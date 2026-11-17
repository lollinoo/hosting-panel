#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M2 cycle 3 (phpMyAdmin behind the panel).
 *
 * Proves the real executor adapter (`ensurePhpMyAdmin` + `siteDatabases` phpMyAdminSignOn),
 * real TypeScript forwarder (`apps/web/src/lib/phpmyadmin-forwarder.ts`), and real session
 * module (`apps/web/src/lib/session.ts`) end to end against real MariaDB 12.3.3 and
 * locked-down phpMyAdmin 5.2.3-apache containers.
 *
 * Machine safety: every created Docker resource starts with "hp_swarmtest_" and
 * is removed by exact name in `finally` (including on SIGINT/SIGTERM). Only one
 * ephemeral loopback port on 127.0.0.1 is published at a time and no prune runs.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const {
  DockerEngineSocketAdapter,
  SiteDatabasesRunner,
  buildSharedDatabaseContainerPayload,
  ensurePhpMyAdminContainer,
  mariadbRootExec,
  subnetToMariadbHostPattern,
} = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href
);
const {
  PHPMYADMIN_IMAGE,
  SHARED_MARIADB_IMAGE,
  mysqlNativePasswordHash,
  siteDatabaseFullName,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
} = await import(
  pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href
);

// Set BFF_SESSION_SECRET before loading session.ts in case NODE_ENV=production.
const sessionSecret = randomBytes(32).toString("hex");
process.env.BFF_SESSION_SECRET = sessionSecret;

const {
  SESSION_COOKIE_NAME,
  decryptSession,
  encryptSession,
  generateCsrfToken,
  getSessionSecretKey,
} = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/web/src/lib/session.ts")).href
);
const {
  PMA_COOKIE_NAME,
  createPhpMyAdminForwarder,
  pmaPrefix,
  sealPmaCookie,
  sessionBindingId,
} = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/web/src/lib/phpmyadmin-forwarder.ts")).href
);
const { fetchPhpMyAdminUpstream } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/web/src/lib/phpmyadmin-upstream.ts")).href
);

const FORBIDDEN_HOST_PORTS = new Set([22, 80, 443, 2222, 3000, 4000, 5432, 8306]);
const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;

const dbContainerName = `${runId}_mariadb`;
const dbNetworkName = `${runId}_db_net`;
const pmaContainerName = `${runId}_pma`;
const pmaNetworkName = `${runId}_pma_net`;
const otherNetworkName = `${runId}_other_net`;
const probeContainerName = `${runId}_netprobe`;

const createdContainers = new Set();
const createdNetworks = new Set();
const tempDirs = [];
const activeChildren = new Set();
const serversToClose = [];

