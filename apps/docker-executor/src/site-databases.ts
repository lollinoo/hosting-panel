import {
  MYSQL_NATIVE_PASSWORD_HASH_PATTERN,
  SITE_DATABASES_MAX,
  SITE_DATABASE_PREFIX_PATTERN,
  SITE_DATABASE_SIGNON_USER_PATTERN,
  SITE_DATABASE_USERS_MAX,
  SiteDatabasesIpcRequestSchema,
  isSiteDatabaseName,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
  type SiteDatabaseEntry,
  type SiteDatabasesOp,
  type SiteDatabasesResultByOp,
} from "@hosting-panel/contracts";
import type { SiteDatabasesRequest, SiteDatabasesResult } from "@hosting-panel/executor-contracts";
import { runDockerExec, type DockerExecTarget } from "./docker-exec.js";
import { ExecutorCodedError, assertSafeIdentifier } from "./traefik-config.js";

type ExecResult = Awaited<ReturnType<typeof runDockerExec>>;

export type { ExecResult };

export interface SiteDatabasesDeps {
  runSql(sql: string, opts?: { readonly timeoutMs?: number }): Promise<ExecResult>;
  ensurePhpMyAdmin(): Promise<void>;
}

export interface SiteDatabasesState {
  databases: SiteDatabaseEntry[];
  users: { name: string; primary: boolean; databases: string[] }[];
  signOnDatabases: string[] | null;
}

const MARIADB_STATE_TIMEOUT_MS = 15_000;
const MARIADB_BATCH_TIMEOUT_MS = 45_000;
const MARIADB_MAX_OUTPUT_BYTES = 1_048_576;
const MARIADB_LOCK_WAIT_TIMEOUT_LINE = "SET SESSION lock_wait_timeout = 30;";
/** Max concurrent connections per extra database user and per phpMyAdmin sign-on account (R40). */
export const MARIADB_EXTRA_MAX_USER_CONNECTIONS = 5;
export const MARIADB_SIGNON_MAX_USER_CONNECTIONS = 10;

const MARIADB_ROOT_EXEC_CMD = [
  "sh",
  "-c",
  'MYSQL_PWD="$(cat /run/secrets/mariadb-root)" exec mariadb --user=root --batch --skip-column-names --raw',
] as const;

// Equal to ALL PRIVILEGES at database level on MariaDB 12.3.3, explicitly omitting GRANT OPTION.
const MARIADB_DB_PRIVILEGES =
  "ALTER, ALTER ROUTINE, CREATE, CREATE ROUTINE, CREATE TEMPORARY TABLES, CREATE VIEW, DELETE, DELETE HISTORY, DROP, EVENT, EXECUTE, INDEX, INSERT, LOCK TABLES, REFERENCES, SELECT, SHOW CREATE ROUTINE, SHOW VIEW, TRIGGER, UPDATE";

const MSG_INVALID_REQUEST = "Invalid site databases request";
const MSG_NOT_FOUND = "The database or database user was not found";
const MSG_DB_EXISTS = "A database with this name already exists";
const MSG_USER_EXISTS = "A database user with this name already exists";
const MSG_DB_QUOTA = "Database limit reached for this site";
const MSG_USER_QUOTA = "Database user limit reached for this site";
const MSG_RESOURCE_LOCKED = "The database is in use. Retry in a minute";
const MSG_SERVER_UNAVAILABLE = "The database server is not available. Retry in a few minutes";
const MSG_SERVER_TIMEOUT = "The database server did not answer in time";
const MSG_SERVER_REFUSED = "The database server refused the change";
const MSG_PMA_UNAVAILABLE = "phpMyAdmin is not available. Retry in a few minutes";

const ENGINE_UNAVAILABLE_ERRNOS = new Set(["1040", "1045", "1053", "2002", "2003", "2006", "2013", "2026"]);
const NOT_FOUND_ERRNOS = new Set(["1008", "1049", "1133", "1141"]);
const MAX_SAFE_INT_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeUnderscores(name: string): string {
  return name.replaceAll("_", "\\_");
}

