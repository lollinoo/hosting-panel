import { Controller, Get, Inject } from "@nestjs/common";
import { sql, type DatabaseClient } from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

@Controller("health")
export class HealthController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  @Get("live")
  public getLive(): {
    readonly status: "ok";
    readonly service: "hosting-panel-api";
    readonly timestamp: string;
  } {
    return {
      status: "ok",
      service: "hosting-panel-api",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  public async getReady(): Promise<{
    readonly status: "ready";
    readonly database: "up";
    readonly mode: "pglite" | "postgres";
    readonly timestamp: string;
  }> {
    try {
      await this.dbClient.db.execute(sql`SELECT 1`);
      return {
        status: "ready",
        database: "up",
        mode: this.dbClient.mode,
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        "Database readiness check failed.",
        { retryable: true },
      );
    }
  }
}
