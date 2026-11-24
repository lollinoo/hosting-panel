#!/usr/bin/env node
/**
 * Real-Docker acceptance of the terminal in an application component (ADR-0041) through the PRODUCTION
 * DockerEngineSocketAdapter from apps/docker-executor/dist, called step by step as the API would: the shell is the
 * component (its user, its capabilities, its mounts, its network and no more), Ctrl-C and Ctrl-D, an end that leaves
 * nothing running (close, idle, shell exit, executor death and the clean-up at the next start, restart and stop of the
 * component), the limits across containers and customers, the refusal of a container that is not that component, and
 * that nothing typed or printed is kept anywhere.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a…d, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_term_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created) and the create bodies keep the hardening; list answers are filtered to this run's
 *    objects, so the clean-up at start (which lists every component on the server) sees only this run's. An exec is
 *    forwarded only in a container of this run and only when its body is exactly the product's shell or the product's
 *    clean-up script, with no user, directory or privilege; the raw stream of an exec is piped only for an exec the gate
 *    saw created. The first step proves that it denies foreign and unsafe requests.
 *  - No image is ever pulled (the gate denies every pull; the seed image must be local), no edge network is created
 *    (the gate allows only a private network, internal) and no network is attached to anything: the live panel's
 *    executor attaches its proxy to any edge network it finds.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/exec/logs only ever name this run's objects.
 *  - What a session prints is matched and never printed: a failure names a check, not the output.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): every session closed, the helper process killed,
 *    removeAppStack(..., removeVolumes: true) for every stack, then leftovers by exact own names through the gate, the
 *    piped streams destroyed, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-terminal.mjs (alone: not next to another heavy job).
 * Steps: gate-self-test, preflight, snapshot-before, plans-compile-from-seed, applications-deploy,
 * shell-is-the-component, shell-reaches-only-its-own-application, ctrl-c-interrupts, close-leaves-nothing,
 * ctrl-d-ends-the-session, idle-ends-the-session (with a shortened idle time), limits-across-containers,
 * refuses-what-is-not-that-component, cleanup-after-executor-death, restart-and-stop-end-the-session, nothing-recorded,
 * remove-everything, gate-clean, nothing-left.
 * Each prints PASS/FAIL <step>; final line RESULT n/m passed.
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
  APP_STACK_TERMINAL_KILL_SCRIPT,
  DockerEngineSocketAdapter,
  appStackComponentLabels,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackVolumeName,
} = executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema } = contracts;

/** Everything this process writes to its output, kept to prove that nothing of a session is ever printed. */
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
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_term_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const OTHER_ORG = `org_swarmtest_${hex}_other`;
/** A, B: two applications of one customer; C: one of another customer; D: only impostor containers; E: never created. */
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((s) => `stk_swarmtest_${hex}_${s}`);
const OWNER = new Map([[A, ORG], [B, ORG], [C, OTHER_ORG], [D, ORG]]);
/** The idle time of the idle step only; every other step runs with the product's own limits. */
const IDLE_MS = 4_000;
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

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
/** The counter the worker increments, read inside the storage component (null when unset or unreadable). */
const ticks = async (stackId) => {
  const out = (await docker(["exec", cName(stackId, "storage"), "valkey-cli", "GET", "worker:ticks"], 20_000).catch(() => "")).trim();
  return /^[0-9]+$/.test(out) ? Number(out) : null;
};

// ---- the observer inside a component (the docker CLI, never the product) ----
/** How many processes of a container carry the mark the product gives a session's shell (inherited by what it starts). */
const COUNT_MARKED =
  'n=0; for p in /proc/[0-9]*; do tr "\\0" "\\n" <"$p/environ" 2>/dev/null | grep -q "^HP_TERMINAL_SESSION=" && n=$((n+1)); done; echo "$n"';
const marked = async (name) => Number((await docker(["exec", name, "sh", "-c", COUNT_MARKED], 20_000)).trim());
const processes = async (name) =>
  (await docker(["exec", name, "ps", "-o", "args"], 20_000))
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("ps -o"));
const runs = async (name, args) => (await processes(name)).includes(args);
const sleeps = async (name, pattern) => (await processes(name)).filter((l) => pattern.test(l));
const startedAt = async (name) => (await inspectOf(name)).State.StartedAt;
/** The component's own processes: its init and its program. */
const alive = async (name, program) => {
  const list = await processes(name);
  return list.some((l) => l.startsWith("tini ")) && list.some((l) => l.startsWith(program));
};
/** The identity lines of a process status, one "Key: values" string each. */
const identity = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).join(" "))
    .filter((l) => /^(Uid|Gid|Groups|Cap[A-Za-z]+|NoNewPrivs):/.test(l));
const IDENTITY = "grep -E '^(Uid|Gid|Groups|Cap|NoNewPrivs)' /proc/self/status";