function assertCheckedSitePrefix(siteId: string): string {
  if (typeof siteId !== "string" || siteId.length === 0 || siteId.length > 128) {
    throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
  }
  const prefix = siteDatabasePrefix(siteId);
  if (!SITE_DATABASE_PREFIX_PATTERN.test(prefix)) {
    throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
  }
  return prefix;
}

function assertCheckedSignOnUser(siteId: string): string {
  const signOn = siteDatabaseSignOnUser(siteId);
  if (!SITE_DATABASE_SIGNON_USER_PATTERN.test(signOn)) {
    throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
  }
  return signOn;
}

function grantClause(dbName: string, userName: string): string {
  return `GRANT ${MARIADB_DB_PRIVILEGES} ON \`${escapeUnderscores(dbName)}\`.* TO '${userName}'@'%';`;
}

function revokeClause(dbName: string, userName: string): string {
  return `REVOKE ALL PRIVILEGES ON \`${escapeUnderscores(dbName)}\`.* FROM '${userName}'@'%';`;
}

export function mariadbRootExec(
  target: DockerExecTarget,
  containerName: string,
): (sql: string, opts?: { readonly timeoutMs?: number }) => Promise<ExecResult> {
  assertSafeIdentifier(containerName, "containerName");
  return async (sql: string, opts?: { readonly timeoutMs?: number }): Promise<ExecResult> => {
    try {
      return await runDockerExec(
        target,
        {
          container: containerName,
          cmd: MARIADB_ROOT_EXEC_CMD,
        },
        {
          stdin: Buffer.from(sql, "utf8"),
          timeoutMs: opts?.timeoutMs ?? MARIADB_BATCH_TIMEOUT_MS,
          maxOutputBytes: MARIADB_MAX_OUTPUT_BYTES,
        },
      );
    } catch {
      throw new ExecutorCodedError(MSG_SERVER_UNAVAILABLE, "DOCKER_ENGINE_UNAVAILABLE");
    }
  };
}

