import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  ERROR_CODE_HTTP_STATUS,
  SITE_DATABASES_MAX,
  SITE_DATABASES_RESULT_SCHEMAS,
  SITE_DATABASE_USERS_MAX,
  mysqlNativePasswordHash,
  signIpcRequest,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
  type ErrorCode,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import type { SiteDatabasesRequest } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerExecutorIpcServer,
  ExecutorCodedError,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
  SimulatedSiteDatabases,
  SiteDatabasesRunner,
  buildSiteDatabasesBatch,
  buildStateQuery,
  type ExecResult,
  type SiteDatabasesState,
} from "../src/index.js";

const SITE_A = "site_qa_alpha_001";
const SITE_B = "site_qa_beta_002";
const P_A = siteDatabasePrefix(SITE_A);
const P_B = siteDatabasePrefix(SITE_B);
const A_A = siteDatabaseSignOnUser(SITE_A);
const A_B = siteDatabaseSignOnUser(SITE_B);

const HASH_1 = mysqlNativePasswordHash("QaStrongPass123456789012");
const HASH_2 = mysqlNativePasswordHash("QaRotatedPass12345678901");

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-qa-site-databases";
const SIGNING_KEY: IpcSigningKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

function okExec(stdout = ""): ExecResult {
  return {
    exitCode: 0,
    exitUnknown: false,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.alloc(0),
    truncated: false,
  };
}

function failExec(stderr: string, opts?: Partial<Omit<ExecResult, "stderr">>): ExecResult {
  return {
    exitCode: opts && "exitCode" in opts ? (opts.exitCode ?? null) : 1,
    exitUnknown: opts?.exitUnknown ?? false,
    stdout: opts?.stdout ?? Buffer.alloc(0),
    stderr: Buffer.from(stderr, "utf8"),
    truncated: opts?.truncated ?? false,
  };
}

