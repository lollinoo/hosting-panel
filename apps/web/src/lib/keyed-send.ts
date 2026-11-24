import { renewKeyAfter } from "@/lib/site-setup";

/** Keys kept per action name, each with the JSON text it was sent with. Lives in a component ref, never in storage. */
export type KeptKeys = Record<string, { key: string; body: string }>;

/** The action's kept key when `body` (the JSON text sent) is the one it went with; otherwise a new key replaces it. */
export function keyFor(keys: KeptKeys, name: string, body: string): string {
  const kept = keys[name];
  if (kept && kept.body === body) return kept.key;
  const key =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  keys[name] = { key, body };
  return key;
}

/** After an answer: a 2xx or a 4xx ends the action's key; a 5xx keeps it, as does a send with no answer (never settled). */
export function settleKey(keys: Record<string, unknown>, name: string, status: number): void {
  if ((status >= 200 && status < 300) || renewKeyAfter(status)) delete keys[name];
}

/** One Idempotency-Key per action name: kept after a 5xx or lost reply (replay), dropped after success or a 4xx. On a 2xx it returns the answer's body; a refusal carries the reason, the field and the bound (`limit`) of its first detail. */
export async function keyedSend(
  keys: Record<string, string>,
  csrfToken: string,
  name: string,
  method: string,
  url: string,
  body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string; reason?: string; field?: string; limit?: string }> {
  const key = (keys[name] ??= crypto.randomUUID());
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    settleKey(keys, name, res.status);
    if (res.ok) return { ok: true, data };
    const first = data?.error?.details?.[0];
    return { ok: false, code: data?.error?.code ?? "", reason: first?.reason, field: first?.field, limit: first?.limit };
  } catch {
    return { ok: false, code: "" };
  }
}