export function parseSiteDatabasesRequest(raw: unknown): SiteDatabasesRequest {
  const parsed = SiteDatabasesIpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
  }

  const req = parsed.data;
  const prefix = assertCheckedSitePrefix(req.siteId);

  switch (req.op) {
    case "createDatabase":
    case "deleteDatabase":
      if (!isSiteDatabaseName(prefix, req.database)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      break;
    case "createUser":
    case "setUserPassword":
    case "deleteUser":
      if (!isSiteDatabaseName(prefix, req.user)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      break;
    case "grant":
    case "revoke":
      if (!isSiteDatabaseName(prefix, req.user) || !isSiteDatabaseName(prefix, req.database)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      break;
    case "list":
    case "phpMyAdminSignOn":
    case "dropAll":
      break;
  }

  return req;
}

const noTabOrNewline = (col: string): string => `${col} NOT REGEXP '[\\t\\n\\r]'`;

export function buildStateQuery(siteId: string): string {
  const prefix = assertCheckedSitePrefix(siteId);
  const signOn = assertCheckedSignOnUser(siteId);
  const escaped = escapeUnderscores(prefix);
  const matchSiteName = (col: string): string =>
    `(${col} = '${prefix}' OR ${col} LIKE '${escaped}\\_%') AND ${noTabOrNewline(col)}`;
  const matchUser = `(User = '${prefix}' OR User LIKE '${escaped}\\_%' OR User = '${signOn}') AND ${noTabOrNewline("User")}`;

  return [
    MARIADB_LOCK_WAIT_TIMEOUT_LINE,
    `SELECT 'D', s.SCHEMA_NAME, COALESCE(t.sz, 0) FROM information_schema.SCHEMATA s LEFT JOIN (SELECT TABLE_SCHEMA, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS sz FROM information_schema.TABLES WHERE ${matchSiteName("TABLE_SCHEMA")} GROUP BY TABLE_SCHEMA) t ON t.TABLE_SCHEMA = s.SCHEMA_NAME WHERE ${matchSiteName("s.SCHEMA_NAME")};`,
    `SELECT 'U', User, '' FROM mysql.user WHERE Host = '%' AND ${matchUser};`,
    `SELECT 'G', User, Db FROM mysql.db WHERE Host = '%' AND ${matchUser} AND ${noTabOrNewline("Db")};`,
  ].join("\n");
}

export function parseSiteDatabasesState(siteId: string, stdout: string): SiteDatabasesState {
  const prefix = assertCheckedSitePrefix(siteId);
  const signOn = assertCheckedSignOnUser(siteId);

  if (stdout.length === 0) {
    return { databases: [], users: [], signOnDatabases: null };
  }

  const trimmed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const lines = trimmed.split("\n");

  const databasesMap = new Map<string, SiteDatabaseEntry>();
  const usersMap = new Map<string, Set<string>>();
  let signOnSet: Set<string> | null = null;

  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) {
      throw new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
    }
    const tag = fields[0]!;
    const col1 = fields[1]!;
    const col2 = fields[2]!;

    if (tag === "D") {
      if (!/^\d{1,19}$/.test(col2) || BigInt(col2) > MAX_SAFE_INT_BIGINT) {
        throw new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
      }
      if (!isSiteDatabaseName(prefix, col1)) {
        continue;
      }
      databasesMap.set(col1, {
        name: col1,
        primary: col1 === prefix,
        sizeBytes: Number(col2),
      });
      continue;
    }

    if (tag === "U") {
      if (col1 === signOn) {
        if (signOnSet === null) {
          signOnSet = new Set<string>();
        }
        continue;
      }
      if (!isSiteDatabaseName(prefix, col1)) {
        continue;
      }
      if (!usersMap.has(col1)) {
        usersMap.set(col1, new Set<string>());
      }
      continue;
    }

    if (tag === "G") {
      const dbName = col2.replaceAll("\\_", "_");
      if (!isSiteDatabaseName(prefix, dbName)) {
        continue;
      }
      if (col1 === signOn) {
        signOnSet?.add(dbName);
        continue;
      }
      if (!isSiteDatabaseName(prefix, col1)) {
        continue;
      }
      usersMap.get(col1)?.add(dbName);
      continue;
    }

    throw new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
  }

  const databases = [...databasesMap.values()].sort((a, b) => compareAscii(a.name, b.name));
  const users = [...usersMap.entries()]
    .sort(([a], [b]) => compareAscii(a, b))
    .map(([name, dbs]) => ({
      name,
      primary: name === prefix,
      databases: [...dbs].sort(compareAscii),
    }));

  return {
    databases,
    users,
    signOnDatabases: signOnSet === null ? null : [...signOnSet].sort(compareAscii),
  };
}

export function toListResult(state: SiteDatabasesState): SiteDatabasesResultByOp["list"] {
  const dbMap = new Map<string, SiteDatabaseEntry>();
  for (const db of state.databases) {
    dbMap.set(db.name, { name: db.name, primary: db.primary, sizeBytes: db.sizeBytes });
  }
  const databases = [...dbMap.values()].sort((a, b) => compareAscii(a.name, b.name));
  const existingDbs = new Set(databases.map((d) => d.name));

  const userMap = new Map<string, { primary: boolean; dbs: Set<string> }>();
  for (const user of state.users) {
    let entry = userMap.get(user.name);
    if (!entry) {
      entry = { primary: user.primary, dbs: new Set<string>() };
      userMap.set(user.name, entry);
    }
    for (const dbName of user.databases) {
      if (existingDbs.has(dbName)) {
        entry.dbs.add(dbName);
      }
    }
  }

  const users = [...userMap.entries()]
    .sort(([a], [b]) => compareAscii(a, b))
    .map(([name, entry]) => ({
      name,
      primary: entry.primary,
      databases: [...entry.dbs].sort(compareAscii),
    }));

  return { databases, users };
}

