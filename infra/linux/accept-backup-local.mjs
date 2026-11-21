#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for the local backup target (HCP-SPEC-004 M3, ADR-0032).
 *
 * Drives the built DockerEngineSocketAdapter.backups(...) with backupLocalRoot = a throw-away 0700 folder, a stand-in
 * WordPress + MariaDB 12.3.3 site on an isolated bridge network and, for the legacy-coexistence step only, a RustFS
 * 1.0.5 S3 server. Rootless like accept-m3-backups.mjs: the executor ids are the ones of the user running the script.
 * No host port is published, nothing is pulled, no prune is ever run.
 *
 * Machine safety: every Docker resource starts with "hp_swarmtest_" (the managed site volume with
 * "hp_vol_svc_swarmtest_") or is a job object whose id this run generated (hp_bk_<jobId>_*, volume hp_bk_<jobId>); each
 * is removed by exact name in `finally`, on SIGINT and on SIGTERM. The live hp_* containers are never read or touched.
 *
 * Steps (RESULT n/m passed; a step that cannot run is reported as skipped in the RESULT line, never as a pass):
 *   setup, local-init-and-test (BKP-02), local-backup-manual (BKP-02), local-repo-ciphertext-only (BKP-04),
 *   local-modes-and-users (BKP-04/05), local-hostile (BKP-05), local-readonly-and-no-space (BKP-05/06, root only),
 *   local-restore (BKP-10), local-export-zip (BKP-12), panel-local-and-dr (BKP-16 executor part),
 *   legacy-s3-coexists (BKP-01/03/11 executor part), no-secrets, cleanup.
 * HP_ACCEPT_ROOT_CASES=1 as root enables the read-only and small-filesystem cases (mount needs root); otherwise they are
 * reported as SKIP with the reason.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const executorDist = path.resolve(repoRoot, "apps/docker-executor/dist/index.js");
const panelFetchCli = path.resolve(repoRoot, "apps/docker-executor/dist/cli/panel-fetch.js");
const pinsDir = path.resolve(repoRoot, "apps/docker-executor/test/fixtures/site-type-pins");

const {
  BACKUP_ARCHIVE_TTL_MS,
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  SHARED_DB_ALIAS,
  buildAwsSharedCredentials,
  buildSharedDatabaseContainerPayload,
  getManagedVolumeName,
  mariadbRootExec,
  s3Request,
} = await import(pathToFileURL(executorDist).href);

// Not re-exported by the package index: the marker text is the guard's own.
const { localTargetMarkerContent } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/local-target-guard.js")).href
);

const {
  DEFAULT_PHP_VERSION,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  SITE_FILE_CHUNK_BYTES,
  resolveWordpressImage,
  siteDatabaseFullName,
  siteDatabasePrefix,
} = await import(pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href);

const SOCKET_PATH = "/var/run/docker.sock";
// Same pin as accept-m3-backups.mjs (the legacy S3 path).
const RUSTFS_IMAGE =
  "rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74";
const WORDPRESS_IMAGE = resolveWordpressImage(DEFAULT_PHP_VERSION);
const MARKER_NAME = ".hp-local-target";

const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;
const networkName = `${runId}_net`;
const s3ContainerName = `${runId}_s3`;
const dbContainerName = `${runId}_db`;
const siteContainerName = `${runId}_site`;
const seedContainerName = `${runId}_seed`;
const lsContainerName = `${runId}_ls`;
const rcContainerName = `${runId}_rc`;

const siteId = `site_swarmtest_${runHex}`;
const serviceInstanceId = `svc_swarmtest_${runHex}`;
const siteVolumeName = getManagedVolumeName(serviceInstanceId, "html");
const dbPrefix = siteDatabasePrefix(siteId);
const db1Name = dbPrefix;
const db2Name = siteDatabaseFullName(dbPrefix, "shop");

const execUid = process.getuid();
const execGid = process.getgid();
const uidGid = `${String(execUid)}:${String(execGid)}`;
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && execUid === 0;

const createdContainers = new Set();
const createdVolumes = new Set();
const activeChildProcs = new Set();
const tempDirs = [];
const mounts = [];
let createdNetwork = false;

const secretsToGuard = new Set();
const capturedContainerSpecs = [];
const capturedResultJsons = [];
const capturedErrorMessages = [];
const capturedOutputLines = [];
const runJobIds = new Set();
const localJobIds = new Set();
let containerCreateCount = 0;
// Awaited right before the adapter creates a container whose name matches (once).
const createHooks = [];

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
  runJobIds.add(id);
  return id;
}

function dockerRequest(method, reqPath, jsonBody, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody), "utf8");
    const headers = payload
      ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
      : {};
    const req = http.request({ socketPath: SOCKET_PATH, path: reqPath, method, headers }, (res) => {
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

async function dockerJson(method, reqPath, jsonBody, okStatuses = [200, 201, 204], timeoutMs = 60_000) {
  const res = await dockerRequest(method, reqPath, jsonBody, { timeoutMs });
  if (!okStatuses.includes(res.statusCode)) {
    throw new Error(`Docker ${method} ${reqPath} failed (${String(res.statusCode)}): ${res.body.toString("utf8")}`);
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
      { encoding: "utf8", timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({
          ok: false,
          code: typeof err.code === "number" ? err.code : 1,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" && stderr !== "" ? stderr : err.message,
        });
      },
    );
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}

const docker = (args, opts = {}) => execCmd("docker", args, opts);

async function dockerInspectContainer(nameOrId) {
  const res = await docker(["inspect", nameOrId]);
  if (!res.ok) return null;
  const arr = JSON.parse(res.stdout);
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

async function dockerListNames(kind, filterName) {
  const args =
    kind === "ps"
      ? ["ps", "-a", "--filter", `name=${filterName}`, "--format", "{{.Names}}"]
      : kind === "volume"
        ? ["volume", "ls", "--filter", `name=${filterName}`, "--format", "{{.Name}}"]
        : ["network", "ls", "--filter", `name=${filterName}`, "--format", "{{.Name}}"];
  const res = await docker(args);
  assert(res.ok, `docker ${kind} ls succeeds`, res.stderr);
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** hp_bk_* names that belong to a job id this run generated (never another run's, never the live host's). */
async function myJobObjects(kind) {
  const all = await dockerListNames(kind, "hp_bk_").catch(() => []);
  return all.filter((n) => [...runJobIds].some((j) => n.includes(j)));
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
      const candidate = `10.${String(second)}.${String(third)}.0/24`;
      const c = parseCidr(candidate);
      const overlaps = used.some((u) => ((c.net & u.mask) >>> 0) === u.net || ((u.net & c.mask) >>> 0) === c.net);
      if (!overlaps) return candidate;
    }
  }
  return null;
}

const decodeXmlEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const xmlTags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => decodeXmlEntities(m[1]));

async function s3ListAll(target, prefix = "") {
  const objects = [];
  let token;
  for (;;) {
    const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const res = await s3Request(target, "GET", "", undefined, query);
    assert(res.status === 200, "S3 ListObjectsV2 returns 200", `status=${String(res.status)}`);
    const xml = res.body.toString("utf8");
    for (const entry of xml.split("<Contents>").slice(1)) {
      const key = xmlTags(entry, "Key")[0];
      if (key) objects.push({ key, size: Number(xmlTags(entry, "Size")[0] ?? "0") });
    }
    if (xmlTags(xml, "IsTruncated")[0] !== "true") return objects;
    token = xmlTags(xml, "NextContinuationToken")[0];
    if (!token) return objects;
  }
}

// ---------------------------------------------------------------------------------------------- local tree helpers

/** Every entry below `dir` (lstat, never followed): "<type> <mode> <uid>:<gid> <size> <relative path>", sorted. */
async function treeEntries(dir) {
  const out = [];
  const walk = async (abs, rel) => {
    for (const name of (await readdir(abs)).sort()) {
      const full = path.join(abs, name);
      const relName = rel === "" ? name : `${rel}/${name}`;
      const st = await lstat(full);
      const type = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "o";
      out.push({ rel: relName, full, type, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, size: st.size, ino: st.ino });
      if (type === "d") await walk(full, relName);
    }
  };
  await walk(dir, "");
  return out;
}

/** Stable text of a tree (names, types, modes, owners, sizes): equal before and after means nothing was written. */
async function treeFingerprint(dir) {
  return (await treeEntries(dir))
    .map((e) => `${e.type} ${e.mode.toString(8)} ${String(e.uid)}:${String(e.gid)} ${String(e.size)} ${e.rel}`)
    .join("\n");
}

/** Reads every regular file below `dir` and returns the (file, needle) pairs found. Unreadable files are an error. */
async function scanTreeForNeedles(dir, needles) {
  const hits = [];
  let files = 0;
  let bytes = 0;
  const bufs = needles.map((n) => (Buffer.isBuffer(n) ? n : Buffer.from(n, "utf8")));
  for (const e of await treeEntries(dir)) {
    if (e.type !== "f") continue;
    const data = await readFile(e.full);
    files += 1;
    bytes += data.length;
    bufs.forEach((n, i) => {
      if (data.includes(n)) hits.push({ file: e.rel, needle: i });
    });
  }
  return { hits, files, bytes };
}

// ------------------------------------------------------------------------------------------------ instrumentation

function instrumentAdapter(adapterInstance) {
  const client = adapterInstance.dockerClient;
  const origRequest = client.request.bind(client);
  client.request = async (method, endpointPath, body, opts) => {
    if (method === "POST" && endpointPath.startsWith("/containers/create")) {
      const idx = createHooks.findIndex((h) => h.re.test(endpointPath));
      if (idx >= 0) {
        const [hook] = createHooks.splice(idx, 1);
        await hook.fn();
      }
    }
    const res = await origRequest(method, endpointPath, body, opts);
    if (method === "POST" && endpointPath.startsWith("/containers/create")) {
      let containerId;
      try {
        containerId = JSON.parse(res.body.toString("utf8"))?.Id ?? null;
      } catch {
        containerId = null;
      }
      const createQueryName = /name=([^&]+)/.exec(endpointPath)?.[1];
      const containerName = createQueryName ? decodeURIComponent(createQueryName) : containerId;
      if (res.statusCode === 201 && containerId) {
        containerCreateCount += 1;
        createdContainers.add(containerName ?? containerId);
      }
      let inspect = null;
      if (res.statusCode === 201 && containerId) {
        const inspectRes = await origRequest("GET", `/containers/${encodeURIComponent(containerId)}/json`);
        if (inspectRes.statusCode === 200) inspect = JSON.parse(inspectRes.body.toString("utf8"));
      }
      capturedContainerSpecs.push({
        containerName,
        createPayload: body ?? null,
        createStatus: res.statusCode,
        createBody: res.statusCode === 201 ? null : res.body.toString("utf8"),
        inspect,
      });
    }
    return res;
  };

  const origBackups = adapterInstance.backups.bind(adapterInstance);
  adapterInstance.backups = async (req) => {
    try {
      const res = await origBackups(req);
      capturedResultJsons.push(JSON.stringify(res));
      return res;
    } catch (err) {
      capturedErrorMessages.push(formatErr(err));
      throw err;
    }
  };
  return adapterInstance;
}

async function pollBackupJob(adapterInstance, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapterInstance.backups({ action: "status", jobId });
    if (status.state !== "running") return status;
    await sleep(150);
  }
  throw new StepAssertionError(`job ${jobId} settles within ${String(timeoutMs)}ms`, "still running");
}

function scanObjectForSecrets(obj, secrets) {
  const text = JSON.stringify(obj);
  return [...secrets].filter((s) => s.length > 0 && text.includes(s));
}

// ------------------------------------------------------------------------------------------------------- cleanup

