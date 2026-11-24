import { renewKeyAfter } from "@/lib/site-setup";

/** One Idempotency-Key per action name: kept after a 5xx or lost reply (replay), dropped after success or a 4xx. On a 2xx it returns the answer's body; a refusal carries the reason and the field of its first detail. */
export async function keyedSend(
  keys: Record<string, string>,
  csrfToken: string,
  name: string,
  method: string,
  url: string,
  body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string; reason?: string; field?: string }> {
  const key = (keys[name] ??= crypto.randomUUID());
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      delete keys[name];
      return { ok: true, data };
    }
    if (renewKeyAfter(res.status)) delete keys[name];
    return { ok: false, code: data?.error?.code ?? "", reason: data?.error?.details?.[0]?.reason, field: data?.error?.details?.[0]?.field };
  } catch {
    return { ok: false, code: "" };
  }
}
