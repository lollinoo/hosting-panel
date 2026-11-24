import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  SITE_DATABASES_MAX,
  SITE_DATABASE_USERS_MAX,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
  type ErrorCode,
  type SiteDatabasesOp,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutorCodedError,
  MARIADB_EXTRA_MAX_USER_CONNECTIONS,
  MARIADB_OWN_MAX_USER_CONNECTIONS,
  MARIADB_SIGNON_MAX_USER_CONNECTIONS,
  SiteDatabasesRunner,
  buildSiteDatabasesBatch,
  buildStateQuery,
  checkSiteDatabasesOp,
  mapMariadbError,
  mariadbRootExec,
  parseSiteDatabasesRequest,
  parseSiteDatabasesState,
  toListResult,
  type DockerExecTarget,
  type ExecResult,
  type SiteDatabasesState,
} from "../src/index.js";

const SITE_ID = "site_01j8x7k9m2p4q6r8s0t2";
const OTHER_SITE_ID = "site_other_999";
const P = siteDatabasePrefix(SITE_ID);
const P_ESC = P.replaceAll("_", "\\_");
const A = siteDatabaseSignOnUser(SITE_ID);
const OTHER_P = siteDatabasePrefix(OTHER_SITE_ID);
const HASH = "*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19";
const HASH_2 = "*00A51F3F48415C7D4E8908980D443C29C69B60C9";

const EXPECTED_PRIVS =
  "ALTER, ALTER ROUTINE, CREATE, CREATE ROUTINE, CREATE TEMPORARY TABLES, CREATE VIEW, DELETE, DELETE HISTORY, DROP, EVENT, EXECUTE, INDEX, INSERT, LOCK TABLES, REFERENCES, SELECT, SHOW CREATE ROUTINE, SHOW VIEW, TRIGGER, UPDATE";

const EXPECTED_CMD = [
  "sh",
  "-c",
  'MYSQL_PWD="$(cat /run/secrets/mariadb-root)" exec mariadb --user=root --batch --skip-column-names --raw',
];

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

function okResult(stdout = ""): ExecResult {
  return {
    exitCode: 0,
    exitUnknown: false,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.alloc(0),
    truncated: false,
  };
}

function failResult(
  stderr: string,
  opts?: Partial<Omit<ExecResult, "stderr">>,
): ExecResult {
  return {
    exitCode: opts && "exitCode" in opts ? (opts.exitCode ?? null) : 1,
    exitUnknown: opts?.exitUnknown ?? false,
    stdout: opts?.stdout ?? Buffer.alloc(0),
    stderr: Buffer.from(stderr, "utf8"),
    truncated: opts?.truncated ?? false,
  };
}

