#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M2 cycle 3 (site databases in the executor).
 *
 * Drives the built DockerEngineSocketAdapter.siteDatabases (pointed at a throw-away
 * MariaDB via sharedDbContainerName) and SiteDatabasesRunner (sign-on SQL half with
 * no-op ensurePhpMyAdmin) against the real Docker Engine, plus db.provision with the
 * real DB_PROVISION_SCRIPT (R30).
 *
 * Machine safety: every created Docker resource starts with "hp_swarmtest_" and is
 * removed by exact name in `finally` (including on SIGINT/SIGTERM). No ports are
 * published and no prune command is ever run.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const {
  DB_PROVISION_SCRIPT,
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  MARIADB_EXTRA_MAX_USER_CONNECTIONS,
  MARIADB_OWN_MAX_USER_CONNECTIONS,
  MARIADB_SIGNON_MAX_USER_CONNECTIONS,
  SHARED_DB_ALIAS,
  SiteDatabasesRunner,
  buildSharedDatabaseContainerPayload,
  buildSiteJobContainerPayload,
  mariadbRootExec,
} = await import(pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href);

const {
  DEFAULT_PHP_VERSION,
  SHARED_MARIADB_IMAGE,
  SITE_DATABASES_MAX,
  SITE_DATABASE_USERS_MAX,
  mysqlNativePasswordHash,
  resolveWordpressImage,
  siteDatabaseFullName,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
} = await import(pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href);

const SOCKET_PATH = "/var/run/docker.sock";
const WORDPRESS_IMAGE = resolveWordpressImage(DEFAULT_PHP_VERSION);

const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;
const networkName = `${runId}_net`;
const dbContainerName = `${runId}_mariadb`;
const cliContainerName = `${runId}_cli`;
const wpContainerName = `${runId}_wp`;

const siteA = `site_accept_a_${runHex}`;
const siteB = `site_accept_b_${runHex}`;
const prefixA = siteDatabasePrefix(siteA);
const prefixB = siteDatabasePrefix(siteB);
const hexA = prefixA.slice(3);
const signOnUserA = siteDatabaseSignOnUser(siteA);

const uidGid = `${String(process.getuid())}:${String(process.getgid())}`;

const createdContainers = new Set();
const createdVolumes = new Set();
const tempDirs = [];
const activeChildProcesses = new Set();
let createdNetwork = false;

const secretsToGuard = new Set();
const capturedErrorMessages = [];
const capturedOutputLines = [];
const capturedResultJsons = [];

function logLine(line) {
  capturedOutputLines.push(line);
  console.log(line);
}

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
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPassword24() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  secretsToGuard.add(out);
  return out;
}

function trackHash(pw) {
  const h = mysqlNativePasswordHash(pw);
  secretsToGuard.add(h);
  return h;
}

function dockerRequest(method, reqPath, jsonBody, options = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody), "utf8");
    const headers = payload
      ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
      : {};
    const req = http.request({ socketPath: SOCKET_PATH, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    });
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () =>
        req.destroy(new Error(`Docker HTTP timeout: ${method} ${reqPath}`)),
      );
    }
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerJson(
  method,
  reqPath,
  jsonBody,
  okStatuses = [200, 201, 204],
  timeoutMs = 60_000,
) {
  const res = await dockerRequest(method, reqPath, jsonBody, { timeoutMs });
  if (!okStatuses.includes(res.statusCode)) {
    throw new Error(
      `Docker ${method} ${reqPath} failed (${String(res.statusCode)}): ${res.body.toString("utf8")}`,
    );
  }
  if (res.body.length === 0) return null;
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    return res.body.toString("utf8");
  }
}

function execCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFileCb(
      cmd,
      args,
      {
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            ok: true,
            code: 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          });
          return;
        }
        const exitCode = typeof err.code === "number" ? err.code : 1;
        resolve({
          ok: false,
          code: exitCode,
          killed: Boolean(err.killed),
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : err.message,
        });
      },
    );
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

/** Runs SQL as a MariaDB user inside cliContainerName, piping password on line 1 of stdin. */
async function execClientSql(user, password, sql, opts = {}) {
  return docker(
    [
      "exec",
      "-i",
      cliContainerName,
      "sh",
      "-c",
      'IFS= read -r p && MYSQL_PWD="$p" exec mariadb -h hp-mariadb -u "$1" --batch --raw --skip-column-names',
      "_",
      user,
    ],
    {
      stdin: `${password}\n${sql}\n`,
      timeoutMs: opts.timeoutMs ?? 15_000,
    },
  );
}

/** Runs PHP mysqli code inside wpContainerName, passing password and params on stdin. */
async function execWpPhp(phpScript, stdinText, opts = {}) {
  return docker(["exec", "-i", wpContainerName, "php", "-r", phpScript], {
    stdin: stdinText,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

/** Spawns a long-running MariaDB client session in cliContainerName and waits for it in PROCESSLIST. */
async function openSleepSession(runSql, user, password, sql = "SELECT SLEEP(60);") {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      cliContainerName,
      "sh",
      "-c",
      'IFS= read -r p && MYSQL_PWD="$p" exec mariadb -h hp-mariadb -u "$1" --batch --raw --skip-column-names',
      "_",
      user,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  activeChildProcesses.add(child);

  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode = null;
  const waiters = new Set();

  const notify = () => {
    for (const w of waiters) w();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    stdout += c;
    notify();
  });
  child.stderr.on("data", (c) => {
    stderr += c;
    notify();
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
    activeChildProcesses.delete(child);
    notify();
  });
  child.once("error", (err) => {
    stderr += err.message;
    exited = true;
    exitCode = 1;
    activeChildProcesses.delete(child);
    notify();
  });

  child.stdin.write(`${password}\n${sql}\n`);
  child.stdin.end();

  for (let i = 0; i < 50; i += 1) {
    const pl = await runSql(
      `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${user}';`,
      { timeoutMs: 10_000 },
    );
    if (pl.exitCode === 0 && Number(pl.stdout.toString("utf8").trim()) >= 1) {
      break;
    }
    if (exited) {
      throw new Error(`Session for ${user} exited prematurely (${String(exitCode)}): ${stderr}`);
    }
    await sleep(100);
  }

  const plCheck = await runSql(
    `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${user}';`,
    { timeoutMs: 10_000 },
  );
  assert(
    Number(plCheck.stdout.toString("utf8").trim()) >= 1,
    `open session for ${user} visible in PROCESSLIST`,
    plCheck.stdout.toString("utf8").trim(),
  );

  return {
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get stderr() {
      return stderr;
    },
    waitForExit(timeoutMs = 5_000) {
      if (exited) {
        return Promise.resolve({ exited: true, exitCode, stdout, stderr });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          resolve({ exited: false, exitCode, stdout, stderr });
        }, timeoutMs);
        function check() {
          if (exited) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve({ exited: true, exitCode, stdout, stderr });
          }
        }
        waiters.add(check);
      });
    },
    close() {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
      activeChildProcesses.delete(child);
    },
  };
}

