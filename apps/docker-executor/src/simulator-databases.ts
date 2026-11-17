import { siteDatabasePrefix, type ErrorCode } from "@hosting-panel/contracts";
import type { SiteDatabasesRequest, SiteDatabasesResult } from "@hosting-panel/executor-contracts";
import {
  checkSiteDatabasesOp,
  parseSiteDatabasesRequest,
  toListResult,
  type SiteDatabasesState,
} from "./site-databases.js";
import { ExecutorCodedError } from "./traefik-config.js";

const FAILURE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  DOCKER_ENGINE_UNAVAILABLE: "The database server is not available. Retry in a few minutes",
  RESOURCE_LOCKED: "The database is in use. Retry in a minute",
  ALREADY_EXISTS: "A database or user with this name already exists",
  NOT_FOUND: "The database or database user was not found",
  QUOTA_EXCEEDED: "Database limit reached for this site",
  INTERNAL_ERROR: "The database server refused the change",
  NOT_SUPPORTED: "phpMyAdmin is not available",
};

function createEmptyState(): SiteDatabasesState {
  return {
    databases: [],
    users: [],
    signOnDatabases: null,
  };
}

export class SimulatedSiteDatabases {
  private readonly sites = new Map<string, SiteDatabasesState>();
  private readonly pendingFailures: ErrorCode[] = [];

  public provision(siteId: string): void {
    const prefix = siteDatabasePrefix(siteId);
    const state = this.getOrCreateSite(siteId);
    if (!state.databases.some((d) => d.name === prefix)) {
      state.databases.push({ name: prefix, primary: true, sizeBytes: 0 });
    }
    let primaryUser = state.users.find((u) => u.name === prefix);
    if (!primaryUser) {
      primaryUser = { name: prefix, primary: true, databases: [prefix] };
      state.users.push(primaryUser);
    } else if (!primaryUser.databases.includes(prefix)) {
      primaryUser.databases.push(prefix);
    }
  }

  /** Removes only the site's own database, its own user, and their grants (matching DB_DROP_SCRIPT). */
  public drop(siteId: string): void {
    const state = this.sites.get(siteId);
    if (!state) {
      return;
    }
    const prefix = siteDatabasePrefix(siteId);
    state.databases = state.databases.filter((d) => d.name !== prefix);
    state.users = state.users.filter((u) => u.name !== prefix);
    for (const user of state.users) {
      user.databases = user.databases.filter((db) => db !== prefix);
    }
    if (state.signOnDatabases !== null) {
      state.signOnDatabases = state.signOnDatabases.filter((db) => db !== prefix);
    }
    if (state.databases.length === 0 && state.users.length === 0 && state.signOnDatabases === null) {
      this.sites.delete(siteId);
    }
  }

  public failNext(code: ErrorCode): void {
    this.pendingFailures.push(code);
  }

  public async handle<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    const parsed = parseSiteDatabasesRequest(req) as R;

    const failureCode = this.pendingFailures.shift();
    if (failureCode !== undefined) {
      throw new ExecutorCodedError(
        FAILURE_MESSAGES[failureCode] ?? "Simulated site databases failure",
        failureCode,
      );
    }

    if (parsed.op === "phpMyAdminSignOn") {
      throw new ExecutorCodedError("phpMyAdmin is not available", "NOT_SUPPORTED");
    }

    if (parsed.op === "dropAll") {
      this.sites.delete(parsed.siteId);
      return {} as SiteDatabasesResult<R["op"]>;
    }

    const state = this.sites.get(parsed.siteId) ?? createEmptyState();
    if (parsed.op === "list") {
      return toListResult(state) as SiteDatabasesResult<R["op"]>;
    }

    checkSiteDatabasesOp(state, parsed);

    const mutable = this.getOrCreateSite(parsed.siteId);
    switch (parsed.op) {
      case "createDatabase": {
        for (const u of mutable.users) {
          u.databases = u.databases.filter((d) => d !== parsed.database);
        }
        mutable.databases.push({ name: parsed.database, primary: false, sizeBytes: 0 });
        break;
      }
      case "deleteDatabase": {
        mutable.databases = mutable.databases.filter((d) => d.name !== parsed.database);
        for (const u of mutable.users) {
          u.databases = u.databases.filter((d) => d !== parsed.database);
        }
        break;
      }
      case "createUser": {
        mutable.users.push({ name: parsed.user, primary: false, databases: [] });
        break;
      }
      case "setUserPassword":
        break;
      case "deleteUser": {
        mutable.users = mutable.users.filter((u) => u.name !== parsed.user);
        break;
      }
      case "grant": {
        const user = mutable.users.find((u) => u.name === parsed.user);
        if (user && !user.databases.includes(parsed.database)) {
          user.databases.push(parsed.database);
        }
        break;
      }
      case "revoke": {
        const user = mutable.users.find((u) => u.name === parsed.user);
        if (user) {
          user.databases = user.databases.filter((d) => d !== parsed.database);
        }
        break;
      }
    }

    return {} as SiteDatabasesResult<R["op"]>;
  }

  private getOrCreateSite(siteId: string): SiteDatabasesState {
    let state = this.sites.get(siteId);
    if (!state) {
      state = createEmptyState();
      this.sites.set(siteId, state);
    }
    return state;
  }
}
