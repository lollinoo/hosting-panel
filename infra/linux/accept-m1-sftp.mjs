#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M1 cycle 2 (SFTP per site).
 *
 * Proves host-key fingerprint matching, container hardening, uid 33:33 ownership,
 * chroot confinement, multi-site isolation with duplicate uid 33, SFTP symlink
 * non-escape, no shell/PTY/forwarding, append-only add-user without restart,
 * container restart and ensureSftpFromState continuity, multi-session concurrency
 * under limits, session cut on user deletion and password rotation,
 * site-deletion volume release, CP-01 site container non-interference, host-key
 * preservation across empty apply, and PerSourcePenalties brute-force slowdown.
 *
 * Machine safety: every created Docker resource starts with "hp_swarmtest_" and
 * is removed by exact name in `finally` (including on SIGINT/SIGTERM). Only one
 * ephemeral loopback port on 127.0.0.1 is bound and no prune command is run.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const { DockerEngineSocketAdapter } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href
);
const { SFTP_IMAGE } = await import(
  pathToFileURL(path.resolve(repoRoot, "packages/contracts/dist/index.js")).href
);
const { sha512Crypt } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/api/dist/sites/sha512-crypt.js")).href
);

const FORBIDDEN_HOST_PORTS = new Set([22, 80, 443, 2222, 3000, 4000, 5432]);
const STANDIN_SITE_IMAGE = "alpine:3";

const runId = `hp_swarmtest_${randomBytes(3).toString("hex")}`;
const sftpContainerName = `${runId}_sftp`;
const networkName = `${runId}_net`;
const volumePrefix = `${runId}_vol_`;
const volA = `${volumePrefix}a_html`;
const volB = `${volumePrefix}b_html`;
const siteContainerName = `${runId}_site_a`;
const chownContainerName = `${runId}_chown`;
const seedContainerName = `${runId}_seed`;
const statContainerName = `${runId}_stat`;

const tempDirs = [];
const createdVolumes = new Set();
const createdContainers = new Set();
const activeChildProcesses = new Set();
let createdNetwork = false;

let port = 0;
let stateDir = "";
let secretsDir = "";
let ingressDir = "";
let workDir = "";
let askpassPath = "";
let knownHostsPath = "";
let adapter = null;
let batchCounter = 0;

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

function execCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFileCb(
      cmd,
      args,
      {
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 20_000,
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

async function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to bind free loopback port")));
        return;
      }
      const chosen = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(chosen)));
    });
  });
}

function createAdapter() {
  return new DockerEngineSocketAdapter({
    pullMissingImages: false,
    sftpStateDir: stateDir,
    secretsRootDir: secretsDir,
    ingressRootDir: ingressDir,
    sftpPort: port,
    sftpHostIp: "127.0.0.1",
    sftpContainerName,
    sftpNetworkName: networkName,
    sftpVolumePrefix: volumePrefix,
  });
}

function sshClientEnv(password) {
  return {
    ...process.env,
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
    HP_SWARMTEST_PW: password,
  };
}

async function runSftp(username, password, batchLines, opts = {}) {
  batchCounter += 1;
  const batchPath = path.join(workDir, `batch-${batchCounter}.txt`);
  await writeFile(batchPath, `${batchLines.join("\n")}\n`, "utf8");
  return execCmd(
    "sftp",
    [
      "-F",
      "/dev/null",
      "-oBatchMode=no",
      `-oUserKnownHostsFile=${knownHostsPath}`,
      "-oStrictHostKeyChecking=yes",
      "-oPubkeyAuthentication=no",
      "-oPreferredAuthentications=password",
      "-oNumberOfPasswordPrompts=1",
      "-oConnectTimeout=10",
      "-P",
      String(port),
      "-b",
      batchPath,
      `${username}@127.0.0.1`,
    ],
    { env: sshClientEnv(password), timeoutMs: opts.timeoutMs ?? 20_000 },
  );
}

async function runSsh(username, password, extraArgs, remoteCmdArgs = [], opts = {}) {
  return execCmd(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-oBatchMode=no",
      `-oUserKnownHostsFile=${knownHostsPath}`,
      "-oStrictHostKeyChecking=yes",
      "-oPubkeyAuthentication=no",
      "-oPreferredAuthentications=password",
      "-oNumberOfPasswordPrompts=1",
      "-oConnectTimeout=10",
      "-p",
      String(port),
      ...extraArgs,
      `${username}@127.0.0.1`,
      ...remoteCmdArgs,
    ],
    { env: sshClientEnv(password), timeoutMs: opts.timeoutMs ?? 15_000 },
  );
}

async function waitForSftpReady(username, password) {
  let last = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    last = await runSftp(username, password, ["pwd"]);
    if (last.ok) {
      return last;
    }
    await sleep(300);
  }
  return last;
}

