#!/usr/bin/env node
/**
 * Real-Docker acceptance check for M5c (the site terminal and the panel restart, D13, D14, D18, D24).
 *
 * Drives the built DockerEngineSocketAdapter terminal calls (open, write, read, close, list) on a
 * throw-away WordPress container A built with the shipped hardened payload, and restartContainerByName
 * on A by its name while container B must not move.
 *
 * Machine safety: every object is named hp_swarmtest_m5t_<hex>_<suffix> (one internal network, two
 * containers, their two html volumes), made from a local image (never pulled), with no port and no host
 * bind. Everything is removed by exact name in `finally` and on SIGINT/SIGTERM. The reaper is never run
 * here, and no panel container name is ever touched. Terminal output is matched, never printed.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (p) => import(pathToFileURL(path.resolve(repoRoot, p)).href);

const IMAGE = "wordpress:7.1.4-php8.4-apache";
const SOCKET = "/var/run/docker.sock";
const IDLE_MS = 4_000;
const runPrefix = `hp_swarmtest_m5t_${randomBytes(4).toString("hex")}`;
const net = `${runPrefix}_net`;
const box = (k) => ({ name: `${runPrefix}_${k}`, siteId: `${runPrefix}_${k}`, svc: `${runPrefix}_${k}_svc`, vol: `${runPrefix}_${k}_html` });
const A = box("a");
const B = box("b");
const PROMPT = "/var/www/html $ ";

const created = { containers: [], volumes: [], network: null };
let tmpDir = null;

function docker(args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** One Engine API call over the socket (only for creating this run's own objects). */
function engine(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath: SOCKET, method, path: p, timeout: 60_000, headers: data ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("engine call timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const name of created.containers) await docker(["rm", "-f", "-v", name]);
    for (const name of created.volumes) await docker(["volume", "rm", name]);
    if (created.network) await docker(["network", "rm", created.network]);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / ${String(actual).slice(0, 200)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sid = () => `term_${randomBytes(16).toString("hex")}`;
async function codeOf(promise) {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return err?.code ?? String(err?.message ?? err);
  }
}

// --- preflight: the image is local, or nothing is created ---
const img = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
if (img.code !== 0) {
  console.log(`SKIP ${IMAGE} is not on this machine; nothing was created (this script never pulls)`);
  process.exit(1);
}
const { DockerEngineSocketAdapter, ExecutorCodedError, buildHardenedContainerCreatePayload, restartContainerByName } =
  await load("apps/docker-executor/dist/index.js");
const { createApprovedServiceSpec } = await load("packages/executor-contracts/dist/index.js");
const fmt = (err) => (err instanceof ExecutorCodedError ? `${err.code}: ${err.message}` : String(err?.message ?? err));

/** Processes in A as 33:33: args lines, and how many carry a session mark. */
async function seenInA() {
  const ps = await docker(["exec", "-u", "33:33", A.name, "ps", "-eo", "args="]);
  const marked = await docker(["exec", "-u", "33:33", A.name, "sh", "-c",
    'n=0; for p in /proc/[0-9]*; do grep -qz "^HP_TERMINAL_SESSION=" "$p/environ" 2>/dev/null && n=$((n+1)); done; echo $n']);
  assert(ps.code === 0 && marked.code === 0, "second exec ran", ps.stderr.trim() || marked.stderr.trim());
  return { args: ps.stdout.split("\n").map((l) => l.trim()), marked: Number(marked.stdout.trim()) };
}

/** Process ids of the web server's www-data workers in A. */
async function apacheWorkersInA() {
  const ps = await docker(["exec", A.name, "ps", "-eo", "pid=,user=,comm="]);
  assert(ps.code === 0, "ps in A ran", ps.stderr.trim());
  return ps.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter(([, u, c]) => u === "www-data" && c === "apache2").map(([pid]) => pid);
}

/** Reads a session from `state.cursor` until `done(all output)` or its end; output stays in memory. */
async function readUntil(adapter, state, done, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await adapter.readTerminal({ sessionId: state.id, cursor: state.cursor });
    state.out += r.output;
    state.cursor = r.cursor;
    if (r.ended) return r.ended;
    if (done(state.out)) return null;
  }
  throw new StepAssertionError("expected output within the time / not seen");
}

/** Creates and starts one site container from the shipped hardened payload, on this run's network and volume. */
async function startSite(b) {
  const spec = createApprovedServiceSpec({
    serviceInstanceId: b.svc, siteId: b.siteId, organizationId: `${runPrefix}_org`, image: IMAGE, containerName: b.name,
    env: {}, resourceLimits: { cpuMilli: 1000, memoryBytes: "536870912" }, exposeHttp: true, internalPort: 80,
    volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
  });
  const payload = buildHardenedContainerCreatePayload(spec);
  // The product names its network and volume hp_site_/hp_vol_; this run keeps every name under its prefix.
  assert(payload.HostConfig.Binds.length === 1 && !payload.HostConfig.PortBindings, "one volume bind, no port", JSON.stringify(payload.HostConfig));
  payload.HostConfig.Binds = [`${b.vol}:/var/www/html`];
  payload.HostConfig.NetworkMode = net;
  payload.NetworkingConfig = { EndpointsConfig: { [net]: { Aliases: [b.name] } } };
  const vol = await docker(["volume", "create", b.vol]);
  assert(vol.code === 0, "volume created", vol.stderr.trim());
  created.volumes.push(b.vol);
  created.containers.push(b.name);
  const made = await engine("POST", `/containers/create?name=${b.name}`, payload);
  assert(made.status === 201, "container created", `${made.status} ${made.body}`);
  const started = await engine("POST", `/containers/${b.name}/start`);
  assert(started.status === 204, "container started", `${started.status} ${started.body}`);
}

const startedAt = async (name) => (await docker(["inspect", "--format", "{{.State.StartedAt}}", name])).stdout.trim();

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
      if (name === "1-setup") setupFailed = true;
    }
  };

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}-`));
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: SOCKET,
    pullMissingImages: false,
    secretsRootDir: path.join(tmpDir, "secrets"),
    ingressRootDir: path.join(tmpDir, "ingress"),
    terminalLimits: { idleMs: IDLE_MS, readWaitMs: 1_000 },
  });
  const target = adapter.execTarget; // the adapter's own Engine target (TS-private, reached for this check only)
  const s1 = { id: sid(), cursor: 0, out: "" };
  const s2 = { id: sid(), cursor: 0, out: "" };
  const s3 = { id: sid(), cursor: 0, out: "" };
  let s1Closed = null;
  let s2Opened = null;
  const before = {};

  try {
    await step("1-setup", async () => {
      const made = await engine("POST", "/networks/create", { Name: net, Driver: "bridge", Internal: true, CheckDuplicate: true });
      assert(made.status === 201, "internal network created", `${made.status} ${made.body}`);
      created.network = net;
      await startSite(A);
      await startSite(B);
      for (let i = 0; i < 120; i += 1) {
        const ps = await docker(["exec", A.name, "ps", "-eo", "user=,comm="]);
        if (ps.stdout.split("\n").filter((l) => /^www-data\s+apache2$/.test(l.trim())).length >= 2) return;
        await sleep(500);
      }
      throw new StepAssertionError("2 www-data apache2 workers in A / not within 60 s");
    });

    await step("2-a1-open-size-id", async () => {
      const opened = await adapter.openTerminal({ sessionId: s1.id, siteId: A.siteId, serviceInstanceId: A.svc });
      assert(opened.containerName === A.name, "containerName is A", opened.containerName);
      await readUntil(adapter, s1, (o) => o.includes(PROMPT));
      await adapter.writeTerminal({ sessionId: s1.id, input: "stty size\n" });
      await readUntil(adapter, s1, (o) => /\n24 80\r?\n/.test(o));
      await adapter.writeTerminal({ sessionId: s1.id, input: "id\n" });
      await readUntil(adapter, s1, (o) => o.includes("uid=33(www-data)"));
    });

    await step("3-a2-ctrl-c", async () => {
      await adapter.writeTerminal({ sessionId: s1.id, input: "sleep 300\n" });
      await readUntil(adapter, s1, (o) => o.includes("sleep 300"));
      let seen = false;
      for (let i = 0; i < 20 && !seen; i += 1) {
        await readUntil(adapter, s1, () => true);
        seen = (await seenInA()).args.includes("sleep 300");
      }
      assert(seen, "a second exec sees sleep 300", "not seen");
      const mark = s1.out.length;
      await adapter.writeTerminal({ sessionId: s1.id, input: "\x03" });
      await readUntil(adapter, s1, (o) => o.slice(mark).includes("^C") && o.trimEnd().endsWith(PROMPT.trimEnd()));
      assert(!(await seenInA()).args.includes("sleep 300"), "sleep 300 is gone", "still running");
    });

    await step("4-a3-close-ends-children", async () => {
      for (const line of ["sleep 301 &\n", "nohup sleep 302 >/dev/null 2>&1 &\n", "setsid sleep 303 &\n"]) {
        await adapter.writeTerminal({ sessionId: s1.id, input: line });
        await readUntil(adapter, s1, () => true); // only reads keep a session from idling
      }
      let all = [];
      for (let i = 0; i < 20 && all.length < 3; i += 1) {
        await readUntil(adapter, s1, () => true);
        all = (await seenInA()).args.filter((a) => /^sleep 30[123]$/.test(a));
      }
      assert(all.length === 3, "the three sleeps run before the close", all.join(","));
      before.workers = await apacheWorkersInA();
      s1Closed = await adapter.closeTerminal({ sessionId: s1.id });
      assert(s1Closed.reason === "closed", "close gives closed", JSON.stringify(s1Closed));
      const after = await seenInA();
      assert(after.marked === 0, "no marked process", after.marked);
      const left = after.args.filter((a) => /^sleep 30[123]$/.test(a));
      assert(left.length === 0, "no sleep 30[123]", left.join(","));
    });

    await step("4b-close-spares-web-server-workers", async () => {
      assert(before.workers?.length >= 2, "web server workers listed before the close", before.workers?.join(","));
      const now = await apacheWorkersInA();
      const gone = before.workers.filter((pid) => !now.includes(pid));
      assert(gone.length === 0, "the same worker ids still run after the close", gone.join(","));
    });

    await step("5-a4-idle", async () => {
      s2Opened = await adapter.openTerminal({ sessionId: s2.id, siteId: A.siteId, serviceInstanceId: A.svc });
      await sleep(IDLE_MS + 2_000);
      const rec = (await adapter.listTerminals()).find((r) => r.sessionId === s2.id);
      assert(rec?.ended?.reason === "idle", "s2 ended idle", JSON.stringify(rec));
      let marked = -1;
      for (let i = 0; i < 20 && marked !== 0; i += 1) {
        marked = (await seenInA()).marked;
        if (marked !== 0) await sleep(250);
      }
      assert(marked === 0, "no marked process after idle", marked);
    });

    await step("6-a5-records", async () => {
      assert(s1Closed && !Number.isNaN(Date.parse(s1Closed.at)), "s1 close result has its time", JSON.stringify(s1Closed));
      const rec = (await adapter.listTerminals()).find((r) => r.sessionId === s2.id);
      assert(rec && rec.openedAt === s2Opened.openedAt && rec.siteId === A.siteId && rec.containerName === A.name, "s2 record", JSON.stringify(rec));
      const lived = Date.parse(rec.ended.at) - Date.parse(rec.openedAt);
      assert(rec.ended.reason === "idle" && lived >= IDLE_MS && lived < IDLE_MS + 2_000, "s2 ended idle after idleMs", lived);
    });

    await step("6b-ctrl-d-shell_exited", async () => {
      const s4 = { id: sid(), cursor: 0, out: "" };
      await adapter.openTerminal({ sessionId: s4.id, siteId: A.siteId, serviceInstanceId: A.svc });
      await readUntil(adapter, s4, (o) => o.includes(PROMPT));
      await adapter.writeTerminal({ sessionId: s4.id, input: "sleep 304 &\n" });
      await readUntil(adapter, s4, () => true);
      await adapter.writeTerminal({ sessionId: s4.id, input: "\x04" });
      const ended = await readUntil(adapter, s4, () => false);
      assert(ended?.reason === "shell_exited", "Ctrl-D ends shell_exited", JSON.stringify(ended));
      let left = ["?"];
      for (let i = 0; i < 20 && left.length > 0; i += 1) {
        left = (await seenInA()).args.filter((a) => a === "sleep 304");
        if (left.length > 0) await sleep(250);
      }
      assert(left.length === 0, "its background sleep is killed too", left.join(","));
    });

    await step("7-a6-restart-ends-container_gone", async () => {
      before.a = await startedAt(A.name);
      before.b = await startedAt(B.name);
      await adapter.openTerminal({ sessionId: s3.id, siteId: A.siteId, serviceInstanceId: A.svc });
      await readUntil(adapter, s3, (o) => o.includes(PROMPT));
      const reading = readUntil(adapter, s3, () => false, 40_000); // keeps reading, so idle never ends s3
      before.result = await restartContainerByName(target, A.name, 5);
      const ended = await reading;
      assert(ended?.reason === "container_gone", "s3 ended container_gone", JSON.stringify(ended));
    });

    await step("8-b-restart-by-name", async () => {
      const a = await startedAt(A.name);
      const b = await startedAt(B.name);
      assert(a !== before.a && Date.parse(a) > Date.parse(before.a), "A's StartedAt changed", `${before.a} -> ${a}`);
      assert(before.result.startedAt === new Date(Date.parse(a)).toISOString(), "restart returns A's new StartedAt", before.result.startedAt);
      assert(b === before.b, "B's StartedAt unchanged", `${before.b} -> ${b}`);
      const missing = await codeOf(restartContainerByName(target, `${runPrefix}_missing`, 5));
      assert(missing === "NOT_FOUND", "missing name NOT_FOUND", missing);
      // An adapter on an absent socket: a refusal before any Engine call stays VALIDATION_ERROR.
      const dead = new DockerEngineSocketAdapter({
        dockerSocketPath: path.join(tmpDir, "absent.sock"),
        pullMissingImages: false,
        secretsRootDir: path.join(tmpDir, "secrets"),
        ingressRootDir: path.join(tmpDir, "ingress"),
      });
      for (const component of ["hp_web", A.name, "../hp_mariadb"]) {
        const code = await codeOf(dead.restartPanelContainer({ component }));
        assert(code === "VALIDATION_ERROR", `${component} refused by the schema`, code);
      }
    });
  } finally {
    for (const r of await adapter.listTerminals().catch(() => [])) await adapter.closeTerminal({ sessionId: r.sessionId }).catch(() => undefined);
    await cleanup();
    total += 1;
    const left = await Promise.all([
      docker(["ps", "-a", "--filter", `name=${runPrefix}`, "-q"]),
      docker(["volume", "ls", "--filter", `name=${runPrefix}`, "-q"]),
      docker(["network", "ls", "--filter", `name=${runPrefix}`, "-q"]),
    ]);
    if (left.every((l) => l.code === 0 && l.stdout.trim() === "")) {
      passed += 1;
      console.log("PASS 9-nothing-left");
    } else {
      console.log(`FAIL 9-nothing-left: ${left.map((l) => l.stdout.trim() || l.stderr.trim()).join(" | ")}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed`);
  }
  return passed === total;
}

process.exit((await main()) ? 0 : 1); // exit now: ended-session records keep timers