let cleanupPromise = null;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of activeChildProcs) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
    const leftoverJobContainers = await myJobObjects("ps");
    const containers = new Set([
      ...createdContainers,
      ...leftoverJobContainers,
      lsContainerName,
      seedContainerName,
      rcContainerName,
      siteContainerName,
      dbContainerName,
      s3ContainerName,
    ]);
    for (const c of containers) await docker(["rm", "-f", "-v", c]);
    const volumes = new Set([...createdVolumes, ...(await myJobObjects("volume")), siteVolumeName]);
    for (const v of volumes) await docker(["volume", "rm", v]);
    if (createdNetwork) await docker(["network", "rm", networkName]);
    for (const m of mounts) await execCmd("umount", ["-l", m]);
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  return cleanupPromise;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

// ------------------------------------------------------------------------------------------------------- main

async function main() {
  const startedAt = performance.now();
  let passed = 0;
  let total = 0;
  let skipped = 0;
  let fatalSetupFailure = false;

  async function runStep(name, fn, { abortOnFail = false } = {}) {
    total += 1;
    if (fatalSetupFailure) {
      logLine(`FAIL ${name}: skipped after setup failure`);
      return;
    }
    try {
      await fn();
      passed += 1;
      logLine(`PASS ${name}`);
    } catch (err) {
      capturedErrorMessages.push(formatErr(err));
      logLine(
        err instanceof StepAssertionError
          ? `FAIL ${name}: ${err.expected} / ${err.actual}`
          : `FAIL ${name}: step succeeds / ${formatErr(err)}`,
      );
      if (abortOnFail) fatalSetupFailure = true;
    }
  }
  const skip = (name, why) => {
    skipped += 1;
    logLine(`SKIP ${name}: ${why}`);
  };
  const info = (msg) => logLine(`INFO ${msg}`);

  let tmpRoot = "";
  let localRoot = "";
  let secretsRootDir = "";
  let backupWorkDir = "";
  let backupKeyFile = "";
  let handoverDir = "";
  let verifySecretsDir = "";
  let adapter = null;
  let adapterOptions = null;
  let runSql = null;
  let chosenSubnet = "";
  let siteIp = "";

  const targetId = `bkt_${randomBytes(16).toString("hex")}`;
  const localTarget = { kind: "local", targetId };
  const targetDir = () => path.join(localRoot, targetId);
  const leafDir = () => path.join(targetDir(), "sites", siteId);
  const panelDir = () => path.join(targetDir(), "panel");
  const leafInContainer = `/backup/repository/sites/${siteId}`;

  const s3AccessKey = `ak_${randomBytes(12).toString("hex")}`;
  const s3SecretKey = `hpSw#rm;T3st+/=${randomBytes(12).toString("hex")}`;
  const backupKey = randomBytes(32).toString("hex");
  const mariaRootPw = randomBytes(32).toString("hex");
  const masterKey = randomBytes(32).toString("hex");
  const siteDbUser = `wp_${runHex}`;
  const siteDbPass = randomBytes(16).toString("hex");
  const hpMailContent = `<?php // hp-mail-${runHex}\n`;
  const hpMailSha = createHash("sha256").update(hpMailContent).digest("hex");
  for (const s of [s3AccessKey, s3SecretKey, backupKey, mariaRootPw, masterKey, siteDbPass]) secretsToGuard.add(s);

  const markerFileName = `marker-${runHex}.txt`;
  const fileMarkerText = `MARKER-FILE-${runHex}-PLAINTEXT`;
  const db1MarkerText = `MARKER-DB1-${runHex}-ROW`;
  const db2MarkerText = `MARKER-DB2-${runHex}-ROW`;
  const plainNeedles = [fileMarkerText, db1MarkerText, db2MarkerText, db1Name, db2Name, backupKey, mariaRootPw, siteDbPass];

  let snapLocal1 = null;
  let s3Target = null;

  // ------------------------------------------------------------------------------ site helpers (set up in `setup`)
  const runSiteHelper = async (suffix, cmdArgs, opts = {}) => {
    const cName = `${runId}_${suffix}`;
    createdContainers.add(cName);
    try {
      return await docker([
        "run",
        ...(opts.stdin !== undefined ? ["-i"] : []),
        "--name",
        cName,
        "--network",
        "none",
        "--user",
        opts.user ?? "33:33",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        opts.entrypoint ?? "sh",
        "-v",
        `${siteVolumeName}:/var/www/html${opts.ro ? ":ro" : ""}`,
        WORDPRESS_IMAGE,
        ...cmdArgs,
      ], opts.stdin !== undefined ? { stdin: opts.stdin } : undefined);
    } finally {
      await docker(["rm", "-f", cName]);
      createdContainers.delete(cName);
    }
  };

  const captureSiteAndDbState = async () => {
    const hashRes = await runSiteHelper(
      "fhash",
      [
        "-c",
        "set -eu; cd /var/www/html; find . -type f ! -path './wp-content/mu-plugins/hp-mail.php' | LC_ALL=C sort | while IFS= read -r f; do sha256sum \"$f\"; done",
      ],
      { ro: true },
    );
    assert(hashRes.ok, "compute sha256 of site files", hashRes.stderr);
    const checksumParts = [];
    for (const db of [db1Name, db2Name]) {
      const tblRes = await runSql(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;`,
      );
      assert(tblRes.exitCode === 0, `list base tables of ${db}`, tblRes.stderr.toString("utf8"));
      const tables = tblRes.stdout.toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (tables.length > 0) {
        const csum = await runSql(`CHECKSUM TABLE ${tables.map((t) => `\`${db}\`.\`${t}\``).join(", ")};`);
        assert(csum.exitCode === 0, `CHECKSUM TABLE on ${db}`, csum.stderr.toString("utf8"));
        checksumParts.push(`${db}:\n${csum.stdout.toString("utf8").trim()}`);
      } else {
        checksumParts.push(`${db}:(none)`);
      }
    }
    const showCreates = [];
    for (const q of [
      `SHOW CREATE VIEW \`${db2Name}\`.v_hp_parent_child;`,
      `SHOW CREATE TRIGGER \`${db2Name}\`.tr_hp_child_ins;`,
      `SHOW CREATE TABLE \`${db2Name}\`.hp_parent;`,
      `SHOW CREATE TABLE \`${db2Name}\`.hp_child;`,
    ]) {
      const res = await runSql(q);
      if (res.exitCode !== 0) {
        // A dropped object is part of a broken state, not an error of the comparison.
        assert(/ERROR (1146|1360)\b/.test(res.stderr.toString("utf8")), `run ${q}`, res.stderr.toString("utf8"));
        showCreates.push(`MISSING ${q}`);
        continue;
      }
      // MariaDB's trigger recreation timestamp column (Created) is the only part not compared.
      showCreates.push(
        res.stdout.toString("utf8").trim().replace(/\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/, ""),
      );
    }
    return {
      fileHashesText: hashRes.stdout.trim(),
      checksumsText: checksumParts.join("\n"),
      showCreatesText: showCreates.join("\n---\n"),
    };
  };
  const sameState = (a, b) =>
    a.fileHashesText === b.fileHashesText && a.checksumsText === b.checksumsText && a.showCreatesText === b.showCreatesText;

  const assertNoRestoreLeftovers = async () => {
    const left = await runSiteHelper(
      "leftover",
      ["-c", "set -eu; cd /var/www/html; find . -maxdepth 1 \\( -name '.maintenance*' -o -name '.hp_rs_*' \\) | LC_ALL=C sort"],
      { ro: true },
    );
    assert(left.ok && left.stdout.trim() === "", "no .maintenance or .hp_rs_* in site volume", left.stdout || left.stderr);
    const dbRes = await runSql("SHOW DATABASES LIKE 'hp\\\\_r%';");
    assert(dbRes.exitCode === 0, "query MariaDB for hp_r* schemas", dbRes.stderr.toString("utf8"));
    assert(dbRes.stdout.toString("utf8").trim() === "", "no hp_r* schemas left on MariaDB", dbRes.stdout.toString("utf8"));
    const bkPs = await myJobObjects("ps");
    assert(bkPs.length === 0, "no job containers of this run left", JSON.stringify(bkPs));
    const bkVols = await myJobObjects("volume");
    assert(bkVols.length === 0, "no job volumes of this run left", JSON.stringify(bkVols));
    const jobSecrets = (await readdir(secretsRootDir).catch(() => [])).filter((n) => n.startsWith("job_bk_"));
    assert(jobSecrets.length === 0, "no job_bk_* secrets dirs left", JSON.stringify(jobSecrets));
  };

  /** Independent restic container (not the product's) reading a local site repository as the executor user. */
  const resticLsLocal = async (snapshotId) => {
    createdContainers.add(lsContainerName);
    try {
      return await docker([
        "run", "--name", lsContainerName, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--user", uidGid, "--tmpfs", "/tmp:rw,size=64m,mode=1777",
        "-v", `${verifySecretsDir}:/run/secrets:ro`,
        "-v", `${leafDir()}:${leafInContainer}:ro`,
        "-e", "RESTIC_PASSWORD_FILE=/run/secrets/backup.key",
        "-e", "RESTIC_CACHE_DIR=/tmp/cache",
        "-e", `RESTIC_REPOSITORY=${leafInContainer}`,
        "--entrypoint", "/usr/bin/restic", RESTIC_IMAGE, "ls", "--no-lock", snapshotId,
      ]);
    } finally {
      await docker(["rm", "-f", lsContainerName]);
      createdContainers.delete(lsContainerName);
    }
  };

  const startLocalBackup = async (target = localTarget) => {
    const jobId = newJobId();
    localJobIds.add(jobId);
    const started = await adapter.backups({ action: "start", jobId, siteId, serviceInstanceId, target });
    assert(started.state === "running" || started.state === "failed", "start answers running or failed", JSON.stringify(started));
    return { jobId, settled: await pollBackupJob(adapter, jobId) };
  };

  try {
    // ---------------------------------------------------------------------------------------------------- setup
    await runStep(
      "setup",
      async () => {
        for (const img of [RESTIC_IMAGE, RUSTFS_IMAGE, SHARED_MARIADB_IMAGE, WORDPRESS_IMAGE]) {
          const res = await docker(["image", "inspect", img]);
          assert(res.ok, `image ${img} present locally`, res.stderr);
        }
        assert(execUid !== 0 || rootCasesEnabled, "run rootless (or as root with HP_ACCEPT_ROOT_CASES=1)", `uid ${String(execUid)}`);

        // A real disk (not /dev/shm): the guard needs 1 GiB free and refuses roots below /dev.
        tmpRoot = await mkdtemp(path.join(os.tmpdir(), `${runId}_`));
        tempDirs.push(tmpRoot);
        await chmod(tmpRoot, 0o755);
        secretsRootDir = path.join(tmpRoot, "secrets");
        backupWorkDir = path.join(tmpRoot, "backups");
        handoverDir = path.join(tmpRoot, "handover");
        localRoot = path.join(tmpRoot, "local-root");
        verifySecretsDir = path.join(tmpRoot, "verify-secrets");
        const mariadbDataDir = path.join(tmpRoot, "mariadb-data");
        const siteFilesDir = path.join(tmpRoot, "site-files");
        const extraDirs = ["sftp", "ingress", "site-mail", "phpmyadmin"].map((d) => path.join(tmpRoot, d));
        for (const dir of [secretsRootDir, backupWorkDir, handoverDir, localRoot, mariadbDataDir, siteFilesDir, ...extraDirs]) {
          await mkdir(dir, { mode: 0o700 });
        }
        await mkdir(verifySecretsDir, { mode: 0o755 });

        backupKeyFile = path.join(tmpRoot, "backup.key");
        const sharedDbRootKeyFile = path.join(tmpRoot, "mariadb-root.key");
        const hpMailFile = path.join(tmpRoot, "hp-mail.php");
        await writeFile(backupKeyFile, backupKey, { mode: 0o400 });
        await writeFile(sharedDbRootKeyFile, mariaRootPw, { mode: 0o400 });
        await writeFile(hpMailFile, hpMailContent, { mode: 0o444 });
        await writeFile(path.join(verifySecretsDir, "backup.key"), backupKey, { mode: 0o444 });
        await writeFile(path.join(verifySecretsDir, "aws.creds"), buildAwsSharedCredentials(s3AccessKey, s3SecretKey), { mode: 0o444 });

        chosenSubnet = pickFreeSubnet(await dockerJson("GET", "/networks"));
        assert(chosenSubnet !== null, "free /24 subnet found", "none available");
        await dockerJson("POST", "/networks/create", {
          Name: networkName,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Driver: "default", Config: [{ Subnet: chosenSubnet }] },
        });
        createdNetwork = true;

        // MariaDB 12.3.3 on the isolated network with the hp-mariadb alias.
        const dbBase = buildSharedDatabaseContainerPayload({
          image: SHARED_MARIADB_IMAGE,
          user: uidGid,
          dataDirHostPath: mariadbDataDir,
          rootKeyHostPath: sharedDbRootKeyFile,
          adminSubnet: chosenSubnet,
        });
        const dbPayload = {
          ...dbBase,
          HostConfig: { ...dbBase.HostConfig, NetworkMode: networkName },
          NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [SHARED_DB_ALIAS] } } },
        };
        assert(
          !("PortBindings" in dbPayload.HostConfig) && !("ExposedPorts" in dbPayload),
          "MariaDB publishes no host port",
          JSON.stringify(dbPayload.HostConfig),
        );
        await dockerJson("POST", `/containers/create?name=${encodeURIComponent(dbContainerName)}`, dbPayload);
        createdContainers.add(dbContainerName);
        await dockerJson("POST", `/containers/${encodeURIComponent(dbContainerName)}/start`, {});

        // Site volume (33:33), seeded files, PHP stand-in site.
        const volCreate = await docker(["volume", "create", "--label", `io.hostingpanel.site_id=${siteId}`, siteVolumeName]);
        assert(volCreate.ok, `site volume ${siteVolumeName} created`, volCreate.stderr);
        createdVolumes.add(siteVolumeName);
        const initVol = `${runId}_volinit`;
        createdContainers.add(initVol);
        const volInit = await docker([
          "run", "--name", initVol, "--network", "none", "--user", "0:0", "--read-only", "--cap-drop", "ALL",
          "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true", "--entrypoint", "sh",
          "-v", `${siteVolumeName}:/var/www/html`, WORDPRESS_IMAGE, "-c", "chmod 0755 /var/www/html && chown 33:33 /var/www/html",
        ]);
        await docker(["rm", "-f", initVol]);
        createdContainers.delete(initVol);
        assert(volInit.ok, "initialize site volume ownership 33:33", volInit.stderr);

        const wpConfigPhp = [
          "<?php",
          `define('DB_HOST', '${SHARED_DB_ALIAS}');`,
          `define('DB_NAME', '${db1Name}');`,
          `define('DB2_NAME', '${db2Name}');`,
          `define('DB_USER', '${siteDbUser}');`,
          `define('DB_PASSWORD', '${siteDbPass}');`,
          `define('MARKER_FILE', '${markerFileName}');`,
          "",
        ].join("\n");
        const indexPhp = [
          "<?php",
          "if (file_exists(__DIR__ . '/.maintenance')) {",
          "  http_response_code(503);",
          "  header('Retry-After: 5');",
          "  echo \"503 maintenance\\n\";",
          "  exit;",
          "}",
          "require __DIR__ . '/wp-config.php';",
          "$m = @new mysqli(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME);",
          "if ($m->connect_error) {",
          "  http_response_code(500);",
          "  echo \"DBERR\\n\";",
          "  exit;",
          "}",
          '$r1 = $m->query("SELECT note FROM `" . DB_NAME . "`.hp_marker WHERE id = 1")->fetch_row();',
          '$r2 = $m->query("SELECT note FROM `" . DB2_NAME . "`.hp_marker WHERE id = 1")->fetch_row();',
          "$fileMarker = @file_get_contents(__DIR__ . '/' . MARKER_FILE);",
          "$mailSha = @hash_file('sha256', __DIR__ . '/wp-content/mu-plugins/hp-mail.php');",
          "http_response_code(200);",
          'echo "OK|FILE=" . trim((string)$fileMarker) . "|DB1=" . ($r1[0] ?? "") . "|DB2=" . ($r2[0] ?? "") . "|MAIL=" . ($mailSha ?: "") . "\\n";',
          "",
        ].join("\n");
        const seedPayload = JSON.stringify({
          files: {
            "/var/www/html/index.php": { content: indexPhp, mode: 0o644 },
            "/var/www/html/wp-config.php": { content: wpConfigPhp, mode: 0o640 },
            "/var/www/html/.htaccess": { content: `# htaccess-${runHex}\n`, mode: 0o644 },
            [`/var/www/html/${markerFileName}`]: { content: `${fileMarkerText}\n`, mode: 0o644 },
            "/var/www/html/wp-content/uploads/hello.txt": { content: `HELLO-${runHex}\n`, mode: 0o644 },
            "/var/www/html/wp-content/themes/site-style.css": { content: `/* style-${runHex} */\n`, mode: 0o644 },
          },
        });
        createdContainers.add(seedContainerName);
        const seedRes = await docker(
          [
            "run", "-i", "--name", seedContainerName, "--network", "none", "--user", "33:33", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true", "--entrypoint", "php", "-v", `${siteVolumeName}:/var/www/html`,
            WORDPRESS_IMAGE, "-r",
            '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["files"] as $p=>$f){ $dir=dirname($p); if(!is_dir($dir)) mkdir($dir,0755,true); file_put_contents($p,$f["content"]); chmod($p,$f["mode"]); }',
          ],
          { stdin: seedPayload },
        );
        await docker(["rm", "-f", seedContainerName]);
        createdContainers.delete(seedContainerName);
        assert(seedRes.ok, "seed stand-in site files into site volume", seedRes.stderr);

        const siteRun = await docker([
          "run", "-d", "--name", siteContainerName, "--network", networkName, "--user", "33:33", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges:true", "--entrypoint", "php", "-e", "PHP_CLI_SERVER_WORKERS=4",
          "--label", `io.hostingpanel.service_instance_id=${serviceInstanceId}`, "--label", `io.hostingpanel.site_id=${siteId}`,
          "-v", `${siteVolumeName}:/var/www/html`, "-v", `${hpMailFile}:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro`,
          WORDPRESS_IMAGE, "-S", "0.0.0.0:8080", "-t", "/var/www/html",
        ]);
        assert(siteRun.ok, "stand-in WordPress site container starts", siteRun.stderr);
        createdContainers.add(siteContainerName);
        const siteInspect = await dockerInspectContainer(siteContainerName);
        siteIp = siteInspect?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
        assert(siteIp.length > 0, "stand-in site container IP assigned", siteIp);
        assert(
          Object.keys(siteInspect?.HostConfig?.PortBindings ?? {}).length === 0,
          "stand-in site publishes no host port",
          JSON.stringify(siteInspect?.HostConfig?.PortBindings ?? null),
        );

        adapterOptions = {
          pullMissingImages: false,
          secretsRootDir,
          backupWorkDir,
          sftpStateDir: path.join(tmpRoot, "sftp"),
          ingressRootDir: path.join(tmpRoot, "ingress"),
          siteFilesDir,
          siteMailDir: path.join(tmpRoot, "site-mail"),
          phpMyAdminConfigDir: path.join(tmpRoot, "phpmyadmin"),
          sharedDbDataDir: mariadbDataDir,
          sharedDbRootKeyFile,
          sharedDbContainerName: dbContainerName,
          sharedDbNetworkName: networkName,
          backupKeyFile,
          backupNetworkName: networkName,
          panelDumpDir: handoverDir,
          backupLocalRoot: localRoot,
          executorUid: execUid,
        };
        adapter = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));

        const dbDeadline = Date.now() + 120_000;
        let dbReady = false;
        while (Date.now() < dbDeadline) {
          try {
            await adapter.siteDatabases({ siteId, op: "list" });
            dbReady = true;
            break;
          } catch (err) {
            if (!(err instanceof ExecutorCodedError && err.code === "DOCKER_ENGINE_UNAVAILABLE")) throw err;
            await sleep(500);
          }
        }
        assert(dbReady, "MariaDB ready within 120s", "timed out");

        runSql = mariadbRootExec({ request: dockerRequest, socketPath: SOCKET_PATH, apiPrefix: "" }, dbContainerName);
        const r1 = await runSql(`CREATE DATABASE \`${db1Name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        assert(r1.exitCode === 0, `create primary DB ${db1Name}`, r1.stderr.toString("utf8"));
        await adapter.siteDatabases({ siteId, op: "createDatabase", database: db2Name });
        const rUser = await runSql(
          `CREATE USER '${siteDbUser}'@'%' IDENTIFIED BY '${siteDbPass}'; GRANT SELECT ON \`${db1Name}\`.* TO '${siteDbUser}'@'%'; GRANT SELECT ON \`${db2Name}\`.* TO '${siteDbUser}'@'%'; FLUSH PRIVILEGES;`,
        );
        assert(rUser.exitCode === 0, "create stand-in site DB user", rUser.stderr.toString("utf8"));
        const rSeed1 = await runSql(
          [
            `CREATE TABLE \`${db1Name}\`.hp_marker (id INT PRIMARY KEY, note VARCHAR(255)) ENGINE=InnoDB;`,
            `INSERT INTO \`${db1Name}\`.hp_marker VALUES (1, '${db1MarkerText}');`,
            `CREATE TABLE \`${db1Name}\`.hp_extra1 (id INT PRIMARY KEY, label VARCHAR(64)) ENGINE=InnoDB;`,
            `INSERT INTO \`${db1Name}\`.hp_extra1 VALUES (1, 'alpha'), (2, 'beta');`,
          ].join(" "),
        );
        assert(rSeed1.exitCode === 0, `seed tables in ${db1Name}`, rSeed1.stderr.toString("utf8"));
        const rSeed2 = await runSql(
          [
            `USE \`${db2Name}\`;`,
            "CREATE TABLE hp_marker (id INT PRIMARY KEY, note VARCHAR(255)) ENGINE=InnoDB;",
            `INSERT INTO hp_marker VALUES (1, '${db2MarkerText}');`,
            "CREATE TABLE hp_parent (id INT PRIMARY KEY, name VARCHAR(64)) ENGINE=InnoDB;",
            "INSERT INTO hp_parent VALUES (1, 'parent-1'), (2, 'parent-2');",
            "CREATE TABLE hp_child (id INT PRIMARY KEY, parent_id INT NOT NULL, val VARCHAR(64), CONSTRAINT fk_hp_child_parent FOREIGN KEY (parent_id) REFERENCES hp_parent(id)) ENGINE=InnoDB;",
            "CREATE TABLE hp_audit (id INT AUTO_INCREMENT PRIMARY KEY, child_id INT NOT NULL, action VARCHAR(32)) ENGINE=InnoDB;",
            "CREATE TRIGGER tr_hp_child_ins AFTER INSERT ON hp_child FOR EACH ROW INSERT INTO hp_audit (child_id, action) VALUES (NEW.id, 'insert');",
            "INSERT INTO hp_child VALUES (10, 1, 'child-10');",
            "CREATE VIEW v_hp_parent_child AS SELECT p.id AS parent_id, p.name AS parent_name, c.id AS child_id, c.val FROM hp_parent p JOIN hp_child c ON c.parent_id = p.id;",
          ].join(" "),
        );
        assert(rSeed2.exitCode === 0, `seed FK tables/trigger/view in ${db2Name}`, rSeed2.stderr.toString("utf8"));

        const siteDeadline = Date.now() + 15_000;
        let siteResp = null;
        while (Date.now() < siteDeadline) {
          try {
            const res = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
            const text = await res.text();
            if (res.status === 200 && text.startsWith("OK|")) {
              siteResp = text;
              break;
            }
          } catch {
            // retry until PHP server listens
          }
          await sleep(150);
        }
        assert(
          siteResp !== null &&
            siteResp.includes(`FILE=${fileMarkerText}`) &&
            siteResp.includes(`DB1=${db1MarkerText}`) &&
            siteResp.includes(`DB2=${db2MarkerText}`) &&
            siteResp.includes(`MAIL=${hpMailSha}`),
          "stand-in site answers 200 with file/DB markers and hp-mail.php sha",
          JSON.stringify(siteResp),
        );
      },
      { abortOnFail: true },
    );

    // ------------------------------------------------------------------------------ 1. local-init-and-test (BKP-02)
    await runStep("local-init-and-test", async () => {
      const before = await adapter.backups({ action: "test", target: localTarget });
      assert(
        before.outcome === "failed" && before.problem === "local_target_unmounted",
        "test before init answers failed/local_target_unmounted",
        JSON.stringify(before),
      );
      assert((await readdir(localRoot)).length === 0, "test never creates <root>/<targetId>", JSON.stringify(await readdir(localRoot)));

      const init = await adapter.backups({ action: "localInit", target: localTarget });
      assert(init.outcome === "ok" && init.problem === null, "localInit answers ok", JSON.stringify(init));
      assert(
        Number.isSafeInteger(init.availableBytes) && init.availableBytes > 1_073_741_824 && init.totalBytes >= init.availableBytes,
        "localInit reports free bytes above the 1 GiB floor and total >= free",
        JSON.stringify(init),
      );
      assert(init.localRoot === localRoot, "localInit reports the executor's own root", JSON.stringify(init));

      const rootSt = await lstat(localRoot);
      const tSt = await lstat(targetDir());
      assert(tSt.isDirectory() && (tSt.mode & 0o7777) === 0o700 && tSt.uid === execUid, "<targetId> is 0700 owned by the executor", `${(tSt.mode & 0o7777).toString(8)} uid ${String(tSt.uid)}`);
      assert((rootSt.mode & 0o7777) === 0o700, "root untouched (0700)", (rootSt.mode & 0o7777).toString(8));
      const marker = path.join(targetDir(), MARKER_NAME);
      const mSt = await lstat(marker);
      assert(mSt.isFile() && mSt.uid === execUid, "marker is a regular file owned by the executor", JSON.stringify(mSt.mode));
      assert((await readFile(marker, "utf8")) === localTargetMarkerContent(targetId), "marker names exactly this target", await readFile(marker, "utf8"));
      const sitesSt = await lstat(path.join(targetDir(), "sites"));
      assert((sitesSt.mode & 0o7777) === 0o700, "sites/ is 0700", (sitesSt.mode & 0o7777).toString(8));
      const pSt = await lstat(panelDir());
      assert(
        (pSt.mode & 0o7777) === 0o2770 && pSt.gid === execGid && pSt.uid === execUid,
        "panel/ is 2770 executor:executor (setgid, group-shared)",
        `${(pSt.mode & 0o7777).toString(8)} ${String(pSt.uid)}:${String(pSt.gid)}`,
      );
      const cfg = await lstat(path.join(panelDir(), "config"));
      assert(cfg.isFile() && (cfg.mode & 0o040) !== 0 && (cfg.mode & 0o007) === 0, "panel repository config exists, group-readable, no other bits", (cfg.mode & 0o7777).toString(8));

      const again = await adapter.backups({ action: "localInit", target: localTarget });
      assert(again.outcome === "ok" && again.availableBytes > 0, "localInit is idempotent", JSON.stringify(again));
      const test = await adapter.backups({ action: "test", target: localTarget });
      assert(test.outcome === "ok" && test.problem === null && test.availableBytes > 0 && test.localRoot === localRoot, "test answers ok with bytes and root", JSON.stringify(test));
      assert(test.availableBytes <= test.totalBytes, "available <= total", JSON.stringify(test));

      // Hostile ids never reach the filesystem.
      for (const bad of ["../x", "bkt_x", "bkt_/../../etc/passwd", `bkt_${"A".repeat(32)}`]) {
        let code = "";
        try {
          await adapter.backups({ action: "localInit", target: { kind: "local", targetId: bad } });
        } catch (err) {
          code = err instanceof ExecutorCodedError ? err.code : formatErr(err);
        }
        assert(code === "VALIDATION_ERROR", `localInit refuses id ${bad}`, code);
      }
      assert((await readdir(localRoot)).join(",") === targetId, "no other entry under the root", JSON.stringify(await readdir(localRoot)));

      // The test container: no network, no AWS env, only the panel repo bound.
      const testSpec = capturedContainerSpecs.filter((s) => /^hp_bk_test_/.test(s.containerName ?? "")).at(-1);
      assert(testSpec?.inspect, "test container inspected", "none");
      const hc = testSpec.inspect.HostConfig;
      assert(hc.NetworkMode === "none", "test container NetworkMode none", String(hc.NetworkMode));
      const env = testSpec.inspect.Config.Env ?? [];
      assert(!env.some((e) => /^AWS_|s3\./i.test(e)), "test container env has no AWS/S3 entry", JSON.stringify(env));
      const repoMounts = (testSpec.inspect.Mounts ?? []).filter((m) => m.Destination.startsWith("/backup/repository"));
      assert(
        repoMounts.length === 1 && repoMounts[0].Source === panelDir() && repoMounts[0].Destination === "/backup/repository/panel" && repoMounts[0].RW === true,
        "test container binds only <root>/<targetId>/panel",
        JSON.stringify(repoMounts),
      );
    });

    // ------------------------------------------------------------------------------ 2. local-backup-manual (BKP-02)
    await runStep(
      "local-backup-manual",
      async () => {
        const t0 = performance.now();
        const { jobId, settled } = await startLocalBackup();
        assert(settled.state === "succeeded" && settled.failure === null && settled.snapshot !== null, "local backup succeeds", JSON.stringify(settled));
        snapLocal1 = settled.snapshot;
        assert(/^[0-9a-f]{64}$/.test(snapLocal1.snapshotId), "64-hex snapshotId", snapLocal1.snapshotId);
        assert(snapLocal1.bytesAdded > 0 && snapLocal1.totalBytes > 0, "positive byte counts", JSON.stringify(snapLocal1));
        info(`local-backup-manual: ${String(Math.round(performance.now() - t0))}ms ${jobId}`);
        const lsRes = await resticLsLocal(snapLocal1.snapshotId);
        assert(lsRes.ok, "independent restic ls (executor user, read-only mount) exits 0", lsRes.stderr);
        const lines = lsRes.stdout.split(/\r?\n/).map((l) => l.trim());
        for (const want of [`/backup/files/${markerFileName}`, `/backup/databases/${db1Name}.sql`, `/backup/databases/${db2Name}.sql`]) {
          assert(lines.includes(want), `snapshot lists ${want}`, lsRes.stdout);
        }
        const leaf = await lstat(leafDir());
        assert((leaf.mode & 0o7777) === 0o2770 && leaf.gid === execGid, "site leaf is 2770 with the executor group", `${(leaf.mode & 0o7777).toString(8)} gid ${String(leaf.gid)}`);
        assert((await myJobObjects("ps")).length === 0 && (await myJobObjects("volume")).length === 0, "no job container or volume left", "left over");
        const probes = (await treeEntries(targetDir())).filter((e) => e.rel.includes(".hp-probe-"));
        assert(probes.length === 0, "guard write probes are removed", JSON.stringify(probes.map((p) => p.rel)));
      },
      { abortOnFail: false },
    );

    // ------------------------------------------------------------------------ 3. local-repo-ciphertext-only (BKP-04)
    await runStep("local-repo-ciphertext-only", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      const { hits, files, bytes } = await scanTreeForNeedles(localRoot, plainNeedles);
      assert(files > 5 && bytes > 0, "the local root holds repository files", `${String(files)} files ${String(bytes)} bytes`);
      assert(hits.length === 0, "zero plaintext markers, DB names or secrets under the local root", JSON.stringify(hits));
      // Negative control: the scanner must be able to fail.
      const canary = path.join(leafDir(), `.canary-${runHex}`);
      await writeFile(canary, fileMarkerText, { mode: 0o660 });
      try {
        const scan = await scanTreeForNeedles(localRoot, [fileMarkerText]);
        assert(scan.hits.some((h) => h.file.endsWith(`.canary-${runHex}`)), "scanner detects a plaintext canary", JSON.stringify(scan.hits));
      } finally {
        await unlink(canary);
      }
      const cfg = await readFile(path.join(leafDir(), "config"));
      assert(!cfg.includes(Buffer.from("hosting")) && !cfg.toString("latin1").includes(siteId), "repository config carries no site data", "config readable");
    });

    // ------------------------------------------------------------------------------ 4. local-modes-and-users (BKP-04/05)
    await runStep("local-modes-and-users", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      const entries = await treeEntries(leafDir());
      const bad = entries.filter((e) => e.type !== "d" && e.type !== "f");
      assert(bad.length === 0, "only files and directories in the repository", JSON.stringify(bad.map((b) => b.rel)));
      const wrongGroup = entries.filter((e) => e.gid !== execGid);
      assert(wrongGroup.length === 0, "every entry carries the executor group", JSON.stringify(wrongGroup.slice(0, 5).map((e) => `${e.rel} gid ${String(e.gid)}`)));
      const otherBits = entries.filter((e) => (e.mode & 0o007) !== 0);
      assert(otherBits.length === 0, "no entry has a world bit", JSON.stringify(otherBits.slice(0, 5).map((e) => `${e.rel} ${e.mode.toString(8)}`)));
      const files = entries.filter((e) => e.type === "f");
      // restic writes its immutable files 0440 (the group modes it derives from `config`): readable by the group is the rule.
      const noGroupRead = files.filter((e) => (e.mode & 0o040) !== 0o040);
      assert(noGroupRead.length === 0, "every repository file is group-readable", JSON.stringify(noGroupRead.slice(0, 5).map((e) => `${e.rel} ${e.mode.toString(8)}`)));
      const locks = entries.filter((e) => e.rel.startsWith("locks/"));
      assert(locks.length === 0, "no lock file left behind by the finished job", JSON.stringify(locks.map((e) => e.rel)));
      const cfg = entries.find((e) => e.rel === "config");
      assert(cfg && (cfg.mode & 0o040) !== 0, "config is group-readable (g+r)", cfg ? cfg.mode.toString(8) : "missing");
      const packs = files.filter((e) => e.rel.startsWith("data/"));
      assert(packs.length > 0 && packs.every((p) => p.uid === 33 && p.gid === execGid), "packs are owned by the site user 33 with the executor group", JSON.stringify(packs.slice(0, 3)));
      const dirs = entries.filter((e) => e.type === "d" && e.rel.split("/").length > 0 && (e.mode & 0o070) !== 0o070);
      assert(dirs.length === 0, "every directory is group rwx", JSON.stringify(dirs.slice(0, 5).map((e) => `${e.rel} ${e.mode.toString(8)}`)));

      // Container configs of the backup job: no network, no AWS env, GroupAdd, only the leaf bound, site volume read-only.
      const jobId = [...localJobIds][0];
      const specs = capturedContainerSpecs.filter((s) => (s.containerName ?? "").startsWith(`hp_bk_${jobId}_`) && s.inspect);
      const bound = specs.filter((s) => (s.inspect.Mounts ?? []).some((m) => m.Destination === leafInContainer));
      assert(bound.length >= 2, "at least the repo step and the upload step bind the leaf", bound.map((s) => s.containerName).join(","));
      for (const s of bound) {
        const hc = s.inspect.HostConfig;
        const payloadText = JSON.stringify(s.createPayload);
        assert(hc.NetworkMode === "none", `${s.containerName} runs with NetworkMode none`, String(hc.NetworkMode));
        assert(!(s.inspect.Config.Env ?? []).some((e) => /^(AWS_|HP_REGION)/.test(e)), `${s.containerName} has no AWS/HP_REGION env`, JSON.stringify(s.inspect.Config.Env));
        assert(!/s3\.|amazonaws/i.test(payloadText), `${s.containerName} payload has no s3. token`, payloadText.slice(0, 200));
        assert((hc.GroupAdd ?? []).includes(String(execGid)), `${s.containerName} adds the executor group`, JSON.stringify(hc.GroupAdd));
        const repoMounts = s.inspect.Mounts.filter((m) => m.Destination.startsWith("/backup/repository"));
        assert(
          repoMounts.length === 1 && repoMounts[0].Destination === leafInContainer && repoMounts[0].Source === leafDir() && repoMounts[0].RW === true && repoMounts[0].Type === "bind",
          `${s.containerName} binds only <root>/<targetId>/sites/<siteId> (rw)`,
          JSON.stringify(repoMounts),
        );
        assert(!(hc.Binds ?? []).some((b) => b.includes("/backup/repository") || b.includes(localRoot)), `${s.containerName} has no repository bind in Binds`, JSON.stringify(hc.Binds));
        assert(!hc.Privileged && hc.ReadonlyRootfs === true && (hc.CapDrop ?? []).includes("ALL"), `${s.containerName} hardened`, JSON.stringify({ p: hc.Privileged, ro: hc.ReadonlyRootfs, cap: hc.CapDrop }));
      }
      const upload = bound.find((s) => s.containerName.endsWith("_up"));
      assert(upload, "upload step container found", bound.map((s) => s.containerName).join(","));
      assert(upload.inspect.Config.User === "33:33", "upload step keeps the site user 33:33", upload.inspect.Config.User);
      const filesMount = upload.inspect.Mounts.find((m) => m.Destination === "/backup/files");
      assert(filesMount && filesMount.RW === false, "site volume is bound read-only", JSON.stringify(filesMount));

      // Fault hook: the leaf disappears between the guard and the create. Docker refuses a missing Mounts source and
      // nothing (no root-owned directory) is created in its place.
      const away = `${leafDir()}.away`;
      let hooked = false;
      createHooks.push({
        re: /^\/containers\/create\?name=hp_bk_op_/,
        fn: async () => {
          hooked = true;
          await rename(leafDir(), away);
        },
      });
      let outcome;
      try {
        outcome = await startLocalBackup();
        assert(hooked, "the fault hook ran before the first create", "never ran");
        assert(outcome.settled.state === "failed", "backup with a vanished leaf fails", JSON.stringify(outcome.settled));
        assert((await lstat(leafDir()).catch(() => null)) === null, "nothing was created at the vanished leaf", "leaf exists again");
        const refused = capturedContainerSpecs.filter((s) => (s.containerName ?? "").startsWith(`hp_bk_${outcome.jobId}_`) && s.createStatus !== 201);
        assert(refused.length >= 1 && /bind source path does not exist|no such file|mount/i.test(refused[0].createBody ?? ""), "Docker refused to create the container (missing bind source)", JSON.stringify(refused.map((r) => r.createBody)));
      } finally {
        createHooks.length = 0;
        if ((await lstat(away).catch(() => null)) !== null) await rename(away, leafDir());
      }
      assert((await lstat(leafDir())).isDirectory(), "leaf restored", "missing");
      assert((await myJobObjects("ps")).length === 0, "no job container left after the refusal", JSON.stringify(await myJobObjects("ps")));
    });

    // ------------------------------------------------------------------------------------- 5. local-hostile (BKP-05)
    await runStep("local-hostile", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      const baseline = await treeFingerprint(localRoot);
      const outsideDirs = [];
      const makeOutside = async (label) => {
        const dir = path.join(tmpRoot, `outside-${label}`);
        await mkdir(dir, { mode: 0o700 });
        outsideDirs.push(dir);
        return dir;
      };
      const marker = path.join(targetDir(), MARKER_NAME);

      /** One refusal: mutate -> start must fail with `problem` with zero containers and zero writes -> undo -> unchanged. */
      const refusal = async (label, problem, mutate, undo, { extra = [], runner = null } = {}) => {
        await mutate();
        const fpBefore = await treeFingerprint(localRoot);
        const extraBefore = await Promise.all(extra.map((d) => treeFingerprint(d)));
        const createsBefore = containerCreateCount;
        try {
          const settled = runner ? await runner() : (await startLocalBackup()).settled;
          assert(settled.state === "failed" && settled.failure === problem, `${label}: job fails with ${problem}`, JSON.stringify(settled));
          assert(containerCreateCount === createsBefore, `${label}: zero containers created`, `${String(createsBefore)} -> ${String(containerCreateCount)}`);
          assert((await treeFingerprint(localRoot)) === fpBefore, `${label}: nothing written under the root`, "tree changed");
          for (const [i, d] of extra.entries()) {
            assert((await treeFingerprint(d)) === extraBefore[i], `${label}: ${path.basename(d)} untouched`, "tree changed");
            assert((await readdir(d)).length === 0, `${label}: ${path.basename(d)} stays empty`, JSON.stringify(await readdir(d)));
          }
        } finally {
          await undo();
        }
        assert((await treeFingerprint(localRoot)) === baseline, `${label}: state restored`, "baseline differs");
      };

      await refusal("marker missing", "local_target_unmounted",
        () => rename(marker, `${marker}.away`), () => rename(`${marker}.away`, marker));
      await refusal("marker with foreign content", "local_target_unmounted",
        async () => { await rename(marker, `${marker}.away`); await writeFile(marker, "hosting-panel local backup target bkt_other\n", { mode: 0o600 }); },
        async () => { await rm(marker, { force: true }); await rename(`${marker}.away`, marker); });
      await refusal("marker is a symlink", "local_target_unsafe",
        async () => { await rename(marker, `${marker}.away`); await symlink(`${marker}.away`, marker); },
        async () => { await unlink(marker); await rename(`${marker}.away`, marker); });
      await refusal("marker is a directory", "local_target_unsafe",
        async () => { await rename(marker, `${marker}.away`); await mkdir(marker, { mode: 0o700 }); },
        async () => { await rm(marker, { recursive: true, force: true }); await rename(`${marker}.away`, marker); });

      // Read intents re-run the guard too: restore and archive on an unmounted target fail at once, site untouched.
      const stateBefore = await captureSiteAndDbState();
      await refusal("restore on unmounted target", "local_target_unmounted",
        () => rename(marker, `${marker}.away`), () => rename(`${marker}.away`, marker),
        { runner: async () => {
            const jobId = newJobId();
            localJobIds.add(jobId);
            await adapter.backups({ action: "restore", jobId, siteId, serviceInstanceId, target: localTarget, snapshotId: snapLocal1.snapshotId });
            return pollBackupJob(adapter, jobId);
        } });
      await refusal("archive on unmounted target", "local_target_unmounted",
        () => rename(marker, `${marker}.away`), () => rename(`${marker}.away`, marker),
        { runner: async () => {
            const jobId = newJobId();
            localJobIds.add(jobId);
            await adapter.backups({ action: "archive", jobId, siteId, target: localTarget, snapshotId: snapLocal1.snapshotId });
            return pollBackupJob(adapter, jobId);
        } });
      assert(sameState(stateBefore, await captureSiteAndDbState()), "site and databases untouched by the refused restore", "state changed");

      const out1 = await makeOutside("target");
      await refusal("<targetId> replaced by a symlink", "local_target_unsafe",
        async () => { await rename(targetDir(), `${targetDir()}.real`); await symlink(out1, targetDir()); },
        async () => { await unlink(targetDir()); await rename(`${targetDir()}.real`, targetDir()); },
        { extra: [out1] });
      const out2 = await makeOutside("sites");
      const sitesPath = path.join(targetDir(), "sites");
      await refusal("sites/ replaced by a symlink", "local_target_unsafe",
        async () => { await rename(sitesPath, `${sitesPath}.real`); await symlink(out2, sitesPath); },
        async () => { await unlink(sitesPath); await rename(`${sitesPath}.real`, sitesPath); },
        { extra: [out2] });
      const out3 = await makeOutside("leaf");
      await refusal("site leaf replaced by a symlink", "local_target_unsafe",
        async () => { await rename(leafDir(), `${leafDir()}.real`); await symlink(out3, leafDir()); },
        async () => { await unlink(leafDir()); await rename(`${leafDir()}.real`, leafDir()); },
        { extra: [out3] });
      for (const mode of [0o700, 0o777, 0o2750]) {
        await refusal(`site leaf mode ${mode.toString(8)}`, "local_target_unsafe",
          () => chmod(leafDir(), mode), () => chmod(leafDir(), 0o2770));
      }
      await refusal("root writable by others (0777)", "local_target_unsafe",
        () => chmod(localRoot, 0o777), () => chmod(localRoot, 0o700));
      assert(((await lstat(leafDir())).mode & 0o7777) === 0o2770, "leaf back to 2770", "mode differs");

      // A root that is not there (disk not mounted) and a root the executor never accepted.
      const missingRoot = path.join(tmpRoot, "missing-root");
      const unmounted = instrumentAdapter(new DockerEngineSocketAdapter({ ...adapterOptions, backupLocalRoot: missingRoot }));
      const t1 = await unmounted.backups({ action: "test", target: localTarget });
      assert(t1.outcome === "failed" && t1.problem === "local_target_unmounted", "missing root: test fails local_target_unmounted", JSON.stringify(t1));
      const i1 = await unmounted.backups({ action: "localInit", target: localTarget });
      assert(i1.outcome === "failed" && i1.problem === "local_target_unmounted", "missing root: localInit does not create it", JSON.stringify(i1));
      assert((await lstat(missingRoot).catch(() => null)) === null, "the missing root was not created", "exists");
      const disabled = instrumentAdapter(new DockerEngineSocketAdapter({ ...adapterOptions, backupLocalRoot: null }));
      const t2 = await disabled.backups({ action: "test", target: localTarget });
      assert(t2.outcome === "failed" && t2.problem === "local_target_unsafe", "no root configured: local_target_unsafe", JSON.stringify(t2));
      const rootLink = path.join(tmpRoot, "root-link");
      await symlink(localRoot, rootLink);
      const viaLink = instrumentAdapter(new DockerEngineSocketAdapter({ ...adapterOptions, backupLocalRoot: rootLink }));
      const t3 = await viaLink.backups({ action: "test", target: localTarget });
      assert(t3.outcome === "failed" && t3.problem === "local_target_unsafe", "root reached through a symlink: local_target_unsafe", JSON.stringify(t3));
      assert((await treeFingerprint(localRoot)) === baseline, "root tree unchanged after all hostile cases", "tree changed");
      assert((await myJobObjects("ps")).length === 0, "no job container left", JSON.stringify(await myJobObjects("ps")));
    });

    // -------------------------------------------------------- 6. local-readonly-and-no-space (BKP-05/06, root only)
    if (!rootCasesEnabled) {
      skip(
        "local-readonly-and-no-space",
        "needs root to mount a small tmpfs and remount it read-only (run as root with HP_ACCEPT_ROOT_CASES=1); covered at unit level by local-target-guard.test.ts (injected statfs/open)",
      );
      skip("local-root-owned-by-another-user", "needs root to chown the root to a foreign uid (HP_ACCEPT_ROOT_CASES=1 as root)");
    } else {
      await runStep("local-readonly-and-no-space", async () => {
        const mnt = path.join(tmpRoot, "rootcase-mount");
        await mkdir(mnt, { mode: 0o700 });
        const mountTmpfs = async (size) => {
          const r = await execCmd("mount", ["-t", "tmpfs", "-o", `size=${size},mode=0700`, "tmpfs", mnt]);
          assert(r.ok, `mount tmpfs ${size}`, r.stderr);
          if (!mounts.includes(mnt)) mounts.push(mnt);
        };
        const unmount = async () => {
          const r = await execCmd("umount", [mnt]);
          assert(r.ok, "umount", r.stderr);
          mounts.splice(mounts.indexOf(mnt), 1);
        };
        const smallTarget = { kind: "local", targetId: `bkt_${randomBytes(16).toString("hex")}` };
        const rootAdapter = instrumentAdapter(new DockerEngineSocketAdapter({ ...adapterOptions, backupLocalRoot: mnt }));
        // Disk full: 64 MiB is below the 1 GiB floor, answered before any container exists.
        await mountTmpfs("64m");
        const createsBefore = containerCreateCount;
        const full = await rootAdapter.backups({ action: "localInit", target: smallTarget });
        assert(full.outcome === "failed" && full.problem === "no_space", "64 MiB root: localInit answers no_space", JSON.stringify(full));
        assert(containerCreateCount === createsBefore, "no container created on no_space", `${String(createsBefore)} -> ${String(containerCreateCount)}`);
        await unmount();
        // Read-only: a mounted, marked target that becomes read-only answers local_target_readonly, never hangs restic.
        await mountTmpfs("1200m");
        const init = await rootAdapter.backups({ action: "localInit", target: smallTarget });
        assert(init.outcome === "ok", "1200 MiB root: localInit ok", JSON.stringify(init));
        const ro = await execCmd("mount", ["-o", "remount,ro", mnt]);
        assert(ro.ok, "remount read-only", ro.stderr);
        const t0 = performance.now();
        const res = await rootAdapter.backups({ action: "test", target: smallTarget });
        assert(res.outcome === "failed" && res.problem === "local_target_readonly", "read-only root: test answers local_target_readonly", JSON.stringify(res));
        assert(performance.now() - t0 < 30_000, "read-only answer under 30s (no restic hang)", `${String(Math.round(performance.now() - t0))}ms`);
        assert(containerCreateCount === createsBefore + 1 || containerCreateCount === createsBefore, "no repository container started on read-only", `${String(createsBefore)} -> ${String(containerCreateCount)}`);
        await unmount();
      });
      skip("local-root-owned-by-another-user", "no second user available to this script even as root; covered by the injected fstat seam in local-target-guard.test.ts");
    }

    // ------------------------------------------------------------------------------------ 7. local-restore (BKP-10)
    await runStep("local-restore", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      const origState = await captureSiteAndDbState();
      const repoBefore = await treeFingerprint(leafDir());

      const breakSite = async (tag) => {
        const f = await runSiteHelper("breakf", [
          "-c",
          [
            "set -eu",
            "rm -f /var/www/html/wp-content/uploads/hello.txt",
            `printf 'BROKEN-${tag}-${runHex}\\n' > /var/www/html/${markerFileName}`,
            "printf '/* broken */\\n' > /var/www/html/wp-content/themes/site-style.css",
            `printf 'unwanted-${runHex}\\n' > /var/www/html/unwanted-broken-${runHex}.txt`,
          ].join("; "),
        ]);
        assert(f.ok, "break site files", f.stderr);
        const d = await runSql(
          [
            `DROP TABLE \`${db1Name}\`.hp_extra1;`,
            `UPDATE \`${db1Name}\`.hp_marker SET note='BROKEN-${tag}-DB1-${runHex}' WHERE id=1;`,
            `UPDATE \`${db2Name}\`.hp_marker SET note='BROKEN-${tag}-DB2-${runHex}' WHERE id=1;`,
            `DROP VIEW \`${db2Name}\`.v_hp_parent_child;`,
            `DROP TRIGGER \`${db2Name}\`.tr_hp_child_ins;`,
            `DROP TABLE \`${db2Name}\`.hp_child;`,
          ].join(" "),
        );
        assert(d.exitCode === 0, "break site databases", d.stderr.toString("utf8"));
      };
      const pageBody = async () => {
        const res = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
        return { status: res.status, body: await res.text() };
      };

      // (a) Injected failure: the switch cannot take its MariaDB lock -> switch_undone, the broken site is as it was.
      await breakSite("A");
      const brokenA = await captureSiteAndDbState();
      assert(!sameState(brokenA, origState), "the break is detected by the state comparison", "unchanged");
      const lockScript = [
        "set -eu",
        "trap 'rm -f /tmp/hp-lock.cnf' EXIT",
        'printf \'[client]\\nuser=root\\nhost=localhost\\npassword=%s\\n\' "$(cat /run/secrets/mariadb-root)" > /tmp/hp-lock.cnf',
        `mariadb --defaults-extra-file=/tmp/hp-lock.cnf -N -B -e "BEGIN; SELECT * FROM \\\`${db1Name}\\\`.hp_marker FOR UPDATE; SELECT SLEEP(60); COMMIT;"`,
      ].join("\n");
      const lockChild = spawn("docker", ["exec", "-i", dbContainerName, "sh", "-c", lockScript], { stdio: ["ignore", "pipe", "pipe"] });
      activeChildProcs.add(lockChild);
      let lockConnId = null;
      const lockDeadline = Date.now() + 15_000;
      while (Date.now() < lockDeadline && lockConnId === null) {
        const q = await runSql(
          "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%SELECT SLEEP(60)%' AND INFO NOT LIKE '%information_schema.PROCESSLIST%' LIMIT 1;",
        );
        const id = q.exitCode === 0 ? q.stdout.toString("utf8").trim() : "";
        if (/^\d+$/.test(id)) lockConnId = id;
        else await sleep(50);
      }
      assert(lockConnId !== null, "MariaDB lock session active", "not found");
      let failed;
      try {
        const jobId = newJobId();
        localJobIds.add(jobId);
        await adapter.backups({ action: "restore", jobId, siteId, serviceInstanceId, target: localTarget, snapshotId: snapLocal1.snapshotId });
        failed = await pollBackupJob(adapter, jobId);
      } finally {
        await runSql(`KILL ${lockConnId};`).catch(() => undefined);
        await Promise.race([new Promise((r) => lockChild.once("exit", r)), sleep(5_000)]);
        lockChild.kill("SIGKILL");
        activeChildProcs.delete(lockChild);
      }
      assert(failed.state === "failed" && failed.failure === "switch_undone", "locked restore from the local snapshot fails with switch_undone", JSON.stringify(failed));
      const afterA = await pageBody();
      assert(afterA.status === 200 && afterA.body.includes("BROKEN-A-"), "site open again with the state it had before (rollback)", JSON.stringify(afterA));
      assert(sameState(brokenA, await captureSiteAndDbState()), "files and databases identical after the rollback", "state changed");
      await assertNoRestoreLeftovers();
      assert((await treeFingerprint(leafDir())) === repoBefore, "the repository is untouched by the failed restore", "tree changed");

      // (b) A snapshot id the repository does not hold fails in prepare and leaves the site as it was.
      const missingJob = newJobId();
      localJobIds.add(missingJob);
      await adapter.backups({ action: "restore", jobId: missingJob, siteId, serviceInstanceId, target: localTarget, snapshotId: "e".repeat(64) });
      const missing = await pollBackupJob(adapter, missingJob);
      assert(missing.state === "failed" && missing.snapshot === null, "restore of an unknown snapshot fails", JSON.stringify(missing));
      assert(sameState(brokenA, await captureSiteAndDbState()), "state unchanged after the unknown-snapshot restore", "state changed");
      await assertNoRestoreLeftovers();

      // (c) The real restore from the local snapshot brings everything back.
      const jobId = newJobId();
      localJobIds.add(jobId);
      await adapter.backups({ action: "restore", jobId, siteId, serviceInstanceId, target: localTarget, snapshotId: snapLocal1.snapshotId });
      const done = await pollBackupJob(adapter, jobId);
      assert(done.state === "succeeded" && done.failure === null, "restore from the local snapshot succeeds", JSON.stringify(done));
      const page = await pageBody();
      assert(
        page.status === 200 && page.body.includes(`FILE=${fileMarkerText}`) && page.body.includes(`DB1=${db1MarkerText}`) && page.body.includes(`DB2=${db2MarkerText}`) && page.body.includes(`MAIL=${hpMailSha}`),
        "site serves the original markers right after succeeded",
        JSON.stringify(page),
      );
      const restored = await captureSiteAndDbState();
      assert(restored.fileHashesText === origState.fileHashesText, "all file hashes match the original, extra file gone", "file hash mismatch");
      assert(restored.checksumsText === origState.checksumsText, "all table checksums match the original", "checksum mismatch");
      assert(restored.showCreatesText === origState.showCreatesText, "view, trigger and FK tables match the original", "DDL mismatch");
      const fk = await runSql(`INSERT INTO \`${db2Name}\`.hp_child (id, parent_id, val) VALUES (999, 999999, 'orphan');`);
      assert(fk.exitCode !== 0 && /1452|foreign key constraint/i.test(fk.stderr.toString("utf8")), "foreign key refuses an orphan row after restore", fk.stderr.toString("utf8"));
      await assertNoRestoreLeftovers();
      assert((await treeFingerprint(leafDir())) === repoBefore, "restore wrote nothing into the repository", "tree changed");
    });

    // ---------------------------------------------------------------------------------- 8. local-export-zip (BKP-12)
    await runStep("local-export-zip", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      const archivesDir = path.join(backupWorkDir, "archives");
      const repoBefore = await treeFingerprint(leafDir());
      const archJob = newJobId();
      localJobIds.add(archJob);
      await adapter.backups({ action: "archive", jobId: archJob, siteId, target: localTarget, snapshotId: snapLocal1.snapshotId });
      const done = await pollBackupJob(adapter, archJob);
      assert(done.state === "succeeded" && done.failure === null && done.archive !== null, "archive from the local snapshot succeeds", JSON.stringify(done));
      const { sizeBytes, readyAt, expiresAt } = done.archive;
      assert(sizeBytes > 0, "archive sizeBytes > 0", String(sizeBytes));
      assert(Date.parse(expiresAt) - Date.parse(readyAt) === BACKUP_ARCHIVE_TTL_MS, "expiresAt is exactly 60 minutes after readyAt", `${readyAt} -> ${expiresAt}`);
      const dirSt = await stat(archivesDir);
      assert((dirSt.mode & 0o777) === 0o700 && dirSt.uid === execUid, "archives dir is 0700 owned by the executor user", (dirSt.mode & 0o777).toString(8));
      const entries = await readdir(archivesDir);
      assert(entries.length === 1 && entries[0] === `${archJob}.zip`, "only <jobId>.zip exists (no .part)", JSON.stringify(entries));
      const zipPath = path.join(archivesDir, `${archJob}.zip`);
      const zipSt = await stat(zipPath);
      assert(zipSt.size === sizeBytes && zipSt.uid === execUid, "zip has the announced size and owner", `${String(zipSt.size)} uid ${String(zipSt.uid)}`);

      const chunks = [];
      let offset = 0;
      for (;;) {
        const chunk = await adapter.backups({ action: "readArchive", jobId: archJob, offset, length: SITE_FILE_CHUNK_BYTES });
        assert(chunk.size === sizeBytes, "chunk reports the exact size", String(chunk.size));
        const raw = Buffer.from(chunk.dataBase64, "base64");
        chunks.push(raw);
        offset += raw.length;
        if (chunk.eof) break;
        assert(raw.length > 0, "non-eof chunk has bytes", "empty");
      }
      const joined = Buffer.concat(chunks);
      assert(joined.length === sizeBytes && sha256(joined) === sha256(await readFile(zipPath)), "joined chunks equal the zip on disk (sha256)", `${String(joined.length)} vs ${String(sizeBytes)}`);

      const unzipName = `${runId}_unzip`;
      createdContainers.add(unzipName);
      let unzip;
      try {
        unzip = await docker([
          "run", "--name", unzipName, "--network", "none", "--user", uidGid, "--read-only", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges:true", "--entrypoint", "php", "-v", `${zipPath}:/tmp/archive.zip:ro`, WORDPRESS_IMAGE, "-r",
          [
            "$z = new ZipArchive();",
            "if ($z->open('/tmp/archive.zip', ZipArchive::RDONLY) !== true) { exit(2); }",
            `$m = $z->getFromName('files/${markerFileName}');`,
            `$d1 = $z->getFromName('databases/${db1Name}.sql');`,
            `$d2 = $z->getFromName('databases/${db2Name}.sql');`,
            "$missing = $z->getFromName('files/nonexistent-canary.txt');",
            "if ($m === false || $d1 === false || $d2 === false || $missing !== false) { exit(3); }",
            "echo json_encode(['marker' => trim($m), 'db1Len' => strlen($d1), 'db2Len' => strlen($d2)]);",
          ].join(" "),
        ]);
      } finally {
        await docker(["rm", "-f", unzipName]);
        createdContainers.delete(unzipName);
      }
      assert(unzip.ok, "PHP ZipArchive opens and validates the archive", `${unzip.stderr} ${unzip.stdout}`);
      const meta = JSON.parse(unzip.stdout);
      assert(meta.marker === fileMarkerText && meta.db1Len > 0 && meta.db2Len > 0, "zip holds the files/ marker and both databases/<db>.sql", JSON.stringify(meta));
      const siteZip = await runSiteHelper("sitezip", ["-c", "find /var/www/html -name '*.zip'"], { ro: true });
      assert(siteZip.ok && siteZip.stdout.trim() === "", "no *.zip anywhere in the site volume", siteZip.stdout);

      const disc = await adapter.backups({ action: "discardArchive", jobId: archJob });
      assert(disc.discarded === true, "discardArchive returns { discarded: true }", JSON.stringify(disc));
      assert((await readdir(archivesDir)).length === 0, "archives dir empty after discardArchive", JSON.stringify(await readdir(archivesDir)));
      let gone = "";
      try {
        await adapter.backups({ action: "readArchive", jobId: archJob, offset: 0, length: 64 });
      } catch (err) {
        gone = err instanceof ExecutorCodedError ? `${err.code}:${err.message}` : formatErr(err);
      }
      assert(gone === "NOT_FOUND:archive_gone", "readArchive after discard throws NOT_FOUND archive_gone", gone);
      assert((await treeFingerprint(leafDir())) === repoBefore, "the archive job wrote nothing into the repository", "tree changed");
      await assertNoRestoreLeftovers();
    });

    // ------------------------------------------------------------------------- 9. panel-local-and-dr (BKP-16)
    await runStep("panel-local-and-dr", async () => {
      const dumpMarker = `PANEL-MARKER-${runHex}-PLAINTEXT`;
      const dumpBytes = Buffer.concat([Buffer.from("PGDMP"), Buffer.from(dumpMarker), randomBytes(8192)]);
      const panelJob = newJobId();
      localJobIds.add(panelJob);
      const dumpPath = path.join(handoverDir, `${panelJob}.dump`);
      await writeFile(dumpPath, dumpBytes, { mode: 0o640 });
      await adapter.backups({ action: "panelStart", jobId: panelJob, target: localTarget, masterKey, retentionDays: 30 });
      const done = await pollBackupJob(adapter, panelJob);
      assert(done.state === "succeeded" && done.failure === null, "panel copy to the local target succeeds", JSON.stringify(done));
      assert(done.snapshot?.fileCount === 2 && done.snapshot.totalBytes === dumpBytes.length + 64, "snapshot = dump + 64-byte key", JSON.stringify(done.snapshot));
      assert(sha256(await readFile(dumpPath)) === sha256(dumpBytes), "the dump file is untouched", "changed");
      await rm(dumpPath, { force: true });

      const snapshots = await readdir(path.join(panelDir(), "snapshots"));
      assert(snapshots.length >= 1, "the panel/ repository holds the snapshot", JSON.stringify(snapshots));
      const scan = await scanTreeForNeedles(localRoot, [dumpMarker, masterKey, Buffer.from(masterKey, "hex"), backupKey]);
      assert(scan.hits.length === 0, "no plaintext dump marker, master key or backup key under the local root", JSON.stringify(scan.hits));
      const pupSpec = capturedContainerSpecs.find((s) => s.containerName === `hp_bk_${panelJob}_pup`);
      assert(pupSpec?.inspect, "upload container inspected", "none");
      assert(pupSpec.inspect.HostConfig.NetworkMode === "none", "panel upload runs with NetworkMode none", pupSpec.inspect.HostConfig.NetworkMode);
      assert(pupSpec.inspect.Config.User === uidGid, "panel steps run as the executor user", pupSpec.inspect.Config.User);
      assert((pupSpec.inspect.Mounts ?? []).some((m) => m.Destination === "/backup/repository/panel" && m.Source === panelDir() && m.RW === true), "panel upload binds only panel/", JSON.stringify(pupSpec.inspect.Mounts));

      // DR fetch straight from the directory (hp-restore-panel --local-repo): read-only, --no-lock, no network.
      const fetchDir = path.join(tmpRoot, "fetch-out");
      await mkdir(fetchDir, { mode: 0o700 });
      const repoFp = await treeFingerprint(panelDir());
      const specStart = capturedContainerSpecs.length;
      const got = await adapter.fetchPanelCopy({ kind: "local_repo", repoDir: panelDir() }, fetchDir);
      assert(got.ok === true && got.snapshotId === done.snapshot.snapshotId, "fetchPanelCopy returns the newest copy", JSON.stringify(got));
      const fetchedDump = await readFile(path.join(fetchDir, "restore.pgdump"));
      const fetchedKey = await readFile(path.join(fetchDir, "restore.key"), "utf8");
      assert(fetchedDump.equals(dumpBytes) && sha256(fetchedDump) === sha256(dumpBytes), "restore.pgdump is byte-identical to the dump", sha256(fetchedDump));
      assert(fetchedKey === masterKey, "restore.key is the master key", `len ${String(fetchedKey.length)}`);
      assert((await treeFingerprint(panelDir())) === repoFp, "the fetch wrote nothing into the repository (no lock file)", "tree changed");
      const pf = capturedContainerSpecs.slice(specStart).filter((s) => (s.containerName ?? "").startsWith("hp_bk_pf_") && s.inspect);
      assert(pf.length >= 1, "a fetch container ran", "none");
      for (const s of pf) {
        const m = (s.inspect.Mounts ?? []).find((x) => x.Destination.startsWith("/backup/repository"));
        assert(s.inspect.HostConfig.NetworkMode === "none", "fetch container NetworkMode none", s.inspect.HostConfig.NetworkMode);
        assert(m && m.RW === false && m.Source === panelDir(), "fetch binds the repository read-only", JSON.stringify(m));
        assert(!(s.inspect.Config.Env ?? []).some((e) => /^AWS_/.test(e)), "fetch has no AWS env", JSON.stringify(s.inspect.Config.Env));
      }
      for (const f of ["restore.pgdump", "restore.key"]) {
        const m = (await stat(path.join(fetchDir, f))).mode & 0o777;
        assert((m & 0o007) === 0 && (m & 0o600) === 0o600, `${f} is owner-rw with no world bit`, m.toString(8));
      }

      // The shipped CLI (exits 0 / 2 / 7 / 8), pointed at this run's paths through its createAdapter hook.
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
      const cliOut = path.join(tmpRoot, "cli-out");
      await mkdir(cliOut, { mode: 0o700 });
      const runCli = async (extraArgs) => {
        const r = await execCmd(process.execPath, [wrapper, secretsRootDir, networkName, ...extraArgs], {
          stdin: "",
          env: { ...process.env, HP_PANEL_DUMP_DIR: cliOut, HP_BACKUP_KEY_FILE: backupKeyFile },
          timeoutMs: 180_000,
        });
        for (const s of secretsToGuard) assert(!(r.stdout + r.stderr).includes(s), `CLI output (exit ${String(r.code)}) holds no secret`, "leak");
        return r;
      };
      const present = async () => (await readdir(cliOut)).filter((n) => n.includes("restore"));
      const link = path.join(tmpRoot, "panel-link");
      await symlink(panelDir(), link);
      const refusals = [
        ["a missing directory", ["--local-repo", path.join(targetDir(), "nope", "panel")], 7],
        ["a symlinked directory", ["--local-repo", link], 8],
        ["a directory under /etc", ["--local-repo", "/etc/hosting-panel-nope"], 8],
        ["S3 flags mixed in", ["--local-repo", panelDir(), "--endpoint", "https://s3.example.test", "--region", "x", "--bucket", "bucket-x"], 2],
      ];
      for (const [label, args, code] of refusals) {
        const r = await runCli(args);
        assert(r.code === code, `CLI --local-repo with ${label} exits ${String(code)}`, `exit ${String(r.code)} ${r.stderr.trim()}`);
        assert((await present()).length === 0, `${label}: no output file left`, JSON.stringify(await present()));
      }
      const ok = await runCli(["--local-repo", panelDir()]);
      assert(ok.code === 0, "CLI --local-repo on the panel repository exits 0", `exit ${String(ok.code)} ${ok.stderr.trim()}`);
      assert(JSON.parse(ok.stdout.trim()).snapshotId === done.snapshot.snapshotId, "CLI answers the newest snapshot id", ok.stdout);
      assert((await readFile(path.join(cliOut, "restore.pgdump"))).equals(dumpBytes), "CLI restore.pgdump is byte-identical", "differs");
      assert((await readFile(path.join(cliOut, "restore.key"), "utf8")) === masterKey, "CLI restore.key is the master key", "differs");
      assert((await treeFingerprint(panelDir())) === repoFp, "the CLI fetch wrote nothing into the repository", "tree changed");
      assert((await myJobObjects("ps")).length === 0 && (await dockerListNames("ps", "hp_bk_pf_").then((n) => n.filter((x) => capturedContainerSpecs.some((s) => s.containerName === x)))).length === 0, "no job or fetch container left", "left over");
      info("panel-local-and-dr: the foreign-uid repository case needs a second uid and stays with the real-server DR runbook");
    });

    // ----------------------------------------------------------------------------- 10. legacy-s3-coexists (BKP-01/03/11)
    await runStep("legacy-s3-coexists", async () => {
      assert(snapLocal1 !== null, "a local snapshot exists", "backup step failed");
      // Throw-away RustFS 1.0.5: no host port, tmpfs data.
      const s3Payload = {
        Image: RUSTFS_IMAGE,
        Env: [`RUSTFS_ACCESS_KEY=${s3AccessKey}`, `RUSTFS_SECRET_KEY=${s3SecretKey}`],
        HostConfig: {
          Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: networkName, RestartPolicy: { Name: "no" },
          Tmpfs: {
            "/tmp": "rw,size=64m,uid=10001,gid=10001",
            "/data": "rw,size=512m,uid=10001,gid=10001",
            "/logs": "rw,size=16m,uid=10001,gid=10001",
          },
        },
      };
      await dockerJson("POST", `/containers/create?name=${encodeURIComponent(s3ContainerName)}`, s3Payload);
      createdContainers.add(s3ContainerName);
      await dockerJson("POST", `/containers/${encodeURIComponent(s3ContainerName)}/start`, {});
      const s3Ip = (await dockerInspectContainer(s3ContainerName))?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
      assert(s3Ip.length > 0, "RustFS container IP assigned", s3Ip);
      s3Target = {
        endpoint: `http://${s3Ip}:9000`,
        region: "us-east-1",
        bucket: `hp-backups-${runHex}`,
        prefix: `tenant-${runHex}`,
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
      };
      assert(Object.keys(s3Target).length === 6, "the S3 target is the frozen 6-key object (no kind)", JSON.stringify(Object.keys(s3Target)));
      const s3Deadline = Date.now() + 30_000;
      let s3Ready = false;
      while (Date.now() < s3Deadline && !s3Ready) {
        try {
          s3Ready = (await fetch(`${s3Target.endpoint}/`, { signal: AbortSignal.timeout(2_000) })).status === 403;
        } catch {
          // retry until ready
        }
        if (!s3Ready) await sleep(250);
      }
      assert(s3Ready, "RustFS answers HTTP within 30s", "timed out");
      const bucket = await s3Request(s3Target, "PUT", "");
      assert(bucket.status === 200 || bucket.status === 204, "create RustFS bucket", String(bucket.status));

      const t = await adapter.backups({ action: "test", target: s3Target });
      assert(t.outcome === "ok" && t.problem === null && !("availableBytes" in t) && !("localRoot" in t), "S3 test answers {outcome ok, problem null} only", JSON.stringify(t));

      // S3 backup with the state to be restored from it later; then the local backup; then break the site.
      const s3State = await captureSiteAndDbState();
      const specStart = capturedContainerSpecs.length;
      const s3Job = newJobId();
      await adapter.backups({ action: "start", jobId: s3Job, siteId, serviceInstanceId, target: s3Target });
      const s3Done = await pollBackupJob(adapter, s3Job);
      assert(s3Done.state === "succeeded" && s3Done.snapshot !== null, "S3 backup succeeds next to a local target", JSON.stringify(s3Done));
      const snapS3 = s3Done.snapshot;
      const s3Specs = capturedContainerSpecs.slice(specStart).filter((s) => (s.containerName ?? "").startsWith(`hp_bk_${s3Job}_`));

      // BKP-03: the S3 job's repo and upload payloads equal the frozen pins once the run's own names are swapped back.
      const normalize = (value) => {
        let text = JSON.stringify(value);
        const swaps = [
          [s3Job, `op_${"b0".repeat(16)}`],
          [secretsRootDir, "/run/hosting-panel/secrets"],
          [siteVolumeName, "hp_vol_svc_pin_a_html"],
          [siteId, "site_pin_a"],
          [s3Target.endpoint, "https://s3.example.test:9000"],
          [s3Target.bucket, "pin-backups"],
          [s3Target.prefix, "pins/site-a"],
          [s3Target.region, "eu-central-1"],
          [networkName, "hp_backup_net"],
        ];
        for (const [from, to] of swaps) text = text.split(from).join(to);
        return JSON.parse(text);
      };
      const repoPin = JSON.parse(await readFile(path.join(pinsDir, "backup-repo.json"), "utf8"));
      const upPin = JSON.parse(await readFile(path.join(pinsDir, "backup-upload.json"), "utf8")).spec;
      for (const [suffix, pin] of [["repo", repoPin], ["up", upPin]]) {
        const spec = s3Specs.find((s) => s.containerName === `hp_bk_${s3Job}_${suffix}`);
        assert(spec?.createPayload, `S3 job created _${suffix}`, s3Specs.map((s) => s.containerName).join(","));
        const got = normalize({ containerName: spec.containerName, payload: spec.createPayload });
        const want = { containerName: pin.containerName, payload: pin.payload };
        assert(isDeepStrictEqual(got, want), `S3 _${suffix} payload equals the frozen pin`, JSON.stringify(got).slice(0, 600) + " VS " + JSON.stringify(want).slice(0, 600));
      }

      const { settled: local2 } = await startLocalBackup();
      assert(local2.state === "succeeded" && local2.snapshot !== null, "local backup next to the S3 history succeeds", JSON.stringify(local2));
      assert(local2.snapshot.snapshotId !== snapS3.snapshotId && local2.snapshot.snapshotId !== snapLocal1.snapshotId, "three different snapshot ids", `${snapS3.snapshotId} ${local2.snapshot.snapshotId}`);

      // The S3 history is exactly as written: its snapshot is the only one listed and a fresh restic ls still reads it.
      const snapObjects = await s3ListAll(s3Target, `${s3Target.prefix}/sites/${siteId}/snapshots/`);
      assert(
        snapObjects.length === 1 && snapObjects[0].key.endsWith(snapS3.snapshotId),
        "S3 repository still lists exactly the S3 snapshot (same id)",
        JSON.stringify(snapObjects),
      );
      createdContainers.add(lsContainerName);
      const s3Ls = await docker([
        "run", "--name", lsContainerName, "--network", networkName, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--user", "33:33", "--tmpfs", "/tmp:rw,size=64m,mode=1777",
        "-v", `${verifySecretsDir}:/run/secrets:ro`,
        "-e", "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws.creds", "-e", "RESTIC_PASSWORD_FILE=/run/secrets/backup.key",
        "-e", "RESTIC_CACHE_DIR=/tmp/cache",
        "-e", `RESTIC_REPOSITORY=s3:${s3Target.endpoint}/${s3Target.bucket}/${s3Target.prefix}/sites/${siteId}`,
        "--entrypoint", "/usr/bin/restic", RESTIC_IMAGE, "-o", "s3.bucket-lookup=path", "-o", `s3.region=${s3Target.region}`,
        "ls", "--no-lock", snapS3.snapshotId,
      ]);
      await docker(["rm", "-f", lsContainerName]);
      createdContainers.delete(lsContainerName);
      assert(s3Ls.ok && s3Ls.stdout.includes(`/backup/files/${markerFileName}`), "independent restic ls reads the S3 snapshot", s3Ls.stderr);

      // BKP-11: restore from the S3 snapshot while a local target exists.
      const stateBefore = await captureSiteAndDbState();
      assert(sameState(stateBefore, s3State), "site state unchanged since the S3 backup (the local backup altered nothing)", "state changed");
      const broke = await runSiteHelper("breakf", ["-c", `printf 'BROKEN-S3-${runHex}\\n' > /var/www/html/${markerFileName}`]);
      assert(broke.ok, "break the site marker", broke.stderr);
      const brk = await runSql(`UPDATE \`${db1Name}\`.hp_marker SET note='BROKEN-S3-DB1-${runHex}' WHERE id=1;`);
      assert(brk.exitCode === 0, "break a database row", brk.stderr.toString("utf8"));
      const rJob = newJobId();
      await adapter.backups({ action: "restore", jobId: rJob, siteId, serviceInstanceId, target: s3Target, snapshotId: snapS3.snapshotId });
      const rDone = await pollBackupJob(adapter, rJob);
      assert(rDone.state === "succeeded" && rDone.failure === null, "restore from the S3 snapshot succeeds", JSON.stringify(rDone));
      assert(sameState(await captureSiteAndDbState(), s3State), "restored files and tables equal the S3 backup state", "state mismatch");
      const page = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
      const body = await page.text();
      assert(page.status === 200 && body.includes(`FILE=${fileMarkerText}`) && body.includes(`DB1=${db1MarkerText}`), "site serves the original markers", body);
      await assertNoRestoreLeftovers();
      // Local data neither read nor written by the S3 jobs.
      const s3Mounts = s3Specs.flatMap((s) => (s.inspect?.Mounts ?? []).map((m) => m.Source));
      assert(!s3Mounts.some((m) => m.startsWith(localRoot)), "S3 jobs bind nothing from the local root", JSON.stringify(s3Mounts));
    });

    // ----------------------------------------------------------------------------------------------- 11. no-secrets
    await runStep("no-secrets", async () => {
      const secrets = [...secretsToGuard];
      assert(capturedContainerSpecs.length >= 15, "captured container specs across the run", String(capturedContainerSpecs.length));
      const leaks = [];
      for (const rec of capturedContainerSpecs) {
        const surfaces = {
          containerName: rec.containerName,
          createPayload: rec.createPayload
            ? { Env: rec.createPayload.Env ?? null, Cmd: rec.createPayload.Cmd ?? null, Entrypoint: rec.createPayload.Entrypoint ?? null, Labels: rec.createPayload.Labels ?? null }
            : null,
          inspect: rec.inspect
            ? { Env: rec.inspect.Config?.Env ?? null, Cmd: rec.inspect.Config?.Cmd ?? null, Entrypoint: rec.inspect.Config?.Entrypoint ?? null, Args: rec.inspect.Args ?? null, Labels: rec.inspect.Config?.Labels ?? null }
            : null,
        };
        // The throw-away RustFS and MariaDB containers of this script carry their own keys by design (not product jobs).
        if (!(rec.containerName ?? "").startsWith("hp_bk_")) continue;
        if (scanObjectForSecrets(surfaces, secrets).length > 0) leaks.push(rec.containerName);
      }
      assert(leaks.length === 0, "zero secrets in job container configs", JSON.stringify(leaks));

      // Local jobs: no AWS entry, no s3. token, no host path of the root, anywhere in the create payload or inspect.
      // A local container is one that binds something under the local root (the S3 test and jobs do not).
      const bindsLocal = (s) => (s.createPayload?.HostConfig?.Mounts ?? []).some((m) => String(m.Source).startsWith(`${localRoot}/`));
      const localSpecs = capturedContainerSpecs.filter((s) => bindsLocal(s) && (s.containerName ?? "").startsWith("hp_bk_"));
      assert(localSpecs.length >= 8, "local job containers captured", String(localSpecs.length));
      for (const s of localSpecs) {
        const env = s.createPayload?.Env ?? [];
        assert(!env.some((e) => /^AWS_|^HP_REGION/.test(e)) && !JSON.stringify(s.createPayload).includes("s3."), `${s.containerName}: no AWS env and no s3. token`, JSON.stringify(env));
        const labels = JSON.stringify(s.createPayload?.Labels ?? {});
        assert(!labels.includes(localRoot) && !labels.includes(targetId), `${s.containerName}: no host path or target id in labels`, labels);
      }

      for (const [label, list] of [["results", capturedResultJsons], ["errors", capturedErrorMessages], ["stdout", capturedOutputLines]]) {
        const joined = list.join("\n");
        for (const s of secrets) assert(!joined.includes(s), `no secret in ${label}`, `found a secret in ${label}`);
      }
      // No host path in any IPC result or error except `localRoot` of a test answer.
      for (const r of capturedResultJsons) {
        const o = JSON.parse(r);
        delete o.localRoot;
        assert(!JSON.stringify(o).includes(tmpRoot), "no host path in an IPC result besides localRoot", r.slice(0, 200));
      }
      assert(capturedResultJsons.some((r) => r.includes('"localRoot"')), "localRoot is reported by test/localInit", "never");
      assert(!capturedErrorMessages.join("\n").includes(tmpRoot), "no host path in any error message", capturedErrorMessages.find((e) => e.includes(tmpRoot)) ?? "");

      const notes = (await readdir(path.join(backupWorkDir, "restores")).catch(() => [])).filter((n) => n.endsWith(".json"));
      for (const n of notes) {
        const raw = await readFile(path.join(backupWorkDir, "restores", n), "utf8");
        for (const s of secrets) assert(!raw.includes(s), `no secret in restore note ${n}`, "found");
      }
      const synthetic = scanObjectForSecrets({ Env: [`LEAK=${backupKey}`] }, secrets);
      assert(synthetic.includes(backupKey), "secret scanner detects a synthetic leak", JSON.stringify(synthetic));
    });
  } finally {
    await cleanup();
  }

  fatalSetupFailure = false;
  await runStep("cleanup", async () => {
    const swarm = await dockerListNames("ps", runId);
    const jobs = await myJobObjects("ps");
    const vols = [...(await dockerListNames("volume", runId)), ...(await dockerListNames("volume", siteVolumeName)), ...(await myJobObjects("volume"))];
    const nets = await dockerListNames("network", runId);
    assert(swarm.length === 0 && jobs.length === 0, "no containers of this run left", JSON.stringify([...swarm, ...jobs]));
    assert(vols.length === 0, "no volumes of this run left", JSON.stringify(vols));
    assert(nets.length === 0, "no network of this run left", JSON.stringify(nets));
    const tmpExists = tmpRoot === "" ? false : await access(tmpRoot).then(() => true).catch(() => false);
    assert(tmpExists === false, "temporary folder removed", tmpRoot);
  });

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  logLine(
    `RESULT ${String(passed)}/${String(total)} passed${skipped > 0 ? `, ${String(skipped)} skipped (not counted in n/m)` : ""} in ${elapsedSec}s`,
  );
  if (passed !== total) process.exitCode = 1;
}

await main();
