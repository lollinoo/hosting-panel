import { Controller, Get, Inject } from "@nestjs/common";
import { sql, type DatabaseClient } from "@hosting-panel/database";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

@Controller("health")
export class HealthController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  @Get("live")
  public getLive(): Record<string, unknown> {
    const isPhase1Disabled = this.config.runtimeBackend === "disabled";
    return {
      status: "ok",
      service: "hosting-panel-api",
      spec: isPhase1Disabled ? "HCP-SPEC-002" : "HCP-SPEC-003",
      phase: isPhase1Disabled ? "phase-1" : "phase-2",
      ...(isPhase1Disabled ? {} : { runtimeBackend: this.config.runtimeBackend }),
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  public async getReady(): Promise<Record<string, unknown>> {
    await this.dbClient.db.execute(sql`SELECT 1`);
    return {
      status: "ready",
      database: "up",
      mode: this.dbClient.mode,
      timestamp: new Date().toISOString(),
    };
  }
}