async function countUserSessions(runSql, user) {
  const pl = await runSql(
    `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE User = '${user}';`,
    { timeoutMs: 10_000 },
  );
  return Number(pl.stdout.toString("utf8").trim());
}

async function expectExecutorError(fn, expectedCode) {
  try {
    await fn();
  } catch (err) {
    assert(
      err instanceof ExecutorCodedError && err.code === expectedCode,
      `ExecutorCodedError(${expectedCode})`,
      err instanceof ExecutorCodedError ? `${err.code}: ${err.message}` : formatErr(err),
    );
    capturedErrorMessages.push(err.message);
    return err;
  }
  throw new StepAssertionError(`throws ${expectedCode}`, "resolved without error");
}

function pickFreeSubnet(existingNets) {
  const ipToInt = (ip) =>
    ip.split(".").reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);
  const parseCidr = (cidr) => {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr ?? "");
    if (!m) return null;
    const prefix = Number(m[2]);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const net = (ipToInt(m[1]) & mask) >>> 0;
    return { net, mask };
  };
  const usedRanges = (existingNets ?? [])
    .flatMap((n) => n?.IPAM?.Config ?? [])
    .map((c) => parseCidr(c?.Subnet))
    .filter(Boolean);

  for (let second = 240; second <= 254; second += 1) {
    for (let third = 200; third <= 254; third += 1) {
      const candidate = `10.${String(second)}.${String(third)}.0/24`;
      const c = parseCidr(candidate);
      const overlaps = usedRanges.some(
        (u) => ((c.net & u.mask) >>> 0) === u.net || ((u.net & c.mask) >>> 0) === c.net,
      );
      if (!overlaps) return candidate;
    }
  }
  return null;
}