function encodeDockerFrame(stream: 1 | 2, data: Buffer | string): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function startFakeExecDocker(opts?: {
  createStatus?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): Promise<{
  target: DockerExecTarget;
  createBodies: Array<{ container: string; body: Record<string, unknown> }>;
  stdins: Buffer[];
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-site-db-exec-"));
  const socketPath = path.join(dir, "docker.sock");
  const apiPrefix = "/v1.45";
  const createBodies: Array<{ container: string; body: Record<string, unknown> }> = [];
  const stdins: Buffer[] = [];
  const openSockets = new Set<Duplex>();

  const stripPrefix = (u: string) => (u.startsWith(apiPrefix) ? u.slice(apiPrefix.length) : u);

  const server = http.createServer((req, res) => {
    const urlPath = stripPrefix((req.url ?? "/").split("?")[0] ?? "/");
    const createMatch = /^\/containers\/([^/]+)\/exec$/.exec(urlPath);
    if (req.method === "POST" && createMatch?.[1]) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        createBodies.push({ container: decodeURIComponent(createMatch[1]!), body });
        const status = opts?.createStatus ?? 201;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 201 ? { Id: "exec_1" } : { message: "no container" }));
      });
      return;
    }

    if (req.method === "GET" && /^\/exec\/[^/]+\/json$/.test(urlPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Running: false, ExitCode: opts?.exitCode ?? 0 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    // The HTTP server drops its own error handler on upgrade.
    socket.on("error", () => undefined);
    const parsedLen = Number(req.headers["content-length"] ?? 0);
    const contentLength = Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : 0;
    const reqChunks: Buffer[] = [];

    const runUpgrade = () => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: tcp\r\n\r\n",
      );
      const inChunks: Buffer[] = [];
      socket.on("data", (c: Buffer) => inChunks.push(c));
      socket.on("end", () => {
        stdins.push(Buffer.concat(inChunks));
        const frames: Buffer[] = [];
        if (opts?.stdout) frames.push(encodeDockerFrame(1, opts.stdout));
        if (opts?.stderr) frames.push(encodeDockerFrame(2, opts.stderr));
        socket.end(Buffer.concat(frames));
      });
    };

    req.on("data", (c: Buffer) => reqChunks.push(c));
    req.on("end", () => {
      const reqBody = Buffer.concat(reqChunks);
      if (reqBody.length >= contentLength) {
        const trailing = Buffer.concat([reqBody.subarray(contentLength), head]);
        if (trailing.length > 0) socket.unshift(trailing);
        runUpgrade();
        return;
      }
      const chunks: Buffer[] = head.length > 0 ? [reqBody, head] : [reqBody];
      let bytes = Buffer.concat(chunks).length;
      const onReadable = () => {
        for (;;) {
          const chunk = socket.read() as Buffer | null;
          if (chunk === null) break;
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes >= contentLength) {
            socket.off("readable", onReadable);
            const full = Buffer.concat(chunks);
            const trailing = full.subarray(contentLength);
            if (trailing.length > 0) socket.unshift(trailing);
            runUpgrade();
            return;
          }
        }
      };
      if (bytes >= contentLength) {
        runUpgrade();
      } else {
        socket.on("readable", onReadable);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanupTasks.push(async () => {
    for (const s of openSockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const request: DockerExecTarget["request"] = (method, endpointPath, jsonBody, reqOpts) =>
    new Promise((resolve, reject) => {
      const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody));
      const req = http.request(
        {
          socketPath,
          method,
          path: `${apiPrefix}${endpointPath}`,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : undefined,
          timeout: reqOpts?.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ statusCode: res.statusCode ?? 500, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  return {
    target: { request, socketPath, apiPrefix },
    createBodies,
    stdins,
  };
}

describe("mariadbRootExec", () => {
  it("runs the constant command on stdin with no Env, User, or WorkingDir", async () => {
    const fake = await startFakeExecDocker({ stdout: `D\t${P}\t16384\n` });
    const exec = mariadbRootExec(fake.target, "hp_mariadb_test");
    const sql = buildStateQuery(SITE_ID);
    const res = await exec(sql);

    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString("utf8")).toBe(`D\t${P}\t16384\n`);
    expect(fake.createBodies).toHaveLength(1);
    const { container, body } = fake.createBodies[0]!;
    expect(container).toBe("hp_mariadb_test");
    expect(body.Cmd).toEqual(EXPECTED_CMD);
    expect(body).not.toHaveProperty("Env");
    expect(body).not.toHaveProperty("User");
    expect(body).not.toHaveProperty("WorkingDir");
    expect(body.AttachStdin).toBe(true);
    expect(fake.stdins[0]!.toString("utf8")).toBe(sql);
  });

  it("maps container 404/409 from runDockerExec to DOCKER_ENGINE_UNAVAILABLE with a fixed message", async () => {
    const fake = await startFakeExecDocker({ createStatus: 404 });
    const exec = mariadbRootExec(fake.target, "hp_mariadb_missing");
    await expect(exec("SELECT 1;")).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "The database server is not available. Retry in a few minutes",
    });
  });

  it("passes R27 timeouts (15s state, 45s batch) and 1 MiB output cap through runSql", async () => {
    const calls: Array<{ sql: string; timeoutMs?: number }> = [];
    const runner = new SiteDatabasesRunner({
      runSql: async (sql, opts) => {
        calls.push({ sql, timeoutMs: opts?.timeoutMs });
        return okResult();
      },
      ensurePhpMyAdmin: async () => undefined,
    });

    await runner.run({ siteId: SITE_ID, op: "createDatabase", database: `${P}_shop` });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.timeoutMs).toBe(15_000);
    expect(calls[1]!.timeoutMs).toBe(45_000);
  });
});

describe("parseSiteDatabasesRequest", () => {
  it("accepts valid requests and rejects malformed shapes and non-native hashes with VALIDATION_ERROR", () => {
    expect(parseSiteDatabasesRequest({ siteId: SITE_ID, op: "list" })).toEqual({
      siteId: SITE_ID,
      op: "list",
    });

    const invalidInputs = [
      null,
      { siteId: "", op: "list" },
      { siteId: SITE_ID, op: "list", extra: true },
      { siteId: SITE_ID, op: "createDatabase", database: P }, // bare prefix protected
      { siteId: SITE_ID, op: "deleteDatabase", database: P },
      { siteId: SITE_ID, op: "createUser", user: P, passwordHash: HASH },
      { siteId: SITE_ID, op: "setUserPassword", user: P, passwordHash: HASH },
      { siteId: SITE_ID, op: "deleteUser", user: P },
      { siteId: SITE_ID, op: "createUser", user: `${P}_app`, passwordHash: "not-a-hash" },
      { siteId: SITE_ID, op: "createUser", user: `${P}_app`, passwordHash: HASH.toLowerCase() },
      { siteId: SITE_ID, op: "phpMyAdminSignOn", passwordHash: "$6$rounds=5000$abc$def" },
      { siteId: SITE_ID, op: "createDatabase", database: `${P}_bad\`name` },
      { siteId: SITE_ID, op: "createDatabase", database: `${P}_bad'name` },
    ];

    for (const bad of invalidInputs) {
      expect(() => parseSiteDatabasesRequest(bad)).toThrowError(ExecutorCodedError);
      try {
        parseSiteDatabasesRequest(bad);
      } catch (err) {
        expect((err as ExecutorCodedError).code).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("refuses another site's database or user with NOT_FOUND without touching SQL", async () => {
    const crossSiteReqs = [
      { siteId: SITE_ID, op: "createDatabase", database: `${OTHER_P}_shop` },
      { siteId: SITE_ID, op: "deleteDatabase", database: `${OTHER_P}_shop` },
      { siteId: SITE_ID, op: "createUser", user: `${OTHER_P}_app`, passwordHash: HASH },
      { siteId: SITE_ID, op: "setUserPassword", user: `${OTHER_P}_app`, passwordHash: HASH },
      { siteId: SITE_ID, op: "deleteUser", user: `${OTHER_P}_app` },
      { siteId: SITE_ID, op: "grant", user: `${OTHER_P}_app`, database: `${P}_shop` },
      { siteId: SITE_ID, op: "grant", user: `${P}_app`, database: `${OTHER_P}_shop` },
      { siteId: SITE_ID, op: "grant", user: `${P}_app`, database: OTHER_P },
      { siteId: SITE_ID, op: "revoke", user: `${OTHER_P}_app`, database: `${P}_shop` },
      { siteId: SITE_ID, op: "revoke", user: `${P}_app`, database: OTHER_P },
    ];

    const runSql = vi.fn(async () => okResult());
    const runner = new SiteDatabasesRunner({
      runSql,
      ensurePhpMyAdmin: async () => undefined,
    });

    for (const req of crossSiteReqs) {
      expect(() => parseSiteDatabasesRequest(req)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
      await expect(runner.run(req as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(runSql).not.toHaveBeenCalled();
  });
});

describe("buildStateQuery and parseSiteDatabasesState", () => {
  it("pins the exact state query SQL with filtered TABLE_SCHEMA, escaped underscores, and tab/newline skip", () => {
    const q = buildStateQuery(SITE_ID);
    expect(q).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `SELECT 'D', s.SCHEMA_NAME, COALESCE(t.sz, 0) FROM information_schema.SCHEMATA s LEFT JOIN (SELECT TABLE_SCHEMA, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS sz FROM information_schema.TABLES WHERE (TABLE_SCHEMA = '${P}' OR TABLE_SCHEMA LIKE '${P_ESC}\\_%') AND TABLE_SCHEMA NOT REGEXP '[\\t\\n\\r]' GROUP BY TABLE_SCHEMA) t ON t.TABLE_SCHEMA = s.SCHEMA_NAME WHERE (s.SCHEMA_NAME = '${P}' OR s.SCHEMA_NAME LIKE '${P_ESC}\\_%') AND s.SCHEMA_NAME NOT REGEXP '[\\t\\n\\r]';`,
        `SELECT 'U', User, '' FROM mysql.user WHERE Host = '%' AND (User = '${P}' OR User LIKE '${P_ESC}\\_%' OR User = '${A}') AND User NOT REGEXP '[\\t\\n\\r]';`,
        `SELECT 'G', User, Db FROM mysql.db WHERE Host = '%' AND (User = '${P}' OR User LIKE '${P_ESC}\\_%' OR User = '${A}') AND User NOT REGEXP '[\\t\\n\\r]' AND Db NOT REGEXP '[\\t\\n\\r]';`,
      ].join("\n"),
    );
  });

  it("keeps per-site MariaDB connection budget within 100 (own + 10*extra + signOn <= 100) (R40)", () => {
    expect(MARIADB_OWN_MAX_USER_CONNECTIONS).toBe(40);
    expect(MARIADB_EXTRA_MAX_USER_CONNECTIONS).toBe(5);
    expect(MARIADB_SIGNON_MAX_USER_CONNECTIONS).toBe(10);
    expect(
      MARIADB_OWN_MAX_USER_CONNECTIONS +
        SITE_DATABASE_USERS_MAX * MARIADB_EXTRA_MAX_USER_CONNECTIONS +
        MARIADB_SIGNON_MAX_USER_CONNECTIONS,
    ).toBeLessThanOrEqual(100);
  });

  it("parses real state output, unescapes Db, hides dropped DB grants from toListResult, and skips hostile rows", () => {
    const hash12 = createHash("sha256").update(SITE_ID).digest("hex").slice(0, 12);
    const wildcardDecoy = `wpX${hash12}_shop`;
    const uppercaseRow = `WP_${hash12.toUpperCase()}_SHOP`;
    const stdout = [
      `D\t${P}\t16384`,
      `D\t${P}_shop\t0`,
      `D\t${wildcardDecoy}\t999`,
      `D\t${uppercaseRow}\t999`,
      `D\t${OTHER_P}_shop\t999`,
      `D\t${P}_bad'quote\t0`,
      `D\t${P}_bad\`tick\t0`,
      `D\t${P}_bad\\r\r\t0`,
      `U\t${P}\t`,
      `U\t${P}_app\t`,
      `U\t${A}\t`,
      `U\t${OTHER_P}_app\t`,
      `U\t${wildcardDecoy}\t`,
      `U\t${P}_bad'user\t`,
      `G\t${P}\t${P_ESC}`,
      `G\t${P}_app\t${P_ESC}\\_shop`,
      `G\t${P}_app\t${P_ESC}\\_dropped`,
      `G\t${P}_app\t${P_ESC}X_decoy`,
      `G\t${P}_app\t${P_ESC}\\_bad'db`,
      `G\t${A}\t${P_ESC}`,
      `G\t${A}\t${P_ESC}\\_shop`,
      `G\t${A}\t${P_ESC}\\_dropped`,
      "",
    ].join("\n");

    const state = parseSiteDatabasesState(SITE_ID, stdout);
    expect(state).toEqual({
      databases: [
        { name: P, primary: true, sizeBytes: 16384 },
        { name: `${P}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P, primary: true, databases: [P] },
        { name: `${P}_app`, primary: false, databases: [`${P}_dropped`, `${P}_shop`] },
      ],
      signOnDatabases: [P, `${P}_dropped`, `${P}_shop`],
    });

    const list = toListResult(state);
    expect(list).toEqual({
      databases: [
        { name: P, primary: true, sizeBytes: 16384 },
        { name: `${P}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P, primary: true, databases: [P] },
        { name: `${P}_app`, primary: false, databases: [`${P}_shop`] },
      ],
    });
  });

  it("parses captured real MariaDB 12.3.3 state stdout verbatim", () => {
    // Captured verbatim from MariaDB 12.3.3 via `mariadb --batch --raw --skip-column-names`
    // in .herdr-swarm/swarm-1114-132739/scratch/db-smoke.mjs for site_smoke_a_14e526.
    const capturedSiteId = "site_smoke_a_14e526";
    const capturedStdout =
      "D\twp_f9aa26a3c422\t0\n" +
      "D\twp_f9aa26a3c422_app\t16384\n" +
      "U\twp_f9aa26a3c422\t\n" +
      "U\twp_f9aa26a3c422_idle\t\n" +
      "U\twp_f9aa26a3c422_reader\t\n" +
      "G\twp_f9aa26a3c422\twp\\_f9aa26a3c422\n" +
      "G\twp_f9aa26a3c422_reader\twp\\_f9aa26a3c422\\_app\n";

    const parsed = parseSiteDatabasesState(capturedSiteId, capturedStdout);
    expect(parsed).toEqual({
      databases: [
        { name: "wp_f9aa26a3c422", primary: true, sizeBytes: 0 },
        { name: "wp_f9aa26a3c422_app", primary: false, sizeBytes: 16384 },
      ],
      users: [
        { name: "wp_f9aa26a3c422", primary: true, databases: ["wp_f9aa26a3c422"] },
        { name: "wp_f9aa26a3c422_idle", primary: false, databases: [] },
        { name: "wp_f9aa26a3c422_reader", primary: false, databases: ["wp_f9aa26a3c422_app"] },
      ],
      signOnDatabases: null,
    });
    expect(toListResult(parsed)).toEqual({
      databases: parsed.databases,
      users: parsed.users,
    });
  });

  it("rejects malformed lines (wrong field count, unknown tag, newline split, non-digit or unsafe size) with INTERNAL_ERROR", () => {
    const badOutputs = [
      `D\t${P}`,
      `D\t${P}\t0\textra`,
      `X\t${P}\t0`,
      `D\t${P}_a\nb\t0`,
      `D\t${P}\tnot-a-number`,
      `D\t${P}\t-1`,
      `D\t${P}\t9007199254740992`,
      `D\t${P}\t${"9".repeat(20)}`,
    ];

    for (const bad of badOutputs) {
      expect(() => parseSiteDatabasesState(SITE_ID, bad)).toThrow(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          message: "The database server refused the change",
        }),
      );
    }
  });
});

describe("checkSiteDatabasesOp", () => {
  const baseState: SiteDatabasesState = {
    databases: [
      { name: P, primary: true, sizeBytes: 0 },
      { name: `${P}_shop`, primary: false, sizeBytes: 0 },
    ],
    users: [
      { name: P, primary: true, databases: [P] },
      { name: `${P}_app`, primary: false, databases: [`${P}_shop`] },
    ],
    signOnDatabases: null,
  };

  it("enforces ALREADY_EXISTS, QUOTA_EXCEEDED (10 custom, ignoring primary), and NOT_FOUND", () => {
    expect(() =>
      checkSiteDatabasesOp(baseState, {
        siteId: SITE_ID,
        op: "createDatabase",
        database: `${P}_shop`,
      }),
    ).toThrow(expect.objectContaining({ code: "ALREADY_EXISTS" }));

    expect(() =>
      checkSiteDatabasesOp(baseState, {
        siteId: SITE_ID,
        op: "createUser",
        user: `${P}_app`,
        passwordHash: HASH,
      }),
    ).toThrow(expect.objectContaining({ code: "ALREADY_EXISTS" }));

    const fullDbsState: SiteDatabasesState = {
      databases: [
        { name: P, primary: true, sizeBytes: 0 },
        ...Array.from({ length: SITE_DATABASES_MAX }, (_, i) => ({
          name: `${P}_db${String(i)}`,
          primary: false,
          sizeBytes: 0,
        })),
      ],
      users: [],
      signOnDatabases: null,
    };
    expect(() =>
      checkSiteDatabasesOp(fullDbsState, {
        siteId: SITE_ID,
        op: "createDatabase",
        database: `${P}_db10`,
      }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));

    // 9 custom + 1 primary is still allowed
    const nineCustomDbs: SiteDatabasesState = {
      databases: fullDbsState.databases.slice(0, SITE_DATABASES_MAX),
      users: [],
      signOnDatabases: null,
    };
    expect(() =>
      checkSiteDatabasesOp(nineCustomDbs, {
        siteId: SITE_ID,
        op: "createDatabase",
        database: `${P}_db9`,
      }),
    ).not.toThrow();

    const fullUsersState: SiteDatabasesState = {
      databases: [],
      users: [
        { name: P, primary: true, databases: [P] },
        ...Array.from({ length: SITE_DATABASE_USERS_MAX }, (_, i) => ({
          name: `${P}_u${String(i)}`,
          primary: false,
          databases: [],
        })),
      ],
      signOnDatabases: null,
    };
    expect(() =>
      checkSiteDatabasesOp(fullUsersState, {
        siteId: SITE_ID,
        op: "createUser",
        user: `${P}_u10`,
        passwordHash: HASH,
      }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));

    const missingOps = [
      { siteId: SITE_ID, op: "deleteDatabase", database: `${P}_missing` },
      { siteId: SITE_ID, op: "setUserPassword", user: `${P}_missing`, passwordHash: HASH },
      { siteId: SITE_ID, op: "deleteUser", user: `${P}_missing` },
      { siteId: SITE_ID, op: "grant", user: `${P}_missing`, database: `${P}_shop` },
      { siteId: SITE_ID, op: "grant", user: `${P}_app`, database: `${P}_missing` },
      { siteId: SITE_ID, op: "revoke", user: `${P}_missing`, database: `${P}_shop` },
    ] as const;

    for (const op of missingOps) {
      expect(() => checkSiteDatabasesOp(baseState, op)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    }

    // Revoking a missing grant for an existing user is allowed (becomes a no-op batch)
    expect(() =>
      checkSiteDatabasesOp(baseState, {
        siteId: SITE_ID,
        op: "revoke",
        user: `${P}_app`,
        database: P,
      }),
    ).not.toThrow();
  });
});

describe("buildSiteDatabasesBatch (pinned SQL per op)", () => {
  const emptyState: SiteDatabasesState = { databases: [], users: [], signOnDatabases: null };

  it("pins list, createDatabase (stale grant cleanup + signOn re-grant), and deleteDatabase", () => {
    expect(buildSiteDatabasesBatch(SITE_ID, emptyState, { siteId: SITE_ID, op: "list" })).toBeNull();

    const createWithStaleAndSignOn: SiteDatabasesState = {
      databases: [{ name: P, primary: true, sizeBytes: 0 }],
      users: [
        { name: P, primary: true, databases: [P] },
        { name: `${P}_z`, primary: false, databases: [`${P}_shop`] },
        { name: `${P}_a`, primary: false, databases: [`${P}_shop`] },
      ],
      signOnDatabases: [P],
    };
    const createBatch = buildSiteDatabasesBatch(SITE_ID, createWithStaleAndSignOn, {
      siteId: SITE_ID,
      op: "createDatabase",
      database: `${P}_shop`,
    });
    expect(createBatch).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* FROM '${P}_a'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* FROM '${P}_z'@'%';`,
        `CREATE DATABASE \`${P}_shop\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `GRANT ${EXPECTED_PRIVS} ON \`${P_ESC}\\_shop\`.* TO '${A}'@'%';`,
      ].join("\n"),
    );
    expect(createBatch).not.toMatch(/GRANT\s+ALL\s+PRIVILEGES/i);
    expect(createBatch).not.toContain("GRANT OPTION");

    const deleteState: SiteDatabasesState = {
      databases: [
        { name: P, primary: true, sizeBytes: 0 },
        { name: `${P}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: `${P}_app`, primary: false, databases: [`${P}_shop`] },
        { name: P, primary: true, databases: [P] },
      ],
      signOnDatabases: [P, `${P}_shop`],
    };
    const deleteBatch = buildSiteDatabasesBatch(SITE_ID, deleteState, {
      siteId: SITE_ID,
      op: "deleteDatabase",
      database: `${P}_shop`,
    });
    expect(deleteBatch).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* FROM '${A}'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* FROM '${P}_app'@'%';`,
        `DROP DATABASE IF EXISTS \`${P}_shop\`;`,
      ].join("\n"),
    );
  });

  it("pins createUser, setUserPassword, deleteUser, grant, revoke, phpMyAdminSignOn, and dropAll", () => {
    expect(
      buildSiteDatabasesBatch(SITE_ID, emptyState, {
        siteId: SITE_ID,
        op: "createUser",
        user: `${P}_app`,
        passwordHash: HASH,
      }),
    ).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `CREATE USER '${P}_app'@'%' IDENTIFIED BY PASSWORD '${HASH}' WITH MAX_USER_CONNECTIONS 5;`,
      ].join("\n"),
    );

    expect(
      buildSiteDatabasesBatch(SITE_ID, emptyState, {
        siteId: SITE_ID,
        op: "setUserPassword",
        user: `${P}_app`,
        passwordHash: HASH_2,
      }),
    ).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `ALTER USER '${P}_app'@'%' IDENTIFIED BY PASSWORD '${HASH_2}';`,
        `KILL USER '${P}_app'@'%';`,
      ].join("\n"),
    );

    expect(
      buildSiteDatabasesBatch(SITE_ID, emptyState, {
        siteId: SITE_ID,
        op: "deleteUser",
        user: `${P}_app`,
      }),
    ).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `DROP USER IF EXISTS '${P}_app'@'%';`,
        `KILL USER '${P}_app'@'%';`,
      ].join("\n"),
    );

    const grantSql = buildSiteDatabasesBatch(SITE_ID, emptyState, {
      siteId: SITE_ID,
      op: "grant",
      user: `${P}_app`,
      database: P,
    });
    expect(grantSql).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `GRANT ${EXPECTED_PRIVS} ON \`${P_ESC}\`.* TO '${P}_app'@'%';`,
      ].join("\n"),
    );
    expect(grantSql).not.toContain("GRANT OPTION");
    expect(grantSql).not.toMatch(/GRANT\s+ALL\s+PRIVILEGES/i);

    const withGrant: SiteDatabasesState = {
      databases: [{ name: `${P}_shop`, primary: false, sizeBytes: 0 }],
      users: [{ name: `${P}_app`, primary: false, databases: [`${P}_shop`] }],
      signOnDatabases: null,
    };
    expect(
      buildSiteDatabasesBatch(SITE_ID, withGrant, {
        siteId: SITE_ID,
        op: "revoke",
        user: `${P}_app`,
        database: `${P}_shop`,
      }),
    ).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* FROM '${P}_app'@'%';`,
        `KILL USER '${P}_app'@'%';`,
      ].join("\n"),
    );

    expect(
      buildSiteDatabasesBatch(SITE_ID, withGrant, {
        siteId: SITE_ID,
        op: "revoke",
        user: `${P}_app`,
        database: P,
      }),
    ).toBeNull();

    const signOnState: SiteDatabasesState = {
      databases: [
        { name: `${P}_shop`, primary: false, sizeBytes: 0 },
        { name: P, primary: true, sizeBytes: 0 },
      ],
      users: [],
      signOnDatabases: [`${P}_gone`, P],
    };
    const signOnBatch = buildSiteDatabasesBatch(SITE_ID, signOnState, {
      siteId: SITE_ID,
      op: "phpMyAdminSignOn",
      passwordHash: HASH,
    });
    expect(signOnBatch).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `CREATE USER IF NOT EXISTS '${A}'@'%' IDENTIFIED BY PASSWORD '${HASH}' WITH MAX_USER_CONNECTIONS 10 MAX_STATEMENT_TIME 300;`,
        `ALTER USER '${A}'@'%' IDENTIFIED BY PASSWORD '${HASH}' WITH MAX_USER_CONNECTIONS 10 MAX_STATEMENT_TIME 300;`,
        `KILL USER '${A}'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${P_ESC}\\_gone\`.* FROM '${A}'@'%';`,
        `GRANT ${EXPECTED_PRIVS} ON \`${P_ESC}\`.* TO '${A}'@'%';`,
        `GRANT ${EXPECTED_PRIVS} ON \`${P_ESC}\\_shop\`.* TO '${A}'@'%';`,
      ].join("\n"),
    );

    expect(buildSiteDatabasesBatch(SITE_ID, emptyState, { siteId: SITE_ID, op: "dropAll" })).toBeNull();

    const fullState: SiteDatabasesState = {
      databases: [
        { name: `${P}_shop`, primary: false, sizeBytes: 0 },
        { name: P, primary: true, sizeBytes: 0 },
      ],
      users: [
        { name: `${P}_app`, primary: false, databases: [`${P}_shop`] },
        { name: P, primary: true, databases: [P] },
      ],
      signOnDatabases: [P],
    };
    expect(buildSiteDatabasesBatch(SITE_ID, fullState, { siteId: SITE_ID, op: "dropAll" })).toBe(
      [
        "SET SESSION lock_wait_timeout = 30;",
        `DROP USER IF EXISTS '${A}'@'%';`,
        `DROP USER IF EXISTS '${P}'@'%';`,
        `DROP USER IF EXISTS '${P}_app'@'%';`,
        `KILL USER '${A}'@'%';`,
        `KILL USER '${P}'@'%';`,
        `KILL USER '${P}_app'@'%';`,
        `DROP DATABASE IF EXISTS \`${P}\`;`,
        `DROP DATABASE IF EXISTS \`${P}_shop\`;`,
      ].join("\n"),
    );
  });
});

