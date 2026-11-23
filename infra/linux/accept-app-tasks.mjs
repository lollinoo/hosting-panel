#!/usr/bin/env node
/**
 * Real-Docker acceptance of the tasks of applications (ADR-0042) through the PRODUCTION DockerEngineSocketAdapter from
 * apps/docker-executor/dist, called step by step as the API would: a command run by the executor in the existing
 * container of one component of an application. The command is the component (its user, its groups, its directory, no
 * terminal, no input, plus the mark of its run), a shell is refused before any Docker request, the exit code and the
 * output come back, the time limit kills the command and what left its session, one run per application at a time and
 * never the same run twice, a container that is not that component is refused, what an executor that died left running
 * is ended at the next start, and nothing a run printed is written anywhere by this process.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a…e, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_task_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created) and the create bodies keep the hardening; list answers are filtered to this run's
 *    objects, so the clean-up at start (which lists every component on the server) sees only this run's. An exec is
 *    forwarded only in a container of this run and only when its body is exactly the product's clean-up script (its
 *    argument empty or a run id, no environment) or one of the commands declared in ARGV below with the one variable
 *    HP_TASK_RUN=<run id>; never with a user, a directory, a privilege or a terminal. The gate records every exec it
 *    forwards, by container. The raw stream of an exec is piped only for an exec the gate saw created. The first step
 *    proves that it denies foreign and unsafe requests.
 *  - No image is ever pulled (the gate denies every pull; the seed image must be local), no edge network is created
 *    (the gate allows only a private network, internal) and no network is attached to anything: the live panel's
 *    executor attaches its proxy to any edge network it finds. The networks of the live proxy are read before the first
 *    object is created and after the last one is removed, and must be the same.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/exec only ever name this run's objects, and processes are looked for with ps inside
 *    an own container, never in the host's /proc. One read is not about this run: docker inspect hp_ingress_proxy
 *    --format <its networks>, in a helper that can run nothing else.
 *  - What a run prints is matched and never printed: a failure names a check, not the output.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): the helper process killed,
 *    removeAppStack(..., removeVolumes: true) for every stack, then leftovers by exact own names through the gate, the
 *    piped streams destroyed, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-tasks.mjs (alone: not next to another heavy job).
 * Steps: gate-self-test, preflight, snapshot-before, plans-compile-from-seed, applications-deploy,
 * task-runs-as-the-component, a-shell-is-refused-before-docker, exit-code-and-output, time-limit-kills-the-command,
 * time-limit-kills-what-left-the-session, one-at-a-time-and-never-twice, refuses-what-is-not-that-component,
 * no-shell-no-task (skipped: no local image without /bin/sh is allowed through the gate), cleanup-after-executor-death,
 * nothing-recorded, remove-everything, gate-clean, nothing-left.
 * Each prints PASS/FAIL/SKIP <step> (a PASS may add ": <what was measured>"); final line RESULT n/m passed in Xs (a
 * skipped step is never a pass and is not counted).
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const t0 = performance.now();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const exists = (p) => stat(p).then(() => true, () => false);
const DIST = ["apps/docker-executor/dist/index.js", "packages/policy-engine/dist/index.js", "packages/contracts/dist/index.js"].map((p) =>
  path.resolve(repoRoot, p),
);
const missingDist = [];
for (const file of DIST) if (!(await exists(file))) missingDist.push(path.relative(repoRoot, file));
if (missingDist.length > 0) {
  console.log(`FAIL preflight: run corepack pnpm run build first (missing ${missingDist.join(", ")})`);
  console.log("RESULT 0/1 passed in 0.0s");
  process.exit(1);
}
const [executor, policy, contracts] = await Promise.all(DIST.map((file) => import(pathToFileURL(file).href)));
const {
  APP_STACK_LABELS,
  APP_STACK_TASK_KILL_SCRIPT,
  APP_STACK_TASK_MARK,
  DockerEngineSocketAdapter,
  INGRESS_PROXY_CONTAINER_NAME,
  appStackComponentLabels,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackVolumeName,
} = executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema, AppStackTaskReadIpcResultSchema, AppStackTaskRunIpcResultSchema } = contracts;

/** Everything this process writes to its output, kept to prove that nothing of a run is ever printed. */
const printed = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    printed.push(String(chunk));
    return write(chunk, ...rest);
  };
}

const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
/** The live panel's proxy (hp_ingress_proxy), by the product's own constant: this script only ever reads its networks. */
const LIVE_PROXY = INGRESS_PROXY_CONTAINER_NAME;
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_task_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const OTHER_ORG = `org_swarmtest_${hex}_other`;
/** A, B: two applications of one customer; C: one of another customer; D: only impostor containers; E: never created. */
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((s) => `stk_swarmtest_${hex}_${s}`);
const OWNER = new Map([[A, ORG], [B, ORG], [C, OTHER_ORG], [D, ORG]]);
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- the commands (the gate forwards an exec of one of these and of no other command) ----
const ARGV = Object.freeze({
  id: ["id"],
  pwd: ["pwd"],
  mark: ["printenv", APP_STACK_TASK_MARK],
  ping: ["valkey-cli", "-h", "127.0.0.1", "PING"],
  pingClosedPort: ["valkey-cli", "-h", "127.0.0.1", "-p", "1", "PING"],
  missing: ["no-such-program-swarmtest"],
  overLimit: ["sleep", "300"],
  leavesSession: ["setsid", "sleep", "301"],
  wrapped: ["timeout", "300", "sleep", "302"],
  twentySeconds: ["sleep", "20"],
  orphan: ["sleep", "303"],
});
const TASK_ARGVS = Object.values(ARGV);
const words = (argv) => argv.join(" ");
/** How a command would show in a text, as a line or as JSON: none of these may ever be printed or written. */
const ARGV_MARKS = [...TASK_ARGVS.filter((argv) => argv.length > 1).flatMap((argv) => [words(argv), JSON.stringify(argv)]), ...ARGV.missing];
const RUN_ID = /^srun_[0-9a-f]{24}$/;
const rid = () => `srun_${randomBytes(12).toString("hex")}`;

// ---- plans (the worker-storage seed: no ingress, so no edge network) ----
const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "worker-storage");
const compile = (stackId, n) =>
  compileAppStackPlan({
    source: seed.source,
    parameters: [{ key: "worker_interval_seconds", value: 5 }],
    secretVersions: new Map(),
    ids: {
      stackId,
      organizationId: OWNER.get(stackId),
      hostAllocationId: `alloc_swarmtest_${hex}`,
      templateVersionId: seed.versionId,
      revisionId: `srev_swarmtest_${hex}_${String(n)}`,
    },
  });
