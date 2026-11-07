import { Controller, Get, Inject } from "@nestjs/common";
import { sql, type DatabaseClient } from "@hosting-panel/database";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

@Controller("health")
export class HealthController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  @Get("live")
  public getLive(): Record<string, unknown> {
    return {
      status: "ok",
      service: "hosting-panel-api",
      spec: "HCP-SPEC-002",
      phase: "phase-1",
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