describe("mapMariadbError and secret redaction", () => {
  it("maps every row of the MariaDB error table and never leaks stderr, hash, or names", () => {
    const cases: Array<{
      op: SiteDatabasesOp;
      res: ExecResult;
      code: ErrorCode;
      message: string;
    }> = [
      {
        op: "list",
        res: failResult(`secret ${HASH} ${P}_shop`, { exitCode: null }),
        code: "DOCKER_ENGINE_UNAVAILABLE",
        message: "The database server did not answer in time",
      },
      {
        op: "list",
        res: failResult(`secret ${HASH}`, { exitCode: null, exitUnknown: true }),
        code: "DOCKER_ENGINE_UNAVAILABLE",
        message: "The database server did not answer in time",
      },
      {
        op: "list",
        res: failResult("", { exitCode: 0, truncated: true }),
        code: "INTERNAL_ERROR",
        message: "The database server refused the change",
      },
      {
        op: "createDatabase",
        res: failResult(`ERROR 1007 (HY000): Can't create database '${P}_shop'`),
        code: "ALREADY_EXISTS",
        message: "A database with this name already exists",
      },
      {
        op: "createUser",
        res: failResult(`ERROR 1396 (HY000): Operation CREATE USER failed for '${P}_app'@'%' ${HASH}`),
        code: "ALREADY_EXISTS",
        message: "A database user with this name already exists",
      },
      {
        op: "setUserPassword",
        res: failResult(`ERROR 1396 (HY000): Operation ALTER USER failed for '${P}_app'@'%' ${HASH}`),
        code: "NOT_FOUND",
        message: "The database or database user was not found",
      },
      {
        op: "deleteDatabase",
        res: failResult(`ERROR 1008 (HY000): Can't drop database '${P}_shop'`),
        code: "NOT_FOUND",
        message: "The database or database user was not found",
      },
      {
        op: "grant",
        res: failResult(`ERROR 1049 (42000): Unknown database '${P}_shop'`),
        code: "NOT_FOUND",
        message: "The database or database user was not found",
      },
      {
        op: "grant",
        res: failResult(`ERROR 1133 (28000): Can't find any matching row`),
        code: "NOT_FOUND",
        message: "The database or database user was not found",
      },
      {
        op: "revoke",
        res: failResult(`ERROR 1141 (42000): There is no such grant defined`),
        code: "NOT_FOUND",
        message: "The database or database user was not found",
      },
      {
        op: "deleteDatabase",
        res: failResult(`ERROR 1205 (HY000): Lock wait timeout exceeded`),
        code: "RESOURCE_LOCKED",
        message: "The database is in use. Retry in a minute",
      },
      ...["1040", "1045", "1053", "2002", "2003", "2006", "2013", "2026"].map((num) => ({
        op: "list" as const,
        res: failResult(`ERROR ${num} (HY000): Server connection error ${HASH}`),
        code: "DOCKER_ENGINE_UNAVAILABLE" as const,
        message: "The database server is not available. Retry in a few minutes",
      })),
      {
        op: "createDatabase",
        res: failResult(`ERROR 1064 (42000): syntax error near '${HASH}'`),
        code: "INTERNAL_ERROR",
        message: "The database server refused the change",
      },
    ];

    for (const c of cases) {
      const err = mapMariadbError(c.op, c.res);
      expect(err).toBeInstanceOf(ExecutorCodedError);
      expect(err.code).toBe(c.code);
      expect(err.message).toBe(c.message);
      expect(err.message).not.toContain(HASH);
      expect(err.message).not.toContain(P);
      expect(err.message).not.toContain("ERROR ");
    }
  });
});

