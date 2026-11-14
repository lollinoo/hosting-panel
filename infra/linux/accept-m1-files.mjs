#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M1 cycle 1 (web file manager).
 *
 * Proves mount-namespace confinement, helper container hardening, uid 33:33
 * ownership, symlink escape refusal, protected path enforcement, zip attack
 * refusal & round-trip, CP-01 site container non-interference, idle removal,
 * and purge without implicit volume recreation.
 *
 * Machine safety: every created Docker resource contains "swarmtest" and is
 * removed by exact name in `finally` (including on SIGINT/SIGTERM). No host
 * ports are published and no prune command is ever run.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { deflateRawSync, crc32 } from "node:zlib";
import {
  DEFAULT_DOCKER_API_PREFIX,
  DEFAULT_DOCKER_SOCKET_PATH,
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  SiteFilesHelpers,
  ensureSiteFilesProgram,
  getManagedVolumeName,
  siteFilesHelperName,
} from "../../apps/docker-executor/dist/index.js";
import {
  DEFAULT_PHP_VERSION,
  SITE_FILE_CHUNK_BYTES,
  resolveWordpressImage,
} from "../../packages/contracts/dist/index.js";

const execFile = promisify(execFileCb);

const runId = randomBytes(3).toString("hex");
const svcId = `svc_swarmtest_${runId}`;
const siteId = `site_swarmtest_${runId}`;
const volumeName = getManagedVolumeName(svcId, "html");
const helperName = siteFilesHelperName(svcId);
const seedContainerName = `hp_swarmtest_seed_${runId}`;
const statContainerName = `hp_swarmtest_stat_${runId}`;
const siteContainerName = `hp_swarmtest_site_${runId}`;
const largeDirContainerName = `hp_swarmtest_largedir_${runId}`;
const timeoutProbeContainerName = `hp_swarmtest_timeout_${runId}`;
const smallSvcId = `svc_swarmtest_small_${runId}`;
const smallSiteId = `site_swarmtest_small_${runId}`;
const smallVolumeName = getManagedVolumeName(smallSvcId, "html");
const smallHelperName = siteFilesHelperName(smallSvcId);
const smallHoldContainerName = `hp_swarmtest_smallhold_${runId}`;
const smallSeedContainerName = `hp_swarmtest_smallseed_${runId}`;
const wpImage = resolveWordpressImage(DEFAULT_PHP_VERSION);

const tempDirs = [];
let adapter = null;
let siteRemovedExplicitly = false;

async function docker(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFile("docker", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? 1,
      stdout: typeof err?.stdout === "string" ? err.stdout.trim() : "",
      stderr: typeof err?.stderr === "string" ? err.stderr.trim() : String(err),
    };
  }
}

