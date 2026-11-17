import {
  FIREWALL_BLOCK_REFUSALS,
  FIREWALL_MAX_BLOCKS_PER_FAMILY,
  FIREWALL_MIN_PREFIX,
  FIREWALL_NOTE_MAX,
  type FirewallDto,
} from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";

type BaseRules = FirewallDto["baseRules"];

/** The BFF's wait for the firewall: one change makes up to three host-agent calls of 20 s each. */
export const FIREWALL_BFF_TIMEOUT_MS = 65_000;

/** Ports and blocks can be changed: base rules current, or unreadable (stored, applied later). */
export const canChangeFirewall = (b: BaseRules): boolean => b === "current" || b === "unreadable";

/** The base rules must be applied before anything changes. */
export const needsBaseRules = (b: BaseRules): boolean => b === "absent" || b === "outdated";

/** Some stored port or block is not in force on the server. */
export const hasNotInForce = (dto: Pick<FirewallDto, "ports" | "blocks">): boolean =>
  dto.ports.some((p) => p.inForce === false) || dto.blocks.some((b) => b.inForce === false);

const REASONS: readonly string[] = [...FIREWALL_BLOCK_REFUSALS, "note_invalid", "unknown_port"];

/** The sentence for a refused firewall change; `base`: the apply button, whose NOT_FOUND is the host row. Never echoes the server's text. */
export function firewallErrorText(m: Messages, code: string, reason?: string, base = false): string {
  const t = m.admin.firewall;
  if (code === "VALIDATION_ERROR" && reason !== undefined && REASONS.includes(reason)) {
    const max = reason === "note_invalid" ? FIREWALL_NOTE_MAX : FIREWALL_MAX_BLOCKS_PER_FAMILY;
    return format(t.refusals[reason as keyof typeof t.refusals], { v4: FIREWALL_MIN_PREFIX.ipv4, v6: FIREWALL_MIN_PREFIX.ipv6, max });
  }
  switch (code) {
    case "FIREWALL_BASE_RULES_NOT_CURRENT": return t.errors.notCurrent;
    case "NOT_FOUND": return base ? t.errors.hostGone : t.errors.notFound;
    case "RESOURCE_LOCKED": return t.errors.locked;
    case "NOT_SUPPORTED": return t.base.disabled;
    case "HOST_AGENT_UNAVAILABLE": return t.errors.agentDown;
    case "UNAUTHENTICATED": return t.errors.session;
    // A 5xx of the API, the BFF's 502/504 and a lost connection: whether it happened is unknown.
    case "INTERNAL_ERROR": case "OPERATION_AMBIGUOUS": case "": return t.errors.noAnswer;
    default: return errorMessage(m, code);
  }
}
