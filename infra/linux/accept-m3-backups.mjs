#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M3a cycle 4 (encrypted site backups).
 *
 * Drives the built DockerEngineSocketAdapter.backups(...) against a throw-away
 * RustFS 1.0.5 S3 server and stand-in WordPress + MariaDB 12.3.3 containers on
 * an isolated bridge network, without publishing any host port or touching any
 * pre-existing Docker resource or /etc/hosting-panel.
 *
 * Machine safety: every created Docker resource starts with "hp_swarmtest_" (or
 * "hp_vol_svc_swarmtest_" for the managed site volume name) and is removed by
 * exact name in `finally` (including on SIGINT/SIGTERM). No prune command is
 * ever run and no missing images are pulled.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const {
  BACKUP_ARCHIVE_TTL_MS,
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  RESTORE_MAINTENANCE_FILE_CONTENT,
  SHARED_DB_ALIAS,
  buildAwsSharedCredentials,
  buildSharedDatabaseContainerPayload,
  getManagedVolumeName,
  mariadbRootExec,
  readRestoreNote,
  s3Request,
} = await import(pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href);

const {
  DEFAULT_PHP_VERSION,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  SITE_FILE_CHUNK_BYTES,
  resolveWordpressImage,
  siteDatabaseFullName,
  siteDatabasePrefix,
} = await import(pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href);

if (process.argv.includes("--child-restore-worker")) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const cfg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const childAdapter = new DockerEngineSocketAdapter(cfg.adapterOptions);
  await childAdapter.backups(cfg.restoreReq);
  process.stdout.write("STARTED\n");
  setInterval(() => {}, 10_000);
  await new Promise(() => {});
}

const SOCKET_PATH = "/var/run/docker.sock";
const RUSTFS_IMAGE =
  "rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74";
const WORDPRESS_IMAGE = resolveWordpressImage(DEFAULT_PHP_VERSION);

const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;
const networkName = `${runId}_net`;
const s3ContainerName = `${runId}_s3`;
const dbContainerName = `${runId}_db`;
const siteContainerName = `${runId}_site`;
const rcContainerName = `${runId}_rc`;
const seedContainerName = `${runId}_seed`;
const blobSeedContainerName = `${runId}_blob`;
const lsContainerName = `${runId}_ls`;
const wpOwnContainerName = `${runId}_wpown`;
const wpOwnVolumeName = `${runId}_wpown_vol`;

const siteId = `site_swarmtest_${runHex}`;
const serviceInstanceId = `svc_swarmtest_${runHex}`;
const siteVolumeName = getManagedVolumeName(serviceInstanceId, "html");
const dbPrefix = siteDatabasePrefix(siteId);
const db1Name = dbPrefix;
const db2Name = siteDatabaseFullName(dbPrefix, "shop");

const uidGid = `${String(process.getuid())}:${String(process.getgid())}`;

const createdContainers = new Set();
const createdVolumes = new Set();
const activeChildProcs = new Set();
const tempDirs = [];
let createdNetwork = false;

const secretsToGuard = new Set();
const capturedContainerSpecs = [];
const capturedFailedWaits = [];
const capturedResultJsons = [];
const capturedErrorMessages = [];
const capturedOutputLines = [];
let containerCreateCount = 0;
// Awaited right before the adapter creates an `_rs_switch` container (R102), i.e. after prepare's check passed.
let beforeSwitchCreate = null;

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
  if (err instanceof ExecutorCodedError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newJobId() {
  return `op_${randomBytes(16).toString("hex")}`;
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
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
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
    .map((line) => line.trim())
    .filter(Boolean);
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

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) =>
    decodeXmlEntities(m[1]),
  );
}

async function s3ListAll(target, prefix = "") {
  const objects = [];
  let token;
  for (;;) {
    const query = {
      "list-type": "2",
      prefix,
      ...(token ? { "continuation-token": token } : {}),
    };
    const res = await s3Request(target, "GET", "", undefined, query);
    assert(res.status === 200, "S3 ListObjectsV2 returns 200", `status=${String(res.status)}`);
    const xml = res.body.toString("utf8");
    const contents = xml.split("<Contents>").slice(1);
    for (const entry of contents) {
      const key = xmlTags(entry, "Key")[0];
      const size = Number(xmlTags(entry, "Size")[0] ?? "0");
      if (key) {
        objects.push({ key, size });
      }
    }
    if (xmlTags(xml, "IsTruncated")[0] !== "true") {
      return objects;
    }
    token = xmlTags(xml, "NextContinuationToken")[0];
    if (!token) {
      return objects;
    }
  }
}

async function s3SearchBucket(target, needles) {
  const objects = await s3ListAll(target, "");
  const hits = [];
  for (const obj of objects) {
    const res = await s3Request(target, "GET", obj.key);
    assert(
      res.status === 200,
      `S3 GetObject ${obj.key} returns 200`,
      `status=${String(res.status)}`,
    );
    for (const needle of needles) {
      if (res.body.includes(Buffer.from(needle, "utf8"))) {
        hits.push({ key: obj.key, needle });
      }
    }
  }
  return { objects, hits };
}

