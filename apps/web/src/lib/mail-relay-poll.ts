import type { MailRelaySettingsDto } from "@hosting-panel/contracts";

/** Re-reads the settings until the relay reports `applied`; gives up after `limitMs`. Returns a stop function. */
export function startMailRelayPolling(o: {
  load: () => Promise<MailRelaySettingsDto | null>;
  onData: (d: MailRelaySettingsDto) => void;
  onGiveUp: () => void;
  intervalMs?: number;
  limitMs?: number;
}): () => void {
  const startedAt = Date.now();
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    if (Date.now() - startedAt > (o.limitMs ?? 5 * 60_000)) {
      stop();
      return o.onGiveUp();
    }
    const d = await o.load().catch(() => null); // the next tick tries again
    if (stopped || !d) return;
    o.onData(d);
    if (d.applied) stop();
  }, o.intervalMs ?? 5000);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