// ---- sessions ----
/** The prompt the product sets (PS1=$PWD $ ) in the image's working directory. */
const PROMPT = "/data $ ";
/** The image's shell asks the terminal where the cursor is after each prompt. */
const ASK = "\x1b[6n";
const atPrompt = (out) => (out.endsWith(ASK) ? out.slice(0, -ASK.length) : out).endsWith(PROMPT);
const sid = () => `term_${randomBytes(16).toString("hex")}`;
const state = (id = sid()) => ({ id, cursor: 0, out: "" });
/** Reads until done(output) or the session's end (returned); only reads keep a session from idling. */
async function readUntil(a, s, done, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await a.readTerminal({ sessionId: s.id, cursor: s.cursor });
    s.out += r.output;
    s.cursor = r.cursor;
    if (r.ended) return r.ended;
    if (done(s.out)) return null;
  }
  throw new StepAssertionError(`${what} within ${String(timeoutMs / 1000)} s / not seen (${String(s.out.length)} characters read)`);
}
/** Types one line and reads until the prompt is back; returns what came after it was sent (matched, never printed). */
async function type(a, s, line, timeoutMs = 15_000) {
  const mark = s.out.length;
  await a.writeTerminal({ sessionId: s.id, input: `${line}\n` });
  const fresh = (out) => out.slice(mark);
  const ended = await readUntil(a, s, (out) => fresh(out).includes("\n") && atPrompt(fresh(out)), "the prompt after a typed line", timeoutMs);
  assert(ended === null, "the session stays open after a typed line", String(ended?.reason));
  return fresh(s.out);
}
const openIn = (a, s, stackId, componentKey, organizationId = OWNER.get(stackId)) =>
  a.openAppStackTerminal({ sessionId: s.id, stackId, organizationId, componentKey });
/** Opens a session, waits for the first prompt, runs fn and closes whatever happened. */
async function withSession(a, stackId, componentKey, fn) {
  const s = state();
  const opened = await openIn(a, s, stackId, componentKey);
  try {
    assert(opened.containerName === cName(stackId, componentKey), `the session is in ${componentKey} of ${stackId}`, String(opened.containerName));
    const ended = await readUntil(a, s, atPrompt, "the first prompt");
    assert(ended === null, "the shell shows its prompt", String(ended?.reason));
    return await fn(s, opened);
  } finally {
    await a.closeTerminal({ sessionId: s.id }).catch(() => undefined);
  }
}

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
/** The execs the gate saw created: only their state is read and only their stream is piped. */
const ownExecs = new Set();
/** The raw streams being piped: [client, engine]. */
const streams = new Set();
const execSeen = { shell: 0, kill: 0 };
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

/** "shell" or "kill" when the exec body is exactly one of the two the product sends for a component; otherwise null. */
function execForm(body) {
  if (["User", "WorkingDir", "Privileged", "DetachKeys"].some((k) => body[k] !== undefined)) return null;
  const cmd = Array.isArray(body.Cmd) ? body.Cmd : [];
  if (same(cmd, ["/bin/sh"])) {
    const env = Array.isArray(body.Env) ? body.Env : [];
    const exact =
      env.length === 3 && env[0] === "TERM=dumb" && env[1] === "PS1=$PWD $ " && /^HP_TERMINAL_SESSION=term_[0-9a-f]{32}$/.test(String(env[2]));
    return exact && body.Tty === true && same(body.ConsoleSize, [24, 80]) ? "shell" : null;
  }
  const kill =
    cmd.length === 5 &&
    cmd[0] === "/bin/sh" &&
    cmd[1] === "-c" &&
    cmd[2] === APP_STACK_TERMINAL_KILL_SCRIPT &&
    cmd[3] === "sh" &&
    /^(term_[0-9a-f]{32})?$/.test(String(cmd[4]));
  return kill && body.Tty !== true && body.Env === undefined ? "kill" : null;
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
    return problem === null ? fwd({ register: true }) : deny(problem);
  }
  if (method === "POST" && (m = p.match(/^\/containers\/([^/]+)\/exec$/))) {
    if (!isOwn(m[1])) return deny("exec in a foreign container");
    const form = execForm(body);
    if (form === null) return deny("an exec that is not the product's shell or clean-up");
    execSeen[form] += 1;
    return fwd({ registerExec: true });
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
      const out = Buffer.from(bodyText);
      const headers = { ...req.headers, host: "docker" };
      delete headers["transfer-encoding"];
      if (out.length > 0 || req.method === "POST") headers["content-length"] = String(out.length);
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.register && ures.statusCode === 201) ownIds.add(JSON.parse(body.toString("utf8")).Id);
          if (verdict.registerExec && ures.statusCode === 201) ownExecs.add(JSON.parse(body.toString("utf8")).Id);
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
const DYING_EXECUTOR = `
const [dist, options, open] = process.argv.slice(-3);
const { DockerEngineSocketAdapter } = await import(dist);
const adapter = new DockerEngineSocketAdapter(JSON.parse(options));
const req = JSON.parse(open);
await adapter.openAppStackTerminal(req);
let cursor = 0;
const read = async () => {
  cursor = (await adapter.readTerminal({ sessionId: req.sessionId, cursor })).cursor;
};
for (const line of ["sleep 311 &", "setsid sleep 312 &", "nohup sleep 313 >/dev/null 2>&1 &"]) {
  await read();
  await adapter.writeTerminal({ sessionId: req.sessionId, input: line + "\\n" });
  await read();
}
console.log("READY");
setInterval(() => void read().catch(() => undefined), 500);
`;
let dying = null;
const dyingRuns = () => dying !== null && dying.exitCode === null && dying.signalCode === null;