const compiled = [A, B, C, D].map((stackId, i) => compile(stackId, i + 1));
const SEED_IMAGE = compiled[0].ok ? compiled[0].plan.components[0].image : "none";
/** The only image the gate inspects; it is never pulled. */
const IMAGES = new Set([SEED_IMAGE]);
const namesOf = (plan) => ({
  containers: plan.components.map((c) => appStackContainerName(plan.stackId, c.key)).sort(),
  networks: [appStackInternalNetworkName(plan.stackId)],
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const NONE = { containers: [], networks: [], volumes: [] };
const cName = appStackContainerName;

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);
const hasDockerId = (value) => /[0-9a-f]{64}/.test(JSON.stringify(value));

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / got: ${actual}`);
}
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}
async function until(what, ms, fn, every = 500) {
  const deadline = Date.now() + ms;
  let last = "no answer";
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    if (Date.now() > deadline) throw new StepAssertionError(`${what} within ${String(ms / 1000)} s / ${last}`);
    await sleep(every);
  }
}
/** Runs fn (given a "the run has answered" test) while a run goes, and never leaves the run behind when fn fails. */
async function during(pending, fn) {
  let ended = false;
  const settle = () => {
    ended = true;
  };
  pending.then(settle, settle);
  try {
    await fn(() => ended);
  } catch (err) {
    await pending.catch(() => undefined);
    throw err;
  }
  return pending;
}

function run(cmd, args, timeout, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
    child.stdin?.end(input);
  });
}
/** The only docker CLI door: no hp_ name of another run, and object verbs only on this run's objects. */
async function docker(args, timeout = 120_000) {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !ours(t));
  const objectVerb =
    ["inspect", "exec", "top", "stats", "logs"].includes(args[0]) || (["network", "volume"].includes(args[0]) && args[1] === "inspect");
  if (foreign.length > 0 || (objectVerb && !args.some(ours))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const networkOf = async (name) => JSON.parse(await docker(["network", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();

/**
 * The one read that is not about this run: the networks of the live panel's proxy ("<name> <network id>" each), to
 * prove at the end that this run attached nothing to it. It can run nothing but docker inspect <that one name>
 * --format <its networks>; null = no such container on this machine.
 */
async function liveProxyNetworks() {
  const name = String(LIVE_PROXY);
  if (!/^hp_[a-z_]+$/.test(name) || ours(name)) throw new Error("the name of the live proxy is not known");
  let out;
  try {
    out = await run("docker", ["inspect", name, "--format", "{{json .NetworkSettings.Networks}}"], 30_000);
  } catch (err) {
    if (/no such (object|container)/i.test(String(err?.message))) return null;
    throw err;
  }
  return Object.entries(JSON.parse(out) ?? {})
    .map(([network, endpoint]) => `${network} ${String(endpoint?.NetworkID ?? "")}`)
    .sort();
}

// ---- the observer inside a component (the docker CLI, never the product; ps in the container, never the host) ----
/** The processes of a component, {pid, args} each, without the observer's own ps. */
const processes = async (name) =>
  (await docker(["exec", name, "ps", "-o", "pid,args"], 20_000))
    .split("\n")
    .slice(1)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m !== null && !m[2].startsWith("ps -o"))
    .map((m) => ({ pid: Number(m[1]), args: m[2].trim() }));
/** The processes of a component, its first one apart, whose arguments pass the test. */
const runningIn = async (name, test) => (await processes(name)).filter((p) => p.pid !== 1 && test(p.args));
/** What a run must leave as it was: the start of the container and its first process, on the host and inside. */
const componentState = async (name) => {
  const c = await inspectOf(name);
  const first = (await processes(name)).find((p) => p.pid === 1)?.args ?? "none";
  return { startedAt: c.State.StartedAt, hostPid: c.State.Pid, running: c.State.Running, restarts: c.RestartCount, firstProcess: first };
};
const changed = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]);
/** The same without an exec in the container: the engine's own view only. */
const containerState = async (name) => {
  const c = await inspectOf(name);
  return {
    name,
    state: `${String(c.State.StartedAt)} ${String(c.State.Pid)} ${String(c.State.Running)} ${String(c.RestartCount)}`,
    execs: (c.ExecIDs ?? []).length,
  };
};

// ---- runs ----
/** Every output a run answered, kept only to prove at the end that none of it was printed or written. */
const outputs = [];
/** The answer of a run: it must be the contract's result. */
function answered(result) {
  outputs.push(String(result?.output ?? ""));
  assert(AppStackTaskRunIpcResultSchema.safeParse(result).success, "the answer of a run is the contract's result", Object.keys(result ?? {}).join(","));
  return result;
}
const endedAs = (r, outcome, exitCode) => r?.outcome === outcome && r.exitCode === exitCode && r.problem === null;
/** How a run ended, for a failure message: never what it printed. */
const how = (r) =>
  `${String(r?.outcome)}, exit code ${String(r?.exitCode)}, problem ${String(r?.problem)}, ${String(r?.output?.length ?? 0)} characters`;

const snapshot = async () => ({
  containers: await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]),
  networks: await lines(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"]),
  volumes: await lines(["volume", "ls", "--format", "{{.Name}}"]),
});
const KINDS = ["containers", "networks", "volumes"];
/** Own names in a snapshot (default: this run; or one stack id). */
const ownNames = (s, id = null) => {
  const mine = (l) => (id === null ? ours(l) : l.includes(id));
  return {
    containers: s.containers.filter(mine).map((l) => l.split(" ")[1]).sort(),
    networks: s.networks.filter(mine).map((l) => l.split(" ")[1]).sort(),
    volumes: s.volumes.filter(mine).sort(),
  };
};
const removedSince = (s0, s1) => KINDS.flatMap((k) => s0[k].filter((l) => !s1[k].includes(l)));

// ---- gate ----
let tmpDir = null;
let gateServer = null;
let gateSocket = null;
const gateLog = [];
const gateDenied = [];
const ownIds = new Set();
/** The name of each container the gate saw created, by its id: the product asks for an exec by the id it inspected. */
const ownIdNames = new Map();
/** The execs the gate saw created: only their state is read and only their stream is piped. */
const ownExecs = new Set();
/** The raw streams being piped: [client, engine]. */
const streams = new Set();
/** Every exec create the gate forwarded, in order: {container (its name), form ("kill" or "task")}. */
const execLog = [];
const execsIn = (name, from = 0) => execLog.slice(from).filter((e) => e.container === name).length;
const execsOf = (form, from = 0) => execLog.slice(from).filter((e) => e.form === form).length;
const DENIED = JSON.stringify({ message: "gate: denied" });
const isOwn = (ref) => ours(ref) || ownIds.has(ref);
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });
const pathOf = (rawUrl) => decodeURIComponent(new URL(rawUrl, "http://docker").pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");

/** null = the create body keeps every hardening property and names only this run's objects. */
function containerBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (body.Image !== SEED_IMAGE) return "image";
  if (h.Privileged === true || h.CapAdd !== undefined) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !(h.SecurityOpt ?? []).includes("no-new-privileges:true")) return "hardening";
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  if (h.NetworkMode !== "none" && !String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${secretsRoot}/`) || !b.endsWith(":ro"))) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  if (Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker))) return "endpoint";
  return null;
}

/** The only properties an exec body may have: so no User, no WorkingDir, no Privileged, no DetachKeys, no ConsoleSize. */
const EXEC_KEYS = ["Cmd", "Env", "AttachStdin", "AttachStdout", "AttachStderr", "Tty"];
/**
 * "kill" when the exec body is exactly the product's clean-up (no environment), "task" when it is exactly one of this
 * script's commands with the mark of a run as its only variable; both with no terminal. Otherwise null.
 */
function execForm(body) {
  if (Object.keys(body).some((k) => !EXEC_KEYS.includes(k)) || body.Tty !== false) return null;
  const cmd = Array.isArray(body.Cmd) ? body.Cmd : [];
  const kill =
    cmd.length === 5 &&
    cmd[0] === "/bin/sh" &&
    cmd[1] === "-c" &&
    cmd[2] === APP_STACK_TASK_KILL_SCRIPT &&
    cmd[3] === "sh" &&
    (cmd[4] === "" || (typeof cmd[4] === "string" && RUN_ID.test(cmd[4])));
  if (kill) return body.Env === undefined ? "kill" : null;
  const env = body.Env;
  const marked =
    Array.isArray(env) &&
    env.length === 1 &&
    typeof env[0] === "string" &&
    env[0].startsWith(`${APP_STACK_TASK_MARK}=`) &&
    RUN_ID.test(env[0].slice(APP_STACK_TASK_MARK.length + 1));
  return marked && TASK_ARGVS.some((argv) => same(argv, cmd)) ? "task" : null;
}

/** Default deny: "forward" (optionally registering the created id or filtering a list) or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = pathOf(rawUrl);
  const query = decodeURIComponent(u.search);
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t));
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version" || p === "/info")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) ? fwd() : deny("image");
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p });
  if (method === "POST" && p === "/networks/create") {
    const ok =
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.IPAM === undefined &&
      String(body.Name).includes(marker) &&
      body.Internal === true &&
      body.Labels?.[ROLE_LABEL] === "app_internal";
    return ok ? fwd() : deny("network create");
  }
  if (method === "POST" && p === "/volumes/create") {
    const ok = String(body.Name).includes(marker) && body.DriverOpts === undefined && [undefined, "local"].includes(body.Driver);
    return ok ? fwd() : deny("volume create");
  }
  if (method === "POST" && p === "/containers/create") {
    const name = u.searchParams.get("name") ?? "";
    const problem = name.startsWith("hp_app_") && name.includes(marker) ? containerBodyProblem(body) : "unnamed or foreign container";
    return problem === null ? fwd({ register: name }) : deny(problem);
  }
  if (method === "POST" && (m = p.match(/^\/containers\/([^/]+)\/exec$/))) {
    if (!isOwn(m[1])) return deny("exec in a foreign container");
    const form = execForm(body);
    if (form === null) return deny("an exec that is not the product's clean-up or a command of this script");
    return fwd({ exec: { ref: m[1], form } });
  }
  if (method === "GET" && (m = p.match(/^\/exec\/([^/]+)\/json$/))) return ownExecs.has(m[1]) ? fwd() : deny("foreign exec");
  if ((m = p.match(/^\/containers\/([^/]+)(?:\/(json|logs|start|stop|restart|kill|wait))?$/)) && isOwn(m[1])) {
    const sub = m[2];
    if (method === (sub === undefined ? "DELETE" : sub === "json" || sub === "logs" ? "GET" : "POST")) return fwd();
  }
  if ((m = p.match(/^\/(networks|volumes)\/([^/]+)$/)) && isOwn(m[2])) {
    if (method === "GET" || (method === "DELETE" && !(m[1] === "volumes" && u.searchParams.has("force")))) return fwd();
  }
  return deny("not an allowed request");
}

/** A list answer with this run's objects only. */
function ownOnly(listPath, text) {
  const data = JSON.parse(text);
  if (listPath === "/volumes") return { ...data, Volumes: (data.Volumes ?? []).filter((v) => ours(String(v.Name))) };
  return data.filter((x) => ours(String(listPath === "/networks" ? x.Name : x.Names?.[0])));
}