async function openSftpSession(username, password, opts = {}) {
  const connectTimeoutMs = opts.timeoutMs ?? 15_000;
  const child = spawn(
    "stdbuf",
    [
      "-oL",
      "-eL",
      "sftp",
      "-F",
      "/dev/null",
      "-oBatchMode=no",
      `-oUserKnownHostsFile=${knownHostsPath}`,
      "-oStrictHostKeyChecking=yes",
      "-oPubkeyAuthentication=no",
      "-oPreferredAuthentications=password",
      "-oNumberOfPasswordPrompts=1",
      "-oConnectTimeout=10",
      "-P",
      String(port),
      "-b",
      "-",
      `${username}@127.0.0.1`,
    ],
    {
      env: sshClientEnv(password),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  activeChildProcesses.add(child);

  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode = null;
  const waiters = new Set();

  function notifyWaiters() {
    for (const w of waiters) {
      w();
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    notifyWaiters();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    notifyWaiters();
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
    activeChildProcesses.delete(child);
    notifyWaiters();
  });
  child.once("error", (err) => {
    stderr += `\n${err.message}`;
    exited = true;
    exitCode = 1;
    activeChildProcesses.delete(child);
    notifyWaiters();
  });

  function waitForCondition(pred, timeoutMs, timeoutLabel) {
    if (pred()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(`${timeoutLabel} (stdout=${stdout.slice(-300)}, stderr=${stderr.slice(-300)})`),
        );
      }, timeoutMs);
      function check() {
        if (pred()) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        }
      }
      waiters.add(check);
    });
  }

  const pwdLineRe = /Remote working directory:[^\n]*\n/;

  async function run(cmd, cmdTimeoutMs = 10_000) {
    if (exited) {
      throw new Error(
        `SFTP session already exited (code=${String(exitCode)}, stderr=${stderr.trim()})`,
      );
    }
    const markerStart = stdout.length;
    const payload = cmd.trim() === "pwd" ? "pwd\n" : `${cmd}\npwd\n`;
    child.stdin.write(payload);
    await waitForCondition(
      () => exited || pwdLineRe.test(stdout.slice(markerStart)),
      cmdTimeoutMs,
      `Timed out waiting for SFTP command "${cmd}"`,
    );
    const segment = stdout.slice(markerStart);
    if (!pwdLineRe.test(segment)) {
      throw new Error(
        `SFTP session ended during "${cmd}" (code=${String(exitCode)}, stderr=${stderr.trim()})`,
      );
    }
    return segment;
  }

  async function waitForExit(waitMs = 5_000) {
    try {
      await waitForCondition(() => exited, waitMs, "SFTP session did not exit");
      return { exited: true, code: exitCode, stdout, stderr };
    } catch {
      return { exited: false, code: exitCode, stdout, stderr };
    }
  }

  async function close() {
    if (!exited) {
      try {
        child.stdin.write("bye\n");
        child.stdin.end();
      } catch {
        // ignore broken pipe on closed stdin
      }
      const res = await waitForExit(2_000);
      if (!res.exited) {
        child.kill("SIGKILL");
        await waitForExit(2_000);
      }
    }
    activeChildProcesses.delete(child);
  }

  try {
    await run("pwd", connectTimeoutMs);
  } catch (err) {
    await close();
    throw err;
  }

  return {
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    run,
    waitForExit,
    close,
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

let cleanupPromise = null;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of activeChildProcesses) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore already exited child
      }
    }
    activeChildProcesses.clear();
    if (adapter) {
      await adapter.applySftpAccess({ users: [] }).catch(() => undefined);
    }
    const containerList = new Set([
      ...createdContainers,
      sftpContainerName,
      siteContainerName,
      chownContainerName,
      seedContainerName,
      statContainerName,
    ]);
    for (const c of containerList) {
      await docker(["rm", "-f", c]);
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

  let initialSiteInspect = null;
  let pwA = "";
  let pwA2 = "";
  let pwB = "";
  let userA = null;
  let userA2 = null;
  let userB = null;
  let localUpPath = "";
  let upContent = "";
  let secretBContent = "";

  try {
    await runStep(
      "setup",
      async () => {
        port = await getFreeLoopbackPort();
        assert(
          Number.isInteger(port) && port > 1024 && !FORBIDDEN_HOST_PORTS.has(port),
          "ephemeral unprivileged port on 127.0.0.1",
          String(port),
        );

        const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hp_swarmtest_sftp-"));
        tempDirs.push(tmpRoot);
        stateDir = path.join(tmpRoot, "state");
        secretsDir = path.join(tmpRoot, "secrets");
        ingressDir = path.join(tmpRoot, "ingress");
        workDir = path.join(tmpRoot, "client");

        await mkdir(stateDir, { mode: 0o700 });
        await chmod(stateDir, 0o700);
        await mkdir(secretsDir, { mode: 0o700 });
        await mkdir(ingressDir, { mode: 0o700 });
        await mkdir(workDir, { mode: 0o700 });

        askpassPath = path.join(workDir, "askpass.sh");
        await writeFile(askpassPath, '#!/bin/sh\nprintf \'%s\\n\' "$HP_SWARMTEST_PW"\n', {
          mode: 0o700,
        });
        await chmod(askpassPath, 0o700);

        knownHostsPath = path.join(workDir, "known_hosts");
        upContent = `hello-${runId}\n`;
        localUpPath = path.join(workDir, "up.txt");
        await writeFile(localUpPath, upContent, "utf8");

        secretBContent = `secret-b-${runId}\n`;
        const localSeedBPath = path.join(workDir, "secret-b.txt");
        await writeFile(localSeedBPath, secretBContent, "utf8");

        adapter = createAdapter();
        const pingOk = await adapter.pingEngine();
        assert(pingOk, "Docker Engine ping returns true", `pingEngine=${String(pingOk)}`);

        const imgRes = await docker(["image", "inspect", SFTP_IMAGE]);
        assert(imgRes.ok, `SFTP image ${SFTP_IMAGE} present locally`, imgRes.stderr);

        for (const vol of [volA, volB]) {
          const cr = await docker(["volume", "create", vol]);
          assert(cr.ok, `volume ${vol} created`, cr.stderr);
          createdVolumes.add(vol);

          const ch = await docker([
            "run",
            "--rm",
            "--name",
            chownContainerName,
            "--network",
            "none",
            "--entrypoint",
            "chown",
            "-v",
            `${vol}:/v`,
            SFTP_IMAGE,
            "33:33",
            "/v",
          ]);
          assert(ch.ok, `volume ${vol} chowned 33:33`, ch.stderr);
        }

        const seedRes = await docker([
          "run",
          "--rm",
          "--name",
          seedContainerName,
          "--network",
          "none",
          "--user",
          "33:33",
          "--entrypoint",
          "cp",
          "-v",
          `${volB}:/v`,
          "-v",
          `${localSeedBPath}:/seed.txt:ro`,
          SFTP_IMAGE,
          "/seed.txt",
          "/v/secret-b.txt",
        ]);
        assert(seedRes.ok, "marker secret-b.txt seeded in volume B", seedRes.stderr);

        createdContainers.add(siteContainerName);
        const siteRun = await docker([
          "run",
          "-d",
          "--name",
          siteContainerName,
          "--network",
          "none",
          "--entrypoint",
          "sleep",
          "-v",
          `${volA}:/var/www/html`,
          STANDIN_SITE_IMAGE,
          "infinity",
        ]);
        assert(siteRun.ok, "stand-in site container starts", siteRun.stderr);

        initialSiteInspect = await dockerInspectContainer(siteContainerName);
        assert(
          initialSiteInspect !== null && initialSiteInspect.State?.Running === true,
          "stand-in site container running",
          JSON.stringify(initialSiteInspect?.State ?? null),
        );
      },
      { abortOnFail: true },
    );

    if (!fatalSetupFailure) {
      await runStep(
        "apply-user-a",
        async () => {
          pwA = randomBytes(18).toString("base64url");
          userA = {
            username: "s1a2b3c4d_usera",
            passwordHash: sha512Crypt(pwA),
            siteId: "sa",
            serviceInstanceId: "a",
          };

          const applyRes = await adapter.applySftpAccess({ users: [userA] });
          createdNetwork = true;
          createdContainers.add(sftpContainerName);
          assert(applyRes.applied === 1, "applied=1", `applied=${String(applyRes.applied)}`);

          const status = await adapter.getSftpStatus();
          assert(status.running === true, "status.running=true", String(status.running));
          assert(status.port === port, `status.port=${port}`, String(status.port));
          assert(
            typeof status.hostKeyFingerprint === "string" &&
              /^SHA256:[A-Za-z0-9+/]{43}$/.test(status.hostKeyFingerprint),
            "valid SHA256 hostKeyFingerprint",
            String(status.hostKeyFingerprint),
          );

          const pubPath = path.join(stateDir, "etc", "ssh_host_ed25519_key.pub");
          const keygen = await execCmd("ssh-keygen", ["-lf", pubPath]);
          assert(keygen.ok, "ssh-keygen -lf succeeds", keygen.stderr);
          const match = keygen.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
          const cliFingerprint = match ? match[0].replace(/=+$/, "") : "";
          assert(
            cliFingerprint === status.hostKeyFingerprint,
            `fingerprint matches ssh-keygen (${cliFingerprint})`,
            String(status.hostKeyFingerprint),
          );

          const pubLine = (await readFile(pubPath, "utf8")).trim();
          await writeFile(knownHostsPath, `[127.0.0.1]:${String(port)} ${pubLine}\n`, "utf8");
        },
        { abortOnFail: true },
      );
    }

    if (!fatalSetupFailure) {
      await runStep("container-hardening", async () => {
        const info = await dockerInspectContainer(sftpContainerName);
        assert(info !== null, `container ${sftpContainerName} exists`, "not found");

        const hc = info.HostConfig ?? {};
        assert(hc.Privileged === false, "Privileged=false", String(hc.Privileged));
        assert(hc.ReadonlyRootfs === true, "ReadonlyRootfs=true", String(hc.ReadonlyRootfs));

        const capDrop = Array.isArray(hc.CapDrop) ? [...hc.CapDrop] : [];
        assert(
          capDrop.length === 1 && capDrop[0] === "ALL",
          "CapDrop=[ALL]",
          JSON.stringify(capDrop),
        );

        const capAdd = Array.isArray(hc.CapAdd) ? [...hc.CapAdd].sort() : [];
        assert(
          JSON.stringify(capAdd) === JSON.stringify(["SETGID", "SETUID", "SYS_CHROOT"]),
          "CapAdd=[SETGID,SETUID,SYS_CHROOT]",
          JSON.stringify(capAdd),
        );

        const secOpt = Array.isArray(hc.SecurityOpt) ? hc.SecurityOpt : [];
        assert(
          secOpt.some((s) => s === "no-new-privileges:true" || s === "no-new-privileges"),
          "SecurityOpt includes no-new-privileges",
          JSON.stringify(secOpt),
        );

        assert(hc.Memory === 268_435_456, "Memory=256MiB", String(hc.Memory));
        assert(hc.MemorySwap === 268_435_456, "MemorySwap=256MiB", String(hc.MemorySwap));
        assert(hc.PidsLimit === 512, "PidsLimit=512", String(hc.PidsLimit));
        assert(hc.NanoCpus === 500_000_000, "NanoCpus=0.5", String(hc.NanoCpus));

        const resolvedState = path.resolve(stateDir);
        const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
        for (const m of mounts) {
          const src = String(m.Source ?? "");
          const dst = String(m.Destination ?? "");
          assert(
            !src.includes("docker.sock") && !dst.includes("docker.sock"),
            "no docker.sock mount",
            JSON.stringify(m),
          );
          if (m.Type === "bind") {
            const insideState =
              src === resolvedState || src.startsWith(`${resolvedState}${path.sep}`);
            assert(
              insideState,
              `bind mount inside ${resolvedState}`,
              src,
            );
          }
        }

        const netInfo = await dockerInspectNetwork(networkName);
        assert(netInfo !== null, `network ${networkName} exists`, "not found");
        const netContainers = Object.keys(netInfo.Containers ?? {});
        assert(
          netContainers.length === 1 && netContainers[0] === info.Id,
          `network ${networkName} holds only ${sftpContainerName}`,
          JSON.stringify(netContainers),
        );
      });

      await runStep("upload-and-ownership", async () => {
        const ready = await waitForSftpReady(userA.username, pwA);
        assert(ready?.ok === true, "sshd ready for SFTP login", ready?.stderr || ready?.stdout);

        const putRes = await runSftp(userA.username, pwA, [`put ${localUpPath} up.txt`]);
        assert(putRes.ok, "sftp put up.txt succeeds", putRes.stderr || putRes.stdout);

        const statRes = await docker([
          "run",
          "--rm",
          "--name",
          statContainerName,
          "--network",
          "none",
          "--entrypoint",
          "stat",
          "-v",
          `${volA}:/v:ro`,
          SFTP_IMAGE,
          "-c",
          "%u:%g",
          "/v/up.txt",
        ]);
        assert(
          statRes.ok && statRes.stdout.trim() === "33:33",
          "uploaded file ownership 33:33",
          `${statRes.stdout.trim()} ${statRes.stderr.trim()}`.trim(),
        );
      });

      await runStep("confinement", async () => {
        const stolenPath = path.join(workDir, "stolen-passwd.txt");
        const getPasswd = await runSftp(userA.username, pwA, [`get /etc/passwd ${stolenPath}`]);
        assert(
          !getPasswd.ok && !(await exists(stolenPath)),
          "get /etc/passwd fails",
          `code=${getPasswd.code} exists=${String(await exists(stolenPath))}`,
        );

        const lsRoot = await runSftp(userA.username, pwA, ["ls -a /"]);
        assert(lsRoot.ok, "ls -a / succeeds", lsRoot.stderr);
        const entries = lsRoot.stdout
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0 && !l.trim().startsWith("sftp>"))
          .flatMap((l) => l.trim().split(/\s+/))
          .filter((t) => t.length > 0)
          .map((t) => t.replace(/^\/+/, ""));
        assert(
          JSON.stringify([...entries].sort()) === JSON.stringify([".", "..", "files"]),
          "root lists only ., .., files",
          JSON.stringify(entries),
        );

        const cdUp = await runSftp(userA.username, pwA, ["cd ..", "pwd"]);
        assert(cdUp.ok, "cd .. && pwd succeeds", cdUp.stderr);
        assert(
          /Remote working directory:\s*\/\s*$/m.test(cdUp.stdout),
          "cd .. stays at /",
          cdUp.stdout.trim(),
        );
      });

      await runStep("second-site-isolation", async () => {
        const before = await dockerInspectContainer(sftpContainerName);
        assert(before !== null, "container exists before adding site B", "missing");

        pwB = randomBytes(18).toString("base64url");
        userB = {
          username: "s9f8e7d6c_userb",
          passwordHash: sha512Crypt(pwB),
          siteId: "sb",
          serviceInstanceId: "b",
        };

        const applyRes = await adapter.applySftpAccess({ users: [userA, userB] });
        assert(applyRes.applied === 2, "applied=2", `applied=${String(applyRes.applied)}`);

        const after = await dockerInspectContainer(sftpContainerName);
        assert(after !== null && after.Id !== before.Id, "container recreated with new Id", after?.Id);

        const readyB = await waitForSftpReady(userB.username, pwB);
        assert(readyB?.ok === true, "recreated sshd ready", readyB?.stderr || readyB?.stdout);

        const outAbs = path.join(workDir, "cross-abs.txt");
        const tryAbs = await runSftp(userA.username, pwA, [
          `get /srv/sftp/sb/files/secret-b.txt ${outAbs}`,
        ]);
        assert(
          !tryAbs.ok && !(await exists(outAbs)),
          "user A cannot read /srv/sftp/sb/files/secret-b.txt",
          `code=${tryAbs.code}`,
        );

        const outRel = path.join(workDir, "cross-rel.txt");
        const tryRel = await runSftp(userA.username, pwA, [
          `get ../sb/files/secret-b.txt ${outRel}`,
        ]);
        assert(
          !tryRel.ok && !(await exists(outRel)),
          "user A cannot read ../sb/files/secret-b.txt",
          `code=${tryRel.code}`,
        );

        const outOwnB = path.join(workDir, "own-b.txt");
        const getOwnB = await runSftp(userB.username, pwB, [`get secret-b.txt ${outOwnB}`]);
        assert(getOwnB.ok, "user B gets secret-b.txt", getOwnB.stderr);
        const gotB = await readFile(outOwnB, "utf8");
        assert(gotB === secretBContent, "secret-b.txt content matches", gotB);
      });

      await runStep("symlink-escape", async () => {
        const mkLinks = await runSftp(userA.username, pwA, [
          "symlink /etc/passwd sym_etc_passwd",
          "symlink /srv/sftp/sb/files/secret-b.txt sym_site_b",
          "symlink ../../../../etc/passwd sym_rel_etc",
          "symlink ../../../sb/files/secret-b.txt sym_rel_site_b",
          "symlink up.txt sym_in_site",
        ]);
        assert(mkLinks.ok, "create symlinks via SFTP succeeds", mkLinks.stderr);

        const escapeTargets = [
          ["sym_etc_passwd", "sym_etc_passwd.out"],
          ["sym_site_b", "sym_site_b.out"],
          ["sym_rel_etc", "sym_rel_etc.out"],
          ["sym_rel_site_b", "sym_rel_site_b.out"],
        ];
        for (const [linkName, localName] of escapeTargets) {
          const outPath = path.join(workDir, localName);
          const res = await runSftp(userA.username, pwA, [`get ${linkName} ${outPath}`]);
          assert(
            !res.ok && !(await exists(outPath)),
            `symlink ${linkName} cannot be read outside chroot`,
            `code=${res.code} exists=${String(await exists(outPath))}`,
          );
        }

        const inSiteOut = path.join(workDir, "sym_in_site.out");
        const inSiteRes = await runSftp(userA.username, pwA, [`get sym_in_site ${inSiteOut}`]);
        assert(inSiteRes.ok, "in-site symlink resolves inside own root", inSiteRes.stderr);
        const inSiteData = await readFile(inSiteOut, "utf8");
        assert(inSiteData === upContent, "in-site symlink matches up.txt", inSiteData);

        await runSftp(userA.username, pwA, [
          "rm sym_etc_passwd",
          "rm sym_site_b",
          "rm sym_rel_etc",
          "rm sym_rel_site_b",
          "rm sym_in_site",
        ]);
      });

      await runStep("no-shell-no-pty", async () => {
        const noTty = await runSsh(userA.username, pwA, ["-n", "-T"], ["id"]);
        const combinedNoTty = `${noTty.stdout}\n${noTty.stderr}`;
        assert(!/uid=/.test(combinedNoTty), "no shell execution on ssh -T id", combinedNoTty);

        const withPty = await runSsh(userA.username, pwA, ["-tt"], ["id"]);
        const combinedPty = `${withPty.stdout}\n${withPty.stderr}`;
        assert(
          /PTY allocation request failed/i.test(combinedPty),
          "PTY allocation refused",
          combinedPty,
        );
        assert(!/uid=/.test(combinedPty), "no uid= output on ssh -tt id", combinedPty);
      });

      await runStep("no-forwarding", async () => {
        const fwdW = await runSsh(userA.username, pwA, ["-n", "-N", "-W", "127.0.0.1:22"]);
        assert(fwdW.code === 255, "ssh -W exits 255", `code=${fwdW.code}`);
        assert(
          /administratively prohibited/i.test(fwdW.stderr),
          "ssh -W reports administratively prohibited",
          fwdW.stderr.trim(),
        );

        const t0 = performance.now();
        const fwdR = await runSsh(
          userA.username,
          pwA,
          ["-n", "-N", "-oExitOnForwardFailure=yes", "-R", "0:127.0.0.1:1"],
          [],
          { timeoutMs: 15_000 },
        );
        const elapsedMs = performance.now() - t0;
        assert(
          !fwdR.killed && fwdR.code === 255 && elapsedMs < 15_000,
          "ssh -R exits 255 within 15s",
          `code=${fwdR.code} killed=${String(fwdR.killed)} ms=${Math.round(elapsedMs)} stderr=${fwdR.stderr.trim()}`,
        );
      });

      await runStep("second-user-no-recreate", async () => {
        const before = await dockerInspectContainer(sftpContainerName);
        assert(before !== null, "container exists before adding user A2", "missing");
        const passwdStatBefore = await stat(path.join(stateDir, "users", "passwd"));

        pwA2 = randomBytes(18).toString("base64url");
        userA2 = {
          username: "s1a2b3c4d_usera2",
          passwordHash: sha512Crypt(pwA2),
          siteId: "sa",
          serviceInstanceId: "a",
        };

        const applyRes = await adapter.applySftpAccess({ users: [userA, userA2, userB] });
        assert(applyRes.applied === 3, "applied=3", `applied=${String(applyRes.applied)}`);

        const after = await dockerInspectContainer(sftpContainerName);
        assert(after !== null && after.Id === before.Id, "Id unchanged", `${before.Id} vs ${after?.Id}`);
        assert(
          after.State?.StartedAt === before.State?.StartedAt,
          "StartedAt unchanged",
          `${before.State?.StartedAt} vs ${after.State?.StartedAt}`,
        );

        const passwdStatAfter = await stat(path.join(stateDir, "users", "passwd"));
        assert(
          passwdStatAfter.ino === passwdStatBefore.ino,
          "passwd inode unchanged",
          `${passwdStatBefore.ino} vs ${passwdStatAfter.ino}`,
        );

        const lsA2 = await runSftp(userA2.username, pwA2, ["ls -la"]);
        assert(
          lsA2.ok && lsA2.stdout.includes("up.txt"),
          "user A2 logs in immediately and sees up.txt",
          `${lsA2.stdout} ${lsA2.stderr}`.trim(),
        );
      });

      await runStep("serves-without-panel", async () => {
        const statusBefore = await adapter.getSftpStatus();
        const fpBefore = statusBefore.hostKeyFingerprint;
        assert(typeof fpBefore === "string", "initial fingerprint present", String(fpBefore));

        // (a) docker restart of our SFTP container keeps serving with the same host key.
        const restartRes = await docker(["restart", sftpContainerName]);
        assert(restartRes.ok, `docker restart ${sftpContainerName} succeeds`, restartRes.stderr);

        const readyAfterRestart = await waitForSftpReady(userA2.username, pwA2);
        assert(
          readyAfterRestart?.ok === true,
          "existing user A2 logs in after docker restart with same known_hosts",
          readyAfterRestart?.stderr || readyAfterRestart?.stdout,
        );
        const statusAfterRestart = await adapter.getSftpStatus();
        assert(
          statusAfterRestart.hostKeyFingerprint === fpBefore,
          `hostKeyFingerprint unchanged after restart (${fpBefore})`,
          String(statusAfterRestart.hostKeyFingerprint),
        );

        // (b) A brand-new adapter calling ensureSftpFromState() keeps the same container Id and StartedAt.
        const beforeEnsure = await dockerInspectContainer(sftpContainerName);
        assert(beforeEnsure !== null, "container exists before ensureSftpFromState", "missing");

        adapter = null;
        const freshAdapter = createAdapter();
        const ensureRes = await freshAdapter.ensureSftpFromState();
        assert(
          ensureRes !== null && ensureRes.applied === 3,
          "fresh ensureSftpFromState returns applied=3",
          JSON.stringify(ensureRes),
        );
        adapter = freshAdapter;

        const afterEnsure = await dockerInspectContainer(sftpContainerName);
        assert(
          afterEnsure !== null && afterEnsure.Id === beforeEnsure.Id,
          "container Id unchanged after ensureSftpFromState",
          `${beforeEnsure.Id} vs ${afterEnsure?.Id}`,
        );
        assert(
          afterEnsure.State?.StartedAt === beforeEnsure.State?.StartedAt,
          "State.StartedAt unchanged after ensureSftpFromState",
          `${beforeEnsure.State?.StartedAt} vs ${afterEnsure.State?.StartedAt}`,
        );

        const outPath = path.join(workDir, "no-panel-up.txt");
        const res = await runSftp(userA2.username, pwA2, [`get up.txt ${outPath}`]);
        assert(res.ok, "login still works after ensureSftpFromState", res.stderr);
        const got = await readFile(outPath, "utf8");
        assert(got === upContent, "downloaded up.txt matches", got);
      });

      await runStep("many-sessions", async () => {
        const sessions = [];
        const totalSessions = 20;
        const batchSize = 4;
        try {
          // Open in small batches so PerSourceMaxStartups 10 is never exceeded during auth.
          for (let offset = 0; offset < totalSessions; offset += batchSize) {
            const batchCount = Math.min(batchSize, totalSessions - offset);
            const opened = await Promise.all(
              Array.from({ length: batchCount }, () =>
                openSftpSession(userA.username, pwA, { timeoutMs: 20_000 }),
              ),
            );
            sessions.push(...opened);
          }
          assert(
            sessions.length === totalSessions && sessions.every((s) => !s.exited),
            `${totalSessions} concurrent sessions open for user A`,
            `open=${sessions.filter((s) => !s.exited).length}`,
          );

          const statsRes = await docker([
            "stats",
            "--no-stream",
            "--format",
            "{{.Name}} mem={{.MemUsage}} ({{.MemPerc}}) pids={{.PIDs}}",
            sftpContainerName,
          ]);
          assert(
            statsRes.ok && statsRes.stdout.trim().length > 0,
            "docker stats --no-stream succeeds",
            statsRes.stderr,
          );
          console.log(`INFO many-sessions stats: ${statsRes.stdout.trim()}`);

          const lsB = await runSftp(userB.username, pwB, ["ls -la"]);
          assert(
            lsB.ok && lsB.stdout.includes("secret-b.txt"),
            "user B logs in and lists secret-b.txt while 20 user A sessions are open",
            `${lsB.stdout} ${lsB.stderr}`.trim(),
          );

          assert(
            sessions.every((s) => !s.exited),
            "all 20 user A sessions stay open while user B logs in",
            `alive=${sessions.filter((s) => !s.exited).length}`,
          );
        } finally {
          await Promise.all(sessions.map((s) => s.close()));
        }
      });

      await runStep("site-deletion-volume-removal", async () => {
        const applyRes = await adapter.applySftpAccess({ users: [userA, userA2] });
        assert(applyRes.applied === 2, "applied=2 after removing site B", String(applyRes.applied));

        const rmVol = await docker(["volume", "rm", volB]);
        assert(rmVol.ok, `deleted site volume ${volB} can be removed`, rmVol.stderr);
        createdVolumes.delete(volB);

        const readyA = await waitForSftpReady(userA.username, pwA);
        assert(readyA?.ok === true, "remaining site user A still logs in", readyA?.stderr);
      });

      await runStep("delete-cuts-session", async () => {
        const before = await dockerInspectContainer(sftpContainerName);
        assert(before !== null, "container exists before deleting user A2", "missing");

        const sessionA2 = await openSftpSession(userA2.username, pwA2);
        try {
          const initialLs = await sessionA2.run("ls -la");
          assert(initialLs.includes("up.txt"), "open A2 session sees up.txt", initialLs);

          const applyRes = await adapter.applySftpAccess({ users: [userA] });
          assert(applyRes.applied === 1, "applied=1 after removing A2", String(applyRes.applied));

          const after = await dockerInspectContainer(sftpContainerName);
          assert(
            after !== null && after.State?.StartedAt !== before.State?.StartedAt,
            "StartedAt changed after deleting user A2",
            `${before.State?.StartedAt} vs ${after?.State?.StartedAt}`,
          );

          let cutConfirmed = false;
          const exitCheck = await sessionA2.waitForExit(3_000);
          if (exitCheck.exited) {
            cutConfirmed = true;
          } else {
            let cmdFailed = false;
            try {
              await sessionA2.run("ls -la", 4_000);
            } catch {
              cmdFailed = true;
            }
            const afterCmdExit = await sessionA2.waitForExit(2_000);
            cutConfirmed = cmdFailed || afterCmdExit.exited;
          }
          assert(
            cutConfirmed,
            "open session of deleted user A2 ends or fails within a few seconds",
            `exited=${String(sessionA2.exited)} code=${String(sessionA2.exitCode)}`,
          );
        } finally {
          await sessionA2.close();
        }

        const readyA = await waitForSftpReady(userA.username, pwA);
        assert(readyA?.ok === true, "remaining site user A logs in again", readyA?.stderr);

        const refusedA2 = await runSftp(userA2.username, pwA2, ["pwd"]);
        assert(
          !refusedA2.ok && refusedA2.code === 255,
          "new login of deleted user A2 is refused",
          `code=${refusedA2.code}`,
        );
        assert(
          /Permission denied/i.test(refusedA2.stderr),
          "deleted user A2 fails with Permission denied",
          refusedA2.stderr.trim(),
        );
      });

      await runStep("add-user-no-restart", async () => {
        const before = await dockerInspectContainer(sftpContainerName);
        assert(before !== null, "container exists before adding second user to site A", "missing");

        const sessionA = await openSftpSession(userA.username, pwA);
        try {
          const lsBefore = await sessionA.run("ls -la");
          assert(lsBefore.includes("up.txt"), "open user A session lists up.txt before apply", lsBefore);

          const applyRes = await adapter.applySftpAccess({ users: [userA, userA2] });
          assert(applyRes.applied === 2, "applied=2 after adding A2 back", String(applyRes.applied));

          const after = await dockerInspectContainer(sftpContainerName);
          assert(after !== null && after.Id === before.Id, "Id unchanged", `${before.Id} vs ${after?.Id}`);
          assert(
            after.State?.StartedAt === before.State?.StartedAt,
            "StartedAt unchanged",
            `${before.State?.StartedAt} vs ${after.State?.StartedAt}`,
          );

          const lsAfter = await sessionA.run("ls -la");
          assert(
            lsAfter.includes("up.txt"),
            "already-open user A session still lists up.txt after apply",
            lsAfter,
          );
        } finally {
          await sessionA.close();
        }

        const lsA2 = await runSftp(userA2.username, pwA2, ["ls -la"]);
        assert(
          lsA2.ok && lsA2.stdout.includes("up.txt"),
          "new user A2 logs in and lists up.txt",
          `${lsA2.stdout} ${lsA2.stderr}`.trim(),
        );
      });

      await runStep("new-password", async () => {
        const before = await dockerInspectContainer(sftpContainerName);
        assert(before !== null, "container exists before password change", "missing");

        const oldPwA2 = pwA2;
        const newPwA2 = randomBytes(18).toString("base64url");
        const updatedA2 = {
          ...userA2,
          passwordHash: sha512Crypt(newPwA2),
        };

        const applyRes = await adapter.applySftpAccess({ users: [userA, updatedA2] });
        assert(applyRes.applied === 2, "applied=2 after password change", String(applyRes.applied));

        const after = await dockerInspectContainer(sftpContainerName);
        assert(
          after !== null && after.State?.StartedAt !== before.State?.StartedAt,
          "StartedAt changed after password change",
          `${before.State?.StartedAt} vs ${after?.State?.StartedAt}`,
        );

        // Wait until sshd is accepting logins so the old-password test proves auth refusal, not startup lag.
        const readyA = await waitForSftpReady(userA.username, pwA);
        assert(readyA?.ok === true, "sshd ready after password change restart", readyA?.stderr);

        const oldRes = await runSftp(updatedA2.username, oldPwA2, ["pwd"]);
        assert(
          !oldRes.ok && oldRes.code === 255,
          "old password is refused",
          `code=${oldRes.code}`,
        );
        assert(
          /Permission denied/i.test(oldRes.stderr),
          "old password fails with Permission denied",
          oldRes.stderr.trim(),
        );

        const newRes = await runSftp(updatedA2.username, newPwA2, ["ls -la"]);
        assert(
          newRes.ok && newRes.stdout.includes("up.txt"),
          "new password is accepted and lists up.txt",
          `${newRes.stdout} ${newRes.stderr}`.trim(),
        );

        pwA2 = newPwA2;
        userA2 = updatedA2;
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
          current.RestartCount === 0,
          "RestartCount=0",
          String(current.RestartCount),
        );
        const execIds = Array.isArray(current.ExecIDs) ? current.ExecIDs : [];
        assert(
          execIds.length === 0,
          "no docker exec ever run on site container",
          JSON.stringify(execIds),
        );
      });

      await runStep("empty-apply-preserves-host-key", async () => {
        const statusBefore = await adapter.getSftpStatus();
        const fpBefore = statusBefore.hostKeyFingerprint;
        assert(typeof fpBefore === "string", "initial fingerprint present", String(fpBefore));

        const emptyRes = await adapter.applySftpAccess({ users: [] });
        assert(emptyRes.applied === 0, "empty apply returns applied=0", String(emptyRes.applied));

        const gone = await dockerInspectContainer(sftpContainerName);
        assert(gone === null, "container removed after empty apply", gone?.Id ?? "present");

        const statusEmpty = await adapter.getSftpStatus();
        assert(statusEmpty.running === false, "status.running=false", String(statusEmpty.running));
        assert(
          statusEmpty.hostKeyFingerprint === fpBefore,
          "fingerprint preserved after empty apply",
          String(statusEmpty.hostKeyFingerprint),
        );
        assert(
          await exists(path.join(stateDir, "etc", "ssh_host_ed25519_key")),
          "private host key file still on disk",
          "missing",
        );

        const reRes = await adapter.applySftpAccess({ users: [userA] });
        assert(reRes.applied === 1, "re-apply returns applied=1", String(reRes.applied));

        const statusAfter = await adapter.getSftpStatus();
        assert(statusAfter.running === true, "status.running=true after re-apply", String(statusAfter.running));
        assert(
          statusAfter.hostKeyFingerprint === fpBefore,
          `same fingerprint after re-apply (${fpBefore})`,
          String(statusAfter.hostKeyFingerprint),
        );

        const readyAfter = await waitForSftpReady(userA.username, pwA);
        assert(readyAfter?.ok === true, "login succeeds with same known_hosts", readyAfter?.stderr);
      });

      await runStep("wrong-password-penalty", async () => {
        const wrongPw = `${pwA}_wrong`;
        // sshd_config uses PerSourcePenalties authfail:10s min:15s, so 2 auth failures (20s >= 15s) trigger the block.
        for (let i = 1; i <= 2; i += 1) {
          const bad = await runSftp(userA.username, wrongPw, ["pwd"]);
          assert(bad.code === 255, `wrong login #${i} exits 255`, `code=${bad.code}`);
          assert(
            /Permission denied/i.test(bad.stderr),
            `wrong login #${i} reports Permission denied`,
            bad.stderr.trim(),
          );
        }

        const penalized = await runSftp(userA.username, pwA, ["pwd"]);
        assert(
          penalized.code === 255,
          "correct login during penalty refused (exit 255)",
          `code=${penalized.code}`,
        );
        assert(
          !/Permission denied/i.test(penalized.stderr),
          "penalized refusal happens before auth (no Permission denied)",
          penalized.stderr.trim(),
        );
        assert(
          /Connection (closed|reset)|kex_exchange_identification|banner/i.test(penalized.stderr),
          "penalized refusal shows connection closed/reset",
          penalized.stderr.trim(),
        );

        let recovered = false;
        let lastRecovery = null;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await sleep(5_000);
          lastRecovery = await runSftp(userA.username, pwA, ["pwd"]);
          if (lastRecovery.ok) {
            recovered = true;
            break;
          }
        }
        assert(
          recovered,
          "correct login succeeds again within 120s",
          lastRecovery ? `code=${lastRecovery.code} stderr=${lastRecovery.stderr.trim()}` : "timed out",
        );
      });
    }
  } finally {
    await cleanup();
  }

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`accept-m1-sftp: ${passed}/${total} passed in ${elapsedSec}s`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`FAIL fatal: ${formatErr(err)}`);
  await cleanup();
  process.exit(1);
});
