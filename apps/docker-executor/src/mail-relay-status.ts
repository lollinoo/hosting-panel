import { redactSensitiveString, type MailFailureDto, type MailProblem } from "@hosting-panel/contracts";
import type { ServiceLogLine } from "@hosting-panel/executor-contracts";

export interface MailDelivery {
  readonly at: string;
  readonly queueId: string;
  readonly recipient: string;
  readonly status: "sent" | "deferred" | "bounced";
  readonly problem: MailProblem | null;
  readonly detail: string;
}

// qmgr logs `to=` only for a dead nexthop; its from=/size=/nrcpt= lines have no `to=` and never match.
const DELIVERY_LINE =
  /postfix\/(?:smtp|error|qmgr)\[\d+\]: ([0-9A-Za-z]+): to=<([^>]*)>,.*? status=(sent|deferred|bounced) \((.*)\)\s*$/;

/** Most specific cause first; "delivery temporarily suspended" is classified by the reason after it. */
export function classifyMailProblem(status: "deferred" | "bounced", reason: string): MailProblem {
  if (/SASL authentication failed| 535 /.test(reason)) {
    return "auth_failed";
  }
  if (
    /connect to|Connection (?:refused|timed out)|Network is unreachable|No route to host|host not found|Name or service not known|lost connection|timed out/i.test(
      reason,
    )
  ) {
    return "unreachable";
  }
  if (/(?<![\w.-])(?:STARTTLS|TLS|certificate)(?![\w.-])/i.test(reason)) {
    return "tls_failed";
  }
  if (/sasl_passwd|unknown mail transport error|No such file/.test(reason)) {
    return "credentials_missing";
  }
  return status === "bounced" ? "rejected" : "other";
}

export function parsePostfixDeliveries(lines: readonly ServiceLogLine[]): MailDelivery[] {
  const out: MailDelivery[] = [];
  for (const line of lines) {
    const m = line.at ? DELIVERY_LINE.exec(line.text) : null;
    if (!line.at || !m) {
      continue;
    }
    const status = m[3] as MailDelivery["status"];
    const reason = m[4] ?? "";
    out.push({
      at: new Date(line.at).toISOString(),
      queueId: m[1]!,
      recipient: m[2] ?? "",
      status,
      problem: status === "sent" ? null : classifyMailProblem(status, reason),
      detail: redactSensitiveString(reason).slice(0, 300),
    });
  }
  return out;
}

export function summarizeMailDeliveries(
  deliveries: readonly MailDelivery[],
  sinceMs: number,
): { sentCount: number; failures: MailFailureDto[] } {
  const latest = new Map<string, MailDelivery>();
  for (const d of deliveries) {
    if (Date.parse(d.at) >= sinceMs) {
      latest.set(`${d.queueId}\n${d.recipient}`, d); // log order: a later line replaces an earlier one
    }
  }
  const all = [...latest.values()];
  return {
    sentCount: all.filter((d) => d.status === "sent").length,
    failures: all
      .filter((d) => d.status !== "sent")
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 50)
      .map((d) => ({
        at: d.at,
        recipient: d.recipient,
        status: d.status as "deferred" | "bounced",
        problem: d.problem ?? "other",
        detail: d.detail,
      })),
  };
}
