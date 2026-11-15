#!/usr/bin/env node
/**
 * Real-Docker acceptance check for M3c (panel copy and the way back, ADR 0022).
 *
 * Drives the built DockerEngineSocketAdapter.backups(...) against a throw-away
 * RustFS S3 server, two Postgres 18 containers and a stand-in WordPress site, on
 * an isolated bridge network with no host port. pg_dump, pg_restore and psql run
 * only inside this script's Postgres containers.
 *
 * Machine safety: every object this script creates is named hp_swarmtest_<run>…
 * (the product's own site and job objects carry "swarmtest_<run>" or one of this
 * run's job ids) and is removed by exact name in `finally` and on SIGINT/SIGTERM.
 * Nothing is pulled, nothing is pruned, and nothing under /etc, /var/lib or
 * /opt/hosting-panel is read or written: all files live in a /dev/shm temp folder.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { inspect } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const executorDist = path.resolve(repoRoot, "apps/docker-executor/dist/index.js");
const panelFetchCli = path.resolve(repoRoot, "apps/docker-executor/dist/cli/panel-fetch.js");

const {
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  SHARED_DB_ALIAS,
  buildAwsSharedCredentials,
  buildSharedDatabaseContainerPayload,
  getManagedVolumeName,
  mariadbRootExec,
  s3Request,
} = await import(pathToFileURL(executorDist).href);
const { DEFAULT_PHP_VERSION, RESTIC_IMAGE, SHARED_MARIADB_IMAGE, resolveWordpressImage, siteDatabasePrefix } =
  await import(pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href);
const { buildPanelDumpCommand, PG_DUMP_PATH } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/api/dist/backups/panel-dump.js")).href
);

const SOCKET_PATH = "/var/run/docker.sock";
const PG_IMAGE = "postgres:18-bookworm";
const HELPER_IMAGE = "busybox:latest";
const RUSTFS_IMAGE =
  "rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74";
const WORDPRESS_IMAGE = resolveWordpressImage(DEFAULT_PHP_VERSION);
const HANDOVER_GID = 30; // a supplementary group of the user running this script (dip), not 0
const DUMP_OWNER_UID = 4001; // "another uid": the stand-in for the API user that writes the dump

const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;
const networkName = `${runId}_net`;
const s3ContainerName = `${runId}_s3`;
const pg1Name = `${runId}_pg1`;
const pg2Name = `${runId}_pg2`;
const dbContainerName = `${runId}_db`;
const siteContainerName = `${runId}_site`;
const siteId = `site_swarmtest_${runHex}`;
const serviceInstanceId = `svc_swarmtest_${runHex}`;
const siteVolumeName = getManagedVolumeName(serviceInstanceId, "html");
const siteDbName = siteDatabasePrefix(siteId);
const uidGid = `${String(process.getuid())}:${String(process.getgid())}`;

const createdContainers = new Set();
const createdVolumes = new Set();
const myJobIds = new Set(); // every job id this run sends; product objects carry it
const productNames = new Set(); // hp_bk_* container names the product created for this run
const tempDirs = [];
let createdNetwork = false;
let containerCreateCount = 0;
const capturedSpecs = [];
const measured = {};

function logLine(line) {
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
  if (!cond) throw new StepAssertionError(expected, actual);
}

function formatErr(err) {
  if (err instanceof ExecutorCodedError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function newJobId() {
  const id = `op_${randomBytes(16).toString("hex")}`;
  myJobIds.add(id);
  return id;
}

function dockerRequest(method, reqPath, jsonBody) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody), "utf8");
    const headers = payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {};
    const req = http.request({ socketPath: SOCKET_PATH, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`Docker HTTP timeout: ${method} ${reqPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerJson(method, reqPath, jsonBody) {
  const res = await dockerRequest(method, reqPath, jsonBody);
  if (![200, 201, 204].includes(res.statusCode)) {
    throw new Error(`Docker ${method} ${reqPath} failed (${String(res.statusCode)}): ${res.body.toString("utf8")}`);
  }
  return res.body.length === 0 ? null : JSON.parse(res.body.toString("utf8"));
}

/** execFile with argv only; stdin may be a string or Buffer. Output is kept as Buffers. */
function execCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFileCb(
      cmd,
      args,
      {
        encoding: "buffer",
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 256 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          ok: !err,
          code,
          stdoutBuf: stdout,
          stdout: stdout.toString("utf8"),
          stderr: err && stderr.length === 0 ? err.message : stderr.toString("utf8"),
        });
      },
    );
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}

const docker = (args, opts) => execCmd("docker", args, opts);

async function dockerInspect(kind, name) {
  const res = await docker([kind, "inspect", name]);
  if (!res.ok) return null;
  const arr = JSON.parse(res.stdout);
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

async function dockerListNames(kind, filterName) {
  const args =
    kind === "container"
      ? ["ps", "-a", "--filter", `name=${filterName}`, "--format", "{{.Names}}"]
      : [kind, "ls", "--filter", `name=${filterName}`, "--format", "{{.Name}}"];
  const res = await docker(args);
  assert(res.ok, `docker ${kind} ls succeeds`, res.stderr);
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Names of hp_bk_* objects that belong to this run (one of its job ids, or seen created by its adapters). */
async function myProductLeftovers() {
  const out = [];
  for (const kind of ["container", "volume", "network"]) {
    for (const name of await dockerListNames(kind, "hp_bk_")) {
      if (productNames.has(name) || [...myJobIds].some((id) => name.includes(id))) out.push(`${kind}:${name}`);
    }
  }
  return out;
}

function pickFreeSubnet(existingNets) {
  const ipToInt = (ip) => ip.split(".").reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);
  const parseCidr = (cidr) => {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr ?? "");
    if (!m) return null;
    const prefix = Number(m[2]);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { net: (ipToInt(m[1]) & mask) >>> 0, mask };
  };
  const used = (existingNets ?? [])
    .flatMap((n) => n?.IPAM?.Config ?? [])
    .map((c) => parseCidr(c?.Subnet))
    .filter(Boolean);
  for (let second = 240; second <= 254; second += 1) {
    for (let third = 200; third <= 254; third += 1) {
      const c = parseCidr(`10.${String(second)}.${String(third)}.0/24`);
      if (!used.some((u) => ((c.net & u.mask) >>> 0) === u.net || ((u.net & c.mask) >>> 0) === c.net)) {
        return `10.${String(second)}.${String(third)}.0/24`;
      }
    }
  }
  return null;
}

async function s3ListAll(target, prefix = "") {
  const objects = [];
  let token;
  for (;;) {
    const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const res = await s3Request(target, "GET", "", undefined, query);
    assert(res.status === 200, "S3 ListObjectsV2 returns 200", `status=${String(res.status)}`);
    const xml = res.body.toString("utf8");
    for (const entry of xml.split("<Contents>").slice(1)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(entry)?.[1];
      if (key) objects.push(key.replace(/&amp;/g, "&"));
    }
    if (!xml.includes("<IsTruncated>true</IsTruncated>")) return objects;
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!token) return objects;
  }
}

/** Wraps the adapter's Docker client to record every container create and inspect it before it runs. */
function instrumentAdapter(adapter) {
  const client = adapter.dockerClient;
  const orig = client.request.bind(client);
  client.request = async (method, endpointPath, body, opts) => {
    const res = await orig(method, endpointPath, body, opts);
    if (method === "POST" && endpointPath.startsWith("/containers/create")) {
      containerCreateCount += 1;
      const name = decodeURIComponent(/name=([^&]+)/.exec(endpointPath)?.[1] ?? "");
      if (name) productNames.add(name);
      let inspectBefore = null;
      if (res.statusCode === 201 && name) {
        const ir = await orig("GET", `/containers/${encodeURIComponent(name)}/json`);
        if (ir.statusCode === 200) inspectBefore = JSON.parse(ir.body.toString("utf8"));
      }
      capturedSpecs.push({ name, createPayload: body ?? null, inspect: inspectBefore });
    }
    return res;
  };
  return adapter;
}

async function pollJob(adapter, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapter.backups({ action: "status", jobId });
    if (status.state !== "running") return status;
    await sleep(200);
  }
  throw new StepAssertionError(`job ${jobId} settles within ${String(timeoutMs)}ms`, "still running");
}

let cleanupPromise = null;
let cleanupLeftovers = [];
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    cleanupLeftovers = await myProductLeftovers().catch(() => []);
    const leftoverContainers = cleanupLeftovers.filter((n) => n.startsWith("container:")).map((n) => n.slice(10));
    const leftoverVolumes = cleanupLeftovers.filter((n) => n.startsWith("volume:")).map((n) => n.slice(7));
    for (const c of new Set([...leftoverContainers, ...createdContainers])) {
      await docker(["rm", "-f", "-v", c]);
    }
    for (const v of new Set([...leftoverVolumes, ...createdVolumes, siteVolumeName])) {
      await docker(["volume", "rm", v]);
    }
    for (const n of cleanupLeftovers.filter((x) => x.startsWith("network:")).map((x) => x.slice(8))) {
      await docker(["network", "rm", n]);
    }
    if (createdNetwork) await docker(["network", "rm", networkName]);
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  })();
  return cleanupPromise;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

// ---------------------------------------------------------------------------------------------------------------

/** Starts a Postgres 18 container: data on tmpfs, runs as this user, host connections need a password. */
async function startPostgres(name, superPwFile, extraArgs = []) {
  createdContainers.add(name);
  const res = await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    uidGid,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    `/var/lib/postgresql:rw,size=512m,uid=${String(process.getuid())},gid=${String(process.getgid())}`,
    "--tmpfs",
    `/var/run/postgresql:rw,size=8m,uid=${String(process.getuid())},gid=${String(process.getgid())}`,
    "-v",
    `${superPwFile}:/run/hp_pg_superpw:ro`,
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/hp_pg_superpw",
    "-e",
    "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust",
    ...extraArgs,
    PG_IMAGE,
  ]);
  assert(res.ok, `${name} starts`, res.stderr);
}

