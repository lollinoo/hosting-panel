import { ControlPlaneError } from "../common/control-plane.error.js";

/** Each read can hold up to 2 MiB in the executor (ADR 0026 limit 9): 8 at once bound it to 16 MiB. */
export const LOG_READS_MAX = 8;
/** One organisation cannot take every slot. */
export const LOG_READS_PER_ORG_MAX = 2;

/** Customer log reads in flight (ADR 0026 limit 27). A read over the cap is refused, never queued. */
export class LogReadGate {
  #running = 0;
  readonly #byOrg = new Map<string, number>();

  async run<T>(organizationId: string, read: () => Promise<T>): Promise<T> {
    const org = this.#byOrg.get(organizationId) ?? 0;
    if (this.#running >= LOG_READS_MAX || org >= LOG_READS_PER_ORG_MAX) {
      throw new ControlPlaneError("RATE_LIMITED", "Too many log reads right now. Try again in a minute.");
    }
    this.#running += 1;
    this.#byOrg.set(organizationId, org + 1);
    try {
      return await read();
    } finally {
      this.#running -= 1;
      const left = (this.#byOrg.get(organizationId) ?? 1) - 1;
      if (left === 0) this.#byOrg.delete(organizationId);
      else this.#byOrg.set(organizationId, left);
    }
  }
}
