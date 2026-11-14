import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  mailSenderAddress,
  type MailRelaySettingsDto,
  type MailRelaySettingsInput,
  type MailTestResult,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  deleteMailRelaySettings,
  getMailRelaySettings,
  getMailRelaySettingsPublic,
  upsertMailRelaySettings,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { upgradeSitesToSiteMail } from "./site-mail-upgrade.js";

const FORCED_EVERY_TICKS = 10;
const STATUS_WINDOW_MS = 24 * 3600_000;
const UNAVAILABLE_CODES: ReadonlySet<unknown> = new Set(["MAIL_RELAY_UNAVAILABLE", "DOCKER_ENGINE_UNAVAILABLE", "NOT_SUPPORTED"]);

type PublicRow = Awaited<ReturnType<typeof getMailRelaySettingsPublic>>;

const fingerprint = (row: PublicRow): string =>
  row === null
    ? "none"
    : createHash("sha256")
        .update([row.host, row.port, row.username, row.senderDomain, row.ciphertextBase64, row.updatedAt.toISOString()].join("|"))
        .digest("hex");

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/**
 * The outgoing mail relay: settings, an asynchronous apply, and a test email. Applies and test sends share
 * one promise chain; reads never wait on it, because an apply can take minutes (an image pull).
 */
@Injectable()
export class MailRelayService {
  /** In memory on purpose: a restarted API applies once at boot, which also repairs a lost relay. */
  #appliedFingerprint: string | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #ticks = 0;
  #running: Promise<void> | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  public get(): Promise<MailRelaySettingsDto> {
    return this.#read(true);
  }

  /** `withStatus: false` answers without the executor, so a save never waits on a wedged one. */
  async #read(withStatus: boolean): Promise<MailRelaySettingsDto> {
    const row = await getMailRelaySettingsPublic(this.dbClient.db);
    const dto: MailRelaySettingsDto = {
      configured: row !== null,
      host: row?.host ?? null,
      port: row?.port ?? null,
      username: row?.username ?? null,
      senderDomain: row?.senderDomain ?? null,
      passwordSet: row !== null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      applied: fingerprint(row) === this.#appliedFingerprint,
      relayRunning: null,
      sentLast24h: null,
      failures: [],
    };
    if (row === null || !withStatus) return dto;
    try {
      const status = await this.executor.getMailRelayStatus({ since: new Date(Date.now() - STATUS_WINDOW_MS).toISOString() });
      return { ...dto, relayRunning: status.running, sentLast24h: status.sentCount, failures: status.failures };
    } catch {
      return dto; // Unknown, not "not running": the executor did not answer.
    }
  }

  public async save(input: MailRelaySettingsInput, actorId: string): Promise<MailRelaySettingsDto> {
    const { password, ...fields } = input;
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      if (password === undefined && (await getMailRelaySettingsPublic(t)) === null) {
        throw new ControlPlaneError("VALIDATION_ERROR", "password_required", {
          details: [{ field: "password", message: "password_required" }],
        });
      }
      await upsertMailRelaySettings(t, this.#masterKey(), { ...fields, password: password ?? null, actorId });
      await this.#audit(t, actorId, "admin.mail_relay.update", { ...fields, passwordChanged: password !== undefined });
    });
    // The DTO is read before the apply starts, so it says applied: false until the apply lands.
    const dto = await this.#read(false);
    void this.ensureApplied();
    return dto;
  }

  public async clear(actorId: string): Promise<MailRelaySettingsDto> {
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      await deleteMailRelaySettings(t);
      await this.#audit(t, actorId, "admin.mail_relay.clear", {});
    });
    const dto = await this.#read(false);
    void this.ensureApplied();
    return dto;
  }

  public async sendTest(to: string, actorId: string): Promise<MailTestResult> {
    const row = await getMailRelaySettingsPublic(this.dbClient.db);
    if (row === null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", { details: [{ message: "not_configured" }] });
    }
    const unavailable = () =>
      new ControlPlaneError("MAIL_RELAY_UNAVAILABLE", "Email sending is not running on this server yet.", { retryable: true });
    if (fingerprint(row) !== this.#appliedFingerprint) throw unavailable();
    let result: MailTestResult;
    try {
      result = await this.#queue(() => this.executor.sendTestMail({ to, from: mailSenderAddress(row.senderDomain) }));
    } catch (err) {
      if (UNAVAILABLE_CODES.has(codeOf(err))) throw unavailable();
      if (codeOf(err) === "OPERATION_AMBIGUOUS") {
        // The executor timed out after the request was written: the email may have been sent.
        await this.#audit(this.dbClient.db, actorId, "admin.mail_relay.test", { to, outcome: "unknown", problem: null });
        throw new ControlPlaneError("OPERATION_AMBIGUOUS", "The test email may have been sent. Check the inbox.");
      }
      throw err;
    }
    await this.#audit(this.dbClient.db, actorId, "admin.mail_relay.test", { to, outcome: result.outcome, problem: result.problem });
    return result;
  }

  public async customerView(): Promise<{ configured: boolean; fromAddress: string | null }> {
    const row = await getMailRelaySettingsPublic(this.dbClient.db);
    return { configured: row !== null, fromAddress: row ? mailSenderAddress(row.senderDomain) : null };
  }

  /** Never rejects: a failure is logged by code only and retried by the next tick. */
  public ensureApplied(force = false): Promise<void> {
    return this.#queue(async () => {
      const db = this.dbClient.db;
      const target = fingerprint(await getMailRelaySettingsPublic(db));
      if (target === this.#appliedFingerprint && !force) return;
      const settings = target === "none" ? null : await getMailRelaySettings(db, this.#masterKey());
      await this.executor.applyMailRelay(
        settings === null
          ? null
          : {
              host: settings.host,
              port: settings.port as 25 | 465 | 587 | 2525,
              username: settings.username,
              password: settings.password,
              senderDomain: settings.senderDomain,
            },
      );
      // A save between the two reads leaves the old fingerprint here, so the next tick applies again.
      this.#appliedFingerprint = target;
    }).catch((err: unknown) => {
      if (this.#stopped) return;
      console.warn(JSON.stringify({ event: "mail_relay_apply_failed", code: codeOf(err) ?? "INTERNAL_ERROR" }));
    });
  }

  /** At once, then every `mailRelayRetryIntervalMs`; every 10th tick re-applies even when nothing changed. */
  public startBackgroundLoop(): void {
    const intervalMs = this.config.mailRelayRetryIntervalMs;
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    const run = () => {
      // A tick still waiting on a slow apply is not stacked with another.
      if (this.#stopped || this.#running) return;
      this.#running = this.tick().finally(() => (this.#running = null));
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  public async tick(): Promise<void> {
    this.#ticks += 1;
    await this.ensureApplied(this.#ticks % FORCED_EVERY_TICKS === 0);
    if (this.#stopped) return;
    try {
      if ((await upgradeSitesToSiteMail(this.dbClient.db)) > 0) this.outboxWorker.triggerAsync();
    } catch (err) {
      console.warn(JSON.stringify({ event: "site_mail_upgrade_failed", code: codeOf(err) ?? null }));
    }
  }

  /** Resolves when the running background tick, if any, has finished. */
  public async idle(): Promise<void> {
    await this.#running;
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    // Queued work skips once stopped, so this waits only for the call in flight.
    await this.#running;
    await this.#serial;
  }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(() =>
      this.#stopped
        ? Promise.reject(new ControlPlaneError("MAIL_RELAY_UNAVAILABLE", "Email sending is stopping.", { retryable: true }))
        : work(),
    );
    this.#serial = run.catch(() => undefined);
    return run;
  }

  #masterKey(): string {
    return this.config.secretsMasterKey.toString("hex");
  }

  #audit(db: HostingPanelDatabase, actorId: string, action: string, details: Record<string, unknown>) {
    return appendAuditEvent(db, { actorId, actorType: "user", action, targetType: "mail_relay", targetId: null, details });
  }
}