async function waitPostgres(name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // TCP answers only once the final server runs (the init server listens on the socket only).
    const r = await docker(["exec", name, "pg_isready", "-q", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"]);
    if (r.ok) return;
    await sleep(500);
  }
  throw new StepAssertionError(`${name} ready within 90s`, "timed out");
}

/** psql inside a Postgres container over the local socket; SQL on stdin. */
async function psql(container, db, sql, { user = "postgres", at = true } = {}) {
  const args = ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db];
  if (at) args.push("-At");
  args.push("-f", "-");
  const r = await docker(args, { stdin: sql });
  assert(r.ok, `psql on ${container}/${db} exits 0`, r.stderr.slice(0, 600));
  return r.stdout;
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`;

/** Per-table row count and content hash, plus owners, for one database. */
async function tableFingerprint(container, db) {
  const tables = (await psql(container, db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"))
    .split("\n")
    .filter(Boolean);
  const sql = `${tables
    .map(
      (t) =>
        `SELECT ${lit(t)}, count(*), md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) FROM public.${t} t`,
    )
    .join(" UNION ALL ")} ORDER BY 1;`;
  return { tables, rows: await psql(container, db, sql) };
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const startedAt = performance.now();
  let passed = 0;
  let total = 0;
  let setupFailed = false;
  const failures = [];

  async function runStep(name, fn, { abortOnFail = false } = {}) {
    total += 1;
    if (setupFailed) {
      logLine(`FAIL ${name}: step runs / skipped after setup failure`);
      failures.push(name);
      return;
    }
    try {
      await fn();
      passed += 1;
      logLine(`PASS ${name}`);
    } catch (err) {
      failures.push(name);
      if (err instanceof StepAssertionError) logLine(`FAIL ${name}: ${err.expected} / ${err.actual}`);
      else logLine(`FAIL ${name}: step succeeds / ${formatErr(err)}`);
      if (abortOnFail) setupFailed = true;
    }
  }

  // Sentinels. None of them may reach a bucket object, a job container's config, or a child's output.
  const marker = `HPMARK_${runHex}_${randomBytes(4).toString("hex")}`;
  const awkward = `O'Brien "q" \\back\\slash $$dollar$$ ;-- tab\there\nline2 \u00fc\u20ac ${marker}`;
  const s3AccessKey = `ak${randomBytes(10).toString("hex")}`;
  const s3SecretKey = `sk${randomBytes(18).toString("hex")}`;
  const backupKey = randomBytes(32).toString("hex");
  const masterKey = `5e${randomBytes(31).toString("hex")}`;
  const masterKey8 = `8e${randomBytes(31).toString("hex")}`;
  const pgPassword = `p@ss:w/rd?#[]%&= +${randomBytes(8).toString("hex")}`;
  const pgSuperPw = randomBytes(16).toString("hex");
  const restorePw = randomBytes(32).toString("hex"); // hosting_panel on pg2, as install.sh makes it
  const mariaRootPw = randomBytes(24).toString("hex");
  const siteDbUser = `wp_${runHex}`;
  const siteDbPass = randomBytes(16).toString("hex");
  const secrets = [s3SecretKey, backupKey, masterKey, masterKey8, pgPassword, pgSuperPw, mariaRootPw, restorePw];
  // restore-panel.sh's way: user hosting_panel over TCP, the password only in the child's environment.
  const asPanelUser = (args, stdin) =>
    docker(["exec", "-i", "-e", "PGPASSWORD", pg2Name, ...args, "-h", "127.0.0.1", "-U", "hosting_panel"], {
      stdin,
      env: { ...process.env, PGPASSWORD: restorePw },
    });

  let tmpRoot = "";
  let handoverDir = "";
  let secretsRootDir = "";
  let backupKeyFile = "";
  let verifyDir = "";
  let adapter = null;
  let adapterOptions = null;
  let target = null;
  let s3Ip = "";
  let j1 = "";
  let dumpPath = "";
  let dumpBytes = null;
  let fetchedDump = null;

  // Runs restic in this script's own container against `<prefix>/panel` (never a product container).
  const myRestic = async (prefix, args, { script = null, copyDir = null } = {}) => {
    const name = `${runId}_restic_${randomBytes(3).toString("hex")}`;
    createdContainers.add(name);
    const res = await docker([
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      networkName,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      uidGid,
      "--tmpfs",
      "/tmp:rw,size=64m,mode=1777",
      "-v",
      `${verifyDir}:/run/v:ro`,
      ...(copyDir ? ["-v", `${copyDir}:/backup/panel:ro`] : []),
      "-e",
      "AWS_SHARED_CREDENTIALS_FILE=/run/v/aws.creds",
      "-e",
      "RESTIC_PASSWORD_FILE=/run/v/backup.key",
      "-e",
      "RESTIC_CACHE_DIR=/tmp/cache",
      "-e",
      `RESTIC_REPOSITORY=s3:${target.endpoint}/${target.bucket}/${prefix}/panel`,
      "-e",
      `RO=-o s3.bucket-lookup=path -o s3.region=${target.region}`,
      "--entrypoint",
      script ? "/bin/sh" : "/usr/bin/restic",
      RESTIC_IMAGE,
      ...(script ? ["-c", script, "sh", ...args] : ["-o", "s3.bucket-lookup=path", "-o", `s3.region=${target.region}`, ...args]),
    ]);
    createdContainers.delete(name);
    return res;
  };
  const snapshots = async (prefix) => {
    const r = await myRestic(prefix, ["snapshots", "--json", "--no-lock"]);
    assert(r.ok, `restic snapshots on ${prefix}/panel exits 0`, r.stderr);
    return JSON.parse(r.stdout);
  };

  try {
    // ---------------------------------------------------------------- setup
    await runStep(
      "setup",
      async () => {
        for (const img of [PG_IMAGE, RESTIC_IMAGE, RUSTFS_IMAGE, SHARED_MARIADB_IMAGE, WORDPRESS_IMAGE, HELPER_IMAGE]) {
          const r = await docker(["image", "inspect", "--format", "{{.Id}}", img]);
          assert(r.ok, `image ${img} present locally`, r.stderr);
        }
        tmpRoot = await mkdtemp(path.join("/dev/shm", `${runId}_`));
        tempDirs.push(tmpRoot);
        await chmod(tmpRoot, 0o755);
        secretsRootDir = path.join(tmpRoot, "secrets");
        verifyDir = path.join(tmpRoot, "verify");
        handoverDir = path.join(tmpRoot, "handover");
        const dirs = {};
        for (const d of ["secrets", "verify", "backups", "sftp", "ingress", "site-files", "site-mail", "phpmyadmin", "mariadb-data", "pg", "fetch8"]) {
          dirs[d] = path.join(tmpRoot, d);
          await mkdir(dirs[d], { mode: 0o700 });
        }
        await mkdir(handoverDir, { mode: 0o700 });
        backupKeyFile = path.join(tmpRoot, "backup.key");
        await writeFile(backupKeyFile, backupKey, { mode: 0o400 });
        await writeFile(path.join(verifyDir, "backup.key"), backupKey, { mode: 0o400 });
        await writeFile(path.join(verifyDir, "aws.creds"), buildAwsSharedCredentials(s3AccessKey, s3SecretKey), { mode: 0o400 });
        await writeFile(path.join(dirs.pg, "superpw"), pgSuperPw, { mode: 0o400 });
        const mariaKey = path.join(tmpRoot, "mariadb-root.key");
        await writeFile(mariaKey, mariaRootPw, { mode: 0o400 });

        // Hand-over directory: root-owned, group 30, mode 2770 — set by a root container of this run.
        const ownName = `${runId}_own`;
        createdContainers.add(ownName);
        const own = await docker([
          "run", "--rm", "--name", ownName, "--network", "none", "--user", "0:0",
          "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "FSETID",
          "--security-opt", "no-new-privileges:true", "-v", `${handoverDir}:/h`, HELPER_IMAGE,
          "sh", "-c", `chown 0:${String(HANDOVER_GID)} /h && chmod 2770 /h`,
        ]);
        createdContainers.delete(ownName);
        assert(own.ok, "hand-over directory set to root:30 2770", own.stderr);
        const hs = await stat(handoverDir);
        assert(hs.uid === 0 && hs.gid === HANDOVER_GID && (hs.mode & 0o7777) === 0o2770, "hand-over root:30 2770", `${String(hs.uid)}:${String(hs.gid)} ${(hs.mode & 0o7777).toString(8)}`);

        const subnet = pickFreeSubnet(await dockerJson("GET", "/networks"));
        assert(subnet !== null, "free /24 subnet found", "none");
        await dockerJson("POST", "/networks/create", {
          Name: networkName,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
        });
        createdNetwork = true;

        // RustFS: tmpfs data, no port.
        await dockerJson("POST", `/containers/create?name=${encodeURIComponent(s3ContainerName)}`, {
          Image: RUSTFS_IMAGE,
          Env: [`RUSTFS_ACCESS_KEY=${s3AccessKey}`, `RUSTFS_SECRET_KEY=${s3SecretKey}`],
          HostConfig: {
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: networkName,
            RestartPolicy: { Name: "no" },
            Tmpfs: {
              "/tmp": "rw,size=64m,uid=10001,gid=10001",
              "/data": "rw,size=768m,uid=10001,gid=10001",
              "/logs": "rw,size=16m,uid=10001,gid=10001",
            },
          },
        });
        createdContainers.add(s3ContainerName);
        await dockerJson("POST", `/containers/${s3ContainerName}/start`, {});
        s3Ip = (await dockerInspect("container", s3ContainerName))?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
        assert(s3Ip.length > 0, "RustFS IP assigned", s3Ip);
        target = {
          endpoint: `http://${s3Ip}:9000`,
          region: "us-east-1",
          bucket: `hp-panel-${runHex}`,
          prefix: `tenant-${runHex}`,
          accessKeyId: s3AccessKey,
          secretAccessKey: s3SecretKey,
        };

        // Postgres containers and MariaDB start while RustFS warms up.
        await startPostgres(pg1Name, path.join(dirs.pg, "superpw"), ["-v", `${handoverDir}:${handoverDir}`]);
        await startPostgres(pg2Name, path.join(dirs.pg, "superpw"));
        const dbBase = buildSharedDatabaseContainerPayload({
          image: SHARED_MARIADB_IMAGE,
          user: uidGid,
          dataDirHostPath: dirs["mariadb-data"],
          rootKeyHostPath: mariaKey,
          adminSubnet: subnet,
        });
        await dockerJson("POST", `/containers/create?name=${encodeURIComponent(dbContainerName)}`, {
          ...dbBase,
          HostConfig: { ...dbBase.HostConfig, NetworkMode: networkName },
          NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [SHARED_DB_ALIAS] } } },
        });
        createdContainers.add(dbContainerName);
        await dockerJson("POST", `/containers/${dbContainerName}/start`, {});

        const s3Deadline = Date.now() + 30_000;
        let s3Ready = false;
        while (Date.now() < s3Deadline && !s3Ready) {
          try {
            s3Ready = (await fetch(`${target.endpoint}/`, { signal: AbortSignal.timeout(2_000) })).status === 403;
          } catch {
            // starting
          }
          if (!s3Ready) await sleep(250);
        }
        assert(s3Ready, "RustFS answers within 30s", "timed out");
        const bucket = await s3Request(target, "PUT", "");
        assert(bucket.status === 200 || bucket.status === 204, "bucket created", String(bucket.status));

        adapterOptions = {
          pullMissingImages: false,
          secretsRootDir,
          backupWorkDir: dirs.backups,
          sftpStateDir: dirs.sftp,
          ingressRootDir: dirs.ingress,
          siteFilesDir: dirs["site-files"],
          siteMailDir: dirs["site-mail"],
          phpMyAdminConfigDir: dirs.phpmyadmin,
          sharedDbDataDir: dirs["mariadb-data"],
          sharedDbRootKeyFile: mariaKey,
          sharedDbContainerName: dbContainerName,
          sharedDbNetworkName: networkName,
          backupKeyFile,
          backupNetworkName: networkName,
          panelDumpDir: handoverDir,
          executorUid: process.getuid(),
        };
        adapter = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));
        await waitPostgres(pg1Name);
        await waitPostgres(pg2Name);
      },
      { abortOnFail: true },
    );

    // ---------------------------------------------------------------- (a) real schema
    const migrationFiles = (await readdir(path.join(repoRoot, "packages/database/migrations")))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    await runStep("panel-db-real-schema", async () => {
      await psql(
        pg1Name,
        "postgres",
        `CREATE ROLE hosting_panel LOGIN PASSWORD ${lit(pgPassword)}; CREATE DATABASE hosting_panel OWNER hosting_panel;`,
      );
      const db = (sql) => psql(pg1Name, "hosting_panel", sql, { user: "hosting_panel" });
      // As the product runner does: the table, then each file in its own transaction with its row.
      await db("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
      for (const f of migrationFiles) {
        const body = await readFile(path.join(repoRoot, "packages/database/migrations", f), "utf8");
        await db(`BEGIN;\n${body}\n;INSERT INTO schema_migrations (filename) VALUES (${lit(f)});\nCOMMIT;\n`);
      }
      const M = marker;
      await db(`
INSERT INTO platform_installations (id, name) VALUES ('pi_${M}', 'install ${M}');
INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
  VALUES ('host_${M}', 'pi_${M}', 'host', 'host-${runHex}.example.test', '192.0.2.10', 4000, '8589934592', '107374182400');
INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('org_${M}', 'pi_${M}', 'Org ${M}', 'org-${runHex}');
INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('ha_${M}', 'host_${M}', 'org_${M}');
INSERT INTO resource_quotas (id, organization_id, max_sites, max_services, max_cpu_milli, max_memory_bytes, max_storage_bytes)
  VALUES ('rq_${M}', 'org_${M}', 5, 5, 2000, '1073741824', '10737418240');
INSERT INTO users (id, email, name) VALUES ('usr1_${M}', 'a-${runHex}@example.test', 'User ${M}'), ('usr2_${M}', 'b-${runHex}@example.test', 'User2 ${M}');
INSERT INTO user_sessions (id, user_id, expires_at) VALUES ('ses1_${M}', 'usr1_${M}', now() + interval '1 day'), ('ses2_${M}', 'usr2_${M}', now() + interval '1 day');
INSERT INTO sites (id, organization_id, host_allocation_id, name, slug, status) VALUES
  ('site1_${M}', 'org_${M}', 'ha_${M}', $hpq$${awkward}$hpq$, 's1-${runHex}', 'ready'),
  ('site2_${M}', 'org_${M}', 'ha_${M}', 'deploying ${M}', 's2-${runHex}', 'deploying'),
  ('site3_${M}', 'org_${M}', 'ha_${M}', 'maint ${M}', 's3-${runHex}', 'maintenance');
INSERT INTO operations (id, organization_id, kind, status, resource_type, resource_id, started_at, completed_at) VALUES
  ('opdone_${M}', 'org_${M}', 'site.backups.create', 'succeeded', 'site', 'site1_${M}', now() - interval '2 hours', now() - interval '119 minutes'),
  ('opqueued_${M}', 'org_${M}', 'site.deploy', 'queued', 'site', 'site2_${M}', NULL, NULL),
  ('oprun_${M}', 'org_${M}', 'site.backups.restore', 'processing', 'site', 'site1_${M}', now() - interval '5 minutes', NULL),
  ('opunk_${M}', 'org_${M}', 'site.deploy', 'unknown', 'site', 'site3_${M}', now() - interval '9 minutes', NULL),
  ('oppanel_${M}', 'org_${M}', 'panel.backups.create', 'processing', 'panel', 'panel', now() - interval '1 hour', NULL);
INSERT INTO operation_steps (id, operation_id, key, label, status) VALUES
  ('st1_${M}', 'opdone_${M}', 'k1', 'done step', 'succeeded'),
  ('st2_${M}', 'opqueued_${M}', 'k1', 'pending step', 'pending'),
  ('st3_${M}', 'oprun_${M}', 'k1', 'running step', 'running'),
  ('st4_${M}', 'oprun_${M}', 'k2', 'pending step', 'pending'),
  ('st5_${M}', 'opunk_${M}', 'k1', 'unknown step', 'unknown'),
  ('st6_${M}', 'oppanel_${M}', 'k1', 'panel step', 'running'),
  ('st7_${M}', 'oppanel_${M}', 'k2', 'panel step 2', 'pending');
INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, started_at, finished_at) VALUES
  ('bk1_${M}', 'site1_${M}', 'manual', 'succeeded', 'opbk1_${M}', '${"a".repeat(64)}', 1234, now() - interval '3 hours', now() - interval '179 minutes'),
  ('bk2_${M}', 'site1_${M}', 'nightly', 'running', 'opbk2_${M}', NULL, NULL, now() - interval '3 minutes', NULL),
  ('bk3_${M}', 'site1_${M}', 'manual', 'succeeded', 'opbk3_${M}', '${"b".repeat(64)}', 4321, now() - interval '4 hours', now() - interval '239 minutes');
UPDATE site_backups SET restore_status = 'running', restore_operation_id = 'oprun_${M}' WHERE id = 'bk1_${M}';
UPDATE site_backups SET archive_status = 'ready', archive_operation_id = 'oparch_${M}', archive_ready_until = now() + interval '1 day' WHERE id = 'bk3_${M}';
INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status, locked_at, published_at) VALUES
  ('ev1_${M}', 'e', 'operation', 'oprun_${M}', '{"m":"${M}"}', 'pending', NULL, NULL),
  ('ev2_${M}', 'e', 'operation', 'oprun_${M}', '{"m":"${M}"}', 'processing', now(), NULL),
  ('ev3_${M}', 'e', 'operation', 'opdone_${M}', '{"m":"${M}"}', 'published', NULL, now() - interval '1 hour');
INSERT INTO quota_reservations (id, organization_id, resource_quota_id, status, idempotency_key, expires_at) VALUES
  ('qr1_${M}', 'org_${M}', 'rq_${M}', 'pending', 'idem1-${M}', now() + interval '1 hour'),
  ('qr2_${M}', 'org_${M}', 'rq_${M}', 'committed', 'idem2-${M}', now() + interval '1 hour');
INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
  secret_access_key_iv_base64, secret_access_key_auth_tag_base64, nightly_run_started_at)
  VALUES ('default', 'https://s3.example.test', 'us-east-1', 'b-${runHex}', 'p', 'AKEXAMPLE', 'Y2lwaGVy', 'aXY=', 'dGFn', now() - interval '10 minutes');
`);
      const applied = (await db("SELECT filename FROM schema_migrations ORDER BY 1;")).split("\n").filter(Boolean);
      assert(JSON.stringify(applied) === JSON.stringify(migrationFiles), "every migration applied and recorded", applied.join(","));
      const counts = await db(
        `SELECT (SELECT count(*) FROM sites)||','||(SELECT count(*) FROM operations)||','||(SELECT count(*) FROM outbox_events)||','||(SELECT count(*) FROM user_sessions);`,
      );
      assert(counts.trim() === "3,5,3,2", "seed rows present (sites,operations,outbox,sessions)", counts.trim());
    });

    // ---------------------------------------------------------------- (b) pg_dump with the product's arguments
    await runStep("panel-dump-product-args", async () => {
      j1 = newJobId();
      dumpPath = path.join(handoverDir, `${j1}.dump`);
      const databaseUrl = `postgres://hosting_panel:${encodeURIComponent(pgPassword)}@127.0.0.1:5432/hosting_panel`;
      assert(encodeURIComponent(pgPassword) !== pgPassword, "password needs URL escaping", pgPassword);
      const cmd = buildPanelDumpCommand(databaseUrl, dumpPath);
      assert(!cmd.args.some((a) => a.includes(pgPassword) || a.includes(encodeURIComponent(pgPassword))), "password in no argument", JSON.stringify(cmd.args));
      assert(cmd.env.PGPASSWORD === pgPassword, "password decoded into PGPASSWORD only", "mismatch");
      assert(PG_DUMP_PATH === "/usr/lib/postgresql/18/bin/pg_dump", "pg_dump path is the PG 18 one", PG_DUMP_PATH);
      measured.dumpArgs = cmd.args.join(" ");
      measured.dumpEnvKeys = Object.keys(cmd.env).join(",");

      const runDump = async (env, outFile) => {
        const envFile = path.join(tmpRoot, `dump-${randomBytes(3).toString("hex")}.env`);
        await writeFile(envFile, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
        const args = buildPanelDumpCommand(databaseUrl, outFile).args;
        const t0 = performance.now();
        const r = await docker([
          "exec", "--env-file", envFile, "-u", `${String(DUMP_OWNER_UID)}:${String(HANDOVER_GID)}`, pg1Name,
          "sh", "-c", 'umask 027; exec "$0" "$@"', PG_DUMP_PATH, ...args,
        ]);
        await rm(envFile, { force: true });
        return { ...r, ms: performance.now() - t0 };
      };
      const good = await runDump(cmd.env, dumpPath);
      assert(good.ok, "pg_dump exits 0", good.stderr);
      measured.dumpMs = Math.round(good.ms);
      const st = await stat(dumpPath);
      dumpBytes = await readFile(dumpPath);
      measured.dumpSize = st.size;
      assert(dumpBytes.subarray(0, 5).toString("latin1") === "PGDMP", "dump starts with PGDMP", dumpBytes.subarray(0, 5).toString("hex"));
      assert(st.uid === DUMP_OWNER_UID && st.gid === HANDOVER_GID && (st.mode & 0o777) === 0o640, "dump 4001:30 0640", `${String(st.uid)}:${String(st.gid)} ${(st.mode & 0o777).toString(8)}`);
      assert(dumpBytes.includes(Buffer.from(marker)), "uncompressed dump holds the marker (makes the bucket scan meaningful)", "marker absent");

      const badFile = path.join(handoverDir, `${newJobId()}.dump`);
      const bad = await runDump({ ...cmd.env, PGPASSWORD: `wrong-${pgPassword}` }, badFile);
      assert(!bad.ok, "wrong password: pg_dump exits non-zero", `exit ${String(bad.code)}`);
      const badStat = await lstat(badFile).catch(() => null);
      const badHead = badStat ? (await readFile(badFile)).subarray(0, 5).toString("latin1") : "";
      assert(badStat === null || badHead !== "PGDMP", "wrong password leaves no usable file", `size=${String(badStat?.size)}`);
      await rm(badFile, { force: true });
      assert(!bad.stderr.includes(pgPassword), "pg_dump error text has no password", "leak");
    });

    // ---------------------------------------------------------------- (c) the copy is stored
    await runStep("panel-copy-stored", async () => {
      const before = await lstat(dumpPath);
      const specStart = capturedSpecs.length;
      const t0 = performance.now();
      const started = await adapter.backups({ action: "panelStart", jobId: j1, target, masterKey, retentionDays: 30 });
      assert(started.state === "running" || started.state === "succeeded", "panelStart answers running", JSON.stringify(started));
      const settled = await pollJob(adapter, j1);
      measured.copyJobMs = Math.round(performance.now() - t0);
      assert(settled.state === "succeeded" && settled.failure === null, "copy job succeeds", JSON.stringify(settled));
      assert(settled.snapshot?.fileCount === 2, "fileCount 2", JSON.stringify(settled.snapshot));
      assert(settled.snapshot.totalBytes === before.size + 64, "totalBytes = dump + 64-byte key", JSON.stringify(settled.snapshot));
      measured.copySnapshot = settled.snapshot;

      const keys = await s3ListAll(target, "");
      const needles = [marker, masterKey, s3SecretKey, backupKey].map((s) => Buffer.from(s, "utf8"));
      needles.push(Buffer.from(masterKey, "hex"));
      let bucketBytes = 0;
      const hits = [];
      for (const key of keys) {
        const obj = await s3Request(target, "GET", key);
        assert(obj.status === 200, `GET ${key}`, String(obj.status));
        bucketBytes += obj.body.length;
        needles.forEach((n, i) => {
          if (obj.body.includes(n)) hits.push(`${key}#${String(i)}`);
        });
      }
      measured.bucketObjects = keys.length;
      measured.bucketBytes = bucketBytes;
      assert(keys.some((k) => k.startsWith(`${target.prefix}/panel/`)), "copy stored under <prefix>/panel", keys.slice(0, 5).join(","));
      assert(hits.length === 0, "no bucket object holds the marker, master key (hex or raw), S3 secret or key file", hits.join(","));

      const specs = capturedSpecs.slice(specStart);
      const names = specs.map((s) => s.name);
      assert(names.length >= 3 && names.every((n) => n.startsWith(`hp_bk_${j1}_`)), "job containers named hp_bk_<jobId>_…", names.join(","));
      for (const s of specs) {
        const i = s.inspect;
        assert(i !== null, `${s.name} inspected before start`, "null");
        const visible = JSON.stringify({ env: i.Config?.Env, cmd: i.Config?.Cmd, ep: i.Config?.Entrypoint, args: i.Args, labels: i.Config?.Labels, payload: s.createPayload });
        const leaked = secrets.filter((x) => visible.includes(x));
        assert(leaked.length === 0, `${s.name} config holds no secret`, `${String(leaked.length)} secret(s)`);
        const mounts = i.Mounts ?? [];
        assert(!mounts.some((m) => /docker\.sock/.test(m.Source ?? "")), `${s.name} mounts no Docker socket`, JSON.stringify(mounts.map((m) => m.Source)));
      }
      const pup = specs.find((s) => s.name === `hp_bk_${j1}_pup`);
      assert(pup, "upload container _pup created", names.join(","));
      const pm = pup.inspect.Mounts ?? [];
      const dumpMount = pm.find((m) => m.Destination === "/backup/panel/panel.dump");
      const keyMount = pm.find((m) => m.Destination === "/backup/panel/secrets-master.key");
      assert(dumpMount?.Source === dumpPath && dumpMount.RW === false, "dump bind-mounted read-only", JSON.stringify(dumpMount));
      assert(keyMount && keyMount.RW === false && keyMount.Source.startsWith(path.join(secretsRootDir, `job_bk_mk_${j1}`)), "key bind-mounted read-only from job_bk_mk_<jobId>", JSON.stringify(keyMount));
      assert(JSON.stringify(pup.inspect.HostConfig?.GroupAdd) === JSON.stringify([String(HANDOVER_GID)]), "_pup joins the hand-over group", JSON.stringify(pup.inspect.HostConfig?.GroupAdd));

      for (const d of [`job_bk_pn_${j1}`, `job_bk_mk_${j1}`]) {
        assert((await lstat(path.join(secretsRootDir, d)).catch(() => null)) === null, `${d} gone after the job`, "still there");
      }
      const left = (await myProductLeftovers()).filter((n) => n.includes(j1));
      assert(left.length === 0, "no hp_bk_<jobId> object left", left.join(","));
      const after = await lstat(dumpPath);
      const afterBytes = await readFile(dumpPath);
      assert(after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && afterBytes.equals(dumpBytes), "dump untouched", "changed");
    });

    // ---------------------------------------------------------------- refusals
    let j5Snapshot = null;
    await runStep("panel-copy-refusals", async () => {
      const count0 = (await snapshots(target.prefix)).length;
      const expectMissing = async (label, prepare) => {
        const jobId = newJobId();
        await prepare(path.join(handoverDir, `${jobId}.dump`));
        const creates = containerCreateCount;
        await adapter.backups({ action: "panelStart", jobId, target, masterKey, retentionDays: 30 });
        const st = await pollJob(adapter, jobId);
        assert(st.state === "failed" && st.failure === "panel_dump_missing", `${label}: failed panel_dump_missing`, JSON.stringify(st));
        assert(containerCreateCount === creates, `${label}: no container created`, String(containerCreateCount - creates));
        await rm(path.join(handoverDir, `${jobId}.dump`), { force: true });
      };
      await expectMissing("dump missing", async () => undefined);
      await expectMissing("symlink", async (p) => symlink(dumpPath, p));
      await expectMissing("not PGDMP", async (p) => writeFile(p, `NOTPG ${marker}\n`, { mode: 0o640 }));
      assert((await snapshots(target.prefix)).length === count0, "refusals add no snapshot", "count changed");

      // One panel job at a time; the same id answers the same job.
      const j5 = newJobId();
      const j6 = newJobId();
      for (const j of [j5, j6]) {
        await copyFile(dumpPath, path.join(handoverDir, `${j}.dump`));
        await chmod(path.join(handoverDir, `${j}.dump`), 0o640);
      }
      const first = await adapter.backups({ action: "panelStart", jobId: j5, target, masterKey, retentionDays: 30 });
      assert(first.state === "running", "first panelStart running", JSON.stringify(first));
      let lockErr;
      try {
        const r = await adapter.backups({ action: "panelStart", jobId: j6, target, masterKey, retentionDays: 30 });
        lockErr = `answered ${JSON.stringify(r)}`;
      } catch (err) {
        lockErr = err instanceof ExecutorCodedError ? err.code : formatErr(err);
      }
      assert(lockErr === "RESOURCE_LOCKED", "second panelStart while one runs → RESOURCE_LOCKED", lockErr);
      const again = await adapter.backups({ action: "panelStart", jobId: j5, target, masterKey, retentionDays: 30 });
      assert(again.jobId === j5 && (again.state === "running" || again.state === "succeeded"), "same id → same job status", JSON.stringify(again));
      const done = await pollJob(adapter, j5);
      assert(done.state === "succeeded", "j5 succeeds", JSON.stringify(done));
      const again2 = await adapter.backups({ action: "panelStart", jobId: j5, target, masterKey, retentionDays: 30 });
      assert(JSON.stringify(again2) === JSON.stringify(done), "same id after the end → same status", JSON.stringify(again2));
      const pups = capturedSpecs.filter((s) => s.name === `hp_bk_${j5}_pup`).length;
      assert(pups === 1, "one upload for the job id", String(pups));
      const snapsAfter = await snapshots(target.prefix);
      assert(snapsAfter.length === count0 + 1, "exactly one new snapshot", `${String(count0)} → ${String(snapsAfter.length)}`);
      assert(capturedSpecs.every((s) => !s.name.includes(j6)), "locked job created nothing", "j6 container seen");
      j5Snapshot = done.snapshot;
      for (const j of [j5, j6]) await rm(path.join(handoverDir, `${j}.dump`), { force: true });

      // Hostile requests: refused by the schema before any container exists.
      const base = { action: "panelStart", jobId: newJobId(), target, masterKey, retentionDays: 30 };
      const hostile = {
        "upper-case key": { ...base, masterKey: masterKey.toUpperCase() },
        "63-character key": { ...base, masterKey: masterKey.slice(1) },
        "unknown key": { ...base, extra: "x" },
        "retentionDays 0": { ...base, retentionDays: 0 },
        "retentionDays 366": { ...base, retentionDays: 366 },
        "bad job id": { ...base, jobId: "op_../../etc" },
      };
      const creates = containerCreateCount;
      for (const [label, req] of Object.entries(hostile)) {
        let code = "accepted";
        try {
          await adapter.backups(req);
        } catch (err) {
          code = err instanceof ExecutorCodedError ? err.code : formatErr(err);
          assert(!secrets.some((s) => formatErr(err).includes(s)), `${label}: error text holds no secret`, "leak");
        }
        assert(code === "VALIDATION_ERROR", `${label} → VALIDATION_ERROR`, code);
      }
      assert(containerCreateCount === creates, "hostile requests created no container", String(containerCreateCount - creates));
    });

    // ---------------------------------------------------------------- (d) fetch through the CLI
    await runStep("panel-fetch-byte-for-byte", async () => {
      // The CLI hard-codes /run/hosting-panel/secrets and hp_backup_net; a wrapper injects this run's paths
      // through the CLI's own createAdapter hook. Everything else is the shipped main().
      const wrapper = path.join(tmpRoot, "panel-fetch-wrap.mjs");
      await writeFile(
        wrapper,
        [
          `import { main } from ${JSON.stringify(pathToFileURL(panelFetchCli).href)};`,
          `import { DockerEngineSocketAdapter } from ${JSON.stringify(pathToFileURL(executorDist).href)};`,
          "const [secretsRootDir, backupNetworkName, ...argv] = process.argv.slice(2);",
          "const chunks = []; for await (const c of process.stdin) chunks.push(c);",
          "process.exitCode = await main({ argv, stdin: Buffer.concat(chunks).toString('utf8'), env: process.env,",
          "  uid: process.getuid(), stdout: (l) => process.stdout.write(l + '\\n'), stderr: (l) => process.stderr.write(l + '\\n'),",
          "  createAdapter: (p) => new DockerEngineSocketAdapter({ pullMissingImages: false, secretsRootDir, backupNetworkName, ...p }) });",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const outDir = handoverDir;
      const outFiles = ["restore.pgdump", "restore.key", ".restore.pgdump.part", ".restore.key.part"];
      const present = async () => {
        const r = [];
        for (const f of outFiles) if ((await lstat(path.join(outDir, f)).catch(() => null)) !== null) r.push(f);
        return r;
      };
      const runCli = async (t, { keyFile = backupKeyFile, script = wrapper } = {}) => {
        const argv = [
          ...(script === wrapper ? [script, secretsRootDir, networkName] : [script]),
          "--endpoint", t.endpoint, "--region", t.region, "--bucket", t.bucket, "--prefix", t.prefix,
        ];
        assert(!argv.some((a) => a.includes(t.accessKeyId) || a.includes(t.secretAccessKey)), "no S3 key in argv", "key in argv");
        const before = new Set(await dockerListNames("container", "hp_bk_pf_"));
        const r = await execCmd(process.execPath, argv, {
          stdin: `${t.accessKeyId}\n${t.secretAccessKey}\n`,
          env: { HP_PANEL_DUMP_DIR: outDir, HP_BACKUP_KEY_FILE: keyFile },
          timeoutMs: 180_000,
        });
        const after = await dockerListNames("container", "hp_bk_pf_");
        const leaked = after.filter((n) => !before.has(n));
        for (const n of leaked) productNames.add(n);
        assert(leaked.length === 0, "CLI leaves no hp_bk_pf_ container", leaked.join(","));
        const out = r.stdout + r.stderr;
        for (const s of [t.accessKeyId, t.secretAccessKey, s3AccessKey, s3SecretKey, backupKey, masterKey]) {
          assert(!out.includes(s), `CLI output (exit ${String(r.code)}) holds no key`, "leak");
        }
        return r;
      };
      assert((await present()).length === 0, "no output files before", (await present()).join(","));

      // The shipped CLI itself, unchanged: malformed stdin is refused with exit 2 before anything else.
      const refused = await execCmd(process.execPath, [panelFetchCli, "--endpoint", target.endpoint, "--region", target.region, "--bucket", target.bucket], {
        stdin: "only-one-line\n",
        env: { HP_PANEL_DUMP_DIR: outDir, HP_BACKUP_KEY_FILE: backupKeyFile },
      });
      assert(refused.code === 2 && refused.stderr.trim() === "panel-fetch: refused", "shipped CLI refuses bad stdin with exit 2", `${String(refused.code)} ${refused.stderr}`);

      const wrongKeyFile = path.join(tmpRoot, "wrong-backup.key");
      await writeFile(wrongKeyFile, randomBytes(32).toString("hex"), { mode: 0o400 });
      const cases = [
        ["wrong backup.key", { t: target, keyFile: wrongKeyFile }, 5],
        ["wrong S3 keys", { t: { ...target, accessKeyId: `x${s3AccessKey}`, secretAccessKey: `y${s3SecretKey}` } }, 3],
        ["prefix with no copy", { t: { ...target, prefix: `empty-${runHex}` } }, 4],
      ];
      for (const [label, c, code] of cases) {
        const r = await runCli(c.t, { keyFile: c.keyFile ?? backupKeyFile });
        assert(r.code === code, `${label} → exit ${String(code)}`, `exit ${String(r.code)} ${r.stderr.trim()}`);
        const left = await present();
        assert(left.length === 0, `${label}: no file left`, left.join(","));
      }

      const ok = await runCli(target);
      assert(ok.code === 0, "fetch exits 0", `exit ${String(ok.code)} ${ok.stderr.trim()}`);
      const answer = JSON.parse(ok.stdout.trim());
      assert(answer.snapshotId === j5Snapshot?.snapshotId, "fetch returns the newest copy", `${answer.snapshotId} vs ${String(j5Snapshot?.snapshotId)}`);
      fetchedDump = await readFile(path.join(outDir, "restore.pgdump"));
      const fetchedKey = await readFile(path.join(outDir, "restore.key"), "utf8");
      assert(sha256(fetchedDump) === sha256(dumpBytes) && fetchedDump.equals(dumpBytes), "restore.pgdump matches by sha256 and byte for byte", `${sha256(fetchedDump)} vs ${sha256(dumpBytes)}`);
      assert(fetchedKey === masterKey, "restore.key is the master key", `len ${String(fetchedKey.length)}`);
      for (const f of ["restore.pgdump", "restore.key"]) {
        const st = await stat(path.join(outDir, f));
        assert((st.mode & 0o777) === 0o600, `${f} mode 0600`, (st.mode & 0o777).toString(8));
      }
      measured.fetchSha = sha256(fetchedDump);
    });

    // ---------------------------------------------------------------- (e) restore into an empty database
    let restoredFingerprint = null;
    await runStep("panel-restore-into-empty", async () => {
      assert(fetchedDump !== null, "fetched dump available", "fetch step failed");
      await psql(pg2Name, "postgres", `CREATE ROLE hosting_panel LOGIN PASSWORD ${lit(restorePw)};`);
      await psql(pg2Name, "postgres", "CREATE DATABASE hosting_panel OWNER postgres; \\c hosting_panel\nCREATE TABLE stale (x int);");
      const t0 = performance.now();
      for (const args of [
        ["dropdb", "-U", "postgres", "--force", "--if-exists", "hosting_panel"],
        ["createdb", "-U", "postgres", "-O", "hosting_panel", "hosting_panel"],
      ]) {
        const r = await docker(["exec", pg2Name, ...args]);
        assert(r.ok, `${args[0]} exits 0`, r.stderr);
      }
      const restore = await asPanelUser(["pg_restore", "--dbname=hosting_panel", "--no-owner", "--exit-on-error"], fetchedDump);
      measured.restoreMs = Math.round(performance.now() - t0);
      assert(restore.ok, "pg_restore exits 0", restore.stderr.slice(0, 600));

      const src = await tableFingerprint(pg1Name, "hosting_panel");
      restoredFingerprint = await tableFingerprint(pg2Name, "hosting_panel");
      assert(!restoredFingerprint.tables.includes("stale"), "old database replaced", "stale table survived");
      assert(src.rows === restoredFingerprint.rows, "per-table row counts and md5 match the source", "differ");
      measured.tableCount = src.tables.length;
      const foreign = await psql(
        pg2Name,
        "hosting_panel",
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'hosting_panel';",
      );
      assert(foreign.trim() === "0", "every public relation owned by hosting_panel", foreign.trim());
      const dbOwner = await psql(pg2Name, "postgres", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'hosting_panel';");
      assert(dbOwner.trim() === "hosting_panel", "database owned by hosting_panel", dbOwner.trim());
      const restoredMigrations = (await psql(pg2Name, "hosting_panel", "SELECT filename FROM schema_migrations ORDER BY 1;")).split("\n").filter(Boolean);
      assert(JSON.stringify(restoredMigrations) === JSON.stringify(migrationFiles), "schema_migrations matches the repo", restoredMigrations.join(","));
      const awkHex = await psql(pg2Name, "hosting_panel", `SELECT encode(convert_to(name, 'UTF8'), 'hex') FROM sites WHERE id = 'site1_${marker}';`);
      assert(awkHex.trim() === Buffer.from(awkward, "utf8").toString("hex"), "awkward value intact", awkHex.trim().slice(0, 40));

      // The recipe of restore-panel.sh that reads the migrations held by a copy.
      const AWK = "/^COPY public\\.schema_migrations /{on=1;next} /^\\\\\\.$/{on=0} on{print $1}";
      const readMigrations = async (dump) => {
        const r = await docker(
          ["exec", "-i", pg2Name, "sh", "-c", `pg_restore --data-only --table=schema_migrations --file=- | awk -F '\t' "$1"`, "sh", AWK],
          { stdin: dump },
        );
        assert(r.ok, "migration reader exits 0", r.stderr);
        return r.stdout.split("\n").filter(Boolean);
      };
      const inCopy = await readMigrations(fetchedDump);
      assert(JSON.stringify(inCopy) === JSON.stringify(migrationFiles), "reader lists the copy's migrations", inCopy.join(","));
      const unknown = "9999_swarmtest_unknown.sql";
      await psql(pg2Name, "postgres", "CREATE DATABASE hp_swarmtest_probe;");
      await psql(
        pg2Name,
        "hp_swarmtest_probe",
        `CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); INSERT INTO schema_migrations (filename) VALUES ${[...migrationFiles, unknown].map((f) => `(${lit(f)})`).join(",")};`,
      );
      const probeDump = await docker(["exec", pg2Name, "pg_dump", "-U", "postgres", "--format=custom", "hp_swarmtest_probe"]);
      assert(probeDump.ok, "probe dump made", probeDump.stderr);
      const probeList = await readMigrations(probeDump.stdoutBuf);
      const notInRepo = probeList.filter((f) => !migrationFiles.includes(f));
      assert(JSON.stringify(notInRepo) === JSON.stringify([unknown]), "a copy holding an unknown migration is seen", notInRepo.join(","));
      await docker(["exec", pg2Name, "dropdb", "-U", "postgres", "hp_swarmtest_probe"]);
    });

    // ---------------------------------------------------------------- (f) the SQL leaves nothing unfinished
    await runStep("panel-sql-leaves-nothing-unfinished", async () => {
      assert(restoredFingerprint !== null, "restored database available", "restore step failed");
      const M = marker;
      const finished = `
SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (
  SELECT t::text AS x FROM operations t WHERE id = 'opdone_${M}'
  UNION ALL SELECT t::text FROM operation_steps t WHERE id = 'st1_${M}'
  UNION ALL SELECT t::text FROM outbox_events t WHERE id = 'ev3_${M}'
  UNION ALL SELECT t::text FROM quota_reservations t WHERE id = 'qr2_${M}'
  UNION ALL SELECT t::text FROM sites t WHERE id = 'site1_${M}'
  UNION ALL SELECT (t.id, t.status, t.snapshot_id, t.size_bytes, t.finished_at)::text FROM site_backups t WHERE id IN ('bk1_${M}', 'bk3_${M}')
) s;`;
      const finishedBefore = await psql(pg2Name, "hosting_panel", finished);
      const sqlFile = await readFile(path.join(repoRoot, "infra/linux/hp-restore-panel.sql"));
      const runSql = () => asPanelUser(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", "hosting_panel", "-f", "-"], sqlFile);
      const r1 = await runSql();
      assert(r1.ok, "first run exits 0", r1.stderr);
      const afterFirst = (await tableFingerprint(pg2Name, "hosting_panel")).rows;
      const r2 = await runSql();
      assert(r2.ok, "second run exits 0", r2.stderr);
      assert((await tableFingerprint(pg2Name, "hosting_panel")).rows === afterFirst, "second run changes nothing", "differs");

      const q = async (sql) => (await psql(pg2Name, "hosting_panel", sql)).trim();
      const expectEq = async (label, sql, want) => {
        const got = await q(sql);
        assert(got === want, label, got);
      };
      await expectEq("panel copy operation → succeeded", `SELECT status FROM operations WHERE id = 'oppanel_${M}';`, "succeeded");
      await expectEq("its open steps → succeeded", `SELECT string_agg(status, ',' ORDER BY id) FROM operation_steps WHERE operation_id = 'oppanel_${M}';`, "succeeded,succeeded");
      await expectEq(
        "last panel copy set from the operation's start",
        `SELECT (s.last_panel_backup_at = o.started_at)::text || ',' || s.last_panel_backup_status || ',' || coalesce(s.last_panel_backup_problem, 'null') FROM backup_settings s, operations o WHERE o.id = 'oppanel_${M}';`,
        "true,succeeded,null",
      );
      await expectEq(
        "other open operations → failed OPERATION_INTERRUPTED",
        `SELECT string_agg(status || ':' || coalesce(error_code, '') || ':' || (lease_expires_at IS NULL)::text || ':' || (completed_at IS NOT NULL)::text, ',' ORDER BY id) FROM operations WHERE id IN ('opqueued_${M}', 'oprun_${M}', 'opunk_${M}');`,
        "failed:OPERATION_INTERRUPTED:true:true,failed:OPERATION_INTERRUPTED:true:true,failed:OPERATION_INTERRUPTED:true:true",
      );
      await expectEq(
        "steps: pending → cancelled, running/unknown → failed",
        `SELECT string_agg(id || '=' || status, ',' ORDER BY id) FROM operation_steps WHERE id IN ('st2_${M}', 'st3_${M}', 'st4_${M}', 'st5_${M}');`,
        `st2_${M}=cancelled,st3_${M}=failed,st4_${M}=cancelled,st5_${M}=failed`,
      );
      await expectEq("outbox pending/processing → failed", `SELECT string_agg(status, ',' ORDER BY id) FROM outbox_events;`, "failed,failed,published");
      await expectEq("quota pending → released", `SELECT string_agg(status, ',' ORDER BY id) FROM quota_reservations;`, "released,committed");
      await expectEq(
        "running backup → failed interrupted",
        `SELECT status || ':' || problem || ':' || (finished_at IS NOT NULL)::text FROM site_backups WHERE id = 'bk2_${M}';`,
        "failed:interrupted:true",
      );
      await expectEq(
        "running restore → failed interrupted",
        `SELECT restore_status || ':' || restore_problem FROM site_backups WHERE id = 'bk1_${M}';`,
        "failed:interrupted",
      );
      await expectEq(
        "prepared archive cleared",
        `SELECT count(*) FROM site_backups WHERE archive_status IS NOT NULL OR archive_operation_id IS NOT NULL OR archive_ready_until IS NOT NULL;`,
        "0",
      );
      await expectEq("nightly_run_started_at cleared", `SELECT count(*) FROM backup_settings WHERE nightly_run_started_at IS NOT NULL;`, "0");
      await expectEq("deploying/maintenance sites → degraded", `SELECT string_agg(status, ',' ORDER BY id) FROM sites;`, "ready,degraded,degraded");
      await expectEq("every session deleted", `SELECT count(*) FROM user_sessions;`, "0");
      await expectEq(
        "nothing left open anywhere",
        `SELECT (SELECT count(*) FROM operations WHERE status IN ('queued','processing','accepted','reconciling','unknown')) + (SELECT count(*) FROM operation_steps WHERE status IN ('pending','running','unknown')) + (SELECT count(*) FROM outbox_events WHERE status IN ('pending','processing')) + (SELECT count(*) FROM site_backups WHERE status = 'running' OR restore_status = 'running');`,
        "0",
      );
      assert((await psql(pg2Name, "hosting_panel", finished)) === finishedBefore, "finished rows unchanged", "changed");
    });

    // ---------------------------------------------------------------- (f2) a hostile copy runs nothing
    await runStep("panel-restore-hostile-copy", async () => {
      // A CHECK on a filled table calls a volatile function while the rows load (an expression index cannot:
      // its function must be IMMUTABLE, and PostgreSQL refuses RESET in a non-volatile function).
      const pwned = `/tmp/hp_swarmtest_${runHex}_pwned`;
      const db = (n) => `hp_swarmtest_hostile_${n}`;
      await psql(pg2Name, "postgres", `CREATE DATABASE ${db("src")};`);
      await psql(
        pg2Name,
        db("src"),
        `CREATE FUNCTION public.hp_take_over(x int) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN RESET ROLE; COPY (SELECT 1) TO PROGRAM ${lit(`touch ${pwned}`)}; RETURN true; END $f$;
CREATE TABLE public.hostile (x int CHECK (public.hp_take_over(x))); INSERT INTO hostile VALUES (1);`,
      );
      const made = await docker(["exec", pg2Name, "pg_dump", "-U", "postgres", "--format=custom", db("src")]);
      assert(made.ok, "hostile copy made", made.stderr);
      const exists = async () => (await docker(["exec", pg2Name, "test", "-e", pwned])).ok;
      const fresh = async (n) => {
        await docker(["exec", pg2Name, "rm", "-f", pwned]);
        const r = await docker(["exec", pg2Name, "createdb", "-U", "postgres", "-O", "hosting_panel", db(n)]);
        assert(r.ok, `createdb ${db(n)} exits 0`, r.stderr);
      };

      await fresh("old");
      const old = await docker(
        ["exec", "-i", pg2Name, "pg_restore", "-U", "postgres", `--dbname=${db("old")}`, "--role=hosting_panel", "--no-owner", "--exit-on-error"],
        { stdin: made.stdoutBuf },
      );
      assert(await exists(), "control: loaded as superuser with --role, the copy runs its program", `exit ${String(old.code)}, no file`);

      await fresh("new");
      const now = await asPanelUser(["pg_restore", `--dbname=${db("new")}`, "--no-owner", "--exit-on-error"], made.stdoutBuf);
      assert(!now.ok && now.stderr.includes("pg_execute_server_program"), "the product's way fails on the program", `exit ${String(now.code)} ${now.stderr.slice(0, 300)}`);
      assert(!(await exists()), "the product's way runs no program", "file appeared");
      for (const n of ["src", "old", "new"]) await docker(["exec", pg2Name, "dropdb", "-U", "postgres", "--force", db(n)]);
    });

    // ---------------------------------------------------------------- (f3) the site count of a second run runs nothing
    await runStep("panel-count-hostile-copy", async () => {
      // Made with an owner's rights only: the superuser's search path ("$user" first) finds postgres.sites.
      const pwned = `/tmp/hp_swarmtest_${runHex}_counted`;
      const db = (n) => `hp_swarmtest_count_${n}`;
      try {
        await psql(pg2Name, "postgres", `CREATE DATABASE ${db("src")} OWNER hosting_panel;`);
        await psql(
          pg2Name,
          db("src"),
          `CREATE TABLE public.sites (id int); INSERT INTO public.sites VALUES (1), (2);
CREATE SCHEMA postgres;
CREATE FUNCTION postgres.hp_count_trap() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $f$
BEGIN COPY (SELECT 1) TO PROGRAM ${lit(`touch ${pwned}`)}; RETURN true; END $f$;
CREATE VIEW postgres.sites AS SELECT 1 AS id WHERE postgres.hp_count_trap();`,
          { user: "hosting_panel" },
        );
        const made = await docker(["exec", pg2Name, "pg_dump", "-U", "postgres", "--format=custom", db("src")]);
        assert(made.ok, "hostile copy made", made.stderr);
        const created = await docker(["exec", pg2Name, "createdb", "-U", "postgres", "-O", "hosting_panel", db("dst")]);
        assert(created.ok, `createdb ${db("dst")} exits 0`, created.stderr);
        const load = await asPanelUser(["pg_restore", `--dbname=${db("dst")}`, "--no-owner", "--exit-on-error"], made.stdoutBuf);
        assert(load.ok, "the copy loads the product's way without error", `exit ${String(load.code)} ${load.stderr.slice(0, 300)}`);
        const exists = async () => (await docker(["exec", pg2Name, "test", "-e", pwned])).ok;
        await docker(["exec", pg2Name, "rm", "-f", pwned]);

        const now = await asPanelUser(["psql", "-X", "-tAc", "SELECT count(*) FROM public.sites", "-d", db("dst")]);
        assert(now.ok && now.stdout.trim() === "2", "the product's count reads public.sites", `exit ${String(now.code)} ${now.stdout.trim()} ${now.stderr.slice(0, 300)}`);
        assert(!(await exists()), "the product's count runs no program", "file appeared");

        const old = await docker(["exec", pg2Name, "psql", "-X", "-tAc", "SELECT count(*) FROM sites", "-U", "postgres", "-d", db("dst")]);
        assert(await exists(), "control: counted as the superuser, the copy runs its program", `exit ${String(old.code)} ${old.stdout.trim()} ${old.stderr.slice(0, 300)}, no file`);
      } finally {
        await docker(["exec", pg2Name, "rm", "-f", pwned]);
        for (const n of ["src", "dst"]) await docker(["exec", pg2Name, "dropdb", "-U", "postgres", "--force", "--if-exists", db(n)]);
      }
    });

    // ---------------------------------------------------------------- (g) keep rule
    await runStep("panel-keep-rule", async () => {
      const copyDir = path.join(tmpRoot, "oldcopy");
      await mkdir(copyDir, { mode: 0o755 });
      await writeFile(path.join(copyDir, "panel.dump"), dumpBytes, { mode: 0o644 });
      await writeFile(path.join(copyDir, "secrets-master.key"), randomBytes(32).toString("hex"), { mode: 0o644 });
      const DAY = 86_400_000;
      const stamp = (days) => new Date(Date.now() - days * DAY).toISOString().replace("T", " ").slice(0, 19);
      const scenario = async (prefix, ages, mk) => {
        const script = [
          "set -eu",
          "restic $RO init >/dev/null",
          'for t in "$@"; do restic $RO backup -q --host hosting-panel --time "$t" /backup/panel >/dev/null; done',
        ].join("\n");
        const r = await myRestic(prefix, ages.map(stamp), { script, copyDir });
        assert(r.ok, `old copies made in ${prefix}/panel`, r.stderr);
        assert((await snapshots(prefix)).length === ages.length, `${String(ages.length)} old copies present`, "count");
        const jobId = newJobId();
        await copyFile(dumpPath, path.join(handoverDir, `${jobId}.dump`));
        await chmod(path.join(handoverDir, `${jobId}.dump`), 0o640);
        await adapter.backups({ action: "panelStart", jobId, target: { ...target, prefix }, masterKey: mk, retentionDays: 7 });
        const st = await pollJob(adapter, jobId);
        assert(st.state === "succeeded", `panelStart on ${prefix} succeeds`, JSON.stringify(st));
        await rm(path.join(handoverDir, `${jobId}.dump`), { force: true });
        const left = await snapshots(prefix);
        const newest = Math.max(...left.map((s) => Date.parse(s.time)));
        const kept = left
          .map((s) => Math.round((newest - Date.parse(s.time)) / DAY))
          .sort((a, b) => a - b);
        return { kept, st, left };
      };
      const a = await scenario(`keep-a-${runHex}`, [1, 3, 5, 10, 20, 40], masterKey8);
      assert(JSON.stringify(a.kept) === JSON.stringify([0, 1, 3, 5]), "7 days from the newest: copies of 0,1,3,5 days kept, 10,20,40 dropped", JSON.stringify(a.kept));
      const b = await scenario(`keep-b-${runHex}`, [30, 60, 90, 120], masterKey);
      assert(JSON.stringify(b.kept) === JSON.stringify([0, 30, 60]), "never fewer than 3: 0,30,60 kept", JSON.stringify(b.kept));

      const fetchDir = path.join(tmpRoot, "fetch8");
      const got = await adapter.fetchPanelCopy({ ...target, prefix: `keep-a-${runHex}` }, fetchDir);
      const newestA = a.left.reduce((x, y) => (Date.parse(x.time) >= Date.parse(y.time) ? x : y));
      assert(got.ok && got.snapshotId === newestA.id, "fetch returns the newest copy", JSON.stringify(got));
      assert((await readFile(path.join(fetchDir, "restore.key"), "utf8")) === masterKey8, "its key is the newest job's key", "other key");
    });

    // ---------------------------------------------------------------- (h) a site back from nothing
    await runStep("site-back-from-nothing", async () => {
      const t0 = performance.now();
      const runSql = mariadbRootExec({ request: dockerRequest, socketPath: SOCKET_PATH, apiPrefix: "" }, dbContainerName);
      const sql = async (label, text) => {
        const r = await runSql(text);
        assert(r.exitCode === 0, label, r.stderr.toString("utf8"));
        return r.stdout.toString("utf8");
      };
      const dbDeadline = Date.now() + 120_000;
      for (;;) {
        try {
          await adapter.siteDatabases({ siteId, op: "list" });
          break;
        } catch (err) {
          if (Date.now() > dbDeadline) throw err;
          await sleep(500);
        }
      }
      const siteMarker = `SITE_${marker}`;
      // db.provision stand-in (see the record): database, user and a marker row.
      const provision = () =>
        sql(
          "provision the site database",
          `CREATE DATABASE \`${siteDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '${siteDbUser}'@'%' IDENTIFIED BY '${siteDbPass}'; GRANT ALL ON \`${siteDbName}\`.* TO '${siteDbUser}'@'%'; FLUSH PRIVILEGES;`,
        );
      await provision();
      await sql("seed marker page row", `CREATE TABLE \`${siteDbName}\`.hp_page (id INT PRIMARY KEY, body VARCHAR(255)); INSERT INTO \`${siteDbName}\`.hp_page VALUES (1, '${siteMarker}');`);

      // The site volume with the labels deployService gives it (docker-engine-adapter ensureVolume).
      const deployLabels = {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.site_id": siteId,
        "io.hostingpanel.service_instance_id": serviceInstanceId,
      };
      await dockerJson("POST", "/volumes/create", { Name: siteVolumeName, Labels: deployLabels });
      createdVolumes.add(siteVolumeName);
      const helper = async (suffix, user, script, stdin) => {
        const name = `${runId}_${suffix}`;
        createdContainers.add(name);
        const r = await docker(
          ["run", "--rm", "-i", "--name", name, "--network", "none", "--user", user, "--read-only", "--cap-drop", "ALL",
            ...(user === "0:0" ? ["--cap-add", "CHOWN", "--cap-add", "FOWNER"] : []),
            "--security-opt", "no-new-privileges:true", "--entrypoint", "sh", "-v", `${siteVolumeName}:/var/www/html`,
            WORDPRESS_IMAGE, "-c", script],
          stdin === undefined ? {} : { stdin },
        );
        createdContainers.delete(name);
        assert(r.ok, `helper ${suffix}`, r.stderr);
        return r.stdout.trim();
      };
      await helper("volinit", "0:0", "chown 33:33 /var/www/html && chmod 0755 /var/www/html");
      const indexPhp = [
        "<?php",
        `$m = @new mysqli('${SHARED_DB_ALIAS}', '${siteDbUser}', '${siteDbPass}', '${siteDbName}');`,
        "if ($m->connect_error) { http_response_code(500); echo \"DBERR\\n\"; exit; }",
        "$r = $m->query('SELECT body FROM hp_page WHERE id = 1')->fetch_row();",
        "echo 'OK|PAGE=' . ($r[0] ?? '') . '|FILE=' . trim((string)@file_get_contents(__DIR__ . '/marker.txt')) . \"\\n\";",
        "",
      ].join("\n");
      await helper("seed", "33:33", `cat > /var/www/html/index.php && printf '%s\\n' 'FILE_${marker}' > /var/www/html/marker.txt`, indexPhp);

      const startSite = async () => {
        createdContainers.add(siteContainerName);
        const r = await docker([
          "run", "-d", "--name", siteContainerName, "--network", networkName, "--user", "33:33", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges:true", "--entrypoint", "php",
          "--label", "io.hostingpanel.managed=true", "--label", `io.hostingpanel.site_id=${siteId}`,
          "--label", `io.hostingpanel.service_instance_id=${serviceInstanceId}`,
          "-v", `${siteVolumeName}:/var/www/html`, WORDPRESS_IMAGE, "-S", "0.0.0.0:8080", "-t", "/var/www/html",
        ]);
        assert(r.ok, "site container starts", r.stderr);
        return fetchPage();
      };
      const fetchPage = async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            const ip = (await dockerInspect("container", siteContainerName))?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
            const res = await fetch(`http://${ip}:8080/`, { signal: AbortSignal.timeout(2_000) });
            const text = await res.text();
            if (res.status === 200 || res.status === 500) return { status: res.status, text };
          } catch {
            // starting
          }
          await sleep(200);
        }
        return { status: 0, text: "" };
      };
      const page0 = await startSite();
      assert(page0.status === 200 && page0.text.includes(`PAGE=${siteMarker}`) && page0.text.includes(`FILE=FILE_${marker}`), "site answers 200 with its marker page", JSON.stringify(page0));
      const st0 = await adapter.backups({ action: "siteState", siteId, serviceInstanceId });
      assert(st0.filesVolume === true && st0.container === true, "siteState before: volume and container", JSON.stringify(st0));

      const bk = newJobId();
      await adapter.backups({ action: "start", jobId: bk, siteId, serviceInstanceId, target });
      const bkDone = await pollJob(adapter, bk);
      assert(bkDone.state === "succeeded", "site backup succeeds", JSON.stringify(bkDone));
      const snapshotId = bkDone.snapshot.snapshotId;

      const startTimes = async () => {
        const out = {};
        for (const n of [s3ContainerName, pg1Name, pg2Name, dbContainerName]) {
          out[n] = (await dockerInspect("container", n))?.State?.StartedAt ?? null;
        }
        return out;
      };
      const times0 = await startTimes();

      // Lose everything: the container, its volume, the database.
      await docker(["rm", "-f", siteContainerName]);
      createdContainers.delete(siteContainerName);
      const vr = await docker(["volume", "rm", siteVolumeName]);
      assert(vr.ok, "site volume removed", vr.stderr);
      await sql("drop the site database", `DROP DATABASE \`${siteDbName}\`;`);
      const st1 = await adapter.backups({ action: "siteState", siteId, serviceInstanceId });
      assert(JSON.stringify(st1) === JSON.stringify({ filesVolume: false, container: false }), "siteState: {filesVolume:false, container:false}", JSON.stringify(st1));

      const restore = async (snap, createVolume) => {
        const jobId = newJobId();
        await adapter.backups({
          action: "restore", jobId, siteId, serviceInstanceId, target, snapshotId: snap,
          ...(createVolume ? { createVolume: true } : {}),
        });
        return { jobId, st: await pollJob(adapter, jobId, 300_000) };
      };
      const volExists = async () => (await dockerInspect("volume", siteVolumeName)) !== null;

      // No flag and no volume: refused at prepare, nothing created.
      const n1 = await restore(snapshotId, false);
      assert(n1.st.state === "failed" && n1.st.failure === "restore_prepare_failed", "no flag, no volume → restore_prepare_failed", JSON.stringify(n1.st));
      assert(!(await volExists()), "no volume created", "volume exists");
      const n1Left = (await myProductLeftovers()).filter((n) => n.includes(n1.jobId));
      assert(n1Left.length === 0, "nothing of the refused restore left", n1Left.join(","));

      await provision();
      // createVolume with an unknown snapshot: fails and removes the volume it made.
      const n2 = await restore(randomBytes(32).toString("hex"), true);
      assert(n2.st.state === "failed", "unknown snapshot → failed", JSON.stringify(n2.st));
      assert(!(await volExists()), "volume made by the failed restore removed", "volume left");
      const n2Left = (await myProductLeftovers()).filter((n) => n.includes(n2.jobId));
      assert(n2Left.length === 0, "nothing of the failed restore left", n2Left.join(","));

      const tR = performance.now();
      const good = await restore(snapshotId, true);
      measured.siteRestoreMs = Math.round(performance.now() - tR);
      assert(good.st.state === "succeeded", "restore with createVolume succeeds", JSON.stringify(good.st));
      const vol = await dockerInspect("volume", siteVolumeName);
      assert(vol !== null, "volume created", "missing");
      createdVolumes.add(siteVolumeName);
      const sorted = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
      assert(sorted(vol.Labels) === sorted(deployLabels), "volume carries a deployed site's labels", JSON.stringify(vol.Labels));
      const rootMode = await helper("rootstat", "33:33", "stat -c '%u:%g %a' /var/www/html");
      assert(rootMode === "33:33 755", "volume root 33:33 0755", rootMode);

      const page1 = await startSite(); // deploy stand-in
      assert(page1.status === 200 && page1.text.includes(`PAGE=${siteMarker}`) && page1.text.includes(`FILE=FILE_${marker}`), "after restore and deploy: 200 with the marker", JSON.stringify(page1));

      // Volume present, no flag: the ordinary restore, as before.
      const plain = await restore(snapshotId, false);
      assert(plain.st.state === "succeeded", "restore over a present volume without the flag succeeds", JSON.stringify(plain.st));
      const page2 = await fetchPage();
      assert(page2.status === 200 && page2.text.includes(`PAGE=${siteMarker}`), "site still 200 with the marker", JSON.stringify(page2));

      const times1 = await startTimes();
      assert(JSON.stringify(times0) === JSON.stringify(times1), "other containers of the run not restarted (R115)", JSON.stringify({ times0, times1 }));
      measured.siteMs = Math.round(performance.now() - t0);
    });
  } finally {
    // ---------------------------------------------------------------- (i) nothing left
    const leftoversBefore = await myProductLeftovers().catch((err) => [`list failed: ${formatErr(err)}`]);
    await cleanup();
    total += 1;
    const problems = [];
    if (leftoversBefore.length > 0) problems.push(`product objects left by the run: ${leftoversBefore.join(",")}`);
    for (const kind of ["container", "volume", "network"]) {
      for (const filter of [runId, `swarmtest_${runHex}`]) {
        const names = await dockerListNames(kind, filter).catch(() => []);
        if (names.length > 0) problems.push(`${kind}: ${names.join(",")}`);
      }
    }
    const stillMine = await myProductLeftovers().catch(() => []);
    if (stillMine.length > 0) problems.push(`hp_bk_ after clean-up: ${stillMine.join(",")}`);
    if (tmpRoot && (await lstat(tmpRoot).catch(() => null)) !== null) problems.push(`temp folder ${tmpRoot} still there`);
    if (problems.length === 0) {
      passed += 1;
      logLine("PASS nothing-left");
    } else {
      failures.push("nothing-left");
      logLine(`FAIL nothing-left: no object of the run left / ${problems.join("; ")}`);
    }
    measured.totalMs = Math.round(performance.now() - startedAt);
    logLine(`INFO measured ${inspect(measured, { breakLength: Infinity, depth: 3 })}`);
    logLine(`RESULT ${String(passed)}/${String(total)} passed in ${String(Math.round(measured.totalMs / 1000))}s`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
}

await main();
