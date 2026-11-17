#!/usr/bin/env node
/**
 * Real-Docker acceptance check for M5b (panel container state and logs, D26).
 *
 * Drives the built DockerEngineSocketAdapter helpers inspectPanelContainer(name) and
 * readContainerLogs(name, tail) against one throw-away busybox container, plus the
 * phpMyAdmin mask on a real log line.
 *
 * Machine safety: the only container is hp_swarmtest_m5h_<hex>_a, made from a local image
 * (never pulled), NetworkMode none, no port, no bind; it is removed by exact name in
 * `finally` and on SIGINT/SIGTERM. No other name is ever inspected.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const { DockerEngineSocketAdapter, ExecutorCodedError } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/index.js")).href
);
const { maskPhpMyAdminQuery } = await import(
  pathToFileURL(path.resolve(repoRoot, "apps/docker-executor/dist/docker-logs.js")).href
);

const IMAGE = "busybox:latest";
const runPrefix = `hp_swarmtest_m5h_${randomBytes(4).toString("hex")}`;
const nameA = `${runPrefix}_a`;
// The access line a real phpMyAdmin wrote for a request with a token and SQL (arch-exec [ran]).
const PMA_LINE =
  '172.30.0.1 - u [16/Nov/2026:10:00:00 +0000] "GET /index.php?route=/sql&db=wp&token=MADEUPTOKEN123&sql_query=SELECT+1 HTTP/1.0" 200 512 "http://x/phpmyadmin/s1/" "agent"';

const created = new Set();
let tmpDir = null;

function docker(args) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const name of created) await docker(["rm", "-f", "-v", name]);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / ${actual}`);
}
const fmt = (err) => (err instanceof ExecutorCodedError ? `${err.code}: ${err.message}` : String(err?.message ?? err));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function codeOf(promise) {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return err?.code ?? fmt(err);
  }
}

async function main() {
  let passed = 0;
  let total = 0;
  let setupFailed = false;
  const step = async (name, fn) => {
    total += 1;
    if (setupFailed) {
      console.log(`FAIL ${name}: skipped after setup failure`);
      return;
    }
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${fmt(err)}`);
      if (name === "1-container") setupFailed = true;
    }
  };

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}-`));
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: "/var/run/docker.sock",
    pullMissingImages: false,
    secretsRootDir: path.join(tmpDir, "secrets"),
    ingressRootDir: path.join(tmpDir, "ingress"),
  });

  try {
    await step("1-container", async () => {
      const img = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
      assert(img.code === 0, `${IMAGE} present locally`, img.stderr.trim());
      created.add(nameA);
      const script = 'echo ready; echo err-line >&2; printf "%3000s\\n" "" | tr " " x; echo "$PMA_LINE"; exec sleep 600';
      const run = await docker([
        "run", "-d", "--pull", "never", "--network", "none", "--log-driver", "json-file",
        "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "-e", `PMA_LINE=${PMA_LINE}`,
        "--name", nameA, IMAGE, "sh", "-c", script,
      ]);
      assert(run.code === 0, "container started", run.stderr.trim());
      for (let i = 0; i < 50 && (await adapter.readContainerLogs(nameA, 500)).length < 4; i += 1) await sleep(100);
    });

    await step("2-inspect-running", async () => {
      const seen = await adapter.inspectPanelContainer(nameA);
      assert(seen.state === "running", "state running", seen.state);
      const age = Date.now() - Date.parse(seen.startedAt ?? "");
      assert(age >= -5_000 && age < 60_000, "startedAt under 60 s old", String(seen.startedAt));
      assert(seen.restartCount === 0, "restartCount 0", String(seen.restartCount));
      assert(!JSON.stringify(seen).match(/[0-9a-f]{64}/), "no Docker id", JSON.stringify(seen));
    });

    await step("3-logs", async () => {
      const two = await adapter.readContainerLogs(nameA, 2);
      assert(two.length === 2, "tail 2 gives 2 lines", String(two.length));
      const all = await adapter.readContainerLogs(nameA, 500);
      const texts = all.map((l) => l.text);
      assert(all.some((l) => l.stream === "stdout" && l.text === "ready"), "stdout line", JSON.stringify(texts));
      assert(all.some((l) => l.stream === "stderr" && l.text === "err-line"), "stderr line", JSON.stringify(texts));
      assert(all.some((l) => l.text === "x".repeat(2000)), "3000-char line cut to 2000", texts.map((t) => t.length).join(","));
      assert(all.every((l) => l.at !== null), "every line has a timestamp", JSON.stringify(all.map((l) => l.at)));
      const pma = all.find((l) => l.text.includes("index.php"));
      assert(pma?.text === PMA_LINE, "phpMyAdmin line read verbatim", String(pma?.text));
      const masked = maskPhpMyAdminQuery(pma.text);
      assert(!masked.includes("MADEUPTOKEN123") && !masked.includes("sql_query"), "mask removes token and SQL", masked);
    });

    await step("4-stopped-then-missing", async () => {
      const stop = await docker(["stop", "-t", "1", nameA]);
      assert(stop.code === 0, "stopped", stop.stderr.trim());
      const stopped = await adapter.inspectPanelContainer(nameA);
      assert(stopped.state === "stopped", "state stopped", stopped.state);
      const removed = await docker(["rm", "-f", "-v", nameA]);
      assert(removed.code === 0, "removed", removed.stderr.trim());
      const gone = await adapter.inspectPanelContainer(nameA);
      assert(gone.state === "missing" && gone.startedAt === null, "state missing", JSON.stringify(gone));
      const code = await codeOf(adapter.readContainerLogs(nameA, 5));
      assert(code === "NOT_FOUND", "logs NOT_FOUND", code);
    });

    await step("5-engine-unreachable", async () => {
      const dead = new DockerEngineSocketAdapter({
        dockerSocketPath: path.join(tmpDir, "absent.sock"),
        pullMissingImages: false,
        secretsRootDir: path.join(tmpDir, "secrets"),
        ingressRootDir: path.join(tmpDir, "ingress"),
      });
      const code = await codeOf(dead.inspectPanelContainer(nameA));
      assert(code === "DOCKER_ENGINE_UNAVAILABLE", "DOCKER_ENGINE_UNAVAILABLE", code);
    });
  } finally {
    await cleanup();
    total += 1;
    const left = await docker(["ps", "-a", "--filter", `name=${runPrefix}`, "-q"]);
    if (left.code === 0 && left.stdout.trim() === "") {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: ${left.stdout.trim() || left.stderr.trim()}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