function instrumentAdapter(adapterInstance) {
  const client = adapterInstance.dockerClient;
  const origRequest = client.request.bind(client);
  client.request = async (method, endpointPath, body, opts) => {
    if (beforeSwitchCreate && method === "POST" && /^\/containers\/create\?name=hp_bk_[^&]*_rs_switch(?:&|$)/.test(endpointPath)) {
      const hook = beforeSwitchCreate;
      beforeSwitchCreate = null;
      await hook();
    }
    const res = await origRequest(method, endpointPath, body, opts);
    if (method === "POST" && endpointPath.startsWith("/containers/create")) {
      containerCreateCount += 1;
      let containerId;
      try {
        containerId = JSON.parse(res.body.toString("utf8"))?.Id ?? null;
      } catch {
        containerId = null;
      }
      const createQueryName = /name=([^&]+)/.exec(endpointPath)?.[1];
      const containerName = createQueryName ? decodeURIComponent(createQueryName) : containerId;
      if (containerId) {
        createdContainers.add(containerName ?? containerId);
      }
      let inspectBeforeStart = null;
      if (res.statusCode === 201 && containerId) {
        const inspectRes = await origRequest(
          "GET",
          `/containers/${encodeURIComponent(containerId)}/json`,
        );
        if (inspectRes.statusCode === 200) {
          inspectBeforeStart = JSON.parse(inspectRes.body.toString("utf8"));
        }
      }
      capturedContainerSpecs.push({
        phase: "create",
        containerName,
        containerId,
        createPayload: body ?? null,
        inspect: inspectBeforeStart,
      });
    } else if (method === "POST" && /^\/containers\/[^/]+\/start$/.test(endpointPath)) {
      const ref = decodeURIComponent(endpointPath.split("/")[2]);
      const inspectRes = await origRequest("GET", `/containers/${encodeURIComponent(ref)}/json`);
      if (inspectRes.statusCode === 200) {
        const inspectAfterStart = JSON.parse(inspectRes.body.toString("utf8"));
        capturedContainerSpecs.push({
          phase: "start",
          containerName: inspectAfterStart?.Name?.replace(/^\//, "") ?? ref,
          containerId: inspectAfterStart?.Id ?? ref,
          createPayload: null,
          inspect: inspectAfterStart,
        });
      }
    } else if (method === "POST" && /^\/containers\/[^/]+\/wait$/.test(endpointPath)) {
      const ref = decodeURIComponent(endpointPath.split("/")[2]);
      let waitCode;
      try {
        waitCode = JSON.parse(res.body.toString("utf8"))?.StatusCode ?? null;
      } catch {
        waitCode = null;
      }
      if (typeof waitCode === "number" && waitCode !== 0) {
        const logRes = await origRequest("GET", `/containers/${encodeURIComponent(ref)}/logs?stdout=1&stderr=1`);
        let text = logRes.body.toString("utf8").replace(/[^ -\u007e\n\r\t]+/g, "");
        for (const s of secretsToGuard) {
          if (s.length > 0) text = text.split(s).join("[REDACTED]");
        }
        capturedFailedWaits.push({ container: ref, exitCode: waitCode, logs: text.slice(-800) });
      }
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

async function pollBackupJob(adapterInstance, jobId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapterInstance.backups({ action: "status", jobId });
    if (status.state !== "running") {
      return status;
    }
    await sleep(150);
  }
  throw new StepAssertionError(
    `job ${jobId} settles within ${String(timeoutMs)}ms`,
    "still running",
  );
}

function scanObjectForSecrets(obj, secrets) {
  const text = JSON.stringify(obj);
  const hits = [];
  for (const s of secrets) {
    if (text.includes(s)) {
      hits.push(s);
    }
  }
  return hits;
}

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
    const leftoverBkContainers = await dockerListNames("ps", "hp_bk_").catch(() => []);
    const containers = new Set([
      ...createdContainers,
      ...leftoverBkContainers,
      wpOwnContainerName,
      lsContainerName,
      blobSeedContainerName,
      seedContainerName,
      rcContainerName,
      siteContainerName,
      dbContainerName,
      s3ContainerName,
    ]);
    for (const c of containers) {
      await docker(["rm", "-f", "-v", c]);
    }
    const leftoverBkVolumes = await dockerListNames("volume", "hp_bk_").catch(() => []);
    const volumes = new Set([
      ...createdVolumes,
      ...leftoverBkVolumes,
      wpOwnVolumeName,
      siteVolumeName,
    ]);
    for (const v of volumes) {
      await docker(["volume", "rm", v]);
    }
    if (createdNetwork) {
      await docker(["network", "rm", networkName]);
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
  let secretsRootDir = "";
  let backupWorkDir = "";
  let backupKeyFile = "";
  let wrongBackupKeyFile = "";
  let missingBackupKeyFile = "";
  let verifySecretsDir = "";
  let sharedDbRootKeyFile = "";
  let hpMailFile = "";
  let wpOwnSecretFile = "";
  let adapter = null;
  let adapter2 = null;
  let adapterOptions = null;
  let runSql = null;

  let chosenSubnet = "";
  let s3Ip = "";
  let siteIp = "";
  let goodTarget = null;
  let listOnlyTarget = null;

  const s3AccessKey = `ak_${randomBytes(12).toString("hex")}`;
  const s3SecretKey = `hpSw#rm;T3st+/=${randomBytes(12).toString("hex")}`;
  const listOnlyKey = `lk_${randomBytes(12).toString("hex")}`;
  const listOnlySecret = `ls_${randomBytes(20).toString("hex")}`;
  const backupKey = randomBytes(32).toString("hex");
  const wrongBackupKey = randomBytes(32).toString("hex");
  const mariaRootPw = randomBytes(32).toString("hex");
  const siteDbUser = `wp_${runHex}`;
  const siteDbPass = randomBytes(16).toString("hex");
  const wpOwnDbPass = randomBytes(16).toString("hex");
  const hpMailContent = `<?php // hp-mail-${runHex}\n`;
  const hpMailSha = createHash("sha256").update(hpMailContent).digest("hex");

  for (const s of [
    s3AccessKey,
    s3SecretKey,
    listOnlyKey,
    listOnlySecret,
    backupKey,
    wrongBackupKey,
    mariaRootPw,
    siteDbPass,
    wpOwnDbPass,
  ]) {
    secretsToGuard.add(s);
  }

  const markerFileName = `marker-${runHex}.txt`;
  const fileMarkerText = `MARKER-FILE-${runHex}-PLAINTEXT`;
  const db1MarkerText = `MARKER-DB1-${runHex}-ROW`;
  const db2MarkerText = `MARKER-DB2-${runHex}-ROW`;

  let initialSiteInspect = null;
  let initialDbInspect = null;
  let inFlightSample = null;
  let snap1 = null;
  let snap2 = null;
  let snapRestore = null;
  const runJobIds = [];

  try {
    // 0. Setup
    await runStep(
      "setup",
      async () => {
        for (const img of [RESTIC_IMAGE, RUSTFS_IMAGE, SHARED_MARIADB_IMAGE, WORDPRESS_IMAGE]) {
          const res = await docker(["image", "inspect", img]);
          assert(res.ok, `image ${img} present locally`, res.stderr);
        }

        tmpRoot = await mkdtemp(path.join("/dev/shm", `${runId}_`));
        tempDirs.push(tmpRoot);
        await chmod(tmpRoot, 0o755);

        secretsRootDir = path.join(tmpRoot, "secrets");
        backupWorkDir = path.join(tmpRoot, "backups");
        const mariadbDataDir = path.join(tmpRoot, "mariadb-data");
        const sftpStateDir = path.join(tmpRoot, "sftp");
        const ingressRootDir = path.join(tmpRoot, "ingress");
        const siteFilesDir = path.join(tmpRoot, "site-files");
        const siteMailDir = path.join(tmpRoot, "site-mail");
        const phpMyAdminConfigDir = path.join(tmpRoot, "phpmyadmin");
        verifySecretsDir = path.join(tmpRoot, "verify-secrets");

        for (const dir of [
          secretsRootDir,
          backupWorkDir,
          mariadbDataDir,
          sftpStateDir,
          ingressRootDir,
          siteFilesDir,
          siteMailDir,
          phpMyAdminConfigDir,
        ]) {
          await mkdir(dir, { mode: 0o700 });
        }
        await mkdir(verifySecretsDir, { mode: 0o755 });

        backupKeyFile = path.join(tmpRoot, "backup.key");
        wrongBackupKeyFile = path.join(tmpRoot, "backup-wrong.key");
        missingBackupKeyFile = path.join(tmpRoot, "missing-backup.key");
        sharedDbRootKeyFile = path.join(tmpRoot, "mariadb-root.key");
        hpMailFile = path.join(tmpRoot, "hp-mail.php");
        wpOwnSecretFile = path.join(verifySecretsDir, "wpown-db.key");

        await writeFile(backupKeyFile, backupKey, { mode: 0o400 });
        await writeFile(wrongBackupKeyFile, wrongBackupKey, { mode: 0o400 });
        await writeFile(sharedDbRootKeyFile, mariaRootPw, { mode: 0o400 });
        await writeFile(hpMailFile, hpMailContent, { mode: 0o444 });
        await writeFile(wpOwnSecretFile, wpOwnDbPass, { mode: 0o444 });

        await writeFile(
          path.join(verifySecretsDir, "aws.creds"),
          buildAwsSharedCredentials(s3AccessKey, s3SecretKey),
          { mode: 0o444 },
        );
        await writeFile(path.join(verifySecretsDir, "backup.key"), backupKey, { mode: 0o444 });

        const existingNets = await dockerJson("GET", "/networks");
        chosenSubnet = pickFreeSubnet(existingNets);
        assert(chosenSubnet !== null, "free /24 subnet found", "none available");

        await dockerJson("POST", "/networks/create", {
          Name: networkName,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Driver: "default", Config: [{ Subnet: chosenSubnet }] },
        });
        createdNetwork = true;

        // Start throw-away RustFS 1.0.5 (no host ports, tmpfs /data 512m, read-only root).
        const s3Payload = {
          Image: RUSTFS_IMAGE,
          Env: [`RUSTFS_ACCESS_KEY=${s3AccessKey}`, `RUSTFS_SECRET_KEY=${s3SecretKey}`],
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: networkName,
            RestartPolicy: { Name: "no" },
            Tmpfs: {
              "/tmp": "rw,size=64m,uid=10001,gid=10001",
              "/data": "rw,size=512m,uid=10001,gid=10001",
              "/logs": "rw,size=16m,uid=10001,gid=10001",
            },
          },
        };
        assert(
          !("PortBindings" in s3Payload.HostConfig) && !("ExposedPorts" in s3Payload),
          "RustFS publishes no host port",
          JSON.stringify(s3Payload.HostConfig),
        );
        await dockerJson(
          "POST",
          `/containers/create?name=${encodeURIComponent(s3ContainerName)}`,
          s3Payload,
        );
        createdContainers.add(s3ContainerName);
        await dockerJson("POST", `/containers/${encodeURIComponent(s3ContainerName)}/start`, {});

        const s3Inspect = await dockerInspectContainer(s3ContainerName);
        s3Ip = s3Inspect?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
        assert(s3Ip.length > 0, "RustFS container IP assigned", s3Ip);

        goodTarget = {
          endpoint: `http://${s3Ip}:9000`,
          region: "us-east-1",
          bucket: `hp-backups-${runHex}`,
          prefix: `tenant-${runHex}`,
          accessKeyId: s3AccessKey,
          secretAccessKey: s3SecretKey,
        };
        listOnlyTarget = {
          ...goodTarget,
          accessKeyId: listOnlyKey,
          secretAccessKey: listOnlySecret,
        };

        // Wait for RustFS HTTP readiness (answers 403 on unsigned GET /, 503 while starting).
        const s3Deadline = Date.now() + 30_000;
        let s3Ready = false;
        while (Date.now() < s3Deadline) {
          try {
            const res = await fetch(`${goodTarget.endpoint}/`, {
              signal: AbortSignal.timeout(2_000),
            });
            if (res.status === 403) {
              s3Ready = true;
              break;
            }
          } catch {
            // retry until ready
          }
          await sleep(250);
        }
        assert(s3Ready, "RustFS answers HTTP within 30s", "timed out");

        // Create bucket via signed PUT /<bucket>.
        const createBucketRes = await s3Request(goodTarget, "PUT", "");
        assert(
          createBucketRes.status === 200 || createBucketRes.status === 204,
          "create RustFS bucket via s3Request",
          `status=${String(createBucketRes.status)} ${createBucketRes.body.toString("utf8")}`,
        );

        // Create list-only user on RustFS using rc inside rustfs/rustfs:1.0.5 (creds via stdin).
        const rcScript = [
          "set -eu",
          "IFS= read -r ak",
          "IFS= read -r sk",
          "IFS= read -r lak",
          "IFS= read -r lsk",
          `rc alias set l "${goodTarget.endpoint}" "$ak" "$sk" >/dev/null`,
          `printf '%s\\n' '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetObject"],"Resource":["arn:aws:s3:::*"]}]}' > /tmp/listonly.json`,
          "rc admin policy create l listonly /tmp/listonly.json >/dev/null",
          'rc admin user add l "$lak" "$lsk" >/dev/null',
          'rc admin policy attach l listonly --user "$lak" >/dev/null',
        ].join("\n");
        createdContainers.add(rcContainerName);
        const rcRes = await docker(
          [
            "run",
            "-i",
            "--name",
            rcContainerName,
            "--network",
            networkName,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--tmpfs",
            "/tmp:rw,size=16m",
            "--tmpfs",
            "/home/rc:rw,size=4m,uid=10001,gid=10001",
            "-e",
            "HOME=/home/rc",
            "--entrypoint",
            "sh",
            RUSTFS_IMAGE,
            "-c",
            rcScript,
          ],
          { stdin: `${s3AccessKey}\n${s3SecretKey}\n${listOnlyKey}\n${listOnlySecret}\n` },
        );
        await docker(["rm", "-f", rcContainerName]);
        createdContainers.delete(rcContainerName);
        assert(rcRes.ok, "create RustFS list-only user via rc", rcRes.stderr);

        // Start throw-away MariaDB 12.3.3 on isolated network with hp-mariadb alias.
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
          NetworkingConfig: {
            EndpointsConfig: { [networkName]: { Aliases: [SHARED_DB_ALIAS] } },
          },
        };
        assert(
          !("PortBindings" in dbPayload.HostConfig) && !("ExposedPorts" in dbPayload),
          "MariaDB publishes no host port",
          JSON.stringify(dbPayload.HostConfig),
        );
        await dockerJson(
          "POST",
          `/containers/create?name=${encodeURIComponent(dbContainerName)}`,
          dbPayload,
        );
        createdContainers.add(dbContainerName);
        await dockerJson("POST", `/containers/${encodeURIComponent(dbContainerName)}/start`, {});

        // Create site volume (host disk so df >= 1 GiB floor passes), init 33:33, seed files, then start PHP server with hp-mail.php:ro.
        const volCreate = await docker([
          "volume",
          "create",
          "--label",
          `io.hostingpanel.site_id=${siteId}`,
          siteVolumeName,
        ]);
        assert(volCreate.ok, `site volume ${siteVolumeName} created`, volCreate.stderr);
        createdVolumes.add(siteVolumeName);

        const initVolContainer = `${runId}_volinit`;
        createdContainers.add(initVolContainer);
        const volInitRes = await docker([
          "run",
          "--name",
          initVolContainer,
          "--network",
          "none",
          "--user",
          "0:0",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "FOWNER",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "sh",
          "-v",
          `${siteVolumeName}:/var/www/html`,
          WORDPRESS_IMAGE,
          "-c",
          "chmod 0755 /var/www/html && chown 33:33 /var/www/html",
        ]);
        await docker(["rm", "-f", initVolContainer]);
        createdContainers.delete(initVolContainer);
        assert(volInitRes.ok, "initialize site volume ownership 33:33", volInitRes.stderr);

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
            "/var/www/html/wp-content/uploads/hello.txt": {
              content: `HELLO-${runHex}\n`,
              mode: 0o644,
            },
            "/var/www/html/wp-content/themes/site-style.css": {
              content: `/* style-${runHex} */\n`,
              mode: 0o644,
            },
          },
        });

        createdContainers.add(seedContainerName);
        const seedRes = await docker(
          [
            "run",
            "-i",
            "--name",
            seedContainerName,
            "--network",
            "none",
            "--user",
            "33:33",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "php",
            "-v",
            `${siteVolumeName}:/var/www/html`,
            WORDPRESS_IMAGE,
            "-r",
            '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["files"] as $p=>$f){ $dir=dirname($p); if(!is_dir($dir)) mkdir($dir,0755,true); file_put_contents($p,$f["content"]); chmod($p,$f["mode"]); }',
          ],
          { stdin: seedPayload },
        );
        await docker(["rm", "-f", seedContainerName]);
        createdContainers.delete(seedContainerName);
        assert(seedRes.ok, "seed stand-in site files into site volume", seedRes.stderr);

        const siteRun = await docker([
          "run",
          "-d",
          "--name",
          siteContainerName,
          "--network",
          networkName,
          "--user",
          "33:33",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "php",
          "-e",
          "PHP_CLI_SERVER_WORKERS=4",
          "--label",
          `io.hostingpanel.service_instance_id=${serviceInstanceId}`,
          "--label",
          `io.hostingpanel.site_id=${siteId}`,
          "-v",
          `${siteVolumeName}:/var/www/html`,
          "-v",
          `${hpMailFile}:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro`,
          WORDPRESS_IMAGE,
          "-S",
          "0.0.0.0:8080",
          "-t",
          "/var/www/html",
        ]);
        assert(siteRun.ok, "stand-in WordPress site container starts", siteRun.stderr);
        createdContainers.add(siteContainerName);

        const siteInspectInit = await dockerInspectContainer(siteContainerName);
        siteIp = siteInspectInit?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
        assert(siteIp.length > 0, "stand-in site container IP assigned", siteIp);
        assert(
          Object.keys(siteInspectInit?.HostConfig?.PortBindings ?? {}).length === 0,
          "stand-in site publishes no host port",
          JSON.stringify(siteInspectInit?.HostConfig?.PortBindings ?? null),
        );

        adapterOptions = {
          pullMissingImages: false,
          secretsRootDir,
          backupWorkDir,
          sftpStateDir,
          ingressRootDir,
          siteFilesDir,
          siteMailDir,
          phpMyAdminConfigDir,
          sharedDbDataDir: mariadbDataDir,
          sharedDbRootKeyFile,
          sharedDbContainerName: dbContainerName,
          sharedDbNetworkName: networkName,
          backupKeyFile,
          backupNetworkName: networkName,
          executorUid: process.getuid(),
        };
        adapter = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));

        // Wait for MariaDB readiness via adapter.siteDatabases list.
        const dbDeadline = Date.now() + 120_000;
        let dbReady = false;
        while (Date.now() < dbDeadline) {
          try {
            await adapter.siteDatabases({ siteId, op: "list" });
            dbReady = true;
            break;
          } catch (err) {
            if (!(err instanceof ExecutorCodedError && err.code === "DOCKER_ENGINE_UNAVAILABLE")) {
              throw err;
            }
            await sleep(500);
          }
        }
        assert(dbReady, "MariaDB ready within 120s", "timed out");

        // Provision two site databases (primary + custom), site DB user, marker rows, FK tables, trigger, and view.
        runSql = mariadbRootExec(
          { request: dockerRequest, socketPath: SOCKET_PATH, apiPrefix: "" },
          dbContainerName,
        );
        const r1 = await runSql(
          `CREATE DATABASE \`${db1Name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        );
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
            `CREATE TABLE hp_marker (id INT PRIMARY KEY, note VARCHAR(255)) ENGINE=InnoDB;`,
            `INSERT INTO hp_marker VALUES (1, '${db2MarkerText}');`,
            `CREATE TABLE hp_parent (id INT PRIMARY KEY, name VARCHAR(64)) ENGINE=InnoDB;`,
            `INSERT INTO hp_parent VALUES (1, 'parent-1'), (2, 'parent-2');`,
            `CREATE TABLE hp_child (id INT PRIMARY KEY, parent_id INT NOT NULL, val VARCHAR(64), CONSTRAINT fk_hp_child_parent FOREIGN KEY (parent_id) REFERENCES hp_parent(id)) ENGINE=InnoDB;`,
            `CREATE TABLE hp_audit (id INT AUTO_INCREMENT PRIMARY KEY, child_id INT NOT NULL, action VARCHAR(32)) ENGINE=InnoDB;`,
            `CREATE TRIGGER tr_hp_child_ins AFTER INSERT ON hp_child FOR EACH ROW INSERT INTO hp_audit (child_id, action) VALUES (NEW.id, 'insert');`,
            `INSERT INTO hp_child VALUES (10, 1, 'child-10');`,
            `CREATE VIEW v_hp_parent_child AS SELECT p.id AS parent_id, p.name AS parent_name, c.id AS child_id, c.val FROM hp_parent p JOIN hp_child c ON c.parent_id = p.id;`,
          ].join(" "),
        );
        assert(rSeed2.exitCode === 0, `seed FK tables/trigger/view in ${db2Name}`, rSeed2.stderr.toString("utf8"));

        // Verify stand-in site HTTP server answers 200 with original markers + mounted hp-mail.php hash.
        const siteHttpDeadline = Date.now() + 15_000;
        let siteInitResp = null;
        while (Date.now() < siteHttpDeadline) {
          try {
            const res = await fetch(`http://${siteIp}:8080/`, {
              signal: AbortSignal.timeout(2_000),
            });
            const text = await res.text();
            if (res.status === 200 && text.startsWith("OK|")) {
              siteInitResp = { status: res.status, text };
              break;
            }
          } catch {
            // retry until PHP server listens
          }
          await sleep(150);
        }
        assert(
          siteInitResp !== null &&
            siteInitResp.text.includes(`FILE=${fileMarkerText}`) &&
            siteInitResp.text.includes(`DB1=${db1MarkerText}`) &&
            siteInitResp.text.includes(`DB2=${db2MarkerText}`) &&
            siteInitResp.text.includes(`MAIL=${hpMailSha}`),
          "stand-in site answers 200 with file/DB markers and hp-mail.php sha",
          JSON.stringify(siteInitResp),
        );

        const listedDbs = await adapter.siteDatabases({ siteId, op: "list" });
        const dbNames = listedDbs.databases.map((d) => d.name).sort();
        assert(
          dbNames.length === 2 && dbNames.includes(db1Name) && dbNames.includes(db2Name),
          "both site databases listed by adapter",
          JSON.stringify(dbNames),
        );

        initialSiteInspect = await dockerInspectContainer(siteContainerName);
        initialDbInspect = await dockerInspectContainer(dbContainerName);
        assert(
          initialSiteInspect?.State?.Running === true && initialDbInspect?.State?.Running === true,
          "site and MariaDB containers running",
          "not running",
        );
      },
      { abortOnFail: true },
    );

    // 1. Connection test ok < 30s and panel repo created under prefix
    if (!fatalSetupFailure) {
      await runStep("connection-test-ok", async () => {
        const t0 = performance.now();
        const res = await adapter.backups({ action: "test", target: goodTarget });
        const elapsedMs = performance.now() - t0;
        assert(
          res.outcome === "ok" && res.problem === null,
          "test answers { outcome: ok, problem: null }",
          JSON.stringify(res),
        );
        assert(elapsedMs < 30_000, "test finishes under 30s", `${String(Math.round(elapsedMs))}ms`);

        const panelConfig = await s3ListAll(goodTarget, `${goodTarget.prefix}/panel/config`);
        assert(
          panelConfig.some((o) => o.key === `${goodTarget.prefix}/panel/config`),
          "panel repository config exists under prefix",
          JSON.stringify(panelConfig),
        );
      });
    }

    // 2. Seven failure classes under 30s
    if (!fatalSetupFailure) {
      await runStep("connection-test-failures", async () => {
        const wrongKeyAdapter = instrumentAdapter(
          new DockerEngineSocketAdapter({ ...adapterOptions, backupKeyFile: wrongBackupKeyFile }),
        );
        const missingKeyAdapter = instrumentAdapter(
          new DockerEngineSocketAdapter({ ...adapterOptions, backupKeyFile: missingBackupKeyFile }),
        );

        const unusedIp = chosenSubnet.replace(/\.0\/24$/, ".250");
        const cases = [
          {
            label: "auth_failed",
            exec: () =>
              adapter.backups({
                action: "test",
                target: { ...goodTarget, secretAccessKey: `wrong-${s3SecretKey}` },
              }),
          },
          {
            label: "bucket_missing",
            exec: () =>
              adapter.backups({
                action: "test",
                target: { ...goodTarget, bucket: `missing-bucket-${runHex}` },
              }),
          },
          {
            label: "write_denied",
            exec: () => adapter.backups({ action: "test", target: listOnlyTarget }),
          },
          {
            label: "unreachable",
            exec: () =>
              adapter.backups({
                action: "test",
                target: { ...goodTarget, endpoint: `http://${unusedIp}:9000` },
              }),
          },
          {
            label: "tls_failed",
            exec: () =>
              adapter.backups({
                action: "test",
                target: { ...goodTarget, endpoint: `https://${s3Ip}:9000` },
              }),
          },
          {
            label: "wrong_key",
            exec: () => wrongKeyAdapter.backups({ action: "test", target: goodTarget }),
          },
          {
            label: "key_file_missing",
            exec: () => missingKeyAdapter.backups({ action: "test", target: goodTarget }),
          },
        ];

        for (const c of cases) {
          const t0 = performance.now();
          const res = await c.exec();
          const elapsedMs = performance.now() - t0;
          assert(
            res.outcome === "failed" && res.problem === c.label,
            `${c.label} problem`,
            `${c.label}: ${JSON.stringify(res)}`,
          );
          assert(
            elapsedMs < 30_000,
            `${c.label} finishes under 30s`,
            `${String(Math.round(elapsedMs))}ms`,
          );
        }
      });
    }

    // 3. First backup succeeds (64-hex snapshotId) and independent restic ls finds marker + 2 DB dumps
    if (!fatalSetupFailure) {
      await runStep(
        "backup-and-list-copy",
        async () => {
          const jobId = newJobId();
          runJobIds.push(jobId);
          const started = await adapter.backups({
            action: "start",
            jobId,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          assert(started.state === "running", "start returns running", JSON.stringify(started));

          const settled = await pollBackupJob(adapter, jobId);
          assert(
            settled.state === "succeeded" && settled.failure === null && settled.snapshot !== null,
            "first backup succeeds",
            JSON.stringify(settled),
          );
          snap1 = settled.snapshot;
          assert(
            /^[0-9a-f]{64}$/.test(snap1.snapshotId),
            "64-hex snapshotId",
            snap1.snapshotId,
          );
          assert(snap1.bytesAdded > 0 && snap1.totalBytes > 0, "positive byte counts", JSON.stringify(snap1));

          // Independently list snapshot contents in our own hardened restic container (not a restore).
          createdContainers.add(lsContainerName);
          const lsRes = await docker([
            "run",
            "--name",
            lsContainerName,
            "--network",
            networkName,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            "33:33",
            "--tmpfs",
            "/tmp:rw,size=64m,mode=1777",
            "-v",
            `${verifySecretsDir}:/run/secrets:ro`,
            "-e",
            "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws.creds",
            "-e",
            "RESTIC_PASSWORD_FILE=/run/secrets/backup.key",
            "-e",
            "RESTIC_CACHE_DIR=/tmp/cache",
            "-e",
            `RESTIC_REPOSITORY=s3:${goodTarget.endpoint}/${goodTarget.bucket}/${goodTarget.prefix}/sites/${siteId}`,
            "--entrypoint",
            "/usr/bin/restic",
            RESTIC_IMAGE,
            "-o",
            "s3.bucket-lookup=path",
            "-o",
            `s3.region=${goodTarget.region}`,
            "ls",
            "--no-lock",
            snap1.snapshotId,
          ]);
          await docker(["rm", "-f", lsContainerName]);
          createdContainers.delete(lsContainerName);
          assert(lsRes.ok, "independent restic ls exits 0", lsRes.stderr);

          const lines = lsRes.stdout.split(/\r?\n/).map((l) => l.trim());
          assert(
            lines.includes(`/backup/files/${markerFileName}`),
            `snapshot lists /backup/files/${markerFileName}`,
            lsRes.stdout,
          );
          assert(
            lines.includes(`/backup/databases/${db1Name}.sql`),
            `snapshot lists /backup/databases/${db1Name}.sql`,
            lsRes.stdout,
          );
          assert(
            lines.includes(`/backup/databases/${db2Name}.sql`),
            `snapshot lists /backup/databases/${db2Name}.sql`,
            lsRes.stdout,
          );
        },
        { abortOnFail: true },
      );
    }

    // 4. Download every object in the bucket: zero plaintext markers or DB names (+ negative control)
    if (!fatalSetupFailure) {
      await runStep("bucket-ciphertext-only", async () => {
        const needles = [fileMarkerText, db1MarkerText, db2MarkerText, db1Name, db2Name];
        const { objects, hits } = await s3SearchBucket(goodTarget, needles);
        assert(objects.length > 0, "bucket contains backup objects", String(objects.length));
        assert(hits.length === 0, "zero plaintext markers or DB names in bucket", JSON.stringify(hits));

        // Prove the bucket scanner can fail by uploading a temporary plaintext canary and removing it.
        const canaryKey = `${goodTarget.prefix}/.hp-canary-${runHex}`;
        const putRes = await s3Request(goodTarget, "PUT", canaryKey, Buffer.from(fileMarkerText, "utf8"));
        assert(
          putRes.status === 200 || putRes.status === 204,
          "upload temporary canary object",
          `status=${String(putRes.status)}`,
        );
        try {
          const canaryScan = await s3SearchBucket(goodTarget, [fileMarkerText]);
          assert(
            canaryScan.hits.some((h) => h.key === canaryKey),
            "bucket scanner detects plaintext canary",
            JSON.stringify(canaryScan.hits),
          );
        } finally {
          await s3Request(goodTarget, "DELETE", canaryKey);
        }
      });
    }

    // 5. Second backup succeeds with different snapshotId and fewer bytes added
    if (!fatalSetupFailure) {
      await runStep("second-backup-dedup", async () => {
        const jobId = newJobId();
        runJobIds.push(jobId);
        await adapter.backups({
          action: "start",
          jobId,
          siteId,
          serviceInstanceId,
          target: goodTarget,
        });
        const settled = await pollBackupJob(adapter, jobId);
        assert(
          settled.state === "succeeded" && settled.snapshot !== null,
          "second backup succeeds",
          JSON.stringify(settled),
        );
        snap2 = settled.snapshot;
        assert(
          /^[0-9a-f]{64}$/.test(snap2.snapshotId) && snap2.snapshotId !== snap1.snapshotId,
          "different 64-hex snapshotId",
          `${snap1.snapshotId} vs ${snap2.snapshotId}`,
        );
        assert(
          snap2.bytesAdded < snap1.bytesAdded,
          `fewer bytes added (${String(snap2.bytesAdded)} < ${String(snap1.bytesAdded)})`,
          `${String(snap2.bytesAdded)} >= ${String(snap1.bytesAdded)}`,
        );
      });
    }

    // 6. Forgetting first backup removes exactly one snapshot object; repeat forget succeeds
    if (!fatalSetupFailure) {
      await runStep("forget-snapshot-and-idempotent-repeat", async () => {
        const snapshotsPrefix = `${goodTarget.prefix}/sites/${siteId}/snapshots/`;
        const dataPrefix = `${goodTarget.prefix}/sites/${siteId}/data/`;

        const snapsBefore = await s3ListAll(goodTarget, snapshotsPrefix);
        const dataBefore = await s3ListAll(goodTarget, dataPrefix);
        const dataBytesBefore = dataBefore.reduce((sum, o) => sum + o.size, 0);
        assert(snapsBefore.length === 2, "two snapshots before forget", String(snapsBefore.length));

        const forgetJob1 = `${runJobIds[0]}-forget`;
        runJobIds.push(forgetJob1);
        await adapter.backups({
          action: "forget",
          jobId: forgetJob1,
          siteId,
          target: goodTarget,
          snapshotIds: [snap1.snapshotId],
        });
        const settled1 = await pollBackupJob(adapter, forgetJob1);
        assert(
          settled1.state === "succeeded" && settled1.failure === null,
          "first forget succeeds",
          JSON.stringify(settled1),
        );

        const snapsAfter = await s3ListAll(goodTarget, snapshotsPrefix);
        const dataAfter = await s3ListAll(goodTarget, dataPrefix);
        const dataBytesAfter = dataAfter.reduce((sum, o) => sum + o.size, 0);
        assert(
          snapsAfter.length === snapsBefore.length - 1,
          "snapshot object count drops by 1",
          `${String(snapsBefore.length)} -> ${String(snapsAfter.length)}`,
        );
        assert(
          !snapsAfter.some((o) => o.key.endsWith(`/${snap1.snapshotId}`)) &&
            snapsAfter.some((o) => o.key.endsWith(`/${snap2.snapshotId}`)),
          "first snapshot removed and second kept",
          JSON.stringify(snapsAfter),
        );
        assert(
          dataBytesAfter <= dataBytesBefore,
          "data/ bytes shrink or stay same",
          `${String(dataBytesAfter)} > ${String(dataBytesBefore)}`,
        );

        const forgetJob2 = `${newJobId()}-forget`;
        runJobIds.push(forgetJob2);
        await adapter.backups({
          action: "forget",
          jobId: forgetJob2,
          siteId,
          target: goodTarget,
          snapshotIds: [snap1.snapshotId],
        });
        const settled2 = await pollBackupJob(adapter, forgetJob2);
        assert(
          settled2.state === "succeeded" && settled2.failure === null,
          "repeat forget of already-gone snapshot succeeds",
          JSON.stringify(settled2),
        );

        const snapsAfterRepeat = await s3ListAll(goodTarget, snapshotsPrefix);
        assert(
          snapsAfterRepeat.length === snapsAfter.length,
          "snapshot count unchanged after repeat forget",
          String(snapsAfterRepeat.length),
        );
      });
    }

    // Helpers for M3b restore & download acceptance steps
    const runSiteHelper = async (suffix, cmdArgs, opts = {}) => {
      const cName = `${runId}_${suffix}`;
      createdContainers.add(cName);
      try {
        return await docker(
          [
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
          ],
          opts.stdin !== undefined ? { stdin: opts.stdin } : undefined,
        );
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
        const tables = tblRes.stdout
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (tables.length > 0) {
          const tableList = tables.map((t) => `\`${db}\`.\`${t}\``).join(", ");
          const csumRes = await runSql(`CHECKSUM TABLE ${tableList};`);
          assert(csumRes.exitCode === 0, `CHECKSUM TABLE on ${db}`, csumRes.stderr.toString("utf8"));
          checksumParts.push(`${db}:\n${csumRes.stdout.toString("utf8").trim()}`);
        } else {
          checksumParts.push(`${db}:(none)`);
        }
      }

      const showQueries = [
        `SHOW CREATE VIEW \`${db2Name}\`.v_hp_parent_child;`,
        `SHOW CREATE TRIGGER \`${db2Name}\`.tr_hp_child_ins;`,
        `SHOW CREATE TABLE \`${db2Name}\`.hp_parent;`,
        `SHOW CREATE TABLE \`${db2Name}\`.hp_child;`,
      ];
      const showCreates = [];
      for (const q of showQueries) {
        const res = await runSql(q);
        assert(res.exitCode === 0, `run ${q}`, res.stderr.toString("utf8"));
        // Strip only MariaDB's trigger recreation timestamp column (Created) while comparing full DDL/SQL.
        const normalized = res.stdout
          .toString("utf8")
          .trim()
          .replace(/\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/, "");
        showCreates.push(normalized);
      }

      return {
        fileHashesText: hashRes.stdout.trim(),
        checksumsText: checksumParts.join("\n"),
        showCreatesText: showCreates.join("\n---\n"),
      };
    };

    const findSiteLeftovers = async () => {
      const res = await runSiteHelper(
        "leftover",
        [
          "-c",
          "set -eu; cd /var/www/html; find . -maxdepth 1 \\( -name '.maintenance*' -o -name '.hp_rs_*' \\) | LC_ALL=C sort",
        ],
        { ro: true },
      );
      assert(res.ok, "scan site volume for restore leftovers", res.stderr);
      return res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const assertNoRestoreLeftovers = async () => {
      const siteLeft = await findSiteLeftovers();
      assert(siteLeft.length === 0, "no .maintenance or .hp_rs_* in site volume", JSON.stringify(siteLeft));

      const dbRes = await runSql("SHOW DATABASES LIKE 'hp\\\\_r%';");
      assert(dbRes.exitCode === 0, "query MariaDB for hp_r* schemas", dbRes.stderr.toString("utf8"));
      const leftSchemas = dbRes.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      assert(leftSchemas.length === 0, "no hp_r* schemas left on MariaDB", JSON.stringify(leftSchemas));

      const bkPs = await dockerListNames("ps", "hp_bk_");
      assert(bkPs.length === 0, "no hp_bk_* containers left", JSON.stringify(bkPs));
      const bkVols = await dockerListNames("volume", "hp_bk_");
      assert(bkVols.length === 0, "no hp_bk_* volumes left", JSON.stringify(bkVols));

      const secretEntries = await readdir(secretsRootDir).catch(() => []);
      const jobSecrets = secretEntries.filter((n) => n.startsWith("job_bk_"));
      assert(jobSecrets.length === 0, "no job_bk_* secrets dirs left", JSON.stringify(jobSecrets));
    };

    const startMariaDbLock = async () => {
      const lockScript = [
        "set -eu",
        "trap 'rm -f /tmp/hp-lock.cnf' EXIT",
        'printf \'[client]\\nuser=root\\nhost=localhost\\npassword=%s\\n\' "$(cat /run/secrets/mariadb-root)" > /tmp/hp-lock.cnf',
        `mariadb --defaults-extra-file=/tmp/hp-lock.cnf -N -B -e "BEGIN; SELECT * FROM \\\`${db1Name}\\\`.hp_marker FOR UPDATE; SELECT SLEEP(60); COMMIT;"`,
      ].join("\n");
      const lockChild = spawn("docker", ["exec", "-i", dbContainerName, "sh", "-c", lockScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildProcs.add(lockChild);
      const exitPromise = new Promise((resolve) => {
        lockChild.once("exit", (code, signal) => {
          activeChildProcs.delete(lockChild);
          resolve({ code, signal });
        });
      });

      let lockConnId = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const res = await runSql(
          "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%SELECT SLEEP(60)%' AND INFO NOT LIKE '%information_schema.PROCESSLIST%' LIMIT 1;",
        );
        if (res.exitCode === 0) {
          const id = res.stdout.toString("utf8").trim();
          if (/^\d+$/.test(id)) {
            lockConnId = id;
            break;
          }
        }
        await sleep(50);
      }
      assert(lockConnId !== null, "MariaDB lock session active in PROCESSLIST", "not found");

      return {
        connId: lockConnId,
        release: async () => {
          await runSql(`KILL ${lockConnId};`).catch(() => undefined);
          await Promise.race([exitPromise, sleep(5_000)]);
          if (activeChildProcs.has(lockChild)) {
            lockChild.kill("SIGKILL");
          }
        },
      };
    };

    const spawnChildRestoreWorker = async (jobId, snapshotId) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child-restore-worker"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      activeChildProcs.add(child);
      let stdoutBuf = "";
      let stderrBuf = "";
      const exitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
          activeChildProcs.delete(child);
          resolve({ code, signal });
        });
      });
      const startedPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child restore worker did not start: ${stderrBuf}`)),
          15_000,
        );
        child.stdout.on("data", (d) => {
          stdoutBuf += d.toString("utf8");
          if (stdoutBuf.includes("STARTED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on("data", (d) => {
          stderrBuf += d.toString("utf8");
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`child exited early code=${String(code)} sig=${String(signal)} err=${stderrBuf}`));
        });
      });
      child.stdin.write(
        JSON.stringify({
          adapterOptions,
          restoreReq: {
            action: "restore",
            jobId,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId,
          },
        }),
      );
      child.stdin.end();
      await startedPromise;
      return { child, exitPromise };
    };

    let restoreFullSpecs = [];
    let restoreFullJobId = "";
    let brokenRefState = null;

    // 6a. Full restore: backup, record hashes & DB state, break site & DBs, restore while polling HTTP 100ms
    if (!fatalSetupFailure) {
      await runStep(
        "restore-full",
        async () => {
          // Seed a 12 MiB random file so _rs_fetch and _zip run long enough to test reliably yet finish in ~1-2s.
          const payloadSeedRes = await runSiteHelper("payseed", [
            "-c",
            `head -c 12582912 /dev/urandom > /var/www/html/wp-content/uploads/payload-${runHex}.bin`,
          ]);
          assert(payloadSeedRes.ok, "seed 12 MiB payload file", payloadSeedRes.stderr);

          const prepBkJob = newJobId();
          runJobIds.push(prepBkJob);
          await adapter.backups({
            action: "start",
            jobId: prepBkJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          const bkSettled = await pollBackupJob(adapter, prepBkJob);
          assert(
            bkSettled.state === "succeeded" && bkSettled.snapshot !== null,
            "pre-restore backup succeeds",
            JSON.stringify(bkSettled),
          );
          snapRestore = bkSettled.snapshot;

          const origState = await captureSiteAndDbState();

          // Break site files: delete hello.txt, change marker and CSS, add unwanted file.
          const breakFilesRes = await runSiteHelper("breakf", [
            "-c",
            [
              "set -eu",
              "rm -f /var/www/html/wp-content/uploads/hello.txt",
              `printf 'BROKEN-FILE-${runHex}\\n' > /var/www/html/${markerFileName}`,
              "printf '/* broken */\\n' > /var/www/html/wp-content/themes/site-style.css",
              `printf 'unwanted-${runHex}\\n' > /var/www/html/unwanted-broken-${runHex}.txt`,
            ].join("; "),
          ]);
          assert(breakFilesRes.ok, "break site files", breakFilesRes.stderr);

          // Break both databases: drop table, update marker rows, drop trigger and view and FK child table.
          const breakDbRes = await runSql(
            [
              `DROP TABLE \`${db1Name}\`.hp_extra1;`,
              `UPDATE \`${db1Name}\`.hp_marker SET note='BROKEN-DB1-${runHex}' WHERE id=1;`,
              `UPDATE \`${db2Name}\`.hp_marker SET note='BROKEN-DB2-${runHex}' WHERE id=1;`,
              `DROP VIEW \`${db2Name}\`.v_hp_parent_child;`,
              `DROP TRIGGER \`${db2Name}\`.tr_hp_child_ins;`,
              `DROP TABLE \`${db2Name}\`.hp_child;`,
            ].join(" "),
          );
          assert(breakDbRes.exitCode === 0, "break both site databases", breakDbRes.stderr.toString("utf8"));

          // Negative control: hash comparison against broken state must differ.
          const brokenHashRes = await runSiteHelper(
            "brkhash",
            [
              "-c",
              "set -eu; cd /var/www/html; find . -type f ! -path './wp-content/mu-plugins/hp-mail.php' | LC_ALL=C sort | while IFS= read -r f; do sha256sum \"$f\"; done",
            ],
            { ro: true },
          );
          assert(brokenHashRes.ok, "compute broken file hashes", brokenHashRes.stderr);
          assert(
            brokenHashRes.stdout.trim() !== origState.fileHashesText,
            "hash check detects broken site files",
            "hashes unexpectedly matched",
          );

          const brokenPage = await fetch(`http://${siteIp}:8080/`, {
            signal: AbortSignal.timeout(2_000),
          });
          const brokenBody = await brokenPage.text();
          assert(
            brokenPage.status === 200 && brokenBody.includes(`BROKEN-FILE-${runHex}`),
            "broken site serves 200 with broken marker before restore",
            `status=${String(brokenPage.status)} body=${brokenBody}`,
          );

          const specStartIdx = capturedContainerSpecs.length;
          restoreFullJobId = newJobId();
          runJobIds.push(restoreFullJobId);

          const httpSamples = [];
          let pollingHttp = true;
          const httpLoop = (async () => {
            while (pollingHttp) {
              const t = performance.now();
              try {
                const res = await fetch(`http://${siteIp}:8080/`, {
                  signal: AbortSignal.timeout(1_500),
                });
                const body = await res.text();
                httpSamples.push({ t, status: res.status, body });
              } catch (err) {
                httpSamples.push({ t, status: 0, body: formatErr(err) });
              }
              await sleep(100);
            }
          })();

          let restoreResult;
          try {
            await adapter.backups({
              action: "restore",
              jobId: restoreFullJobId,
              siteId,
              serviceInstanceId,
              target: goodTarget,
              snapshotId: snapRestore.snapshotId,
            });
            restoreResult = await pollBackupJob(adapter, restoreFullJobId);
          } finally {
            pollingHttp = false;
            await httpLoop;
          }

          assert(
            restoreResult.state === "succeeded" && restoreResult.failure === null,
            "restore-full settles succeeded",
            `${JSON.stringify(restoreResult)} wait=${JSON.stringify(capturedFailedWaits.slice(-2))}`,
          );

          // At first succeeded answer, page is already 200 with original marker and .maintenance is gone (R79).
          const afterPage = await fetch(`http://${siteIp}:8080/`, {
            signal: AbortSignal.timeout(2_000),
          });
          const afterBody = await afterPage.text();
          assert(
            afterPage.status === 200 &&
              afterBody.includes(`FILE=${fileMarkerText}`) &&
              afterBody.includes(`DB1=${db1MarkerText}`) &&
              afterBody.includes(`DB2=${db2MarkerText}`) &&
              afterBody.includes(`MAIL=${hpMailSha}`),
            "site answers 200 with original markers and intact hp-mail.php mount right on succeeded",
            `status=${String(afterPage.status)} body=${afterBody}`,
          );

          // Verify HTTP poll sequence: only 200 or 503, never broken content after first 503.
          let saw503 = false;
          let max503Run = 0;
          let cur503Run = 0;
          let cur503Start = 0;
          let max503SpanMs = 0;
          for (const s of httpSamples) {
            assert(
              s.status === 200 || s.status === 503,
              "every HTTP poll during restore answered 200 or 503",
              JSON.stringify(s),
            );
            if (s.status === 503) {
              if (cur503Run === 0) cur503Start = s.t;
              cur503Run += 1;
              if (cur503Run > max503Run) max503Run = cur503Run;
              const span = s.t - cur503Start;
              if (span > max503SpanMs) max503SpanMs = span;
              saw503 = true;
            } else {
              cur503Run = 0;
              if (saw503) {
                assert(
                  !s.body.includes("BROKEN-"),
                  "page never serves broken content after first 503",
                  s.body,
                );
              }
            }
          }
          logLine(
            `INFO restore-full gate-window: polls=${String(httpSamples.length)} max503Run=${String(max503Run)} max503SpanMs=${String(Math.round(max503SpanMs))}`,
          );

          const restoredState = await captureSiteAndDbState();
          assert(
            restoredState.fileHashesText === origState.fileHashesText,
            "all restored file hashes match original and extra file gone",
            "file hash mismatch",
          );
          assert(
            restoredState.checksumsText === origState.checksumsText,
            "all restored table checksums match original",
            `${origState.checksumsText}\nVS\n${restoredState.checksumsText}`,
          );
          assert(
            restoredState.showCreatesText === origState.showCreatesText,
            "all restored SHOW CREATE (view, trigger, FK tables) match original",
            `${origState.showCreatesText}\nVS\n${restoredState.showCreatesText}`,
          );

          // Foreign key still refuses orphan child row.
          const fkTest = await runSql(
            `INSERT INTO \`${db2Name}\`.hp_child (id, parent_id, val) VALUES (999, 999999, 'orphan');`,
          );
          assert(
            fkTest.exitCode !== 0 && /1452|foreign key constraint/i.test(fkTest.stderr.toString("utf8")),
            "foreign key refuses orphan row after restore",
            `exit=${String(fkTest.exitCode)} err=${fkTest.stderr.toString("utf8")}`,
          );

          await assertNoRestoreLeftovers();

          // Negative control for leftover detector: synthetic .hp_rs_ folder must be caught and removed.
          const mkSynRes = await runSiteHelper("mkleft", [
            "-c",
            `mkdir -p /var/www/html/.hp_rs_canary_${runHex}`,
          ]);
          assert(mkSynRes.ok, "create synthetic .hp_rs_ canary", mkSynRes.stderr);
          try {
            const foundSyn = await findSiteLeftovers();
            assert(
              foundSyn.includes(`./.hp_rs_canary_${runHex}`),
              "leftover detector catches synthetic .hp_rs_ directory",
              JSON.stringify(foundSyn),
            );
          } finally {
            await runSiteHelper("rmleft", ["-c", `rm -rf /var/www/html/.hp_rs_canary_${runHex}`]);
          }

          restoreFullSpecs = capturedContainerSpecs.slice(specStartIdx);
        },
        { abortOnFail: true },
      );
    }

    // 6b. R77: verify step container names, prepare mounts no site volume, no docker.sock, dumps only in staging
    if (!fatalSetupFailure) {
      await runStep("restore-mounts-as-ruled", async () => {
        const createSpecs = restoreFullSpecs.filter(
          (s) => s.phase === "create" && s.containerName?.startsWith(`hp_bk_${restoreFullJobId}`),
        );
        const expectedSuffixes = ["rs_fetch", "rs_fetch_files", "rs_prepare", "rs_gate_on", "rs_switch", "rs_files", "rs_finish"];
        assert(
          createSpecs.length === expectedSuffixes.length,
          "all 7 restore step containers captured",
          JSON.stringify(createSpecs.map((s) => s.containerName)),
        );
        for (const suffix of expectedSuffixes) {
          const spec = createSpecs.find((s) => s.containerName === `hp_bk_${restoreFullJobId}_${suffix}`);
          assert(Boolean(spec), `captured ${suffix} container`, JSON.stringify(createSpecs.map((s) => s.containerName)));
          assert(
            /^hp_bk_op_[0-9a-f]{32}_rs_(?:fetch|fetch_files|prepare|gate_on|switch|files|finish)$/.test(spec.containerName),
            `container ${spec.containerName} matches hp_bk_<jobId>_rs_*`,
            spec.containerName,
          );
          const binds = spec.createPayload?.HostConfig?.Binds ?? [];
          const inspectBinds = spec.inspect?.HostConfig?.Binds ?? [];
          for (const b of [...binds, ...inspectBinds]) {
            assert(!b.includes("docker.sock"), `no docker.sock bind on ${suffix}`, b);
          }
          if (suffix === "rs_prepare") {
            assert(
              !binds.some((b) => b.includes(siteVolumeName) || b.includes("/var/www/html")),
              "_rs_prepare mounts no site volume",
              JSON.stringify(binds),
            );
            assert(
              binds.some((b) => b === `hp_bk_${restoreFullJobId}:/var/tmp`),
              "_rs_prepare mounts job staging volume at /var/tmp",
              JSON.stringify(binds),
            );
          }
          // C2 (R207 restore.1): no container of a restore mounts the site volume and the staging volume together.
          assert(
            !(binds.some((b) => b.includes(siteVolumeName)) && binds.some((b) => b.startsWith(`hp_bk_${restoreFullJobId}:`))),
            `${suffix} never mounts the site volume and the staging volume together`,
            JSON.stringify(binds),
          );
          if (suffix === "rs_fetch") {
            const cmdText = [...(spec.createPayload?.Entrypoint ?? []), ...(spec.createPayload?.Cmd ?? [])].join("\n");
            assert(
              binds.some((b) => b === `hp_bk_${restoreFullJobId}:/var/tmp`) &&
                cmdText.includes("S=/var/tmp/c") &&
                cmdText.includes('"$HP_SNAP:/backup/databases" --target "$S/databases"'),
              "_rs_fetch restores DB dumps strictly to /var/tmp/c/databases in staging",
              "missing expected staging target",
            );
          }
          if (binds.some((b) => b.includes(siteVolumeName))) {
            const cmdText = [
              ...(spec.createPayload?.Entrypoint ?? []),
              ...(spec.createPayload?.Cmd ?? []),
              ...(spec.createPayload?.Env ?? []),
            ].join("\n");
            assert(
              !cmdText.includes("/.hp_rs_$HP_H/databases") &&
                !cmdText.includes('--target "$R/databases') &&
                !cmdText.includes('--target $R/databases'),
              `${suffix} does not place DB dumps inside site volume`,
              suffix,
            );
            if (suffix === "rs_fetch_files") {
              assert(
                cmdText.includes("R=/var/www/html/.hp_rs_$HP_H") &&
                  cmdText.includes('"$HP_SNAP:/backup/files" --target "$R/c/files"'),
                "_rs_fetch_files restores files under .hp_rs_ in the site volume",
                "missing expected files target",
              );
            }
          }
        }
      });
    }

    // 6b-2. C2 (R207 restore.1): links the site plants where database copies were written never carry its text into MariaDB
    if (!fatalSetupFailure) {
      await runStep("restore-planted-link-never-replayed", async () => {
        const plantDir = `/var/www/html/hp_plant_${runHex}`;
        const plantedText = `PLANTED-${runHex}`;
        const forged = `CREATE TABLE hp_planted_${runHex} (id INT); UPDATE hp_marker SET note='${plantedText}' WHERE id=1;\n`;
        const racerName = `${runId}_racer`;
        try {
          // The site's files hold a forged dump and links to where the dumps were staged.
          const plant = await runSiteHelper("plant", [
            "-c",
            [
              "set -eu",
              `mkdir -p ${plantDir}`,
              `printf '%s' '${Buffer.from(forged, "utf8").toString("base64")}' | base64 -d > ${plantDir}/${db1Name}.sql`,
              `ln -s /var/tmp/c/databases ${plantDir}/databases`,
              `ln -s /var/tmp/c ${plantDir}/c`,
              `sha256sum ${plantDir}/${db1Name}.sql`,
            ].join("; "),
          ]);
          assert(plant.ok, "plant a forged dump and links in the site files", plant.stderr);
          const forgedSha = plant.stdout.trim().split(/\s+/)[0];

          const noteRes = await runSql(`SELECT note FROM \`${db1Name}\`.hp_marker WHERE id=1;`);
          assert(noteRes.exitCode === 0, "read marker before backup", noteRes.stderr.toString("utf8"));
          const backedUpNote = noteRes.stdout.toString("utf8").trim();

          const bkJob = newJobId();
          runJobIds.push(bkJob);
          await adapter.backups({ action: "start", jobId: bkJob, siteId, serviceInstanceId, target: goodTarget });
          const bk = await pollBackupJob(adapter, bkJob);
          assert(bk.state === "succeeded" && bk.snapshot !== null, "backup of the planted site succeeds", JSON.stringify(bk));

          const brk = await runSql(`UPDATE \`${db1Name}\`.hp_marker SET note='BROKEN-LINK-${runHex}' WHERE id=1;`);
          assert(brk.exitCode === 0, "break marker before restore", brk.stderr.toString("utf8"));

          // The site's code plants links inside the restore dir while the restore runs.
          const restoreJob = newJobId();
          runJobIds.push(restoreJob);
          const restoreDir = `/var/www/html/.hp_rs_${restoreJob.slice(3)}`;
          createdContainers.add(racerName);
          const racer = await docker([
            "run", "-d", "--name", racerName, "--network", "none", "--user", "33:33", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "sh",
            "-v", `${siteVolumeName}:/var/www/html`, WORDPRESS_IMAGE, "-c",
            [
              `R=${restoreDir}; n=0`,
              "while [ $n -lt 3000 ]; do",
              '  if [ -d "$R/c" ] && [ ! -L "$R/c/databases" ]; then ln -s /var/tmp/c/databases "$R/c/databases" 2>/dev/null && echo planted; fi',
              '  if [ -d "$R" ] && [ ! -L "$R/databases" ]; then ln -s /var/tmp/c/databases "$R/databases" 2>/dev/null && echo planted; fi',
              "  n=$((n+1)); sleep 0.05",
              "done",
            ].join("\n"),
          ]);
          assert(racer.ok, "start the site's racer", racer.stderr);

          const specStart = capturedContainerSpecs.length;
          await adapter.backups({
            action: "restore",
            jobId: restoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: bk.snapshot.snapshotId,
          });
          const res = await pollBackupJob(adapter, restoreJob);
          const racerLogs = await docker(["logs", racerName]);
          assert(res.state === "succeeded" && res.failure === null, "restore of the planted site succeeds", JSON.stringify(res));
          assert(racerLogs.stdout.includes("planted"), "the site planted a link inside the restore dir during the restore", racerLogs.stdout);

          const after = await runSql(`SELECT note FROM \`${db1Name}\`.hp_marker WHERE id=1;`);
          assert(after.exitCode === 0, "read marker after restore", after.stderr.toString("utf8"));
          assert(
            after.stdout.toString("utf8").trim() === backedUpNote,
            "MariaDB holds the backed-up marker, not the planted text",
            after.stdout.toString("utf8").trim(),
          );
          const planted = await runSql(
            `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_NAME='hp_planted_${runHex}';`,
          );
          assert(
            planted.exitCode === 0 && planted.stdout.toString("utf8").trim() === "0",
            "no table of the planted text exists anywhere",
            planted.stdout.toString("utf8"),
          );

          // Nothing outside the site volume was reachable: every container with the site volume had no staging and a read-only root.
          const specs = capturedContainerSpecs
            .slice(specStart)
            .filter((sp) => sp.phase === "create" && sp.containerName?.startsWith(`hp_bk_${restoreJob}_`));
          assert(specs.length > 0, "captured the restore's containers", "0");
          for (const sp of specs) {
            const binds = sp.createPayload?.HostConfig?.Binds ?? [];
            if (!binds.some((b) => b.includes(siteVolumeName))) continue;
            assert(
              !binds.some((b) => b.startsWith(`hp_bk_${restoreJob}:`)) && sp.createPayload?.HostConfig?.ReadonlyRootfs === true,
              `${sp.containerName} with the site volume has no staging and a read-only root`,
              JSON.stringify(binds),
            );
          }
          const kept = await runSiteHelper(
            "plantchk",
            [
              "-c",
              `readlink ${plantDir}/databases; readlink ${plantDir}/c; sha256sum ${plantDir}/${db1Name}.sql`,
            ],
            { ro: true },
          );
          assert(
            kept.ok &&
              kept.stdout.split(/\r?\n/)[0] === "/var/tmp/c/databases" &&
              kept.stdout.split(/\r?\n/)[1] === "/var/tmp/c" &&
              kept.stdout.includes(forgedSha),
            "the restored links and forged file are the site's own content, unchanged",
            kept.stdout + kept.stderr,
          );
        } finally {
          await docker(["rm", "-f", racerName]);
          createdContainers.delete(racerName);
          await runSiteHelper("unplant", ["-c", `rm -rf ${plantDir}`]).catch(() => undefined);
        }
        await assertNoRestoreLeftovers();
      });
    }

    // 6c. Restore fails before switch (definer_missing): site untouched, broken state intact, never 503
    let snapDefiner = null;
    if (!fatalSetupFailure) {
      await runStep("restore-fails-before-switch", async () => {
        const defUser = `hp_def_${runHex}`;
        const mkDefRes = await runSql(
          [
            `CREATE USER '${defUser}'@'%' IDENTIFIED BY 'temp-def-pass';`,
            `GRANT SELECT ON \`${db2Name}\`.* TO '${defUser}'@'%';`,
            `CREATE DEFINER='${defUser}'@'%' SQL SECURITY DEFINER VIEW \`${db2Name}\`.v_temp_def AS SELECT id, note FROM \`${db2Name}\`.hp_marker;`,
          ].join(" "),
        );
        assert(mkDefRes.exitCode === 0, "create temporary definer user and view", mkDefRes.stderr.toString("utf8"));

        const defBkJob = newJobId();
        runJobIds.push(defBkJob);
        await adapter.backups({
          action: "start",
          jobId: defBkJob,
          siteId,
          serviceInstanceId,
          target: goodTarget,
        });
        const defBkSettled = await pollBackupJob(adapter, defBkJob);
        assert(
          defBkSettled.state === "succeeded" && defBkSettled.snapshot !== null,
          "backup with temp-definer view succeeds",
          JSON.stringify(defBkSettled),
        );
        snapDefiner = defBkSettled.snapshot;

        // Drop the definer user and the temp view from the live DB, then break the site.
        const dropDefRes = await runSql(
          `DROP VIEW IF EXISTS \`${db2Name}\`.v_temp_def; DROP USER IF EXISTS '${defUser}'@'%';`,
        );
        assert(dropDefRes.exitCode === 0, "drop temp definer user and view", dropDefRes.stderr.toString("utf8"));

        const brkFiles = await runSiteHelper("brkdef", [
          "-c",
          `printf 'BROKEN-DEF-${runHex}\\n' > /var/www/html/${markerFileName}`,
        ]);
        assert(brkFiles.ok, "break marker file before definer_missing test", brkFiles.stderr);
        const brkDbs = await runSql(
          [
            `UPDATE \`${db1Name}\`.hp_marker SET note='BROKEN-DEF-DB1-${runHex}' WHERE id=1;`,
            `UPDATE \`${db2Name}\`.hp_marker SET note='BROKEN-DEF-DB2-${runHex}' WHERE id=1;`,
          ].join(" "),
        );
        assert(brkDbs.exitCode === 0, "break marker rows before definer_missing test", brkDbs.stderr.toString("utf8"));

        brokenRefState = await captureSiteAndDbState();

        const defRestoreJob = newJobId();
        runJobIds.push(defRestoreJob);
        const polls = [];
        let polling = true;
        const pollLoop = (async () => {
          while (polling) {
            try {
              const r = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(1_500) });
              polls.push({ status: r.status, body: await r.text() });
            } catch (err) {
              polls.push({ status: 0, body: formatErr(err) });
            }
            await sleep(100);
          }
        })();

        let res;
        try {
          await adapter.backups({
            action: "restore",
            jobId: defRestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapDefiner.snapshotId,
          });
          res = await pollBackupJob(adapter, defRestoreJob);
        } finally {
          polling = false;
          await pollLoop;
        }

        assert(
          res.state === "failed" && res.failure === "definer_missing",
          "restore fails with definer_missing",
          JSON.stringify(res),
        );
        assert(polls.length > 0, "polled site during definer_missing restore", "0 polls");
        for (const p of polls) {
          assert(
            p.status === 200 && p.body.includes(`BROKEN-DEF-${runHex}`),
            "site stays 200 with broken content and never 503",
            JSON.stringify(p),
          );
        }

        const afterBroken = await captureSiteAndDbState();
        assert(
          afterBroken.fileHashesText === brokenRefState.fileHashesText &&
            afterBroken.checksumsText === brokenRefState.checksumsText &&
            afterBroken.showCreatesText === brokenRefState.showCreatesText,
          "broken state completely unchanged after definer_missing",
          "state changed",
        );
        await assertNoRestoreLeftovers();
      });

      // 6c-2. Failure before switch keeps any pre-existing WordPress .maintenance byte-identical (R89)
      await runStep("restore-pre-switch-keeps-wp-maintenance", async () => {
        assert(snapDefiner !== null, "snapDefiner captured", "null");
        const oldTs = Math.floor(Date.now() / 1000) - 1200;
        const wpMaintContent = `<?php $upgrading = ${String(oldTs)}; // pre-switch-wp-maint-${runHex}\n`;
        const b64 = Buffer.from(wpMaintContent, "utf8").toString("base64");
        try {
          const putMaint = await runSiteHelper("putm89", [
            "-c",
            `printf '%s' '${b64}' | base64 -d > /var/www/html/.maintenance && sha256sum /var/www/html/.maintenance`,
          ]);
          assert(putMaint.ok, "write pre-existing .maintenance before pre-switch failure", putMaint.stderr);
          const beforeSha = putMaint.stdout.trim().split(/\s+/)[0];

          const preFailJob = newJobId();
          runJobIds.push(preFailJob);
          await adapter.backups({
            action: "restore",
            jobId: preFailJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapDefiner.snapshotId,
          });
          const preFailRes = await pollBackupJob(adapter, preFailJob);
          assert(
            preFailRes.state === "failed" && preFailRes.failure === "definer_missing",
            "pre-switch restore fails with definer_missing",
            JSON.stringify(preFailRes),
          );

          const checkMaint = await runSiteHelper(
            "chkm89",
            ["-c", "test -f /var/www/html/.maintenance && test ! -L /var/www/html/.maintenance && sha256sum /var/www/html/.maintenance && cat /var/www/html/.maintenance"],
            { ro: true },
          );
          assert(checkMaint.ok, "pre-existing .maintenance still exists as regular file", checkMaint.stderr);
          const firstLine = checkMaint.stdout.split(/\r?\n/)[0] ?? "";
          const afterSha = firstLine.trim().split(/\s+/)[0];
          const afterBody = checkMaint.stdout.slice(firstLine.length + 1);
          assert(
            afterSha === beforeSha && afterBody === wpMaintContent,
            "pre-existing .maintenance is byte-identical after failure before switch",
            `beforeSha=${beforeSha} afterSha=${afterSha} body=${JSON.stringify(afterBody)}`,
          );
        } finally {
          await runSiteHelper("clrm89", ["-c", "rm -f /var/www/html/.maintenance"]).catch(() => undefined);
        }
        await assertNoRestoreLeftovers();
      });
    }

    // 6d. Restore fails inside switch (lock wait timeout -> switch_undone)
    if (!fatalSetupFailure) {
      await runStep("restore-fails-inside-switch", async () => {
        const lock = await startMariaDbLock();
        let res;
        let elapsedMs;
        try {
          const lockRestoreJob = newJobId();
          runJobIds.push(lockRestoreJob);
          const t0 = performance.now();
          await adapter.backups({
            action: "restore",
            jobId: lockRestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapRestore.snapshotId,
          });
          res = await pollBackupJob(adapter, lockRestoreJob);
          elapsedMs = performance.now() - t0;
        } finally {
          await lock.release();
        }

        assert(
          res.state === "failed" && res.failure === "switch_undone",
          "locked restore fails with switch_undone",
          JSON.stringify(res),
        );
        assert(
          elapsedMs >= 4_000,
          "switch waited near lock_wait_timeout (5s) before failing",
          `${String(Math.round(elapsedMs))}ms`,
        );

        const afterPage = await fetch(`http://${siteIp}:8080/`, {
          signal: AbortSignal.timeout(2_000),
        });
        const afterBody = await afterPage.text();
        assert(
          afterPage.status === 200 && afterBody.includes(`BROKEN-DEF-${runHex}`),
          "site open again (200, no .maintenance) with broken state",
          `status=${String(afterPage.status)} body=${afterBody}`,
        );

        const afterState = await captureSiteAndDbState();
        assert(
          afterState.fileHashesText === brokenRefState.fileHashesText &&
            afterState.checksumsText === brokenRefState.checksumsText &&
            afterState.showCreatesText === brokenRefState.showCreatesText,
          "broken state identical after switch_undone",
          "state mismatch",
        );
        await assertNoRestoreLeftovers();
      });
    }

    // 6e. Interrupted restore in real SIGKILLed child executor settled at start (switch + prepare), then new restore succeeds
    const prepareSettlePolls = [];
    if (!fatalSetupFailure) {
      await runStep(
        "restore-interrupted-settled-at-start",
        async () => {
          // Case (a): kill child while _rs_switch container exists (held by DB lock) -> settled as switch_undone
          const jobSwitchKill = newJobId();
          runJobIds.push(jobSwitchKill);
          const lock = await startMariaDbLock();
          let workerA;
          try {
            workerA = await spawnChildRestoreWorker(jobSwitchKill, snapRestore.snapshotId);
            const switchName = `hp_bk_${jobSwitchKill}_rs_switch`;
            const deadline = Date.now() + 30_000;
            let caughtSwitch = false;
            while (Date.now() < deadline) {
              const list = await dockerJson(
                "GET",
                `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: [switchName] }))}`,
              );
              if (Array.isArray(list) && list.some((c) => (c.Names ?? []).includes(`/${switchName}`))) {
                const insp = await dockerInspectContainer(switchName);
                if (insp) {
                  capturedContainerSpecs.push({
                    phase: "child-inspect",
                    containerName: switchName,
                    containerId: insp.Id,
                    createPayload: null,
                    inspect: insp,
                  });
                }
                caughtSwitch = true;
                break;
              }
              await sleep(25);
            }
            assert(caughtSwitch, `caught ${switchName} running in child process`, "not caught");
            workerA.child.kill("SIGKILL");
            const exitA = await workerA.exitPromise;
            assert(exitA.signal === "SIGKILL", "child executor A killed by SIGKILL", JSON.stringify(exitA));
          } finally {
            await lock.release();
          }

          // Prove the note is at stage "switch" and staging volume exists before startup (proving step can fail).
          const noteA = await readRestoreNote(path.join(backupWorkDir, "restores"), jobSwitchKill);
          assert(noteA?.stage === "switch", "note persisted at stage switch", JSON.stringify(noteA));
          const volsBeforeA = await dockerListNames("volume", `hp_bk_${jobSwitchKill}`);
          assert(
            volsBeforeA.includes(`hp_bk_${jobSwitchKill}`),
            "staging volume exists before startup settle",
            JSON.stringify(volsBeforeA),
          );

          adapter2 = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));
          await adapter2.cleanupOrphanJobs();
          await adapter2.settleRestores();
          await adapter2.emptyArchives();

          const settleA1 = await adapter2.backups({ action: "settle", jobId: jobSwitchKill });
          const statusA = await adapter2.backups({ action: "status", jobId: jobSwitchKill });
          assert(
            settleA1.state === "failed" && settleA1.failure === "switch_undone",
            "settle answers failed/switch_undone after switch crash",
            JSON.stringify(settleA1),
          );
          assert(
            statusA.state === "failed" && statusA.failure === "switch_undone",
            "status answers failed/switch_undone after switch crash",
            JSON.stringify(statusA),
          );
          const createsBeforeRepeat = containerCreateCount;
          const settleA2 = await adapter2.backups({ action: "settle", jobId: jobSwitchKill });
          assert(
            settleA2.state === "failed" &&
              settleA2.failure === "switch_undone" &&
              containerCreateCount === createsBeforeRepeat,
            "second settle is idempotent and creates zero containers",
            JSON.stringify({ settleA2, createsBeforeRepeat, containerCreateCount }),
          );

          const pageAfterA = await fetch(`http://${siteIp}:8080/`, {
            signal: AbortSignal.timeout(2_000),
          });
          assert(
            pageAfterA.status === 200 && (await pageAfterA.text()).includes(`BROKEN-DEF-${runHex}`),
            "site open (200) and unchanged after switch crash settle",
            String(pageAfterA.status),
          );
          const stateAfterA = await captureSiteAndDbState();
          assert(
            stateAfterA.fileHashesText === brokenRefState.fileHashesText &&
              stateAfterA.checksumsText === brokenRefState.checksumsText,
            "site identical to pre-restore state after switch crash settle",
            "state mismatch",
          );
          await assertNoRestoreLeftovers();

          // Case (b): kill child while _rs_fetch container exists -> settled as interrupted, site never closed
          const jobFetchKill = newJobId();
          runJobIds.push(jobFetchKill);
          const workerB = await spawnChildRestoreWorker(jobFetchKill, snapRestore.snapshotId);
          const fetchName = `hp_bk_${jobFetchKill}_rs_fetch`;
          const prepName = `hp_bk_${jobFetchKill}_rs_prepare`;
          const fetchDeadline = Date.now() + 30_000;
          let caughtFetch = false;
          while (Date.now() < fetchDeadline) {
            const list = await dockerJson(
              "GET",
              `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: [`hp_bk_${jobFetchKill}_rs_`] }))}`,
            );
            const names = Array.isArray(list) ? list.flatMap((c) => c.Names ?? []) : [];
            if (names.includes(`/${prepName}`)) {
              break;
            }
            if (names.includes(`/${fetchName}`)) {
              const insp = await dockerInspectContainer(fetchName);
              if (insp) {
                capturedContainerSpecs.push({
                  phase: "child-inspect",
                  containerName: fetchName,
                  containerId: insp.Id,
                  createPayload: null,
                  inspect: insp,
                });
              }
              caughtFetch = true;
              break;
            }
            await sleep(15);
          }
          assert(caughtFetch, `caught ${fetchName} before _rs_prepare`, "missed _rs_fetch");
          workerB.child.kill("SIGKILL");
          const exitB = await workerB.exitPromise;
          assert(exitB.signal === "SIGKILL", "child executor B killed by SIGKILL", JSON.stringify(exitB));

          const noteB = await readRestoreNote(path.join(backupWorkDir, "restores"), jobFetchKill);
          assert(noteB?.stage === "prepare", "note persisted at stage prepare", JSON.stringify(noteB));
          const pageMidB = await fetch(`http://${siteIp}:8080/`, {
            signal: AbortSignal.timeout(2_000),
          });
          assert(pageMidB.status === 200, "site stayed open (200) during fetch crash", String(pageMidB.status));

          const adapter3 = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));
          let pollingSettleB = true;
          const settlePollLoop = (async () => {
            while (pollingSettleB) {
              try {
                const r = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(1_500) });
                prepareSettlePolls.push(r.status);
              } catch {
                prepareSettlePolls.push(0);
              }
              await sleep(25);
            }
          })();
          try {
            await adapter3.cleanupOrphanJobs();
            await adapter3.settleRestores();
          } finally {
            pollingSettleB = false;
            await settlePollLoop;
          }
          await adapter3.emptyArchives();

          const settleB = await adapter3.backups({ action: "settle", jobId: jobFetchKill });
          const statusB = await adapter3.backups({ action: "status", jobId: jobFetchKill });
          assert(
            settleB.state === "failed" && settleB.failure === "interrupted",
            "settle answers failed/interrupted after fetch crash",
            JSON.stringify(settleB),
          );
          assert(
            statusB.state === "failed" && statusB.failure === "interrupted",
            "status answers failed/interrupted after fetch crash",
            JSON.stringify(statusB),
          );
          await assertNoRestoreLeftovers();

          // A fresh restore on the restarted adapter now succeeds and restores the original content.
          const recoverRestoreJob = newJobId();
          runJobIds.push(recoverRestoreJob);
          await adapter3.backups({
            action: "restore",
            jobId: recoverRestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapRestore.snapshotId,
          });
          const recoverSettled = await pollBackupJob(adapter3, recoverRestoreJob);
          assert(
            recoverSettled.state === "succeeded" && recoverSettled.failure === null,
            "fresh restore after crash settles succeeds",
            JSON.stringify(recoverSettled),
          );
          const recoverPage = await fetch(`http://${siteIp}:8080/`, {
            signal: AbortSignal.timeout(2_000),
          });
          const recoverBody = await recoverPage.text();
          assert(
            recoverPage.status === 200 &&
              recoverBody.includes(`FILE=${fileMarkerText}`) &&
              recoverBody.includes(`DB1=${db1MarkerText}`) &&
              recoverBody.includes(`DB2=${db2MarkerText}`) &&
              recoverBody.includes(`MAIL=${hpMailSha}`),
            "site back to original content after post-crash restore",
            `status=${String(recoverPage.status)} body=${recoverBody}`,
          );
          await assertNoRestoreLeftovers();
          adapter2 = adapter3;
        },
        { abortOnFail: true },
      );

      // 6e-2. R89: Settling a prepare-stage note at restart never closes the site (never 503)
      await runStep("restore-prepare-settle-never-503", async () => {
        assert(prepareSettlePolls.length > 0, "polled site during settle of prepare note", "0 polls");
        for (const st of prepareSettlePolls) {
          assert(st === 200, "settle of prepare-stage note never closes site (never 503)", String(st));
        }
      });
    }

    // 6f. Download archive: prepare zip, check permissions & TTL, read chunks, inspect with PHP ZipArchive, replace, discard
    if (!fatalSetupFailure) {
      await runStep("download-archive", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const archJob1 = newJobId();
        runJobIds.push(archJob1);
        const t0 = performance.now();
        await activeAdapter.backups({
          action: "archive",
          jobId: archJob1,
          siteId,
          target: goodTarget,
          snapshotId: snapRestore.snapshotId,
        });
        const archDone1 = await pollBackupJob(activeAdapter, archJob1);
        const archElapsedMs = Math.round(performance.now() - t0);
        assert(
          archDone1.state === "succeeded" && archDone1.failure === null && archDone1.archive !== null,
          "archive job succeeds with archive metadata",
          JSON.stringify(archDone1),
        );
        const { sizeBytes, readyAt, expiresAt } = archDone1.archive;
        assert(sizeBytes > 0, "archive sizeBytes > 0", String(sizeBytes));
        assert(
          Date.parse(expiresAt) - Date.parse(readyAt) === BACKUP_ARCHIVE_TTL_MS,
          "expiresAt is exactly 60 minutes after readyAt",
          `${readyAt} -> ${expiresAt}`,
        );
        logLine(`INFO download-archive: sizeBytes=${String(sizeBytes)} elapsedMs=${String(archElapsedMs)}`);

        const archivesDir = path.join(backupWorkDir, "archives");
        const archivesDirStat = await stat(archivesDir);
        assert(
          (archivesDirStat.mode & 0o777) === 0o700 && archivesDirStat.uid === process.getuid(),
          "archives dir is mode 0700 owned by executor user",
          `mode=${(archivesDirStat.mode & 0o777).toString(8)} uid=${String(archivesDirStat.uid)}`,
        );

        const archiveEntries1 = await readdir(archivesDir);
        assert(
          archiveEntries1.length === 1 && archiveEntries1[0] === `${archJob1}.zip`,
          "only <jobId>.zip exists in archives dir (no .part left)",
          JSON.stringify(archiveEntries1),
        );
        const zipHostPath = path.join(archivesDir, `${archJob1}.zip`);
        const zipStat = await stat(zipHostPath);
        assert(
          zipStat.uid === process.getuid() && (zipStat.mode & 0o777) === 0o644 && zipStat.size === sizeBytes,
          "zip owned by executor user, mode 0644 (per design), exact size",
          `uid=${String(zipStat.uid)} mode=${(zipStat.mode & 0o777).toString(8)} size=${String(zipStat.size)}`,
        );

        // Read all chunks of 524288 bytes from offset 0 until eof.
        const chunks = [];
        let offset = 0;
        for (;;) {
          const chunk = await activeAdapter.backups({
            action: "readArchive",
            jobId: archJob1,
            offset,
            length: SITE_FILE_CHUNK_BYTES,
          });
          assert(chunk.size === sizeBytes, "chunk reports exact size", JSON.stringify(chunk.size));
          const raw = Buffer.from(chunk.dataBase64, "base64");
          chunks.push(raw);
          offset += raw.length;
          if (chunk.eof) {
            break;
          }
          assert(raw.length > 0, "non-eof chunk has bytes", String(raw.length));
        }
        const joined = Buffer.concat(chunks);
        assert(
          joined.length === sizeBytes,
          "joined chunks equal announced sizeBytes",
          `${String(joined.length)} vs ${String(sizeBytes)}`,
        );

        // Open zip in throw-away WordPress container via PHP ZipArchive (mounted read-only).
        const unzipName = `${runId}_unzip`;
        createdContainers.add(unzipName);
        let unzipRes;
        try {
          unzipRes = await docker([
            "run",
            "--name",
            unzipName,
            "--network",
            "none",
            "--user",
            uidGid,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "php",
            "-v",
            `${zipHostPath}:/tmp/archive.zip:ro`,
            WORDPRESS_IMAGE,
            "-r",
            [
              "$z = new ZipArchive();",
              "if ($z->open('/tmp/archive.zip', ZipArchive::RDONLY) !== true) { exit(2); }",
              `$m = $z->getFromName('files/${markerFileName}');`,
              `$d1 = $z->getFromName('databases/${db1Name}.sql');`,
              `$d2 = $z->getFromName('databases/${db2Name}.sql');`,
              "$missing = $z->getFromName('files/nonexistent-canary.txt');",
              "$hasRs = false; for ($i=0; $i<$z->numFiles; $i++) { if (str_contains($z->getNameIndex($i), '.hp_rs_')) $hasRs = true; }",
              "if ($m === false || $d1 === false || $d2 === false || $missing !== false || $hasRs) { exit(3); }",
              "echo json_encode(['marker' => trim($m), 'db1Len' => strlen($d1), 'db2Len' => strlen($d2), 'numFiles' => $z->numFiles]);",
            ].join(" "),
          ]);
        } finally {
          await docker(["rm", "-f", unzipName]);
          createdContainers.delete(unzipName);
        }
        assert(unzipRes.ok, "PHP ZipArchive opens and validates archive", `${unzipRes.stderr} ${unzipRes.stdout}`);
        const zipMeta = JSON.parse(unzipRes.stdout);
        assert(
          zipMeta.marker === fileMarkerText && zipMeta.db1Len > 0 && zipMeta.db2Len > 0,
          "archive contains files/ marker and both databases/<db>.sql",
          JSON.stringify(zipMeta),
        );

        // Verify no *.zip in the site's files volume anywhere.
        const siteZipRes = await runSiteHelper(
          "sitezip",
          ["-c", "find /var/www/html -name '*.zip'"],
          { ro: true },
        );
        assert(
          siteZipRes.ok && siteZipRes.stdout.trim() === "",
          "no *.zip anywhere in site volume",
          siteZipRes.stdout,
        );

        // Start a second archive for the same site and verify readArchive while preparing + replaced archive.
        const archJob2 = newJobId();
        runJobIds.push(archJob2);
        await activeAdapter.backups({
          action: "archive",
          jobId: archJob2,
          siteId,
          target: goodTarget,
          snapshotId: snapRestore.snapshotId,
        });

        let prepErr = null;
        try {
          await activeAdapter.backups({
            action: "readArchive",
            jobId: archJob2,
            offset: 0,
            length: 64,
          });
        } catch (err) {
          prepErr = err;
        }
        assert(
          prepErr instanceof ExecutorCodedError &&
            prepErr.code === "RESOURCE_LOCKED" &&
            prepErr.message === "archive_preparing",
          "readArchive while second archive prepares throws RESOURCE_LOCKED archive_preparing",
          prepErr ? formatErr(prepErr) : "resolved unexpectedly",
        );

        let oldErr = null;
        try {
          await activeAdapter.backups({
            action: "readArchive",
            jobId: archJob1,
            offset: 0,
            length: 64,
          });
        } catch (err) {
          oldErr = err;
        }
        assert(
          oldErr instanceof ExecutorCodedError &&
            oldErr.code === "NOT_FOUND" &&
            oldErr.message === "archive_gone",
          "readArchive on replaced first archive throws NOT_FOUND archive_gone",
          oldErr ? formatErr(oldErr) : "resolved unexpectedly",
        );

        const archDone2 = await pollBackupJob(activeAdapter, archJob2);
        assert(
          archDone2.state === "succeeded" && archDone2.archive !== null,
          "second archive job succeeds",
          JSON.stringify(archDone2),
        );
        const entriesAfter2 = await readdir(archivesDir);
        assert(
          entriesAfter2.length === 1 && entriesAfter2[0] === `${archJob2}.zip`,
          "only second archive zip present, no .part file",
          JSON.stringify(entriesAfter2),
        );

        // discardArchive removes zip, empties folder, and subsequent read throws NOT_FOUND archive_gone.
        const disc = await activeAdapter.backups({ action: "discardArchive", jobId: archJob2 });
        assert(disc.discarded === true, "discardArchive returns { discarded: true }", JSON.stringify(disc));

        const entriesAfterDiscard = await readdir(archivesDir);
        assert(entriesAfterDiscard.length === 0, "archives dir empty after discardArchive", JSON.stringify(entriesAfterDiscard));

        let goneErr = null;
        try {
          await activeAdapter.backups({
            action: "readArchive",
            jobId: archJob2,
            offset: 0,
            length: 64,
          });
        } catch (err) {
          goneErr = err;
        }
        assert(
          goneErr instanceof ExecutorCodedError &&
            goneErr.code === "NOT_FOUND" &&
            goneErr.message === "archive_gone",
          "readArchive after discardArchive throws NOT_FOUND archive_gone",
          goneErr ? formatErr(goneErr) : "resolved unexpectedly",
        );
      });
    }

    // 6g. Real WordPress image meets .maintenance gate with exact product content (R79)
    if (!fatalSetupFailure) {
      await runStep("gate-is-wordpress-own", async () => {
        const wpOwnDb = `hp_swarmtest_wpown_${runHex}`;
        const wpOwnUser = `wp_own_${runHex}`;
        const prepOwnDb = await runSql(
          [
            `CREATE DATABASE \`${wpOwnDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
            `CREATE USER '${wpOwnUser}'@'%' IDENTIFIED BY '${wpOwnDbPass}';`,
            `GRANT ALL PRIVILEGES ON \`${wpOwnDb}\`.* TO '${wpOwnUser}'@'%';`,
            "FLUSH PRIVILEGES;",
          ].join(" "),
        );
        assert(prepOwnDb.exitCode === 0, "create temp DB for real WordPress gate test", prepOwnDb.stderr.toString("utf8"));

        const volRes = await docker(["volume", "create", wpOwnVolumeName]);
        assert(volRes.ok, "create empty volume for real WordPress container", volRes.stderr);
        createdVolumes.add(wpOwnVolumeName);

        try {
          const wpRun = await docker([
            "run",
            "-d",
            "--name",
            wpOwnContainerName,
            "--network",
            networkName,
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--cap-add",
            "SETUID",
            "--cap-add",
            "SETGID",
            "--cap-add",
            "NET_BIND_SERVICE",
            "--cap-add",
            "DAC_OVERRIDE",
            "--cap-add",
            "FOWNER",
            "--security-opt",
            "no-new-privileges:true",
            "-v",
            `${wpOwnVolumeName}:/var/www/html`,
            "-v",
            `${wpOwnSecretFile}:/run/secrets/wp_db_pw:ro`,
            "-e",
            `WORDPRESS_DB_HOST=${SHARED_DB_ALIAS}`,
            "-e",
            `WORDPRESS_DB_NAME=${wpOwnDb}`,
            "-e",
            `WORDPRESS_DB_USER=${wpOwnUser}`,
            "-e",
            "WORDPRESS_DB_PASSWORD_FILE=/run/secrets/wp_db_pw",
            WORDPRESS_IMAGE,
          ]);
          assert(wpRun.ok, "real WordPress container starts", wpRun.stderr);
          createdContainers.add(wpOwnContainerName);

          const wpInsp = await dockerInspectContainer(wpOwnContainerName);
          const wpIp = wpInsp?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
          assert(wpIp.length > 0, "real WordPress container IP assigned", wpIp);

          const waitWpDeadline = Date.now() + 45_000;
          let openStatus = 0;
          while (Date.now() < waitWpDeadline) {
            try {
              const r = await fetch(`http://${wpIp}:80/`, {
                redirect: "manual",
                signal: AbortSignal.timeout(2_000),
              });
              if (r.status > 0 && r.status !== 503) {
                openStatus = r.status;
                break;
              }
            } catch {
              // wait for entrypoint copy + Apache start
            }
            await sleep(300);
          }
          assert(openStatus > 0 && openStatus !== 503, "real WordPress answers non-503 without .maintenance", String(openStatus));

          const putGate = await docker(
            [
              "exec",
              "-i",
              "-u",
              "33:33",
              wpOwnContainerName,
              "sh",
              "-c",
              "cat > /var/www/html/.maintenance",
            ],
            { stdin: RESTORE_MAINTENANCE_FILE_CONTENT },
          );
          assert(putGate.ok, "write .maintenance into real WordPress container", putGate.stderr);

          const closedRes = await fetch(`http://${wpIp}:80/`, {
            redirect: "manual",
            signal: AbortSignal.timeout(2_000),
          });
          assert(
            closedRes.status === 503,
            "real WordPress answers 503 with product .maintenance",
            String(closedRes.status),
          );

          const rmGate = await docker([
            "exec",
            "-u",
            "33:33",
            wpOwnContainerName,
            "rm",
            "-f",
            "/var/www/html/.maintenance",
          ]);
          assert(rmGate.ok, "remove .maintenance from real WordPress container", rmGate.stderr);

          const reopenedRes = await fetch(`http://${wpIp}:80/`, {
            redirect: "manual",
            signal: AbortSignal.timeout(2_000),
          });
          assert(
            reopenedRes.status !== 503,
            "real WordPress answers non-503 after .maintenance removed",
            String(reopenedRes.status),
          );
          logLine(
            `INFO gate-is-wordpress-own: openStatus=${String(openStatus)} closedStatus=${String(closedRes.status)} reopenedStatus=${String(reopenedRes.status)}`,
          );
        } finally {
          await docker(["rm", "-f", "-v", wpOwnContainerName]);
          createdContainers.delete(wpOwnContainerName);
          await docker(["volume", "rm", wpOwnVolumeName]);
          createdVolumes.delete(wpOwnVolumeName);
          await runSql(`DROP DATABASE IF EXISTS \`${wpOwnDb}\`; DROP USER IF EXISTS '${wpOwnUser}'@'%';`).catch(
            () => undefined,
          );
        }
      });
    }

    // 6h. R88: Hostile object names in both copy and live DB restore cleanly; canary, DBs, users, grants untouched
    if (!fatalSetupFailure) {
      await runStep("restore-hostile-object-names", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const sqlId = (name) => "`" + name.replace(/`/g, "``") + "`";
        const pwnHex = runHex.slice(0, 8);
        const canaryDb = `hp_swarmtest_canary_${runHex}`;
        const pwnCopyDb = `hp_pwnc_${pwnHex}`;
        const pwnLiveDb = `hp_pwnl_${pwnHex}`;
        // One hidden payload that creates both a database and a user (<= 64 chars).
        const pwnDuDb = `hp_pwnd_${runHex}`;
        const pwnDuUser = `hp_pwnw_${runHex}`;
        const duPayload = `\`;CREATE DATABASE ${pwnDuDb};CREATE USER ${pwnDuUser};#`;
        const cTrigDu = `c${duPayload}`;
        const lTrigDu = `l${duPayload}`;
        // Full special set for every kind: leading dash, backtick, ;, space, quotes, glob, $().
        const spec = (k) => `-${k}\`q;b'c" *$(id)`;
        const [cTrigSpec, cViewSpec, cProcSpec, cEvSpec] = ["ctr", "cv", "csp", "cev"].map(spec);
        const [lTrigSpec, lViewSpec, lProcSpec, lEvSpec] = ["ltr", "lv", "lsp", "lev"].map(spec);

        // Copy-side hostile identifiers (all valid MariaDB <= 64 chars, UTF-8 / quotes / spaces / glob / $() / SQL injection)
        const cTblPwn = `t\`;CREATE/**/DATABASE/**/${pwnCopyDb};#`;
        const cTblSpec = `ht\`q;b'c" *$(id)`;
        const cTblDash = `-hdash`;
        const cTblUtf8 = `t_é_€`;
        const cTblAud = `hp_h_aud`;
        const cViewPwn = `v\`;CREATE/**/DATABASE/**/${pwnCopyDb};#`;
        const cViewDash = `-hvdash`;
        const cTrigPwn = `tr\`;CREATE/**/DATABASE/**/${pwnCopyDb};#`;
        const cProcPwn = `sp\`;CREATE/**/DATABASE/**/${pwnCopyDb};#`;
        const cEvPwn = `ev\`;CREATE/**/DATABASE/**/${pwnCopyDb};#`;

        // Live-side-only hostile identifiers (different names so restore must save, drop, rename, and discard them)
        const lTblPwn = `lt\`;CREATE/**/DATABASE/**/${pwnLiveDb};#`;
        const lTblDash = `-ldash`;
        const lTblSpec = `hl\`q;b'c" *$(id)`;
        const lTblAud = `hp_lh_aud`;
        const lViewPwn = `lv\`;CREATE/**/DATABASE/**/${pwnLiveDb};#`;
        const lTrigPwn = `ltr\`;CREATE/**/DATABASE/**/${pwnLiveDb};#`;
        const lProcPwn = `lsp\`;CREATE/**/DATABASE/**/${pwnLiveDb};#`;
        const lEvPwn = `lev\`;CREATE/**/DATABASE/**/${pwnLiveDb};#`;

        const snapshotDbsUsersGrants = async () => {
          const dbsRes = await runSql("SHOW DATABASES;");
          assert(dbsRes.exitCode === 0, "SHOW DATABASES", dbsRes.stderr.toString("utf8"));
          const dbs = dbsRes.stdout
            .toString("utf8")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
          const usersRes = await runSql(
            "SELECT CONCAT(QUOTE(User), '@', QUOTE(Host)) FROM mysql.user ORDER BY 1;",
          );
          assert(usersRes.exitCode === 0, "list mysql.user", usersRes.stderr.toString("utf8"));
          const users = usersRes.stdout
            .toString("utf8")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          const grants = [];
          for (const u of users) {
            const gRes = await runSql(`SHOW GRANTS FOR ${u};`);
            assert(gRes.exitCode === 0, `SHOW GRANTS FOR ${u}`, gRes.stderr.toString("utf8"));
            grants.push(`${u}=>${gRes.stdout.toString("utf8").trim().split(/\r?\n/).sort().join("|")}`);
          }
          return { dbs, users, grants };
        };

        try {
          const mkCanary = await runSql(
            [
              `CREATE DATABASE \`${canaryDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
              `CREATE TABLE \`${canaryDb}\`.t (id INT PRIMARY KEY, v VARCHAR(64));`,
              `INSERT INTO \`${canaryDb}\`.t VALUES (1, 'CANARY-UNTOUCHED');`,
            ].join(" "),
          );
          assert(mkCanary.exitCode === 0, "create canary DB", mkCanary.stderr.toString("utf8"));

          const beforeSnap = await snapshotDbsUsersGrants();

          // Phase 1: Identifiers with SQL-injection statements (`;CREATE/**/DATABASE...;#) in both copy and live DB
          const seedInjCopy = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db2Name}\`;`,
              `CREATE TABLE ${sqlId(cTblPwn)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(cTblPwn)} VALUES (1, 'PWN-COPY-ROW');`,
              `CREATE TABLE ${sqlId(cTblAud)} (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(64)) ENGINE=InnoDB;`,
              `CREATE VIEW ${sqlId(cViewPwn)} AS SELECT id, note FROM ${sqlId(cTblPwn)};`,
              `CREATE TRIGGER ${sqlId(cTrigPwn)} AFTER INSERT ON ${sqlId(cTblPwn)} FOR EACH ROW INSERT INTO ${sqlId(cTblAud)} (tag) VALUES (CONCAT('ctrig:', NEW.note));`,
              `CREATE PROCEDURE ${sqlId(cProcPwn)}() SELECT 'COPY-PROC-OK' AS tag;`,
              `CREATE EVENT ${sqlId(cEvPwn)} ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO ${sqlId(cTblAud)} (tag) VALUES ('cev');`,
              `CREATE TRIGGER ${sqlId(cTrigDu)} AFTER UPDATE ON ${sqlId(cTblAud)} FOR EACH ROW SET @hp_du = 1;`,
            ].join("\n"),
          );
          assert(seedInjCopy.exitCode === 0, "seed SQL-injection hostile objects to back up", seedInjCopy.stderr.toString("utf8"));

          const injBkJob = newJobId();
          runJobIds.push(injBkJob);
          await activeAdapter.backups({
            action: "start",
            jobId: injBkJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          const injBkRes = await pollBackupJob(activeAdapter, injBkJob);
          assert(
            injBkRes.state === "succeeded" && injBkRes.snapshot !== null,
            "backup with SQL-injection hostile object names succeeds",
            JSON.stringify(injBkRes),
          );

          const seedInjLive = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db2Name}\`;`,
              `UPDATE ${sqlId(cTblPwn)} SET note = 'BROKEN-PWN-ROW' WHERE id = 1;`,
              `CREATE TABLE ${sqlId(lTblPwn)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(lTblPwn)} VALUES (1, 'LIVE-ONLY');`,
              `CREATE TABLE ${sqlId(lTblAud)} (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(64)) ENGINE=InnoDB;`,
              `CREATE VIEW ${sqlId(lViewPwn)} AS SELECT id, note FROM ${sqlId(lTblPwn)};`,
              `CREATE TRIGGER ${sqlId(lTrigPwn)} AFTER INSERT ON ${sqlId(lTblPwn)} FOR EACH ROW INSERT INTO ${sqlId(lTblAud)} (tag) VALUES ('ltrig');`,
              `CREATE PROCEDURE ${sqlId(lProcPwn)}() SELECT 'LIVE-PROC' AS tag;`,
              `CREATE EVENT ${sqlId(lEvPwn)} ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO ${sqlId(lTblAud)} (tag) VALUES ('lev');`,
              `CREATE TRIGGER ${sqlId(lTrigDu)} AFTER UPDATE ON ${sqlId(lTblAud)} FOR EACH ROW SET @hp_du = 1;`,
            ].join("\n"),
          );
          assert(seedInjLive.exitCode === 0, "seed live-only SQL-injection hostile objects", seedInjLive.stderr.toString("utf8"));

          const injRestoreJob = newJobId();
          runJobIds.push(injRestoreJob);
          await activeAdapter.backups({
            action: "restore",
            jobId: injRestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: injBkRes.snapshot.snapshotId,
          });
          const injRes = await pollBackupJob(activeAdapter, injRestoreJob);

          // Check FIRST whether any injected CREATE DATABASE statement executed!
          const pwnCheck = await runSql(
            "SHOW DATABASES LIKE 'hp\\\\_pwn%'; SELECT CONCAT('user:', User) FROM mysql.user WHERE User LIKE 'hp\\\\_pwn%';",
          );
          assert(pwnCheck.exitCode === 0, "check for injected databases", pwnCheck.stderr.toString("utf8"));
          const pwnCreated = pwnCheck.stdout
            .toString("utf8")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          assert(
            pwnCreated.length === 0,
            "hostile object names never execute injected SQL statements",
            `injected statement ran, created databases/users: ${JSON.stringify(pwnCreated)}`,
          );
          assert(
            injRes.state === "succeeded" && injRes.failure === null,
            "restore with SQL-injection names in copy and live succeeds",
            JSON.stringify(injRes),
          );

          // Phase 2: Add leading-dash view/table, spaces/quotes/glob/$(), and UTF-8 in both copy and live DB
          const seedCopy = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db2Name}\`;`,
              `CREATE TABLE ${sqlId(cTblSpec)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(cTblSpec)} VALUES (1, 'SPEC-COPY-ROW');`,
              `CREATE TABLE ${sqlId(cTblDash)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(cTblDash)} VALUES (1, 'DASH-COPY-ROW');`,
              `CREATE TABLE ${sqlId(cTblUtf8)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(cTblUtf8)} VALUES (1, 'UTF8-COPY-ROW');`,
              `CREATE VIEW ${sqlId(cViewDash)} AS SELECT id, note FROM ${sqlId(cTblDash)};`,
              `CREATE VIEW ${sqlId(cViewSpec)} AS SELECT id, note FROM ${sqlId(cTblSpec)};`,
              `CREATE TRIGGER ${sqlId(cTrigSpec)} AFTER INSERT ON ${sqlId(cTblSpec)} FOR EACH ROW INSERT INTO ${sqlId(cTblAud)} (tag) VALUES (CONCAT('cspec:', NEW.note));`,
              `CREATE PROCEDURE ${sqlId(cProcSpec)}() SELECT 'COPY-SPEC-PROC' AS tag;`,
              `CREATE EVENT ${sqlId(cEvSpec)} ON SCHEDULE EVERY 1 DAY DISABLE DO SET @hp_e = 1;`,
            ].join("\n"),
          );
          assert(seedCopy.exitCode === 0, "seed hostile special/dash/utf8 objects to back up", seedCopy.stderr.toString("utf8"));

          const hostileBkJob = newJobId();
          runJobIds.push(hostileBkJob);
          await activeAdapter.backups({
            action: "start",
            jobId: hostileBkJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          const hostileBkRes = await pollBackupJob(activeAdapter, hostileBkJob);
          assert(
            hostileBkRes.state === "succeeded" && hostileBkRes.snapshot !== null,
            "backup with hostile object names succeeds",
            JSON.stringify(hostileBkRes),
          );
          const snapHostile = hostileBkRes.snapshot;

          // Mutate copy rows and plant DIFFERENT hostile objects in the live database.
          const seedLive = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db2Name}\`;`,
              `UPDATE ${sqlId(cTblPwn)} SET note = 'BROKEN-PWN-ROW' WHERE id = 1;`,
              `DROP VIEW IF EXISTS ${sqlId(cViewSpec)};`,
              `DROP TABLE IF EXISTS ${sqlId(cTblSpec)};`,
              `CREATE TABLE ${sqlId(lTblPwn)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(lTblPwn)} VALUES (1, 'LIVE-ONLY');`,
              `CREATE TABLE ${sqlId(lTblDash)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `CREATE TABLE ${sqlId(lTblSpec)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `CREATE TABLE ${sqlId(lTblAud)} (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(64)) ENGINE=InnoDB;`,
              `CREATE VIEW ${sqlId(lViewPwn)} AS SELECT id, note FROM ${sqlId(lTblPwn)};`,
              `CREATE TRIGGER ${sqlId(lTrigPwn)} AFTER INSERT ON ${sqlId(lTblPwn)} FOR EACH ROW INSERT INTO ${sqlId(lTblAud)} (tag) VALUES ('ltrig');`,
              `CREATE PROCEDURE ${sqlId(lProcPwn)}() SELECT 'LIVE-PROC' AS tag;`,
              `CREATE EVENT ${sqlId(lEvPwn)} ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO ${sqlId(lTblAud)} (tag) VALUES ('lev');`,
              `CREATE VIEW ${sqlId(lViewSpec)} AS SELECT id, note FROM ${sqlId(lTblSpec)};`,
              `CREATE TRIGGER ${sqlId(lTrigSpec)} AFTER INSERT ON ${sqlId(lTblSpec)} FOR EACH ROW SET @hp_l = 1;`,
              `CREATE PROCEDURE ${sqlId(lProcSpec)}() SELECT 'LIVE-SPEC-PROC' AS tag;`,
              `CREATE EVENT ${sqlId(lEvSpec)} ON SCHEDULE EVERY 1 DAY DISABLE DO SET @hp_e = 2;`,
            ].join("\n"),
          );
          assert(seedLive.exitCode === 0, "seed live-only hostile objects", seedLive.stderr.toString("utf8"));

          const hostileRestoreJob = newJobId();
          runJobIds.push(hostileRestoreJob);
          await activeAdapter.backups({
            action: "restore",
            jobId: hostileRestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapHostile.snapshotId,
          });
          const hostileRes = await pollBackupJob(activeAdapter, hostileRestoreJob);
          assert(
            hostileRes.state === "succeeded" && hostileRes.failure === null,
            "restore with hostile names in copy and live succeeds",
            JSON.stringify(hostileRes),
          );

          // Verify backed-up hostile tables, views, triggers, routines, events all came back and live-only ones are gone.
          const verifySql = await runSql(
            [
              "SET NAMES utf8mb4;",
              `SELECT note FROM \`${db2Name}\`.${sqlId(cTblPwn)} WHERE id = 1;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cTblSpec)} WHERE id = 1;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cTblDash)} WHERE id = 1;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cTblUtf8)} WHERE id = 1;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cViewPwn)} WHERE id = 1;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cViewDash)} WHERE id = 1;`,
              `CALL \`${db2Name}\`.${sqlId(cProcPwn)}();`,
              `SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${db2Name}' AND EVENT_NAME='${cEvPwn.replace(/'/g, "''")}';`,
              `INSERT INTO \`${db2Name}\`.${sqlId(cTblPwn)} VALUES (2, 'FIRED');`,
              `INSERT INTO \`${db2Name}\`.${sqlId(cTblSpec)} VALUES (2, 'SFIRED');`,
              `SELECT tag FROM \`${db2Name}\`.${sqlId(cTblAud)} ORDER BY id;`,
              `SELECT note FROM \`${db2Name}\`.${sqlId(cViewSpec)} WHERE id = 1;`,
              `CALL \`${db2Name}\`.${sqlId(cProcSpec)}();`,
              `SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${db2Name}' AND EVENT_NAME='${cEvSpec.replace(/'/g, "''")}';`,
              `SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${db2Name}' AND TRIGGER_NAME IN ('${cTrigSpec.replace(/'/g, "''")}','${cTrigDu.replace(/'/g, "''")}');`,
              `SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${db2Name}' AND TRIGGER_NAME IN ('${lTrigSpec.replace(/'/g, "''")}','${lTrigDu.replace(/'/g, "''")}','${lTrigPwn.replace(/'/g, "''")}')) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='${db2Name}' AND ROUTINE_NAME IN ('${lProcSpec.replace(/'/g, "''")}','${lProcPwn.replace(/'/g, "''")}')) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${db2Name}' AND EVENT_NAME IN ('${lEvSpec.replace(/'/g, "''")}','${lEvPwn.replace(/'/g, "''")}')) + (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='${db2Name}' AND TABLE_NAME='${lViewSpec.replace(/'/g, "''")}');`,
              `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db2Name}' AND TABLE_NAME IN ('${lTblPwn.replace(/'/g, "''")}','${lTblDash.replace(/'/g, "''")}','${lTblSpec.replace(/'/g, "''")}','${lViewPwn.replace(/'/g, "''")}');`,
              `SELECT v FROM \`${canaryDb}\`.t WHERE id = 1;`,
            ].join("\n"),
          );
          assert(verifySql.exitCode === 0, "verify restored hostile objects and canary", verifySql.stderr.toString("utf8"));
          const outLines = verifySql.stdout.toString("utf8").trim().split(/\r?\n/);
          assert(
            JSON.stringify(outLines) ===
              JSON.stringify([
                "PWN-COPY-ROW",
                "SPEC-COPY-ROW",
                "DASH-COPY-ROW",
                "UTF8-COPY-ROW",
                "PWN-COPY-ROW",
                "DASH-COPY-ROW",
                "COPY-PROC-OK",
                "1",
                "ctrig:FIRED",
                "cspec:SFIRED",
                "SPEC-COPY-ROW",
                "COPY-SPEC-PROC",
                "1",
                "2",
                "0",
                "0",
                "CANARY-UNTOUCHED",
              ]),
            "all copy hostile objects work identically, live-only gone, canary untouched",
            JSON.stringify(outLines),
          );

          const afterSnap = await snapshotDbsUsersGrants();
          assert(
            JSON.stringify(afterSnap) === JSON.stringify(beforeSnap),
            "databases, users, and grants identical before and after hostile restore",
            `before=${JSON.stringify(beforeSnap)} after=${JSON.stringify(afterSnap)}`,
          );
          await assertNoRestoreLeftovers();
        } finally {
          await runSql(
            [
              "SET NAMES utf8mb4;",
              `DROP DATABASE IF EXISTS \`${canaryDb}\`;`,
              `DROP DATABASE IF EXISTS \`${pwnCopyDb}\`;`,
              `DROP DATABASE IF EXISTS \`${pwnLiveDb}\`;`,
              `DROP DATABASE IF EXISTS \`${pwnDuDb}\`;`,
              `DROP USER IF EXISTS '${pwnDuUser}'@'%';`,
              `USE \`${db2Name}\`;`,
              `DROP EVENT IF EXISTS ${sqlId(cEvSpec)}; DROP EVENT IF EXISTS ${sqlId(lEvSpec)};`,
              `DROP PROCEDURE IF EXISTS ${sqlId(cProcSpec)}; DROP PROCEDURE IF EXISTS ${sqlId(lProcSpec)};`,
              `DROP VIEW IF EXISTS ${sqlId(cViewSpec)}; DROP VIEW IF EXISTS ${sqlId(lViewSpec)};`,
              `DROP TRIGGER IF EXISTS ${sqlId(cTrigSpec)}; DROP TRIGGER IF EXISTS ${sqlId(lTrigSpec)};`,
              `DROP TRIGGER IF EXISTS ${sqlId(cTrigDu)}; DROP TRIGGER IF EXISTS ${sqlId(lTrigDu)};`,
              `DROP EVENT IF EXISTS ${sqlId(cEvPwn)}; DROP EVENT IF EXISTS ${sqlId(lEvPwn)};`,
              `DROP PROCEDURE IF EXISTS ${sqlId(cProcPwn)}; DROP PROCEDURE IF EXISTS ${sqlId(lProcPwn)};`,
              `DROP VIEW IF EXISTS ${sqlId(cViewPwn)}; DROP VIEW IF EXISTS ${sqlId(cViewDash)}; DROP VIEW IF EXISTS ${sqlId(lViewPwn)};`,
              `DROP TRIGGER IF EXISTS ${sqlId(cTrigPwn)}; DROP TRIGGER IF EXISTS ${sqlId(lTrigPwn)};`,
              `DROP TABLE IF EXISTS ${sqlId(cTblAud)}; DROP TABLE IF EXISTS ${sqlId(cTblPwn)}; DROP TABLE IF EXISTS ${sqlId(cTblSpec)}; DROP TABLE IF EXISTS ${sqlId(cTblDash)}; DROP TABLE IF EXISTS ${sqlId(cTblUtf8)};`,
              `DROP TABLE IF EXISTS ${sqlId(lTblAud)}; DROP TABLE IF EXISTS ${sqlId(lTblPwn)}; DROP TABLE IF EXISTS ${sqlId(lTblSpec)}; DROP TABLE IF EXISTS ${sqlId(lTblDash)};`,
            ].join("\n"),
          ).catch(() => undefined);
        }
      });

      // 6i. R88: Refuses object names with newline or backslash (in live and in copy) leaving site and DBs untouched
      await runStep("restore-refuses-newline-and-backslash-names", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const pwnHex = runHex.slice(0, 8);
        const failCases = [
          {
            label: "live-newline-table",
            side: "live",
            token: `toklnl_${pwnHex}`,
            createSql: `EXECUTE IMMEDIATE CONCAT('CREATE TABLE \`${db2Name}\`.\`toklnl_${pwnHex}', CHAR(10), 'x\` (id INT PRIMARY KEY) ENGINE=InnoDB');`,
            dropSql: `EXECUTE IMMEDIATE CONCAT('DROP TABLE IF EXISTS \`${db2Name}\`.\`toklnl_${pwnHex}', CHAR(10), 'x\`');`,
          },
          {
            label: "live-backslash-table",
            side: "live",
            token: `toklbs_${pwnHex}`,
            createSql: `EXECUTE IMMEDIATE CONCAT('CREATE TABLE \`${db2Name}\`.\`toklbs_${pwnHex}', CHAR(92), 'x\` (id INT PRIMARY KEY) ENGINE=InnoDB');`,
            dropSql: `EXECUTE IMMEDIATE CONCAT('DROP TABLE IF EXISTS \`${db2Name}\`.\`toklbs_${pwnHex}', CHAR(92), 'x\`');`,
          },
          {
            label: "copy-newline-table",
            side: "copy",
            token: `tokcnl_${pwnHex}`,
            createSql: `EXECUTE IMMEDIATE CONCAT('CREATE TABLE \`${db2Name}\`.\`tokcnl_${pwnHex}', CHAR(10), 'x\` (id INT PRIMARY KEY) ENGINE=InnoDB');`,
            dropSql: `EXECUTE IMMEDIATE CONCAT('DROP TABLE IF EXISTS \`${db2Name}\`.\`tokcnl_${pwnHex}', CHAR(10), 'x\`');`,
          },
          {
            label: "copy-backslash-table",
            side: "copy",
            token: `tokcbs_${pwnHex}`,
            createSql: `EXECUTE IMMEDIATE CONCAT('CREATE TABLE \`${db2Name}\`.\`tokcbs_${pwnHex}', CHAR(92), 'x\` (id INT PRIMARY KEY) ENGINE=InnoDB');`,
            dropSql: `EXECUTE IMMEDIATE CONCAT('DROP TABLE IF EXISTS \`${db2Name}\`.\`tokcbs_${pwnHex}', CHAR(92), 'x\`');`,
          },
        ];

        for (const fc of failCases) {
          try {
            let targetSnap = snapRestore.snapshotId;
            const mk = await runSql(fc.createSql);
            assert(mk.exitCode === 0, `${fc.label}: create bad-name object`, mk.stderr.toString("utf8"));

            if (fc.side === "copy") {
              const bkJob = newJobId();
              runJobIds.push(bkJob);
              await activeAdapter.backups({
                action: "start",
                jobId: bkJob,
                siteId,
                serviceInstanceId,
                target: goodTarget,
              });
              const bkRes = await pollBackupJob(activeAdapter, bkJob);
              assert(
                bkRes.state === "succeeded" && bkRes.snapshot !== null,
                `${fc.label}: backup with bad object name succeeds`,
                JSON.stringify(bkRes),
              );
              targetSnap = bkRes.snapshot.snapshotId;
              const dr = await runSql(fc.dropSql);
              assert(dr.exitCode === 0, `${fc.label}: drop bad object from live`, dr.stderr.toString("utf8"));
            }

            const beforeTables = await runSql(
              `SELECT HEX(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('${db1Name}', '${db2Name}') ORDER BY TABLE_SCHEMA, TABLE_NAME;`,
            );
            assert(beforeTables.exitCode === 0, `${fc.label}: snapshot table list before`, beforeTables.stderr.toString("utf8"));
            const beforePage = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
            const beforeBody = await beforePage.text();

            const waitStartIdx = capturedFailedWaits.length;
            const badRestoreJob = newJobId();
            runJobIds.push(badRestoreJob);
            await activeAdapter.backups({
              action: "restore",
              jobId: badRestoreJob,
              siteId,
              serviceInstanceId,
              target: goodTarget,
              snapshotId: targetSnap,
            });
            const res = await pollBackupJob(activeAdapter, badRestoreJob);
            assert(
              res.state === "failed" && res.failure === "restore_prepare_failed",
              `${fc.label}: refused cleanly with restore_prepare_failed`,
              JSON.stringify(res),
            );

            // Site remains 200 with same marker; object name never leaked into failed container logs.
            const afterPage = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
            const afterBody = await afterPage.text();
            assert(
              afterPage.status === 200 && afterBody === beforeBody,
              `${fc.label}: site untouched (200)`,
              `status=${String(afterPage.status)} body=${afterBody}`,
            );
            const afterTables = await runSql(
              `SELECT HEX(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('${db1Name}', '${db2Name}') ORDER BY TABLE_SCHEMA, TABLE_NAME;`,
            );
            assert(
              afterTables.exitCode === 0 &&
                afterTables.stdout.toString("utf8") === beforeTables.stdout.toString("utf8"),
              `${fc.label}: database tables unchanged after refusal`,
              "tables changed",
            );
            for (const fw of capturedFailedWaits.slice(waitStartIdx)) {
              assert(
                !fw.logs.includes(fc.token),
                `${fc.label}: container logs do not reveal bad object name`,
                fw.logs,
              );
            }
            await assertNoRestoreLeftovers();
          } finally {
            await runSql(fc.dropSql).catch(() => undefined);
          }
        }
      });

      // 6i2. R102: a newline-named live table that appears after prepare's check is refused by the switch's own check
      await runStep("restore-switch-refuses-name-added-after-prepare", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const tok = `toksnl_${runHex.slice(0, 8)}`;
        const dropSql = `EXECUTE IMMEDIATE CONCAT('DROP TABLE IF EXISTS \`${db2Name}\`.\`${tok}', CHAR(10), 'x\`');`;
        let hookRan = false;
        try {
          const beforePage = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
          const beforeBody = await beforePage.text();
          beforeSwitchCreate = async () => {
            const mk = await runSql(`EXECUTE IMMEDIATE CONCAT('CREATE TABLE \`${db2Name}\`.\`${tok}', CHAR(10), 'x\` (id INT) ENGINE=InnoDB');`);
            assert(mk.exitCode === 0, "create newline-named live table before the switch", mk.stderr.toString("utf8"));
            hookRan = true;
          };
          const waitIdx = capturedFailedWaits.length;
          const job = newJobId();
          runJobIds.push(job);
          await activeAdapter.backups({
            action: "restore",
            jobId: job,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: snapRestore.snapshotId,
          });
          const res = await pollBackupJob(activeAdapter, job);
          assert(hookRan, "hostile name placed after prepare, before the switch container exists", "hook never ran");
          assert(
            res.state === "failed" && res.failure === "switch_undone",
            "switch refuses the late hostile name (exit 84) and settles switch_undone",
            `${JSON.stringify(res)} exits=${JSON.stringify(capturedFailedWaits.slice(waitIdx).map((w) => w.exitCode))}`,
          );
          const switchId = capturedContainerSpecs.find(
            (c) => c.phase === "create" && c.containerName === `hp_bk_${job}_rs_switch`,
          )?.containerId;
          const switchWait = capturedFailedWaits.slice(waitIdx).find((w) => w.container === switchId);
          assert(switchWait?.exitCode === 84, "the switch container itself ended with exit 84", JSON.stringify(switchWait?.exitCode));
          for (const fw of capturedFailedWaits.slice(waitIdx)) {
            assert(!fw.logs.includes(tok), "container logs do not reveal the hostile name", fw.logs);
          }
          const afterPage = await fetch(`http://${siteIp}:8080/`, { signal: AbortSignal.timeout(2_000) });
          const afterBody = await afterPage.text();
          assert(
            afterPage.status === 200 && afterBody === beforeBody,
            "site untouched (200, same page) after the refused switch",
            `status=${String(afterPage.status)}`,
          );
          const still = await runSql(
            `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db2Name}' AND TABLE_NAME=CONCAT('${tok}', CHAR(10), 'x');`,
          );
          assert(still.stdout.toString("utf8").trim() === "1", "the live hostile table is still in place, untouched", still.stdout.toString("utf8"));
          await assertNoRestoreLeftovers();
        } finally {
          beforeSwitchCreate = null;
          await runSql(dropSql).catch(() => undefined);
        }
      });

      // 6j. R90: Real WordPress image with 20-minute-old .maintenance (200) keeps byte-identical file and stays 200 after switch_undone
      await runStep("restore-switch-failure-keeps-wp-maintenance", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const r90SiteId = `site_swarmtest_r90_${runHex}`;
        const r90SvcId = `svc_swarmtest_r90_${runHex}`;
        const r90VolName = getManagedVolumeName(r90SvcId, "html");
        const r90DbName = siteDatabasePrefix(r90SiteId);
        const r90DbUser = `wp_r90_${runHex}`;
        const r90ContainerName = `${runId}_r90_wp`;
        const r90LockSecretFile = wpOwnSecretFile;

        let lockChild = null;
        let lockConnId = null;
        try {
          const mkDb = await runSql(
            [
              `CREATE DATABASE \`${r90DbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
              `CREATE USER '${r90DbUser}'@'%' IDENTIFIED BY '${wpOwnDbPass}';`,
              `GRANT ALL PRIVILEGES ON \`${r90DbName}\`.* TO '${r90DbUser}'@'%';`,
              "FLUSH PRIVILEGES;",
              `CREATE TABLE \`${r90DbName}\`.hp_r90_lock (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO \`${r90DbName}\`.hp_r90_lock VALUES (1, 'R90-ORIG');`,
            ].join(" "),
          );
          assert(mkDb.exitCode === 0, "create DB for real WordPress R90 test", mkDb.stderr.toString("utf8"));

          const volRes = await docker(["volume", "create", r90VolName]);
          assert(volRes.ok, "create managed volume for R90 WordPress", volRes.stderr);
          createdVolumes.add(r90VolName);

          const wpRun = await docker([
            "run",
            "-d",
            "--name",
            r90ContainerName,
            "--network",
            networkName,
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--cap-add",
            "SETUID",
            "--cap-add",
            "SETGID",
            "--cap-add",
            "NET_BIND_SERVICE",
            "--cap-add",
            "DAC_OVERRIDE",
            "--cap-add",
            "FOWNER",
            "--security-opt",
            "no-new-privileges:true",
            "-v",
            `${r90VolName}:/var/www/html`,
            "-v",
            `${r90LockSecretFile}:/run/secrets/wp_db_pw:ro`,
            "-e",
            `WORDPRESS_DB_HOST=${SHARED_DB_ALIAS}`,
            "-e",
            `WORDPRESS_DB_NAME=${r90DbName}`,
            "-e",
            `WORDPRESS_DB_USER=${r90DbUser}`,
            "-e",
            "WORDPRESS_DB_PASSWORD_FILE=/run/secrets/wp_db_pw",
            WORDPRESS_IMAGE,
          ]);
          assert(wpRun.ok, "real WordPress R90 container starts", wpRun.stderr);
          createdContainers.add(r90ContainerName);

          const insp = await dockerInspectContainer(r90ContainerName);
          const wpIp = insp?.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? "";
          assert(wpIp.length > 0, "real WordPress R90 IP assigned", wpIp);

          const waitDeadline = Date.now() + 45_000;
          let initCode = 0;
          while (Date.now() < waitDeadline) {
            try {
              const r = await fetch(`http://${wpIp}:80/`, { signal: AbortSignal.timeout(2_000) });
              if (r.status === 200) {
                initCode = r.status;
                break;
              }
            } catch {
              // wait for entrypoint + Apache startup
            }
            await sleep(300);
          }
          assert(initCode === 200, "real WordPress R90 answers 200 before backup", String(initCode));

          const r90BkJob = newJobId();
          runJobIds.push(r90BkJob);
          await activeAdapter.backups({
            action: "start",
            jobId: r90BkJob,
            siteId: r90SiteId,
            serviceInstanceId: r90SvcId,
            target: goodTarget,
          });
          const r90BkRes = await pollBackupJob(activeAdapter, r90BkJob);
          assert(
            r90BkRes.state === "succeeded" && r90BkRes.snapshot !== null,
            "backup of real WordPress R90 succeeds",
            JSON.stringify(r90BkRes),
          );

          const oldTs = Math.floor(Date.now() / 1000) - 1200;
          const oldMaintContent = `<?php $upgrading = ${String(oldTs)}; // wp-20min-old-${runHex}\n`;
          const writeMaint = await docker(
            [
              "exec",
              "-i",
              "-u",
              "33:33",
              r90ContainerName,
              "sh",
              "-c",
              `cat > /var/www/html/.maintenance && touch -d '@${String(oldTs)}' /var/www/html/.maintenance && sha256sum /var/www/html/.maintenance`,
            ],
            { stdin: oldMaintContent },
          );
          assert(writeMaint.ok, "write 20-minute-old .maintenance", writeMaint.stderr);
          const beforeSha = writeMaint.stdout.trim().split(/\s+/)[0];

          const pageBefore = await fetch(`http://${wpIp}:80/`, { signal: AbortSignal.timeout(2_000) });
          assert(pageBefore.status === 200, "real WordPress answers 200 with 20-minute-old .maintenance", String(pageBefore.status));

          // Lock R90 DB table to force switch_undone inside switch.
          const r90LockScript = [
            "set -eu",
            "trap 'rm -f /tmp/hp-r90-lock.cnf' EXIT",
            'printf \'[client]\\nuser=root\\nhost=localhost\\npassword=%s\\n\' "$(cat /run/secrets/mariadb-root)" > /tmp/hp-r90-lock.cnf',
            `mariadb --defaults-extra-file=/tmp/hp-r90-lock.cnf -N -B -e "BEGIN; SELECT * FROM \\\`${r90DbName}\\\`.hp_r90_lock FOR UPDATE; SELECT SLEEP(60) AS hp_r90_sleep; COMMIT;"`,
          ].join("\n");
          lockChild = spawn("docker", ["exec", "-i", dbContainerName, "sh", "-c", r90LockScript], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          activeChildProcs.add(lockChild);
          const lockExitPromise = new Promise((resolve) => {
            lockChild.once("exit", () => {
              activeChildProcs.delete(lockChild);
              resolve();
            });
          });
          const lockDeadline = Date.now() + 15_000;
          while (Date.now() < lockDeadline) {
            const pRes = await runSql(
              "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%hp_r90_sleep%' AND INFO NOT LIKE '%PROCESSLIST%' LIMIT 1;",
            );
            if (pRes.exitCode === 0 && /^\d+$/.test(pRes.stdout.toString("utf8").trim())) {
              lockConnId = pRes.stdout.toString("utf8").trim();
              break;
            }
            await sleep(50);
          }
          assert(lockConnId !== null, "R90 MariaDB lock active", "not found");

          try {
            const r90RestoreJob = newJobId();
            runJobIds.push(r90RestoreJob);
            await activeAdapter.backups({
              action: "restore",
              jobId: r90RestoreJob,
              siteId: r90SiteId,
              serviceInstanceId: r90SvcId,
              target: goodTarget,
              snapshotId: r90BkRes.snapshot.snapshotId,
            });
            const r90Res = await pollBackupJob(activeAdapter, r90RestoreJob);
            assert(
              r90Res.state === "failed" && r90Res.failure === "switch_undone",
              "R90 switch lock settles as switch_undone",
              JSON.stringify(r90Res),
            );
          } finally {
            if (lockConnId !== null) {
              await runSql(`KILL ${lockConnId};`).catch(() => undefined);
            }
            await Promise.race([lockExitPromise, sleep(5_000)]);
          }

          const readMaint = await docker([
            "exec",
            "-u",
            "33:33",
            r90ContainerName,
            "sh",
            "-c",
            "test -f /var/www/html/.maintenance && test ! -L /var/www/html/.maintenance && sha256sum /var/www/html/.maintenance && cat /var/www/html/.maintenance",
          ]);
          assert(readMaint.ok, ".maintenance still exists as regular file after switch_undone", readMaint.stderr);
          const firstLine = readMaint.stdout.split(/\r?\n/)[0] ?? "";
          const afterSha = firstLine.trim().split(/\s+/)[0];
          const afterBody = readMaint.stdout.slice(firstLine.length + 1);
          assert(
            afterSha === beforeSha && afterBody === oldMaintContent,
            "20-minute-old .maintenance is byte-identical after switch_undone",
            `beforeSha=${beforeSha} afterSha=${afterSha} body=${JSON.stringify(afterBody)}`,
          );

          const pageAfter = await fetch(`http://${wpIp}:80/`, { signal: AbortSignal.timeout(2_000) });
          assert(pageAfter.status === 200, "real WordPress answers 200 after switch_undone", String(pageAfter.status));
        } finally {
          await docker(["rm", "-f", "-v", r90ContainerName]);
          createdContainers.delete(r90ContainerName);
          await docker(["volume", "rm", r90VolName]);
          createdVolumes.delete(r90VolName);
          await runSql(`DROP DATABASE IF EXISTS \`${r90DbName}\`; DROP USER IF EXISTS '${r90DbUser}'@'%';`).catch(
            () => undefined,
          );
        }
      });

      // 6k. R91 proof (a): Dump with DB-qualified trigger/view/routine/event and literal db-name row restores cleanly once
      await runStep("restore-db-qualified-objects-from-backup", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const literalRow = `KEEP:${db1Name}.hp_r91_aud and \`${db1Name}\`.hp_r91_src`;
        try {
          const setupSql = [
            "SET NAMES utf8mb4;",
            `USE \`${db1Name}\`;`,
            "CREATE TABLE hp_r91_src (id INT PRIMARY KEY, v INT) ENGINE=InnoDB;",
            "CREATE TABLE hp_r91_aud (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(255)) ENGINE=InnoDB;",
            `INSERT INTO hp_r91_aud (tag) VALUES ('${literalRow}');`,
            "DELIMITER ;;",
            `CREATE TRIGGER ${db1Name}.tr_hp_r91 AFTER INSERT ON ${db1Name}.hp_r91_src FOR EACH ROW`,
            "BEGIN",
            `  INSERT INTO ${db1Name}.hp_r91_aud (tag) VALUES (CONCAT('u:', NEW.v));`,
            `  INSERT INTO \`${db1Name}\`.\`hp_r91_aud\` (tag) VALUES (CONCAT('q:', NEW.v));`,
            "END;;",
            // R100: header forms the restore must read (IF NOT EXISTS, non-ASCII unquoted name, no space by quotes).
            `CREATE TRIGGER IF NOT EXISTS ${db1Name}.tr_hp_r100_é AFTER UPDATE ON ${db1Name}.hp_r91_src FOR EACH ROW INSERT INTO hp_r91_aud (tag) VALUES (CONCAT('upd:', NEW.v));;`,
            `CREATE TRIGGER\`${db1Name}\`.\`tr_hp_r100_ns\`AFTER DELETE ON\`${db1Name}\`.\`hp_r91_src\`FOR EACH ROW INSERT INTO hp_r91_aud (tag) VALUES (CONCAT('del:', OLD.v));;`,
            `CREATE VIEW ${db1Name}.v_hp_r91 AS SELECT id, v FROM ${db1Name}.hp_r91_src;;`,
            `CREATE PROCEDURE ${db1Name}.p_hp_r91() BEGIN SELECT tag FROM ${db1Name}.hp_r91_aud ORDER BY id; END;;`,
            `CREATE EVENT ${db1Name}.e_hp_r91 ON SCHEDULE EVERY 1 DAY DISABLE DO BEGIN INSERT INTO ${db1Name}.hp_r91_aud (tag) VALUES ('ev'); END;;`,
            "DELIMITER ;",
          ].join("\n");
          const mkRes = await runSql(setupSql);
          assert(mkRes.exitCode === 0, "create DB-qualified objects", mkRes.stderr.toString("utf8"));

          const r91BkJob = newJobId();
          runJobIds.push(r91BkJob);
          await activeAdapter.backups({
            action: "start",
            jobId: r91BkJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          const r91BkRes = await pollBackupJob(activeAdapter, r91BkJob);
          assert(
            r91BkRes.state === "succeeded" && r91BkRes.snapshot !== null,
            "backup with DB-qualified objects succeeds",
            JSON.stringify(r91BkRes),
          );

          // Drop all R91 objects from live DB so unqualified/raw replay of DB-qualified triggers fails ERROR 1146.
          const dropLive = await runSql(
            [
              `USE \`${db1Name}\`;`,
              "DROP TRIGGER IF EXISTS tr_hp_r91;",
              "DROP VIEW IF EXISTS v_hp_r91;",
              "DROP PROCEDURE IF EXISTS p_hp_r91;",
              "DROP EVENT IF EXISTS e_hp_r91;",
              "DROP TABLE IF EXISTS hp_r91_src;",
              "DROP TABLE IF EXISTS hp_r91_aud;",
            ].join(" "),
          );
          assert(dropLive.exitCode === 0, "drop R91 objects from live before restore", dropLive.stderr.toString("utf8"));

          const r91RestoreJob = newJobId();
          runJobIds.push(r91RestoreJob);
          await activeAdapter.backups({
            action: "restore",
            jobId: r91RestoreJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: r91BkRes.snapshot.snapshotId,
          });
          const r91Res = await pollBackupJob(activeAdapter, r91RestoreJob);
          assert(
            r91Res.state === "succeeded" && r91Res.failure === null,
            "restore of DB-qualified trigger/view/routine/event succeeds in one run",
            `${JSON.stringify(r91Res)} wait=${JSON.stringify(capturedFailedWaits.slice(-1))}`,
          );

          const checkRes = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db1Name}\`;`,
              "INSERT INTO hp_r91_src VALUES (1, 42);",
              "SELECT COUNT(*) FROM v_hp_r91;",
              `SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${db1Name}' AND EVENT_NAME='e_hp_r91';`,
              `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${db1Name}' AND TRIGGER_NAME LIKE 'tr\\_hp\\_r100\\_%' ORDER BY 1;`,
              "UPDATE hp_r91_src SET v = 43 WHERE id = 1;",
              "DELETE FROM hp_r91_src WHERE id = 1;",
              "CALL p_hp_r91();",
            ].join(" "),
          );
          assert(checkRes.exitCode === 0, "verify restored R91 trigger, data, view, routine, event", checkRes.stderr.toString("utf8"));
          const lines = checkRes.stdout.toString("utf8").trim().split(/\r?\n/);
          assert(
            JSON.stringify(lines) ===
              JSON.stringify(["1", "1", "tr_hp_r100_é", "tr_hp_r100_ns", literalRow, "u:42", "q:42", "upd:43", "del:43"]),
            "restored DB-qualified triggers (R100 header forms too) fire and INSERT data row with DB name is intact",
            JSON.stringify(lines),
          );
          await assertNoRestoreLeftovers();
        } finally {
          await runSql(
            [
              `USE \`${db1Name}\`;`,
              "DROP EVENT IF EXISTS e_hp_r91;",
              "DROP PROCEDURE IF EXISTS p_hp_r91;",
              "DROP VIEW IF EXISTS v_hp_r91;",
              "DROP TRIGGER IF EXISTS tr_hp_r91;",
              "DROP TABLE IF EXISTS hp_r91_src;",
              "DROP TABLE IF EXISTS hp_r91_aud;",
            ].join(" "),
          ).catch(() => undefined);
        }
      });

      // 6l. R91 proof (b): Failed prepare leaves live DB tables, views, triggers, routines, events, and rows completely unchanged
      await runStep("restore-failed-prepare-leaves-live-untouched", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const r91DefUser = `hp_r91d_${runHex}`;
        try {
          const setupSql = [
            `CREATE USER '${r91DefUser}'@'%' IDENTIFIED BY 'r91-def-pass';`,
            `GRANT SELECT ON \`${db1Name}\`.* TO '${r91DefUser}'@'%';`,
            `USE \`${db1Name}\`;`,
            "CREATE TABLE hp_r91b_src (id INT PRIMARY KEY, v VARCHAR(64)) ENGINE=InnoDB;",
            "INSERT INTO hp_r91b_src VALUES (1, 'COPY-VAL');",
            "CREATE TABLE hp_r91b_aud (tag VARCHAR(64)) ENGINE=InnoDB;",
            `CREATE TRIGGER ${db1Name}.tr_r91b_leak AFTER INSERT ON ${db1Name}.hp_r91b_src FOR EACH ROW INSERT INTO ${db1Name}.hp_r91b_aud VALUES ('FROM-PREPARE-LEAK');`,
            `CREATE DEFINER='${r91DefUser}'@'%' SQL SECURITY DEFINER VIEW ${db1Name}.v_r91b_def AS SELECT id, v FROM ${db1Name}.hp_r91b_src;`,
          ].join(" ");
          const mkRes = await runSql(setupSql);
          assert(mkRes.exitCode === 0, "create R91b snapshot fixture", mkRes.stderr.toString("utf8"));

          const bkJob = newJobId();
          runJobIds.push(bkJob);
          await activeAdapter.backups({
            action: "start",
            jobId: bkJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
          });
          const bkRes = await pollBackupJob(activeAdapter, bkJob);
          assert(
            bkRes.state === "succeeded" && bkRes.snapshot !== null,
            "backup for R91b failed-prepare test succeeds",
            JSON.stringify(bkRes),
          );

          // Drop temp definer + v_r91b_def + tr_r91b_leak, and set distinctive live state + live view/trigger/proc/event.
          const livePrep = await runSql(
            [
              `USE \`${db1Name}\`;`,
              "DROP VIEW IF EXISTS v_r91b_def;",
              "DROP TRIGGER IF EXISTS tr_r91b_leak;",
              `DROP USER IF EXISTS '${r91DefUser}'@'%';`,
              "UPDATE hp_r91b_src SET v = 'LIVE-ONLY-VAL' WHERE id = 1;",
              "CREATE VIEW v_r91b_live AS SELECT id, v FROM hp_r91b_src;",
              "CREATE TRIGGER tr_r91b_live AFTER INSERT ON hp_r91b_src FOR EACH ROW INSERT INTO hp_r91b_aud VALUES ('LIVE-TRIG');",
              "CREATE PROCEDURE p_r91b_live() SELECT v FROM hp_r91b_src WHERE id = 1;",
              "CREATE EVENT e_r91b_live ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO hp_r91b_aud VALUES ('LIVE-EV');",
            ].join(" "),
          );
          assert(livePrep.exitCode === 0, "prepare distinct live state for R91b", livePrep.stderr.toString("utf8"));

          const captureFullLive = async () => {
            const qRes = await runSql(
              [
                `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('${db1Name}','${db2Name}') ORDER BY 1,2;`,
                `SELECT TRIGGER_SCHEMA, TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN ('${db1Name}','${db2Name}') ORDER BY 1,2;`,
                `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN ('${db1Name}','${db2Name}') ORDER BY 1,2;`,
                `SELECT EVENT_SCHEMA, EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA IN ('${db1Name}','${db2Name}') ORDER BY 1,2;`,
                `SELECT v FROM \`${db1Name}\`.hp_r91b_src ORDER BY id;`,
                `SELECT tag FROM \`${db1Name}\`.hp_r91b_aud ORDER BY tag;`,
              ].join(" "),
            );
            assert(qRes.exitCode === 0, "capture full live objects", qRes.stderr.toString("utf8"));
            return qRes.stdout.toString("utf8").trim();
          };
          const liveBefore = await captureFullLive();
          const siteStateBefore = await captureSiteAndDbState();

          const failJob = newJobId();
          runJobIds.push(failJob);
          await activeAdapter.backups({
            action: "restore",
            jobId: failJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: bkRes.snapshot.snapshotId,
          });
          const failRes = await pollBackupJob(activeAdapter, failJob);
          assert(
            failRes.state === "failed" && failRes.failure === "definer_missing",
            "R91b prepare failure settles as definer_missing (not polluting live DB)",
            JSON.stringify(failRes),
          );

          const liveAfter = await captureFullLive();
          const siteStateAfter = await captureSiteAndDbState();
          assert(
            liveAfter === liveBefore &&
              siteStateAfter.checksumsText === siteStateBefore.checksumsText &&
              siteStateAfter.showCreatesText === siteStateBefore.showCreatesText &&
              siteStateAfter.fileHashesText === siteStateBefore.fileHashesText,
            "live DBs (tables, views, triggers, routines, events, rows) completely untouched after failed prepare",
            `before=${liveBefore}\nafter=${liveAfter}`,
          );
          await assertNoRestoreLeftovers();
        } finally {
          await runSql(
            [
              `USE \`${db1Name}\`;`,
              "DROP EVENT IF EXISTS e_r91b_live;",
              "DROP PROCEDURE IF EXISTS p_r91b_live;",
              "DROP VIEW IF EXISTS v_r91b_live;",
              "DROP VIEW IF EXISTS v_r91b_def;",
              "DROP TRIGGER IF EXISTS tr_r91b_live;",
              "DROP TRIGGER IF EXISTS tr_r91b_leak;",
              "DROP TABLE IF EXISTS hp_r91b_src;",
              "DROP TABLE IF EXISTS hp_r91b_aud;",
              `DROP USER IF EXISTS '${r91DefUser}'@'%';`,
            ].join(" "),
          ).catch(() => undefined);
        }
      });
      // 6m. R88: a name holding "<db>." never loses its quotes in prepare; odd trigger headers are refused before the gate
      await runStep("restore-db-qualifier-injection-refused", async () => {
        const activeAdapter = adapter2 ?? adapter;
        const sqlId = (name) => "`" + name.replace(/`/g, "``") + "`";
        const qDb = `hp_pwnq_${runHex}`;
        const qUser = `hp_pwnu_${runHex}`;
        const canaryDb = `hp_swarmtest_qcanary_${runHex}`;
        const tDb = `${db2Name}.t;CREATE DATABASE ${qDb};#`;
        const tUser = `${db2Name}.a;CREATE USER ${qUser};#`;
        const trName = `qtr\`;CREATE USER ${qUser};#`;
        const trOdd = `hp_qodd_${runHex}`;
        assert(tDb.length <= 64 && tUser.length <= 64, "injection names fit in 64 chars", `${tDb.length} ${tUser.length}`);
        const listDbsUsers = async () => {
          const r = await runSql("SHOW DATABASES; SELECT CONCAT(QUOTE(User), '@', QUOTE(Host)) FROM mysql.user ORDER BY 1;");
          assert(r.exitCode === 0, "list databases and users", r.stderr.toString("utf8"));
          return r.stdout.toString("utf8").trim();
        };
        const dropAll = [
          "SET NAMES utf8mb4;",
          `DROP DATABASE IF EXISTS \`${qDb}\`;`,
          `DROP DATABASE IF EXISTS \`${canaryDb}\`;`,
          `DROP USER IF EXISTS '${qUser}'@'%';`,
          `USE \`${db2Name}\`;`,
          `DROP TRIGGER IF EXISTS ${sqlId(trName)}; DROP TRIGGER IF EXISTS ${sqlId(trOdd)};`,
          `DROP TABLE IF EXISTS ${sqlId(tDb)}; DROP TABLE IF EXISTS ${sqlId(tUser)}; DROP TABLE IF EXISTS hp_q_aud;`,
        ].join("\n");
        try {
          const mk = await runSql(
            [
              "SET NAMES utf8mb4;",
              `CREATE DATABASE \`${canaryDb}\`; CREATE TABLE \`${canaryDb}\`.t (v VARCHAR(32)); INSERT INTO \`${canaryDb}\`.t VALUES ('CANARY');`,
              `USE \`${db2Name}\`;`,
              `CREATE TABLE ${sqlId(tDb)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(tDb)} VALUES (1, 'Q-DB-ROW');`,
              `CREATE TABLE ${sqlId(tUser)} (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB;`,
              `INSERT INTO ${sqlId(tUser)} VALUES (1, 'Q-USER-ROW');`,
              "CREATE TABLE hp_q_aud (tag VARCHAR(64)) ENGINE=InnoDB;",
              `CREATE TRIGGER \`${db2Name}\`.${sqlId(trName)} AFTER INSERT ON \`${db2Name}\`.${sqlId(tDb)} FOR EACH ROW INSERT INTO \`${db2Name}\`.hp_q_aud VALUES (CONCAT('qtr:', NEW.note));`,
            ].join("\n"),
          );
          assert(mk.exitCode === 0, "seed names holding the database qualifier", mk.stderr.toString("utf8"));
          const before = await listDbsUsers();

          const bkJob = newJobId();
          runJobIds.push(bkJob);
          await activeAdapter.backups({ action: "start", jobId: bkJob, siteId, serviceInstanceId, target: goodTarget });
          const bkRes = await pollBackupJob(activeAdapter, bkJob);
          assert(bkRes.state === "succeeded" && bkRes.snapshot !== null, "backup with qualifier names succeeds", JSON.stringify(bkRes));
          const mut = await runSql(`USE \`${db2Name}\`; UPDATE ${sqlId(tDb)} SET note = 'LIVE-CHANGED' WHERE id = 1;`);
          assert(mut.exitCode === 0, "change live row", mut.stderr.toString("utf8"));

          const rsJob = newJobId();
          runJobIds.push(rsJob);
          await activeAdapter.backups({
            action: "restore",
            jobId: rsJob,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: bkRes.snapshot.snapshotId,
          });
          const rsRes = await pollBackupJob(activeAdapter, rsJob);
          const pwn = await runSql(`SHOW DATABASES LIKE 'hp\\\\_pwnq%'; SELECT User FROM mysql.user WHERE User LIKE 'hp\\\\_pwnu%';`);
          assert(pwn.exitCode === 0, "check for injected database and user", pwn.stderr.toString("utf8"));
          assert(
            pwn.stdout.toString("utf8").trim() === "",
            "names holding the database qualifier never run injected SQL",
            `injected statement ran: ${pwn.stdout.toString("utf8").trim()}`,
          );
          assert(rsRes.state === "succeeded" && rsRes.failure === null, "restore with qualifier names succeeds", JSON.stringify(rsRes));
          const chk = await runSql(
            [
              "SET NAMES utf8mb4;",
              `USE \`${db2Name}\`;`,
              `SELECT note FROM ${sqlId(tDb)} WHERE id = 1;`,
              `SELECT note FROM ${sqlId(tUser)} WHERE id = 1;`,
              `INSERT INTO ${sqlId(tDb)} VALUES (2, 'FIRED');`,
              "SELECT tag FROM hp_q_aud;",
              `SELECT v FROM \`${canaryDb}\`.t;`,
            ].join("\n"),
          );
          assert(chk.exitCode === 0, "verify restored qualifier objects", chk.stderr.toString("utf8"));
          assert(
            chk.stdout.toString("utf8").trim() === ["Q-DB-ROW", "Q-USER-ROW", "qtr:FIRED", "CANARY"].join("\n"),
            "rows, trigger and canary intact",
            chk.stdout.toString("utf8"),
          );
          assert((await listDbsUsers()) === before, "databases and users unchanged", "databases or users changed");
          await assertNoRestoreLeftovers();

          // A trigger header the strip cannot parse (comment inside) is refused in prepare: exit 84, live untouched.
          // The client drops comments, so the statement goes in a string to reach the server as typed.
          const odd = await runSql(
            `USE \`${db2Name}\`; EXECUTE IMMEDIATE 'CREATE TRIGGER ${trOdd} /*hp*/ AFTER INSERT ON hp_q_aud FOR EACH ROW SET @hp_q = 1';`,
          );
          assert(odd.exitCode === 0, "seed trigger with comment in header", odd.stderr.toString("utf8"));
          const oddBk = newJobId();
          runJobIds.push(oddBk);
          await activeAdapter.backups({ action: "start", jobId: oddBk, siteId, serviceInstanceId, target: goodTarget });
          const oddBkRes = await pollBackupJob(activeAdapter, oddBk);
          assert(oddBkRes.state === "succeeded" && oddBkRes.snapshot !== null, "backup with odd trigger header succeeds", JSON.stringify(oddBkRes));
          const stateBefore = await captureSiteAndDbState();
          const waitIdx = capturedFailedWaits.length;
          const oddRs = newJobId();
          runJobIds.push(oddRs);
          await activeAdapter.backups({
            action: "restore",
            jobId: oddRs,
            siteId,
            serviceInstanceId,
            target: goodTarget,
            snapshotId: oddBkRes.snapshot.snapshotId,
          });
          const oddRes = await pollBackupJob(activeAdapter, oddRs);
          assert(oddRes.state === "failed" && oddRes.failure === "restore_prepare_failed", "odd trigger header refused in prepare", JSON.stringify(oddRes));
          const stateAfter = await captureSiteAndDbState();
          assert(
            stateAfter.checksumsText === stateBefore.checksumsText &&
              stateAfter.showCreatesText === stateBefore.showCreatesText &&
              stateAfter.fileHashesText === stateBefore.fileHashesText,
            "live site and databases untouched after refused header",
            "state changed",
          );
          const oddLogs = capturedFailedWaits.slice(waitIdx).map((w) => w.logs).join("\n");
          assert(oddLogs.includes(`TRIGGER\t${db2Name}`), "refusal names only the kind and database", oddLogs);
          assert(!oddLogs.includes(trOdd), "refusal does not reveal the trigger name", oddLogs);
          await assertNoRestoreLeftovers();
        } finally {
          await runSql(dropAll).catch(() => undefined);
        }
      });
    }

    // 7. Restart case: kill in-flight backup via second adapter's cleanupOrphanJobs(), verify cleanup + unknown + stale lock recovery
    if (!fatalSetupFailure) {
      await runStep("restart-in-flight-cleanup-and-recovery", async () => {
        // Seed 100 MiB random incompressible file so upload runs long enough to catch in flight (well under 512m RustFS tmpfs).
        createdContainers.add(blobSeedContainerName);
        const blobRes = await docker([
          "run",
          "--name",
          blobSeedContainerName,
          "--network",
          "none",
          "--user",
          "33:33",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "sh",
          "-v",
          `${siteVolumeName}:/var/www/html`,
          WORDPRESS_IMAGE,
          "-c",
          "head -c 104857600 /dev/urandom > /var/www/html/blob-swarmtest.bin",
        ]);
        await docker(["rm", "-f", blobSeedContainerName]);
        createdContainers.delete(blobSeedContainerName);
        assert(blobRes.ok, "seed 100 MiB random blob into site volume", blobRes.stderr);

        const locksPrefix = `${goodTarget.prefix}/sites/${siteId}/locks/`;
        const waitForUploadInFlight = async (jobId) => {
          const catchDeadline = Date.now() + 30_000;
          while (Date.now() < catchDeadline) {
            const running = await dockerListNames("ps", `hp_bk_${jobId}_up`);
            if (running.includes(`hp_bk_${jobId}_up`)) {
              const locks = await s3ListAll(goodTarget, locksPrefix);
              if (locks.length > 0) {
                return true;
              }
            }
            await sleep(40);
          }
          return false;
        };

        const inFlightJobId = newJobId();
        runJobIds.push(inFlightJobId);
        await adapter.backups({
          action: "start",
          jobId: inFlightJobId,
          siteId,
          serviceInstanceId,
          target: goodTarget,
        });

        const caught1 = await waitForUploadInFlight(inFlightJobId);
        assert(caught1, "caught first upload container in flight with active restic lock", String(caught1));

        // Verify staging volume and secrets directory exist before restart cleanup (proving step 7 can fail).
        const volBefore = await dockerListNames("volume", `hp_bk_${inFlightJobId}`);
        assert(
          volBefore.includes(`hp_bk_${inFlightJobId}`),
          "staging volume exists while job runs",
          JSON.stringify(volBefore),
        );
        const secretDirPath = path.join(secretsRootDir, `job_bk_${inFlightJobId}`);
        const secretStat = await stat(secretDirPath).catch(() => null);
        assert(secretStat?.isDirectory() === true, "job secrets dir exists while job runs", String(secretStat));

        // Sample site and MariaDB containers while backup is in flight (for Step 8).
        const siteMid = await dockerInspectContainer(siteContainerName);
        const dbMid = await dockerInspectContainer(dbContainerName);
        inFlightSample = { site: siteMid, db: dbMid };

        // Simulate executor restart: new adapter with identical settings calling cleanupOrphanJobs().
        adapter2 = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));
        await adapter2.cleanupOrphanJobs();

        const containersAfter = await dockerListNames("ps", `hp_bk_${inFlightJobId}`);
        assert(
          containersAfter.length === 0,
          "in-flight job containers removed by cleanupOrphanJobs",
          JSON.stringify(containersAfter),
        );
        const volumesAfter = await dockerListNames("volume", `hp_bk_${inFlightJobId}`);
        assert(
          volumesAfter.length === 0,
          "staging volume removed by cleanupOrphanJobs",
          JSON.stringify(volumesAfter),
        );
        const secretExistsAfter = await access(secretDirPath)
          .then(() => true)
          .catch(() => false);
        assert(secretExistsAfter === false, "secrets directory removed by cleanupOrphanJobs", String(secretExistsAfter));

        const oldStatus = await adapter2.backups({ action: "status", jobId: inFlightJobId });
        assert(
          oldStatus.state === "unknown" && oldStatus.failure === null && oldStatus.snapshot === null,
          "status for old jobId answers unknown on restarted adapter",
          JSON.stringify(oldStatus),
        );

        // Also simulate a SIGKILLed upload container leaving a stale lock in S3 (SIGKILL prevents restic cleanup).
        const sigkillJobId = newJobId();
        runJobIds.push(sigkillJobId);
        await adapter2.backups({
          action: "start",
          jobId: sigkillJobId,
          siteId,
          serviceInstanceId,
          target: goodTarget,
        });
        const caught2 = await waitForUploadInFlight(sigkillJobId);
        assert(caught2, "caught second upload container in flight for SIGKILL lock test", String(caught2));
        const killRes = await docker(["kill", "-s", "KILL", `hp_bk_${sigkillJobId}_up`]);
        assert(killRes.ok, "SIGKILL upload container succeeds", killRes.stderr);

        // Poll until adapter2 settles sigkillJobId (cleanup of its containers/volume/secrets) while lock remains in S3.
        const sigkillSettled = await pollBackupJob(adapter2, sigkillJobId);
        assert(
          sigkillSettled.state === "failed" && sigkillSettled.failure === "other",
          "SIGKILLed job settles as failed/other",
          JSON.stringify(sigkillSettled),
        );

        const locksAfterSigkill = await s3ListAll(goodTarget, locksPrefix);
        assert(
          locksAfterSigkill.length > 0,
          "SIGKILLed job left stale lock in repository",
          JSON.stringify(locksAfterSigkill),
        );

        // Start a new backup on a fresh adapter3 for the same site; unlock --remove-all must clear the stale lock.
        const adapter3 = instrumentAdapter(new DockerEngineSocketAdapter(adapterOptions));
        await adapter3.cleanupOrphanJobs();
        const recoveryJobId = newJobId();
        runJobIds.push(recoveryJobId);
        await adapter3.backups({
          action: "start",
          jobId: recoveryJobId,
          siteId,
          serviceInstanceId,
          target: goodTarget,
        });
        const recoverySettled = await pollBackupJob(adapter3, recoveryJobId);
        assert(
          recoverySettled.state === "succeeded" && recoverySettled.snapshot !== null,
          "new backup succeeds despite stale lock from killed job",
          JSON.stringify(recoverySettled),
        );

        const locksAfterRecovery = await s3ListAll(goodTarget, locksPrefix);
        assert(
          locksAfterRecovery.length === 0,
          "stale lock removed by recovery backup",
          JSON.stringify(locksAfterRecovery),
        );
        adapter2 = adapter3;
      });
    }

    // 8. CP-01: site container and MariaDB never restarted or paused (in-flight + final)
    if (!fatalSetupFailure) {
      await runStep("cp01-site-and-db-untouched", async () => {
        assert(inFlightSample !== null, "in-flight sample was recorded", "null");
        assert(
          inFlightSample.site?.State?.Running === true &&
            inFlightSample.site?.State?.Paused === false &&
            inFlightSample.site?.Id === initialSiteInspect.Id &&
            inFlightSample.site?.State?.StartedAt === initialSiteInspect.State?.StartedAt &&
            inFlightSample.site?.RestartCount === initialSiteInspect.RestartCount,
          "site container running and untouched during backup",
          JSON.stringify(inFlightSample.site?.State ?? null),
        );

        const finalSite = await dockerInspectContainer(siteContainerName);
        const finalDb = await dockerInspectContainer(dbContainerName);
        assert(
          finalSite?.State?.Running === true &&
            finalSite?.State?.Paused === false &&
            finalSite?.Id === initialSiteInspect.Id &&
            finalSite?.State?.StartedAt === initialSiteInspect.State?.StartedAt &&
            finalSite?.RestartCount === initialSiteInspect.RestartCount &&
            (finalSite?.ExecIDs ?? []).length === 0,
          "site container untouched at end",
          JSON.stringify({
            idMatch: finalSite?.Id === initialSiteInspect.Id,
            startedAt: finalSite?.State?.StartedAt,
            restartCount: finalSite?.RestartCount,
            execIds: finalSite?.ExecIDs,
          }),
        );
        assert(
          finalDb?.State?.Running === true &&
            finalDb?.State?.Paused === false &&
            finalDb?.Id === initialDbInspect.Id &&
            finalDb?.State?.StartedAt === initialDbInspect.State?.StartedAt &&
            finalDb?.RestartCount === initialDbInspect.RestartCount,
          "MariaDB container untouched at end",
          JSON.stringify({
            idMatch: finalDb?.Id === initialDbInspect.Id,
            startedAt: finalDb?.State?.StartedAt,
            restartCount: finalDb?.RestartCount,
          }),
        );
      });
    }

    // 9. No secrets in container Env, Cmd, Entrypoint, Args, Labels, IPC results, errors, or stdout
    if (!fatalSetupFailure) {
      await runStep("no-secrets-in-containers-or-outputs", async () => {
        const secrets = [...secretsToGuard];
        assert(
          capturedContainerSpecs.length >= 10,
          "captured job container specs across run",
          String(capturedContainerSpecs.length),
        );

        const leaks = [];
        for (const rec of capturedContainerSpecs) {
          const surfaces = {
            containerName: rec.containerName,
            createPayload: rec.createPayload
              ? {
                  Env: rec.createPayload.Env ?? null,
                  Cmd: rec.createPayload.Cmd ?? null,
                  Entrypoint: rec.createPayload.Entrypoint ?? null,
                  Labels: rec.createPayload.Labels ?? null,
                }
              : null,
            inspect: rec.inspect
              ? {
                  Env: rec.inspect.Config?.Env ?? null,
                  Cmd: rec.inspect.Config?.Cmd ?? null,
                  Entrypoint: rec.inspect.Config?.Entrypoint ?? null,
                  Args: rec.inspect.Args ?? null,
                  Labels: rec.inspect.Config?.Labels ?? null,
                }
              : null,
          };
          const found = scanObjectForSecrets(surfaces, secrets);
          if (found.length > 0) {
            leaks.push({ container: rec.containerName, phase: rec.phase, count: found.length });
          }
        }
        assert(leaks.length === 0, "zero secrets in job container configs", JSON.stringify(leaks));

        for (const [label, list] of [
          ["results", capturedResultJsons],
          ["errors", capturedErrorMessages],
          ["stdout", capturedOutputLines],
        ]) {
          const joined = list.join("\n");
          for (const s of secrets) {
            assert(!joined.includes(s), `no secret in ${label}`, `found secret in ${label}`);
          }
        }

        const restoresDir = path.join(backupWorkDir, "restores");
        let restoreNoteFiles;
        try {
          restoreNoteFiles = (await readdir(restoresDir)).filter((name) => name.endsWith(".json")).sort();
        } catch {
          restoreNoteFiles = [];
        }
        assert(
          restoreNoteFiles.length >= 1,
          "at least one restore note file exists for secret scan",
          String(restoreNoteFiles.length),
        );
        for (const noteFile of restoreNoteFiles) {
          const rawNote = await readFile(path.join(restoresDir, noteFile), "utf8");
          for (const s of secrets) {
            assert(
              !rawNote.includes(s),
              `no secret in restore note ${noteFile}`,
              `found secret in ${noteFile}`,
            );
          }
        }

        // Negative control: prove the scanner catches a synthetic secret in Env.
        const syntheticHits = scanObjectForSecrets(
          { Env: [`LEAK=${s3SecretKey}`], Cmd: [], Entrypoint: [], Args: [], Labels: {} },
          secrets,
        );
        assert(
          syntheticHits.includes(s3SecretKey),
          "secret scanner detects synthetic leak",
          JSON.stringify(syntheticHits),
        );
      });
    }

    // 10. Hostile requests refused with VALIDATION_ERROR before any container is created
    if (!fatalSetupFailure) {
      await runStep("hostile-requests-refused", async () => {
        const targetAdapter = adapter2 ?? adapter;
        const createsBefore = containerCreateCount;
        const psBefore = await dockerListNames("ps", "hp_bk_");
        assert(psBefore.length === 0, "no hp_bk_ containers before hostile checks", JSON.stringify(psBefore));

        const hostileCases = [
          {
            label: "bad-site-id",
            req: {
              action: "start",
              jobId: newJobId(),
              siteId: "../bad-site",
              serviceInstanceId,
              target: goodTarget,
            },
          },
          {
            label: "dotdot-prefix",
            req: {
              action: "test",
              target: { ...goodTarget, prefix: "a/../b" },
            },
          },
          {
            label: "loopback-endpoint",
            req: {
              action: "test",
              target: { ...goodTarget, endpoint: "http://127.0.0.1:9000" },
            },
          },
          {
            label: "userinfo-endpoint",
            req: {
              action: "test",
              target: { ...goodTarget, endpoint: `http://user:pass@${s3Ip}:9000` },
            },
          },
          {
            label: "bad-job-id",
            req: {
              action: "status",
              jobId: "not-a-valid-job-id",
            },
          },
          {
            label: "restore-bad-job-id",
            req: {
              action: "restore",
              jobId: "bad job id!",
              siteId,
              serviceInstanceId,
              snapshotId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              databases: [],
              target: goodTarget,
            },
          },
          {
            label: "restore-job-id-with-restore-suffix",
            req: {
              action: "restore",
              jobId: `${newJobId()}-restore`,
              siteId,
              serviceInstanceId,
              snapshotId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              databases: [],
              target: goodTarget,
            },
          },
          {
            label: "archive-job-id-with-archive-suffix",
            req: {
              action: "archive",
              jobId: `${newJobId()}-archive`,
              siteId,
              serviceInstanceId,
              snapshotId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              databases: [],
              target: goodTarget,
            },
          },
          {
            label: "restore-bad-snapshot-id",
            req: {
              action: "restore",
              jobId: newJobId(),
              siteId,
              serviceInstanceId,
              snapshotId: "../../etc/passwd",
              databases: [],
              target: goodTarget,
            },
          },
          {
            label: "restore-extra-unknown-key",
            req: {
              action: "restore",
              jobId: newJobId(),
              siteId,
              serviceInstanceId,
              snapshotId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              databases: [],
              target: goodTarget,
              unexpectedField: "nope",
            },
          },
          {
            label: "readArchive-negative-offset",
            req: {
              action: "readArchive",
              jobId: newJobId(),
              offset: -1,
              length: 1024,
            },
          },
          {
            label: "readArchive-length-over-512KiB",
            req: {
              action: "readArchive",
              jobId: newJobId(),
              offset: 0,
              length: 524289,
            },
          },
          {
            label: "discardArchive-bad-job-id",
            req: {
              action: "discardArchive",
              jobId: "invalid/job",
            },
          },
          {
            label: "settle-extra-unknown-key",
            req: {
              action: "settle",
              extra: true,
            },
          },
        ];

        for (const hc of hostileCases) {
          let caught = null;
          try {
            await targetAdapter.backups(hc.req);
          } catch (err) {
            caught = err;
          }
          assert(
            caught instanceof ExecutorCodedError && caught.code === "VALIDATION_ERROR",
            `${hc.label} throws VALIDATION_ERROR`,
            caught === null ? "resolved without error" : formatErr(caught),
          );
        }

        assert(
          containerCreateCount === createsBefore,
          "zero container create calls on hostile requests",
          `${String(createsBefore)} -> ${String(containerCreateCount)}`,
        );
        const psAfter = await dockerListNames("ps", "hp_bk_");
        assert(psAfter.length === 0, "no hp_bk_ containers created", JSON.stringify(psAfter));
      });
    }
  } finally {
    await cleanup();
  }

  // 11. Clean-up verification AFTER finally
  await runStep("cleanup", async () => {
    const swarmContainers = await dockerListNames("ps", runId);
    const bkContainers = await dockerListNames("ps", "hp_bk_");
    const swarmVolumes = await dockerListNames("volume", runId);
    const siteVols = await dockerListNames("volume", siteVolumeName);
    const bkVolumes = await dockerListNames("volume", "hp_bk_");
    const swarmNetworks = await dockerListNames("network", runId);

    const tmpExists =
      tmpRoot === ""
        ? false
        : await access(tmpRoot)
            .then(() => true)
            .catch(() => false);

    assert(swarmContainers.length === 0, "no hp_swarmtest_ containers left", JSON.stringify(swarmContainers));
    assert(bkContainers.length === 0, "no hp_bk_ containers left", JSON.stringify(bkContainers));
    assert(
      swarmVolumes.length === 0 && siteVols.length === 0,
      "no swarmtest volumes left",
      JSON.stringify([...swarmVolumes, ...siteVols]),
    );
    assert(bkVolumes.length === 0, "no hp_bk_ volumes left", JSON.stringify(bkVolumes));
    assert(swarmNetworks.length === 0, "no swarmtest network left", JSON.stringify(swarmNetworks));
    assert(tmpExists === false, "temporary folder under /dev/shm removed", tmpRoot);
  });

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`\naccept-m3-backups: ${String(passed)}/${String(total)} passed in ${elapsedSec}s`);
  if (passed !== total) {
    process.exitCode = 1;
  }
}

await main();