// ---- cleanup ----
let adapter = null;
const adapters = [];
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (dyingRuns()) dying.kill("SIGKILL");
    for (const a of adapters) {
      for (const r of await a.listTerminals().catch(() => [])) await a.closeTerminal({ sessionId: r.sessionId }).catch(() => undefined);
    }
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
    console.log(`SKIP accept-app-terminal: no Docker Engine (${err.message}); nothing was created`);
    process.exit(1);
  }
  let passed = 0;
  let total = 0;
  const step = async (name, fn) => {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
      return true;
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      return false;
    }
  };
  const info = (msg) => console.log(`INFO ${msg}`);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  gateSocket = path.join(tmpDir, "docker-gate.sock");
  const unused = (x) => `${runPrefix}_${x}_unused`;
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
    terminalLimits: { readWaitMs: 1_000 },
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
  const execRequests = (from) => gateLog.slice(from).filter((l) => /\/exec(\/|\?| )/.test(`${l.split(" ")[1]} `));
  const liveSessions = async (a = adapter) => (await a.listTerminals()).filter((r) => r.ended === null);
  const COMPONENTS = [A, B, C].flatMap((stackId) => ["storage", "worker"].map((key) => cName(stackId, key)));
  const noneMarked = async () => {
    const counts = await Promise.all(COMPONENTS.map(marked));
    return counts.every((n) => n === 0) ? true : null;
  };
  let S0 = null;
  /** Where the self-test's own requests end in the gate's log. */
  let afterSelfTest = 0;
  /** Sessions ended because their container stopped: everything in it ended with it, so no clean-up runs there. */
  let endedWithContainer = 0;
  let planA = null;
  let planB = null;
  let planC = null;
  let planD = null;

  try {
    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    adapters.push(adapter);
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
      const shellEnv = ["TERM=dumb", "PS1=$PWD $ ", `HP_TERMINAL_SESSION=${sid()}`];
      const attach = { AttachStdin: true, AttachStdout: true, AttachStderr: true };
      const shellForm = (over = {}) => JSON.stringify({ Cmd: ["/bin/sh"], Env: shellEnv, ...attach, Tty: true, ConsoleSize: [24, 80], ...over });
      const killForm = (arg, over = {}) => JSON.stringify({ Cmd: ["/bin/sh", "-c", APP_STACK_TERMINAL_KILL_SCRIPT, "sh", arg], ...attach, Tty: false, ...over });
      const execIn = (ref) => `/v1.45/containers/${ref}/exec`;
      const [repo, digest] = SEED_IMAGE.split("@");
      const cases = [
        ["GET", `/v1.45/containers/${foreignName}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/logs?stdout=1`, ""],
        ["POST", `/v1.45/containers/${foreignId}/restart?t=10`, ""],
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
        ["POST", execIn(foreignName), shellForm()],
        ["POST", execIn(foreignId), shellForm()],
        ["POST", execIn(foreignId), killForm("")],
        ["POST", execIn(storage), JSON.stringify({ Cmd: ["true"] })],
        ["POST", execIn(storage), shellForm({ User: "0:0" })],
        ["POST", execIn(storage), shellForm({ User: "999:1000" })],
        ["POST", execIn(storage), shellForm({ WorkingDir: "/" })],
        ["POST", execIn(storage), shellForm({ Privileged: true })],
        ["POST", execIn(storage), shellForm({ Cmd: ["/bin/bash"] })],
        ["POST", execIn(storage), shellForm({ Cmd: ["/bin/sh", "-c", "id"] })],
        ["POST", execIn(storage), shellForm({ Env: [...shellEnv, "X=1"] })],
        ["POST", execIn(storage), shellForm({ Env: [shellEnv[0], shellEnv[1], "HP_TERMINAL_SESSION=term_x"] })],
        ["POST", execIn(storage), shellForm({ Tty: false })],
        ["POST", execIn(storage), shellForm({ ConsoleSize: [200, 400] })],
        ["POST", execIn(storage), killForm("", { User: "0" })],
        ["POST", execIn(storage), killForm("", { Env: ["X=1"] })],
        ["POST", execIn(storage), killForm("x; id")],
        ["POST", execIn(storage), JSON.stringify({ Cmd: ["/bin/sh", "-c", `${APP_STACK_TERMINAL_KILL_SCRIPT}; id`, "sh", ""], ...attach, Tty: false })],
        ["GET", `/v1.45/exec/${noExec}/json`, ""],
        ["POST", `/v1.45/exec/${noExec}/start`, '{"Detach":false,"Tty":true}'],
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
        ["POST", execIn(storage), shellForm()],
        ["POST", execIn(storage), killForm("")],
        ["POST", execIn(storage), killForm(sid())],
        ["POST", "/v1.45/networks/create", netBody(ownNet, "app_internal")],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({})],
        ["GET", `/v1.45/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ["io.hostingpanel.app_component"] }))}`, ""],
      ];
      const refused = needed.filter(([method, url, body]) => judge(method, url, body).kind !== "forward");
      assert(refused.length === 0, "judge() forwards what the product needs", refused.map(([method, url]) => `${method} ${url}`).join(" | "));
      // Through the socket: a read and a stream request about objects that do not exist, harmless even if let through.
      const denied = await viaGate("GET", `/v1.45/containers/hp_selftest_${hex}/json`);
      assert(denied.status === 403 && gateDenied.length === 1, "the socket answers 403 for a foreign name and records the denial", `${denied.status} ${gateDenied.length}`);
      const stream = await streamViaGate(`/v1.45/exec/${noExec}/start`);
      assert(stream.status === 403 && !stream.stream && gateDenied.length === 2, "no raw stream for an exec the gate did not see created", JSON.stringify(stream));
      const ping = await viaGate("GET", "/_ping");
      assert(ping.status === 200 && ping.body === "OK", "the socket forwards an allowed request to the Engine", `${ping.status} ${ping.body}`);
      gateDenied.length = 0; // the expected self-test denials; from here on any denial fails gate-clean
      execSeen.shell = 0;
      execSeen.kill = 0;
      afterSelfTest = gateLog.length;
    });
    if (!gateOk) {
      adapter = null; // nothing was created: cleanup sends nothing through a gate that failed its self-test
      adapters.length = 0;
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
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
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
      assert((await noneMarked()) === true && asked === 0, "no session yet: no marked process, no exec asked", String(asked));
    });
    if (!deployed) return;

    await step("shell-is-the-component", async () => {
      for (const key of ["storage", "worker"]) {
        const name = cName(A, key);
        // What the component is: its first process, read by the observer.
        const own = identity(await docker(["exec", name, "grep", "-E", "^(Uid|Gid|Groups|Cap|NoNewPrivs)", "/proc/1/status"], 20_000));
        assert(
          own.includes("Uid: 999 999 999 999") && own.includes("Gid: 1000 1000 1000 1000") && own.includes("CapEff: 0000000000000000") && own.includes("NoNewPrivs: 1"),
          `${key} itself runs as 999:1000 with no capability and no new privileges`,
          own.join("; "),
        );
        await withSession(adapter, A, key, async (s, opened) => {
          assert(same(Object.keys(opened).sort(), ["containerName", "openedAt"]) && !hasDockerId(opened), "the answer holds the container's name and the time, no Docker id", Object.keys(opened).join(","));
          const size = await type(adapter, s, "stty size");
          assert(/\n24 80\r?\n/.test(size), `${key}: a terminal of 24 rows and 80 columns`, `${String(size.length)} characters`);
          const id = await type(adapter, s, "id");
          assert(id.includes("uid=999(") && id.includes("gid=1000(") && !id.includes("uid=0"), `${key}: the shell runs as 999:1000`, `uid999=${String(id.includes("uid=999("))} root=${String(id.includes("uid=0"))}`);
          const mine = identity(await type(adapter, s, IDENTITY));
          const differ = [...new Set([...own, ...mine])].filter((l) => !(own.includes(l) && mine.includes(l))).map((l) => l.split(":")[0]);
          assert(mine.length === own.length && differ.length === 0, `${key}: the shell has the user, groups and capabilities of the component and no more`, `${String(mine.length)}/${String(own.length)} lines, different: ${[...new Set(differ)].join(",")}`);
          const root = await type(adapter, s, "touch /x; echo rc=$?");
          assert(root.includes("Read-only file system") && /\nrc=1\r?\n/.test(root), `${key}: the root file system is read-only`, `${String(root.length)} characters`);
          const data = await type(adapter, s, "touch /data/t; echo rc=$?; rm -f /data/t");
          if (key === "storage") assert(/\nrc=0\r?\n/.test(data), "storage: the shell writes the component's own volume", `${String(data.length)} characters`);
          else assert(data.includes("Read-only file system") && /\nrc=1\r?\n/.test(data), "worker: the component mounts no volume and neither does its shell", `${String(data.length)} characters`);
        });
        const c = await inspectOf(name);
        assert(c.State.Running === true && c.RestartCount === 0, `${key} runs as before`, JSON.stringify(c.State.Status));
      }
      assert(execSeen.shell === 2, "two shells were asked, each with no user and no directory (the gate lets no other form through)", String(execSeen.shell));
    });

    await step("shell-reaches-only-its-own-application", async () => {
      const otherIp = (await inspectOf(cName(B, "storage"))).NetworkSettings.Networks[appStackInternalNetworkName(B)]?.IPAddress ?? "";
      assert(/^\d+\.\d+\.\d+\.\d+$/.test(otherIp), "the storage of the second application has an address on its own network", otherIp);
      await withSession(adapter, A, "worker", async (s) => {
        const own = await type(adapter, s, "timeout 5 valkey-cli -h storage ping; echo rc=$?", 20_000);
        assert(/\nPONG\r?\n/.test(own) && /\nrc=0\r?\n/.test(own), "the worker's shell reaches the storage of its own application", `${String(own.length)} characters`);
        const byAddress = await type(adapter, s, `timeout 5 valkey-cli -h ${otherIp} ping; echo rc=$?`, 20_000);
        assert(!/\nPONG\r?\n/.test(byAddress) && /\nrc=[1-9][0-9]*\r?\n/.test(byAddress), "it does not reach the storage of another application by address", `${String(byAddress.length)} characters`);
        await type(adapter, s, `H=${cName(B, "storage")}`);
        const byName = await type(adapter, s, "timeout 5 valkey-cli -h $H ping; echo rc=$?", 20_000);
        assert(!/\nPONG\r?\n/.test(byName) && /\nrc=[1-9][0-9]*\r?\n/.test(byName), "it does not reach it by name either", `${String(byName.length)} characters`);
      });
    });

    await step("ctrl-c-interrupts", async () => {
      const name = cName(A, "storage");
      await withSession(adapter, A, "storage", async (s) => {
        await adapter.writeTerminal({ sessionId: s.id, input: "sleep 300\n" });
        await until("sleep 300 runs in the component", 15_000, async () => {
          await readUntil(adapter, s, () => true, "a read");
          return runs(name, "sleep 300");
        });
        const mark = s.out.length;
        await adapter.writeTerminal({ sessionId: s.id, input: "\x03" });
        const ended = await readUntil(adapter, s, (out) => out.slice(mark).includes("^C") && atPrompt(out.slice(mark)), "^C and the prompt");
        assert(ended === null, "Ctrl-C does not end the session", String(ended?.reason));
        await until("the interrupted program is gone", 5_000, async () => !(await runs(name, "sleep 300")), 250);
        const after = await type(adapter, s, "echo still_$((20+3))");
        assert(/\nstill_23\r?\n/.test(after), "the session still answers", `${String(after.length)} characters`);
      });
    });

    await step("close-leaves-nothing", async () => {
      const name = cName(A, "storage");
      const started = await startedAt(name);
      const before = await ticks(A);
      const s = state();
      await openIn(adapter, s, A, "storage");
      try {
        await readUntil(adapter, s, atPrompt, "the first prompt");
        for (const line of ["sleep 301 &", "nohup sleep 302 >/dev/null 2>&1 &", "setsid sleep 303 &"]) await type(adapter, s, line);
        await until("the three background programs run", 10_000, async () => (await sleeps(name, /^sleep 30[123]$/)).length === 3, 250);
        const live = await marked(name);
        assert(live >= 4, "the shell and what it started carry the session's mark", String(live));
        const ended = await adapter.closeTerminal({ sessionId: s.id });
        assert(ended.reason === "closed" && !hasDockerId(ended), "close answers closed", JSON.stringify(ended.reason));
        const left = await marked(name);
        const still = await sleeps(name, /^sleep 30[123]$/);
        assert(left === 0 && still.length === 0, "nothing the session started runs once close has answered (background, nohup and setsid included)", `${String(left)} marked, ${String(still.length)} programs`);
        const gone = await rejection(adapter.readTerminal({ sessionId: s.id, cursor: 0 }));
        assert(reasonOf(gone) === "NOT_FOUND", "a closed session can no longer be read", gone ? reasonOf(gone) : "readable");
      } finally {
        await adapter.closeTerminal({ sessionId: s.id }).catch(() => undefined);
      }
      assert(await alive(name, "valkey-server"), "the component's own processes still run", "missing");
      const c = await inspectOf(name);
      assert(c.State.StartedAt === started && c.RestartCount === 0, "the component was not restarted", `${c.State.StartedAt} ${String(c.RestartCount)}`);
      await until("the worker still writes to the storage", 20_000, async () => {
        const now = await ticks(A);
        return before !== null && now !== null && now > before;
      }, 1_000);
    });

    await step("ctrl-d-ends-the-session", async () => {
      const name = cName(A, "worker");
      const s = state();
      await openIn(adapter, s, A, "worker");
      try {
        await readUntil(adapter, s, atPrompt, "the first prompt");
        await type(adapter, s, "sleep 304 &");
        await until("its background program runs", 10_000, () => runs(name, "sleep 304"), 250);
        await adapter.writeTerminal({ sessionId: s.id, input: "\x04" });
        const ended = await readUntil(adapter, s, () => false, "the end of the session", 20_000);
        assert(ended?.reason === "shell_exited", "Ctrl-D ends the session as shell_exited", String(ended?.reason));
        await until("what the shell left behind is ended too", 10_000, async () => (await marked(name)) === 0 && !(await runs(name, "sleep 304")), 250);
        const late = await rejection(adapter.writeTerminal({ sessionId: s.id, input: "id\n" }));
        assert(reasonOf(late) === "OPERATION_INTERRUPTED", "an ended session takes no more input", late ? reasonOf(late) : "accepted");
      } finally {
        await adapter.closeTerminal({ sessionId: s.id }).catch(() => undefined);
      }
      assert(await alive(name, "valkey-cli"), "the worker itself still runs", "missing");
    });

    await step("idle-ends-the-session", async () => {
      const idle = new DockerEngineSocketAdapter({ ...adapterOptions, terminalLimits: { idleMs: IDLE_MS, readWaitMs: 1_000 } });
      adapters.push(idle);
      const name = cName(B, "storage");
      const s = state();
      await openIn(idle, s, B, "storage");
      try {
        await readUntil(idle, s, atPrompt, "the first prompt");
        await type(idle, s, "sleep 305 &");
        const last = Date.now();
        await idle.readTerminal({ sessionId: s.id, cursor: s.cursor }); // the last read: the idle time counts from here
        assert(await runs(name, "sleep 305"), "its background program runs", "missing");
        await sleep(Math.max(0, IDLE_MS + 1_500 - (Date.now() - last)));
        const rec = (await idle.listTerminals()).find((r) => r.sessionId === s.id);
        assert(rec?.ended?.reason === "idle", "the session ended as idle with nobody reading", JSON.stringify(rec?.ended?.reason ?? null));
        const waited = Date.parse(rec.ended.at) - last;
        assert(waited >= IDLE_MS - 50 && waited < IDLE_MS + 1_500, `it ended ${String(IDLE_MS)} ms after the last read`, String(waited));
        assert(!hasDockerId(rec) && rec.containerName === name, "its record names the container, no Docker id", Object.keys(rec).join(","));
        await until("nothing of the idle session runs", 10_000, async () => (await marked(name)) === 0 && !(await runs(name, "sleep 305")), 250);
      } finally {
        await idle.closeTerminal({ sessionId: s.id }).catch(() => undefined);
      }
      assert(await alive(name, "valkey-server"), "the component's own processes still run", "missing");
    });

    await step("limits-across-containers", async () => {
      const open = [];
      const start = async (stackId, key, s = state()) => {
        const r = await openIn(adapter, s, stackId, key);
        open.push(s);
        return { s, ...r };
      };
      try {
        const first = await start(A, "storage");
        const twice = await rejection(openIn(adapter, state(), A, "storage"));
        assert(reasonOf(twice) === "RESOURCE_LOCKED", "a second session in the same component is refused", twice ? reasonOf(twice) : "opened");
        const reused = await rejection(openIn(adapter, state(first.s.id), A, "worker"));
        assert(reasonOf(reused) === "ALREADY_EXISTS", "a session id is never used twice", reused ? reasonOf(reused) : "opened");
        const second = await start(A, "worker");
        const third = await start(B, "storage");
        await start(B, "worker");
        const live = await liveSessions();
        assert(live.length === 4 && new Set(live.map((r) => r.containerName)).size === 4, "four sessions, each in its own container", String(live.length));
        const mark = gateLog.length;
        const fifth = await rejection(openIn(adapter, state(), C, "storage"));
        assert(reasonOf(fifth) === "QUOTA_EXCEEDED" && gateLog.length === mark, "a fifth session on the server is refused, for another customer too, before any Docker request", `${fifth ? reasonOf(fifth) : "opened"} ${String(gateLog.length - mark)}`);
        // Two sessions never see each other's output.
        const word = `w${randomBytes(8).toString("hex")}`;
        await readUntil(adapter, first.s, atPrompt, "the first prompt");
        await readUntil(adapter, third.s, atPrompt, "the first prompt");
        await type(adapter, first.s, `echo ${word}`);
        await type(adapter, third.s, "id");
        assert(first.s.out.includes(word) && !third.s.out.includes(word), "what one session prints is not in another", `${String(first.s.out.includes(word))} ${String(third.s.out.includes(word))}`);
        const closed = await adapter.closeTerminal({ sessionId: second.s.id });
        assert(closed.reason === "closed", "one session closed", String(closed.reason));
        const freed = await start(C, "storage");
        assert(freed.containerName === cName(C, "storage"), "with a place free the other customer's application opens", String(freed.containerName));
      } finally {
        for (const s of open) await adapter.closeTerminal({ sessionId: s.id }).catch(() => undefined);
      }
      assert((await liveSessions()).length === 0 && (await noneMarked()) === true, "every session closed, no marked process in any component", "left");
    });

    await step("refuses-what-is-not-that-component", async () => {
      const mark = gateLog.length;
      const refusal = async (stackId, organizationId, componentKey) =>
        reasonOf((await rejection(adapter.openAppStackTerminal({ sessionId: sid(), stackId, organizationId, componentKey }))) ?? "opened");
      assert((await refusal(C, ORG, "storage")) === "STACK_NAMESPACE_CONFLICT", "an application asked as another customer's is refused", await refusal(C, ORG, "storage"));
      assert((await refusal(A, OTHER_ORG, "worker")) === "STACK_NAMESPACE_CONFLICT", "and the other way round", await refusal(A, OTHER_ORG, "worker"));
      assert((await refusal(A, ORG, "nosuch")) === "NOT_FOUND", "a component the application does not have is not found", await refusal(A, ORG, "nosuch"));
      assert((await refusal(E, ORG, "storage")) === "NOT_FOUND", "an application that does not exist is not found", await refusal(E, ORG, "storage"));

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
        assert(execRequests(mark).length === 0, "every refusal came before any exec request", execRequests(mark).join(" | "));
        assert((await liveSessions()).length === 0, "a refused open keeps no session", "kept");
        // The control: the same container with the labels of the component is that component.
        await make(right);
        await withSession(adapter, D, "storage", async (s) => {
          const id = await type(adapter, s, "id");
          assert(id.includes("uid=999("), "with the right labels the same container is accepted: the labels decide", `${String(id.length)} characters`);
        });
      } finally {
        await drop().catch(() => undefined);
      }
      await gone(D, "the impostors");
    });

    await step("cleanup-after-executor-death", async () => {
      const name = cName(A, "storage");
      const others = COMPONENTS.filter((n) => n !== name);
      const startedBefore = await Promise.all(COMPONENTS.map(startedAt));
      const req = { sessionId: sid(), stackId: A, organizationId: ORG, componentKey: "storage" };
      const args = ["--input-type=module", "-e", DYING_EXECUTOR, "--", pathToFileURL(DIST[0]).href, JSON.stringify(adapterOptions), JSON.stringify(req)];
      dying = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let childOut = "";
      let childErr = "";
      dying.stdout.on("data", (c) => (childOut += String(c)));
      dying.stderr.on("data", (c) => (childErr += String(c)));
      await until("the other executor has its session", 30_000, () => {
        assert(dyingRuns(), "the other executor runs", childErr.trim().split("\n").slice(-2).join(" / ").slice(0, 300));
        return childOut.includes("READY");
      }, 250);
      await until("what its session started runs", 10_000, async () => (await sleeps(name, /^sleep 31[123]$/)).length === 3, 250);
      const exited = new Promise((resolve) => dying.once("exit", resolve));
      dying.kill("SIGKILL");
      await exited;
      await sleep(1_500);
      const orphans = await marked(name);
      const still = await sleeps(name, /^sleep 31[123]$/);
      const execs = (await inspectOf(name)).ExecIDs ?? [];
      assert(orphans >= 4 && still.length === 3 && execs.length > 0, "the dead executor left its shell and what it started running", `${String(orphans)} marked, ${String(still.length)} programs, ${String(execs.length)} execs`);
      info(`after the executor died: ${String(orphans)} marked processes left in the component`);
      // The next executor, at its start.
      const kills = execSeen.kill;
      const next = new DockerEngineSocketAdapter(adapterOptions);
      adapters.push(next);
      await next.reapTerminalShells();
      const left = await marked(name);
      const programs = await sleeps(name, /^sleep 31[123]$/);
      assert(left === 0 && programs.length === 0, "the clean-up at start leaves nothing of the dead executor's session", `${String(left)} marked, ${String(programs.length)} programs`);
      assert(execSeen.kill > kills, "it ran the clean-up script in the component", String(execSeen.kill - kills));
      assert(await alive(name, "valkey-server"), "the component's own processes still run", "missing");
      const startedAfter = await Promise.all(COMPONENTS.map(startedAt));
      assert(same(startedBefore, startedAfter), "no component was restarted", "restarted");
      for (const other of others) assert(await alive(other, other.endsWith("_storage") ? "valkey-server" : "valkey-cli"), `${other} still runs`, "missing");
      await next.reapTerminalShells(); // a second pass finds nothing to end and does not fail
      await withSession(adapter, A, "storage", async (s) => {
        const id = await type(adapter, s, "id");
        assert(id.includes("uid=999("), "a new session opens in the cleaned component", `${String(id.length)} characters`);
      });
    });

    await step("restart-and-stop-end-the-session", async () => {
      const worker = state();
      await openIn(adapter, worker, B, "worker");
      try {
        await readUntil(adapter, worker, atPrompt, "the first prompt");
        await type(adapter, worker, "sleep 306 &");
        const reading = readUntil(adapter, worker, () => false, "the end of the session", 60_000);
        reading.catch(() => undefined);
        await adapter.restartAppStackComponent(startReq(planB, "worker"));
        const ended = await reading;
        assert(ended?.reason === "container_gone", "a restart of the component ends its session as container_gone", String(ended?.reason));
        endedWithContainer += 1;
      } finally {
        await adapter.closeTerminal({ sessionId: worker.id }).catch(() => undefined);
      }
      await waitHealthy(B, ["storage", "worker"]);
      assert((await marked(cName(B, "worker"))) === 0, "the restarted component holds nothing of the session", "marked");
      await withSession(adapter, B, "worker", async (s) => {
        const id = await type(adapter, s, "id");
        assert(id.includes("uid=999("), "a new session opens in the restarted component", `${String(id.length)} characters`);
      });

      const storage = state();
      await openIn(adapter, storage, B, "storage");
      try {
        await readUntil(adapter, storage, atPrompt, "the first prompt");
        const reading = readUntil(adapter, storage, () => false, "the end of the session", 60_000);
        reading.catch(() => undefined);
        await adapter.stopAppStack({ stackId: B, organizationId: ORG });
        const ended = await reading;
        assert(ended?.reason === "container_gone", "stopping the application ends its session as container_gone", String(ended?.reason));
        endedWithContainer += 1;
      } finally {
        await adapter.closeTerminal({ sessionId: storage.id }).catch(() => undefined);
      }
      const mark = gateLog.length;
      const stopped = await rejection(openIn(adapter, state(), B, "storage"));
      assert(reasonOf(stopped) === "NOT_FOUND" && String(stopped?.message).includes("not running"), "a stopped component takes no session", stopped ? `${reasonOf(stopped)}` : "opened");
      assert(execRequests(mark).length === 0, "and no exec is asked for it", execRequests(mark).join(" | "));
      assert((await liveSessions()).length === 0, "no session is left open", "left");
    });

    await step("nothing-recorded", async () => {
      const typed = `t${randomBytes(12).toString("hex")}`;
      const shown = "p_62615533"; // 7919 * 7907: printed by the shell, never typed
      const name = cName(A, "worker");
      const seen = [];
      const s = state();
      const opened = await openIn(adapter, s, A, "worker");
      seen.push(JSON.stringify(opened));
      try {
        await readUntil(adapter, s, atPrompt, "the first prompt");
        const out = await type(adapter, s, `echo ${typed}; echo p_$((7919*7907))`);
        assert(out.split(typed).length >= 3 && out.includes(shown), "the words were really typed and printed in the session", `${String(out.length)} characters`);
        seen.push(JSON.stringify(await adapter.listTerminals()));
        seen.push(JSON.stringify(await adapter.closeTerminal({ sessionId: s.id })));
      } finally {
        await adapter.closeTerminal({ sessionId: s.id }).catch(() => undefined);
      }
      seen.push(JSON.stringify(await adapter.listTerminals()));
      seen.push(JSON.stringify(await adapter.getAppStackComponentLogs({ stackId: A, organizationId: ORG, componentKey: "worker", tail: 200 })));
      seen.push(await docker(["logs", "--tail", "200", name], 30_000));
      seen.push(gateLog.join("\n"));
      seen.push(printed.join(""));
      let fileCount = 0;
      for (const dir of [tmpDir, secretsRoot]) {
        for (const f of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
          if (!f.isFile()) continue;
          fileCount += 1;
          seen.push(await readFile(path.join(f.parentPath, f.name), "latin1").catch(() => ""));
        }
      }
      const where = seen.map((text, i) => (text.includes(typed) || text.includes(shown) ? i : -1)).filter((i) => i >= 0);
      assert(where.length === 0, "nothing typed or printed is in an answer, a session record, the component's logs, the requests, this process's output or a file", `found in ${where.join(",")}`);
      assert(!seen.slice(0, 4).some((text) => /[0-9a-f]{64}/.test(text)), "no terminal answer or record holds a Docker id", "id");
      info(`searched ${String(seen.length)} texts (${String(fileCount)} files of the executor's directories)`);
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
      const piped = gateLog.filter((l) => l.endsWith("-> upgrade")).length;
      assert(
        execSeen.shell > 0 && execSeen.kill >= execSeen.shell - endedWithContainer,
        "every shell whose container kept running had its clean-up",
        `${String(execSeen.shell)} shells, ${String(endedWithContainer)} ended with their container, ${String(execSeen.kill)} clean-ups`,
      );
      info(
        `gate saw ${gateLog.length} request(s): ${String(execSeen.shell)} shells (${String(endedWithContainer)} ended with their container), ${String(execSeen.kill)} clean-ups, ${String(piped)} raw streams, ${gateDenied.length} denied`,
      );
    });
  } finally {
    await cleanup();
    total += 1;
    const left = [];
    for (const args of [["ps", "-aq", ...OURS_FILTER], ["network", "ls", "-q", ...OURS_FILTER], ["volume", "ls", "-q", ...OURS_FILTER]]) {
      if ((await docker(args).catch(() => "x")).trim() !== "") left.push(args[0]);
    }
    if (S0 !== null) {
      const S3 = await snapshot().catch(() => null);
      const removed = S3 === null ? ["snapshot failed"] : removedSince(S0, S3);
      if (removed.length > 0) left.push(`pre-existing removed: ${removed.join(",")}`);
      const added = S3 === null ? [] : KINDS.flatMap((k) => S3[k].filter((l) => !S0[k].includes(l)));
      if (added.length > 0) info(`objects added meanwhile by someone else: ${added.join(", ")}`);
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
    console.log(`RESULT ${String(passed)}/${String(total)} passed in ${s}s`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
process.exit(process.exitCode ?? 1); // exit now: the records of ended sessions keep timers