async function dockerInspectContainer(name) {
  const res = await docker(["inspect", name]);
  if (!res.ok) return null;
  const arr = JSON.parse(res.stdout);
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

function assert(cond, expected, actual) {
  if (!cond) {
    throw new StepAssertionError(expected, actual);
  }
}

class StepAssertionError extends Error {
  constructor(expected, actual) {
    super(`${expected} / ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

function formatErr(err) {
  if (err instanceof ExecutorCodedError) {
    return `${err.code}:${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function expectCodedError(promise, expectedCode, expectedReason) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof ExecutorCodedError,
    `ExecutorCodedError(${expectedCode}/${expectedReason})`,
    caught === null ? "succeeded without error" : formatErr(caught),
  );
  assert(
    caught.code === expectedCode && caught.message === expectedReason,
    `${expectedCode}/${expectedReason}`,
    `${caught.code}/${caught.message}`,
  );
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const rawData = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const deflate = entry.deflate === true;
    const compMethod = deflate ? 8 : 0;
    const compData = deflate ? deflateRawSync(rawData) : rawData;
    const crc = crc32(rawData) >>> 0;
    const isUnix = entry.mode !== undefined;
    const versionMadeBy = isUnix ? (3 << 8) | 20 : 20;
    const externalAttr = isUnix ? (entry.mode << 16) >>> 0 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(compMethod, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(rawData.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compData);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(compMethod, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compData.length, 20);
    central.writeUInt32LE(rawData.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compData.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

async function uploadBuffer(remotePath, data, { overwrite = true, serviceInstanceId = svcId } = {}) {
  const uploadId = `u_${randomBytes(12).toString("hex")}`;
  if (data.length === 0) {
    return adapter.siteFiles({
      serviceInstanceId,
      op: "write",
      path: remotePath,
      uploadId,
      offset: 0,
      dataBase64: "",
      final: true,
      overwrite,
    });
  }
  let res = null;
  for (let offset = 0; offset < data.length; offset += SITE_FILE_CHUNK_BYTES) {
    const end = Math.min(offset + SITE_FILE_CHUNK_BYTES, data.length);
    const chunk = data.subarray(offset, end);
    res = await adapter.siteFiles({
      serviceInstanceId,
      op: "write",
      path: remotePath,
      uploadId,
      offset,
      dataBase64: chunk.toString("base64"),
      final: end === data.length,
      overwrite,
    });
  }
  return res;
}

async function downloadBuffer(remotePath) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const res = await adapter.siteFiles({
      serviceInstanceId: svcId,
      op: "read",
      path: remotePath,
      offset,
      length: SITE_FILE_CHUNK_BYTES,
    });
    const buf = Buffer.from(res.dataBase64, "base64");
    chunks.push(buf);
    offset += buf.length;
    if (res.eof || buf.length === 0) {
      break;
    }
  }
  return Buffer.concat(chunks);
}

async function snapshotTree(dirPath = "") {
  const listed = await adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: dirPath });
  const result = [];
  for (const entry of listed.entries) {
    const rel = dirPath === "" ? entry.name : `${dirPath}/${entry.name}`;
    result.push({ path: rel, kind: entry.kind, size: entry.size });
    if (entry.kind === "dir") {
      result.push(...(await snapshotTree(rel)));
    }
  }
  return result;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerSocketJsonRequest(method, endpointPath, jsonBody, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody === undefined ? null : Buffer.from(JSON.stringify(jsonBody), "utf8");
    const headers = {};
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const req = http.request(
      {
        socketPath: DEFAULT_DOCKER_SOCKET_PATH,
        path: `${DEFAULT_DOCKER_API_PREFIX}${endpointPath}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(new Error(`Docker socket timeout on ${method} ${endpointPath}`));
    });
    req.on("error", reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function createTmpfsVolume(name, labelSiteId, sizeMb) {
  return docker([
    "volume",
    "create",
    "--driver",
    "local",
    "--opt",
    "type=tmpfs",
    "--opt",
    "device=tmpfs",
    "--opt",
    `o=size=${sizeMb}m,uid=33,gid=33,mode=0755`,
    "--label",
    `io.hostingpanel.site_id=${labelSiteId}`,
    name,
  ]);
}

let cleanupPromise = null;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const c of [
      helperName,
      seedContainerName,
      statContainerName,
      siteContainerName,
      largeDirContainerName,
      timeoutProbeContainerName,
      smallHelperName,
      smallHoldContainerName,
      smallSeedContainerName,
    ]) {
      await docker(["rm", "-f", c]);
    }
    for (const v of [volumeName, smallVolumeName]) {
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

  let siteFilesDir = "";
  let initialSiteInspect = null;

  try {
    await runStep(
      "preflight",
      async () => {
        const tmpBase = await mkdtemp(path.join(os.tmpdir(), `hp-swarmtest-files-${runId}-`));
        tempDirs.push(tmpBase);
        siteFilesDir = path.join(tmpBase, "site-files");
        const ingressRootDir = path.join(tmpBase, "ingress");
        const secretsRootDir = path.join(tmpBase, "secrets");
        const siteMailDir = path.join(tmpBase, "site-mail");

        await ensureSiteFilesProgram(siteFilesDir);
        adapter = new DockerEngineSocketAdapter({
          siteFilesDir,
          ingressRootDir,
          secretsRootDir,
          siteMailDir,
          filesHelperIdleMs: 3000,
          pullMissingImages: false,
        });

        const pingOk = await adapter.pingEngine();
        assert(pingOk, "Docker Engine ping returns true", `pingEngine=${String(pingOk)}`);

        const imgInspect = await docker(["image", "inspect", wpImage]);
        if (!imgInspect.ok) {
          const pullRes = await docker(["pull", wpImage]);
          assert(pullRes.ok, `pull ${wpImage} succeeds`, pullRes.stderr || pullRes.stdout);
        }
      },
      { abortOnFail: true },
    );

    if (!fatalSetupFailure) {
      await runStep(
        "seed",
        async () => {
          const volRes = await createTmpfsVolume(volumeName, siteId, 1536);
          assert(volRes.ok, `tmpfs volume ${volumeName} created`, volRes.stderr);

          // Start the stand-in site container BEFORE seeding so a user stays mounted on the tmpfs volume.
          const siteRun = await docker([
            "run",
            "-d",
            "--name",
            siteContainerName,
            "--network",
            "none",
            "--entrypoint",
            "sleep",
            "--label",
            `io.hostingpanel.service_instance_id=${svcId}`,
            "--label",
            `io.hostingpanel.site_id=${siteId}`,
            "-v",
            `${volumeName}:/var/www/html`,
            wpImage,
            "infinity",
          ]);
          assert(siteRun.ok, "stand-in site container starts", siteRun.stderr);

          const seedScript = [
            "set -eu",
            "mkdir -p /var/www/html/wp-content/uploads /var/www/html/wp-content/mu-plugins",
            "printf '<?php echo \"hello-swarmtest\"; ?>\\n' > /var/www/html/index.php",
            "printf 'upload-seed\\n' > /var/www/html/wp-content/uploads/a.txt",
            "printf '<?php // protected\\n' > /var/www/html/wp-content/mu-plugins/hp-mail.php",
            "ln -s /etc/passwd /var/www/html/out-passwd",
            "ln -s /etc /var/www/html/out-abs",
            "ln -s ../../../etc/passwd /var/www/html/out-rel",
            "ln -s index.php /var/www/html/in-link",
            "ln -s /etc /var/www/html/wp-content/uploads/dirlink",
            "ln -s wp-content/uploads /var/www/html/updir",
            "chown 33:33 /var/www/html /var/www/html/index.php /var/www/html/wp-content",
            "chown -R 33:33 /var/www/html/wp-content/uploads",
            "chown -h 33:33 /var/www/html/out-passwd /var/www/html/out-abs /var/www/html/out-rel /var/www/html/in-link /var/www/html/updir /var/www/html/wp-content/uploads/dirlink",
            "chown 0:0 /var/www/html/wp-content/mu-plugins /var/www/html/wp-content/mu-plugins/hp-mail.php",
            "chmod 0755 /var/www/html/wp-content/mu-plugins",
            "chmod 0644 /var/www/html/wp-content/mu-plugins/hp-mail.php",
          ].join("; ");

          const seedRun = await docker([
            "run",
            "--rm",
            "--name",
            seedContainerName,
            "--network",
            "none",
            "--entrypoint",
            "sh",
            "-v",
            `${volumeName}:/var/www/html`,
            wpImage,
            "-c",
            seedScript,
          ]);
          assert(seedRun.ok, "seed container succeeds", seedRun.stderr);

          initialSiteInspect = await dockerInspectContainer(siteContainerName);
          assert(
            initialSiteInspect !== null && initialSiteInspect.State?.Running === true,
            "stand-in site container running",
            JSON.stringify(initialSiteInspect?.State ?? null),
          );
        },
        { abortOnFail: true },
      );
    }

    if (!fatalSetupFailure) {
      await runStep("helper-spec", async () => {
        const listed = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "list",
          path: "",
        });
        const byName = new Map(listed.entries.map((e) => [e.name, e]));
        for (const linkName of ["out-passwd", "out-abs", "out-rel", "in-link", "updir"]) {
          const entry = byName.get(linkName);
          assert(
            entry?.kind === "link",
            `${linkName} listed as kind=link`,
            `${linkName} kind=${entry?.kind ?? "missing"}`,
          );
        }

        const info = await dockerInspectContainer(helperName);
        assert(info !== null, `helper ${helperName} exists`, "not found");
        assert(info.Config?.Image === wpImage, `Image=${wpImage}`, String(info.Config?.Image));
        assert(info.Config?.User === "33:33", "User=33:33", String(info.Config?.User));
        assert(
          info.HostConfig?.NetworkMode === "none",
          "NetworkMode=none",
          String(info.HostConfig?.NetworkMode),
        );
        assert(
          info.HostConfig?.ReadonlyRootfs === true,
          "ReadonlyRootfs=true",
          String(info.HostConfig?.ReadonlyRootfs),
        );
        assert(
          Array.isArray(info.HostConfig?.CapDrop) &&
            info.HostConfig.CapDrop.length === 1 &&
            info.HostConfig.CapDrop[0] === "ALL",
          "CapDrop=[ALL]",
          JSON.stringify(info.HostConfig?.CapDrop),
        );
        assert(
          Array.isArray(info.HostConfig?.SecurityOpt) &&
            info.HostConfig.SecurityOpt.includes("no-new-privileges:true"),
          "SecurityOpt includes no-new-privileges:true",
          JSON.stringify(info.HostConfig?.SecurityOpt),
        );
        const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
        assert(mounts.length === 2, "exactly 2 mounts", `mounts=${mounts.length}`);
        const volMount = mounts.find((m) => m.Destination === "/var/www/html");
        const progMount = mounts.find((m) => m.Destination === "/usr/local/lib/hp-files");
        assert(
          volMount?.Type === "volume" && volMount?.Name === volumeName && volMount?.RW === true,
          `volume mount ${volumeName}:/var/www/html:rw`,
          JSON.stringify(volMount ?? null),
        );
        assert(
          progMount?.Type === "bind" &&
            progMount?.Source === path.resolve(siteFilesDir) &&
            progMount?.RW === false,
          `ro bind mount ${siteFilesDir}:/usr/local/lib/hp-files:ro`,
          JSON.stringify(progMount ?? null),
        );
        assert(
          info.Config?.Labels?.["io.hostingpanel.service_instance_id"] === undefined,
          "helper has no io.hostingpanel.service_instance_id label",
          String(info.Config?.Labels?.["io.hostingpanel.service_instance_id"]),
        );
        assert(
          info.Config?.Labels?.["io.hostingpanel.role"] === "site_files",
          "helper has role=site_files",
          String(info.Config?.Labels?.["io.hostingpanel.role"]),
        );
      });

      await runStep("program-timeout-tool", async () => {
        const probe = await docker([
          "run",
          "--rm",
          "--name",
          timeoutProbeContainerName,
          "--network",
          "none",
          "--entrypoint",
          "sh",
          wpImage,
          "-c",
          'command -v timeout && timeout -s KILL 0.1 sleep 5; rc=$?; [ "$rc" -eq 137 ]',
        ]);
        assert(
          probe.ok && probe.stdout.includes("timeout"),
          "timeout exists in WordPress image and -s KILL exits 137",
          probe.stderr || probe.stdout,
        );

        const recordedExecCmds = [];
        const probeHelpers = new SiteFilesHelpers({
          target: {
            socketPath: DEFAULT_DOCKER_SOCKET_PATH,
            apiPrefix: DEFAULT_DOCKER_API_PREFIX,
            request: async (method, endpointPath, jsonBody, options) => {
              if (method === "POST" && /^\/containers\/[^/]+\/exec$/.test(endpointPath)) {
                recordedExecCmds.push(jsonBody?.Cmd);
              }
              return dockerSocketJsonRequest(method, endpointPath, jsonBody, options);
            },
          },
          programDir: siteFilesDir,
        });

        try {
          const statRes = await probeHelpers.run({
            serviceInstanceId: svcId,
            op: "stat",
            path: "index.php",
          });
          assert(
            statRes.entry.name === "index.php" && statRes.entry.kind === "file",
            "stat via SiteFilesHelpers succeeds on live helper",
            JSON.stringify(statRes),
          );
          assert(
            recordedExecCmds.some(
              (cmd) =>
                Array.isArray(cmd) &&
                cmd.slice(0, 5).join(" ") === "timeout -s KILL 43 php" &&
                cmd[cmd.length - 1] === "/usr/local/lib/hp-files/hp-files.php",
            ),
            "helper starts hp-files.php under timeout -s KILL 43 php",
            JSON.stringify(recordedExecCmds),
          );
        } finally {
          probeHelpers.stop();
        }
      });

      await runStep("roundtrip", async () => {
        const initialBuf = Buffer.from(`initial-${runId}-content\n`, "utf8");
        const editedBuf = Buffer.from(`edited-${runId}-payload-${randomBytes(32).toString("hex")}\n`, "utf8");

        const upRes = await uploadBuffer("roundtrip.txt", initialBuf, { overwrite: false });
        assert(
          upRes.received === initialBuf.length,
          `received=${initialBuf.length}`,
          `received=${upRes.received}`,
        );

        const listed = await adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "" });
        const found = listed.entries.find((e) => e.name === "roundtrip.txt");
        assert(
          found?.kind === "file" && found?.size === initialBuf.length,
          `roundtrip.txt listed with size=${initialBuf.length}`,
          JSON.stringify(found ?? null),
        );

        await uploadBuffer("roundtrip.txt", editedBuf, { overwrite: true });
        const downloaded = await downloadBuffer("roundtrip.txt");
        assert(
          sha256(downloaded) === sha256(editedBuf),
          `sha256=${sha256(editedBuf)}`,
          `sha256=${sha256(downloaded)}`,
        );

        const statRes = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "stat",
          path: "roundtrip.txt",
        });
        assert(
          statRes.entry.size === editedBuf.length,
          `stat size=${editedBuf.length}`,
          `stat size=${statRes.entry.size}`,
        );
      });

      await runStep("large-upload", async () => {
        const totalSize = SITE_FILE_CHUNK_BYTES * 4 + 12_345;
        const payload = randomBytes(totalSize);
        const uploadId = `large_${randomBytes(12).toString("hex")}`;

        // 5 chunks with a replay of chunk 1 to prove offset idempotency.
        const chunks = [];
        for (let off = 0; off < payload.length; off += SITE_FILE_CHUNK_BYTES) {
          const end = Math.min(off + SITE_FILE_CHUNK_BYTES, payload.length);
          chunks.push({ offset: off, data: payload.subarray(off, end), final: end === payload.length });
        }
        const sequence = [chunks[0], chunks[1], chunks[1], chunks[2], chunks[3], chunks[4]];
        for (const c of sequence) {
          await adapter.siteFiles({
            serviceInstanceId: svcId,
            op: "write",
            path: "large.bin",
            uploadId,
            offset: c.offset,
            dataBase64: c.data.toString("base64"),
            final: c.final,
            overwrite: true,
          });
        }

        const listed = await adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "" });
        assert(
          !listed.entries.some((e) => e.name.startsWith(".htpanel-")),
          "no .htpanel-* staging file listed",
          JSON.stringify(listed.entries.map((e) => e.name).filter((n) => n.startsWith(".htpanel-"))),
        );
        const entry = listed.entries.find((e) => e.name === "large.bin");
        assert(
          entry?.size === totalSize,
          `large.bin size=${totalSize}`,
          `size=${entry?.size ?? "missing"}`,
        );

        const readBack = await downloadBuffer("large.bin");
        assert(
          sha256(readBack) === sha256(payload),
          `sha256=${sha256(payload)}`,
          `sha256=${sha256(readBack)}`,
        );

        const statRun = await docker([
          "run",
          "--rm",
          "--name",
          statContainerName,
          "--network",
          "none",
          "--entrypoint",
          "stat",
          "-v",
          `${volumeName}:/var/www/html:ro`,
          wpImage,
          "-c",
          "%u:%g",
          "/var/www/html/large.bin",
          "/var/www/html/roundtrip.txt",
        ]);
        assert(statRun.ok, "second throw-away container stat succeeds", statRun.stderr);
        const owners = statRun.stdout.split(/\r?\n/).map((s) => s.trim());
        assert(
          owners.length === 2 && owners.every((o) => o === "33:33"),
          "ownership is 33:33 on both created files",
          JSON.stringify(owners),
        );

        await expectCodedError(
          uploadBuffer("large.bin", Buffer.from("nope"), { overwrite: false }),
          "ALREADY_EXISTS",
          "exists",
        );
      });

      await runStep("path-validation", async () => {
        const before = await dockerInspectContainer(helperName);
        const execIdsBefore = Array.isArray(before?.ExecIDs) ? [...before.ExecIDs] : [];

        for (const badPath of ["../x", "/etc/x", "a\u0000b", ".htpanel-upload-x"]) {
          await expectCodedError(
            adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: badPath }),
            "VALIDATION_ERROR",
            "invalid_path",
          );
        }

        const after = await dockerInspectContainer(helperName);
        const execIdsAfter = Array.isArray(after?.ExecIDs) ? [...after.ExecIDs] : [];
        assert(
          JSON.stringify(execIdsBefore) === JSON.stringify(execIdsAfter),
          "Docker exec not invoked for schema-rejected paths",
          `before=${execIdsBefore.length} after=${execIdsAfter.length}`,
        );
      });

      await runStep("symlink-escape", async () => {
        const dummyB64 = Buffer.from("x").toString("base64");
        const dummyUploadId = `sym_${randomBytes(12).toString("hex")}`;

        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "read", path: "out-passwd", offset: 0, length: 64 }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "read", path: "out-abs/passwd", offset: 0, length: 64 }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "read", path: "out-rel", offset: 0, length: 64 }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "out-abs" }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "wp-content/uploads/dirlink" }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({
            serviceInstanceId: svcId,
            op: "write",
            path: "out-abs/x",
            uploadId: dummyUploadId,
            offset: 0,
            dataBase64: dummyB64,
            final: true,
            overwrite: true,
          }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({
            serviceInstanceId: svcId,
            op: "write",
            path: "wp-content/uploads/dirlink/x",
            uploadId: dummyUploadId,
            offset: 0,
            dataBase64: dummyB64,
            final: true,
            overwrite: true,
          }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "mkdir", path: "out-abs/y" }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "mkdir", path: "wp-content/uploads/dirlink/y" }),
          "PERMISSION_DENIED",
          "protected",
        );

        const inside = await downloadBuffer("in-link");
        const direct = await downloadBuffer("index.php");
        assert(
          inside.equals(direct) && inside.toString("utf8").includes("hello-swarmtest"),
          "in-link resolves to index.php content",
          inside.toString("utf8"),
        );
      });

      await runStep("protected", async () => {
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "delete", paths: ["wp-content/mu-plugins/hp-mail.php"] }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "delete", paths: ["wp-content"] }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({
            serviceInstanceId: svcId,
            op: "move",
            from: "wp-content/mu-plugins",
            to: "wp-content/mu-plugins-moved",
          }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          uploadBuffer("wp-content/mu-plugins/x.php", Buffer.from("<?php\n"), { overwrite: true }),
          "PERMISSION_DENIED",
          "protected",
        );
        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "mkdir", path: "wp-content/mu-plugins/sub" }),
          "PERMISSION_DENIED",
          "protected",
        );
      });

      await runStep("delete-link", async () => {
        await adapter.siteFiles({ serviceInstanceId: svcId, op: "delete", paths: ["updir"] });
        const rootList = await adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "" });
        assert(
          !rootList.entries.some((e) => e.name === "updir"),
          "updir symlink removed",
          "updir still present",
        );
        const uploadsList = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "list",
          path: "wp-content/uploads",
        });
        assert(
          uploadsList.entries.some((e) => e.name === "a.txt"),
          "wp-content/uploads/a.txt intact after deleting symlink",
          JSON.stringify(uploadsList.entries.map((e) => e.name)),
        );
      });

      await runStep("zip-attacks", async () => {
        const beforeTree = await snapshotTree();

        const manyEntries = Array.from({ length: 20_001 }, (_, i) => ({
          name: `f${i}.txt`,
          data: "",
        }));

        const attacks = [
          {
            file: "dotdot.zip",
            buf: buildZip([
              { name: "../evil.txt", data: "evil" },
              { name: "a/../../evil.txt", data: "evil" },
            ]),
            code: "VALIDATION_ERROR",
            reason: "archive_unsafe",
          },
          {
            file: "abs.zip",
            buf: buildZip([{ name: "/etc/evil.txt", data: "evil" }]),
            code: "VALIDATION_ERROR",
            reason: "archive_unsafe",
          },
          {
            file: "link.zip",
            buf: buildZip([{ name: "s", data: "/etc/passwd", mode: 0o120777 }]),
            code: "VALIDATION_ERROR",
            reason: "archive_unsafe",
          },
          {
            file: "many.zip",
            buf: buildZip(manyEntries),
            code: "QUOTA_EXCEEDED",
            reason: "archive_limit",
          },
          {
            file: "bomb.zip",
            buf: buildZip([{ name: "zeros.bin", data: Buffer.alloc(20 * 1024 * 1024), deflate: true }]),
            code: "QUOTA_EXCEEDED",
            reason: "archive_limit",
          },
        ];

        const uploadedAttackPaths = [];
        for (const atk of attacks) {
          await uploadBuffer(atk.file, atk.buf, { overwrite: true });
          uploadedAttackPaths.push(atk.file);
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: svcId,
              op: "extract",
              path: atk.file,
              to: "attack-out",
            }),
            atk.code,
            atk.reason,
          );
        }

        await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "delete",
          paths: uploadedAttackPaths,
        });

        const afterTree = await snapshotTree();
        assert(
          JSON.stringify(beforeTree) === JSON.stringify(afterTree),
          "tree listing unchanged after all zip attacks",
          `before=${beforeTree.length} entries, after=${afterTree.length} entries`,
        );
      });

      await runStep("zip-roundtrip", async () => {
        const arc = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "archive",
          paths: ["wp-content"],
          to: "site.zip",
        });
        assert(arc.entries > 0, "archive entry count > 0", `entries=${arc.entries}`);

        const ext = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "extract",
          path: "site.zip",
          to: "restored",
        });
        assert(
          ext.entries === arc.entries,
          `extract entries (${ext.entries}) === archive entries (${arc.entries})`,
          `${ext.entries} vs ${arc.entries}`,
        );

        const restoredFile = await downloadBuffer("restored/wp-content/uploads/a.txt");
        assert(
          restoredFile.toString("utf8") === "upload-seed\n",
          "restored a.txt matches original",
          restoredFile.toString("utf8"),
        );

        const restoredUploads = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "list",
          path: "restored/wp-content/uploads",
        });
        assert(
          !restoredUploads.entries.some((e) => e.name === "dirlink"),
          "dirlink symlink omitted from archive/extract round-trip",
          JSON.stringify(restoredUploads.entries.map((e) => e.name)),
        );
      });

      await runStep("list-large", async () => {
        const createRes = await docker([
          "run",
          "--rm",
          "--name",
          largeDirContainerName,
          "--user",
          "33:33",
          "--network",
          "none",
          "--entrypoint",
          "php",
          "-v",
          `${volumeName}:/var/www/html`,
          wpImage,
          "-r",
          [
            '$d = "/var/www/html/large-dir";',
            "if (!is_dir($d)) { mkdir($d, 0755, true); }",
            '$padA = str_repeat("a", 195);',
            '$padU = str_repeat("\\xc3\\xa9", 97);',
            "for ($i = 0; $i < 5000; $i++) {",
            '  $p = ($i < 2500) ? sprintf("%04d-%s", $i, $padA) : sprintf("%04d-%s", $i, $padU);',
            '  touch("$d/$p");',
            "}",
          ].join(" "),
        ]);
        assert(createRes.ok, "large-dir populated with 5000 long files", createRes.stderr);

        const listed = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "list",
          path: "large-dir",
        });
        const encodedBytes = Buffer.byteLength(
          JSON.stringify({ ok: true, result: listed }),
          "utf8",
        );
        assert(listed.truncated === true, "list-large truncated=true", String(listed.truncated));
        assert(
          listed.entries.length > 0 && listed.entries.length < 5000,
          "list-large caps entries below 5000 under 1 MiB byte budget",
          `entries=${listed.entries.length}`,
        );
        assert(
          encodedBytes < 1_048_576,
          "list-large JSON response stays under 1 MiB",
          `bytes=${encodedBytes}`,
        );

        await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "delete",
          paths: ["large-dir"],
        });
      });

      await runStep("cp01-site-untouched", async () => {
        const current = await dockerInspectContainer(siteContainerName);
        assert(current !== null, "stand-in site container still present", "missing");
        assert(
          current.State?.Running === true,
          "stand-in site container still running",
          String(current.State?.Running),
        );
        assert(
          current.State?.StartedAt === initialSiteInspect.State?.StartedAt,
          `StartedAt unchanged (${initialSiteInspect.State?.StartedAt})`,
          String(current.State?.StartedAt),
        );
        assert(
          current.RestartCount === initialSiteInspect.RestartCount && current.RestartCount === 0,
          "RestartCount unchanged (0)",
          String(current.RestartCount),
        );
        const execIds = Array.isArray(current.ExecIDs) ? current.ExecIDs : [];
        assert(
          execIds.length === 0,
          "no docker exec ever run on site container",
          JSON.stringify(execIds),
        );
      });

      await runStep("idle-removal", async () => {
        let gone = false;
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          await sleep(500);
          const inspected = await dockerInspectContainer(helperName);
          if (inspected === null) {
            gone = true;
            break;
          }
        }
        assert(gone, `helper ${helperName} removed after idle timeout`, "still present after 8s");

        const relisted = await adapter.siteFiles({
          serviceInstanceId: svcId,
          op: "list",
          path: "",
        });
        assert(
          relisted.entries.some((e) => e.name === "index.php"),
          "next list recreates helper and returns index.php",
          JSON.stringify(relisted.entries.map((e) => e.name)),
        );
        const recreated = await dockerInspectContainer(helperName);
        assert(
          recreated !== null && recreated.State?.Running === true,
          "recreated helper is running",
          "not running",
        );
      });

      await runStep("purge", async () => {
        // Site services are deleted before purgeSite(siteId) is called.
        const rmSite = await docker(["rm", "-f", siteContainerName]);
        assert(rmSite.ok, "stand-in site container removed before purgeSite", rmSite.stderr);
        siteRemovedExplicitly = true;

        await adapter.purgeSite(siteId);

        const helperAfter = await dockerInspectContainer(helperName);
        assert(helperAfter === null, "helper removed by purgeSite", "helper still exists");

        const volCheck = await docker(["volume", "inspect", volumeName]);
        assert(!volCheck.ok, "volume removed by purgeSite", "volume still exists");

        await expectCodedError(
          adapter.siteFiles({ serviceInstanceId: svcId, op: "list", path: "" }),
          "NOT_FOUND",
          "not_found",
        );

        const volList = await docker(["volume", "ls", "-q", "--filter", `name=${volumeName}`]);
        assert(
          volList.ok && volList.stdout === "",
          "volume not recreated after file request on purged site",
          volList.stdout,
        );
      });

      await runStep("protected-before-disk", async () => {
        const smallVol = await createTmpfsVolume(smallVolumeName, smallSiteId, 16);
        assert(smallVol.ok, `small tmpfs volume ${smallVolumeName} created`, smallVol.stderr);

        try {
          const holdRun = await docker([
            "run",
            "-d",
            "--name",
            smallHoldContainerName,
            "--network",
            "none",
            "--entrypoint",
            "sleep",
            "--label",
            `io.hostingpanel.service_instance_id=${smallSvcId}`,
            "--label",
            `io.hostingpanel.site_id=${smallSiteId}`,
            "-v",
            `${smallVolumeName}:/var/www/html`,
            wpImage,
            "infinity",
          ]);
          assert(holdRun.ok, "small volume hold container starts", holdRun.stderr);

          const seedSmall = await docker([
            "run",
            "--rm",
            "--name",
            smallSeedContainerName,
            "--network",
            "none",
            "--entrypoint",
            "php",
            "-v",
            `${smallVolumeName}:/var/www/html`,
            wpImage,
            "-r",
            [
              "$r = '/var/www/html';",
              'mkdir("$r/wp-content/uploads", 0755, true);',
              'mkdir("$r/wp-content/mu-plugins", 0755, true);',
              'file_put_contents("$r/wp-content/uploads/seed.txt", "seed");',
              'file_put_contents("$r/wp-content/mu-plugins/hp-mail.php", "<?php");',
              '$z1 = new ZipArchive(); $z1->open("$r/seed.zip", ZipArchive::CREATE); $z1->addFromString("sub/a.txt", "a"); $z1->close();',
              '$z2 = new ZipArchive(); $z2->open("$r/prot-inner.zip", ZipArchive::CREATE); $z2->addFromString("wp-content/mu-plugins/evil.php", "x"); $z2->close();',
              'chown($r, 33); chown("$r/wp-content", 33); chown("$r/wp-content/uploads", 33); chown("$r/wp-content/uploads/seed.txt", 33);',
              'chown("$r/seed.zip", 33); chown("$r/prot-inner.zip", 33);',
              'chown("$r/wp-content/mu-plugins", 0); chown("$r/wp-content/mu-plugins/hp-mail.php", 0);',
              'chmod("$r/wp-content/mu-plugins", 0755); chmod("$r/wp-content/mu-plugins/hp-mail.php", 0644);',
            ].join(" "),
          ]);
          assert(seedSmall.ok, "small volume seeded", seedSmall.stderr);

          // Confirm the 16 MiB tmpfs reaches the 1 GiB free-space floor on a writable destination.
          await expectCodedError(
            uploadBuffer("wp-content/uploads/can-fill.txt", Buffer.from("x"), {
              overwrite: false,
              serviceInstanceId: smallSvcId,
            }),
            "QUOTA_EXCEEDED",
            "disk_full",
          );

          // Unwritable/protected destinations must refuse with PERMISSION_DENIED/protected BEFORE disk_full.
          await expectCodedError(
            uploadBuffer("wp-content/mu-plugins/new.php", Buffer.from("x"), {
              overwrite: false,
              serviceInstanceId: smallSvcId,
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            uploadBuffer("wp-content/mu-plugins/hp-mail.php", Buffer.from("x"), {
              overwrite: true,
              serviceInstanceId: smallSvcId,
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: smallSvcId,
              op: "mkdir",
              path: "wp-content/mu-plugins/sub",
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: smallSvcId,
              op: "archive",
              paths: ["wp-content/uploads/seed.txt"],
              to: "wp-content/mu-plugins/out.zip",
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: smallSvcId,
              op: "extract",
              path: "seed.zip",
              to: "wp-content/mu-plugins",
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: smallSvcId,
              op: "extract",
              path: "seed.zip",
              to: "wp-content/mu-plugins/sub",
            }),
            "PERMISSION_DENIED",
            "protected",
          );
          await expectCodedError(
            adapter.siteFiles({
              serviceInstanceId: smallSvcId,
              op: "extract",
              path: "prot-inner.zip",
              to: "",
            }),
            "PERMISSION_DENIED",
            "protected",
          );

          // Deleting files is never blocked by the 1 GiB free-space floor.
          await adapter.siteFiles({
            serviceInstanceId: smallSvcId,
            op: "delete",
            paths: ["wp-content/uploads/seed.txt"],
          });
        } finally {
          await docker(["rm", "-f", smallHoldContainerName]);
          await adapter.purgeSite(smallSiteId).catch(() => undefined);
          await docker(["rm", "-f", smallHelperName]);
          await docker(["volume", "rm", smallVolumeName]);
        }
      });
    }
  } finally {
    await cleanup();
    if (!siteRemovedExplicitly) {
      // cleanup() already removes siteContainerName
    }
  }

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`accept-m1-files: ${passed}/${total} passed in ${elapsedSec}s`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`FAIL fatal: ${formatErr(err)}`);
  await cleanup();
  process.exit(1);
});