function rawUnixPost(options: {
  readonly socketPath: string;
  readonly pathWithQuery: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Promise<{ readonly statusCode: number; readonly rawBody: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(options.body, "utf8");
    const req = http.request(
      {
        socketPath: options.socketPath,
        method: "POST",
        path: options.pathWithQuery,
        headers: {
          ...options.headers,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(bodyBuf.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            rawBody: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function startIpcWithSimulator() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-db-ipc-"));
  const socketPath = path.join(dir, `ipc-${randomBytes(4).toString("hex")}.sock`);
  const simulator = new InMemoryDockerSimulatorAdapter();
  const server = new DockerExecutorIpcServer({
    executor: simulator,
    keyring: { "hmac-v1": VERIFICATION_KEY },
    transport: "uds",
    socketPath,
    runtimeBackend: "local-simulator",
  });
  cleanupTasks.push(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await server.start();
  const client = new SignedDockerExecutorIpcClient({
    signingKey: SIGNING_KEY,
    transport: "uds",
    socketPath,
  });
  return { simulator, server, client, socketPath };
}

function buildStateStdout(opts: {
  readonly prefix: string;
  readonly signOn?: string;
  readonly databases?: ReadonlyArray<{ readonly name: string; readonly sizeBytes?: number }>;
  readonly users?: ReadonlyArray<{ readonly name: string; readonly databases?: readonly string[] }>;
  readonly signOnDatabases?: readonly string[] | null;
}): string {
  const lines: string[] = [];
  for (const db of opts.databases ?? []) {
    lines.push(`D\t${db.name}\t${String(db.sizeBytes ?? 0)}`);
  }
  for (const user of opts.users ?? []) {
    lines.push(`U\t${user.name}\t`);
  }
  if (opts.signOn && opts.signOnDatabases !== null && opts.signOnDatabases !== undefined) {
    lines.push(`U\t${opts.signOn}\t`);
    for (const db of opts.signOnDatabases) {
      lines.push(`G\t${opts.signOn}\t${db.replaceAll("_", "\\_")}`);
    }
  }
  for (const user of opts.users ?? []) {
    for (const db of user.databases ?? []) {
      lines.push(`G\t${user.name}\t${db.replaceAll("_", "\\_")}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

describe("QA Part A: Site databases security, isolation, IPC, and parity", () => {
  it("refuses hostile names in every field of every operation before calling runSql", async () => {
    const runSql = vi.fn(async () => okExec());
    const ensurePhpMyAdmin = vi.fn(async () => undefined);
    const runner = new SiteDatabasesRunner({ runSql, ensurePhpMyAdmin });

    const hostileMalformed = [
      `${P_A}_a'b`,
      `${P_A}_a"b`,
      `${P_A}_a\`b`,
      `${P_A}_a\\b`,
      `${P_A}_a;b`,
      `${P_A}_a--b`,
      `${P_A}_a/*b`,
      `${P_A}_a b`,
      `${P_A}_a\nb`,
      `${P_A}_a\0b`,
      `${P_A}_a%b`,
      "_",
      `${P_A}__`,
      `${P_A}_Shop`,
      `${P_A.toUpperCase()}_shop`,
      `${P_A}_\u0430pp`, // Cyrillic 'а' look-alike
      `${P_A}_\uff41pp`, // fullwidth 'ａ' look-alike
      `${P_A}_${"a".repeat(65 - P_A.length - 1)}`, // 65 chars total
      `${P_A}_${"a".repeat(17)}`, // 17-char suffix
      `${P_A}_a'@'%'`,
      A_A, // sign-on account name
      A_B,
      "",
    ];

    const customNameOps: Array<(name: string) => Record<string, unknown>> = [
      (name) => ({ siteId: SITE_A, op: "createDatabase", database: name }),
      (name) => ({ siteId: SITE_A, op: "deleteDatabase", database: name }),
      (name) => ({ siteId: SITE_A, op: "createUser", user: name, passwordHash: HASH_1 }),
      (name) => ({ siteId: SITE_A, op: "setUserPassword", user: name, passwordHash: HASH_1 }),
      (name) => ({ siteId: SITE_A, op: "deleteUser", user: name }),
      (name) => ({ siteId: SITE_A, op: "grant", user: name, database: `${P_A}_shop` }),
      (name) => ({ siteId: SITE_A, op: "revoke", user: name, database: `${P_A}_shop` }),
    ];

    const dbNameOps: Array<(name: string) => Record<string, unknown>> = [
      (name) => ({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: name }),
      (name) => ({ siteId: SITE_A, op: "revoke", user: `${P_A}_app`, database: name }),
    ];

    // Malformed shapes -> VALIDATION_ERROR
    for (const badName of hostileMalformed) {
      for (const buildReq of [...customNameOps, ...dbNameOps]) {
        await expect(runner.run(buildReq(badName) as SiteDatabasesRequest)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
    }

    // Bare prefix where a custom name is required -> VALIDATION_ERROR
    for (const buildReq of customNameOps) {
      await expect(runner.run(buildReq(P_A) as SiteDatabasesRequest)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }

    // Bare prefix of another site where custom name is required -> VALIDATION_ERROR (regex fails before prefix check)
    for (const buildReq of customNameOps) {
      await expect(runner.run(buildReq(P_B) as SiteDatabasesRequest)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }

    // Another site's valid custom name in any field, or another site's bare prefix in grant/revoke.database -> NOT_FOUND
    for (const buildReq of customNameOps) {
      await expect(runner.run(buildReq(`${P_B}_shop`) as SiteDatabasesRequest)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    for (const buildReq of dbNameOps) {
      await expect(runner.run(buildReq(`${P_B}_shop`) as SiteDatabasesRequest)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(runner.run(buildReq(P_B) as SiteDatabasesRequest)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }

    // Invalid siteId values across non-name ops
    for (const badSiteId of ["", "x".repeat(129)]) {
      for (const req of [
        { siteId: badSiteId, op: "list" },
        { siteId: badSiteId, op: "phpMyAdminSignOn", passwordHash: HASH_1 },
        { siteId: badSiteId, op: "dropAll" },
      ]) {
        await expect(runner.run(req as SiteDatabasesRequest)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
    }

    expect(runSql).not.toHaveBeenCalled();
    expect(ensurePhpMyAdmin).not.toHaveBeenCalled();
  });

  it("refuses hostile names and cross-site names over real IPC before reaching runSql", async () => {
    const runSql = vi.fn(async () => okExec());
    const runner = new SiteDatabasesRunner({
      runSql,
      ensurePhpMyAdmin: async () => undefined,
    });
    const fakeExecutor = new InMemoryDockerSimulatorAdapter();
    fakeExecutor.siteDatabases = (req) => runner.run(req);

    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-db-ipc-runner-"));
    const socketPath = path.join(dir, "exec.sock");
    const server = new DockerExecutorIpcServer({
      executor: fakeExecutor,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "linux-systemd",
    });
    cleanupTasks.push(async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    });
    await server.start();
    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    await expect(
      client.siteDatabases({
        siteId: SITE_A,
        op: "createDatabase",
        database: `${P_A}_a'; DROP DATABASE mysql;--`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      client.siteDatabases({
        siteId: SITE_A,
        op: "grant",
        user: `${P_A}_app`,
        database: P_B,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(runSql).not.toHaveBeenCalled();
  });

  it("never emits another site name, unescaped underscore in GRANT/REVOKE/LIKE, GRANT OPTION, or ALL PRIVILEGES ON *.* in any SQL", () => {
    const state: SiteDatabasesState = {
      databases: [
        { name: P_A, primary: true, sizeBytes: 1024 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 2048 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [P_A, `${P_A}_shop`] },
      ],
      signOnDatabases: [P_A, `${P_A}_stale`],
    };

    const ops: SiteDatabasesRequest[] = [
      { siteId: SITE_A, op: "list" },
      { siteId: SITE_A, op: "createDatabase", database: `${P_A}_shop` },
      { siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_shop` },
      { siteId: SITE_A, op: "createUser", user: `${P_A}_newu`, passwordHash: HASH_1 },
      { siteId: SITE_A, op: "setUserPassword", user: `${P_A}_app`, passwordHash: HASH_2 },
      { siteId: SITE_A, op: "deleteUser", user: `${P_A}_app` },
      { siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: P_A },
      { siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: `${P_A}_shop` },
      { siteId: SITE_A, op: "revoke", user: `${P_A}_app`, database: P_A },
      { siteId: SITE_A, op: "revoke", user: `${P_A}_app`, database: `${P_A}_shop` },
      { siteId: SITE_A, op: "phpMyAdminSignOn", passwordHash: HASH_1 },
      { siteId: SITE_A, op: "dropAll" },
    ];

    const sqlTexts: string[] = [buildStateQuery(SITE_A)];
    for (const req of ops) {
      const batch = buildSiteDatabasesBatch(SITE_A, state, req);
      if (batch !== null) {
        sqlTexts.push(batch);
      }
    }

    for (const sql of sqlTexts) {
      expect(sql).not.toContain(P_B);
      expect(sql).not.toContain(A_B);
      expect(sql).not.toMatch(/GRANT\s+OPTION/i);
      expect(sql).not.toMatch(/ALL\s+PRIVILEGES\s+ON\s+\*\.\*/i);
      expect(sql).not.toMatch(/ON\s+\*\.\*/i);

      // Every GRANT/REVOKE target `...`.* must escape every '_' as '\_'.
      for (const match of sql.matchAll(/\b(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+`([^`]+)`\.\*/g)) {
        const escapedTarget = match[1]!;
        expect(escapedTarget).not.toMatch(/(?<!\\)_/);
      }

      // Every LIKE '...' pattern must escape every '_' as '\_'.
      for (const match of sql.matchAll(/\bLIKE\s+'([^']+)'/g)) {
        const pattern = match[1]!;
        expect(pattern).not.toMatch(/(?<!\\)_/);
      }
    }
  });

  it("ignores hostile and foreign names returned in MariaDB state across list, batches, and dropAll (R29)", async () => {
    const hash12A = P_A.slice(3);
    const hostileStdout = [
      `D\t${P_A}\t100`,
      `D\t${P_A}_shop\t200`,
      `D\t${P_B}\t999`,
      `D\t${P_B}_shop\t999`,
      `D\twpX${hash12A}_decoy\t999`,
      `D\tWP_${hash12A.toUpperCase()}_UPPER\t999`,
      `D\t${P_A}_bad'quote\t0`,
      `D\t${P_A}_bad\`tick\t0`,
      `D\t${P_A}_bad;semi\t0`,
      `D\t${P_A}_bad space\t0`,
      `D\t${P_A}_${"z".repeat(17)}\t0`,
      `D\tmysql\t0`,
      `U\t${P_A}\t`,
      `U\t${P_A}_app\t`,
      `U\t${A_A}\t`,
      `U\t${P_B}\t`,
      `U\t${P_B}_app\t`,
      `U\t${A_B}\t`,
      `U\twpX${hash12A}_u\t`,
      `U\t${P_A}_bad'u\t`,
      `U\t${P_A}_bad;u\t`,
      `G\t${P_A}\t${P_A.replaceAll("_", "\\_")}`,
      `G\t${P_A}_app\t${P_A.replaceAll("_", "\\_")}\\_shop`,
      `G\t${P_A}_app\t${P_A.replaceAll("_", "\\_")}\\_bad'db`,
      `G\t${P_A}_app\t${P_B.replaceAll("_", "\\_")}`,
      `G\t${P_A}_app\t${P_A.replaceAll("_", "\\_")}X_decoy`,
      `G\t${P_A}_bad'u\t${P_A.replaceAll("_", "\\_")}\\_shop`,
      `G\t${A_A}\t${P_A.replaceAll("_", "\\_")}\\_bad'db`,
      `G\t${A_A}\t${P_B.replaceAll("_", "\\_")}\\_shop`,
      `G\t${P_B}_app\t${P_B.replaceAll("_", "\\_")}\\_shop`,
      "",
    ].join("\n");

    const batches: string[] = [];
    const runner = new SiteDatabasesRunner({
      runSql: async (sql) => {
        if (sql.includes("SELECT 'D'")) {
          return okExec(hostileStdout);
        }
        batches.push(sql);
        return okExec();
      },
      ensurePhpMyAdmin: async () => undefined,
    });

    const listRes = await runner.run({ siteId: SITE_A, op: "list" });
    expect(listRes).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 100 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 200 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [`${P_A}_shop`] },
      ],
    });

    await runner.run({ siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_shop` });
    await runner.run({ siteId: SITE_A, op: "phpMyAdminSignOn", passwordHash: HASH_1 });
    await runner.run({ siteId: SITE_A, op: "dropAll" });

    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch).not.toContain(P_B);
      expect(batch).not.toContain(A_B);
      expect(batch).not.toContain("decoy");
      expect(batch).not.toContain("UPPER");
      expect(batch).not.toContain("bad'quote");
      expect(batch).not.toContain("bad`tick");
      expect(batch).not.toContain("bad;semi");
      expect(batch).not.toContain("bad space");
      expect(batch).not.toContain("bad'u");
      expect(batch).not.toContain("bad;u");
      expect(batch).not.toContain("bad'db");
      expect(batch).not.toContain("mysql");
    }

    // Even if state contains ONLY hostile/foreign rows, dropAll runs state query only and emits no batch.
    const onlyHostileStdout = [
      `D\t${P_B}_shop\t10`,
      `D\t${P_A}_bad'db\t10`,
      `U\t${P_B}_app\t`,
      `U\t${A_B}\t`,
      `U\t${P_A}_bad'user\t`,
      "",
    ].join("\n");
    const runSqlHostileOnly = vi.fn(async () => okExec(onlyHostileStdout));
    const runnerHostileOnly = new SiteDatabasesRunner({
      runSql: runSqlHostileOnly,
      ensurePhpMyAdmin: async () => undefined,
    });
    await expect(runnerHostileOnly.run({ siteId: SITE_A, op: "dropAll" })).resolves.toEqual({});
    expect(runSqlHostileOnly).toHaveBeenCalledTimes(1);

    // Direct buildSiteDatabasesBatch check when a crafted state object holds hostile/foreign entries.
    const craftedDirtyState: SiteDatabasesState = {
      databases: [
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
        { name: `${P_A}_bad'db`, primary: false, sizeBytes: 0 },
        { name: `${P_B}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: `${P_A}_app`, primary: false, databases: [`${P_A}_shop`, `${P_A}_bad'db`] },
        { name: `${P_A}_bad'u`, primary: false, databases: [`${P_A}_shop`] },
        { name: `${P_B}_app`, primary: false, databases: [`${P_B}_shop`] },
      ],
      signOnDatabases: [`${P_A}_bad'db`, `${P_B}_shop`, `${P_A}_gone`],
    };
    const dropBatch = buildSiteDatabasesBatch(SITE_A, craftedDirtyState, {
      siteId: SITE_A,
      op: "dropAll",
    });
    expect(dropBatch).not.toBeNull();
    expect(dropBatch).not.toContain(P_B);
    expect(dropBatch).not.toContain("bad'db");
    expect(dropBatch).not.toContain("bad'u");
  });

  it("includes passwordHash in SQL only where a password is set, rejects bad hash shapes, and leaks no hash or stderr", async () => {
    const stateStdout = buildStateStdout({
      prefix: P_A,
      databases: [
        { name: P_A, sizeBytes: 100 },
        { name: `${P_A}_shop`, sizeBytes: 0 },
      ],
      users: [
        { name: P_A, databases: [P_A] },
        { name: `${P_A}_app`, databases: [`${P_A}_shop`] },
      ],
    });

    // 1. Bad hash shapes refused before any SQL
    const runSqlSpy = vi.fn(async () => okExec(stateStdout));
    const ensureSpy = vi.fn(async () => undefined);
    const runner = new SiteDatabasesRunner({ runSql: runSqlSpy, ensurePhpMyAdmin: ensureSpy });

    const badHashes = [
      "",
      "plaintext",
      HASH_1.toLowerCase(),
      HASH_1.slice(0, 40), // 39 hex chars
      `${HASH_1}A`, // 41 hex chars
      HASH_1.slice(1), // missing '*'
      `$6$rounds=5000$saltsaltsalt$hash`,
      `${HASH_1.slice(0, -1)}G`, // non-hex G
      `${HASH_1}'; SELECT 1;--`,
      `${HASH_1}\n`,
    ];

    for (const badHash of badHashes) {
      for (const req of [
        { siteId: SITE_A, op: "createUser", user: `${P_A}_u1`, passwordHash: badHash },
        { siteId: SITE_A, op: "setUserPassword", user: `${P_A}_app`, passwordHash: badHash },
        { siteId: SITE_A, op: "phpMyAdminSignOn", passwordHash: badHash },
      ]) {
        await expect(runner.run(req as SiteDatabasesRequest)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
    }
    expect(runSqlSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();

    // 2. Hash appears in SQL ONLY for createUser, setUserPassword, phpMyAdminSignOn; never in list output
    const capturedSql: string[] = [];
    const runnerCapture = new SiteDatabasesRunner({
      runSql: async (sql) => {
        capturedSql.push(sql);
        return okExec(stateStdout);
      },
      ensurePhpMyAdmin: async () => undefined,
    });

    const listed = await runnerCapture.run({ siteId: SITE_A, op: "list" });
    expect(JSON.stringify(listed)).not.toMatch(/\*[0-9A-F]{40}/);

    await runnerCapture.run({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_newdb` });
    await runnerCapture.run({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: P_A });
    await runnerCapture.run({
      siteId: SITE_A,
      op: "revoke",
      user: `${P_A}_app`,
      database: `${P_A}_shop`,
    });
    await runnerCapture.run({ siteId: SITE_A, op: "deleteUser", user: `${P_A}_app` });
    await runnerCapture.run({ siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_shop` });
    await runnerCapture.run({ siteId: SITE_A, op: "dropAll" });

    for (const sql of capturedSql) {
      expect(sql).not.toMatch(/\*[0-9A-F]{40}/);
    }

    capturedSql.length = 0;
    await runnerCapture.run({
      siteId: SITE_A,
      op: "createUser",
      user: `${P_A}_u2`,
      passwordHash: HASH_1,
    });
    expect(capturedSql[0]).not.toContain(HASH_1);
    expect(capturedSql[1]).toContain(HASH_1);

    capturedSql.length = 0;
    await runnerCapture.run({
      siteId: SITE_A,
      op: "setUserPassword",
      user: `${P_A}_app`,
      passwordHash: HASH_2,
    });
    expect(capturedSql[0]).not.toContain(HASH_2);
    expect(capturedSql[1]).toContain(HASH_2);

    capturedSql.length = 0;
    await runnerCapture.run({
      siteId: SITE_A,
      op: "phpMyAdminSignOn",
      passwordHash: HASH_1,
    });
    expect(capturedSql[0]).not.toContain(HASH_1);
    expect(capturedSql[1]).toContain(HASH_1);

    // 3. Failures carrying hash, SHOW GRANTS, MYSQL_PWD in stderr/thrown errors never leak into errors or console
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const secretStderr = `ERROR 1064 (42000): SHOW GRANTS FOR '${P_A}_app'@'%' IDENTIFIED BY PASSWORD '${HASH_1}' MYSQL_PWD=supersecret`;
    const failingRunner = new SiteDatabasesRunner({
      runSql: async (sql) => {
        if (sql.includes("SELECT 'D'")) {
          return okExec(stateStdout);
        }
        return failExec(secretStderr);
      },
      ensurePhpMyAdmin: async () => undefined,
    });

    const fakeAdapter = new InMemoryDockerSimulatorAdapter();
    fakeAdapter.siteDatabases = (req) => failingRunner.run(req);
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-db-leak-"));
    const socketPath = path.join(dir, "exec.sock");
    const server = new DockerExecutorIpcServer({
      executor: fakeAdapter,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "linux-systemd",
    });
    cleanupTasks.push(async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    });
    await server.start();
    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    const ipcErr = await client
      .siteDatabases({
        siteId: SITE_A,
        op: "setUserPassword",
        user: `${P_A}_app`,
        passwordHash: HASH_1,
      })
      .catch((e: unknown) => e);
    expect(ipcErr).toBeInstanceOf(ExecutorIpcClientError);
    const errMsg = (ipcErr as ExecutorIpcClientError).message;
    expect(errMsg).not.toContain(HASH_1);
    expect(errMsg).not.toContain("SHOW GRANTS");
    expect(errMsg).not.toContain("MYSQL_PWD");
    expect(errMsg).not.toContain("supersecret");
    expect(errMsg).not.toContain("ERROR 1064");

    const consoleOutput = [
      ...logSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join("\n");
    expect(consoleOutput).not.toContain(HASH_1);
    expect(consoleOutput).not.toContain("SHOW GRANTS");
    expect(consoleOutput).not.toContain("MYSQL_PWD");
    expect(consoleOutput).not.toContain("supersecret");
  });

  it("round-trips every operation over real IPC server+client, refuses unknown keys/wrong names without echoing body, and passes error codes", async () => {
    const { simulator, client, socketPath } = await startIpcWithSimulator();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Seed site via real db.provision job over IPC
    await client.runSiteJob({
      jobId: "job_qa_prov_1",
      kind: "db.provision",
      siteId: SITE_A,
      organizationId: "org_qa_1",
      params: { dbName: P_A, dbUser: P_A },
      resolvedSecrets: { HP_DB_PASSWORD: "a".repeat(64) },
    });

    const list1 = await client.siteDatabases({ siteId: SITE_A, op: "list" });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.list.parse(list1)).not.toThrow();
    expect(list1).toEqual({
      databases: [{ name: P_A, primary: true, sizeBytes: 0 }],
      users: [{ name: P_A, primary: true, databases: [P_A] }],
    });

    const createDbRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "createDatabase",
      database: `${P_A}_shop`,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.createDatabase.parse(createDbRes)).not.toThrow();

    const createUserRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "createUser",
      user: `${P_A}_app`,
      passwordHash: HASH_1,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.createUser.parse(createUserRes)).not.toThrow();

    const grantRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "grant",
      user: `${P_A}_app`,
      database: `${P_A}_shop`,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.grant.parse(grantRes)).not.toThrow();

    const pwRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "setUserPassword",
      user: `${P_A}_app`,
      passwordHash: HASH_2,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.setUserPassword.parse(pwRes)).not.toThrow();

    const revokeRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "revoke",
      user: `${P_A}_app`,
      database: `${P_A}_shop`,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.revoke.parse(revokeRes)).not.toThrow();

    const delUserRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "deleteUser",
      user: `${P_A}_app`,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.deleteUser.parse(delUserRes)).not.toThrow();

    const delDbRes = await client.siteDatabases({
      siteId: SITE_A,
      op: "deleteDatabase",
      database: `${P_A}_shop`,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.deleteDatabase.parse(delDbRes)).not.toThrow();

    // phpMyAdminSignOn on simulator returns NOT_SUPPORTED
    await expect(
      client.siteDatabases({
        siteId: SITE_A,
        op: "phpMyAdminSignOn",
        passwordHash: HASH_1,
      }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

    const dropAllRes = await client.siteDatabases({ siteId: SITE_A, op: "dropAll" });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.dropAll.parse(dropAllRes)).not.toThrow();

    // Verify phpMyAdminSignOn result schema over real IPC with runner
    const runner = new SiteDatabasesRunner({
      runSql: async () => okExec(buildStateStdout({ prefix: P_A, databases: [{ name: P_A }] })),
      ensurePhpMyAdmin: async () => undefined,
    });
    const signOnAdapter = new InMemoryDockerSimulatorAdapter();
    signOnAdapter.siteDatabases = (req) => runner.run(req);
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "hp-qa-db-ipc-pma-"));
    const sock2 = path.join(dir2, "exec.sock");
    const srv2 = new DockerExecutorIpcServer({
      executor: signOnAdapter,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath: sock2,
      runtimeBackend: "linux-systemd",
    });
    cleanupTasks.push(async () => {
      await srv2.stop();
      await rm(dir2, { recursive: true, force: true });
    });
    await srv2.start();
    const cli2 = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath: sock2,
    });
    const signOnRes = await cli2.siteDatabases({
      siteId: SITE_A,
      op: "phpMyAdminSignOn",
      passwordHash: HASH_1,
    });
    expect(() => SITE_DATABASES_RESULT_SCHEMAS.phpMyAdminSignOn.parse(signOnRes)).not.toThrow();
    expect(signOnRes).toEqual({ username: A_A });

    // Every error code survives the IPC wire
    const errorCodes: ErrorCode[] = [
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "ALREADY_EXISTS",
      "QUOTA_EXCEEDED",
      "RESOURCE_LOCKED",
      "DOCKER_ENGINE_UNAVAILABLE",
      "INTERNAL_ERROR",
      "NOT_SUPPORTED",
    ];
    for (const code of errorCodes) {
      simulator.databases.failNext(code);
      const err = await client
        .siteDatabases({ siteId: SITE_A, op: "list" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExecutorIpcClientError);
      expect((err as ExecutorIpcClientError).code).toBe(code);
      expect((err as ExecutorIpcClientError).statusCode).toBe(ERROR_CODE_HTTP_STATUS[code]);
    }

    // Unknown key & wrong name refused by server, and body appears in no error text
    const siteDatabasesSpy = vi.spyOn(simulator, "siteDatabases");
    const badBodies = [
      JSON.stringify({ siteId: SITE_A, op: "list", unknownField: "SECRET_BODY_MARKER_1" }),
      JSON.stringify({
        siteId: SITE_A,
        op: "createDatabase",
        database: `${P_A}_bad'SECRET_BODY_MARKER_2`,
      }),
      JSON.stringify({
        siteId: SITE_A,
        op: "createUser",
        user: `${P_A}_u1`,
        passwordHash: "NOT_A_HASH_SECRET_MARKER_3",
      }),
    ];

    for (const body of badBodies) {
      const headers = signIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/sites/databases",
        body,
        key: SIGNING_KEY,
      });
      const res = await rawUnixPost({
        socketPath,
        pathWithQuery: "/v1/sites/databases",
        headers: { ...headers },
        body,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.rawBody)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(res.rawBody).not.toContain(body);
      expect(res.rawBody).not.toContain("SECRET_BODY_MARKER_1");
      expect(res.rawBody).not.toContain("SECRET_BODY_MARKER_2");
      expect(res.rawBody).not.toContain("SECRET_BODY_MARKER_3");
    }

    // Oversized IPC body (1 MiB + 1 byte) refused before reaching simulator
    const oversizedSuffix = "a".repeat(1_048_577);
    await expect(
      client.siteDatabases({
        siteId: SITE_A,
        op: "createDatabase",
        database: `${P_A}_${oversizedSuffix}`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(siteDatabasesSpy).not.toHaveBeenCalled();

    const logs = [
      ...logSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].join("\n");
    expect(logs).not.toContain("SECRET_BODY_MARKER_1");
    expect(logs).not.toContain("SECRET_BODY_MARKER_2");
    expect(logs).not.toContain("SECRET_BODY_MARKER_3");
  });

  it("simulator and runner refuse the exact same inputs for the same state (parity table)", async () => {
    const sim = new SimulatedSiteDatabases();
    sim.provision(SITE_A);
    await sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_existing` });
    await sim.handle({
      siteId: SITE_A,
      op: "createUser",
      user: `${P_A}_existing`,
      passwordHash: HASH_1,
    });
    await sim.handle({
      siteId: SITE_A,
      op: "grant",
      user: `${P_A}_existing`,
      database: `${P_A}_existing`,
    });

    const stateStdout = buildStateStdout({
      prefix: P_A,
      databases: [{ name: P_A }, { name: `${P_A}_existing` }],
      users: [
        { name: P_A, databases: [P_A] },
        { name: `${P_A}_existing`, databases: [`${P_A}_existing`] },
      ],
    });
    const runner = new SiteDatabasesRunner({
      runSql: async (sql) => (sql.includes("SELECT 'D'") ? okExec(stateStdout) : okExec()),
      ensurePhpMyAdmin: async () => undefined,
    });

    const cases: Array<{
      readonly label: string;
      readonly req: SiteDatabasesRequest;
      readonly expected: { readonly ok: true } | { readonly code: ErrorCode };
    }> = [
      {
        label: "bare prefix createDatabase",
        req: { siteId: SITE_A, op: "createDatabase", database: P_A },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "bare prefix deleteDatabase",
        req: { siteId: SITE_A, op: "deleteDatabase", database: P_A },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "bare prefix createUser",
        req: { siteId: SITE_A, op: "createUser", user: P_A, passwordHash: HASH_1 },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "bare prefix setUserPassword",
        req: { siteId: SITE_A, op: "setUserPassword", user: P_A, passwordHash: HASH_1 },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "bare prefix deleteUser",
        req: { siteId: SITE_A, op: "deleteUser", user: P_A },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "bad hash createUser",
        req: { siteId: SITE_A, op: "createUser", user: `${P_A}_u2`, passwordHash: "bad" },
        expected: { code: "VALIDATION_ERROR" },
      },
      {
        label: "foreign database createDatabase",
        req: { siteId: SITE_A, op: "createDatabase", database: `${P_B}_shop` },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "foreign database grant",
        req: { siteId: SITE_A, op: "grant", user: `${P_A}_existing`, database: P_B },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "foreign user revoke",
        req: { siteId: SITE_A, op: "revoke", user: `${P_B}_u`, database: P_A },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "duplicate database",
        req: { siteId: SITE_A, op: "createDatabase", database: `${P_A}_existing` },
        expected: { code: "ALREADY_EXISTS" },
      },
      {
        label: "duplicate user",
        req: {
          siteId: SITE_A,
          op: "createUser",
          user: `${P_A}_existing`,
          passwordHash: HASH_1,
        },
        expected: { code: "ALREADY_EXISTS" },
      },
      {
        label: "missing database deleteDatabase",
        req: { siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_missing` },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing user setUserPassword",
        req: {
          siteId: SITE_A,
          op: "setUserPassword",
          user: `${P_A}_missing`,
          passwordHash: HASH_1,
        },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing user deleteUser",
        req: { siteId: SITE_A, op: "deleteUser", user: `${P_A}_missing` },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing user grant",
        req: { siteId: SITE_A, op: "grant", user: `${P_A}_missing`, database: P_A },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing db grant",
        req: {
          siteId: SITE_A,
          op: "grant",
          user: `${P_A}_existing`,
          database: `${P_A}_missing`,
        },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing user revoke",
        req: { siteId: SITE_A, op: "revoke", user: `${P_A}_missing`, database: P_A },
        expected: { code: "NOT_FOUND" },
      },
      {
        label: "missing grant on existing user revoke -> ok",
        req: { siteId: SITE_A, op: "revoke", user: `${P_A}_existing`, database: P_A },
        expected: { ok: true },
      },
      {
        label: "dropAll on unknown site -> ok",
        req: { siteId: "site_never_used", op: "dropAll" },
        expected: { ok: true },
      },
    ];

    async function runOutcome(fn: () => Promise<unknown>) {
      try {
        const value = await fn();
        return { ok: true as const, value };
      } catch (err) {
        expect(err).toBeInstanceOf(ExecutorCodedError);
        return { ok: false as const, code: (err as ExecutorCodedError).code };
      }
    }

    for (const c of cases) {
      const simOut = await runOutcome(() => sim.handle(c.req));
      const runOut = await runOutcome(() => runner.run(c.req));
      expect(simOut, `simulator mismatch on ${c.label}`).toEqual(runOut);
      if ("ok" in c.expected) {
        expect(runOut.ok, `expected ok on ${c.label}`).toBe(true);
      } else {
        expect(runOut, `expected ${c.expected.code} on ${c.label}`).toEqual({
          ok: false,
          code: c.expected.code,
        });
      }
    }
  });

  it("serializes concurrent ops on one site (preventing quota race) while running two sites side by side", async () => {
    const dbNamesBySite = new Map<string, string[]>([
      [
        SITE_A,
        [
          P_A,
          ...Array.from({ length: SITE_DATABASES_MAX - 1 }, (_, i) => `${P_A}_d${String(i)}`),
        ],
      ],
      [SITE_B, [P_B]],
    ]);

    let releaseSiteABatch!: () => void;
    const siteABatchGate = new Promise<void>((resolve) => {
      releaseSiteABatch = resolve;
    });
    let siteAFirstBatchStartedResolve!: () => void;
    const siteAFirstBatchStarted = new Promise<void>((resolve) => {
      siteAFirstBatchStartedResolve = resolve;
    });
    const timeline: string[] = [];

    const runner = new SiteDatabasesRunner({
      ensurePhpMyAdmin: async () => undefined,
      runSql: async (sql) => {
        const isSiteA = sql.includes(P_A);
        const siteId = isSiteA ? SITE_A : SITE_B;
        const prefix = isSiteA ? P_A : P_B;

        if (sql.includes("SELECT 'D'")) {
          const dbs = (dbNamesBySite.get(siteId) ?? []).map((name) => ({ name }));
          timeline.push(`${isSiteA ? "A" : "B"}:state`);
          return okExec(buildStateStdout({ prefix, databases: dbs }));
        }

        if (isSiteA) {
          timeline.push("A:batch:start");
          siteAFirstBatchStartedResolve();
          await siteABatchGate;
          const m = /CREATE DATABASE `([^`]+)`/.exec(sql);
          if (m?.[1]) {
            dbNamesBySite.get(SITE_A)!.push(m[1]);
          }
          timeline.push("A:batch:end");
        } else {
          timeline.push("B:batch");
        }
        return okExec();
      },
    });

    // Site A currently has primary + 9 custom DBs. Fire two concurrent createDatabase ops on Site A.
    const pA1 = runner.run({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_ten` });
    const pA2 = runner.run({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_eleven` });

    // Wait until A1's batch is in-flight, then run Site B while A1 is blocked.
    await siteAFirstBatchStarted;
    const resB = await runner.run({
      siteId: SITE_B,
      op: "createDatabase",
      database: `${P_B}_shop`,
    });
    expect(resB).toEqual({});

    // A2 has not even run its state query yet because A1 owns Site A's queue.
    expect(timeline).toEqual(["A:state", "A:batch:start", "B:state", "B:batch"]);

    releaseSiteABatch();
    await expect(pA1).resolves.toEqual({});
    await expect(pA2).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(timeline).toEqual([
      "A:state",
      "A:batch:start",
      "B:state",
      "B:batch",
      "A:batch:end",
      "A:state",
    ]);
  });

  it("enforces limits of 10 databases and 10 users without counting primary DB, primary user, or sign-on user", async () => {
    const nineCustomDbs = Array.from(
      { length: SITE_DATABASES_MAX - 1 },
      (_, i) => `${P_A}_db${String(i)}`,
    );
    const nineCustomUsers = Array.from(
      { length: SITE_DATABASE_USERS_MAX - 1 },
      (_, i) => `${P_A}_u${String(i)}`,
    );

    const dbs = [P_A, ...nineCustomDbs];
    const users = [P_A, ...nineCustomUsers];

    const runner = new SiteDatabasesRunner({
      ensurePhpMyAdmin: async () => undefined,
      runSql: async (sql) => {
        if (sql.includes("SELECT 'D'")) {
          return okExec(
            buildStateStdout({
              prefix: P_A,
              signOn: A_A,
              databases: dbs.map((name) => ({ name })),
              users: users.map((name) => ({ name })),
              signOnDatabases: [P_A],
            }),
          );
        }
        const dbMatch = /CREATE DATABASE `([^`]+)`/.exec(sql);
        if (dbMatch?.[1]) dbs.push(dbMatch[1]);
        const userMatch = /CREATE USER '([^']+)'@'%'/.exec(sql);
        if (userMatch?.[1]) users.push(userMatch[1]);
        return okExec();
      },
    });

    // 10th custom database succeeds (11 total with primary), 11th custom fails QUOTA_EXCEEDED
    await expect(
      runner.run({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_db9` }),
    ).resolves.toEqual({});
    await expect(
      runner.run({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_db10` }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    // 10th custom user succeeds (11 total + signOn user = 12 accounts), 11th custom fails QUOTA_EXCEEDED
    await expect(
      runner.run({ siteId: SITE_A, op: "createUser", user: `${P_A}_u9`, passwordHash: HASH_1 }),
    ).resolves.toEqual({});
    await expect(
      runner.run({ siteId: SITE_A, op: "createUser", user: `${P_A}_u10`, passwordHash: HASH_1 }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});
