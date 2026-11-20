import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  dnsCredentialIssues,
  type DnsProviderSettingsDto,
  type DnsProviderSettingsInput,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  countDnsChallengeDomains,
  deleteDnsProviderSettings,
  dnsProviderSettings,
  getDnsProviderSettings,
  upsertDnsProviderSettings,
  type DnsProviderSettings,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const FORCED_EVERY_TICKS = 10;
const IN_USE = "Switch every domain back to HTTP-01 first.";

/** A hash of the plaintext with sorted keys (never logged), so only a real change applies again. */
const fingerprint = (settings: DnsProviderSettings | null): string =>
  settings === null
    ? "none"
    : createHash("sha256")
        .update(JSON.stringify([settings.provider, Object.entries(settings.credentials).sort(([a], [b]) => (a < b ? -1 : 1))]))
        .digest("hex");

/** Locks the provider row, so a DNS-01 switch and a clear cannot both pass their checks (READ COMMITTED). */
export async function lockDnsProviderRow(tx: HostingPanelDatabase): Promise<boolean> {
  const rows = await tx.select({ id: dnsProviderSettings.id }).from(dnsProviderSettings).for("update");
  return rows.length > 0;
}

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/**
 * The installation-wide DNS provider for DNS-01: settings and an asynchronous apply, as for the mail relay.
 * Applies run on one promise chain; reads never wait on it.
 */
@Injectable()
export class DnsProviderService {
  /** In memory on purpose: a restarted API applies once at boot, which also refills the executor's tmpfs. */
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
  ) {}

  public get(): Promise<DnsProviderSettingsDto> {
    return this.#read(true);
  }

  /** `withStatus: false` answers without the executor, so a write never waits on a wedged one. */
  async #read(withStatus: boolean): Promise<DnsProviderSettingsDto> {
    const settings = await getDnsProviderSettings(this.dbClient.db, this.#masterKey());
    const dto: DnsProviderSettingsDto = {
      provider: settings?.provider ?? null,
      fieldsSet: settings ? Object.keys(settings.credentials).sort() : [],
      updatedAt: settings?.updatedAt.toISOString() ?? null,
      applied: fingerprint(settings) === this.#appliedFingerprint,
      ready: null,
    };
    if (!withStatus) return dto;
    try {
      const status = await this.executor.getCertificateStatus({ failuresSince: new Date().toISOString() });
      return { ...dto, ready: status.dnsChallenge === true };
    } catch {
      return dto; // Unknown: the executor did not answer.
    }
  }

  public async save(input: DnsProviderSettingsInput, actorId: string): Promise<DnsProviderSettingsDto> {
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      await lockDnsProviderRow(t);
      const stored = await getDnsProviderSettings(t, this.#masterKey());
      // A field left out keeps its stored value, but only while the provider stays the same.
      const credentials =
        stored?.provider === input.provider ? { ...stored.credentials, ...input.credentials } : { ...input.credentials };
      const issues = dnsCredentialIssues(input.provider, credentials, true);
      if (issues.length > 0) {
        throw new ControlPlaneError("VALIDATION_ERROR", issues[0]!.message, {
          details: issues.map((i) => ({ field: `credentials.${i.field}`, message: i.message })),
        });
      }
      await upsertDnsProviderSettings(t, this.#masterKey(), { provider: input.provider, credentials, actorId });
      // Names only, never values.
      await this.#audit(t, actorId, "admin.dns_provider.update", {
        provider: input.provider,
        fieldsChanged: Object.keys(input.credentials).sort(),
      });
    });
    // Read before the apply starts, so it says applied: false until the apply lands.
    const dto = await this.#read(false);
    void this.ensureApplied();
    return dto;
  }

  public async clear(actorId: string): Promise<DnsProviderSettingsDto> {
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      await lockDnsProviderRow(t);
      if ((await countDnsChallengeDomains(t)) > 0) {
        throw new ControlPlaneError("VALIDATION_ERROR", IN_USE, { details: [{ message: IN_USE, reason: "dns_challenge_in_use" }] });
      }
      await deleteDnsProviderSettings(t);
      await this.#audit(t, actorId, "admin.dns_provider.clear", {});
    });
    const dto = await this.#read(false);
    void this.ensureApplied();
    return dto;
  }

  /** Never rejects: a failure is logged by code only and retried by the next tick. */
  public ensureApplied(force = false): Promise<void> {
    return this.#queue(async () => {
      const settings = await getDnsProviderSettings(this.dbClient.db, this.#masterKey());
      const target = fingerprint(settings);
      if (target === this.#appliedFingerprint && !force) return;
      await this.executor.applyDnsProvider(
        settings === null ? null : { provider: settings.provider, credentials: settings.credentials },
      );
      this.#appliedFingerprint = target;
    }).catch((err: unknown) => {
      if (this.#stopped) return;
      console.warn(JSON.stringify({ event: "dns_provider_apply_failed", code: codeOf(err) ?? "INTERNAL_ERROR" }));
    });
  }

  /** At once, then every `intervalMs`; every 10th tick re-applies even when nothing changed. */
  public startBackgroundLoop(intervalMs: number | null | undefined): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    const run = () => {
      // A tick still waiting on a slow apply is not stacked with another.
      if (this.#stopped || this.#running) return;
      this.#ticks += 1;
      this.#running = this.ensureApplied(this.#ticks % FORCED_EVERY_TICKS === 0).finally(() => (this.#running = null));
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
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
      this.#stopped ? Promise.reject(new Error("DNS provider service is stopping")) : work(),
    );
    this.#serial = run.catch(() => undefined);
    return run;
  }

  #masterKey(): string {
    return this.config.secretsMasterKey.toString("hex");
  }

  #audit(db: HostingPanelDatabase, actorId: string, action: string, details: Record<string, unknown>) {
    return appendAuditEvent(db, { actorId, actorType: "user", action, targetType: "dns_provider", targetId: null, details });
  }
}