export function checkSiteDatabasesOp(
  state: SiteDatabasesState,
  req: SiteDatabasesRequest,
): void {
  const parsed = parseSiteDatabasesRequest(req);

  switch (parsed.op) {
    case "createDatabase": {
      if (state.databases.some((d) => d.name === parsed.database)) {
        throw new ExecutorCodedError(MSG_DB_EXISTS, "ALREADY_EXISTS");
      }
      const customCount = state.databases.filter((d) => !d.primary).length;
      if (customCount >= SITE_DATABASES_MAX) {
        throw new ExecutorCodedError(MSG_DB_QUOTA, "QUOTA_EXCEEDED");
      }
      return;
    }
    case "createUser": {
      if (state.users.some((u) => u.name === parsed.user)) {
        throw new ExecutorCodedError(MSG_USER_EXISTS, "ALREADY_EXISTS");
      }
      const customCount = state.users.filter((u) => !u.primary).length;
      if (customCount >= SITE_DATABASE_USERS_MAX) {
        throw new ExecutorCodedError(MSG_USER_QUOTA, "QUOTA_EXCEEDED");
      }
      return;
    }
    case "deleteDatabase": {
      if (!state.databases.some((d) => d.name === parsed.database)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      return;
    }
    case "setUserPassword":
    case "deleteUser": {
      if (!state.users.some((u) => u.name === parsed.user)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      return;
    }
    case "grant": {
      if (
        !state.users.some((u) => u.name === parsed.user) ||
        !state.databases.some((d) => d.name === parsed.database)
      ) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      return;
    }
    case "revoke": {
      if (!state.users.some((u) => u.name === parsed.user)) {
        throw new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
      }
      return;
    }
    case "list":
    case "phpMyAdminSignOn":
    case "dropAll":
      return;
  }
}

export function buildSiteDatabasesBatch(
  siteId: string,
  state: SiteDatabasesState,
  req: SiteDatabasesRequest,
): string | null {
  const parsed = parseSiteDatabasesRequest(req);
  if (parsed.siteId !== siteId) {
    throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
  }
  const prefix = assertCheckedSitePrefix(siteId);
  const signOn = assertCheckedSignOnUser(siteId);

  const safeUsers = state.users.filter((u) => isSiteDatabaseName(prefix, u.name));
  const safeDbs = state.databases.filter((d) => isSiteDatabaseName(prefix, d.name));

  switch (parsed.op) {
    case "list":
      return null;

    case "createDatabase": {
      const staleGrantees = safeUsers
        .filter((u) => u.databases.includes(parsed.database))
        .map((u) => u.name)
        .sort(compareAscii);
      const lines = [MARIADB_LOCK_WAIT_TIMEOUT_LINE];
      for (const grantee of staleGrantees) {
        lines.push(revokeClause(parsed.database, grantee));
      }
      lines.push(
        `CREATE DATABASE \`${parsed.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      );
      if (state.signOnDatabases !== null) {
        lines.push(grantClause(parsed.database, signOn));
      }
      return lines.join("\n");
    }

    case "deleteDatabase": {
      const grantees = new Set<string>();
      for (const u of safeUsers) {
        if (u.databases.includes(parsed.database)) {
          grantees.add(u.name);
        }
      }
      if (state.signOnDatabases?.includes(parsed.database)) {
        grantees.add(signOn);
      }
      const lines = [MARIADB_LOCK_WAIT_TIMEOUT_LINE];
      for (const grantee of [...grantees].sort(compareAscii)) {
        lines.push(revokeClause(parsed.database, grantee));
      }
      lines.push(`DROP DATABASE IF EXISTS \`${parsed.database}\`;`);
      return lines.join("\n");
    }

    case "createUser": {
      if (!MYSQL_NATIVE_PASSWORD_HASH_PATTERN.test(parsed.passwordHash)) {
        throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
      }
      return [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        `CREATE USER '${parsed.user}'@'%' IDENTIFIED BY PASSWORD '${parsed.passwordHash}' WITH MAX_USER_CONNECTIONS ${String(MARIADB_EXTRA_MAX_USER_CONNECTIONS)};`,
      ].join("\n");
    }

    case "setUserPassword": {
      if (!MYSQL_NATIVE_PASSWORD_HASH_PATTERN.test(parsed.passwordHash)) {
        throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
      }
      return [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        `ALTER USER '${parsed.user}'@'%' IDENTIFIED BY PASSWORD '${parsed.passwordHash}';`,
        `KILL USER '${parsed.user}'@'%';`,
      ].join("\n");
    }

    case "deleteUser":
      return [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        `DROP USER IF EXISTS '${parsed.user}'@'%';`,
        `KILL USER '${parsed.user}'@'%';`,
      ].join("\n");

    case "grant":
      return [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        grantClause(parsed.database, parsed.user),
      ].join("\n");

    case "revoke": {
      const userEntry = safeUsers.find((u) => u.name === parsed.user);
      if (!userEntry || !userEntry.databases.includes(parsed.database)) {
        return null;
      }
      return [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        revokeClause(parsed.database, parsed.user),
        `KILL USER '${parsed.user}'@'%';`,
      ].join("\n");
    }

    case "phpMyAdminSignOn": {
      if (!MYSQL_NATIVE_PASSWORD_HASH_PATTERN.test(parsed.passwordHash)) {
        throw new ExecutorCodedError(MSG_INVALID_REQUEST, "VALIDATION_ERROR");
      }
      const existingDbNames = new Set(safeDbs.map((d) => d.name));
      const staleSignOnDbs = [...new Set(state.signOnDatabases ?? [])]
        .filter((db) => isSiteDatabaseName(prefix, db) && !existingDbNames.has(db))
        .sort(compareAscii);
      const currentDbs = [...existingDbNames].sort(compareAscii);

      const lines = [
        MARIADB_LOCK_WAIT_TIMEOUT_LINE,
        `CREATE USER IF NOT EXISTS '${signOn}'@'%' IDENTIFIED BY PASSWORD '${parsed.passwordHash}' WITH MAX_USER_CONNECTIONS ${String(MARIADB_SIGNON_MAX_USER_CONNECTIONS)};`,
        `ALTER USER '${signOn}'@'%' IDENTIFIED BY PASSWORD '${parsed.passwordHash}' WITH MAX_USER_CONNECTIONS ${String(MARIADB_SIGNON_MAX_USER_CONNECTIONS)};`,
        `KILL USER '${signOn}'@'%';`,
      ];
      for (const staleDb of staleSignOnDbs) {
        lines.push(revokeClause(staleDb, signOn));
      }
      for (const db of currentDbs) {
        lines.push(grantClause(db, signOn));
      }
      return lines.join("\n");
    }

    case "dropAll": {
      if (safeDbs.length === 0 && safeUsers.length === 0 && state.signOnDatabases === null) {
        return null;
      }
      const usersToDrop = new Set<string>(safeUsers.map((u) => u.name));
      if (state.signOnDatabases !== null) {
        usersToDrop.add(signOn);
      }
      const sortedUsers = [...usersToDrop].sort(compareAscii);
      const sortedDbs = [...new Set(safeDbs.map((d) => d.name))].sort(compareAscii);

      const lines = [MARIADB_LOCK_WAIT_TIMEOUT_LINE];
      for (const user of sortedUsers) {
        lines.push(`DROP USER IF EXISTS '${user}'@'%';`);
      }
      for (const user of sortedUsers) {
        lines.push(`KILL USER '${user}'@'%';`);
      }
      for (const db of sortedDbs) {
        lines.push(`DROP DATABASE IF EXISTS \`${db}\`;`);
      }
      return lines.join("\n");
    }
  }
}

export function mapMariadbError(op: SiteDatabasesOp, res: ExecResult): ExecutorCodedError {
  if (res.exitCode === null || res.exitUnknown) {
    return new ExecutorCodedError(MSG_SERVER_TIMEOUT, "DOCKER_ENGINE_UNAVAILABLE");
  }
  if (res.truncated) {
    return new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
  }

  const stderrText = res.stderr.toString("utf8");
  const match = /^ERROR (\d{4}) /m.exec(stderrText);
  const errno = match?.[1];

  if (errno === "1007") {
    return new ExecutorCodedError(MSG_DB_EXISTS, "ALREADY_EXISTS");
  }
  if (errno === "1396") {
    return op === "createUser"
      ? new ExecutorCodedError(MSG_USER_EXISTS, "ALREADY_EXISTS")
      : new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
  }
  if (errno !== undefined && NOT_FOUND_ERRNOS.has(errno)) {
    return new ExecutorCodedError(MSG_NOT_FOUND, "NOT_FOUND");
  }
  if (errno === "1205") {
    return new ExecutorCodedError(MSG_RESOURCE_LOCKED, "RESOURCE_LOCKED");
  }
  if (errno !== undefined && ENGINE_UNAVAILABLE_ERRNOS.has(errno)) {
    return new ExecutorCodedError(MSG_SERVER_UNAVAILABLE, "DOCKER_ENGINE_UNAVAILABLE");
  }

  return new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
}

export class SiteDatabasesRunner {
  private readonly deps: SiteDatabasesDeps;
  private readonly siteQueues = new Map<string, Promise<void>>();

  public constructor(deps: SiteDatabasesDeps) {
    this.deps = deps;
  }

  public async run<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    const parsed = parseSiteDatabasesRequest(req) as R;
    return this.enqueue(parsed.siteId, () => this.runQueued(parsed));
  }

  private async enqueue<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.siteQueues.get(siteId) ?? Promise.resolve();
    const current = previous.then(fn);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.siteQueues.set(siteId, tail);
    try {
      return await current;
    } finally {
      if (this.siteQueues.get(siteId) === tail) {
        this.siteQueues.delete(siteId);
      }
    }
  }

  private async execSql(sql: string, timeoutMs: number): Promise<ExecResult> {
    try {
      return await this.deps.runSql(sql, { timeoutMs });
    } catch (err) {
      if (err instanceof ExecutorCodedError && err.code === "INTERNAL_ERROR") {
        throw new ExecutorCodedError(MSG_SERVER_REFUSED, "INTERNAL_ERROR");
      }
      throw new ExecutorCodedError(MSG_SERVER_UNAVAILABLE, "DOCKER_ENGINE_UNAVAILABLE");
    }
  }

  private async runQueued<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    if (req.op === "phpMyAdminSignOn") {
      try {
        await this.deps.ensurePhpMyAdmin();
      } catch (err) {
        if (err instanceof ExecutorCodedError && err.code === "NOT_SUPPORTED") {
          throw err;
        }
        throw new ExecutorCodedError(MSG_PMA_UNAVAILABLE, "DOCKER_ENGINE_UNAVAILABLE");
      }
    }

    const stateSql = buildStateQuery(req.siteId);
    const stateRes = await this.execSql(stateSql, MARIADB_STATE_TIMEOUT_MS);
    if (stateRes.exitCode !== 0 || stateRes.exitUnknown || stateRes.truncated) {
      throw mapMariadbError(req.op, stateRes);
    }

    const state = parseSiteDatabasesState(req.siteId, stateRes.stdout.toString("utf8"));
    if (req.op === "list") {
      return toListResult(state) as SiteDatabasesResult<R["op"]>;
    }

    checkSiteDatabasesOp(state, req);
    const batchSql = buildSiteDatabasesBatch(req.siteId, state, req);
    if (batchSql !== null) {
      const batchRes = await this.execSql(batchSql, MARIADB_BATCH_TIMEOUT_MS);
      if (batchRes.exitCode !== 0 || batchRes.exitUnknown || batchRes.truncated) {
        throw mapMariadbError(req.op, batchRes);
      }
    }

    if (req.op === "phpMyAdminSignOn") {
      return {
        username: siteDatabaseSignOnUser(req.siteId),
      } as SiteDatabasesResult<R["op"]>;
    }
    return {} as SiteDatabasesResult<R["op"]>;
  }
}
