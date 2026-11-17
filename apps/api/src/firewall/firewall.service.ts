import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  FIREWALL_PORT_NAMES,
  FIREWALL_SAFE_PORTS,
  FIREWALL_STATIC_RULES,
  checkFirewallBlock,
  isFirewallNoteValid,
  type FirewallBlockInput,
  type FirewallDto,
  type FirewallPortName,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  asc,
  eq,
  firewallBlocks,
  firewallOpenPorts,
  hosts,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { HostAgentPort, HostFirewallSets, HostFirewallState } from "@hosting-panel/host-agent-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN, HOST_AGENT_TOKEN } from "../tokens.js";

export type FirewallActor = {
  readonly userId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
};

type Stored = { open: Set<string>; blocks: (typeof firewallBlocks.$inferSelect)[] };

const RETRY_CODES: ReadonlySet<unknown> = new Set(["HOST_AGENT_UNAVAILABLE", "OPERATION_AMBIGUOUS"]);
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code ?? "INTERNAL_ERROR";

/** A refusal of the closed lists; the input itself is never echoed. */
export const firewallRefusal = (field: string, reason: string) =>
  new ControlPlaneError("VALIDATION_ERROR", reason, { details: [{ field, reason, message: reason }] });

/** Stored firewall lists and their sync to the host. */
@Injectable()
export class FirewallService {
  #serial: Promise<unknown> = Promise.resolve();
  #stopped = false;
  #wake: (() => void) | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
  ) {}

  /** The stored lists and what the host reports. */
  public async view(): Promise<FirewallDto> {
    const kernel = this.hostAgent.isRuntimeAvailable ? await this.hostAgent.readFirewall().catch(() => null) : null;
    return this.#dto(kernel);
  }

  /** Opens or closes one port of the safe list. */
  public setPort(name: FirewallPortName, open: boolean, actor: FirewallActor): Promise<FirewallDto> {
    return this.#change(async (tx, stored) => {
      if (!FIREWALL_PORT_NAMES.includes(name)) throw firewallRefusal("name", "unknown_port");
      if (stored.open.has(name) === open) return false;
      if (open) await tx.insert(firewallOpenPorts).values({ name });
      else await tx.delete(firewallOpenPorts).where(eq(firewallOpenPorts.name, name));
      await this.#audit(tx, actor, open ? "admin.firewall.port_open" : "admin.firewall.port_close", name, { name, port: FIREWALL_SAFE_PORTS[name] });
      return true;
    });
  }

  /** Blocks one address or range. */
  public block(input: FirewallBlockInput, requesterAddress: string | null, actor: FirewallActor): Promise<FirewallDto> {
    return this.#change(async (tx, stored) => {
      const check = checkFirewallBlock(input.address, { stored: stored.blocks.map((b) => b.cidr), requesterAddress });
      if (!check.ok) throw firewallRefusal("address", check.reason);
      const note = input.note || null;
      if (note !== null && !isFirewallNoteValid(note)) throw firewallRefusal("note", "note_invalid");
      const id = `fwb_${randomUUID().replace(/-/g, "")}`;
      await tx.insert(firewallBlocks).values({ id, family: check.family, cidr: check.cidr, note });
      await this.#audit(tx, actor, "admin.firewall.block", id, { address: check.cidr, family: check.family, note });
      return true;
    });
  }

  /** Removes one block. */
  public unblock(blockId: string, actor: FirewallActor): Promise<FirewallDto> {
    return this.#change(async (tx, stored) => {
      const row = stored.blocks.find((b) => b.id === blockId);
      if (!row) throw new ControlPlaneError("NOT_FOUND", "This block does not exist.");
      await tx.delete(firewallBlocks).where(eq(firewallBlocks.id, blockId));
      await this.#audit(tx, actor, "admin.firewall.unblock", blockId, { address: row.cidr, family: row.family });
      return true;
    });
  }

  /** Sends the stored lists to the host; never throws. */
  public sync(): Promise<HostFirewallState | null> {
    return this.#queue(() => this.#send()).catch(() => null);
  }

  /** Syncs once at start, retrying while the agent is away; never throws. */
  public async syncAtStart(retryMs = 10_000): Promise<void> {
    while (!this.#stopped) {
      const code = await this.#queue(() => this.#push()).then(() => null, codeOf);
      if (this.#stopped) return;
      if (code !== null) console.warn(JSON.stringify({ event: "firewall_sync_failed", code }));
      if (!RETRY_CODES.has(code)) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs);
        timer.unref();
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }

  /** Stops the start retry. */
  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#serial;
  }

  /** The five steps of one change, inside the queue. */
  #change(work: (tx: HostingPanelDatabase, stored: Stored) => Promise<boolean>): Promise<FirewallDto> {
    return this.#queue(async () => {
      if (!this.hostAgent.isRuntimeAvailable) throw new ControlPlaneError("NOT_SUPPORTED", "The host agent is disabled on this server.");
      const before = await this.hostAgent.readFirewall().catch(() => null);
      if (before && before.baseRules !== "current") {
        throw new ControlPlaneError(
          "FIREWALL_BASE_RULES_NOT_CURRENT",
          before.baseRules === "unmanaged" ? "The panel firewall is not installed on this server." : "The base firewall rules are not in place. Apply them first.",
        );
      }
      const changed = await this.dbClient.db.transaction(async (tx) => {
        const db = tx as unknown as HostingPanelDatabase;
        return work(db, await this.#stored(db));
      });
      const after = changed ? await this.#send() : before;
      return this.#dto(after ?? (await this.hostAgent.readFirewall().catch(() => null)));
    });
  }

  /** `#push` with its failure logged as one line with the code only. */
  #send(): Promise<HostFirewallState | null> {
    return this.#push().catch((err: unknown) => {
      console.warn(JSON.stringify({ event: "firewall_sync_failed", code: codeOf(err) }));
      return null;
    });
  }

  async #push(): Promise<HostFirewallState | null> {
    if (!this.hostAgent.isRuntimeAvailable) return null;
    const stored = await this.#stored(this.dbClient.db);
    const sets: HostFirewallSets = {
      openedPorts: FIREWALL_PORT_NAMES.filter((n) => stored.open.has(n)).map((n) => FIREWALL_SAFE_PORTS[n]).sort((a, b) => a - b),
      blockedV4: stored.blocks.filter((b) => b.family === "ipv4").map((b) => b.cidr),
      blockedV6: stored.blocks.filter((b) => b.family === "ipv6").map((b) => b.cidr),
    };
    return this.hostAgent.replaceFirewallSets(sets);
  }

  async #stored(db: HostingPanelDatabase): Promise<Stored> {
    const open = await db.select().from(firewallOpenPorts);
    const blocks = await db.select().from(firewallBlocks).orderBy(asc(firewallBlocks.createdAt), asc(firewallBlocks.id));
    return { open: new Set(open.map((r) => r.name)), blocks };
  }

  /** D12: inForce only when the kernel was read and its base rules are current. */
  async #dto(kernel: HostFirewallState | null): Promise<FirewallDto> {
    const db = this.dbClient.db;
    const stored = await this.#stored(db);
    const [host] = await db.select({ id: hosts.id }).from(hosts).limit(1);
    const live = kernel?.baseRules === "current" ? kernel : null;
    return {
      baseRules: !this.hostAgent.isRuntimeAvailable ? "disabled" : (kernel?.baseRules ?? "unreadable"),
      readAt: kernel?.readAt ?? null,
      hostId: host?.id ?? null,
      staticRules: FIREWALL_STATIC_RULES.map((r) => ({ key: r.key, ports: [...r.ports] })),
      ports: FIREWALL_PORT_NAMES.map((name) => {
        const port = FIREWALL_SAFE_PORTS[name];
        const open = stored.open.has(name);
        return { name, port, open, inForce: live ? live.openedPorts.includes(port) === open : null };
      }),
      blocks: stored.blocks.toReversed().map((b) => ({
        id: b.id,
        address: b.cidr,
        family: b.family,
        note: b.note,
        createdAt: b.createdAt.toISOString(),
        inForce: live ? (b.family === "ipv4" ? live.blockedV4 : live.blockedV6).includes(b.cidr) : null,
      })),
    };
  }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(() =>
      this.#stopped ? Promise.reject(new ControlPlaneError("HOST_AGENT_UNAVAILABLE", "The firewall is stopping.", { retryable: true })) : work(),
    );
    this.#serial = run.catch(() => undefined);
    return run;
  }

  #audit(tx: HostingPanelDatabase, actor: FirewallActor, action: string, targetId: string, details: Record<string, unknown>) {
    return appendAuditEvent(tx, {
      actorId: actor.userId,
      actorType: "user",
      organizationId: null,
      action,
      targetType: "firewall",
      targetId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      details: { outcome: "succeeded", requestId: actor.requestId, ...details },
    });
  }
}