describe("SiteDatabasesRunner", () => {
  it("runs missing-same-site deleteDatabase state-only (1 SQL call) and returns NOT_FOUND", async () => {
    const runSql = vi.fn(async () => okResult(`D\t${P}\t0\nU\t${P}\t\n`));
    const runner = new SiteDatabasesRunner({
      runSql,
      ensurePhpMyAdmin: async () => undefined,
    });

    await expect(
      runner.run({ siteId: SITE_ID, op: "deleteDatabase", database: `${P}_missing` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(runSql).toHaveBeenCalledTimes(1);
  });

  it("enforces per-site serial queue, parallel sites, non-blocking rejections, and never logs secrets", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let callCount = 0;

    const runner = new SiteDatabasesRunner({
      runSql: async (sql) => {
        const idx = ++callCount;
        if (sql.includes(P) && idx === 1) {
          events.push("A1:start");
          await firstGate;
          events.push("A1:fail");
          return failResult(`ERROR 1064 (42000): bad near ${HASH}`);
        }
        if (sql.includes(OTHER_P)) {
          events.push("B1:run");
          return okResult(`D\t${OTHER_P}\t0\nU\t${OTHER_P}\t\n`);
        }
        events.push("A2:run");
        return okResult(`D\t${P}\t0\nU\t${P}\t\n`);
      },
      ensurePhpMyAdmin: async () => undefined,
    });

    const pA1 = runner.run({ siteId: SITE_ID, op: "list" }).catch((e: unknown) => e);
    const pA2 = runner.run({ siteId: SITE_ID, op: "list" });
    const pB1 = runner.run({ siteId: OTHER_SITE_ID, op: "list" });

    // Site B completes while Site A's first op is still blocked; A2 has not started yet.
    const resB = await pB1;
    expect(resB.databases).toHaveLength(1);
    expect(events).toEqual(["A1:start", "B1:run"]);

    releaseFirst();
    const errA1 = await pA1;
    expect(errA1).toBeInstanceOf(ExecutorCodedError);
    expect((errA1 as ExecutorCodedError).code).toBe("INTERNAL_ERROR");
    expect((errA1 as ExecutorCodedError).message).not.toContain(HASH);

    // Rejected A1 did not block A2.
    const resA2 = await pA2;
    expect(resA2.databases).toHaveLength(1);
    expect(events).toEqual(["A1:start", "B1:run", "A1:fail", "A2:run"]);

    // Invalid input does not enter queue or call runSql.
    await expect(
      runner.run({ siteId: SITE_ID, op: "createUser", user: `${P}_u`, passwordHash: "bad" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].join("\n");
    expect(allLogs).not.toContain(HASH);
  });

  it("handles phpMyAdminSignOn ensurePhpMyAdmin ordering, pass-through NOT_SUPPORTED, and failures", async () => {
    const order: string[] = [];
    const runnerOk = new SiteDatabasesRunner({
      ensurePhpMyAdmin: async () => {
        order.push("ensure");
      },
      runSql: async () => {
        order.push(order.length === 1 ? "state" : "batch");
        return okResult(`D\t${P}\t0\nD\t${P}_shop\t0\nU\t${P}\t\n`);
      },
    });

    const signOnRes = await runnerOk.run({
      siteId: SITE_ID,
      op: "phpMyAdminSignOn",
      passwordHash: HASH,
    });
    expect(signOnRes).toEqual({ username: A });
    expect(order).toEqual(["ensure", "state", "batch"]);

    const runSql = vi.fn(async () => okResult());
    const runnerNotSupported = new SiteDatabasesRunner({
      ensurePhpMyAdmin: async () => {
        throw new ExecutorCodedError("phpMyAdmin is not available", "NOT_SUPPORTED");
      },
      runSql,
    });
    await expect(
      runnerNotSupported.run({ siteId: SITE_ID, op: "phpMyAdminSignOn", passwordHash: HASH }),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "phpMyAdmin is not available",
    });
    expect(runSql).not.toHaveBeenCalled();

    const runnerEnsureFail = new SiteDatabasesRunner({
      ensurePhpMyAdmin: async () => {
        throw new Error(`connect ECONNREFUSED /var/run/docker.sock ${HASH}`);
      },
      runSql,
    });
    const err = await runnerEnsureFail
      .run({ siteId: SITE_ID, op: "phpMyAdminSignOn", passwordHash: HASH })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutorCodedError);
    expect((err as ExecutorCodedError).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect((err as ExecutorCodedError).message).toBe(
      "phpMyAdmin is not available. Retry in a few minutes",
    );
    expect((err as ExecutorCodedError).message).not.toContain(HASH);
    expect(runSql).not.toHaveBeenCalled();
  });

  it("dropAll on an empty state runs the state query only and returns {}", async () => {
    const runSql = vi.fn(async () => okResult(""));
    const runner = new SiteDatabasesRunner({
      runSql,
      ensurePhpMyAdmin: async () => undefined,
    });

    await expect(runner.run({ siteId: SITE_ID, op: "dropAll" })).resolves.toEqual({});
    expect(runSql).toHaveBeenCalledTimes(1);
  });

  it("revoke of a missing grant runs only the state query and returns {}", async () => {
    const runSql = vi.fn(async () => okResult(`D\t${P}\t0\nU\t${P}\t\nU\t${P}_app\t\n`));
    const runner = new SiteDatabasesRunner({
      runSql,
      ensurePhpMyAdmin: async () => undefined,
    });

    await expect(
      runner.run({ siteId: SITE_ID, op: "revoke", user: `${P}_app`, database: P }),
    ).resolves.toEqual({});
    expect(runSql).toHaveBeenCalledTimes(1);
  });
});
