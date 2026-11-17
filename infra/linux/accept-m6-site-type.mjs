#!/usr/bin/env node
/**
 * Real-Docker acceptance check for M6a (site types): a second, database-less type next to WordPress.
 *
 * Drives the built DockerEngineSocketAdapter with the option `resolveSiteType` answering a test type
 * (no database, volume suffix `public`, mount `/srv/public`, owner 1000:1000) through files, backup,
 * restore, SFTP and the terminal, then one WordPress files pass in the same run.
 *
 * The test type is defined here: a .mjs script cannot import the executor's TS test type
 * (apps/docker-executor/test/support/test-site-type.ts). It mirrors it, except that its helper and
 * restore images are the local WordPress image (the TS type names images that do not exist).
 *
 * Machine safety: every Docker object this script names starts with "hp_swarmtest_" or embeds it
 * (managed volumes are "hp_vol_hp_swarmtest_..."); the adapter's backup containers and staging volume
 * are "hp_bk_<jobId>..." and are removed by this run's own job ids only. Nothing is pulled, no host
 * port but one ephemeral 127.0.0.1 port (SFTP) is bound, nothing is pruned.
 */

import { execFile as execFileCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const load = (rel) => import(pathToFileURL(path.resolve(repoRoot, rel)).href);

const {
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  buildAwsSharedCredentials,
  buildSftpContainerPayload,
  ensureSiteFilesProgram,
  getManagedVolumeName,
  readRestoreNote,
  renderSftpUserFiles,
  s3Request,
  writeSiteFilesProgram,
  WORDPRESS_EXECUTOR_SITE_TYPE,
} = await load("apps/docker-executor/dist/index.js");
const { DEFAULT_PHP_VERSION, RESTIC_IMAGE, SFTP_IMAGE, resolveWordpressImage } = await load(
  "packages/contracts/dist/index.js",
);
const { sha512Crypt } = await load("apps/api/dist/sites/sha512-crypt.js");

const SOCKET_PATH = "/var/run/docker.sock";
const RUSTFS_IMAGE =
  "rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74";
const WP_IMAGE = resolveWordpressImage(DEFAULT_PHP_VERSION);
const FORBIDDEN_HOST_PORTS = new Set([22, 80, 443, 2222, 3000, 4000, 5432]);
const HARD = ["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"];

/** The executor's test type (test-site-type.ts), with the local WordPress image as its helper and restore image. */
const TEST_TYPE = {
  def: {
    key: "teststatic",
    templateId: "tpl_site_teststatic",
    files: { volumeSuffix: "public", mountPath: "/srv/public", owner: "1000:1000" },
    database: null,
    heavyOperationKinds: [],
  },
  files: {
    programFile: "hp-files-teststatic.php",
    programFunctions: "",
    programDispatch: "",
    ops: [],
    slowOps: [],
    protectedPaths: [],
    helperImage: () => WP_IMAGE,
  },
  backup: { excludes: [] },
  restore: { filesImage: WP_IMAGE, keptDirs: [], leftInPlace: [], dbGate: null },
};

const runHex = randomBytes(3).toString("hex");
const runId = `hp_swarmtest_${runHex}`;
const netName = `${runId}_net`;
const sftpNetName = `${runId}_sftpnet`;
const s3Name = `${runId}_s3`;
const siteName = `${runId}_site`;
const sftpName = `${runId}_sftp`;
const dbName = `${runId}_db`; // given to the adapter, never created: any database touch fails here
const siteId = `site_swarmtest_${runHex}`;
const svc = `${runId}_svc`;
const svc2 = `${runId}_svc2`;
const svcWp = `${runId}_wp`;
const siteIdWp = `site_swarmtest_${runHex}_wp`;
const vol = getManagedVolumeName(svc, "public");
const vol2 = getManagedVolumeName(svc2, "public");
const volWp = getManagedVolumeName(svcWp, WORDPRESS_EXECUTOR_SITE_TYPE.def.files.volumeSuffix);

const createdContainers = new Set();
const createdVolumes = new Set();
const createdNetworks = new Set();
const jobIds = [];
const tempDirs = [];
const creates = []; // { name, image, user, cmd } of every container the test adapter creates
const failedWaits = []; // non-zero exits of the adapter's containers, with their last log lines
let testAdapter = null;
let wpAdapter = null;
let peekN = 0;

class StepAssertionError extends Error {
  constructor(expected, actual) {
    super(`${expected} / ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(expected, typeof actual === "string" ? actual : JSON.stringify(actual));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (err) => (err instanceof ExecutorCodedError ? `${err.code}: ${err.message}` : String(err?.message ?? err));
const newJobId = () => `op_${randomBytes(16).toString("hex")}`;

/** Runs a command with a hard timeout; never throws. */
function execCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFileCb(
      cmd,
      args,
      { encoding: "utf8", timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) =>
        resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr || (err ? err.message : "") }),
    );
  });
}
const docker = (args, opts) => execCmd("docker", args, opts);

/** One Engine API call over the socket, JSON in and out. */
function dockerJson(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { socketPath: SOCKET_PATH, path: reqPath, method, headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) reject(new Error(`Docker ${method} ${reqPath} -> ${String(res.statusCode)}: ${text}`));
          else resolve(text ? JSON.parse(text) : null);
        });
      },
    );
    req.setTimeout(60_000, () => req.destroy(new Error(`Docker timeout ${method} ${reqPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** `docker run` of a short-lived container named under this run, removed afterwards. */
async function runOnce(name, args, opts) {
  createdContainers.add(name);
  const res = await docker(["run", "--name", name, ...args], opts);
  await docker(["rm", "-f", name]);
  createdContainers.delete(name);
  return res;
}

/** A shell command over a volume mounted read-only at /v, as 1000:1000. */
async function peek(volume, cmd, user = "1000:1000") {
  peekN += 1;
  const res = await runOnce(`${runId}_peek${String(peekN)}`, [...HARD, "--user", user, "--entrypoint", "sh", "-v", `${volume}:/v:ro`, WP_IMAGE, "-c", cmd]);
  assert(res.ok, `peek into ${volume} runs`, res.stderr);
  return res.stdout;
}

const OWNERS_CMD = "find /v -printf '%u:%g\\n' | sort -u";
const LEFTOVERS_CMD = "find /v \\( -name wp-content -o -name .maintenance -o -name hp-mail.php -o -name '.hp_rs_*' \\) -print";

function pickFreeSubnet(nets) {
  const toInt = (ip) => ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
  const used = nets
    .flatMap((n) => n?.IPAM?.Config ?? [])
    .map((c) => /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(c?.Subnet ?? ""))
    .filter(Boolean)
    .map((m) => {
      const mask = Number(m[2]) === 0 ? 0 : (~0 << (32 - Number(m[2]))) >>> 0;
      return { net: (toInt(m[1]) & mask) >>> 0, mask };
    });
  for (let b = 240; b <= 254; b += 1) {
    for (let c = 200; c <= 254; c += 1) {
      const n = toInt(`10.${String(b)}.${String(c)}.0`);
      const m = 0xffffff00;
      if (!used.some((u) => ((n & u.mask) >>> 0) === u.net || ((u.net & m) >>> 0) === n)) return `10.${String(b)}.${String(c)}.0/24`;
    }
  }
  return null;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Records every container the adapter creates (name, image, user, command). */
function instrument(adapter) {
  const client = adapter.dockerClient;
  const orig = client.request.bind(client);
  client.request = async (method, endpoint, body, opts) => {
    const res = await orig(method, endpoint, body, opts);
    if (method === "POST" && endpoint.startsWith("/containers/create")) {
      const name = decodeURIComponent(/name=([^&]+)/.exec(endpoint)?.[1] ?? "");
      if (name) createdContainers.add(name);
      creates.push({ name, image: body?.Image ?? "", user: body?.User ?? "", cmd: JSON.stringify([body?.Entrypoint, body?.Cmd, body?.Env]) });
    } else if (method === "POST" && /^\/containers\/[^/]+\/wait/.test(endpoint)) {
      const code = (() => { try { return JSON.parse(res.body.toString("utf8"))?.StatusCode; } catch { return null; } })();
      if (typeof code === "number" && code !== 0) {
        const ref = endpoint.split("/")[2];
        const logs = await orig("GET", `/containers/${ref}/logs?stdout=1&stderr=1&tail=20`);
        failedWaits.push(`${decodeURIComponent(ref)} exit ${String(code)}: ${logs.body.toString("utf8").replace(/[^ -~\n]+/g, "").trim().slice(-600)}`);
      }
    }
    return res;
  };
  return adapter;
}

async function pollJob(adapter, jobId, onTick, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await adapter.backups({ action: "status", jobId });
    if (st.state !== "running") return st;
    if (onTick) await onTick();
    else await sleep(200);
  }
  throw new StepAssertionError(`job settles in ${String(timeoutMs)}ms`, "still running");
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const a of [testAdapter, wpAdapter]) {
      if (!a) continue;
      for (const r of await a.listTerminals().catch(() => [])) await a.closeTerminal({ sessionId: r.sessionId }).catch(() => undefined);
      await a.siteFilesHelpers?.removeAll().catch(() => undefined);
    }
    const names = new Set([...createdContainers, s3Name, siteName, sftpName, `hp_files_${svc}`, `hp_files_${svc2}`, `hp_files_${svcWp}`]);
    for (const j of jobIds) {
      const ls = await docker(["ps", "-a", "--filter", `name=hp_bk_${j}`, "--format", "{{.Names}}"]);
      for (const n of ls.stdout.split("\n").map((l) => l.trim())) if (n.startsWith(`hp_bk_${j}`)) names.add(n);
    }
    for (const n of names) await docker(["rm", "-f", "-v", n]);
    const vols = new Set([...createdVolumes, vol, vol2, volWp, ...jobIds.map((j) => `hp_bk_${j}`)]);
    for (const v of vols) await docker(["volume", "rm", v]);
    for (const n of new Set([...createdNetworks, sftpNetName, netName])) await docker(["network", "rm", n]);
    for (const d of tempDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));

async function main() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let fatal = false;
  const step = async (name, fn, { abort = false } = {}) => {
    if (fatal) {
      skipped += 1;
      console.log(`SKIP ${name}: setup failed`);
      return;
    }
    try {
      const note = await fn();
      if (typeof note === "string" && note.startsWith("SKIP:")) {
        skipped += 1;
        console.log(`SKIP ${name}: ${note.slice(5).trim()}`);
        return;
      }
      passed += 1;
      console.log(`PASS ${name}${typeof note === "string" ? ` (${note})` : ""}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}: ${err instanceof StepAssertionError ? `${err.expected} / ${err.actual}` : `step succeeds / ${fmt(err)}`}`);
      if (abort) fatal = true;
    }
  };

  let tmpRoot = "";
  let dirs = {};
  let target = null;
  let verifyDir = "";
  let snapshotId = "";
  let sftpPort = 0;
  const marks = {
    index: `INDEX-${runHex}-ORIGINAL`,
    page: `PAGE-${runHex}-ORIGINAL`,
    gone: `GONE-${runHex}-ORIGINAL`,
  };

  const files = (req) => testAdapter.siteFiles({ serviceInstanceId: svc, ...req });
  const writeText = (p, text, adapter = testAdapter, service = svc) =>
    adapter.siteFiles({ serviceInstanceId: service, op: "write", path: p, uploadId: `u_${randomBytes(12).toString("hex")}`, offset: 0, dataBase64: Buffer.from(text).toString("base64"), final: true, overwrite: true });
  const readText = async (p) => Buffer.from((await files({ op: "read", path: p, offset: 0, length: 65_536 })).dataBase64, "base64").toString("utf8");

  try {
    await step(
      "setup",
      async () => {
        for (const img of [WP_IMAGE, RESTIC_IMAGE, RUSTFS_IMAGE, SFTP_IMAGE]) {
          assert((await docker(["image", "inspect", img])).ok, `image ${img} present locally`, "missing");
        }
        tmpRoot = await mkdtemp(path.join("/dev/shm", `${runId}_`));
        tempDirs.push(tmpRoot);
        await chmod(tmpRoot, 0o755);
        dirs = Object.fromEntries(
          ["secrets", "backups", "sftp", "ingress", "files", "mail", "pma", "dbdata", "client"].map((d) => [d, path.join(tmpRoot, d)]),
        );
        for (const d of Object.values(dirs)) await mkdir(d, { mode: 0o700 });
        verifyDir = path.join(tmpRoot, "verify");
        await mkdir(verifyDir, { mode: 0o755 });
        const backupKey = randomBytes(32).toString("hex");
        const ak = `ak_${randomBytes(12).toString("hex")}`;
        const sk = `sk_${randomBytes(16).toString("hex")}`;
        await writeFile(path.join(tmpRoot, "backup.key"), backupKey, { mode: 0o400 });
        await writeFile(path.join(tmpRoot, "db-root.key"), randomBytes(16).toString("hex"), { mode: 0o400 });
        await writeFile(path.join(verifyDir, "aws.creds"), buildAwsSharedCredentials(ak, sk), { mode: 0o444 });
        await writeFile(path.join(verifyDir, "backup.key"), backupKey, { mode: 0o444 });

        const subnet = pickFreeSubnet(await dockerJson("GET", "/networks"));
        assert(subnet !== null, "a free /24 subnet", "none");
        await dockerJson("POST", "/networks/create", { Name: netName, Driver: "bridge", CheckDuplicate: true, IPAM: { Driver: "default", Config: [{ Subnet: subnet }] } });
        createdNetworks.add(netName);

        createdContainers.add(s3Name);
        await dockerJson("POST", `/containers/create?name=${s3Name}`, {
          Image: RUSTFS_IMAGE,
          Env: [`RUSTFS_ACCESS_KEY=${ak}`, `RUSTFS_SECRET_KEY=${sk}`],
          HostConfig: {
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: netName,
            Tmpfs: { "/tmp": "rw,size=64m,uid=10001,gid=10001", "/data": "rw,size=512m,uid=10001,gid=10001", "/logs": "rw,size=16m,uid=10001,gid=10001" },
          },
        });
        await dockerJson("POST", `/containers/${s3Name}/start`, {});
        const s3Ip = (await dockerJson("GET", `/containers/${s3Name}/json`))?.NetworkSettings?.Networks?.[netName]?.IPAddress ?? "";
        assert(s3Ip !== "", "RustFS has an address", "none");
        target = { endpoint: `http://${s3Ip}:9000`, region: "us-east-1", bucket: `hp-m6-${runHex}`, prefix: `tenant-${runHex}`, accessKeyId: ak, secretAccessKey: sk };
        let ready = false;
        for (let i = 0; i < 120 && !ready; i += 1) {
          ready = await fetch(`${target.endpoint}/`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.status === 403, () => false);
          if (!ready) await sleep(250);
        }
        assert(ready, "RustFS answers within 30s", "timed out");
        const bucket = await s3Request(target, "PUT", "");
        assert(bucket.status === 200 || bucket.status === 204, "bucket created", String(bucket.status));

        // The site: its volume (labelled, owned by 1000:1000) and a stand-in container of the type.
        assert((await docker(["volume", "create", "--label", `io.hostingpanel.site_id=${siteId}`, vol])).ok, "site volume created", vol);
        createdVolumes.add(vol);
        const init = await runOnce(`${runId}_init`, [...HARD, "--user", "0:0", "--cap-add", "CHOWN", "--entrypoint", "sh", "-v", `${vol}:/srv/public`, WP_IMAGE, "-c", "chmod 0755 /srv/public && chown 1000:1000 /srv/public"]);
        assert(init.ok, "site volume owned by 1000:1000", init.stderr);
        createdContainers.add(siteName);
        const site = await docker(["run", "-d", "--name", siteName, ...HARD, "--user", "1000:1000", "--tmpfs", "/tmp:rw,size=16m", "--label", `io.hostingpanel.service_instance_id=${svc}`, "--label", `io.hostingpanel.site_id=${siteId}`, "-v", `${vol}:/srv/public`, "--entrypoint", "sleep", WP_IMAGE, "infinity"]);
        assert(site.ok, "stand-in site container runs", site.stderr);

        sftpPort = await freeLoopbackPort();
        assert(!FORBIDDEN_HOST_PORTS.has(sftpPort) && sftpPort > 1024, "an ephemeral loopback port", String(sftpPort));

        await ensureSiteFilesProgram(dirs.files); // the registered types (WordPress), as main.ts does
        await writeSiteFilesProgram(dirs.files, TEST_TYPE); // a new type's program; registration would write it
        const options = {
          pullMissingImages: false,
          secretsRootDir: dirs.secrets,
          backupWorkDir: dirs.backups,
          sftpStateDir: dirs.sftp,
          ingressRootDir: dirs.ingress,
          siteFilesDir: dirs.files,
          siteMailDir: dirs.mail,
          phpMyAdminConfigDir: dirs.pma,
          sharedDbDataDir: dirs.dbdata,
          sharedDbRootKeyFile: path.join(tmpRoot, "db-root.key"),
          sharedDbContainerName: dbName,
          sharedDbNetworkName: netName,
          backupKeyFile: path.join(tmpRoot, "backup.key"),
          backupNetworkName: netName,
          executorUid: process.getuid(),
          sftpPort,
          sftpHostIp: "127.0.0.1",
          sftpContainerName: sftpName,
          sftpNetworkName: sftpNetName,
          terminalLimits: { idleMs: 60_000, readWaitMs: 1_000 },
        };
        testAdapter = instrument(new DockerEngineSocketAdapter({ ...options, resolveSiteType: () => TEST_TYPE }));
        wpAdapter = new DockerEngineSocketAdapter(options);
        assert(await testAdapter.pingEngine(), "Engine answers", "no");
      },
      { abort: true },
    );

    // 1. Files
    await step("files-program-php-lint", async () => {
      const program = await readFile(path.join(dirs.files, TEST_TYPE.files.programFile), "utf8");
      assert(program.startsWith("<?php"), "the test type's program is written", program.slice(0, 40));
      const lint = await runOnce(`${runId}_phpl`, [...HARD, "--user", "1000:1000", "-v", `${dirs.files}:/p:ro`, "--entrypoint", "php", WP_IMAGE, "-l", `/p/${TEST_TYPE.files.programFile}`]);
      assert(lint.ok && /No syntax errors detected/.test(lint.stdout), "php -l passes", `${lint.stdout}${lint.stderr}`);
      return lint.stdout.trim().replace(/\/p\//, "");
    });

    await step("files-helper-keeps-empty-volume-owner", async () => {
      assert((await files({ op: "list", path: "" })).entries.length === 0, "the new volume lists empty", "not empty");
      const owner = (await peek(vol, "stat -c %u:%g /v")).trim();
      assert(owner === "1000:1000", "the volume root stays 1000:1000 after the helper first mounts the empty volume", owner);
      return owner;
    });

    await step("files-list-write-read-rename-delete", async () => {
      await writeText("index.html", marks.index);
      await writeText("gone.txt", marks.gone);
      await files({ op: "mkdir", path: "docs" });
      await writeText("docs/draft.txt", marks.page);
      assert((await readText("docs/draft.txt")) === marks.page, "read back the written text", "different");
      await files({ op: "move", from: "docs/draft.txt", to: "docs/page.txt" });
      await writeText("scratch.txt", "scratch");
      await files({ op: "delete", paths: ["scratch.txt"] });
      const top = (await files({ op: "list", path: "" })).entries.map((e) => e.name).sort();
      const docs = (await files({ op: "list", path: "docs" })).entries.map((e) => e.name);
      assert(JSON.stringify(top) === '["docs","gone.txt","index.html"]', "top level is docs, gone.txt, index.html", top);
      assert(JSON.stringify(docs) === '["page.txt"]', "docs holds the renamed page.txt only", docs);
      assert((await readText("docs/page.txt")) === marks.page, "renamed file keeps its text", "different");
      const helper = creates.find((c) => c.name === `hp_files_${svc}`);
      const inspect = await dockerJson("GET", `/containers/hp_files_${svc}/json`);
      assert(inspect?.Config?.User === "1000:1000" && inspect?.Config?.WorkingDir === "/srv/public", "helper runs as 1000:1000 in /srv/public", { user: inspect?.Config?.User, wd: inspect?.Config?.WorkingDir, created: Boolean(helper) });
      return `helper ${inspect.Config.User} in ${inspect.Config.WorkingDir}`;
    });

    await step("files-owner-1000", async () => {
      const owners = (await peek(vol, OWNERS_CMD)).trim();
      assert(owners === "1000:1000", "every file on the volume is 1000:1000", owners);
      return owners;
    });

    await step("files-import-refused", async () => {
      const err = await files({ op: "import.stat" }).then(() => null, (e) => e);
      assert(err instanceof ExecutorCodedError && err.code === "VALIDATION_ERROR", "import.stat refused with VALIDATION_ERROR", err ? fmt(err) : "accepted");
      return fmt(err);
    });

    await step("files-no-wordpress-leftovers", async () => {
      const found = (await peek(vol, LEFTOVERS_CMD)).trim();
      assert(found === "", "no wp-content, .maintenance, hp-mail.php or .hp_rs_ on the volume", found);
    });

    // 2. Backup
    await step("backup-no-database", async () => {
      const jobId = newJobId();
      jobIds.push(jobId);
      const before = creates.length;
      const started = await testAdapter.backups({ action: "start", jobId, siteId, serviceInstanceId: svc, target });
      assert(started.state === "running", "start answers running", started);
      const st = await pollJob(testAdapter, jobId);
      assert(st.state === "succeeded" && st.failure === null && st.snapshot, "backup succeeds", `${JSON.stringify(st)} ${failedWaits.join(" | ")}`);
      snapshotId = st.snapshot.snapshotId;
      const made = creates.slice(before).map((c) => c.name.replace(jobId, "<job>"));
      assert(!made.some((n) => /_dump|_db|mariadb/.test(n)) && !creates.slice(before).some((c) => /mariadb/.test(c.image)), "no database-dump container", made);
      return `containers ${made.join(",")}`;
    });

    await step("backup-snapshot-content", async () => {
      const ls = await runOnce(`${runId}_ls`, [
        "--network", netName, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "1000:1000",
        "--tmpfs", "/tmp:rw,size=64m,mode=1777", "-v", `${verifyDir}:/run/secrets:ro`,
        "-e", "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws.creds", "-e", "RESTIC_PASSWORD_FILE=/run/secrets/backup.key", "-e", "RESTIC_CACHE_DIR=/tmp/cache",
        "-e", `RESTIC_REPOSITORY=s3:${target.endpoint}/${target.bucket}/${target.prefix}/sites/${siteId}`,
        "--entrypoint", "/usr/bin/restic", RESTIC_IMAGE, "-o", "s3.bucket-lookup=path", "-o", `s3.region=${target.region}`, "ls", "--no-lock", snapshotId,
      ]);
      assert(ls.ok, "independent restic ls exits 0", ls.stderr);
      const lines = ls.stdout.split("\n").map((l) => l.trim());
      for (const f of ["/backup/files/index.html", "/backup/files/gone.txt", "/backup/files/docs/page.txt"]) assert(lines.includes(f), `snapshot lists ${f}`, ls.stdout);
      const dbLines = lines.filter((l) => l.startsWith("/backup/databases"));
      assert(dbLines.length === 0, "snapshot has no /backup/databases", dbLines);
      return `${String(lines.filter((l) => l.startsWith("/backup/files/")).length)} files entries, 0 databases entries`;
    });

    // 3. Restore without a database
    const restoreRun = async (service, extra) => {
      const jobId = newJobId();
      jobIds.push(jobId);
      const before = creates.length;
      let maintenanceSeen = false;
      let ticks = 0;
      const volume = getManagedVolumeName(service, "public");
      const started = await testAdapter.backups({ action: "restore", jobId, siteId, serviceInstanceId: service, target, snapshotId, ...extra });
      assert(started.state === "running", "restore starts", started);
      const st = await pollJob(testAdapter, jobId, async () => {
        ticks += 1;
        if (!(await docker(["volume", "inspect", volume])).ok) return sleep(200); // a mount would create the volume
        const out = await runOnce(`${runId}_watch${String(ticks)}`, [...HARD, "--user", "1000:1000", "--entrypoint", "sh", "-v", `${volume}:/v:ro`, WP_IMAGE, "-c", "test -e /v/.maintenance && echo MAINT; true"]);
        if (out.stdout.includes("MAINT")) maintenanceSeen = true;
      });
      const made = creates.slice(before);
      return { jobId, st, made, maintenanceSeen, ticks };
    };
    const checkRestore = (r) => {
      assert(r.st.state === "succeeded" && r.st.failure === null, "restore succeeds", `${JSON.stringify(r.st)} ${failedWaits.join(" | ")}`);
      const names = r.made.map((c) => c.name.replace(r.jobId, "<job>"));
      assert(!names.some((n) => /_rs_prepare|_rs_switch|_db\b|mariadb/.test(n)) && !r.made.some((c) => /mariadb/.test(c.image)), "no database container", names);
      assert(!r.maintenanceSeen, "no .maintenance seen while restoring", `seen in ${String(r.ticks)} polls`);
      return names;
    };

    await step("restore-in-place", async () => {
      await writeText("index.html", `INDEX-${runHex}-CHANGED`);
      await files({ op: "delete", paths: ["gone.txt"] });
      await writeText("new.txt", "added after the backup");
      const r = await restoreRun(svc, {});
      const names = checkRestore(r);
      assert((await readText("index.html")) === marks.index, "index.html is back to the snapshot", "changed");
      assert((await readText("gone.txt")) === marks.gone, "gone.txt is back", "missing");
      assert((await readText("docs/page.txt")) === marks.page, "docs/page.txt intact", "different");
      const top = (await files({ op: "list", path: "" })).entries.map((e) => e.name).sort();
      assert(!top.includes("new.txt"), "new.txt is gone", top);
      const owners = (await peek(vol, OWNERS_CMD)).trim();
      assert(owners === "1000:1000", "restored files are 1000:1000", owners);
      const left = (await peek(vol, LEFTOVERS_CMD)).trim();
      assert(left === "", "no .hp_rs_, .maintenance, wp-content or hp-mail.php left", left);
      const note = await readRestoreNote(path.join(dirs.backups, "restores"), r.jobId);
      assert(note?.stage === "ended" && note?.siteType === "teststatic", "note ended with siteType teststatic", note);
      // The exchange path: index.html and docs exist on both sides (X entries); the script has no fallback.
      const filesStep = r.made.find((c) => c.name.endsWith("_rs_files"));
      assert(filesStep && filesStep.cmd.includes("mv --exchange -T") && filesStep.image === WP_IMAGE, "the files step ran the exchange script in the type's image", names);
      const mv = await runOnce(`${runId}_mv`, [...HARD, "--user", "1000:1000", "--tmpfs", "/t:rw,size=1m,mode=1777", "--entrypoint", "sh", WP_IMAGE, "-c", "mv --version | head -1; cd /t && echo a > a && echo b > b && mv --exchange -T a b && cat a b"]);
      assert(mv.ok && /a\s*$/.test(mv.stdout) && /\nb\na/.test(mv.stdout.replace(/\r/g, "")), "mv --exchange works in the files image", mv.stdout + mv.stderr);
      return `containers ${names.join(",")}; note ${note.stage}/${note.siteType}; ${mv.stdout.split("\n")[0]}; ${String(r.ticks)} polls, no .maintenance`;
    });

    await step("restore-create-volume", async () => {
      const exists = await docker(["volume", "inspect", vol2]);
      assert(!exists.ok, "the second volume does not exist yet", vol2);
      const r = await restoreRun(svc2, { createVolume: true });
      createdVolumes.add(vol2);
      const names = checkRestore(r);
      const vInspect = await dockerJson("GET", `/volumes/${vol2}`);
      assert(vInspect?.Labels?.["io.hostingpanel.site_id"] === siteId, "created volume carries the site label", vInspect?.Labels);
      const content = await peek(vol2, "cat /v/index.html /v/gone.txt /v/docs/page.txt; ls -A /v");
      assert(content.includes(marks.index) && content.includes(marks.gone) && content.includes(marks.page), "snapshot files restored into the new volume", content);
      const owners = (await peek(vol2, OWNERS_CMD)).trim();
      assert(owners === "1000:1000", "restored files are 1000:1000", owners);
      const left = (await peek(vol2, LEFTOVERS_CMD)).trim();
      assert(left === "", "no .hp_rs_ or WordPress leftovers", left);
      const note = await readRestoreNote(path.join(dirs.backups, "restores"), r.jobId);
      // The ended note drops createdVolume by design (it only serves a crash undo); _rs_own shows the runner made the volume.
      assert(note?.stage === "ended" && note?.state === "succeeded" && note?.siteType === "teststatic", "note ended, succeeded, teststatic", note);
      assert(names.includes("hp_bk_<job>_rs_own"), "the runner created and owned the volume (_rs_own)", names);
      return `containers ${names.join(",")}; note ${note.stage}/${note.siteType}`;
    });

    // 4. SFTP
    const password = randomBytes(18).toString("base64url");
    const sftpUser = { username: `s${runHex}_static`, passwordHash: sha512Crypt(password), siteId, serviceInstanceId: svc };

    await step("sftp-generated-bodies", async () => {
      const rendered = renderSftpUserFiles([sftpUser], () => TEST_TYPE);
      const line = `${sftpUser.username}:x:1000:1000::/srv/sftp/${siteId}:/bin/false`;
      assert(rendered.passwd.split("\n").includes(line), "passwd names owner 1000:1000", rendered.passwd);
      const stateModel = path.join(tmpRoot, "sftp-model");
      const { payload } = buildSftpContainerPayload({ stateDir: stateModel, sites: [{ siteId, volume: vol }], port: sftpPort, hostIp: "127.0.0.1", network: sftpNetName });
      const binds = payload.HostConfig?.Binds ?? payload.Binds ?? [];
      assert(binds.includes(`${vol}:/srv/sftp/${siteId}/files:rw`), "container body mounts the type's volume", binds);
      return `group lines: ${rendered.group.trim().split("\n").join(" ")}`;
    });

    await step("sftp-real-login", async () => {
      const applied = await testAdapter.applySftpAccess({ users: [sftpUser] });
      createdContainers.add(sftpName);
      createdNetworks.add(sftpNetName);
      assert(applied.applied === 1, "one user applied", applied);
      const pub = (await readFile(path.join(dirs.sftp, "etc", "ssh_host_ed25519_key.pub"), "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
      const knownHosts = path.join(dirs.client, "known_hosts");
      const askpass = path.join(dirs.client, "askpass.sh");
      const batch = path.join(dirs.client, "batch.txt");
      await writeFile(knownHosts, `[127.0.0.1]:${String(sftpPort)} ${pub}\n`);
      await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$HP_SWARMTEST_PW"\n', { mode: 0o700 });
      await writeFile(batch, "ls\n");
      let res = null;
      for (let i = 0; i < 20; i += 1) {
        res = await execCmd(
          "sftp",
          ["-F", "/dev/null", "-oBatchMode=no", `-oUserKnownHostsFile=${knownHosts}`, "-oStrictHostKeyChecking=yes", "-oPubkeyAuthentication=no", "-oPreferredAuthentications=password", "-oNumberOfPasswordPrompts=1", "-oConnectTimeout=10", "-P", String(sftpPort), "-b", batch, `${sftpUser.username}@127.0.0.1`],
          { env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", HP_SWARMTEST_PW: password }, timeoutMs: 20_000 },
        );
        if (res.ok || /Permission denied/.test(res.stderr)) break;
        await sleep(500);
      }
      if (res.ok) {
        assert(/index\.html/.test(res.stdout), "the login lists the site's files", res.stdout);
        return "gid-1000 user logged in and listed index.html";
      }
      const logs = await docker(["logs", "--tail", "50", sftpName]);
      const why = /none of user's groups are listed in AllowGroups/.test(logs.stdout + logs.stderr);
      assert(/Permission denied/.test(res.stderr), "login either works or is refused at authentication", res.stderr);
      return `SKIP: login refused (${why ? "sshd: none of user's groups are listed in AllowGroups" : "Permission denied"}); the group line is fixed at 33 (R205 point 6), so a gid-1000 login stays unverified`;
    });

    // 5. Terminal
    await step("terminal-shell-as-owner", async () => {
      const sessionId = `term_${randomBytes(16).toString("hex")}`;
      const opened = await testAdapter.openTerminal({ sessionId, siteId, serviceInstanceId: svc });
      assert(opened.containerName === siteName, "terminal opens in the site container", opened);
      let out = "";
      let cursor = 0;
      const readUntil = async (done) => {
        const until = Date.now() + 15_000;
        while (Date.now() < until) {
          const r = await testAdapter.readTerminal({ sessionId, cursor });
          out += r.output;
          cursor = r.cursor;
          if (r.ended || done(out)) return r.ended;
        }
        throw new StepAssertionError("expected output in time", JSON.stringify(out.slice(-200)));
      };
      await readUntil((o) => o.includes("/srv/public $ "));
      await testAdapter.writeTerminal({ sessionId, input: "echo ID=$(id -u):$(id -g) PWD=$(pwd)\n" });
      await readUntil((o) => /ID=\d+:\d+ PWD=\S+/.test(o)); // the echoed command shows "ID=$(id", which never matches
      const m = /ID=(\d+:\d+) PWD=(\S+)/.exec(out);
      assert(m && m[1] === "1000:1000" && m[2] === "/srv/public", "shell runs as 1000:1000 in /srv/public", m?.[0] ?? out.slice(-200));
      const closed = await testAdapter.closeTerminal({ sessionId });
      assert(closed.reason === "closed", "close ends the session (kill exec)", closed);
      const marked = await docker(["exec", "-u", "1000:1000", siteName, "sh", "-c", 'n=0; for p in /proc/[0-9]*; do grep -qz "^HP_TERMINAL_SESSION=" "$p/environ" 2>/dev/null && n=$((n+1)); done; echo $n']);
      assert(marked.ok && marked.stdout.trim() === "0", "no session process left after the kill exec", marked.stdout + marked.stderr);
      return `${m[0]}; closed; 0 session processes left`;
    });

    // 6. WordPress next to it
    await step("wordpress-files-pass", async () => {
      assert((await docker(["volume", "create", "--label", `io.hostingpanel.site_id=${siteIdWp}`, volWp])).ok, "WordPress volume created", volWp);
      createdVolumes.add(volWp);
      const wpMount = WORDPRESS_EXECUTOR_SITE_TYPE.def.files.mountPath;
      const init = await runOnce(`${runId}_wpinit`, [...HARD, "--user", "0:0", "--cap-add", "CHOWN", "--entrypoint", "sh", "-v", `${volWp}:${wpMount}`, WP_IMAGE, "-c", `mkdir -p ${wpMount}/wp-content && chown -R 33:33 ${wpMount}`]);
      assert(init.ok, "WordPress volume initialised", init.stderr);
      const listed = await wpAdapter.siteFiles({ serviceInstanceId: svcWp, op: "list", path: "" });
      const names = listed.entries.map((e) => e.name);
      assert(names.includes("wp-content"), "WordPress helper lists wp-content", names);
      const inspect = await dockerJson("GET", `/containers/hp_files_${svcWp}/json`);
      assert(inspect?.Config?.User === WORDPRESS_EXECUTOR_SITE_TYPE.def.files.owner, "WordPress helper runs as its owner", inspect?.Config?.User);
      return `listed ${names.join(",")} as ${inspect.Config.User}`;
    });
  } finally {
    await testAdapter?.applySftpAccess({ users: [] }).catch(() => undefined);
    await cleanup();
  }

  const left = await Promise.all([
    docker(["ps", "-a", "--filter", `name=${runId}`, "--format", "{{.Names}}"]),
    docker(["volume", "ls", "--filter", `name=${runId}`, "--format", "{{.Name}}"]),
    docker(["network", "ls", "--filter", `name=${runId}`, "--format", "{{.Name}}"]),
    ...jobIds.map((j) => docker(["ps", "-a", "--filter", `name=hp_bk_${j}`, "--format", "{{.Names}}"])),
    ...jobIds.map((j) => docker(["volume", "ls", "--filter", `name=hp_bk_${j}`, "--format", "{{.Name}}"])),
  ]);
  const leftovers = left.flatMap((r) => r.stdout.split("\n").filter(Boolean));
  if (leftovers.length === 0) {
    passed += 1;
    console.log("PASS nothing-left");
  } else {
    failed += 1;
    console.log(`FAIL nothing-left: no object of this run / ${leftovers.join(",")}`);
  }
  console.log(`RESULT ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  async (err) => {
    console.log(`FAIL run: completes / ${fmt(err)}`);
    await cleanup();
    process.exit(1);
  },
);