let cleanupPromise = null;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of activeChildProcesses) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore already exited process
      }
    }
    activeChildProcesses.clear();

    const containers = new Set([
      ...createdContainers,
      wpContainerName,
      cliContainerName,
      dbContainerName,
    ]);
    for (const c of containers) {
      await docker(["rm", "-f", "-v", c]);
    }
    if (createdNetwork) {
      await docker(["network", "rm", networkName]);
    }
    for (const v of createdVolumes) {
      await docker(["volume", "rm", v]);
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
  const startedAt = performance.now();
  let passed = 0;
  let total = 0;
  let fatalSetupFailure = false;

  async function runStep(name, fn, { abortOnFail = false } = {}) {
    total += 1;
    try {
      await fn();
      passed += 1;
      logLine(`PASS ${name}`);
    } catch (err) {
      capturedErrorMessages.push(formatErr(err));
      if (err instanceof StepAssertionError) {
        logLine(`FAIL ${name}: ${err.expected} / ${err.actual}`);
      } else {
        logLine(`FAIL ${name}: step succeeds / ${formatErr(err)}`);
      }
      if (abortOnFail) {
        fatalSetupFailure = true;
      }
    }
  }

  let tmpRoot = "";
  let dataDir = "";
  let rootKeyFile = "";
  let wpPwFileA = "";
  let wpPwFileB = "";
  let wpPwA = "";
  let wpPwB = "";
  let adapter = null;
  let signOnRunner = null;
  let runSql = null;
  let initialDbInspect = null;

  let pwApp1 = "";
  let pwApp2 = "";
  let pwQu1 = "";
  let pwPma1 = "";
  let pwPma2 = "";

  const dbShop = siteDatabaseFullName(prefixA, "shop");
  const userApp = siteDatabaseFullName(prefixA, "app");

  // Runs the real db.provision job container for one site with the given password file.
  const runProvisionJob = async (label, siteId, prefix, pwFile, pw) => {
    const jobContainer = `${runId}_prov_${label}`;
    const jobPayload = buildSiteJobContainerPayload(
      {
        jobId: `job_accept_${label}_${runHex}`,
        kind: "db.provision",
        siteId,
        organizationId: `org_accept_${runHex}`,
        params: { dbName: prefix, dbUser: prefix },
        resolvedSecrets: { HP_DB_PASSWORD: pw },
      },
      {
        executorUser: uidGid,
        secretBinds: [`${pwFile}:/run/secrets/HP_DB_PASSWORD:ro`],
        secretFileEnv: [],
        rootKeyHostPath: rootKeyFile,
      },
    );
    assert(
      jobPayload.Cmd[2] === DB_PROVISION_SCRIPT,
      "uses real DB_PROVISION_SCRIPT",
      String(jobPayload.Cmd[2]),
    );
    assert(
      jobPayload.Env.includes(`HP_DB_NAME_ESCAPED=${prefix.replaceAll("_", "\\_")}`),
      "sets HP_DB_NAME_ESCAPED",
      JSON.stringify(jobPayload.Env),
    );

    const isolatedJobPayload = {
      ...jobPayload,
      HostConfig: { ...jobPayload.HostConfig, NetworkMode: networkName },
    };
    const created = await dockerJson(
      "POST",
      `/containers/create?name=${encodeURIComponent(jobContainer)}`,
      isolatedJobPayload,
    );
    createdContainers.add(jobContainer);
    await dockerJson("POST", `/containers/${encodeURIComponent(created.Id)}/start`, {});
    const waited = await dockerJson(
      "POST",
      `/containers/${encodeURIComponent(created.Id)}/wait`,
      {},
      [200],
      90_000,
    );
    assert(
      waited.StatusCode === 0,
      `db.provision (${label}) exits 0`,
      `exit=${String(waited.StatusCode)}`,
    );
    await docker(["rm", "-f", jobContainer]);
    createdContainers.delete(jobContainer);
  };

  try {
    // 1. Setup
    await runStep(
      "setup",
      async () => {
        const imgMaria = await docker(["image", "inspect", SHARED_MARIADB_IMAGE]);
        assert(imgMaria.ok, `${SHARED_MARIADB_IMAGE} present locally`, imgMaria.stderr);
        const imgWp = await docker(["image", "inspect", WORDPRESS_IMAGE]);
        assert(imgWp.ok, `${WORDPRESS_IMAGE} present locally`, imgWp.stderr);

        tmpRoot = await mkdtemp(path.join(os.tmpdir(), `${runId}_`));
        tempDirs.push(tmpRoot);
        await chmod(tmpRoot, 0o755);

        dataDir = path.join(tmpRoot, "mariadb-data");
        rootKeyFile = path.join(tmpRoot, "mariadb-root.key");
        wpPwFileA = path.join(tmpRoot, "wp-a.key");
        wpPwFileB = path.join(tmpRoot, "wp-b.key");
        const sftpStateDir = path.join(tmpRoot, "sftp");
        const secretsRootDir = path.join(tmpRoot, "secrets");
        const ingressRootDir = path.join(tmpRoot, "ingress");
        const siteFilesDir = path.join(tmpRoot, "site-files");

        for (const dir of [dataDir, sftpStateDir, secretsRootDir, ingressRootDir, siteFilesDir]) {
          await mkdir(dir, { mode: 0o700 });
        }

        const rootPw = randomBytes(32).toString("hex");
        wpPwA = randomBytes(32).toString("hex");
        wpPwB = randomBytes(32).toString("hex");
        secretsToGuard.add(rootPw);
        secretsToGuard.add(wpPwA);
        secretsToGuard.add(wpPwB);

        await writeFile(rootKeyFile, rootPw, { mode: 0o400 });
        await writeFile(wpPwFileA, wpPwA, { mode: 0o400 });
        await writeFile(wpPwFileB, wpPwB, { mode: 0o400 });

        const existingNets = await dockerJson("GET", "/networks");
        const chosenSubnet = pickFreeSubnet(existingNets);
        assert(chosenSubnet !== null, "free /24 subnet found", "none available");

        await dockerJson("POST", "/networks/create", {
          Name: networkName,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Driver: "default", Config: [{ Subnet: chosenSubnet }] },
        });
        createdNetwork = true;

        const basePayload = buildSharedDatabaseContainerPayload({
          image: SHARED_MARIADB_IMAGE,
          user: uidGid,
          dataDirHostPath: dataDir,
          rootKeyHostPath: rootKeyFile,
          adminSubnet: chosenSubnet,
        });
        const isolatedPayload = {
          ...basePayload,
          HostConfig: {
            ...basePayload.HostConfig,
            NetworkMode: networkName,
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [networkName]: { Aliases: [SHARED_DB_ALIAS] },
            },
          },
        };
        assert(
          !("PortBindings" in isolatedPayload.HostConfig) && !("ExposedPorts" in isolatedPayload),
          "no published or exposed ports on MariaDB payload",
          JSON.stringify(isolatedPayload.HostConfig),
        );

        await dockerJson(
          "POST",
          `/containers/create?name=${encodeURIComponent(dbContainerName)}`,
          isolatedPayload,
        );
        createdContainers.add(dbContainerName);
        await dockerJson("POST", `/containers/${encodeURIComponent(dbContainerName)}/start`, {});

        initialDbInspect = await dockerInspectContainer(dbContainerName);
        assert(
          initialDbInspect !== null && initialDbInspect.State?.Running === true,
          "throw-away MariaDB container running",
          JSON.stringify(initialDbInspect?.State ?? null),
        );

        adapter = new DockerEngineSocketAdapter({
          pullMissingImages: false,
          sharedDbContainerName: dbContainerName,
          sftpStateDir,
          secretsRootDir,
          ingressRootDir,
          siteFilesDir,
          sharedDbDataDir: dataDir,
          sharedDbRootKeyFile: rootKeyFile,
          executorUid: process.getuid(),
        });
        const rawSiteDatabases = adapter.siteDatabases.bind(adapter);
        adapter.siteDatabases = async (req) => {
          try {
            const res = await rawSiteDatabases(req);
            capturedResultJsons.push(JSON.stringify(res));
            return res;
          } catch (err) {
            capturedErrorMessages.push(formatErr(err));
            throw err;
          }
        };

        const execTarget = {
          request: dockerRequest,
          socketPath: SOCKET_PATH,
          apiPrefix: "",
        };
        runSql = mariadbRootExec(execTarget, dbContainerName);
        signOnRunner = new SiteDatabasesRunner({
          runSql,
          ensurePhpMyAdmin: async () => undefined,
        });
        const rawSignOnRun = signOnRunner.run.bind(signOnRunner);
        signOnRunner.run = async (req) => {
          try {
            const res = await rawSignOnRun(req);
            capturedResultJsons.push(JSON.stringify(res));
            return res;
          } catch (err) {
            capturedErrorMessages.push(formatErr(err));
            throw err;
          }
        };
      },
      { abortOnFail: true },
    );

    // 2. Readiness
    if (!fatalSetupFailure) {
      await runStep(
        "readiness",
        async () => {
          const deadline = Date.now() + 120_000;
          let readyRes = null;
          let lastErr = null;
          while (Date.now() < deadline) {
            try {
              readyRes = await adapter.siteDatabases({ siteId: siteA, op: "list" });
              break;
            } catch (err) {
              lastErr = err;
              if (!(err instanceof ExecutorCodedError && err.code === "DOCKER_ENGINE_UNAVAILABLE")) {
                throw err;
              }
              await sleep(500);
            }
          }
          assert(
            readyRes !== null,
            "adapter.siteDatabases list succeeds within 120s",
            lastErr ? formatErr(lastErr) : "timed out",
          );
          assert(
            readyRes.databases.length === 0 && readyRes.users.length === 0,
            "initial list empty",
            JSON.stringify(readyRes),
          );

          // Start hardened client containers on the isolated network for steps 3–12.
          const cliRun = await docker([
            "run",
            "-d",
            "--name",
            cliContainerName,
            "--network",
            networkName,
            "--user",
            uidGid,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "sleep",
            SHARED_MARIADB_IMAGE,
            "600",
          ]);
          assert(cliRun.ok, "client container starts", cliRun.stderr);
          createdContainers.add(cliContainerName);

          const wpRun = await docker([
            "run",
            "-d",
            "--name",
            wpContainerName,
            "--network",
            networkName,
            "--user",
            "33:33",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "sleep",
            WORDPRESS_IMAGE,
            "600",
          ]);
          assert(wpRun.ok, "wordpress php client container starts", wpRun.stderr);
          createdContainers.add(wpContainerName);
        },
        { abortOnFail: true },
      );
    }

    // 3. The sites' own databases + R30 check
    if (!fatalSetupFailure) {
      await runStep(
        "provision-own-databases",
        async () => {
          await runProvisionJob("a", siteA, prefixA, wpPwFileA, wpPwA);
          await runProvisionJob("b", siteB, prefixB, wpPwFileB, wpPwB);

          const listA = await adapter.siteDatabases({ siteId: siteA, op: "list" });
          const listB = await adapter.siteDatabases({ siteId: siteB, op: "list" });
          assert(
            listA.databases.length === 1 &&
              listA.databases[0].name === prefixA &&
              listA.databases[0].primary === true &&
              listA.users.length === 1 &&
              listA.users[0].name === prefixA &&
              listA.users[0].primary === true &&
              JSON.stringify(listA.users[0].databases) === JSON.stringify([prefixA]),
            "site A list shows primary db & user",
            JSON.stringify(listA),
          );
          assert(
            listB.databases.length === 1 &&
              listB.databases[0].name === prefixB &&
              listB.databases[0].primary === true &&
              listB.users.length === 1 &&
              listB.users[0].name === prefixB &&
              listB.users[0].primary === true &&
              JSON.stringify(listB.users[0].databases) === JSON.stringify([prefixB]),
            "site B list shows primary db & user",
            JSON.stringify(listB),
          );

          // R30(a): WordPress user of site A can create a table, write and read in its own database.
          const ownCrud = await execClientSql(
            prefixA,
            wpPwA,
            `USE \`${prefixA}\`; CREATE TABLE wp_r30 (id INT PRIMARY KEY, v VARCHAR(16)); INSERT INTO wp_r30 VALUES (1, 'ok_r30'); SELECT v FROM wp_r30; DROP TABLE wp_r30;`,
          );
          assert(
            ownCrud.ok && ownCrud.stdout.trim() === "ok_r30",
            "WP user A CRUD in own DB succeeds",
            `${ownCrud.stdout.trim()} ${ownCrud.stderr.trim()}`.trim(),
          );

          // R30(b): WordPress user of site A cannot create a database named like its own with '_' replaced.
          const wildcardDb = prefixA.replace("_", "x");
          const wildcardRes = await execClientSql(
            prefixA,
            wpPwA,
            `CREATE DATABASE \`${wildcardDb}\`;`,
          );
          assert(
            !wildcardRes.ok && wildcardRes.stderr.includes("1044"),
            `wildcard CREATE DATABASE ${wildcardDb} fails with 1044`,
            `${wildcardRes.stdout.trim()} ${wildcardRes.stderr.trim()}`.trim(),
          );

          // R30(c): WordPress user of site A cannot see or use site B's database.
          const showA = await execClientSql(prefixA, wpPwA, "SHOW DATABASES;");
          assert(showA.ok, "WP user A SHOW DATABASES succeeds", showA.stderr);
          const visibleA = showA.stdout.trim().split(/\r?\n/);
          assert(
            !visibleA.includes(prefixB),
            `WP user A does not see ${prefixB}`,
            JSON.stringify(visibleA),
          );
          const useB = await execClientSql(prefixA, wpPwA, `USE \`${prefixB}\`;`);
          assert(
            !useB.ok && useB.stderr.includes("1044"),
            `WP user A USE ${prefixB} fails with 1044`,
            useB.stderr.trim(),
          );
        },
        { abortOnFail: true },
      );
    }

    if (!fatalSetupFailure) {
      // 4. Lifecycle per site
      await runStep("lifecycle-per-site", async () => {
        await adapter.siteDatabases({ siteId: siteA, op: "createDatabase", database: dbShop });
        pwApp1 = randomPassword24();
        await adapter.siteDatabases({
          siteId: siteA,
          op: "createUser",
          user: userApp,
          passwordHash: trackHash(pwApp1),
        });
        await adapter.siteDatabases({
          siteId: siteA,
          op: "grant",
          user: userApp,
          database: dbShop,
        });

        const listRes = await adapter.siteDatabases({ siteId: siteA, op: "list" });
        const dbNames = listRes.databases.map((d) => ({ name: d.name, primary: d.primary }));
        assert(
          JSON.stringify(dbNames) ===
            JSON.stringify([
              { name: prefixA, primary: true },
              { name: dbShop, primary: false },
            ]),
          `databases=[${prefixA}(primary), ${dbShop}]`,
          JSON.stringify(listRes.databases),
        );
        assert(
          JSON.stringify(listRes.users) ===
            JSON.stringify([
              { name: prefixA, primary: true, databases: [prefixA] },
              { name: userApp, primary: false, databases: [dbShop] },
            ]),
          `users=[${prefixA}(primary,[${prefixA}]), ${userApp}([${dbShop}])]`,
          JSON.stringify(listRes.users),
        );
      });

      // 5. Isolation (mariadb CLI + PHP mysqli + wildcard decoy)
      await runStep("isolation", async () => {
        const showRes = await execClientSql(userApp, pwApp1, "SHOW DATABASES;");
        assert(showRes.ok, "P_app SHOW DATABASES succeeds", showRes.stderr);
        const visible = showRes.stdout.trim().split(/\r?\n/).sort();
        assert(
          JSON.stringify(visible) === JSON.stringify(["information_schema", dbShop].sort()),
          `P_app sees only ${dbShop} and information_schema`,
          JSON.stringify(visible),
        );

        const useB = await execClientSql(userApp, pwApp1, `USE \`${prefixB}\`;`);
        assert(!useB.ok && useB.stderr.includes("1044"), "P_app USE site B -> 1044", useB.stderr);

        const createOther = await execClientSql(
          userApp,
          pwApp1,
          `CREATE DATABASE \`${prefixA}_other\`;`,
        );
        assert(
          !createOther.ok && createOther.stderr.includes("1044"),
          "P_app CREATE DATABASE P_other -> 1044",
          createOther.stderr,
        );

        // PHP mysqli check inside WordPress container
        const phpCheck = `
          $lines = explode("\\n", rtrim(stream_get_contents(STDIN), "\\r\\n"));
          [$pw, $user, $dbA, $dbB] = $lines;
          mysqli_report(MYSQLI_REPORT_OFF);
          $c = mysqli_connect("hp-mariadb", $user, $pw, $dbA);
          if (!$c) { fwrite(STDERR, "connect:" . mysqli_connect_errno() . ":" . mysqli_connect_error()); exit(2); }
          if (!$c->query("CREATE TABLE wp_iso (id INT PRIMARY KEY, v VARCHAR(16))")) { exit(3); }
          if (!$c->query("INSERT INTO wp_iso VALUES (1, 'php_ok')")) { exit(4); }
          $r = $c->query("SELECT v FROM wp_iso");
          $row = $r ? $r->fetch_row() : null;
          $c->query("DROP TABLE wp_iso");
          $okB = $c->select_db($dbB);
          $errB = $c->errno;
          echo json_encode(["val" => $row[0] ?? null, "okB" => $okB, "errB" => $errB]);
        `;
        const wpRes = await execWpPhp(phpCheck, `${pwApp1}\n${userApp}\n${dbShop}\n${prefixB}\n`);
        assert(wpRes.ok, "PHP mysqli isolation check executes", wpRes.stderr);
        const wpJson = JSON.parse(wpRes.stdout.trim());
        assert(
          wpJson.val === "php_ok" && wpJson.okB === false && wpJson.errB === 1044,
          "PHP mysqli reads own DB and gets 1044 on site B",
          JSON.stringify(wpJson),
        );

        // Root creates wildcard decoy wpX<hexA>_shop; A's user cannot use it; then drop decoy.
        const decoyDb = `wpX${hexA}_shop`;
        const decoyCreate = await runSql(`CREATE DATABASE \`${decoyDb}\`;`, { timeoutMs: 10_000 });
        assert(decoyCreate.exitCode === 0, "root creates wildcard decoy", decoyCreate.stderr.toString("utf8"));
        try {
          const useDecoy = await execClientSql(userApp, pwApp1, `USE \`${decoyDb}\`;`);
          assert(
            !useDecoy.ok && useDecoy.stderr.includes("1044"),
            `P_app USE wildcard decoy ${decoyDb} -> 1044`,
            useDecoy.stderr,
          );
          const showAfterDecoy = await execClientSql(userApp, pwApp1, "SHOW DATABASES;");
          assert(
            !showAfterDecoy.stdout.split(/\r?\n/).includes(decoyDb),
            "P_app SHOW DATABASES hides decoy",
            showAfterDecoy.stdout,
          );
        } finally {
          await runSql(`DROP DATABASE IF EXISTS \`${decoyDb}\`;`, { timeoutMs: 10_000 });
        }
      });

      // 6. Password rotation kills open session
      await runStep("password-rotation", async () => {
        const sess = await openSleepSession(runSql, userApp, pwApp1, "SELECT SLEEP(60);");
        try {
          pwApp2 = randomPassword24();
          await adapter.siteDatabases({
            siteId: siteA,
            op: "setUserPassword",
            user: userApp,
            passwordHash: trackHash(pwApp2),
          });
          const exited = await sess.waitForExit(5_000);
          assert(
            exited.exited && exited.exitCode !== 0,
            "open session killed by setUserPassword",
            JSON.stringify(exited),
          );
          assert(
            (await countUserSessions(runSql, userApp)) === 0,
            "0 sessions remain in PROCESSLIST",
            "non-zero",
          );

          const oldLogin = await execClientSql(userApp, pwApp1, "SELECT 1;");
          assert(
            !oldLogin.ok && oldLogin.stderr.includes("1045"),
            "old password rejected with 1045",
            oldLogin.stderr,
          );
          const newLogin = await execClientSql(userApp, pwApp2, "SELECT 1;");
          assert(
            newLogin.ok && newLogin.stdout.trim() === "1",
            "new password succeeds",
            `${newLogin.stdout} ${newLogin.stderr}`,
          );
        } finally {
          sess.close();
        }
      });

      // 7. Revoke kills open session and removes access; second revoke -> {}
      await runStep("revoke", async () => {
        const loopSql = Array.from({ length: 60 }, () => `USE \`${dbShop}\`; SELECT SLEEP(1);`).join(
          "\n",
        );
        const sess = await openSleepSession(runSql, userApp, pwApp2, loopSql);
        try {
          await adapter.siteDatabases({
            siteId: siteA,
            op: "revoke",
            user: userApp,
            database: dbShop,
          });
          const exited = await sess.waitForExit(5_000);
          assert(
            exited.exited && exited.exitCode !== 0,
            "open USE loop session killed by revoke",
            JSON.stringify(exited),
          );
          assert(
            (await countUserSessions(runSql, userApp)) === 0,
            "0 sessions remain after revoke",
            "non-zero",
          );

          const newUse = await execClientSql(userApp, pwApp2, `USE \`${dbShop}\`;`);
          assert(
            !newUse.ok && newUse.stderr.includes("1044"),
            "new login cannot USE revoked DB (1044)",
            newUse.stderr,
          );

          const secondRevoke = await adapter.siteDatabases({
            siteId: siteA,
            op: "revoke",
            user: userApp,
            database: dbShop,
          });
          assert(
            Object.keys(secondRevoke).length === 0,
            "second revoke returns {}",
            JSON.stringify(secondRevoke),
          );
        } finally {
          sess.close();
        }
      });

      // 8. Dropping via customer SQL leaves stale mysql.db grant, and createDatabase revokes it (D16.2)
      await runStep("delete-and-recreate", async () => {
        await adapter.siteDatabases({
          siteId: siteA,
          op: "grant",
          user: userApp,
          database: dbShop,
        });
        const beforeDel = await execClientSql(userApp, pwApp2, `USE \`${dbShop}\`; SELECT 1;`);
        assert(beforeDel.ok, "user can USE db before SQL DROP DATABASE", beforeDel.stderr);

        const sqlDrop = await execClientSql(userApp, pwApp2, `DROP DATABASE \`${dbShop}\`;`);
        assert(sqlDrop.ok, "user can drop own granted DB via SQL DROP DATABASE", sqlDrop.stderr);

        const dbEsc = dbShop.replaceAll("_", "\\_");
        const staleRows = await runSql(
          `SELECT COUNT(*) FROM mysql.db WHERE User = '${userApp}' AND Db = '${dbEsc}';`,
          { timeoutMs: 10_000 },
        );
        assert(staleRows.exitCode === 0, "stale grant query succeeds", staleRows.stderr.toString("utf8"));
        assert(
          Number(staleRows.stdout.toString("utf8").trim()) === 1,
          "stale grant row remains in mysql.db after SQL DROP DATABASE",
          staleRows.stdout.toString("utf8").trim(),
        );

        await adapter.siteDatabases({ siteId: siteA, op: "createDatabase", database: dbShop });

        const afterRecreate = await execClientSql(userApp, pwApp2, `USE \`${dbShop}\`;`);
        assert(
          !afterRecreate.ok && afterRecreate.stderr.includes("1044"),
          "recreated database has no stale grant (1044)",
          afterRecreate.stderr,
        );

        const remainingRows = await runSql(
          `SELECT COUNT(*) FROM mysql.db WHERE Db = '${dbEsc}';`,
          { timeoutMs: 10_000 },
        );
        assert(
          remainingRows.exitCode === 0,
          "post-recreate grant query succeeds",
          remainingRows.stderr.toString("utf8"),
        );
        assert(
          Number(remainingRows.stdout.toString("utf8").trim()) === 0,
          "zero old grant rows left in mysql.db after createDatabase",
          remainingRows.stdout.toString("utf8").trim(),
        );
      });

      // 9. deleteUser kills open session and refuses login (1045)
      await runStep("delete-user", async () => {
        const sess = await openSleepSession(runSql, userApp, pwApp2, "SELECT SLEEP(60);");
        try {
          await adapter.siteDatabases({ siteId: siteA, op: "deleteUser", user: userApp });
          const exited = await sess.waitForExit(5_000);
          assert(
            exited.exited && exited.exitCode !== 0,
            "open session killed by deleteUser",
            JSON.stringify(exited),
          );
          assert(
            (await countUserSessions(runSql, userApp)) === 0,
            "0 sessions remain after deleteUser",
            "non-zero",
          );
          const loginRes = await execClientSql(userApp, pwApp2, "SELECT 1;");
          assert(
            !loginRes.ok && loginRes.stderr.includes("1045"),
            "deleted user login rejected with 1045",
            loginRes.stderr,
          );
        } finally {
          sess.close();
        }
      });

      // 10. Quota (10 custom databases, 10 custom users, primary not counted) + root-created DB ALREADY_EXISTS
      await runStep("quota", async () => {
        // dbShop already exists (1 custom DB). Create 9 more -> total 10 custom DBs.
        for (let i = 2; i <= SITE_DATABASES_MAX; i += 1) {
          await adapter.siteDatabases({
            siteId: siteA,
            op: "createDatabase",
            database: siteDatabaseFullName(prefixA, `qdb${String(i)}`),
          });
        }
        await expectExecutorError(
          () =>
            adapter.siteDatabases({
              siteId: siteA,
              op: "createDatabase",
              database: siteDatabaseFullName(prefixA, "qdb11"),
            }),
          "QUOTA_EXCEEDED",
        );

        // Create 10 custom users -> 11th fails QUOTA_EXCEEDED.
        for (let i = 1; i <= SITE_DATABASE_USERS_MAX; i += 1) {
          const pw = randomPassword24();
          if (i === 1) {
            pwQu1 = pw;
          }
          await adapter.siteDatabases({
            siteId: siteA,
            op: "createUser",
            user: siteDatabaseFullName(prefixA, `qu${String(i)}`),
            passwordHash: trackHash(pw),
          });
        }
        const pwOver = randomPassword24();
        await expectExecutorError(
          () =>
            adapter.siteDatabases({
              siteId: siteA,
              op: "createUser",
              user: siteDatabaseFullName(prefixA, "qu11"),
              passwordHash: trackHash(pwOver),
            }),
          "QUOTA_EXCEEDED",
        );

        // Free one slot, create DB directly as root, then createDatabase -> ALREADY_EXISTS.
        const rootDb = siteDatabaseFullName(prefixA, "qdb10");
        await adapter.siteDatabases({ siteId: siteA, op: "deleteDatabase", database: rootDb });
        const rootCreate = await runSql(`CREATE DATABASE \`${rootDb}\`;`, { timeoutMs: 10_000 });
        assert(rootCreate.exitCode === 0, "root creates DB directly", rootCreate.stderr.toString("utf8"));
        await expectExecutorError(
          () => adapter.siteDatabases({ siteId: siteA, op: "createDatabase", database: rootDb }),
          "ALREADY_EXISTS",
        );
      });

      // 11. Injection over IPC-equivalent input
      await runStep("injection-refusal", async () => {
        const snapBefore = await runSql(
          "SHOW DATABASES; SELECT User FROM mysql.user ORDER BY User;",
          { timeoutMs: 10_000 },
        );
        assert(snapBefore.exitCode === 0, "snapshot before succeeds", snapBefore.stderr.toString("utf8"));

        const hostileReqs = [
          {
            req: { siteId: siteA, op: "createDatabase", database: `${prefixA}_bad'quote` },
            code: "VALIDATION_ERROR",
          },
          {
            req: { siteId: siteA, op: "createDatabase", database: `${prefixA}_bad\`tick` },
            code: "VALIDATION_ERROR",
          },
          {
            req: { siteId: siteA, op: "createDatabase", database: `${prefixA}_bad;semi` },
            code: "VALIDATION_ERROR",
          },
          {
            req: {
              siteId: siteA,
              op: "createUser",
              user: `${prefixA}_bad\\slash`,
              passwordHash: trackHash(randomPassword24()),
            },
            code: "VALIDATION_ERROR",
          },
          {
            req: { siteId: siteA, op: "createDatabase", database: `${prefixB}_foreign` },
            code: "NOT_FOUND",
          },
        ];

        for (const item of hostileReqs) {
          await expectExecutorError(() => adapter.siteDatabases(item.req), item.code);
        }

        const snapAfter = await runSql(
          "SHOW DATABASES; SELECT User FROM mysql.user ORDER BY User;",
          { timeoutMs: 10_000 },
        );
        assert(
          snapAfter.stdout.equals(snapBefore.stdout),
          "MariaDB databases and users unchanged after hostile inputs",
          "changed",
        );
      });

      // 12. Sign-on SQL half (via SiteDatabasesRunner with no-op ensurePhpMyAdmin)
      await runStep("signon-sql", async () => {
        pwPma1 = randomPassword24();
        const signOn1 = await signOnRunner.run({
          siteId: siteA,
          op: "phpMyAdminSignOn",
          passwordHash: trackHash(pwPma1),
        });
        assert(
          signOn1.username === signOnUserA,
          `signOn username=${signOnUserA}`,
          JSON.stringify(signOn1),
        );

        const listA = await adapter.siteDatabases({ siteId: siteA, op: "list" });
        const expectedSiteADbs = listA.databases.map((d) => d.name).sort();

        const showPma1 = await execClientSql(signOnUserA, pwPma1, "SHOW DATABASES;");
        assert(showPma1.ok, "pma SHOW DATABASES succeeds", showPma1.stderr);
        const visiblePma1 = showPma1.stdout
          .trim()
          .split(/\r?\n/)
          .filter((d) => d !== "information_schema")
          .sort();
        assert(
          JSON.stringify(visiblePma1) === JSON.stringify(expectedSiteADbs),
          "pma sees exact site A databases only",
          JSON.stringify({ visiblePma1, expectedSiteADbs }),
        );

        // Free one DB slot if at 10 so we can test createDatabase -> visible, deleteDatabase -> gone.
        await adapter.siteDatabases({
          siteId: siteA,
          op: "deleteDatabase",
          database: siteDatabaseFullName(prefixA, "qdb10"),
        });
        const pmaNewDb = siteDatabaseFullName(prefixA, "pmanew");
        await adapter.siteDatabases({ siteId: siteA, op: "createDatabase", database: pmaNewDb });

        const showAfterCreate = await execClientSql(signOnUserA, pwPma1, "SHOW DATABASES;");
        assert(
          showAfterCreate.stdout.trim().split(/\r?\n/).includes(pmaNewDb),
          `pma sees newly created ${pmaNewDb}`,
          showAfterCreate.stdout,
        );

        await adapter.siteDatabases({ siteId: siteA, op: "deleteDatabase", database: pmaNewDb });
        const showAfterDelete = await execClientSql(signOnUserA, pwPma1, "SHOW DATABASES;");
        assert(
          !showAfterDelete.stdout.trim().split(/\r?\n/).includes(pmaNewDb),
          `pma no longer sees deleted ${pmaNewDb}`,
          showAfterDelete.stdout,
        );
        const grantRows = await runSql(
          `SELECT COUNT(*) FROM mysql.db WHERE User = '${signOnUserA}' AND Db = '${pmaNewDb.replaceAll("_", "\\_")}';`,
          { timeoutMs: 10_000 },
        );
        assert(
          Number(grantRows.stdout.toString("utf8").trim()) === 0,
          "deleted DB grant row removed from mysql.db",
          grantRows.stdout.toString("utf8").trim(),
        );

        // Second sign-on kills old session and invalidates old password.
        const sessPma = await openSleepSession(runSql, signOnUserA, pwPma1, "SELECT SLEEP(60);");
        try {
          pwPma2 = randomPassword24();
          await signOnRunner.run({
            siteId: siteA,
            op: "phpMyAdminSignOn",
            passwordHash: trackHash(pwPma2),
          });
          const exited = await sessPma.waitForExit(5_000);
          assert(
            exited.exited && exited.exitCode !== 0,
            "second signOn killed old pma session",
            JSON.stringify(exited),
          );
          const oldLogin = await execClientSql(signOnUserA, pwPma1, "SELECT 1;");
          assert(
            !oldLogin.ok && oldLogin.stderr.includes("1045"),
            "old signOn password rejected with 1045",
            oldLogin.stderr,
          );
          const newLogin = await execClientSql(signOnUserA, pwPma2, "SELECT 1;");
          assert(newLogin.ok && newLogin.stdout.trim() === "1", "new signOn password works", newLogin.stderr);

          const showGrants = await execClientSql(
            signOnUserA,
            pwPma2,
            "SHOW GRANTS FOR CURRENT_USER();",
          );
          assert(showGrants.ok, "SHOW GRANTS succeeds", showGrants.stderr);
          assert(
            !/GRANT OPTION/i.test(showGrants.stdout),
            "SHOW GRANTS has no GRANT OPTION",
            showGrants.stdout,
          );
        } finally {
          sessPma.close();
        }
      });

      // 13. Per-site MariaDB connection budget (R40)
      await runStep("connection-budget", async () => {
        const extraQu1 = siteDatabaseFullName(prefixA, "qu1");
        const capsRes = await runSql(
          `SELECT User, max_user_connections FROM mysql.user WHERE Host = '%' AND User IN ('${prefixA}', '${extraQu1}', '${signOnUserA}') ORDER BY User;`,
          { timeoutMs: 10_000 },
        );
        assert(capsRes.exitCode === 0, "mysql.user cap query succeeds", capsRes.stderr.toString("utf8"));

        const caps = new Map(
          capsRes.stdout
            .toString("utf8")
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const [u, maxConn] = line.split("\t");
              return [u, Number(maxConn)];
            }),
        );
        assert(
          caps.get(prefixA) === MARIADB_OWN_MAX_USER_CONNECTIONS,
          `own user max_user_connections=${String(MARIADB_OWN_MAX_USER_CONNECTIONS)}`,
          JSON.stringify(Object.fromEntries(caps)),
        );
        assert(
          caps.get(extraQu1) === MARIADB_EXTRA_MAX_USER_CONNECTIONS,
          `extra user max_user_connections=${String(MARIADB_EXTRA_MAX_USER_CONNECTIONS)}`,
          JSON.stringify(Object.fromEntries(caps)),
        );
        assert(
          caps.get(signOnUserA) === MARIADB_SIGNON_MAX_USER_CONNECTIONS,
          `sign-on user max_user_connections=${String(MARIADB_SIGNON_MAX_USER_CONNECTIONS)}`,
          JSON.stringify(Object.fromEntries(caps)),
        );
        assert(
          MARIADB_OWN_MAX_USER_CONNECTIONS +
            SITE_DATABASE_USERS_MAX * MARIADB_EXTRA_MAX_USER_CONNECTIONS +
            MARIADB_SIGNON_MAX_USER_CONNECTIONS <=
            100,
          "site budget <= 100",
          "exceeded",
        );

        const sessions = [];
        try {
          for (let i = 0; i < MARIADB_EXTRA_MAX_USER_CONNECTIONS; i += 1) {
            sessions.push(await openSleepSession(runSql, extraQu1, pwQu1, "SELECT SLEEP(60);"));
          }
          let active = 0;
          for (let i = 0; i < 50; i += 1) {
            active = await countUserSessions(runSql, extraQu1);
            if (active >= MARIADB_EXTRA_MAX_USER_CONNECTIONS) break;
            await sleep(100);
          }
          assert(
            active === MARIADB_EXTRA_MAX_USER_CONNECTIONS,
            `${String(MARIADB_EXTRA_MAX_USER_CONNECTIONS)} concurrent sessions active`,
            String(active),
          );

          const sixth = await execClientSql(extraQu1, pwQu1, "SELECT 1;");
          assert(
            !sixth.ok && sixth.stderr.includes("1226"),
            "6th concurrent connection of extra user refused with 1226",
            sixth.stderr,
          );
        } finally {
          await runSql(`KILL USER '${extraQu1}'@'%';`, { timeoutMs: 5_000 }).catch(() => undefined);
          for (const s of sessions) {
            s.close();
          }
        }
      });

      // 14. dropAll A
      await runStep("drop-all", async () => {
        const listBBefore = await adapter.siteDatabases({ siteId: siteB, op: "list" });

        const dropRes1 = await adapter.siteDatabases({ siteId: siteA, op: "dropAll" });
        assert(Object.keys(dropRes1).length === 0, "first dropAll returns {}", JSON.stringify(dropRes1));

        const leftover = await runSql(
          [
            `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${prefixA}' OR SCHEMA_NAME LIKE '${prefixA.replaceAll("_", "\\_")}\\_%';`,
            `SELECT COUNT(*) FROM mysql.user WHERE User = '${prefixA}' OR User LIKE '${prefixA.replaceAll("_", "\\_")}\\_%' OR User = '${signOnUserA}';`,
            `SELECT COUNT(*) FROM mysql.db WHERE Db = '${prefixA.replaceAll("_", "\\_")}' OR Db LIKE '${prefixA.replaceAll("_", "\\_")}\\_%' OR User = '${prefixA}' OR User LIKE '${prefixA.replaceAll("_", "\\_")}\\_%' OR User = '${signOnUserA}';`,
          ].join("\n"),
          { timeoutMs: 10_000 },
        );
        assert(leftover.exitCode === 0, "leftover query succeeds", leftover.stderr.toString("utf8"));
        const counts = leftover.stdout.toString("utf8").trim().split(/\r?\n/).map(Number);
        assert(
          counts[0] === 0 && counts[1] === 0 && counts[2] === 0,
          "0 SCHEMATA/user/db rows remain for site A",
          JSON.stringify(counts),
        );

        const listBAfter = await adapter.siteDatabases({ siteId: siteB, op: "list" });
        assert(
          JSON.stringify(listBAfter) === JSON.stringify(listBBefore),
          "site B list unchanged after site A dropAll",
          JSON.stringify({ listBBefore, listBAfter }),
        );

        const dropRes2 = await adapter.siteDatabases({ siteId: siteA, op: "dropAll" });
        assert(Object.keys(dropRes2).length === 0, "second dropAll returns {}", JSON.stringify(dropRes2));

        const dropNeverUsed = await adapter.siteDatabases({
          siteId: `site_never_${runHex}`,
          op: "dropAll",
        });
        assert(
          Object.keys(dropNeverUsed).length === 0,
          "dropAll on never-used site returns {}",
          JSON.stringify(dropNeverUsed),
        );
      });

      // 14a. C1: the owner-change statements give the site account a new password and cut its sessions
      await runStep("owner-change-new-password", async () => {
        const oldSession = await openSleepSession(runSql, prefixB, wpPwB);
        const newPw = randomBytes(32).toString("hex");
        secretsToGuard.add(newPw);
        const newPwFile = path.join(tmpRoot, "wp-b-moved.key");
        await writeFile(newPwFile, newPw, { mode: 0o400 });
        await runProvisionJob("b_moved", siteB, prefixB, newPwFile, newPw);

        const gone = await oldSession.waitForExit(10_000);
        oldSession.close();
        assert(gone.exited, "session opened with the old password is gone", "still open");
        assert(
          (await countUserSessions(runSql, prefixB)) === 0,
          "no session of the site account left",
          String(await countUserSessions(runSql, prefixB)),
        );
        const oldRes = await execClientSql(prefixB, wpPwB, "SELECT 1;");
        assert(!oldRes.ok, "old password refused", `ok=${String(oldRes.ok)}`);
        const newRes = await execClientSql(prefixB, newPw, `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${prefixB}';`);
        assert(newRes.ok && newRes.stdout.trim() === "1", "new password works and reaches the site database", newRes.stderr);
      });

      // 14b. H4: an account and grant made by hand the 0.5.0 way get the cap and the escaped grant
      await runStep("upgrade-old-accounts", async () => {
        const siteC = `site_accept_c_${runHex}`;
        const prefixC = siteDatabasePrefix(siteC);
        const lookalike = prefixC.replace("_", "x");
        const otherUser = `other_${runHex}`;
        const pwC = randomBytes(32).toString("hex");
        const pwOther = randomBytes(32).toString("hex");
        secretsToGuard.add(pwC);
        secretsToGuard.add(pwOther);
        const made = await runSql(
          [
            `CREATE DATABASE \`${prefixC}\`;`,
            `CREATE DATABASE \`${lookalike}\`;`,
            `CREATE USER '${prefixC}'@'%' IDENTIFIED BY '${pwC}';`,
            `GRANT ALL PRIVILEGES ON \`${prefixC}\`.* TO '${prefixC}'@'%';`,
            `CREATE USER '${otherUser}'@'%' IDENTIFIED BY '${pwOther}';`,
            `GRANT ALL PRIVILEGES ON \`${prefixC}\`.* TO '${otherUser}'@'%';`,
            "",
          ].join("\n"),
          { timeoutMs: 15_000 },
        );
        assert(made.exitCode === 0, "0.5.0-style account created", made.stderr.toString("utf8"));
        const before = await execClientSql(prefixC, pwC, `USE \`${lookalike}\`;`);
        assert(before.ok, "the unescaped grant reaches the look-alike database before the pass", before.stderr);

        const state = async () => {
          const res = await runSql(
            `SELECT User, max_user_connections FROM mysql.user WHERE User IN ('${prefixC}', '${otherUser}') ORDER BY User;\n` +
              `SELECT User, Db FROM mysql.db WHERE User IN ('${prefixC}', '${otherUser}') ORDER BY User, Db;\n`,
            { timeoutMs: 10_000 },
          );
          assert(res.exitCode === 0, "state query succeeds", res.stderr.toString("utf8"));
          return res.stdout.toString("utf8").trim();
        };
        const otherBefore = (await state()).split("\n").filter((l) => l.startsWith(otherUser));

        const first = await adapter.upgradeDatabaseAccounts();
        assert(first.capped === 1 && first.regranted === 1, "first pass caps 1 and re-grants 1", JSON.stringify(first));
        const after = await state();
        const escaped = prefixC.replaceAll("_", "\\_");
        assert(after.includes(`${prefixC}\t40`), "site account capped at 40", after);
        assert(
          after.split("\n").filter((l) => l.startsWith(`${prefixC}\t`)).includes(`${prefixC}\t${escaped}`) &&
            !after.split("\n").includes(`${prefixC}\t${prefixC}`),
          "only the escaped grant is left",
          after,
        );
        const otherAfter = after.split("\n").filter((l) => l.startsWith(otherUser));
        assert(JSON.stringify(otherAfter) === JSON.stringify(otherBefore), "non-site account untouched", JSON.stringify({ otherBefore, otherAfter }));

        const rw = await execClientSql(
          prefixC,
          pwC,
          `CREATE TABLE \`${prefixC}\`.t (i INT); INSERT INTO \`${prefixC}\`.t VALUES (7); SELECT i FROM \`${prefixC}\`.t;`,
        );
        assert(rw.ok && rw.stdout.trim() === "7", "account still reads and writes its database", rw.stderr);
        const lookalikeAfter = await execClientSql(prefixC, pwC, `USE \`${lookalike}\`;`);
        assert(!lookalikeAfter.ok, "account no longer reaches the look-alike database", `ok=${String(lookalikeAfter.ok)}`);

        const second = await adapter.upgradeDatabaseAccounts();
        assert(second.capped === 0 && second.regranted === 0, "second pass changes nothing", JSON.stringify(second));
        assert((await state()) === after, "state unchanged by the second pass", await state());
      });

      // 15. The server was never restarted
      await runStep("server-never-restarted", async () => {
        const current = await dockerInspectContainer(dbContainerName);
        assert(current !== null, "MariaDB container still present", "missing");
        assert(
          current.State?.Running === true,
          "MariaDB container still running",
          String(current.State?.Running),
        );
        assert(
          current.RestartCount === 0,
          "RestartCount=0",
          String(current.RestartCount),
        );
        assert(
          current.State?.StartedAt === initialDbInspect.State?.StartedAt,
          `StartedAt unchanged (${String(initialDbInspect.State?.StartedAt)})`,
          String(current.State?.StartedAt),
        );
      });

      // 16. No secrets in adapter/runner JSON results, caught errors, or output
      await runStep("no-secrets-in-output", async () => {
        assert(
          capturedResultJsons.length > 0 && capturedErrorMessages.length > 0,
          "captured result JSONs and error messages non-empty",
          JSON.stringify({
            results: capturedResultJsons.length,
            errors: capturedErrorMessages.length,
          }),
        );
        const corpus = [
          ...capturedResultJsons,
          ...capturedErrorMessages,
          ...capturedOutputLines,
        ].join("\n");
        for (const secret of secretsToGuard) {
          assert(
            !corpus.includes(secret),
            "generated password/hash absent from result JSONs, errors, and output",
            `leaked secret of length ${String(secret.length)}`,
          );
        }
      });
    }

    // 17. Cleanup by exact names and verify empty
    await runStep("cleanup", async () => {
      await cleanup();
      const ps = await docker(["ps", "-a", "-q", "--filter", `name=${runId}`]);
      const vols = await docker(["volume", "ls", "-q", "--filter", `name=${runId}`]);
      const nets = await docker(["network", "ls", "-q", "--filter", `name=${runId}`]);
      assert(ps.ok && ps.stdout.trim() === "", "no containers left", ps.stdout.trim());
      assert(vols.ok && vols.stdout.trim() === "", "no volumes left", vols.stdout.trim());
      assert(nets.ok && nets.stdout.trim() === "", "no networks left", nets.stdout.trim());
    });
  } finally {
    await cleanup();
  }

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`accept-m2-databases: ${String(passed)}/${String(total)} passed in ${elapsedSec}s`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`FAIL fatal: ${formatErr(err)}`);
  await cleanup();
  process.exit(1);
});