/** The raw stream of an exec: only POST /exec/<an exec the gate saw created>/start, piped both ways, half-close kept. */
function onUpgrade(req, socket, head) {
  const m = req.method === "POST" ? pathOf(req.url ?? "/").match(/^\/exec\/([0-9a-f]+)\/start$/) : null;
  if (m === null || !ownExecs.has(m[1])) {
    gateLog.push(`${req.method} ${req.url} -> deny`);
    gateDenied.push(`${req.method} ${req.url}: a raw stream that is not an own exec`);
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${String(DENIED.length)}\r\nConnection: close\r\n\r\n${DENIED}`);
    return;
  }
  gateLog.push(`${req.method} ${req.url} -> upgrade`);
  const up = net.connect({ path: DOCKER_SOCK, allowHalfOpen: true });
  const pair = [socket, up];
  streams.add(pair);
  const drop = () => {
    streams.delete(pair);
    socket.destroy();
    up.destroy();
  };
  socket.on("error", drop);
  up.on("error", drop);
  socket.on("close", drop); // the client is gone: nothing more can reach it
  up.on("close", () => socket.end()); // the Engine is done: let the client read what is left
  let headerText = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) headerText += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  up.write(`${headerText}\r\n`);
  if (head.length > 0) up.write(head);
  up.pipe(socket);
  // Node gives the body of a request that asks for a stream to the request object, not to the socket: it goes to the
  // Engine first, and only then what the client sends on the stream.
  if (head.length >= Number(req.headers["content-length"] ?? 0)) {
    socket.pipe(up);
    return;
  }
  req.on("data", (c) => up.write(c));
  req.on("end", () => socket.pipe(up));
  req.on("error", drop);
}

function startGate(socketPath) {
  gateServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let verdict;
      try {
        verdict = judge(req.method ?? "GET", req.url ?? "/", bodyText);
      } catch (err) {
        verdict = deny(`unparsable (${String(err?.message)})`);
      }
      gateLog.push(`${req.method} ${req.url} -> ${verdict.kind}`);
      if (verdict.kind === "deny") {
        gateDenied.push(`${req.method} ${req.url}: ${verdict.why}`);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(DENIED);
        return;
      }
      if (verdict.exec) execLog.push({ container: ownIdNames.get(verdict.exec.ref) ?? verdict.exec.ref, form: verdict.exec.form });
      const out = Buffer.from(bodyText);
      const headers = { ...req.headers, host: "docker" };
      delete headers["transfer-encoding"];
      if (out.length > 0 || req.method === "POST") headers["content-length"] = String(out.length);
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.register && ures.statusCode === 201) {
            const id = JSON.parse(body.toString("utf8")).Id;
            ownIds.add(id);
            ownIdNames.set(id, verdict.register);
          }
          if (verdict.exec && ures.statusCode === 201) ownExecs.add(JSON.parse(body.toString("utf8")).Id);
          if (verdict.filterList && ures.statusCode === 200) body = Buffer.from(JSON.stringify(ownOnly(verdict.filterList, body.toString("utf8"))));
          const rh = { ...ures.headers, "content-length": String(body.length) };
          delete rh["transfer-encoding"];
          res.writeHead(ures.statusCode ?? 502, rh);
          res.end(body);
        });
      });
      up.on("error", (err) => {
        res.writeHead(502);
        res.end(String(err.message));
      });
      up.end(out);
    });
  });
  gateServer.on("upgrade", onUpgrade);
  return new Promise((resolve, reject) => {
    gateServer.once("error", reject);
    gateServer.listen(socketPath, resolve);
  });
}
/** One request through the gate (the script's own changes and the self-test). */
function viaGate(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(payload === undefined ? "" : JSON.stringify(payload));
    const headers = { "content-type": "application/json", "content-length": String(data.length) };
    const req = http.request({ socketPath: gateSocket, method, path: urlPath, headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
/** One request for a raw stream through the gate (the self-test): the status, and whether a stream was given. */
function streamViaGate(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "content-length": "2", connection: "Upgrade", upgrade: "tcp" };
    const req = http.request({ socketPath: gateSocket, method: "POST", path: urlPath, headers });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, stream: false });
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, stream: true });
    });
    req.on("error", reject);
    req.end("{}");
  });
}

// ---- the executor that dies (its own process, so the kernel ends it the way a crash would) ----
/** Its own adapter on the same gate, one run; it prints how the run ended, never what the run printed. */
const DYING_EXECUTOR = `
const [dist, options, request] = process.argv.slice(-3);
const { DockerEngineSocketAdapter } = await import(dist);
const adapter = new DockerEngineSocketAdapter(JSON.parse(options));
console.log("STARTED");
const ended = await adapter.runAppStackTask(JSON.parse(request)).then(
  (result) => "outcome " + String(result.outcome),
  (err) => "refused " + String(err?.reason ?? err?.code ?? "error"),
);
console.log("ENDED " + ended);
`;
let dying = null;
let dyingOut = "";
let dyingErr = "";
const dyingRuns = () => dying !== null && dying.exitCode === null && dying.signalCode === null;

// ---- cleanup ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (dyingRuns()) dying.kill("SIGKILL");
    if (adapter) {
      for (const [stackId, organizationId] of OWNER) {
        await adapter
          .removeAppStack({ stackId, organizationId, removeVolumes: true })
          .catch((err) => console.log(`INFO cleanup ${stackId}: ${reasonOf(err)}`));
      }
      for (const [kind, list] of [
        ["containers", ["ps", "-a", ...OURS_FILTER, "--format", "{{.Names}}"]],
        ["networks", ["network", "ls", ...OURS_FILTER, "--format", "{{.Name}}"]],
        ["volumes", ["volume", "ls", ...OURS_FILTER, "--format", "{{.Name}}"]],
      ]) {
        for (const name of (await lines(list).catch(() => [])).filter(ours)) {
          const r = await viaGate("DELETE", `/v1.45/${kind}/${encodeURIComponent(name)}${kind === "containers" ? "?force=true&v=true" : ""}`).catch(
            (err) => ({ status: 0, body: String(err.message) }),
          );
          if (r.status !== 204 && r.status !== 404) console.log(`INFO cleanup ${name}: ${String(r.status)} ${r.body.slice(0, 120)}`);
        }
      }
    }
    for (const [client, engine] of [...streams]) {
      client.destroy();
      engine.destroy();
    }
    if (gateServer) {
      gateServer.closeAllConnections?.();
      await new Promise((resolve) => gateServer.close(() => resolve()));
    }
    for (const dir of [tmpDir, secretsRoot]) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch((err) => console.log(`INFO cleanup ${dir}: ${err.message}`));
    }
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

async function main() {
  let engineVersion;
  try {
    engineVersion = (await docker(["version", "--format", "{{.Server.Version}}"])).trim();
  } catch (err) {
    console.log(`SKIP accept-app-tasks: no Docker Engine (${err.message}); nothing was created`);
    process.exit(1);
  }
  let passed = 0;
  let total = 0;
  let skipped = 0;
  /** A step that returns a text passes with that text as what it measured. */
  const step = async (name, fn) => {
    total += 1;
    try {
      const measured = await fn();
      passed += 1;
      console.log(typeof measured === "string" ? `PASS ${name}: ${measured}` : `PASS ${name}`);
      return true;
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      return false;
    }
  };
  const skip = (name, why) => {
    skipped += 1;
    console.log(`SKIP ${name}: ${why}`);
  };
  const info = (msg) => console.log(`INFO ${msg}`);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  gateSocket = path.join(tmpDir, "docker-gate.sock");
  const unused = (x) => `${runPrefix}_${x}_unused`;
  // The time limits of a run are real seconds here: no shortened limit is given to the adapter.
  const adapterOptions = {
    dockerSocketPath: gateSocket,
    secretsRootDir: secretsRoot,
    ingressRootDir: path.join(tmpDir, "ingress"),
    ingressHttpPort: 16780,
    ingressHttpsPort: 16743,
    ingressProxyContainerName: `${runPrefix}_proxy`,
    ingressNetworkName: `${runPrefix}_ingress`,
    traefikImage: "traefik:v3.7",
    acmeDnsSecretDir: path.join(tmpDir, "acme-dns"),
    siteMailDir: path.join(tmpDir, "mail"),
    sitePhpDir: path.join(tmpDir, "php"),
    siteFilesDir: path.join(tmpDir, "files"),
    sftpStateDir: path.join(tmpDir, "sftp"),
    phpMyAdminConfigDir: path.join(tmpDir, "pma"),
    backupWorkDir: path.join(tmpDir, "backup"),
    sharedDbDataDir: path.join(tmpDir, "db"),
    sharedDbRootKeyFile: path.join(tmpDir, "db-root.key"),
    sharedDbContainerName: unused("shared_db"),
    sharedDbNetworkName: unused("shared_db"),
  };
  const status = (stackId) => adapter.getAppStackStatus({ stackId, organizationId: OWNER.get(stackId) });
  const healthOf = (s, key) => s.components.find((c) => c.componentKey === key)?.health;
  const waitHealthy = (stackId, keys, ms = 60_000) =>
    until(`${keys.join(",")} of ${stackId} healthy`, ms, async () => {
      const s = await status(stackId);
      return keys.every((k) => healthOf(s, k) === "healthy") ? s : null;
    });
  const startReq = (plan, componentKey) => ({ plan, componentKey, secretFileContents: [] });
  /** The API's deploy: check each image, prepare, create, start in plan order (dependencies healthy first). */
  const deploy = async (plan) => {
    const pulls = [];
    for (const image of new Set(plan.components.map((c) => c.image))) pulls.push(await adapter.pullAppStackImage({ plan, image }));
    const prepare = await adapter.prepareAppStack({ plan });
    await adapter.createAppStackComponents({ plan });
    for (const c of plan.components) {
      if (c.dependsOn.length > 0) await waitHealthy(plan.stackId, c.dependsOn);
      await adapter.startAppStackComponent(startReq(plan, c.key));
    }
    await waitHealthy(plan.stackId, plan.components.map((c) => c.key));
    return { pulls, prepare };
  };
  const gone = async (stackId, what) => {
    const left = ownNames(await snapshot(), stackId);
    assert(same(left, NONE), `${what}: no object of ${stackId} is left`, JSON.stringify(left));
  };
  /** The exec requests (create, state, stream) the gate saw since a mark. */
  const execRequests = (from) => gateLog.slice(from).filter((l) => /\/exec[/? ]/.test(`${l.split(" ")[1]} `));
  /** The request of one run, as the API sends it: the customer of the application unless another is given. */
  const request = (stackId, componentKey, argv, over = {}) => ({
    stackId,
    organizationId: OWNER.get(stackId) ?? ORG,
    componentKey,
    runId: rid(),
    argv,
    timeoutSeconds: 30,
    ...over,
  });
  /** One run through the adapter: its request and its answer. */
  const task = async (stackId, componentKey, argv, over = {}) => {
    const req = request(stackId, componentKey, argv, over);
    return { req, result: answered(await adapter.runAppStackTask(req)) };
  };
  const COMPONENTS = [A, B, C].flatMap((stackId) => ["storage", "worker"].map((key) => cName(stackId, key)));
  let S0 = null;
  /** The networks of the live proxy before anything was created: undefined = not read, null = no such container. */
  let proxyBefore;
  /** Where the self-test's own requests end in the gate's log. */
  let afterSelfTest = 0;
  let planA = null;
  let planB = null;
  let planC = null;
  let planD = null;

  try {
    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    const gateOk = await step("gate-self-test", async () => {
      // Real names of this machine, used only as judge() inputs: no request about them is ever sent.
      const foreignName = (await lines(["ps", "-a", "--format", "{{.Names}}"])).find((n) => n.startsWith("hp_")) ?? `hp_selftest_${hex}`;
      const foreignId = (await lines(["ps", "-aq", "--no-trunc"]))[0] ?? "f".repeat(64);
      const foreignNet = (await lines(["network", "ls", "--format", "{{.Name}}"])).find((n) => n.startsWith("hp_")) ?? "bridge";
      const foreignVol = (await lines(["volume", "ls", "--format", "{{.Name}}"]))[0] ?? `selftest_${hex}`;
      const ownNet = appStackInternalNetworkName(A);
      const ownVol = appStackVolumeName(A, "data");
      const storage = cName(A, "storage");
      const noExec = "e".repeat(64);
      const hardened = { Image: SEED_IMAGE, HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, NetworkMode: ownNet } };
      const createWith = (hostConfig, extra = {}) => JSON.stringify({ ...hardened, ...extra, HostConfig: { ...hardened.HostConfig, ...hostConfig } });
      const netBody = (name, role, extra = {}) => JSON.stringify({ Name: name, Driver: "bridge", Internal: true, Labels: { [ROLE_LABEL]: role }, ...extra });
      const runMark = `${APP_STACK_TASK_MARK}=${rid()}`;
      const attach = { AttachStdin: true, AttachStdout: true, AttachStderr: true };
      const taskForm = (cmd, over = {}) => JSON.stringify({ Cmd: cmd, Env: [runMark], ...attach, Tty: false, ...over });
      const killForm = (arg, over = {}) => JSON.stringify({ Cmd: ["/bin/sh", "-c", APP_STACK_TASK_KILL_SCRIPT, "sh", arg], ...attach, Tty: false, ...over });
      const execIn = (ref) => `/v1.45/containers/${ref}/exec`;
      const listOf = (label) => `/v1.45/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`;
      const [repo, digest] = SEED_IMAGE.split("@");
      const cases = [
        ["GET", `/v1.45/containers/${foreignName}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/logs?stdout=1`, ""],
        ["POST", `/v1.45/containers/${foreignId}/restart?t=10`, ""],
        ["POST", `/v1.45/containers/${foreignId}/stop?t=3`, ""],
        ["DELETE", `/v1.45/containers/${foreignId}?force=true&v=true`, ""],
        ["GET", `/v1.45/networks/${foreignNet}`, ""],
        ["DELETE", `/v1.45/networks/${foreignNet}`, ""],
        ["GET", `/v1.45/volumes/${foreignVol}`, ""],
        ["DELETE", `/v1.45/volumes/${foreignVol}`, ""],
        ["DELETE", `/v1.45/volumes/${ownVol}?force=true`, ""],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: storage })],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignName })],
        ["POST", `/v1.45/networks/${foreignNet}/connect`, JSON.stringify({ Container: storage })],
        ["POST", `/v1.45/networks/${ownNet}/disconnect`, JSON.stringify({ Container: storage })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=${digest}`, ""],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=9.2.0-alpine3.24`, ""],
        ["POST", "/v1.45/images/create?fromImage=traefik&tag=v3.7", ""],
        ["GET", "/v1.45/images/alpine:3/json", ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", "/v1.45/volumes/prune", ""],
        ["GET", "/v1.45/system/df", ""],
        ["POST", "/v1.45/build", ""],
        ["PUT", `/v1.45/containers/${storage}/archive?path=/tmp`, ""],
        // An exec anywhere but in a container of this run.
        ["POST", execIn(foreignName), taskForm(ARGV.id)],
        ["POST", execIn(foreignId), taskForm(ARGV.id)],
        ["POST", execIn(foreignId), killForm("")],
        // An exec that is not exactly a command of this script with the mark of a run.
        ["POST", execIn(storage), JSON.stringify({ Cmd: ["true"] })],
        ["POST", execIn(storage), JSON.stringify({ Cmd: ARGV.id })],
        ["POST", execIn(storage), taskForm(ARGV.id, { User: "0:0" })],
        ["POST", execIn(storage), taskForm(ARGV.id, { User: "999:1000" })],
        ["POST", execIn(storage), taskForm(ARGV.id, { WorkingDir: "/" })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Privileged: true })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Privileged: false })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Tty: true })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Tty: true, ConsoleSize: [24, 80] })],
        ["POST", execIn(storage), taskForm(ARGV.id, { DetachKeys: "ctrl-q" })],
        ["POST", execIn(storage), taskForm([])],
        ["POST", execIn(storage), taskForm(["cat", "/etc/passwd"])],
        ["POST", execIn(storage), taskForm(["valkey-cli", "FLUSHALL"])],
        ["POST", execIn(storage), taskForm([...ARGV.id, "-u"])],
        ["POST", execIn(storage), taskForm([...ARGV.ping, "PING"])],
        ["POST", execIn(storage), taskForm(["/bin/sh", "-c", "id"])],
        ["POST", execIn(storage), taskForm(["/bin/sh"])],
        ["POST", execIn(storage), taskForm(["sh"])],
        ["POST", execIn(storage), taskForm(ARGV.id, { Env: undefined })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Env: [] })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Env: [runMark, "X=1"] })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Env: [`${APP_STACK_TASK_MARK}=srun_x`] })],
        ["POST", execIn(storage), taskForm(ARGV.id, { Env: ["LD_PRELOAD=/tmp/x.so"] })],
        // A clean-up that is not exactly the product's.
        ["POST", execIn(storage), killForm("", { User: "0" })],
        ["POST", execIn(storage), killForm("", { Env: ["X=1"] })],
        ["POST", execIn(storage), killForm("", { Tty: true })],
        ["POST", execIn(storage), killForm("x; id")],
        ["POST", execIn(storage), killForm("srun_x")],
        ["POST", execIn(storage), JSON.stringify({ Cmd: ["/bin/sh", "-c", `${APP_STACK_TASK_KILL_SCRIPT}; id`, "sh", ""], ...attach, Tty: false })],
        ["GET", `/v1.45/exec/${noExec}/json`, ""],
        ["POST", `/v1.45/exec/${noExec}/start`, '{"Detach":false,"Tty":false}'],
        ["POST", `/v1.45/exec/${noExec}/resize?h=50&w=200`, ""],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ CapAdd: ["NET_ADMIN"] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ PortBindings: { "6379/tcp": [{ HostPort: "6379" }] } })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({}, { Image: "alpine:3" })],
        ["POST", "/v1.45/networks/create", netBody(appStackEdgeNetworkName(A), "app_edge", { Internal: false })],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "app_edge")],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "app_internal", { Internal: false })],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "app_internal", { Options: { "com.docker.network.bridge.name": "x" } })],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "site_internal")],
        ["POST", "/v1.45/networks/create", netBody(`${runPrefix}_ingress`, "ingress_public")],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: ownVol, Driver: "local", DriverOpts: { type: "none" } })],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url]) => `${method} ${url}`).join(" | "));
      const needed = [
        ...TASK_ARGVS.map((argv) => ["POST", execIn(storage), taskForm(argv)]),
        ["POST", execIn(storage), killForm("")],
        ["POST", execIn(storage), killForm(rid())],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "app_internal")],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({})],
        ["GET", `${listOf(APP_STACK_LABELS.component)}&all=1`, ""],
        ["GET", listOf(`${APP_STACK_LABELS.role}=app_component`), ""],
        ["POST", `/v1.45/containers/${cName(B, "worker")}/stop?t=3`, ""],
      ];
      const refused = needed.filter(([method, url, body]) => judge(method, url, body).kind !== "forward");
      assert(refused.length === 0, "judge() forwards what the product and this script need", `${String(refused.length)} of ${String(needed.length)}: ${refused.map(([method, url]) => `${method} ${url}`).join(" | ")}`);
      // Through the socket: a read and a stream request about objects that do not exist, harmless even if let through.
      const denied = await viaGate("GET", `/v1.45/containers/hp_selftest_${hex}/json`);
      assert(denied.status === 403 && gateDenied.length === 1, "the socket answers 403 for a foreign name and records the denial", `${denied.status} ${gateDenied.length}`);
      const stream = await streamViaGate(`/v1.45/exec/${noExec}/start`);
      assert(stream.status === 403 && !stream.stream && gateDenied.length === 2, "no raw stream for an exec the gate did not see created", JSON.stringify(stream));
      const ping = await viaGate("GET", "/_ping");
      assert(ping.status === 200 && ping.body === "OK", "the socket forwards an allowed request to the Engine", `${ping.status} ${ping.body}`);
      assert(execLog.length === 0 && ownExecs.size === 0, "the self-test forwarded no exec", String(execLog.length));
      gateDenied.length = 0; // the expected self-test denials; from here on any denial fails gate-clean
      afterSelfTest = gateLog.length;
    });
    if (!gateOk) {
      adapter = null; // nothing was created: cleanup sends nothing through a gate that failed its self-test
      return;
    }

    const ready = await step("preflight", async () => {
      assert(engineVersion.length > 0, "the Docker Engine answers", engineVersion);
      assert(compiled[0].ok, "the worker-storage seed compiles", JSON.stringify(compiled[0].issues));
      const local = (await docker(["image", "inspect", "--format", "{{.Id}}", SEED_IMAGE]).catch(() => "")).trim() !== "";
      assert(local, `the seed image is on this machine (this script never pulls: docker pull ${SEED_IMAGE} first)`, "absent");
      const stale = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter(ours);
      assert(stale.length === 0, "no object name contains the run marker", stale.join(","));
      info(`engine ${engineVersion}, marker ${marker}, image ${SEED_IMAGE}`);
    });
    if (!ready) return;

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      proxyBefore = await liveProxyNetworks();
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
      info(`the live proxy ${String(LIVE_PROXY)}: ${proxyBefore === null ? "not on this machine" : `on ${String(proxyBefore.length)} network(s)`}`);
    });

    const planOk = await step("plans-compile-from-seed", async () => {
      assert(compiled.every((c) => c.ok), "the seed compiles for four applications", JSON.stringify(compiled.find((c) => !c.ok)?.issues));
      [planA, planB, planC, planD] = compiled.map((c) => ApprovedStackPlanSchema.parse(c.plan));
      for (const plan of [planA, planB, planC, planD]) {
        assert(same(plan.components.map((c) => c.key), ["storage", "worker"]), "components [storage, worker]", plan.components.map((c) => c.key).join(","));
        assert(plan.components.every((c) => c.runAsUser === "999:1000"), "both run as 999:1000", plan.components.map((c) => c.runAsUser).join(","));
        assert(plan.ingress.length === 0, "no ingress: no edge network will exist", JSON.stringify(plan.ingress));
      }
      assert(planC.organizationId === OTHER_ORG && planA.organizationId === ORG, "the third application belongs to another customer", planC.organizationId);
    });
    if (!planOk) return;

    const deployed = await step("applications-deploy", async () => {
      for (const plan of [planA, planB, planC]) {
        const out = await deploy(plan);
        assert(out.pulls.every((p) => p.pulled === false), "the image is local: nothing is pulled", JSON.stringify(out.pulls));
        assert(same(out.prepare.networks, [{ role: "app_internal", created: true }]), "one private network, no edge network", JSON.stringify(out.prepare.networks));
      }
      const S1 = await snapshot();
      const expected = {
        containers: [planA, planB, planC].flatMap((p) => namesOf(p).containers).sort(),
        networks: [planA, planB, planC].flatMap((p) => namesOf(p).networks).sort(),
        volumes: [planA, planB, planC].flatMap((p) => namesOf(p).volumes).sort(),
      };
      assert(same(ownNames(S1), expected), "own delta: exactly 6 containers, 3 networks, 3 volumes", JSON.stringify(ownNames(S1)));
      for (const name of expected.networks) {
        const n = await networkOf(name);
        assert(n.Internal === true && n.Labels?.[ROLE_LABEL] === "app_internal", `${name} is a private, internal network`, JSON.stringify(n.Labels));
      }
      const pulls = gateLog.slice(afterSelfTest).filter((l) => l.includes("/images/create"));
      const attaches = gateLog.slice(afterSelfTest).filter((l) => /\/networks\/[^/]+\/(connect|disconnect)/.test(l));
      assert(pulls.length === 0 && attaches.length === 0, "no pull and no network attach was asked", [...pulls, ...attaches].join(" | "));
      assert(removedSince(S0, S1).length === 0, "no pre-existing object removed", removedSince(S0, S1).join(","));
      const asked = execRequests(afterSelfTest).length;
      assert(asked === 0 && execLog.length === 0, "no task yet: no exec asked", String(asked));
    });
    if (!deployed) return;

    await step("task-runs-as-the-component", async () => {
      const name = cName(A, "storage");
      const before = await componentState(name);
      const from = execLog.length;
      /** What the observer's own exec of a program prints: no user and no directory given, as for a run. */
      const asObserver = async (program) => (await docker(["exec", name, program], 20_000)).replace(/\r?\n$/, "");

      const who = await task(A, "storage", ARGV.id);
      assert(endedAs(who.result, "succeeded", 0), "the command ends as succeeded with exit code 0", how(who.result));
      const identity = await asObserver("id");
      assert(/^uid=999\b/.test(identity) && /\bgid=1000\b/.test(identity) && !identity.includes("\n"), "the component itself is 999:1000", `${String(identity.length)} characters`);
      assert(who.result.output === identity, "the command ran as the component: the same user and the same groups", `${String(who.result.output.length)} characters against ${String(identity.length)}`);

      const where = await task(A, "storage", ARGV.pwd);
      const directory = await asObserver("pwd");
      assert(endedAs(where.result, "succeeded", 0) && directory.startsWith("/"), "the second command ends as succeeded", how(where.result));
      assert(where.result.output === directory, "no working directory was set: the command starts where the component does", `${String(where.result.output.length)} characters against ${String(directory.length)}`);

      const marked = await task(A, "storage", ARGV.mark);
      assert(endedAs(marked.result, "succeeded", 0) && marked.result.output === marked.req.runId, "the command's environment carries the id of its run, exactly", how(marked.result));

      for (const { req, result } of [who, where, marked]) {
        assert(result.runId === req.runId && result.outputTruncated === false, "the answer names its run and nothing was cut", how(result));
        assert(Date.parse(result.startedAt) <= Date.parse(result.endedAt), "it tells when the command started and ended", "times");
        assert(!hasDockerId(result), "no answer holds a Docker id", "an id");
      }
      const asked = execLog.slice(from);
      const forms = asked.map((e) => e.form).join(",");
      assert(
        asked.every((e) => e.container === name) && forms === "kill,task,kill,kill,task,kill,kill,task,kill",
        "each run asked three execs, in that container only: the clean-up, the command, the clean-up",
        `${forms || "none"} in ${[...new Set(asked.map((e) => e.container))].join(",")}`,
      );
      const after = await componentState(name);
      assert(after.running === true && changed(before, after).length === 0, "a run restarts nothing: the same start of the container and the same first process", `changed: ${changed(before, after).join(",")}`);
    });

    await step("a-shell-is-refused-before-docker", async () => {
      const mark = gateLog.length;
      for (const argv of [["/bin/sh", "-c", "id"], ["sh"]]) {
        const refused = await rejection(adapter.runAppStackTask(request(A, "storage", argv)));
        assert(refused?.code === "VALIDATION_ERROR", `a shell (${String(argv.length)} argument(s)) is refused as not valid`, refused ? reasonOf(refused) : "it ran");
      }
      assert(gateLog.length === mark, "the gate saw no request", `${String(gateLog.length - mark)} request(s)`);
    });

    await step("exit-code-and-output", async () => {
      const ok = await task(A, "storage", ARGV.ping);
      assert(endedAs(ok.result, "succeeded", 0) && ok.result.output === "PONG", "the storage answers the command: succeeded, exit code 0, its one word", how(ok.result));
      const closed = await task(A, "storage", ARGV.pingClosedPort);
      assert(
        closed.result.outcome === "failed" && Number.isInteger(closed.result.exitCode) && closed.result.exitCode !== 0 && closed.result.output !== "",
        "a command that cannot connect ends as failed, with its exit code and what it printed",
        how(closed.result),
      );
      const none = await task(A, "storage", ARGV.missing);
      assert(none.result.outcome === "failed" && none.result.exitCode !== 0, "a program the image does not have ends as failed", how(none.result));
      // The engine's own message names the program: the product drops it, the exit code tells.
      assert(none.result.output === "", "the engine's message about a missing program is not returned as what the run printed", how(none.result));
      return `a program the image does not have ends as failed with exit code ${String(none.result.exitCode)}, ${none.result.output === "" ? "no" : "an"} output`;
    });

    await step("time-limit-kills-the-command", async () => {
      const name = cName(A, "storage");
      const command = (args) => args.includes(words(ARGV.overLimit));
      const before = await componentState(name);
      const started = Date.now();
      const timed = task(A, "storage", ARGV.overLimit, { timeoutSeconds: 5 }).then((r) => ({ ...r, took: Date.now() - started }));
      const { result, took } = await during(timed, () =>
        until("the command runs in the component", 4_500, async () => (await runningIn(name, command)).length === 1, 250),
      );
      assert(endedAs(result, "timed_out", null), "the run ends as timed_out with no exit code", how(result));
      assert(took >= 4_900 && took < 20_000, "it answers after its 5 seconds and in less than 20", `${String(took)} ms`);
      const left = await runningIn(name, command);
      assert(left.length === 0, "the observer finds the command no longer running", `${String(left.length)} process(es)`);
      const after = await componentState(name);
      assert(after.running === true && changed(before, after).length === 0, "the component runs on: the same first process, not restarted", `changed: ${changed(before, after).join(",")}`);
      return `answered ${(took / 1000).toFixed(1)} s after a limit of 5 s`;
    });

    await step("time-limit-kills-what-left-the-session", async () => {
      const name = cName(A, "storage");
      const before = await componentState(name);
      // The image's setsid starts the program in a session of its own and its first process ends at once: the engine
      // may end the output before the limit. Whatever the outcome, nothing may be left.
      const detached = (args) => args.includes(words(ARGV.leavesSession.slice(1)));
      let seen = false;
      const left = await during(task(A, "storage", ARGV.leavesSession, { timeoutSeconds: 5 }), async (answeredYet) => {
        const deadline = Date.now() + 4_000;
        while (!seen && !answeredYet() && Date.now() < deadline) {
          seen = (await runningIn(name, detached).catch(() => [])).length > 0;
          if (!seen) await sleep(200);
        }
      });
      const outcome = left.result.outcome;
      assert(
        ["timed_out", "succeeded", "failed"].includes(outcome) && left.result.problem === null && (outcome !== "timed_out" || left.result.exitCode === null),
        "the run of a command that leaves its session ends as timed_out, or as the engine told when the output ended first",
        how(left.result),
      );
      const stillDetached = await runningIn(name, detached);
      assert(stillDetached.length === 0, "what left the session of the command is not left once the run has answered", `${String(stillDetached.length)} process(es)`);

      // A program that starts another one and waits for it.
      const inner = (args) => args.includes(words(ARGV.wrapped.slice(2)));
      const wrapper = (args) => args.startsWith(`${ARGV.wrapped[0]} `);
      const wrapped = await during(task(A, "storage", ARGV.wrapped, { timeoutSeconds: 5 }), () =>
        until("the wrapped command runs in the component", 4_500, async () => (await runningIn(name, inner)).length > 0, 250),
      );
      assert(endedAs(wrapped.result, "timed_out", null), "the run of a command started by another ends as timed_out with no exit code", how(wrapped.result));
      const rest = await runningIn(name, (args) => inner(args) || wrapper(args));
      assert(rest.length === 0, "neither the program that waited nor the one it started is left", `${String(rest.length)} process(es)`);
      const after = await componentState(name);
      assert(after.running === true && changed(before, after).length === 0, "the component runs on: the same first process, not restarted", `changed: ${changed(before, after).join(",")}`);
      return `the command that left its session ended as ${outcome}${seen ? ", seen running by the observer" : ", not seen running by the observer"}`;
    });

    await step("one-at-a-time-and-never-twice", async () => {
      const name = cName(A, "storage");
      const command = (args) => args.includes(words(ARGV.twentySeconds));
      const req = request(A, "storage", ARGV.twentySeconds, { timeoutSeconds: 30 });
      const read = (stackId, organizationId) => adapter.getAppStackTaskRun({ stackId, organizationId, runId: req.runId });
      const unknownElsewhere = async () => (await read(A, OTHER_ORG)).state === "unknown" && (await read(B, ORG)).state === "unknown";
      assert((await read(A, ORG)).state === "unknown", "a run nobody asked for is unknown", "known");
      const result = answered(
        await during(adapter.runAppStackTask(req), async () => {
          await until("the run is read as running", 10_000, async () => (await read(A, ORG)).state === "running", 100);
          await until("its command runs in the component", 10_000, async () => (await runningIn(name, command)).length === 1, 250);
          const mark = gateLog.length;
          const second = await rejection(task(A, "worker", ARGV.id));
          assert(
            reasonOf(second) === "STACK_BUSY" && gateLog.length === mark,
            "a second run in the same application, in another component, is refused as busy before any Docker request",
            `${second ? reasonOf(second) : "it ran"}, ${String(gateLog.length - mark)} request(s)`,
          );
          const twice = await rejection(adapter.runAppStackTask(req));
          assert(reasonOf(twice) === "STACK_BUSY" && gateLog.length === mark, "the same run asked again while it goes is refused too", twice ? reasonOf(twice) : "it answered");
          const other = await task(B, "storage", ARGV.id);
          assert(endedAs(other.result, "succeeded", 0) && /^uid=999\b/.test(other.result.output), "another application runs its own task meanwhile", how(other.result));
          assert((await read(A, ORG)).state === "running", "the first run still goes", "not running");
          assert(await unknownElsewhere(), "while it goes, the run is unknown to another customer and to another application", "known");
        }),
      );
      assert(endedAs(result, "succeeded", 0) && result.runId === req.runId, "the first run ends as succeeded", how(result));
      const finished = await read(A, ORG);
      assert(
        finished.state === "finished" && same(finished.result, result) && AppStackTaskReadIpcResultSchema.safeParse(finished).success,
        "the run is then read as finished, with its result",
        String(finished.state),
      );
      const [execs, requests] = [execsIn(name), gateLog.length];
      const again = await adapter.runAppStackTask(req);
      assert(same(again, result), "asked again with the same run id, the answer is the same result", how(again));
      assert(
        execsIn(name) === execs && gateLog.length === requests,
        "and the command was not started a second time: no exec in that container, no Docker request",
        `${String(execsIn(name) - execs)} execs, ${String(gateLog.length - requests)} requests`,
      );
      assert(await unknownElsewhere(), "the finished run is unknown to another customer and to another application", "known");
      const free = await task(A, "worker", ARGV.id);
      assert(endedAs(free.result, "succeeded", 0), "once the run has ended the application takes another task", how(free.result));
    });

    await step("refuses-what-is-not-that-component", async () => {
      const mark = gateLog.length;
      const from = execLog.length;
      const refusal = async (stackId, organizationId, componentKey) =>
        reasonOf((await rejection(task(stackId, componentKey, ARGV.id, { organizationId }))) ?? "it ran");
      const expectRefusal = async (reason, what, stackId, organizationId, componentKey) => {
        const got = await refusal(stackId, organizationId, componentKey);
        assert(got === reason, what, got);
      };
      await expectRefusal("STACK_NAMESPACE_CONFLICT", "an application asked as another customer's is refused", A, OTHER_ORG, "storage");
      await expectRefusal("STACK_NAMESPACE_CONFLICT", "and the other way round", C, ORG, "worker");
      await expectRefusal("STACK_COMPONENT_NOT_READY", "an application that was never created has no component to run in", E, ORG, "storage");
      await expectRefusal("STACK_COMPONENT_NOT_READY", "nor has a component the application does not have", A, ORG, "nosuch");

      // A component that is there and is not running (stopped through the gate; started again whatever happens).
      const worker = cName(B, "worker");
      try {
        const stopped = await viaGate("POST", `/v1.45/containers/${worker}/stop?t=3`);
        assert(stopped.status === 204 && (await inspectOf(worker)).State.Running === false, "the worker of the second application is stopped", `${String(stopped.status)} ${stopped.body.slice(0, 120)}`);
        await expectRefusal("STACK_COMPONENT_NOT_READY", "a stopped component takes no task", B, ORG, "worker");
        assert((await inspectOf(worker)).State.Running === false, "and the request did not start it", "running");
      } finally {
        await viaGate("POST", `/v1.45/containers/${worker}/start`).catch(() => undefined);
      }
      await until("the stopped component runs again", 30_000, async () => (await inspectOf(worker)).State.Running === true);

      // A container under the name of a component whose labels do not say it is that component.
      const impostor = cName(D, "storage");
      const right = appStackComponentLabels(planD, "storage");
      const L = APP_STACK_LABELS;
      const make = async (labels) => {
        const body = {
          Image: SEED_IMAGE,
          Cmd: ["sleep", "600"],
          User: "999:1000",
          Labels: labels,
          HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, NetworkMode: "none", PidsLimit: 64, Memory: 64 << 20 },
        };
        const created = await viaGate("POST", `/v1.45/containers/create?name=${impostor}`, body);
        assert(created.status === 201, "the impostor is created", `${String(created.status)} ${created.body.slice(0, 120)}`);
        const started = await viaGate("POST", `/v1.45/containers/${impostor}/start`);
        assert(started.status === 204, "the impostor runs", `${String(started.status)} ${started.body.slice(0, 120)}`);
      };
      const drop = async () => {
        const r = await viaGate("DELETE", `/v1.45/containers/${impostor}?force=true&v=true`);
        assert(r.status === 204 || r.status === 404, "the impostor is removed", `${String(r.status)} ${r.body.slice(0, 120)}`);
      };
      const wrong = [
        ["no label", {}],
        ["not marked as managed", { ...right, [L.managed]: "false" }],
        ["the label of another application", { ...right, [L.stackId]: A }],
        ["the label of another customer", { ...right, [L.organizationId]: OTHER_ORG }],
        ["another role", { ...right, [L.role]: "swarmtest" }],
        ["the label of another component", { ...right, [L.component]: "worker" }],
      ];
      try {
        for (const [what, labels] of wrong) {
          await make(labels);
          const got = await refusal(D, ORG, "storage");
          assert(got === "STACK_NAMESPACE_CONFLICT", `a running container with ${what} is refused`, got);
          const execs = (await inspectOf(impostor)).ExecIDs ?? [];
          assert(execs.length === 0, `nothing was started in it (${what})`, String(execs.length));
          await drop();
        }
        assert(
          execRequests(mark).length === 0 && execLog.length === from,
          "every refusal of this step came before any exec request",
          `${String(execRequests(mark).length)} requests, ${String(execLog.length - from)} execs`,
        );
        // The control: the same container with the labels of the component is that component.
        await make(right);
        const accepted = await task(D, "storage", ARGV.id);
        assert(endedAs(accepted.result, "succeeded", 0) && /^uid=999\b/.test(accepted.result.output), "with the right labels the same container is accepted: the labels decide", how(accepted.result));
      } finally {
        await drop().catch(() => undefined);
      }
      await gone(D, "the impostors");
    });

    skip("no-shell-no-task", "no local image without /bin/sh is allowed through the gate (the unit tests cover it)");

    await step("cleanup-after-executor-death", async () => {
      const name = cName(A, "storage");
      const orphan = (args) => args.includes(words(ARGV.orphan));
      const before = await componentState(name);
      const req = request(A, "storage", ARGV.orphan, { timeoutSeconds: 600 });
      const args = ["--input-type=module", "-e", DYING_EXECUTOR, "--", pathToFileURL(DIST[0]).href, JSON.stringify(adapterOptions), JSON.stringify(req)];
      dying = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      dying.stdout.on("data", (c) => (dyingOut += String(c)));
      dying.stderr.on("data", (c) => (dyingErr += String(c)));
      await until("the other executor's command runs in the component", 30_000, async () => {
        assert(dyingRuns(), "the other executor runs", dyingErr.trim().split("\n").slice(-2).join(" / ").slice(0, 300));
        assert(!dyingOut.includes("ENDED"), "its run still goes", dyingOut.trim().split("\n").slice(-1).join("").slice(0, 120));
        return (await runningIn(name, orphan)).length === 1;
      }, 250);
      const exited = new Promise((resolve) => dying.once("exit", resolve));
      dying.kill("SIGKILL");
      await exited;
      await sleep(1_500);
      const orphans = await runningIn(name, orphan);
      assert(orphans.length === 1, "the dead executor left its command running", `${String(orphans.length)} process(es)`);

      // What the engine tells before the next executor starts (no exec of the observer from here to the clean-up).
      const listed = await Promise.all(COMPONENTS.map(containerState));
      const withExec = listed.filter((c) => c.execs > 0).map((c) => c.name);
      const idle = listed.filter((c) => c.execs === 0).map((c) => c.name);
      assert(withExec.includes(name), "the engine still lists the exec of that command in the component", withExec.join(",") || "none");
      assert([cName(C, "storage"), cName(C, "worker")].every((n) => idle.includes(n)), "the other customer's components, where no task ever ran, have no exec", withExec.join(","));
      info(`after the executor died: ${String(withExec.length)} of ${String(COMPONENTS.length)} components with an exec the engine still lists`);

      // The next executor, at its start.
      const from = execLog.length;
      const next = new DockerEngineSocketAdapter(adapterOptions);
      await next.reapAppStackTasks();
      const asked = execLog.slice(from);
      const left = await runningIn(name, orphan);
      assert(left.length === 0, "the clean-up at start leaves nothing of the dead executor's run", `${String(left.length)} process(es)`);
      assert(asked.length > 0 && asked.every((e) => e.form === "kill"), "it asked only for the clean-up script, never for a command", asked.map((e) => e.form).join(",") || "nothing");
      assert(asked.some((e) => e.container === name), "it ran the clean-up in the component that had the run", asked.map((e) => e.container).join(","));
      const touched = [...new Set(asked.map((e) => e.container).filter((n) => idle.includes(n) || !COMPONENTS.includes(n)))];
      assert(touched.length === 0, "no exec was asked in a container that had none", touched.join(","));
      const now = await Promise.all(COMPONENTS.map(containerState));
      const restarted = listed.filter((c, i) => c.state !== now[i].state).map((c) => c.name);
      assert(restarted.length === 0, "no component was restarted", restarted.join(","));
      const after = await componentState(name);
      assert(after.running === true && changed(before, after).length === 0, "the first process of that component is the same", `changed: ${changed(before, after).join(",")}`);
      await next.reapAppStackTasks(); // a second pass has nothing to end and does not fail
      assert(execsOf("task", from) === 0, "a second pass starts no command either", String(execsOf("task", from)));
      const again = await task(A, "storage", ARGV.id);
      assert(endedAs(again.result, "succeeded", 0), "the cleaned component takes a new task", how(again.result));
    });

    await step("nothing-recorded", async () => {
      // Two runs of its own, so that the step proves something whatever the earlier steps did.
      const who = await task(A, "storage", ARGV.id);
      const word = await task(A, "storage", ARGV.ping);
      assert(/^uid=999\b/.test(who.result.output) && word.result.output === "PONG", "the commands really printed their words", `${how(who.result)}; ${how(word.result)}`);
      const printedLines = outputs.flatMap((o) => o.split("\n")).map((l) => l.trim()).filter((l) => l.length >= 8);
      const needles = [...new Set(["uid=", "PONG", "sleep 30", ...ARGV_MARKS, ...printedLines])];
      const texts = [
        ["the output of this process", printed.join("")],
        ["the output of the helper process", `${dyingOut}\n${dyingErr}`],
        ["the requests the gate saw", gateLog.join("\n")],
      ];
      let fileCount = 0;
      for (const dir of [tmpDir, secretsRoot]) {
        for (const f of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
          if (!f.isFile()) continue;
          fileCount += 1;
          const file = path.join(f.parentPath ?? f.path, f.name);
          texts.push([`the file ${file}`, await readFile(file, "latin1").catch(() => "")]);
        }
      }
      const where = texts.filter(([, text]) => needles.some((n) => text.includes(n))).map(([what]) => what);
      assert(where.length === 0, "nothing a run printed, and no command, is in what this process printed, in the gate's log or in a file of the run's directories", `found in: ${where.join(", ")}`);
      info(`searched ${String(texts.length)} texts (${String(fileCount)} files of the run's directories) for ${String(needles.length)} words`);
    });

    await step("remove-everything", async () => {
      for (const stackId of [A, B, C]) {
        await adapter.removeAppStack({ stackId, organizationId: OWNER.get(stackId), removeVolumes: true });
        await gone(stackId, "removed with its data");
      }
    });

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only about this run's objects, in the allowed forms", gateDenied.slice(0, 3).join(" | "));
      const sent = gateLog.slice(afterSelfTest);
      const banned = sent.filter((l) => /\/(prune|system|build|archive|images\/create)(\/|\?| |$)/.test(l.split(" ")[1]));
      const attaches = sent.filter((l) => /\/networks\/[^/]+\/(connect|disconnect)/.test(l));
      assert(banned.length === 0 && attaches.length === 0, "no prune, system, build, archive, pull or network attach request", [...banned, ...attaches].join(" | "));
      const [commands, cleanups] = [execsOf("task"), execsOf("kill")];
      const piped = gateLog.filter((l) => l.endsWith("-> upgrade")).length;
      assert(commands > 0 && cleanups >= 2 * commands, "every command had a clean-up before it and one after it", `${String(commands)} commands, ${String(cleanups)} clean-ups`);
      info(`gate saw ${gateLog.length} request(s): ${String(commands)} commands, ${String(cleanups)} clean-ups, ${String(piped)} raw streams, ${gateDenied.length} denied`);
    });
  } finally {
    await cleanup();
    total += 1;
    const left = [];
    for (const args of [["ps", "-aq", ...OURS_FILTER], ["network", "ls", "-q", ...OURS_FILTER], ["volume", "ls", "-q", ...OURS_FILTER]]) {
      if ((await docker(args).catch(() => "x")).trim() !== "") left.push(args[0]);
    }
    // docker ps -a, docker network ls and docker volume ls, whole: nothing in them may carry this run's marker.
    const S3 = await snapshot().catch(() => null);
    if (S3 === null) {
      left.push("snapshot failed");
    } else {
      const listed = KINDS.flatMap((k) => S3[k].filter(ours));
      if (listed.length > 0) left.push(`still listed: ${listed.join(",")}`);
      if (S0 !== null) {
        const removed = removedSince(S0, S3);
        if (removed.length > 0) left.push(`pre-existing removed: ${removed.join(",")}`);
        const added = KINDS.flatMap((k) => S3[k].filter((l) => !S0[k].includes(l)));
        if (added.length > 0) info(`objects added meanwhile by someone else: ${added.join(", ")}`);
      }
    }
    if (proxyBefore !== undefined) {
      const proxyAfter = await liveProxyNetworks().catch(() => undefined);
      if (proxyAfter === undefined) {
        left.push(`the networks of ${String(LIVE_PROXY)} could not be read`);
      } else if ((proxyAfter ?? []).some(ours)) {
        left.push(`${String(LIVE_PROXY)} is on a network of this run`);
      } else if (proxyBefore !== null && !same(proxyAfter, proxyBefore)) {
        const names = (list) => (list ?? []).map((l) => l.split(" ")[0]);
        const gained = (proxyAfter ?? []).filter((l) => !proxyBefore.includes(l));
        const lost = proxyBefore.filter((l) => !(proxyAfter ?? []).includes(l));
        left.push(`the networks of ${String(LIVE_PROXY)} changed: gained [${names(gained).join(" ")}], lost [${names(lost).join(" ")}]`);
      } else if (proxyBefore === null && proxyAfter !== null) {
        info(`${String(LIVE_PROXY)} was started meanwhile by someone else`);
      }
    }
    for (const dir of [tmpDir, secretsRoot]) if (await exists(dir)) left.push(dir);
    const shm = (await readdir("/dev/shm").catch(() => [])).filter((n) => n.startsWith(`${runPrefix}-`));
    left.push(...shm);
    if (gateServer?.listening) left.push("gate");
    if (streams.size > 0) left.push("streams");
    if (dyingRuns()) left.push("helper process");
    const last = "nothing-left";
    if (left.length === 0) {
      passed += 1;
      console.log(`PASS ${last}`);
    } else {
      console.log(`FAIL ${last}: ${left.join(",")}`);
    }
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`RESULT ${String(passed)}/${String(total)} passed${skipped > 0 ? `, ${String(skipped)} skipped (not counted in n/m)` : ""} in ${s}s`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
process.exit(process.exitCode ?? 1); // exit now: a clean-up tried again in the background keeps a timer