class StepAssertionError extends Error {
  constructor(expected, actual) {
    super(`${expected} / ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

function assert(cond, expected, actual) {
  if (!cond) {
    throw new StepAssertionError(expected, actual);
  }
}

function formatErr(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFileCb(
      cmd,
      args,
      {
        encoding: opts.encoding ?? "utf8",
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        activeChildren.delete(child);
        if (!err) {
          resolve({
            ok: true,
            code: 0,
            stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
            stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
          });
          return;
        }
        resolve({
          ok: false,
          code: typeof err.code === "number" ? err.code : 1,
          killed: Boolean(err.killed),
          stdout: typeof stdout === "string" ? stdout : stdout ? stdout.toString("utf8") : "",
          stderr: typeof stderr === "string" ? stderr : stderr ? stderr.toString("utf8") : err.message,
        });
      },
    );
    activeChildren.add(child);
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

async function docker(args, opts = {}) {
  return execCmd("docker", args, opts);
}

async function dockerInspectContainer(name) {
  const res = await docker(["inspect", name]);
  if (!res.ok) return null;
  const arr = JSON.parse(res.stdout);
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

async function dockerInspectNetwork(name) {
  const res = await docker(["network", "inspect", name]);
  if (!res.ok) return null;
  const arr = JSON.parse(res.stdout);
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

async function dockerContainerLogs(name) {
  const res = await docker(["logs", name]);
  return `${res.stdout}\n${res.stderr}`;
}

function countPmaAccessLines(logsText) {
  return logsText
    .split(/\r?\n/)
    .filter((line) => /^\d+\.\d+\.\d+\.\d+\s+-\s+/.test(line) && /"HTTP\/1\.\d"/.test(line)).length;
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "127.0.0.1", port }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreePortInRange(min = 20000, max = 60000, exclude = new Set()) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    if (FORBIDDEN_HOST_PORTS.has(candidate) || exclude.has(candidate)) continue;
    if (await checkPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find free port in 20000..60000");
}

function parseCurlResponse(raw) {
  let offset = 0;
  let status = 0;
  let headerLines = [];

  while (offset < raw.length) {
    const sepCrlf = raw.indexOf("\r\n\r\n", offset);
    const sepLf = raw.indexOf("\n\n", offset);
    let sepIdx = -1;
    let sepLen = 0;
    if (sepCrlf !== -1 && (sepLf === -1 || sepCrlf <= sepLf)) {
      sepIdx = sepCrlf;
      sepLen = 4;
    } else if (sepLf !== -1) {
      sepIdx = sepLf;
      sepLen = 2;
    }
    if (sepIdx === -1) break;

    const block = raw.slice(offset, sepIdx);
    const lines = block.split(/\r?\n/);
    const statusLine = lines[0] ?? "";
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine);
    if (!statusMatch) break;

    status = Number(statusMatch[1]);
    headerLines = lines.slice(1);
    offset = sepIdx + sepLen;

    // 100 Continue has another header block right after it.
    if (status !== 100) {
      break;
    }
  }

  const headers = new Map();
  const setCookies = [];
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "set-cookie") {
      setCookies.push(value);
    }
    const existing = headers.get(key);
    headers.set(key, existing ? `${existing}, ${value}` : value);
  }

  return {
    status,
    headers,
    setCookies,
    location: headers.get("location") ?? null,
    body: raw.slice(offset),
  };
}

async function curlHttp(url, opts = {}) {
  const args = ["-sS", "-i", "--max-time", String(opts.maxTimeSec ?? 120), "-H", "Expect:"];
  if (opts.method && opts.method !== "GET") {
    args.push("-X", opts.method);
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts.formFields) {
    for (const [k, v] of Object.entries(opts.formFields)) {
      args.push("-F", `${k}=${v}`);
    }
  }
  if (opts.data) {
    args.push("--data-raw", opts.data);
  }
  args.push(url);

  const res = await execCmd("curl", args, {
    timeoutMs: (opts.maxTimeSec ?? 120) * 1000 + 5_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = res.ok ? parseCurlResponse(res.stdout) : null;
  return { ...res, parsed };
}

async function pickFreeSubnet() {
  const res = await docker(["network", "ls", "--format", "{{.Name}}"]);
  assert(res.ok, "docker network ls succeeds", res.stderr);
  const names = res.stdout.split(/\r?\n/).filter(Boolean);
  const used = [];
  const ipToInt = (ip) => ip.split(".").reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);
  const parseCidr = (cidr) => {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr ?? "");
    if (!m) return null;
    const prefix = Number(m[2]);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { net: (ipToInt(m[1]) & mask) >>> 0, mask };
  };

  for (const name of names) {
    const info = await dockerInspectNetwork(name);
    for (const cfg of info?.IPAM?.Config ?? []) {
      const parsed = parseCidr(cfg?.Subnet);
      if (parsed) used.push(parsed);
    }
  }

  for (let second = 240; second <= 254; second += 1) {
    for (let third = 180; third <= 254; third += 1) {
      const candidate = `10.${second}.${third}.0/24`;
      const c = parseCidr(candidate);
      const overlaps = used.some(
        (u) => ((c.net & u.mask) >>> 0) === u.net || ((u.net & c.mask) >>> 0) === c.net,
      );
      if (!overlaps) return candidate;
    }
  }
  throw new Error("No free /24 subnet available");
}

function dockerUnixRequest(method, reqPath, jsonBody, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody), "utf8");
    const headers = payload
      ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
      : {};
    const req = http.request({ socketPath: "/var/run/docker.sock", path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`Docker HTTP timeout: ${method} ${reqPath}`)));
    }
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerUnixJson(method, reqPath, jsonBody, okStatuses = [200, 201, 204]) {
  const res = await dockerUnixRequest(method, reqPath, jsonBody, { timeoutMs: 30_000 });
  if (!okStatuses.includes(res.statusCode)) {
    throw new Error(`Docker ${method} ${reqPath} failed (${res.statusCode}): ${res.body.toString("utf8")}`);
  }
  if (res.body.length === 0) return null;
  return JSON.parse(res.body.toString("utf8"));
}

async function runRootMariaDbSql(rootPw, sql) {
  return docker(
    [
      "exec",
      "-i",
      "-e",
      `MYSQL_PWD=${rootPw}`,
      dbContainerName,
      "mariadb",
      "--user=root",
      "--batch",
      "--skip-column-names",
      "--raw",
    ],
    { stdin: sql, timeoutMs: 20_000 },
  );
}

async function waitForMariaDbReady(rootPw) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await runRootMariaDbSql(rootPw, "SELECT 1;");
    if (res.ok && res.stdout.trim() === "1") return;
    await sleep(500);
  }
  throw new Error("Timed out waiting for throw-away MariaDB container");
}

async function waitForPmaHttpReady(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await curlHttp(`http://127.0.0.1:${port}/`, { maxTimeSec: 3 });
    if (res.ok && res.parsed && res.parsed.status === 401) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for phpMyAdmin HTTP listener on 127.0.0.1:${port}`);
}

function startHttpServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to bind loopback server")));
        return;
      }
      serversToClose.push(srv);
      resolve({ server: srv, port: addr.port });
    });
  });
}

function parseCookieHeaderMap(header) {
  const map = {};
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        map[key] = decodeURIComponent(val);
      } catch {
        map[key] = val;
      }
    }
  }
  return map;
}

function extractPmaSessionFromHeaders(setCookies, body) {
  const cookies = setCookies
    .map((line) => line.split(";")[0]?.trim())
    .filter(Boolean);
  const tokenMatch = /name=["']token["']\s+value=["']([^"']+)["']/.exec(body);
  return {
    cookieHeader: cookies.join("; "),
    token: tokenMatch ? tokenMatch[1] : "",
  };
}

function randomAlnum24() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

let cleanupPromise = null;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const childrenToStop = [...activeChildren];
    activeChildren.clear();
    await Promise.all(
      childrenToStop.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const hardKill = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // ignore
              }
              resolve();
            }, 2000);
            child.once("exit", () => {
              clearTimeout(hardKill);
              resolve();
            });
            try {
              child.kill("SIGTERM");
            } catch {
              clearTimeout(hardKill);
              resolve();
            }
          }),
      ),
    );

    for (const srv of serversToClose) {
      await new Promise((resolve) => {
        try {
          srv.close(() => resolve());
          srv.closeAllConnections?.();
        } catch {
          resolve();
        }
      });
    }

    const containers = new Set([
      ...createdContainers,
      probeContainerName,
      pmaContainerName,
      dbContainerName,
    ]);
    for (const c of containers) {
      await docker(["rm", "-f", c]);
    }

    const networks = new Set([
      ...createdNetworks,
      otherNetworkName,
      pmaNetworkName,
      dbNetworkName,
    ]);
    for (const n of networks) {
      await docker(["network", "rm", n]);
    }

    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  return cleanupPromise;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void cleanup().finally(() => {
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  });
}

async function main() {
  const nextBuildIdPath = path.resolve(repoRoot, "apps/web/.next/BUILD_ID");
  try {
    await stat(nextBuildIdPath);
  } catch {
    console.error("Missing apps/web/.next/BUILD_ID. Run `corepack pnpm run build` first.");
    process.exit(1);
  }

  const startedAt = performance.now();
  let passed = 0;
  let total = 0;
  let fatalSetupFailure = false;

  async function runStep(name, fn, { abortOnFail = false } = {}) {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      if (err instanceof StepAssertionError) {
        console.log(`FAIL ${name}: ${err.expected} / ${err.actual}`);
      } else {
        console.log(`FAIL ${name}: step succeeds / ${formatErr(err)}`);
      }
      if (abortOnFail) {
        fatalSetupFailure = true;
      }
    }
  }

  let tmpRoot = "";
  let configDir = "";
  let pmaPort = 0;
  let pmaPort2 = 0;
  let apiPort = 0;
  let webPort = 0;
  let nextPort = 0;
  let adapter = null;
  let signOnRunner = null;
  let rootPw = "";

  const orgA = `org_pma_${runHex}`;
  const siteA = `site_pma_a_${runHex}`;
  const siteB = `site_pma_b_${runHex}`;
  const prefixA = siteDatabasePrefix(siteA);
  const prefixB = siteDatabasePrefix(siteB);
  const dbApp = siteDatabaseFullName(prefixA, "app");
  const expectedSignOnUserA = siteDatabaseSignOnUser(siteA);

  let sessionA = null;
  let sessionCookieValue = "";
  let pmaCookieValue1 = "";
  let pmaCookieValue2 = "";
  let pmaCookieB = "";
  let pw1 = "";
  let pw2 = "";
  let lastApiSignOnPassword = "";
  let dbInitialInspect = null;
  let pmaSessionCookies = "";
  let pmaCsrfToken = "";
  let activeForwarder = null;
  let swapForwarderPort = null;

  try {
    await runStep(
      "setup",
      async () => {
        assert(
          process.features?.typescript === "strip",
          "Node 26 TypeScript stripping active",
          String(process.features?.typescript),
        );

        const pingRes = await docker(["info", "--format", "{{.ServerVersion}}"]);
        assert(pingRes.ok, "Docker Engine reachable", pingRes.stderr);

        for (const image of [PHPMYADMIN_IMAGE, SHARED_MARIADB_IMAGE]) {
          const inspectImg = await docker(["image", "inspect", image]);
          assert(inspectImg.ok, `Image present locally: ${image}`, inspectImg.stderr);
        }

        const baseTmp = await stat("/dev/shm")
          .then((s) => (s.isDirectory() ? "/dev/shm" : os.tmpdir()))
          .catch(() => os.tmpdir());
        tmpRoot = await mkdtemp(path.join(baseTmp, `${runId}-`));
        tempDirs.push(tmpRoot);

        const dbDataDir = path.join(tmpRoot, "mariadb-data");
        const rootKeyFile = path.join(tmpRoot, "mariadb-root.key");
        configDir = path.join(tmpRoot, "pma-config");
        const secretsDir = path.join(tmpRoot, "secrets");
        const ingressDir = path.join(tmpRoot, "ingress");

        await mkdir(dbDataDir, { mode: 0o700 });
        await mkdir(configDir, { mode: 0o755 });
        await mkdir(secretsDir, { mode: 0o700 });
        await mkdir(ingressDir, { mode: 0o700 });

        rootPw = randomBytes(24).toString("hex");
        await writeFile(rootKeyFile, rootPw, { mode: 0o400 });
        await chmod(rootKeyFile, 0o400);

        const subnet = await pickFreeSubnet();
        subnetToMariadbHostPattern(subnet);
        await dockerUnixJson("POST", "/networks/create", {
          Name: dbNetworkName,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
        });
        createdNetworks.add(dbNetworkName);

        const uid = process.getuid();
        const gid = process.getgid();
        const dbPayload = buildSharedDatabaseContainerPayload({
          image: SHARED_MARIADB_IMAGE,
          user: `${uid}:${gid}`,
          dataDirHostPath: dbDataDir,
          rootKeyHostPath: rootKeyFile,
          adminSubnet: subnet,
        });
        const isolatedDbPayload = {
          ...dbPayload,
          HostConfig: {
            ...dbPayload.HostConfig,
            NetworkMode: dbNetworkName,
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [dbNetworkName]: { Aliases: ["hp-mariadb"] },
            },
          },
        };
        const dbCreate = await dockerUnixJson(
          "POST",
          `/containers/create?name=${encodeURIComponent(dbContainerName)}`,
          isolatedDbPayload,
        );
        createdContainers.add(dbContainerName);
        await dockerUnixJson("POST", `/containers/${encodeURIComponent(dbCreate.Id)}/start`, {});

        await waitForMariaDbReady(rootPw);
        dbInitialInspect = await dockerInspectContainer(dbContainerName);
        assert(dbInitialInspect?.State?.Running === true, "MariaDB container running", "not running");

        pmaPort = await getFreePortInRange(20000, 60000);
        pmaPort2 = await getFreePortInRange(20000, 60000, new Set([pmaPort]));

        adapter = new DockerEngineSocketAdapter({
          pullMissingImages: false,
          secretsRootDir: secretsDir,
          ingressRootDir: ingressDir,
          sharedDbContainerName: dbContainerName,
          phpMyAdminContainerName: pmaContainerName,
          phpMyAdminNetworkName: pmaNetworkName,
          phpMyAdminConfigDir: configDir,
          phpMyAdminPort: pmaPort,
        });
        signOnRunner = new SiteDatabasesRunner({
          runSql: mariadbRootExec(
            { request: dockerUnixRequest, socketPath: "/var/run/docker.sock", apiPrefix: "" },
            dbContainerName,
          ),
          ensurePhpMyAdmin: async () => undefined,
        });

        // Provision two isolated sites (siteA with primary + custom dbApp, siteB with primary only).
        const hashWpA = mysqlNativePasswordHash(randomBytes(16).toString("hex"));
        const hashWpB = mysqlNativePasswordHash(randomBytes(16).toString("hex"));
        const escA = prefixA.replaceAll("_", "\\_");
        const escB = prefixB.replaceAll("_", "\\_");
        const seedSql = [
          `CREATE DATABASE \`${prefixA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
          `CREATE USER '${prefixA}'@'%' IDENTIFIED BY PASSWORD '${hashWpA}';`,
          `GRANT ALL PRIVILEGES ON \`${escA}\`.* TO '${prefixA}'@'%';`,
          `CREATE TABLE \`${prefixA}\`.site_a_tbl (id INT PRIMARY KEY, note VARCHAR(32));`,
          `INSERT INTO \`${prefixA}\`.site_a_tbl VALUES (1, 'site-a-ok');`,
          `CREATE DATABASE \`${prefixB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
          `CREATE USER '${prefixB}'@'%' IDENTIFIED BY PASSWORD '${hashWpB}';`,
          `GRANT ALL PRIVILEGES ON \`${escB}\`.* TO '${prefixB}'@'%';`,
          `CREATE TABLE \`${prefixB}\`.site_b_secret (id INT PRIMARY KEY, secret VARCHAR(32));`,
          `INSERT INTO \`${prefixB}\`.site_b_secret VALUES (1, 'site-b-confidential');`,
        ].join("\n");
        const seedRes = await runRootMariaDbSql(rootPw, seedSql);
        assert(seedRes.ok, "seed two sites in MariaDB", seedRes.stderr);

        await adapter.siteDatabases({ siteId: siteA, op: "createDatabase", database: dbApp });
        const seedAppRes = await runRootMariaDbSql(
          rootPw,
          `CREATE TABLE \`${dbApp}\`.app_tbl (id INT PRIMARY KEY); INSERT INTO \`${dbApp}\`.app_tbl VALUES (1);`,
        );
        assert(seedAppRes.ok, "seed custom table in siteA app db", seedAppRes.stderr);

        sessionA = {
          accessToken: `panel-tok-${runHex}`,
          csrfToken: generateCsrfToken(),
          activeConsole: "customer",
          activeOrgSlug: "accept-org",
          user: {
            id: `user_${runHex}`,
            email: "accept@example.test",
            name: "Accept User",
            globalRoles: [],
            hostingAdminOrgIds: [],
            locale: "en",
            isServerAdmin: false,
            mustChangePassword: false,
          },
        };
        sessionCookieValue = await encryptSession(sessionA);

        const apiServer = await startHttpServer((req, res) => {
          void (async () => {
            const auth = req.headers.authorization;
            if (auth !== `Bearer ${sessionA.accessToken}`) {
              res.writeHead(401).end();
              return;
            }
            const reqPath = (req.url ?? "").split("?")[0];
            const allowedPathA = `/v1/organizations/${encodeURIComponent(orgA)}/managed-sites/${encodeURIComponent(siteA)}/databases/phpmyadmin`;
            const allowedPathB = `/v1/organizations/${encodeURIComponent(orgA)}/managed-sites/${encodeURIComponent(siteB)}/databases/phpmyadmin`;
            if (req.method === "GET" && (reqPath === allowedPathA || reqPath === allowedPathB)) {
              res.writeHead(204).end();
              return;
            }
            if (req.method === "POST" && reqPath === allowedPathA) {
              const pwNext = randomAlnum24();
              await signOnRunner.run({
                siteId: siteA,
                op: "phpMyAdminSignOn",
                passwordHash: mysqlNativePasswordHash(pwNext),
              });
              lastApiSignOnPassword = pwNext;
              const payload = JSON.stringify({
                data: {
                  username: expectedSignOnUserA,
                  temporaryPassword: pwNext,
                },
              });
              res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
              return;
            }
            res.writeHead(404).end();
          })().catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" }).end(
                JSON.stringify({ error: { code: "INTERNAL_ERROR", message: formatErr(err) } }),
              );
            } else {
              res.destroy();
            }
          });
        });
        apiPort = apiServer.port;

        const makeForwarder = (upstreamPort) =>
          createPhpMyAdminForwarder({
            readSession: async (webReq) => {
              const cookies = parseCookieHeaderMap(webReq.headers.get("cookie"));
              const raw = cookies[SESSION_COOKIE_NAME];
              if (!raw) return null;
              return await decryptSession(raw);
            },
            cookieKey: getSessionSecretKey(),
            apiBaseUrl: `http://127.0.0.1:${apiPort}`,
            upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
            upstreamFetch: fetchPhpMyAdminUpstream,
            secureCookies: false,
            locale: () => "en",
          });

        activeForwarder = makeForwarder(pmaPort);

        const webServer = await startHttpServer(async (nodeReq, nodeRes) => {
          try {
            const rawUrl = nodeReq.url ?? "/";
            const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${webPort}`);
            const match = /^\/phpmyadmin\/([^/]+)(\/.*)?$/.exec(parsedUrl.pathname);
            if (!match) {
              nodeRes.writeHead(404).end();
              return;
            }
            const reqSiteId = match[1] ?? "";
            const tail = match[2] ?? "";
            const trimmedTail = tail.replace(/^\/+/, "").replace(/\/+$/, "");
            const pathSegments = trimmedTail.length > 0 ? trimmedTail.split("/") : [];

            const headers = new Headers();
            for (const [k, v] of Object.entries(nodeReq.headers)) {
              if (Array.isArray(v)) {
                for (const item of v) headers.append(k, item);
              } else if (typeof v === "string") {
                headers.set(k, v);
              }
            }

            const reqAbort = new AbortController();
            nodeReq.once("aborted", () => {
              reqAbort.abort(new Error("Client request aborted"));
            });
            nodeRes.once("close", () => {
              if (!nodeRes.writableFinished) {
                reqAbort.abort(new Error("Client connection closed"));
              }
            });

            const method = (nodeReq.method ?? "GET").toUpperCase();
            const hasBody = method !== "GET" && method !== "HEAD";
            const webReq = new Request(parsedUrl.toString(), {
              method,
              headers,
              signal: reqAbort.signal,
              ...(hasBody ? { body: Readable.toWeb(nodeReq), duplex: "half" } : {}),
            });

            const webRes = await activeForwarder(webReq, reqSiteId, pathSegments);
            if (nodeRes.destroyed || nodeRes.writableEnded) {
              await webRes.body?.cancel().catch(() => {});
              return;
            }
            const setCookies =
              typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : [];
            const outHeaders = {};
            webRes.headers.forEach((val, key) => {
              if (key.toLowerCase() !== "set-cookie") {
                outHeaders[key] = val;
              }
            });
            if (setCookies.length > 0) {
              outHeaders["set-cookie"] = setCookies;
            }
            nodeRes.writeHead(webRes.status, outHeaders);
            if (webRes.body) {
              await new Promise((resolve, reject) => {
                const nodeStream = Readable.fromWeb(webRes.body);
                let finished = false;
                const onClose = () => {
                  if (!finished && !nodeRes.writableFinished) {
                    finished = true;
                    nodeStream.destroy();
                    resolve();
                  }
                };
                nodeRes.once("close", onClose);
                nodeRes.once("finish", () => {
                  finished = true;
                  resolve();
                });
                nodeStream.on("error", (err) => {
                  if (!finished) {
                    finished = true;
                    reject(err);
                  }
                });
                nodeStream.pipe(nodeRes);
              });
            } else {
              nodeRes.end();
            }
          } catch (err) {
            if (!nodeRes.headersSent) {
              nodeRes.writeHead(500).end(formatErr(err));
            } else {
              nodeRes.destroy();
            }
          }
        });
        webPort = webServer.port;
        webServer.server.requestTimeout = 0;

        // Swap helper exposed for the config-change recreate step:
        swapForwarderPort = (nextPort) => {
          activeForwarder = makeForwarder(nextPort);
        };
      },
      { abortOnFail: true },
    );

    if (!fatalSetupFailure) {
      await runStep(
        "signon-and-ensure",
        async () => {
          pw1 = `${randomBytes(16).toString("hex")}Aa11`;
          const signOn = await adapter.siteDatabases({
            siteId: siteA,
            op: "phpMyAdminSignOn",
            passwordHash: mysqlNativePasswordHash(pw1),
          });
          createdNetworks.add(pmaNetworkName);
          createdContainers.add(pmaContainerName);

          assert(
            signOn.username === expectedSignOnUserA,
            `signOn username=${expectedSignOnUserA}`,
            String(signOn.username),
          );

          await waitForPmaHttpReady(pmaPort);

          pmaCookieValue1 = await sealPmaCookie(getSessionSecretKey(), {
            siteId: siteA,
            orgId: orgA,
            username: signOn.username,
            password: pw1,
            sid: sessionBindingId(sessionA),
          });
        },
        { abortOnFail: true },
      );
    }

    if (!fatalSetupFailure) {
      await runStep("direct-port-unauth", async () => {
        const res = await curlHttp(`http://127.0.0.1:${pmaPort}/`);
        assert(res.ok && res.parsed, "curl direct port succeeds", res.stderr);
        assert(res.parsed.status === 401, "direct unauthenticated port returns 401", String(res.parsed.status));
        assert(!res.parsed.body.includes(prefixA), "direct 401 does not expose siteA DB", "leaked prefixA");
        assert(!res.parsed.body.includes(prefixB), "direct 401 does not expose siteB DB", "leaked prefixB");
      });

      await runStep("no-session-refused", async () => {
        const beforeLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));

        const navRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(navRes.ok && navRes.parsed, "no-session page load curl succeeds", navRes.stderr);
        assert(navRes.parsed.status === 303, "no-session page load -> 303", String(navRes.parsed.status));
        assert(navRes.parsed.location === "/login", "no-session Location -> /login", String(navRes.parsed.location));

        const apiRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php`, {
          headers: {
            Accept: "application/json",
            Cookie: `${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(apiRes.ok && apiRes.parsed, "no-session XHR curl succeeds", apiRes.stderr);
        assert(apiRes.parsed.status === 401, "no-session non-page request -> 401", String(apiRes.parsed.status));

        const afterLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        assert(
          afterLines === beforeLines,
          `phpMyAdmin access log unchanged (${beforeLines})`,
          String(afterLines),
        );
      });

      await runStep("no-pma-cookie-refused", async () => {
        const beforeLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));

        const navRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}`,
          },
        });
        assert(navRes.ok && navRes.parsed, "missing hp_pma page load curl succeeds", navRes.stderr);
        assert(navRes.parsed.status === 303, "missing hp_pma page load -> 303", String(navRes.parsed.status));
        assert(
          navRes.parsed.location === `/sites/${siteA}/database`,
          `Location -> /sites/${siteA}/database`,
          String(navRes.parsed.location),
        );

        const xhrRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php`, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}`,
          },
        });
        assert(xhrRes.ok && xhrRes.parsed, "missing hp_pma XHR curl succeeds", xhrRes.stderr);
        assert(xhrRes.parsed.status === 401, "missing hp_pma XHR -> 401", String(xhrRes.parsed.status));

        const afterLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        assert(
          afterLines === beforeLines,
          `phpMyAdmin access log unchanged (${beforeLines})`,
          String(afterLines),
        );
      });

      await runStep("login-page-and-headers", async () => {
        const slashRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}`, {
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(slashRes.ok && slashRes.parsed, "no-slash curl succeeds", slashRes.stderr);
        assert(slashRes.parsed.status === 308, "missing slash -> 308", String(slashRes.parsed.status));
        assert(
          slashRes.parsed.location === pmaPrefix(siteA),
          `Location=${pmaPrefix(siteA)}`,
          String(slashRes.parsed.location),
        );

        const res = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(res.ok && res.parsed, "home page curl succeeds", res.stderr);
        assert(res.parsed.status === 200, "home page -> 200", String(res.parsed.status));
        assert(
          !res.parsed.headers.has("www-authenticate"),
          "no www-authenticate header",
          String(res.parsed.headers.get("www-authenticate")),
        );
        assert(res.parsed.setCookies.length > 0, "phpMyAdmin Set-Cookie present", "none");
        for (const sc of res.parsed.setCookies) {
          assert(
            sc.includes(`Path=${pmaPrefix(siteA)}`),
            `Set-Cookie scoped to ${pmaPrefix(siteA)}`,
            sc,
          );
          assert(!/\bDomain=/i.test(sc), "Set-Cookie has no Domain=", sc);
        }
        assert(!/12\.3\.3-MariaDB/i.test(res.parsed.body), "ShowServerInfo hides MariaDB version", "exposed");
        assert(!/Apache\/2\.4/i.test(res.parsed.body), "ShowServerInfo hides Apache version", "exposed");
        assert(!/blowfish/i.test(res.parsed.body), "no blowfish warning", "exposed");
        assert(!res.parsed.body.includes(pw1), "password never appears in body", "leaked");
        const basicTok = Buffer.from(`${expectedSignOnUserA}:${pw1}`, "utf8").toString("base64");
        assert(!res.parsed.body.includes(basicTok), "Basic token never appears in body", "leaked");

        const extracted = extractPmaSessionFromHeaders(res.parsed.setCookies, res.parsed.body);
        assert(extracted.token.length > 0, "phpMyAdmin CSRF token present", "missing");
        pmaSessionCookies = extracted.cookieHeader;
        pmaCsrfToken = extracted.token;
      });

      await runStep("site-scope-and-isolation", async () => {
        const cookieHdr = `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}; ${pmaSessionCookies}`;

        // 1. Database list via SQL SHOW DATABASES through phpMyAdmin
        const showDbsRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
          method: "POST",
          headers: {
            Origin: `http://127.0.0.1:${webPort}`,
            "Sec-Fetch-Site": "same-origin",
            Cookie: cookieHdr,
          },
          data: new URLSearchParams({
            token: pmaCsrfToken,
            ajax_request: "true",
            sql_query: "SHOW DATABASES;",
            pos: "0",
          }).toString(),
        });
        assert(showDbsRes.ok && showDbsRes.parsed, "SHOW DATABASES request succeeds", showDbsRes.stderr);
        assert(showDbsRes.parsed.status === 200, "SHOW DATABASES -> 200", String(showDbsRes.parsed.status));
        assert(showDbsRes.parsed.body.includes(prefixA), `DB list includes ${prefixA}`, "missing");
        assert(showDbsRes.parsed.body.includes(dbApp), `DB list includes ${dbApp}`, "missing");
        assert(!showDbsRes.parsed.body.includes(prefixB), `DB list excludes ${prefixB}`, "leaked siteB");

        // 2. Table list for siteA primary DB
        const tblRes = await curlHttp(
          `http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/database/structure&db=${prefixA}`,
          { headers: { Cookie: cookieHdr } },
        );
        assert(tblRes.ok && tblRes.parsed?.status === 200, "siteA table list -> 200", String(tblRes.parsed?.status));
        assert(tblRes.parsed.body.includes("site_a_tbl"), "siteA table list shows site_a_tbl", "missing");

        // 3. Attempt to query siteB's database -> MariaDB #1044/#1142 Access denied
        const crossQueryRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
          method: "POST",
          headers: {
            Origin: `http://127.0.0.1:${webPort}`,
            "Sec-Fetch-Site": "same-origin",
            Cookie: cookieHdr,
          },
          data: new URLSearchParams({
            token: pmaCsrfToken,
            ajax_request: "true",
            db: prefixA,
            sql_query: `SELECT * FROM \`${prefixB}\`.site_b_secret;`,
            pos: "0",
          }).toString(),
        });
        assert(crossQueryRes.ok && crossQueryRes.parsed, "cross-DB SQL request completes", crossQueryRes.stderr);
        assert(
          /#1044|#1142|command denied|Access denied/i.test(crossQueryRes.parsed.body),
          "MariaDB refuses query on siteB database (#1044/#1142)",
          crossQueryRes.parsed.body.slice(0, 300),
        );
        assert(
          !crossQueryRes.parsed.body.includes("site-b-confidential"),
          "siteB row data never exposed",
          "leaked siteB data",
        );

        // 4. Redirect Location stays under prefix
        const redirRes = await curlHttp(
          `http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/collation-connection`,
          {
            method: "POST",
            headers: {
              Origin: `http://127.0.0.1:${webPort}`,
              "Sec-Fetch-Site": "same-origin",
              Cookie: cookieHdr,
            },
            data: new URLSearchParams({
              token: pmaCsrfToken,
              pma_collation_connection: "utf8mb4_unicode_ci",
            }).toString(),
          },
        );
        assert(redirRes.ok && redirRes.parsed, "redirect POST succeeds", redirRes.stderr);
        assert(
          redirRes.parsed.status === 302 && redirRes.parsed.location !== null,
          "POST collation-connection -> 302 with Location",
          `status=${redirRes.parsed.status} loc=${String(redirRes.parsed.location)}`,
        );
        const loc = redirRes.parsed.location;
        const resolved = new URL(loc, `http://panel.local${pmaPrefix(siteA)}index.php`);
        assert(
          resolved.origin === "http://panel.local" && resolved.pathname.startsWith(pmaPrefix(siteA)),
          `Location stays under ${pmaPrefix(siteA)}`,
          loc,
        );
      });

      await runStep("cross-site-cookie-refused", async () => {
        const beforeLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        const res = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteB}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(res.ok && res.parsed, "cross-site curl succeeds", res.stderr);
        assert(res.parsed.status === 404, "siteA cookie on siteB path -> 404", String(res.parsed.status));
        const afterLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        assert(afterLines === beforeLines, "nothing reached phpMyAdmin", `${beforeLines} -> ${afterLines}`);
      });

      await runStep("cross-site-post-refused", async () => {
        const beforeLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        const res = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/sql`, {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "Sec-Fetch-Site": "cross-site",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
          data: "sql_query=SELECT+1",
        });
        assert(res.ok && res.parsed, "cross-origin POST curl succeeds", res.stderr);
        assert(res.parsed.status === 403, "cross-origin POST -> 403", String(res.parsed.status));
        const afterLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        assert(afterLines === beforeLines, "nothing reached phpMyAdmin", `${beforeLines} -> ${afterLines}`);
      });

      await runStep("wrong-password-clears-cookie", async () => {
        const badPmaCookie = await sealPmaCookie(getSessionSecretKey(), {
          siteId: siteA,
          orgId: orgA,
          username: expectedSignOnUserA,
          password: `${pw1}_wrong`,
          sid: sessionBindingId(sessionA),
        });
        const res = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${badPmaCookie}`,
          },
        });
        assert(res.ok && res.parsed, "wrong-password curl succeeds", res.stderr);
        assert(res.parsed.status === 401, "wrong password -> 401", String(res.parsed.status));
        assert(
          !res.parsed.headers.has("www-authenticate"),
          "no www-authenticate on 401",
          String(res.parsed.headers.get("www-authenticate")),
        );
        const cleared = res.parsed.setCookies.join("\n");
        assert(
          cleared.includes(`${PMA_COOKIE_NAME}=`) &&
            cleared.includes("Max-Age=0") &&
            cleared.includes(`Path=${pmaPrefix(siteA)}`),
          "hp_pma cookie cleared with Max-Age=0 and site path",
          cleared,
        );
      });

      await runStep("import-size-limit", async () => {
        const cookieHdr = `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}; ${pmaSessionCookies}`;

        // Provision sign-on for siteB so we can verify cross-tenant availability right after heavy imports.
        const pwB = `${randomBytes(16).toString("hex")}Cc33`;
        const signOnB = await adapter.siteDatabases({
          siteId: siteB,
          op: "phpMyAdminSignOn",
          passwordHash: mysqlNativePasswordHash(pwB),
        });
        pmaCookieB = await sealPmaCookie(getSessionSecretKey(), {
          siteId: siteB,
          orgId: orgA,
          username: signOnB.username,
          password: pwB,
          sid: sessionBindingId(sessionA),
        });
        const checkSiteBPage = async (maxTimeSec = 10) =>
          curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteB}/`, {
            maxTimeSec,
            headers: {
              Accept: "text/html",
              "Sec-Fetch-Mode": "navigate",
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieB}`,
            },
          });

        const pmaBefore = await dockerInspectContainer(pmaContainerName);
        assert(pmaBefore !== null, "phpMyAdmin container exists before imports", "missing");
        const startedAtBefore = pmaBefore.State?.StartedAt;

        // 1. 20 MB SQL comment-only file must return a PHP/phpMyAdmin error without OOM/restart.
        const commentFile20 = path.join(tmpRoot, "import-20mb-comments.sql");
        const comment20Line = `-- ${"x".repeat(1020)}\n`;
        const repeat20Comment = Math.floor((20 * 1024 * 1024) / comment20Line.length);
        await writeFile(commentFile20, comment20Line.repeat(repeat20Comment), "utf8");

        const resComment20 = await curlHttp(
          `http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`,
          {
            method: "POST",
            maxTimeSec: 120,
            headers: {
              Origin: `http://127.0.0.1:${webPort}`,
              "Sec-Fetch-Site": "same-origin",
              Cookie: cookieHdr,
            },
            formFields: {
              token: pmaCsrfToken,
              import_type: "database",
              db: prefixA,
              format: "sql",
              charset_of_file: "utf-8",
              import_file: `@${commentFile20}`,
            },
          },
        );
        assert(
          resComment20.ok && resComment20.parsed,
          "20 MB comment-only import receives HTTP response (not dropped)",
          `ok=${resComment20.ok} code=${resComment20.code} err=${resComment20.stderr}`,
        );
        const commentBodyText = resComment20.parsed.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        console.log(
          `INFO comment-20mb: status=${resComment20.parsed.status} body=${commentBodyText.slice(0, 220)}`,
        );
        assert(
          !/phpMyAdmin isn't available right now/i.test(resComment20.parsed.body),
          "20 MB comment import returned phpMyAdmin/PHP answer (not forwarder 503 dropped upstream)",
          commentBodyText.slice(0, 200),
        );
        assert(
          resComment20.parsed.status >= 400 ||
            /Allowed memory size|Fatal error|memory|error/i.test(commentBodyText),
          "20 MB comment import reports phpMyAdmin/PHP error",
          `status=${resComment20.parsed.status} snippet=${commentBodyText.slice(0, 200)}`,
        );

        const pmaAfterComment = await dockerInspectContainer(pmaContainerName);
        assert(
          pmaAfterComment?.State?.OOMKilled === false,
          "phpMyAdmin State.OOMKilled=false after 20 MB comment import",
          String(pmaAfterComment?.State?.OOMKilled),
        );
        assert(
          pmaAfterComment?.State?.StartedAt === startedAtBefore,
          "phpMyAdmin State.StartedAt unchanged after 20 MB comment import",
          `before=${startedAtBefore} after=${pmaAfterComment?.State?.StartedAt}`,
        );

        const siteBRightAfter = await checkSiteBPage(10);
        assert(
          siteBRightAfter.ok && siteBRightAfter.parsed?.status === 200,
          "other site phpMyAdmin page still answers 200 right after 20 MB comment import",
          `ok=${siteBRightAfter.ok} status=${siteBRightAfter.parsed?.status}`,
        );

        // 2. Existing 20 MB INSERT file must still import cleanly.
        const okFile = path.join(tmpRoot, "import-20mb.sql");
        const tooBigFile = path.join(tmpRoot, "import-40mb.sql");

        const headerSql = `CREATE TABLE IF NOT EXISTS import_20mb_tbl (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(200));\n`;
        const tuple = `('${"a".repeat(190)}')`;
        const batchLine = `INSERT INTO import_20mb_tbl (v) VALUES ${Array(200).fill(tuple).join(",")};\n`;
        const repeat20 = Math.floor((20 * 1024 * 1024 - headerSql.length) / batchLine.length);
        await writeFile(okFile, `${headerSql}${batchLine.repeat(repeat20)}`, "utf8");

        const res20 = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
          method: "POST",
          maxTimeSec: 120,
          headers: {
            Origin: `http://127.0.0.1:${webPort}`,
            "Sec-Fetch-Site": "same-origin",
            Cookie: cookieHdr,
          },
          formFields: {
            token: pmaCsrfToken,
            import_type: "database",
            db: prefixA,
            format: "sql",
            charset_of_file: "utf-8",
            allow_interrupt: "yes",
            skip_queries: "0",
            fk_checks: "1",
            sql_compatibility: "NONE",
            sql_no_auto_value_on_zero: "on",
            import_file: `@${okFile}`,
          },
        });
        assert(res20.ok && res20.parsed, "20 MB import request completes", res20.stderr);
        assert(res20.parsed.status === 200, "20 MB import -> 200", String(res20.parsed.status));

        const verifyRow = await runRootMariaDbSql(rootPw, `SELECT COUNT(*) FROM \`${prefixA}\`.import_20mb_tbl;`);
        assert(
          verifyRow.ok && Number(verifyRow.stdout.trim()) === repeat20 * 200,
          `20 MB SQL import applied ${repeat20 * 200} rows`,
          `${verifyRow.stdout} ${verifyRow.stderr}`,
        );

        const pmaAfter20 = await dockerInspectContainer(pmaContainerName);
        assert(pmaAfter20?.State?.OOMKilled === false, "phpMyAdmin not OOM-killed on 20 MB import", "OOMKilled=true");

        // 3. 40 MB upload hits the 32 MB PHP limit.
        const commentLine = `-- ${"x".repeat(1020)}\n`;
        const repeat40 = Math.ceil((40 * 1024 * 1024) / commentLine.length);
        await writeFile(tooBigFile, commentLine.repeat(repeat40), "utf8");

        const res40 = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
          method: "POST",
          maxTimeSec: 120,
          headers: {
            Origin: `http://127.0.0.1:${webPort}`,
            "Sec-Fetch-Site": "same-origin",
            Cookie: cookieHdr,
          },
          formFields: {
            token: pmaCsrfToken,
            import_type: "database",
            db: prefixA,
            format: "sql",
            import_file: `@${tooBigFile}`,
          },
        });
        assert(res40.ok && res40.parsed, "40 MB import request completes", res40.stderr);
        assert(
          /No data was received to import|probably tried to upload a file that is too large|exceeds the limit|Maximum allowed size/i.test(
            res40.parsed.body,
          ),
          "40 MB import refused with phpMyAdmin upload limit message",
          `status=${res40.parsed.status} snippet=${res40.parsed.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`,
        );

        // 4. Observe 4 concurrent 20 MB comment imports for siteA + siteB responsiveness within 10s.
        const burstTokens = await Promise.all(
          [1, 2, 3, 4].map(async () => {
            const page = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
              headers: {
                Accept: "text/html",
                "Sec-Fetch-Mode": "navigate",
                Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
              },
            });
            const ext = extractPmaSessionFromHeaders(page.parsed?.setCookies ?? [], page.parsed?.body ?? "");
            return {
              cookieHdr: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}; ${ext.cookieHeader}`,
              token: ext.token,
            };
          }),
        );
        const burstStarted = performance.now();
        const burstImports = Promise.all(
          burstTokens.map((bt, i) =>
            curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
              method: "POST",
              maxTimeSec: 120,
              headers: {
                Origin: `http://127.0.0.1:${webPort}`,
                "Sec-Fetch-Site": "same-origin",
                Cookie: bt.cookieHdr,
              },
              formFields: {
                token: bt.token,
                import_type: "database",
                db: prefixA,
                format: "sql",
                charset_of_file: "utf-8",
                import_file: `@${commentFile20}`,
              },
            }).then((r) => {
              const bodyNoNoscript = (r.parsed?.body ?? "").replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
              const text = bodyNoNoscript.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              const alertM = /class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i.exec(bodyNoNoscript);
              const fatalM = /Fatal error[\s\S]{0,180}/i.exec(text);
              const matchStr = fatalM
                ? fatalM[0]
                : alertM
                  ? alertM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
                  : text.slice(0, 160);
              return {
                idx: i + 1,
                ok: r.ok,
                status: r.parsed?.status ?? 0,
                err: r.stderr,
                match: matchStr,
              };
            }),
          ),
        );
        await sleep(300);
        const siteBDuringStarted = performance.now();
        const siteBDuring = await checkSiteBPage(5);
        const siteBDuringMs = Math.round(performance.now() - siteBDuringStarted);
        assert(
          siteBDuring.ok && siteBDuring.parsed?.status === 200 && siteBDuringMs <= 5000,
          `other site phpMyAdmin page answers 200 within 5s during 4x20MB siteA burst (status=${siteBDuring.parsed?.status ?? 0} elapsedMs=${siteBDuringMs})`,
          siteBDuring.stderr,
        );
        const burstResults = await burstImports;
        const burstMs = Math.round(performance.now() - burstStarted);
        const pmaAfterBurst = await dockerInspectContainer(pmaContainerName);
        const burstLogs = await dockerContainerLogs(pmaContainerName);
        const burstErrLines = burstLogs
          .split(/\r?\n/)
          .filter((l) => /killed|fatal|memory|oom|error|warn/i.test(l))
          .slice(-20);
        console.log(
          `INFO burst-4x20mb: elapsedMs=${burstMs} running=${pmaAfterBurst?.State?.Running} OOMKilled=${pmaAfterBurst?.State?.OOMKilled} restartCount=${pmaAfterBurst?.RestartCount} startedAtSame=${pmaAfterBurst?.State?.StartedAt === startedAtBefore} siteBStatus=${siteBDuring.parsed?.status ?? 0} siteBMs=${siteBDuringMs} results=${JSON.stringify(burstResults)} errLines=${JSON.stringify(burstErrLines)}`,
        );
        assert(
          pmaAfterBurst?.State?.Running === true &&
            pmaAfterBurst?.State?.OOMKilled === false &&
            pmaAfterBurst?.State?.StartedAt === startedAtBefore,
          "phpMyAdmin container survives 4 concurrent 20 MB comment imports without OOM/restart",
          `running=${pmaAfterBurst?.State?.Running} OOMKilled=${pmaAfterBurst?.State?.OOMKilled} StartedAt=${pmaAfterBurst?.State?.StartedAt}`,
        );
        assert(
          burstResults.every((r) => r.ok && r.status === 200),
          "all 4 concurrent 20 MB comment imports return HTTP 200 error page (not dropped)",
          JSON.stringify(burstResults),
        );
        const siteBAfterBurst = await checkSiteBPage(10);
        assert(
          siteBAfterBurst.ok && siteBAfterBurst.parsed?.status === 200,
          "other site phpMyAdmin page answers 200 after 4 concurrent comment imports finish",
          `ok=${siteBAfterBurst.ok} status=${siteBAfterBurst.parsed?.status}`,
        );

        await rm(commentFile20, { force: true });
        await rm(okFile, { force: true });
        await rm(tooBigFile, { force: true });
      });

      await runStep("concurrent-page-requests", async () => {
        const cookieHdr = `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`;
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
              maxTimeSec: 15,
              headers: {
                Accept: "text/html",
                "Sec-Fetch-Mode": "navigate",
                Cookie: cookieHdr,
              },
            }),
          ),
        );
        const statuses = results.map((r) => (r.ok ? (r.parsed?.status ?? 0) : 0));
        console.log(`INFO concurrent-8-pages: statuses=${JSON.stringify(statuses)}`);
        assert(
          statuses.every((s) => s === 200),
          "all 8 concurrent page requests return 200",
          JSON.stringify(statuses),
        );
      });

      await runStep("one-site-two-workers", async () => {
        const pmaBefore = await dockerInspectContainer(pmaContainerName);
        assert(pmaBefore !== null, "phpMyAdmin container exists before worker test", "missing");
        const startedAtBefore = pmaBefore.State?.StartedAt;

        const sessions = await Promise.all(
          [1, 2, 3, 4].map(async () => {
            const page = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
              headers: {
                Accept: "text/html",
                "Sec-Fetch-Mode": "navigate",
                Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
              },
            });
            assert(page.ok && page.parsed?.status === 200, "siteA session page -> 200", String(page.parsed?.status));
            const ext = extractPmaSessionFromHeaders(page.parsed.setCookies, page.parsed.body);
            assert(ext.token.length > 0, "phpMyAdmin session CSRF token extracted", "empty token");
            return {
              cookieHdr: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}; ${ext.cookieHeader}`,
              token: ext.token,
            };
          }),
        );

        const startAbortedSql = (sessionObj, sqlQuery) => {
          const bodyStr = new URLSearchParams({
            token: sessionObj.token,
            ajax_request: "true",
            db: prefixA,
            sql_query: sqlQuery,
            pos: "0",
          }).toString();
          let closed = false;
          let onClosed = () => {};
          const closedPromise = new Promise((resolve) => {
            onClosed = resolve;
          });
          const markClosed = () => {
            if (!closed) {
              closed = true;
              onClosed();
            }
          };
          const clientReq = http.request(
            {
              hostname: "127.0.0.1",
              port: webPort,
              path: `/phpmyadmin/${siteA}/index.php?route=/import`,
              method: "POST",
              agent: false,
              headers: {
                Origin: `http://127.0.0.1:${webPort}`,
                "Sec-Fetch-Site": "same-origin",
                Cookie: sessionObj.cookieHdr,
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": String(Buffer.byteLength(bodyStr)),
              },
            },
            (res) => {
              res.resume();
              res.once("end", markClosed);
            },
          );
          clientReq.on("error", markClosed);
          clientReq.on("close", markClosed);
          clientReq.write(bodyStr);
          clientReq.end();
          return {
            abortClient: () => clientReq.destroy(),
            closedPromise,
          };
        };

        const countRunningSiteASql = async () => {
          const proc = await runRootMariaDbSql(
            rootPw,
            `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${expectedSignOnUserA}' AND Command <> 'Sleep';`,
          );
          assert(proc.ok, "MariaDB PROCESSLIST query succeeds", proc.stderr);
          const count = Number(proc.stdout.trim());
          assert(Number.isInteger(count) && count >= 0, "PROCESSLIST returns valid integer", proc.stdout);
          return count;
        };

        const t0 = performance.now();
        const slow1 = startAbortedSql(sessions[0], "SELECT SLEEP(12);");
        const slow2 = startAbortedSql(sessions[1], "SELECT SLEEP(12);");

        // Poll until both SLEEP(12) statements have started and ~1s has elapsed before disconnecting clients.
        let sawTwoRunning = false;
        let maxObservedRunning = 0;
        const startDeadline = Date.now() + 8_000;
        while (Date.now() < startDeadline) {
          const running = await countRunningSiteASql();
          maxObservedRunning = Math.max(maxObservedRunning, running);
          assert(running <= 2, `siteA running SQL count never exceeds 2 (got ${running})`, String(running));
          if (running === 2) {
            sawTwoRunning = true;
          }
          if (sawTwoRunning && performance.now() - t0 >= 1000) {
            break;
          }
          await sleep(150);
        }
        assert(sawTwoRunning, "both slow siteA SQL queries started in MariaDB", `maxRunning=${maxObservedRunning}`);

        // Disconnect both slow clients after ~1s, then immediately queue two more siteA requests.
        slow1.abortClient();
        slow2.abortClient();
        await Promise.all([slow1.closedPromise, slow2.closedPromise]);

        let follow3Done = false;
        let follow4Done = false;
        const postFollowSql = (sessionObj) =>
          curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/index.php?route=/import`, {
            method: "POST",
            maxTimeSec: 28,
            headers: {
              Origin: `http://127.0.0.1:${webPort}`,
              "Sec-Fetch-Site": "same-origin",
              Cookie: sessionObj.cookieHdr,
            },
            data: new URLSearchParams({
              token: sessionObj.token,
              ajax_request: "true",
              db: prefixA,
              sql_query: "SELECT SLEEP(1);",
              pos: "0",
            }).toString(),
          });

        const follow3Promise = postFollowSql(sessions[2]).finally(() => {
          follow3Done = true;
        });
        const follow4Promise = postFollowSql(sessions[3]).finally(() => {
          follow4Done = true;
        });

        let sampleCount = 0;
        let maxSiteBMs = 0;
        const pollDeadline = Date.now() + 28_000;
        while (Date.now() < pollDeadline) {
          const running = await countRunningSiteASql();
          maxObservedRunning = Math.max(maxObservedRunning, running);
          assert(
            running <= 2,
            `siteA PROCESSLIST shows at most 2 running statements (sample=${sampleCount + 1}, got ${running})`,
            String(running),
          );

          const siteBStarted = performance.now();
          const siteBRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteB}/`, {
            maxTimeSec: 5,
            headers: {
              Accept: "text/html",
              "Sec-Fetch-Mode": "navigate",
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieB}`,
            },
          });
          const siteBElapsedMs = Math.round(performance.now() - siteBStarted);
          maxSiteBMs = Math.max(maxSiteBMs, siteBElapsedMs);
          assert(
            siteBRes.ok && siteBRes.parsed?.status === 200 && siteBElapsedMs <= 5000,
            `siteB page answers 200 within 5s while siteA holds 2 workers (sample=${sampleCount + 1}, status=${siteBRes.parsed?.status ?? 0}, ms=${siteBElapsedMs})`,
            siteBRes.stderr,
          );

          const pmaInspect = await dockerInspectContainer(pmaContainerName);
          assert(
            pmaInspect?.State?.Running === true &&
              pmaInspect?.State?.OOMKilled === false &&
              pmaInspect?.State?.StartedAt === startedAtBefore,
            `phpMyAdmin stays healthy without OOM/restart (sample=${sampleCount + 1})`,
            `OOMKilled=${pmaInspect?.State?.OOMKilled} StartedAt=${pmaInspect?.State?.StartedAt}`,
          );

          sampleCount += 1;
          if (follow3Done && follow4Done && sampleCount >= 3) {
            break;
          }
          await sleep(1000);
        }

        const [res3, res4] = await Promise.all([follow3Promise, follow4Promise]);
        assert(
          res3.ok && res3.parsed?.status === 200 && res4.ok && res4.parsed?.status === 200,
          "queued siteA follow-up requests complete with 200 after slow workers end",
          `req3=${res3.parsed?.status ?? 0} req4=${res4.parsed?.status ?? 0}`,
        );
        assert(sampleCount >= 3, "polled MariaDB and siteB multiple times", `samples=${sampleCount}`);

        const siteAFinal = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          maxTimeSec: 5,
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(
          siteAFinal.ok && siteAFinal.parsed?.status === 200,
          "siteA page answers 200 again at end",
          `status=${siteAFinal.parsed?.status ?? 0} ${siteAFinal.stderr}`,
        );

        console.log(
          `INFO one-site-two-workers: samples=${sampleCount} maxRunning=${maxObservedRunning} maxSiteBMs=${maxSiteBMs} req3Status=${res3.parsed?.status ?? 0} req4Status=${res4.parsed?.status ?? 0} totalElapsedMs=${Math.round(performance.now() - t0)}`,
        );
      });

      if (process.env.HP_ACCEPT_LONG === "1") {
        await runStep("long-statements-keep-their-place", async () => {
          const slowSleepSec = 325;
          const pmaBefore = await dockerInspectContainer(pmaContainerName);
          assert(pmaBefore !== null, "phpMyAdmin container exists before long-statement test", "missing");
          const startedAtBefore = pmaBefore.State?.StartedAt;

          const sessions = await Promise.all(
            [1, 2, 3].map(async () => {
              const page = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
                headers: {
                  Accept: "text/html",
                  "Sec-Fetch-Mode": "navigate",
                  Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
                },
              });
              assert(page.ok && page.parsed?.status === 200, "siteA session page -> 200", String(page.parsed?.status));
              const ext = extractPmaSessionFromHeaders(page.parsed.setCookies, page.parsed.body);
              assert(ext.token.length > 0, "phpMyAdmin session CSRF token extracted", "empty token");
              return {
                cookieHdr: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}; ${ext.cookieHeader}`,
                token: ext.token,
              };
            }),
          );

          const startLongSql = (sessionObj, sqlQuery) => {
            const bodyStr = new URLSearchParams({
              token: sessionObj.token,
              ajax_request: "true",
              db: prefixA,
              sql_query: sqlQuery,
              pos: "0",
            }).toString();
            const state = {
              status: 0,
              settled: false,
              error: null,
              clientReq: null,
              donePromise: null,
            };
            state.donePromise = new Promise((resolve) => {
              const finish = () => {
                if (!state.settled) {
                  state.settled = true;
                  resolve();
                }
              };
              const clientReq = http.request(
                {
                  hostname: "127.0.0.1",
                  port: webPort,
                  path: `/phpmyadmin/${siteA}/index.php?route=/import`,
                  method: "POST",
                  agent: false,
                  headers: {
                    Origin: `http://127.0.0.1:${webPort}`,
                    "Sec-Fetch-Site": "same-origin",
                    Cookie: sessionObj.cookieHdr,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": String(Buffer.byteLength(bodyStr)),
                  },
                },
                (res) => {
                  state.status = res.statusCode ?? 0;
                  res.resume();
                  res.once("end", finish);
                  res.once("close", finish);
                },
              );
              state.clientReq = clientReq;
              clientReq.on("error", (err) => {
                state.error = formatErr(err);
                finish();
              });
              clientReq.write(bodyStr);
              clientReq.end();
            });
            return state;
          };

          const countRunningSiteASql = async () => {
            const proc = await runRootMariaDbSql(
              rootPw,
              `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${expectedSignOnUserA}' AND Command <> 'Sleep';`,
            );
            assert(proc.ok, "MariaDB PROCESSLIST query succeeds", proc.stderr);
            const count = Number(proc.stdout.trim());
            assert(Number.isInteger(count) && count >= 0, "PROCESSLIST returns valid integer", proc.stdout);
            return count;
          };

          let stepPassed = false;
          let slow1 = null;
          let slow2 = null;
          let follow3 = null;
          try {
            const t0 = performance.now();
            slow1 = startLongSql(sessions[0], `SELECT SLEEP(${slowSleepSec});`);
            slow2 = startLongSql(sessions[1], `SELECT SLEEP(${slowSleepSec});`);

            let sawTwoRunning = false;
            const startDeadline = Date.now() + 10_000;
            while (Date.now() < startDeadline) {
              const running = await countRunningSiteASql();
              assert(running <= 2, `siteA running SQL count never exceeds 2 (got ${running})`, String(running));
              if (running === 2) {
                sawTwoRunning = true;
                break;
              }
              await sleep(150);
            }
            assert(sawTwoRunning, "both >300s siteA SQL queries started in MariaDB", "less than 2");

            // Wait past 305s while confirming both queries remain running and neither client settled early.
            while (performance.now() - t0 < 305_000) {
              const remainingMs = 305_000 - (performance.now() - t0);
              await sleep(Math.min(10_000, Math.max(50, remainingMs)));
              if (performance.now() - t0 < 305_000) {
                assert(!slow1.settled && !slow2.settled, "slow requests stay pending before 305s", `s1=${slow1.status} s2=${slow2.status}`);
                const running = await countRunningSiteASql();
                assert(running === 2, `both slow queries still running in MariaDB before 305s (got ${running})`, String(running));
              }
            }

            const runningAt305 = await countRunningSiteASql();
            assert(runningAt305 === 2, `at 305s MariaDB still shows 2 running statements for ${expectedSignOnUserA}`, String(runningAt305));
            assert(!slow1.settled && !slow2.settled, "slow requests stay pending past 300s (no fetch timeout)", `s1=${slow1.status} s2=${slow2.status}`);

            const follow3Started = performance.now();
            follow3 = startLongSql(sessions[2], "SELECT SLEEP(1);");

            let windowSamples = 0;
            let maxRunningWindow = 0;
            let maxSiteBMs = 0;
            const windowEnd = follow3Started + 10_000;
            while (true) {
              const tickStarted = performance.now();
              assert(!follow3.settled, `third siteA request still waiting during 10s window (sample=${windowSamples + 1})`, `status=${follow3.status}`);
              const running = await countRunningSiteASql();
              maxRunningWindow = Math.max(maxRunningWindow, running);
              assert(
                running === 2,
                `no third siteA statement appears during 10s window (sample=${windowSamples + 1}, got ${running})`,
                String(running),
              );

              const siteBStarted = performance.now();
              const siteBRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteB}/`, {
                maxTimeSec: 5,
                headers: {
                  Accept: "text/html",
                  "Sec-Fetch-Mode": "navigate",
                  Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieB}`,
                },
              });
              const siteBElapsedMs = Math.round(performance.now() - siteBStarted);
              maxSiteBMs = Math.max(maxSiteBMs, siteBElapsedMs);
              assert(
                siteBRes.ok && siteBRes.parsed?.status === 200 && siteBElapsedMs <= 5000,
                `siteB page answers 200 within 5s while siteA holds 2 workers >305s (sample=${windowSamples + 1}, status=${siteBRes.parsed?.status ?? 0}, ms=${siteBElapsedMs})`,
                siteBRes.stderr,
              );

              const pmaInspect = await dockerInspectContainer(pmaContainerName);
              assert(
                pmaInspect?.State?.Running === true &&
                  pmaInspect?.State?.OOMKilled === false &&
                  pmaInspect?.State?.StartedAt === startedAtBefore,
                `phpMyAdmin stays healthy without OOM/restart (sample=${windowSamples + 1})`,
                `OOMKilled=${pmaInspect?.State?.OOMKilled} StartedAt=${pmaInspect?.State?.StartedAt}`,
              );

              windowSamples += 1;
              const now = performance.now();
              if (now >= windowEnd) break;
              await sleep(Math.min(1000, Math.max(10, windowEnd - now)));
              if (performance.now() - tickStarted < 200 && performance.now() >= windowEnd) break;
            }
            assert(windowSamples >= 5, "sampled multiple times across the 10s window", String(windowSamples));

            // Wait for the two slow statements to end and the queued 3rd request to answer 200.
            await Promise.race([
              follow3.donePromise,
              sleep(40_000).then(() => {
                throw new StepAssertionError("third siteA request answers 200 after slow statements end", "timed out after 40s");
              }),
            ]);
            const follow3WaitMs = Math.round(performance.now() - follow3Started);
            assert(
              follow3.status === 200,
              "third siteA request answers 200 after slow statements end",
              `status=${follow3.status} err=${String(follow3.error)}`,
            );

            await Promise.race([Promise.all([slow1.donePromise, slow2.donePromise]), sleep(5_000)]);

            const finalStarted = performance.now();
            const siteAFinal = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
              maxTimeSec: 5,
              headers: {
                Accept: "text/html",
                "Sec-Fetch-Mode": "navigate",
                Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
              },
            });
            const finalMs = Math.round(performance.now() - finalStarted);
            assert(
              siteAFinal.ok && siteAFinal.parsed?.status === 200 && finalMs <= 5000,
              "last siteA request answers 200 at once",
              `status=${siteAFinal.parsed?.status ?? 0} ms=${finalMs} ${siteAFinal.stderr}`,
            );

            console.log(
              `INFO long-statements-keep-their-place: slowSleepSec=${slowSleepSec} runningAt305=${runningAt305} windowSamples=${windowSamples} maxRunningWindow=${maxRunningWindow} slow1Status=${slow1.status} slow2Status=${slow2.status} maxSiteBMs=${maxSiteBMs} follow3Status=${follow3.status} follow3WaitMs=${follow3WaitMs} finalStatus=${siteAFinal.parsed?.status ?? 0} finalMs=${finalMs} totalElapsedMs=${Math.round(performance.now() - t0)}`,
            );
            stepPassed = true;
          } finally {
            slow1?.clientReq?.destroy();
            slow2?.clientReq?.destroy();
            follow3?.clientReq?.destroy();
            if (!stepPassed) {
              await runRootMariaDbSql(rootPw, `KILL USER '${expectedSignOnUserA}'@'%';`).catch(() => {});
            }
          }
        });
      } else {
        console.log(
          "SKIP long-statements-keep-their-place: HP_ACCEPT_LONG=1 not set (run: HP_ACCEPT_LONG=1 node infra/linux/accept-m2-phpmyadmin.mjs)",
        );
      }

      await runStep("second-signon-ends-first", async () => {
        // Open a real MariaDB TCP session using signOn #1 credentials and run SLEEP(30).
        const sleepChild = spawn(
          "docker",
          [
            "exec",
            "-e",
            `MYSQL_PWD=${pw1}`,
            dbContainerName,
            "mariadb",
            "--protocol=TCP",
            "-h",
            "127.0.0.1",
            "-u",
            expectedSignOnUserA,
            "-e",
            "SELECT SLEEP(30);",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        activeChildren.add(sleepChild);
        let sleepExited = false;
        let sleepCode = null;
        const sleepDone = new Promise((resolve) => {
          sleepChild.once("exit", (code) => {
            sleepExited = true;
            sleepCode = code;
            activeChildren.delete(sleepChild);
            resolve();
          });
        });

        let seenInProcesslist = false;
        for (let i = 0; i < 40; i += 1) {
          const pl = await runRootMariaDbSql(
            rootPw,
            `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${expectedSignOnUserA}';`,
          );
          if (pl.ok && Number(pl.stdout.trim()) >= 1) {
            seenInProcesslist = true;
            break;
          }
          await sleep(100);
        }
        assert(seenInProcesslist, "first sign-on MariaDB session active in PROCESSLIST", "not seen");

        pw2 = `${randomBytes(16).toString("hex")}Bb22`;
        const signOn2 = await adapter.siteDatabases({
          siteId: siteA,
          op: "phpMyAdminSignOn",
          passwordHash: mysqlNativePasswordHash(pw2),
        });
        assert(signOn2.username === expectedSignOnUserA, "second signOn username matches", signOn2.username);

        await Promise.race([sleepDone, sleep(3000)]);
        assert(sleepExited && sleepCode !== 0, "second sign-on kills first DB session", `exited=${sleepExited} code=${sleepCode}`);

        // Old hp_pma cookie is now rejected (401 + cleared)
        const oldRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue1}`,
          },
        });
        assert(
          oldRes.ok && oldRes.parsed?.status === 401,
          "old hp_pma rejected with 401",
          `${String(oldRes.parsed?.status)} body=${(oldRes.parsed?.body ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600)}`,
        );

        // New hp_pma cookie works
        pmaCookieValue2 = await sealPmaCookie(getSessionSecretKey(), {
          siteId: siteA,
          orgId: orgA,
          username: signOn2.username,
          password: pw2,
          sid: sessionBindingId(sessionA),
        });
        const newRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue2}`,
          },
        });
        assert(newRes.ok && newRes.parsed?.status === 200, "new hp_pma succeeds with 200", String(newRes.parsed?.status));
      });

      await runStep("network-isolation", async () => {
        const pmaInspect = await dockerInspectContainer(pmaContainerName);
        const pmaIp = pmaInspect?.NetworkSettings?.Networks?.[pmaNetworkName]?.IPAddress;
        assert(typeof pmaIp === "string" && pmaIp.length > 0, "phpMyAdmin container IP resolved", String(pmaIp));

        await dockerUnixJson("POST", "/networks/create", {
          Name: otherNetworkName,
          Driver: "bridge",
          CheckDuplicate: true,
        });
        createdNetworks.add(otherNetworkName);
        const otherNetInfo = await dockerInspectNetwork(otherNetworkName);
        const gatewayIp = otherNetInfo?.IPAM?.Config?.[0]?.Gateway;
        assert(typeof gatewayIp === "string" && gatewayIp.length > 0, "other network gateway IP resolved", String(gatewayIp));

        const probeCreate = await dockerUnixJson(
          "POST",
          `/containers/create?name=${encodeURIComponent(probeContainerName)}`,
          {
            Image: PHPMYADMIN_IMAGE,
            Entrypoint: ["sh", "-c", "sleep 120"],
            User: "33:33",
            HostConfig: {
              Privileged: false,
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges:true"],
              NetworkMode: otherNetworkName,
            },
          },
        );
        createdContainers.add(probeContainerName);
        await dockerUnixJson("POST", `/containers/${encodeURIComponent(probeCreate.Id)}/start`, {});

        const byContainerIp = await docker([
          "exec",
          probeContainerName,
          "curl",
          "-sS",
          "--max-time",
          "2",
          `http://${pmaIp}:80/`,
        ]);
        assert(!byContainerIp.ok, "other-network container cannot reach phpMyAdmin IP:80", byContainerIp.stdout);

        const byGatewayPort = await docker([
          "exec",
          probeContainerName,
          "curl",
          "-sS",
          "--max-time",
          "2",
          `http://${gatewayIp}:${pmaPort}/`,
        ]);
        assert(!byGatewayPort.ok, "other-network container cannot reach host bridge gateway:pmaPort", byGatewayPort.stdout);
      });

      await runStep("container-hardening", async () => {
        const info = await dockerInspectContainer(pmaContainerName);
        assert(info !== null, `container ${pmaContainerName} exists`, "missing");
        assert(info.Config?.User === "33:33", "User=33:33", String(info.Config?.User));
        assert(info.State?.Running === true, "State.Running=true", String(info.State?.Running));

        const hc = info.HostConfig ?? {};
        assert(hc.Privileged === false, "Privileged=false", String(hc.Privileged));
        assert(hc.ReadonlyRootfs === true, "ReadonlyRootfs=true", String(hc.ReadonlyRootfs));
        assert(
          Array.isArray(hc.CapDrop) && hc.CapDrop.length === 1 && hc.CapDrop[0] === "ALL",
          "CapDrop=[ALL]",
          JSON.stringify(hc.CapDrop),
        );
        assert(!hc.CapAdd || hc.CapAdd.length === 0, "CapAdd empty", JSON.stringify(hc.CapAdd));
        assert(
          Array.isArray(hc.SecurityOpt) && hc.SecurityOpt.includes("no-new-privileges:true"),
          "SecurityOpt includes no-new-privileges:true",
          JSON.stringify(hc.SecurityOpt),
        );
        assert(hc.Memory === 536_870_912, "Memory=512MiB", String(hc.Memory));
        assert(hc.MemorySwap === 536_870_912, "MemorySwap=512MiB", String(hc.MemorySwap));
        assert(hc.PidsLimit === 100, "PidsLimit=100", String(hc.PidsLimit));
        assert(hc.NanoCpus === 500_000_000, "NanoCpus=0.5", String(hc.NanoCpus));
        const mpmConf = await readFile(path.join(configDir, "hp-mpm.conf"), "utf8");
        assert(/\bMaxRequestWorkers\s+4\b/.test(mpmConf), "hp-mpm.conf sets MaxRequestWorkers 4", mpmConf);

        const tmpfsKeys = Object.keys(hc.Tmpfs ?? {}).sort();
        assert(
          JSON.stringify(tmpfsKeys) ===
            JSON.stringify(["/sessions", "/tmp", "/var/run/apache2", "/var/www/html/tmp"]),
          "4 designed tmpfs mounts",
          JSON.stringify(tmpfsKeys),
        );

        const binds = Array.isArray(hc.Binds) ? hc.Binds : [];
        assert(
          binds.length === 2 &&
            binds[0] === `${path.join(configDir, "config.inc.php")}:/etc/phpmyadmin/config.inc.php:ro` &&
            binds[1] === `${path.join(configDir, "hp-mpm.conf")}:/etc/apache2/conf-enabled/hp-mpm.conf:ro`,
          "only the two :ro configuration binds from configDir",
          JSON.stringify(binds),
        );

        const portBindingKeys = Object.keys(hc.PortBindings ?? {});
        const portBindings = hc.PortBindings?.["80/tcp"] ?? [];
        assert(
          portBindingKeys.length === 1 &&
            portBindingKeys[0] === "80/tcp" &&
            portBindings.length === 1 &&
            portBindings[0]?.HostIp === "127.0.0.1" &&
            portBindings[0]?.HostPort === String(pmaPort),
          `PortBindings 127.0.0.1:${pmaPort} only`,
          JSON.stringify(hc.PortBindings),
        );

        const nets = Object.keys(info.NetworkSettings?.Networks ?? {});
        assert(
          nets.length === 1 && nets[0] === pmaNetworkName,
          `connected only to ${pmaNetworkName}`,
          JSON.stringify(nets),
        );

        const envList = Array.isArray(info.Config?.Env) ? info.Config.Env : [];
        for (const e of envList) {
          assert(!e.includes(rootPw) && !e.includes(pw1) && !e.includes(pw2), "no secret in Env", e);
        }

        const netInfo = await dockerInspectNetwork(pmaNetworkName);
        const netContainerIds = new Set(Object.keys(netInfo?.Containers ?? {}));
        assert(
          netContainerIds.size === 2 &&
            netContainerIds.has(info.Id) &&
            netContainerIds.has(dbInitialInspect.Id),
          "pma network holds only phpMyAdmin and MariaDB",
          JSON.stringify([...netContainerIds]),
        );
      });

      await runStep("config-change-recreates-cp01", async () => {
        const beforePma = await dockerInspectContainer(pmaContainerName);
        assert(beforePma !== null, "phpMyAdmin exists before config change", "missing");

        const adapter2 = new DockerEngineSocketAdapter({
          pullMissingImages: false,
          secretsRootDir: path.join(tmpRoot, "secrets"),
          ingressRootDir: path.join(tmpRoot, "ingress"),
          sharedDbContainerName: dbContainerName,
          phpMyAdminContainerName: pmaContainerName,
          phpMyAdminNetworkName: pmaNetworkName,
          phpMyAdminConfigDir: configDir,
          phpMyAdminPort: pmaPort2,
        });

        await adapter2.ensurePhpMyAdmin();
        await waitForPmaHttpReady(pmaPort2);
        swapForwarderPort(pmaPort2);

        const afterPortChange = await dockerInspectContainer(pmaContainerName);
        assert(
          afterPortChange !== null && afterPortChange.State?.Running === true,
          "recreated phpMyAdmin running after port change",
          "not running",
        );
        assert(
          afterPortChange.Id !== beforePma.Id,
          "phpMyAdmin recreated with new Id on port change",
          afterPortChange.Id,
        );

        // Also change configuration text (database hostname) and confirm recreate + new mounted file.
        await dockerUnixJson("POST", `/networks/${encodeURIComponent(pmaNetworkName)}/disconnect`, {
          Container: dbContainerName,
          Force: false,
        });
        const newDbHost = "hp-mariadb-reconf";
        await ensurePhpMyAdminContainer({
          containerName: pmaContainerName,
          networkName: pmaNetworkName,
          configDir,
          port: pmaPort2,
          sharedDbContainerName: dbContainerName,
          dbHost: newDbHost,
          ensureImageAvailable: async () => undefined,
          ensureNetwork: async () => undefined,
          connectContainerToNetwork: async (net, ref, aliases) => {
            const res = await dockerUnixRequest("POST", `/networks/${encodeURIComponent(net)}/connect`, {
              Container: ref,
              ...(aliases && aliases.length > 0 ? { EndpointConfig: { Aliases: aliases } } : {}),
            });
            return res.statusCode === 200 || res.statusCode === 204;
          },
          inspectContainerByNameOrId: async (ref) => {
            const info = await dockerInspectContainer(ref);
            if (!info) return null;
            return {
              Id: info.Id,
              State: { Running: info.State?.Running === true },
              Config: { Labels: info.Config?.Labels ?? {} },
            };
          },
          stopAndRemoveContainer: async (id) => {
            await dockerUnixRequest("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`, undefined);
            await dockerUnixJson("DELETE", `/containers/${encodeURIComponent(id)}?force=true`, undefined, [200, 204]);
          },
          request: (method, endpointPath, body) => dockerUnixRequest(method, endpointPath, body),
        });
        await waitForPmaHttpReady(pmaPort2);

        const afterPma = await dockerInspectContainer(pmaContainerName);
        assert(afterPma !== null && afterPma.State?.Running === true, "recreated phpMyAdmin running", "not running");
        assert(
          afterPma.Id !== afterPortChange.Id,
          "phpMyAdmin recreated with new Id on config text change",
          afterPma.Id,
        );

        const cfgInside = await docker(["exec", pmaContainerName, "cat", "/etc/phpmyadmin/config.inc.php"]);
        assert(
          cfgInside.ok && cfgInside.stdout.includes(`$cfg['Servers'][1]['host'] = '${newDbHost}';`),
          "recreated container mounts updated config.inc.php",
          cfgInside.stdout,
        );

        const forwarderRes = await curlHttp(`http://127.0.0.1:${webPort}/phpmyadmin/${siteA}/`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${PMA_COOKIE_NAME}=${pmaCookieValue2}`,
          },
        });
        assert(
          forwarderRes.ok && forwarderRes.parsed?.status === 200,
          "recreated phpMyAdmin serves through forwarder with new DB hostname",
          String(forwarderRes.parsed?.status),
        );

        const dbAfter = await dockerInspectContainer(dbContainerName);
        assert(
          dbAfter?.Id === dbInitialInspect.Id &&
            dbAfter?.State?.StartedAt === dbInitialInspect.State?.StartedAt &&
            dbAfter?.RestartCount === dbInitialInspect.RestartCount,
          `MariaDB untouched (StartedAt=${dbInitialInspect.State?.StartedAt}, RestartCount=${dbInitialInspect.RestartCount})`,
          `StartedAt=${dbAfter?.State?.StartedAt}, RestartCount=${dbAfter?.RestartCount}`,
        );
      });

      let nextBaseUrl = "";
      let nextPmaCookiePair = "";
      let nextStaticAssetUrl = "";

      await runStep("next-signon", async () => {
        nextPort = await getFreePortInRange(20000, 60000, new Set([pmaPort, pmaPort2, apiPort, webPort]));
        const nextBin = path.resolve(repoRoot, "apps/web/node_modules/next/dist/bin/next");
        const nextLogs = [];
        const nextProc = spawn(
          process.execPath,
          [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(nextPort)],
          {
            cwd: path.resolve(repoRoot, "apps/web"),
            env: {
              ...process.env,
              NODE_ENV: "production",
              PORT: String(nextPort),
              API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
              BFF_SESSION_SECRET: sessionSecret,
              HP_PHPMYADMIN_PORT: String(pmaPort2),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        activeChildren.add(nextProc);
        let nextExited = null;
        nextProc.stdout?.on("data", (chunk) => {
          nextLogs.push(chunk.toString("utf8"));
        });
        nextProc.stderr?.on("data", (chunk) => {
          nextLogs.push(chunk.toString("utf8"));
        });
        nextProc.once("exit", (code, signal) => {
          nextExited = { code, signal };
          activeChildren.delete(nextProc);
        });

        const candidateUrl = `http://127.0.0.1:${nextPort}`;
        const readyDeadline = Date.now() + 30_000;
        let ready = false;
        while (Date.now() < readyDeadline) {
          if (nextExited !== null) {
            throw new StepAssertionError(
              "next start stays running",
              `exited code=${String(nextExited.code)} sig=${String(nextExited.signal)} logs=${nextLogs.join("").slice(-400)}`,
            );
          }
          try {
            const probeRes = await fetch(`${candidateUrl}/login`, { redirect: "manual" });
            await probeRes.body?.cancel().catch(() => {});
            if (probeRes.status === 200) {
              ready = true;
              break;
            }
          } catch {
            // Still binding port
          }
          await sleep(100);
        }
        assert(
          ready,
          `next start answers 200 on 127.0.0.1:${nextPort}/login`,
          nextLogs.join("").slice(-400),
        );
        nextBaseUrl = candidateUrl;

        const signonRes = await fetch(
          `${nextBaseUrl}/api/bff/orgs/${encodeURIComponent(orgA)}/managed-sites/${encodeURIComponent(siteA)}/databases/phpmyadmin`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              Origin: nextBaseUrl,
              "X-CSRF-Token": sessionA.csrfToken,
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}`,
            },
          },
        );
        const rawSignonBody = await signonRes.text();
        assert(signonRes.status === 200, "BFF sign-on through next start -> 200", `${signonRes.status} ${rawSignonBody}`);
        const signonJson = JSON.parse(rawSignonBody);
        assert(
          signonJson?.data?.url === pmaPrefix(siteA),
          `BFF sign-on returns url=${pmaPrefix(siteA)}`,
          rawSignonBody,
        );
        assert(
          !rawSignonBody.includes(expectedSignOnUserA) &&
            (lastApiSignOnPassword.length === 0 || !rawSignonBody.includes(lastApiSignOnPassword)),
          "BFF sign-on never relays username or temporaryPassword",
          "credential leaked",
        );

        const setCookies =
          typeof signonRes.headers.getSetCookie === "function" ? signonRes.headers.getSetCookie() : [];
        const pmaSetCookie = setCookies.find((c) => c.startsWith(`${PMA_COOKIE_NAME}=`));
        assert(Boolean(pmaSetCookie), `BFF sign-on sets ${PMA_COOKIE_NAME} cookie`, JSON.stringify(setCookies));
        assert(
          pmaSetCookie.includes(`Path=${pmaPrefix(siteA)}`),
          `hp_pma cookie Path=${pmaPrefix(siteA)}`,
          pmaSetCookie,
        );
        assert(/\bHttpOnly\b/i.test(pmaSetCookie), "hp_pma cookie is HttpOnly", pmaSetCookie);
        assert(/\bSameSite=strict\b/i.test(pmaSetCookie), "hp_pma cookie is SameSite=Strict", pmaSetCookie);
        nextPmaCookiePair = pmaSetCookie.split(";")[0]?.trim() ?? "";
        assert(nextPmaCookiePair.startsWith(`${PMA_COOKIE_NAME}=`), "extracted hp_pma cookie pair", nextPmaCookiePair);
        console.log(`INFO next-signon: url=${signonJson.data.url} setCookieAttrs=${pmaSetCookie.split(";").slice(1).join(";").trim()}`);
      });

      await runStep("next-phpmyadmin-open", async () => {
        assert(nextBaseUrl.length > 0 && nextPmaCookiePair.length > 0, "next start and hp_pma ready", "not ready");
        const res = await fetch(`${nextBaseUrl}${pmaPrefix(siteA)}`, {
          redirect: "manual",
          headers: {
            Accept: "text/html",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${nextPmaCookiePair}`,
          },
        });
        const body = await res.text();
        assert(res.status === 200, "GET /phpmyadmin/<siteA>/ through next start -> 200", `${res.status} loc=${String(res.headers.get("location"))}`);
        const pmaOutCookies =
          typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        assert(pmaOutCookies.length > 0, "phpMyAdmin Set-Cookie present through next start", "none");
        for (const sc of pmaOutCookies) {
          assert(sc.includes(`Path=${pmaPrefix(siteA)}`), `Set-Cookie scoped to ${pmaPrefix(siteA)}`, sc);
          assert(!/\bDomain=/i.test(sc), "Set-Cookie has no Domain=", sc);
        }
        assert(body.includes("phpMyAdmin"), "response is phpMyAdmin HTML", body.slice(0, 200));
        assert(body.includes(prefixA), `phpMyAdmin page lists siteA primary DB ${prefixA}`, "missing prefixA");
        assert(body.includes(dbApp), `phpMyAdmin page lists siteA custom DB ${dbApp}`, "missing dbApp");
        assert(!body.includes(prefixB), `phpMyAdmin page excludes siteB DB ${prefixB}`, "leaked prefixB");
        assert(
          lastApiSignOnPassword.length === 0 || !body.includes(lastApiSignOnPassword),
          "phpMyAdmin page does not leak sign-on password",
          "leaked password",
        );

        const assetMatches = [
          ...body.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi),
        ];
        assert(assetMatches.length > 0, "phpMyAdmin HTML includes at least one .css or .js asset", "none");
        const rawAssetRef = (assetMatches[0]?.[1] ?? "").replaceAll("&amp;", "&");
        const resolvedAsset = new URL(rawAssetRef, `${nextBaseUrl}${pmaPrefix(siteA)}`);
        assert(
          resolvedAsset.origin === nextBaseUrl && resolvedAsset.pathname.startsWith(pmaPrefix(siteA)),
          `static asset URL resolves under ${pmaPrefix(siteA)}`,
          resolvedAsset.toString(),
        );
        nextStaticAssetUrl = resolvedAsset.toString();
        console.log(
          `INFO next-open: status=${res.status} xfo=${res.headers.get("x-frame-options") ?? "none"} csp=${res.headers.get("content-security-policy") ?? "none"} asset=${resolvedAsset.pathname}`,
        );
      });

      await runStep("next-trailing-slash-no-loop", async () => {
        assert(nextBaseUrl.length > 0 && nextPmaCookiePair.length > 0, "next start and hp_pma ready", "not ready");
        let currentUrl = `${nextBaseUrl}/phpmyadmin/${siteA}`;
        const hops = [];
        let finalBody = "";

        for (let i = 0; i < 5; i += 1) {
          const parsedTarget = new URL(currentUrl);
          const cookieHdr = parsedTarget.pathname.startsWith(pmaPrefix(siteA))
            ? `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${nextPmaCookiePair}`
            : `${SESSION_COOKIE_NAME}=${sessionCookieValue}`;
          const hopRes = await fetch(currentUrl, {
            redirect: "manual",
            headers: {
              Accept: "text/html",
              Cookie: cookieHdr,
            },
          });
          const loc = hopRes.headers.get("location");
          hops.push({ status: hopRes.status, location: loc });
          if (hopRes.status >= 300 && hopRes.status < 400 && loc !== null) {
            await hopRes.body?.cancel().catch(() => {});
            currentUrl = new URL(loc, currentUrl).toString();
            continue;
          }
          finalBody = await hopRes.text();
          break;
        }

        console.log(`INFO next-trailing-slash: hops=${JSON.stringify(hops)}`);
        assert(hops.length === 2, "exactly 2 hops (one 308 + one 200), no loop", JSON.stringify(hops));
        assert(
          hops[0]?.status === 308 && hops[0]?.location === pmaPrefix(siteA),
          `hop 1 is 308 Location=${pmaPrefix(siteA)}`,
          JSON.stringify(hops[0]),
        );
        assert(
          hops[1]?.status === 200 && hops[1]?.location === null,
          "hop 2 is 200 with no further redirect",
          JSON.stringify(hops[1]),
        );
        assert(
          finalBody.includes(prefixA) && finalBody.includes(dbApp) && !finalBody.includes(prefixB),
          "followed destination renders siteA phpMyAdmin page without siteB",
          finalBody.slice(0, 200),
        );
      });

      await runStep("next-no-session-refused", async () => {
        assert(nextBaseUrl.length > 0 && nextPmaCookiePair.length > 0, "next start and hp_pma ready", "not ready");
        const beforeLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));

        const fetchRes = await fetch(`${nextBaseUrl}${pmaPrefix(siteA)}`, {
          redirect: "manual",
          headers: {
            Accept: "text/html",
            Cookie: nextPmaCookiePair,
          },
        });
        const fetchBody = await fetchRes.text();
        assert(fetchRes.status === 401, "fetch without hp_session -> 401", `${fetchRes.status}`);
        assert(
          fetchBody.length === 0 &&
            !fetchBody.includes("phpMyAdmin") &&
            !fetchBody.includes(prefixA) &&
            !fetchBody.includes(dbApp),
          "401 refusal returns zero phpMyAdmin content",
          fetchBody.slice(0, 200),
        );

        const navRes = await curlHttp(`${nextBaseUrl}${pmaPrefix(siteA)}`, {
          headers: {
            Accept: "text/html",
            "Sec-Fetch-Mode": "navigate",
            Cookie: nextPmaCookiePair,
          },
        });
        assert(navRes.ok && navRes.parsed, "navigation refusal curl succeeds", navRes.stderr);
        assert(
          navRes.parsed.status === 303 && navRes.parsed.location === "/login",
          "navigation without hp_session -> 303 Location=/login",
          `status=${navRes.parsed.status} loc=${String(navRes.parsed.location)}`,
        );
        assert(
          navRes.parsed.body.length === 0 &&
            !navRes.parsed.body.includes("phpMyAdmin") &&
            !navRes.parsed.body.includes(prefixA),
          "303 refusal returns zero phpMyAdmin content",
          navRes.parsed.body.slice(0, 200),
        );

        const afterLines = countPmaAccessLines(await dockerContainerLogs(pmaContainerName));
        assert(afterLines === beforeLines, `phpMyAdmin access log unchanged (${beforeLines})`, String(afterLines));
        console.log(
          `INFO next-no-session: fetchStatus=${fetchRes.status} navStatus=${navRes.parsed.status} navLocation=${navRes.parsed.location}`,
        );
      });

      await runStep("next-phpmyadmin-static-asset", async () => {
        assert(nextStaticAssetUrl.length > 0 && nextPmaCookiePair.length > 0, "static asset URL extracted", "missing");
        const assetRes = await fetch(nextStaticAssetUrl, {
          redirect: "manual",
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${nextPmaCookiePair}`,
          },
        });
        const assetBody = await assetRes.text();
        const contentType = assetRes.headers.get("content-type") ?? "";
        assert(assetRes.status === 200, "static asset through next start -> 200", `${assetRes.status}`);
        assert(assetBody.length > 0, "static asset body non-empty", "empty");
        assert(/text\/css|javascript/i.test(contentType), "static asset has CSS or JS content-type", contentType);
        console.log(
          `INFO next-static-asset: path=${new URL(nextStaticAssetUrl).pathname} status=${assetRes.status} contentType=${contentType} bytes=${Buffer.byteLength(assetBody)}`,
        );
      });

      await runStep("next-panel-trailing-slash", async () => {
        assert(nextBaseUrl.length > 0, "next start ready", "not ready");
        const loginSlashRes = await fetch(`${nextBaseUrl}/login/`, {
          redirect: "manual",
          headers: { Accept: "text/html" },
        });
        const loginSlashLoc = loginSlashRes.headers.get("location");
        const loginSlashBody = await loginSlashRes.text();
        assert(
          loginSlashRes.status === 200 && loginSlashLoc === null,
          "GET /login/ answers 200 directly with no redirect",
          `status=${loginSlashRes.status} loc=${String(loginSlashLoc)}`,
        );
        assert(
          loginSlashBody.includes("<form") && loginSlashBody.includes("Hosting Panel"),
          "GET /login/ renders real login page HTML",
          loginSlashBody.slice(0, 200),
        );
        console.log(
          `INFO next-panel-trailing-slash: path=/login/ status=${loginSlashRes.status} location=${String(loginSlashLoc)}`,
        );
      });

      await runStep("next-frame-headers", async () => {
        assert(nextBaseUrl.length > 0 && nextPmaCookiePair.length > 0, "next start and hp_pma ready", "not ready");
        const panelRes = await fetch(`${nextBaseUrl}/login`, {
          redirect: "manual",
          headers: { Accept: "text/html" },
        });
        await panelRes.body?.cancel().catch(() => {});
        const panelXfo = panelRes.headers.get("x-frame-options") ?? "";
        const panelCsp = panelRes.headers.get("content-security-policy") ?? "";
        assert(panelRes.status === 200, "GET /login -> 200", `${panelRes.status}`);
        assert(panelXfo.toUpperCase() === "DENY", "panel X-Frame-Options is DENY", panelXfo);
        assert(
          panelCsp.toLowerCase().includes("frame-ancestors 'none'"),
          "panel Content-Security-Policy includes frame-ancestors 'none'",
          panelCsp,
        );

        const upstreamBasic = Buffer.from(`${expectedSignOnUserA}:${lastApiSignOnPassword}`, "utf8").toString("base64");
        const upstreamRes = await fetch(`http://127.0.0.1:${pmaPort2}/`, {
          redirect: "manual",
          headers: {
            Accept: "text/html",
            Authorization: `Basic ${upstreamBasic}`,
            "X-Forwarded-Prefix": pmaPrefix(siteA),
          },
        });
        await upstreamRes.body?.cancel().catch(() => {});
        const upstreamXfo = upstreamRes.headers.get("x-frame-options") ?? "";
        const upstreamCsp = upstreamRes.headers.get("content-security-policy") ?? "";
        assert(upstreamRes.status === 200, "direct upstream phpMyAdmin -> 200", `${upstreamRes.status}`);

        const pmaRes = await fetch(`${nextBaseUrl}${pmaPrefix(siteA)}`, {
          redirect: "manual",
          headers: {
            Accept: "text/html",
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieValue}; ${nextPmaCookiePair}`,
          },
        });
        await pmaRes.body?.cancel().catch(() => {});
        const pmaXfo = pmaRes.headers.get("x-frame-options") ?? "";
        const pmaCsp = pmaRes.headers.get("content-security-policy") ?? "";
        assert(pmaRes.status === 200, "GET /phpmyadmin/<siteA>/ -> 200", `${pmaRes.status}`);
        const expectedPmaXfo = upstreamXfo.trim().length > 0 ? upstreamXfo : "SAMEORIGIN";
        assert(
          pmaXfo.trim().length > 0 && pmaXfo === expectedPmaXfo,
          `forwarded phpMyAdmin X-Frame-Options preserves upstream (${expectedPmaXfo})`,
          pmaXfo,
        );
        assert(
          pmaCsp === upstreamCsp && !pmaCsp.toLowerCase().includes("frame-ancestors 'none'"),
          "forwarded phpMyAdmin preserves upstream CSP without panel frame-ancestors 'none'",
          `upstream=${JSON.stringify(upstreamCsp)} forwarded=${JSON.stringify(pmaCsp)}`,
        );
        console.log(
          `INFO next-frame-headers: panelXfo=${panelXfo} panelCsp=${JSON.stringify(panelCsp)} upstreamXfo=${upstreamXfo} pmaXfo=${pmaXfo} pmaCsp=${JSON.stringify(pmaCsp)}`,
        );
      });
    }
  } finally {
    await cleanup();
  }

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`accept-m2-phpmyadmin: ${passed}/${total} passed in ${elapsedSec}s`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`FAIL fatal: ${formatErr(err)}`);
  await cleanup();
  process.exit(1);
});
