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

import { execFile as execFileCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const {
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  SHARED_DB_ALIAS,
  buildAwsSharedCredentials,
  buildSharedDatabaseContainerPayload,
  getManagedVolumeName,
  mariadbRootExec,
  s3Request,
} = await import(pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href);

const {
  DEFAULT_PHP_VERSION,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  resolveWordpressImage,
  siteDatabaseFullName,
  siteDatabasePrefix,
} = await import(pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href);

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

const siteId = `site_swarmtest_${runHex}`;
const serviceInstanceId = `svc_swarmtest_${runHex}`;
const siteVolumeName = getManagedVolumeName(serviceInstanceId, "html");
const dbPrefix = siteDatabasePrefix(siteId);
const db1Name = dbPrefix;
const db2Name = siteDatabaseFullName(dbPrefix, "shop");

const uidGid = `${String(process.getuid())}:${String(process.getgid())}`;

const createdContainers = new Set();
const createdVolumes = new Set();
const tempDirs = [];
let createdNetwork = false;

const secretsToGuard = new Set();
const capturedContainerSpecs = [];
const capturedResultJsons = [];
const capturedErrorMessages = [];
const capturedOutputLines = [];
let containerCreateCount = 0;

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
    const leftoverBkContainers = await dockerListNames("ps", "hp_bk_").catch(() => []);
    const containers = new Set([
      ...createdContainers,
      ...leftoverBkContainers,
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
    const volumes = new Set([...createdVolumes, ...leftoverBkVolumes, siteVolumeName]);
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
  let backupKeyFile = "";
  let wrongBackupKeyFile = "";
  let missingBackupKeyFile = "";
  let verifySecretsDir = "";
  let sharedDbRootKeyFile = "";
  let adapter = null;
  let adapter2 = null;
  let adapterOptions = null;

  let chosenSubnet = "";
  let s3Ip = "";
  let goodTarget = null;
  let listOnlyTarget = null;

  const s3AccessKey = `ak_${randomBytes(12).toString("hex")}`;
  const s3SecretKey = `hpSw#rm;T3st+/=${randomBytes(12).toString("hex")}`;
  const listOnlyKey = `lk_${randomBytes(12).toString("hex")}`;
  const listOnlySecret = `ls_${randomBytes(20).toString("hex")}`;
  const backupKey = randomBytes(32).toString("hex");
  const wrongBackupKey = randomBytes(32).toString("hex");
  const mariaRootPw = randomBytes(32).toString("hex");

  for (const s of [
    s3AccessKey,
    s3SecretKey,
    listOnlyKey,
    listOnlySecret,
    backupKey,
    wrongBackupKey,
    mariaRootPw,
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
        const mariadbDataDir = path.join(tmpRoot, "mariadb-data");
        const sftpStateDir = path.join(tmpRoot, "sftp");
        const ingressRootDir = path.join(tmpRoot, "ingress");
        const siteFilesDir = path.join(tmpRoot, "site-files");
        const siteMailDir = path.join(tmpRoot, "site-mail");
        const phpMyAdminConfigDir = path.join(tmpRoot, "phpmyadmin");
        verifySecretsDir = path.join(tmpRoot, "verify-secrets");

        for (const dir of [
          secretsRootDir,
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

        await writeFile(backupKeyFile, backupKey, { mode: 0o400 });
        await writeFile(wrongBackupKeyFile, wrongBackupKey, { mode: 0o400 });
        await writeFile(sharedDbRootKeyFile, mariaRootPw, { mode: 0o400 });

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

        // Create site tmpfs volume (192m, uid 33:33) and stand-in WordPress site container.
        const volCreate = await docker([
          "volume",
          "create",
          "--driver",
          "local",
          "--opt",
          "type=tmpfs",
          "--opt",
          "device=tmpfs",
          "--opt",
          "o=size=192m,uid=33,gid=33,mode=0755",
          "--label",
          `io.hostingpanel.site_id=${siteId}`,
          siteVolumeName,
        ]);
        assert(volCreate.ok, `site tmpfs volume ${siteVolumeName} created`, volCreate.stderr);
        createdVolumes.add(siteVolumeName);

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
          "sleep",
          "--label",
          `io.hostingpanel.service_instance_id=${serviceInstanceId}`,
          "--label",
          `io.hostingpanel.site_id=${siteId}`,
          "-v",
          `${siteVolumeName}:/var/www/html`,
          WORDPRESS_IMAGE,
          "infinity",
        ]);
        assert(siteRun.ok, "stand-in WordPress site container starts", siteRun.stderr);
        createdContainers.add(siteContainerName);

        createdContainers.add(seedContainerName);
        const seedRes = await docker([
          "run",
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
          "sh",
          "-v",
          `${siteVolumeName}:/var/www/html`,
          WORDPRESS_IMAGE,
          "-c",
          `set -eu; mkdir -p /var/www/html/wp-content/uploads; printf '<?php // wp\\n' > /var/www/html/index.php; printf '%s\\n' '${fileMarkerText}' > /var/www/html/${markerFileName}`,
        ]);
        await docker(["rm", "-f", seedContainerName]);
        createdContainers.delete(seedContainerName);
        assert(seedRes.ok, "seed marker file into site volume", seedRes.stderr);

        adapterOptions = {
          pullMissingImages: false,
          secretsRootDir,
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

        // Provision two site databases (primary + custom) and seed marker rows in both.
        const runSql = mariadbRootExec(
          { request: dockerRequest, socketPath: SOCKET_PATH, apiPrefix: "" },
          dbContainerName,
        );
        const r1 = await runSql(
          `CREATE DATABASE \`${db1Name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        );
        assert(r1.exitCode === 0, `create primary DB ${db1Name}`, r1.stderr.toString("utf8"));

        await adapter.siteDatabases({ siteId, op: "createDatabase", database: db2Name });

        const rSeed1 = await runSql(
          `CREATE TABLE \`${db1Name}\`.hp_marker (id INT PRIMARY KEY, note VARCHAR(255)); INSERT INTO \`${db1Name}\`.hp_marker VALUES (1, '${db1MarkerText}');`,
        );
        assert(rSeed1.exitCode === 0, `seed marker row in ${db1Name}`, rSeed1.stderr.toString("utf8"));

        const rSeed2 = await runSql(
          `CREATE TABLE \`${db2Name}\`.hp_marker (id INT PRIMARY KEY, note VARCHAR(255)); INSERT INTO \`${db2Name}\`.hp_marker VALUES (1, '${db2MarkerText}');`,
        );
        assert(rSeed2.exitCode === 0, `seed marker row in ${db2Name}`, rSeed2.stderr.toString("utf8"));

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
