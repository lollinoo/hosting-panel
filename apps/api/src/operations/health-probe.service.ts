import { Injectable } from "@nestjs/common";

export interface HealthProbeResult {
  readonly healthy: boolean;
  readonly statusCode: number;
  readonly checkedAt: string;
  readonly message: string;
}

@Injectable()
export class HealthProbeService {
  readonly #outcomesByAppResourceId = new Map<string, boolean>();

  public setHealthProbeOutcome(appResourceId: string, healthy: boolean): void {
    this.#outcomesByAppResourceId.set(appResourceId, healthy);
  }

  public resetOutcomes(): void {
    this.#outcomesByAppResourceId.clear();
  }

  public isApplicationHealthy(appResourceId: string): boolean {
    return this.#outcomesByAppResourceId.get(appResourceId) ?? true;
  }

  public async probeApplication(appResourceId: string, now: Date = new Date()): Promise<HealthProbeResult> {
    const healthy = this.isApplicationHealthy(appResourceId);
    return {
      healthy,
      statusCode: healthy ? 200 : 502,
      checkedAt: now.toISOString(),
      message: healthy
        ? "External HTTP health check succeeded (200 OK)."
        : "External HTTP health check failed (502 Bad Gateway).",
    };
  }
}
