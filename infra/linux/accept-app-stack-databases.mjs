#!/usr/bin/env node
/**
 * Real-Docker acceptance of the built-in databases and of the private link between a database and an application
 * (ADR-0039) through the PRODUCTION DockerEngineSocketAdapter from apps/docker-executor/dist, called step by step as
 * the API would: MariaDB, PostgreSQL and Valkey start under the hardening of every application component (PostgreSQL
 * with the one extra temporary area its image row declares), take their passwords only as read-only files and keep
 * their data across a restart; an application that is not linked can neither resolve nor reach a database; a link
 * attaches the running database to the application's private network under the name derived from the database's id,
 * without a restart, and applying it twice changes nothing; two applications linked to the same database still cannot
 * reach each other; the link follows a database whose container was replaced; removing an application detaches a
 * running database and a stopped one; an attachment to a network that is gone, or that was made again under the same
 * name, is repaired before the start; a target of another customer is refused; a removed link takes the way away.
 * A database application created on version 1 of its template (the source of the seed's `previousVersions`) and moved to
 * the newest version in place, the way the API does it (the container is made again on the same volume), keeps what it
 * held and starts; the newest version also starts on an empty volume (the steps that deploy it).
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a|b|v|m|p|n|x|u|w|y, so every container, network
 *    and volume name the engine derives contains swarmtest_<hex>; the script's own names and paths use
 *    hp_swarmtest_stk_<hex>; the names of the links contain swarmtest-<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created), the create bodies keep the hardening and only the temporary areas of the image, and
 *    no request carries one of the run's passwords. It forwards NO image download and NO edge network: a live panel on
 *    this machine attaches its proxy to every edge network it sees, so this script creates private networks only. A
 *    network attach is forwarded only between this run's container and this run's private network, under a name of
 *    this run. List answers are filtered to this run's objects. The first step proves the denials.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_stk_<hex>-secrets or a
 *    nonexistent own *_unused name. No proxy is created, nothing is published.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/exec/top only ever name this run's objects. A client run inside a container gets
 *    its password through the environment of the docker CLI, never on a command line.
 *  - Images: the digest-pinned refs of the mariadb, postgresql, valkey and worker-storage seeds in
 *    APP_BUILT_IN_TEMPLATES, which must already be local (fetch each first: docker pull <repository>@sha256:<digest>).
 *  - Cleanup (memoised, in `finally`, on SIGINT/SIGTERM and on a promise nobody waited for): removeAppStack(...,
 *    removeVolumes: true) for every stack, then leftovers by exact own names through the gate, gate closed, temp dirs
 *    removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-stack-databases.mjs
 * Steps: gate-self-test, preflight, snapshot-before, plans-compile-from-seeds, applications-deploy,
 * mariadb-starts-hardened, postgresql-starts-hardened, valkey-starts-hardened, data-survives-restart,
 * mariadb-earlier-version-upgrades, valkey-earlier-version-upgrades, postgresql-earlier-version-upgrades, unlinked-application-cannot-reach, link-reaches-by-alias, link-idempotent, two-applications-stay-apart,
 * link-follows-a-replaced-database, application-stop-start-keeps-links,
 * application-removal-detaches-running-database,
 * stopped-database-survives-application-removal, stale-attachment-repaired, refuses-foreign-targets,
 * detach-removes-reachability, remove-everything, host-nft-metadata-drop-on-stack-net (root only:
 * HP_ACCEPT_ROOT_CASES=1 as root), gate-clean, nothing-left.
 * Each prints PASS/FAIL/SKIP <step>; final line RESULT n/m passed (a skipped step is never a pass and is not counted).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
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
const { DockerEngineSocketAdapter, appStackContainerName, appStackInternalNetworkName, appStackSecretDirKey, appStackVolumeName } = executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema, appStackLinkAlias } = contracts;

const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
const TMPFS_MAGIC = 0x01021994;
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
/** The names of the links carry the run too: a stack id with every underscore turned into a hyphen. */
const aliasMarker = `swarmtest-${hex}`;
const runPrefix = `hp_swarmtest_stk_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const OTHER_ORG = `org_swarmtest_${hex}_other`;
/** a, b: applications · v, m, p: the Valkey, MariaDB and PostgreSQL databases · n: an application that is only
 *  prepared (a private network and a volume, no container) · x: the same, of another customer · u, w, y: a MariaDB, a
 *  Valkey and a PostgreSQL that are created on their version 1 and moved to the newest version. */
const [A, B, V, M, P, N, X, UM, UV, UP] = ["a", "b", "v", "m", "p", "n", "x", "u", "w", "y"].map((s) => `stk_swarmtest_${hex}_${s}`);
/** Removal order of the cleanup: the databases first. */
const STACKS = [[UM, ORG], [UV, ORG], [UP, ORG], [M, ORG], [P, ORG], [V, ORG], [A, ORG], [B, ORG], [N, ORG], [X, OTHER_ORG]];
// hex: can never form an hp_ token
const PASSWORDS = { mariadbApp: randomBytes(16).toString("hex"), mariadbAdmin: randomBytes(16).toString("hex"), postgresApp: randomBytes(16).toString("hex") };
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- plans (the seeds, the default allowlist; a variant by one exact replace) ----
function variant(source, pairs) {
  let out = source;
  for (const [from, to] of pairs) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`variant: ${JSON.stringify(from.slice(0, 40))} occurs ${String(count)} times`);
    out = out.replace(from, to);
  }
  return out;
}
/** Never throws: a seed that is missing or cannot be changed answers like a plan that does not compile. `earlier`: the
 *  seed's version 1 (the first of its `previousVersions`) instead of its newest version. */
function compile(slug, stackId, { parameters = [], secretKeys = [], n = 1, edit = [], organizationId = ORG, earlier = false } = {}) {
  try {
    const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug);
    if (seed === undefined) return { ok: false, issues: [`no built-in template ${slug}`] };
    const version = earlier ? seed.previousVersions?.[0] : seed;
    if (version === undefined) return { ok: false, issues: [`no earlier version of ${slug}`] };
    return compileAppStackPlan({
      source: variant(version.source, edit),
      parameters,
      secretVersions: new Map(secretKeys.map((k) => [k, 1])),
      ids: {
        stackId,
        organizationId,
        hostAllocationId: `alloc_swarmtest_${hex}`,
        templateVersionId: version.versionId,
        revisionId: `srev_swarmtest_${hex}_${stackId.at(-1)}${String(n)}`,
      },
    });
  } catch (err) {
    return { ok: false, issues: [String(err?.message ?? err)] };
  }
}
const INTERVAL = [{ key: "worker_interval_seconds", value: 5 }];
const compiled = {
  a: compile("worker-storage", A, { parameters: INTERVAL }),
  b: compile("worker-storage", B, { parameters: INTERVAL }),
  n: compile("worker-storage", N, { parameters: INTERVAL }),
  x: compile("worker-storage", X, { parameters: INTERVAL, organizationId: OTHER_ORG }),
  v: compile("valkey", V),
  // The same database with one option changed: its container is made again.
  v2: compile("valkey", V, { n: 2, edit: [['"256mb"', '"192mb"']] }),
  m: compile("mariadb", M, { secretKeys: ["database_password", "admin_password"] }),
  p: compile("postgresql", P, { secretKeys: ["database_password"] }),
  // The same MariaDB application as it is on version 1, and as it is after the move to the newest version.
  um1: compile("mariadb", UM, { secretKeys: ["database_password", "admin_password"], earlier: true }),
  um2: compile("mariadb", UM, { secretKeys: ["database_password", "admin_password"], n: 2 }),
  // The same Valkey application as it is on version 1, and as it is after the move to the newest version.
  uv1: compile("valkey", UV, { earlier: true }),
  uv2: compile("valkey", UV, { n: 2 }),
  // The same PostgreSQL application as it is on version 1, and as it is after the move to the newest version.
  up1: compile("postgresql", UP, { secretKeys: ["database_password"], earlier: true }),
  up2: compile("postgresql", UP, { secretKeys: ["database_password"], n: 2 }),
};
/** The only images the gate inspects and accepts in a create body. */
const IMAGES = new Set(Object.values(compiled).flatMap((c) => (c.ok ? c.plan.components.map((x) => x.image) : [])));
const PG_IMAGE = compiled.p.ok ? compiled.p.plan.components[0].image : "none";
const cName = appStackContainerName;
const netName = appStackInternalNetworkName;
const DB = (stackId) => cName(stackId, "db");
const namesOf = (plan) => ({
  containers: plan.components.map((c) => cName(plan.stackId, c.key)).sort(),
  networks: [netName(plan.stackId)],
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const NONE = { containers: [], networks: [], volumes: [] };

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);
/** How many 8-character windows of one of the run's passwords the text holds. */
function leaked(text) {
  let n = 0;
  for (const value of Object.values(PASSWORDS)) {
    for (let i = 0; i + 8 <= value.length; i++) if (text.includes(value.slice(i, i + 8))) n++;
  }
  return n;
}
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
/** `env` adds to the environment of the program itself: a password travels there, never in `args`. */
function run(cmd, args, timeout, env = null) {
  return new Promise((resolve, reject) => {
    const options = { timeout, maxBuffer: 16 << 20, env: env === null ? process.env : { ...process.env, ...env } };
    const child = execFile(cmd, args, options, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
    child.stdin?.end();
  });
}
/** The only docker CLI door: no hp_ name of another run, and object verbs only on this run's objects. */
async function docker(args, timeout = 120_000, env = null) {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !ours(t));
  const objectVerb = ["inspect", "exec", "top", "stats", "logs"].includes(args[0]) || (["network", "volume"].includes(args[0]) && args[1] === "inspect");
  if (foreign.length > 0 || (objectVerb && !args.some(ours))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout, env);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const networkOf = async (name) => JSON.parse(await docker(["network", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();
const snapshot = async () => ({
  containers: await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]),
  networks: await lines(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"]),
  volumes: await lines(["volume", "ls", "--format", "{{.Name}}"]),
});
const KINDS = ["containers", "networks", "volumes"];
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
const isOwn = (ref) => ours(ref) || ownIds.has(ref);
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });

/** null = the stack create body keeps every hardening property and names only this run's objects. */
function containerBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (!IMAGES.has(body.Image)) return "image";
  if (h.Privileged === true || h.CapAdd !== undefined) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !(h.SecurityOpt ?? []).includes("no-new-privileges:true") || h.ReadonlyRootfs !== true) return "hardening";
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  const scratch = Object.keys(h.Tmpfs ?? {}).sort();
  if (!same(scratch, ["/tmp"]) && !(body.Image === PG_IMAGE && same(scratch, ["/run/postgresql", "/tmp"]))) return "temporary area";
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${secretsRoot}/`) || !b.endsWith(":ro"))) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  if (Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker))) return "endpoint";
  return null;
}

/** Default deny: "forward" (optionally registering the created id or filtering a list) or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const text = `${p}?${decodeURIComponent(u.search)}\n${bodyText}`;
  const foreign = [...text.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t));
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  if (leaked(text) > 0) return deny("password in request");
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version" || p === "/info")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) ? fwd() : deny("image");
  // No image is ever downloaded, built or removed: the images must be local before the run.
  if (p === "/build" || p.startsWith("/images/")) return deny("image change");
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p });
  if (method === "POST" && p === "/networks/create") {
    // Private networks only: an edge network would be picked up by a live panel's proxy.
    const ok =
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.IPAM === undefined &&
      body.Internal === true &&
      /^hp_appnet_/.test(String(body.Name)) &&
      String(body.Name).includes(marker) &&
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
  if (method === "POST" && (m = p.match(/^\/networks\/([^/]+)\/(connect|disconnect)$/))) {
    // A link: this run's container, this run's private network, and (to attach) nothing but a name of this run.
    const own = /^hp_appnet_/.test(m[1]) && ours(m[1]) && isOwn(String(body.Container ?? ""));
    const aliases = body.EndpointConfig?.Aliases;
    const named = Array.isArray(aliases) && aliases.length > 0 && aliases.every((a) => String(a).includes(aliasMarker));
    return own && (m[2] === "disconnect" || named) ? fwd() : deny("network attach of a foreign object or under a foreign name");
  }
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
        res.end(JSON.stringify({ message: "gate: denied" }));
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
  return new Promise((resolve, reject) => {
    gateServer.once("error", reject);
    gateServer.listen(socketPath, resolve);
  });
}

/** The script's own Engine requests (cleanup, taking a network away under a stopped database) pass the same gate. */
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

// ---- cleanup (memoised: `finally` and the signal handlers share one run) ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      for (const [stackId, organizationId] of STACKS) {
        await adapter.removeAppStack({ stackId, organizationId, removeVolumes: true }).catch((err) => console.log(`INFO cleanup ${stackId}: ${reasonOf(err)}`));
      }
      for (const [kind, list] of [
        ["containers", ["ps", "-a", ...OURS_FILTER, "--format", "{{.Names}}"]],
        ["networks", ["network", "ls", ...OURS_FILTER, "--format", "{{.Name}}"]],
        ["volumes", ["volume", "ls", ...OURS_FILTER, "--format", "{{.Name}}"]],
      ]) {
        for (const name of (await lines(list).catch(() => [])).filter(ours)) {
          const r = await viaGate("DELETE", `/v1.45/${kind}/${encodeURIComponent(name)}${kind === "containers" ? "?force=true&v=true" : ""}`).catch((err) => ({
            status: 0,
            body: String(err.message),
          }));
          if (r.status !== 204 && r.status !== 404) console.log(`INFO cleanup ${name}: ${String(r.status)} ${r.body.slice(0, 120)}`);
        }
      }
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
// A failed promise nobody waited for would end the process at once: the run's objects are removed first.
process.on("unhandledRejection", (err) => {
  console.log(`FAIL unhandled-rejection: ${reasonOf(err)}`);
  void cleanup().finally(() => process.exit(1));
});

async function main() {
  let engineVersion;
  try {
    engineVersion = (await docker(["version", "--format", "{{.Server.Version}}"])).trim();
  } catch (err) {
    console.log(`SKIP accept-app-stack-databases: no Docker Engine (${err.message}); nothing was created`);
    process.exit(1);
  }
  let passed = 0;
  let total = 0;
  let skipped = 0;
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
  const skip = (name, why) => {
    skipped += 1;
    console.log(`SKIP ${name}: ${why}`);
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
  };
  const status = (stackId) => adapter.getAppStackStatus({ stackId, organizationId: ORG });
  const waitHealthy = (stackId, keys, ms = 60_000) =>
    until(`${keys.join(",")} of ${stackId} healthy`, ms, async () => {
      const s = await status(stackId);
      return keys.every((k) => s.components.find((c) => c.componentKey === k)?.health === "healthy") ? s : null;
    });
  const startReq = (plan, componentKey, contents = []) => ({ plan, componentKey, secretFileContents: contents });
  /** The API's first deploy: each image (local: nothing is downloaded), prepare, create, start in plan order with the
   *  dependencies healthy first, then wait until every component is healthy. */
  const deploy = async (plan, contents = [], ms = 60_000) => {
    const pulls = [];
    for (const image of new Set(plan.components.map((c) => c.image))) pulls.push(await adapter.pullAppStackImage({ plan, image }));
    const prepare = await adapter.prepareAppStack({ plan });
    const create = await adapter.createAppStackComponents({ plan });
    const starts = [];
    for (const c of plan.components) {
      if (c.dependsOn.length > 0) await waitHealthy(plan.stackId, c.dependsOn);
      starts.push(await adapter.startAppStackComponent(startReq(plan, c.key, contents)));
    }
    await waitHealthy(plan.stackId, plan.components.map((c) => c.key), ms);
    return { pulls, prepare, create, starts };
  };
  const writesIn = (from) => gateLog.slice(from).filter((l) => /^(POST|DELETE|PUT) /.test(l));
  const attachesIn = (from) => gateLog.slice(from).filter((l) => /\/networks\/[^/ ]+\/connect /.test(l));
  const gone = async (stackId, what) => {
    const left = ownNames(await snapshot(), stackId);
    assert(same(left, NONE), `${what}: no object of ${stackId} is left`, JSON.stringify(left));
  };

  // ---- links ----
  const aliasOf = (stackId) => appStackLinkAlias(stackId);
  /** The executor's one call: the whole list of applications a database is used by. */
  const link = (stackId, consumers, componentKey = "db") =>
    adapter.syncAppStackLinks({ stackId, organizationId: ORG, componentKey, consumerStackIds: consumers });
  const tag = (stackId) => stackId.at(-1);
  const outcomes = (result) => result.links.map((l) => `${tag(l.consumerStackId)}:${l.outcome}`).join(",");
  const netsOf = async (container) => Object.keys((await inspectOf(container)).NetworkSettings.Networks ?? {}).sort();
  /** The running containers on an application's private network, by name. */
  const membersOf = async (stackId) => Object.values((await networkOf(netName(stackId))).Containers ?? {}).map((c) => c.Name).sort();
  const endpointOf = async (container, stackId) => (await inspectOf(container)).NetworkSettings.Networks?.[netName(stackId)] ?? null;
  const namesOn = async (container, stackId) => {
    const e = await endpointOf(container, stackId);
    return [...(e?.Aliases ?? []), ...(e?.DNSNames ?? [])];
  };
  const addressOn = async (container, stackId) => (await endpointOf(container, stackId))?.IPAddress ?? "";
  const runOf = async (container) => {
    const c = await inspectOf(container);
    return `${c.Id} ${String(c.State.Running)} ${c.State.StartedAt}`;
  };
  /** null = `from` opened a TCP connection to host:port; otherwise what stopped it ("bad address" = the name is unknown). */
  const reach = (from, host, port) => docker(["exec", from, "nc", "-w", "2", host, String(port), "-e", "true"], 30_000).then(() => null, (err) => String(err.message));
  const unknownName = (answer) => answer !== null && answer.includes("bad address");

  // ---- clients, run inside the database's own container; the password is in the docker CLI's environment only ----
  const mariadb = (host, sql, value = PASSWORDS.mariadbApp, from = DB(M), timeout = 60_000) =>
    docker(["exec", "-e", "MYSQL_PWD", from, "mariadb", "-h", host, "-P", "3306", "--connect-timeout=5", "-uapp", "-N", "-B", "-e", sql, "app"], timeout, { MYSQL_PWD: value });
  const mariadbAdmin = (where) =>
    docker(["exec", "-e", "MYSQL_PWD", DB(M), "mariadb", ...where, "--connect-timeout=5", "-uroot", "-N", "-B", "-e", "SELECT CURRENT_USER()"], 60_000, {
      MYSQL_PWD: PASSWORDS.mariadbAdmin,
    });
  // Always a host that is not the loopback: the image trusts the loopback without a password.
  const psql = (host, sql, value = PASSWORDS.postgresApp, from = DB(P)) =>
    docker(["exec", "-e", "PGPASSWORD", "-e", "PGCONNECT_TIMEOUT=5", from, "psql", "-h", host, "-U", "app", "-d", "app", "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], 60_000, {
      PGPASSWORD: value,
    });
  const valkey = async (from, host, ...command) => (await docker(["exec", from, "valkey-cli", "-h", host, ...command], 60_000)).trim();
  /** What the store answers to CONFIG GET maxmemory: the number of bytes, as text. */
  const valkeyCeiling = async (from) => (await valkey(from, "db", "CONFIG", "GET", "maxmemory")).split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  const SQL_WRITE_MARIADB = "CREATE TABLE IF NOT EXISTS probe (id INT PRIMARY KEY, note VARCHAR(32)); REPLACE INTO probe VALUES (1, 'kept')";
  const SQL_WRITE_POSTGRES =
    "CREATE TABLE IF NOT EXISTS probe (id int PRIMARY KEY, note text); INSERT INTO probe VALUES (1, 'kept') ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note";
  const SQL_READ = "SELECT note FROM probe WHERE id = 1";
  /** The directory the server keeps its data in: the one the PostgreSQL template writes (PGDATA) and its first version
   *  already used by the default of the image. */
  const PG_DATA_DIRECTORY = "/var/lib/postgresql/18/docker";
  const SQL_DATA_DIRECTORY = "SHOW data_directory";
  // More temporary space than the 64 MB of /tmp in the strict profile. The Sequence engine makes 900000 rows and no table;
  // each is a 128-byte binary key (8 times the 16 bytes of an MD5). COUNT(DISTINCT) keeps the keys in a tree of at most
  // 16 MB (tmp_table_size) and writes the rest to temporary files in the server's tmpdir: about 900000 * 128 B = 115 MB,
  // 1.8 times the area of version 1 and well under 300 MB of disk. It is one thread: on 4 processors it asks for one, and
  // it is sized by that arithmetic, not by a measurement (the INFO line below prints the time of each run).
  const SQL_BIG_DISTINCT = "SELECT COUNT(DISTINCT REPEAT(UNHEX(MD5(seq)), 8)) FROM seq_1_to_900000";
  const NO_SPACE = /No space left|Errcode: 28|error 28|is full/i;
  const mariadbContents = [
    { parameterKey: "database_password", version: 1, content: PASSWORDS.mariadbApp },
    { parameterKey: "admin_password", version: 1, content: PASSWORDS.mariadbAdmin },
  ];
  const postgresContents = [{ parameterKey: "database_password", version: 1, content: PASSWORDS.postgresApp }];

  const bridges = [];
  /** The private network of a stack is a plain internal bridge, and its host interface matches the host's br-* rule. */
  const shape = async (stackId) => {
    const n = await networkOf(netName(stackId));
    assert(
      n.Driver === "bridge" && n.Internal === true && Object.keys(n.Options ?? {}).length === 0 && n.Labels?.[ROLE_LABEL] === "app_internal",
      `${netName(stackId)} is a plain internal bridge with role app_internal`,
      JSON.stringify({ d: n.Driver, i: n.Internal, o: n.Options, l: n.Labels?.[ROLE_LABEL] }),
    );
    const bridge = `br-${n.Id.slice(0, 12)}`;
    assert(await exists(`/sys/class/net/${bridge}`), `host interface ${bridge} exists (matches iifname "br-*")`, "absent");
    bridges.push(bridge);
  };
  /** Every component of the plan carries the designed hardening; `scratch` = its temporary areas, sorted. */
  const hardening = async (plan, scratch = ["/tmp"]) => {
    for (const comp of plan.components) {
      const name = cName(plan.stackId, comp.key);
      const img = JSON.parse(await docker(["image", "inspect", comp.image]))[0];
      const c = await inspectOf(name);
      const h = c.HostConfig;
      const labels = c.Config.Labels ?? {};
      const memory = Number(comp.resources.memoryBytes);
      const mounted = c.Mounts ?? [];
      const volumes = mounted.filter((mt) => mt.Type === "volume").map((mt) => `${mt.Name}:${mt.Destination}:${String(mt.RW)}`).sort();
      const wantVolumes = comp.volumes.map((v) => `${appStackVolumeName(plan.stackId, v.volumeKey)}:${v.containerPath}:${String(!v.readOnly)}`).sort();
      const fileMounts = mounted.filter((mt) => mt.Type !== "volume");
      const wantBinds = comp.secretFiles
        .map((f) => `${path.join(secretsRoot, appStackSecretDirKey(plan.stackId, comp.key), f.parameterKey)}:/run/secrets/${f.parameterKey}:ro`)
        .sort();
      const checks = {
        CapDrop: same(h.CapDrop, ["ALL"]),
        CapAdd: (h.CapAdd ?? []).length === 0,
        SecurityOpt: (h.SecurityOpt ?? []).includes("no-new-privileges:true"),
        ReadonlyRootfs: h.ReadonlyRootfs === true,
        Tmpfs: same(Object.keys(h.Tmpfs ?? {}).sort(), scratch),
        PidsLimit: h.PidsLimit === 256,
        Memory: h.Memory === memory && h.MemorySwap === memory,
        NanoCpus: h.NanoCpus === comp.resources.cpuMilli * 1_000_000,
        LogConfig: h.LogConfig?.Type === "json-file" && h.LogConfig.Config?.["max-size"] !== undefined && h.LogConfig.Config?.["max-file"] !== undefined,
        NoPorts: Object.keys(h.PortBindings ?? {}).length === 0,
        Binds: same([...(h.Binds ?? [])].sort(), wantBinds),
        Volumes: same(volumes, wantVolumes),
        FileMounts:
          fileMounts.length === wantBinds.length && fileMounts.every((mt) => mt.Type === "bind" && mt.RW === false && String(mt.Destination).startsWith("/run/secrets/")),
        Privileged: h.Privileged === false,
        User: c.Config.User === comp.runAsUser,
        Image: c.Config.Image === comp.image && c.Image === img.Id,
        Entrypoint: same(c.Config.Entrypoint ?? null, img.Config.Entrypoint ?? null),
        Labels: labels["io.hostingpanel.managed"] === "true" && labels["io.hostingpanel.role"] === "app_component" && labels["io.hostingpanel.stack_id"] === plan.stackId,
        NoSiteLabels: labels["io.hostingpanel.site_id"] === undefined && labels["io.hostingpanel.service_instance_id"] === undefined,
        OwnNetworkOnly: same(Object.keys(c.NetworkSettings.Networks ?? {}), [netName(plan.stackId)]),
      };
      const bad = Object.keys(checks).filter((k) => !checks[k]);
      assert(bad.length === 0, `${name} carries the designed hardening`, `${bad.join(",")} ${JSON.stringify({ volumes, binds: h.Binds ?? [], tmpfs: Object.keys(h.Tmpfs ?? {}) })}`);
      const uids = (await docker(["top", name, "-o", "pid,uid"]))
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[1])
        .filter(Boolean);
      assert(uids.length > 0 && !uids.includes("0"), `${name} runs no process as root`, uids.join(","));
      assert(leaked(JSON.stringify(c)) === 0, `${name}: the inspect JSON holds no part of a password`, "leaked");
    }
  };
  /** The passwords of a database exist only as read-only files on a tmpfs, named by the environment. */
  const passwordFiles = async (plan, contents) => {
    const [comp] = plan.components;
    const c = await inspectOf(DB(plan.stackId));
    for (const f of comp.secretFiles) {
      const line = `${f.envName}=/run/secrets/${f.parameterKey}`;
      assert((c.Config.Env ?? []).includes(line), `the environment names the file: ${line}`, (c.Config.Env ?? []).filter((e) => e.includes("_FILE")).join(","));
      const want = contents.find((x) => x.parameterKey === f.parameterKey)?.content;
      const got = (await docker(["exec", DB(plan.stackId), "cat", `/run/secrets/${f.parameterKey}`])).trim();
      assert(got === want, `the component reads ${f.parameterKey} from its file`, got === "" ? "empty" : "another value");
    }
    assert((await statfs(secretsRoot)).type === TMPFS_MAGIC, "the directory of the password files is on a tmpfs", secretsRoot);
  };
  let S0 = null;
  let plans = null;
  /** The plan the Valkey container on the server was created from. */
  let planV = null;

  try {
    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    const gateOk = await step("gate-self-test", async () => {
      // Real names of this machine, used only as judge() inputs: no request about them is ever sent.
      const foreignName = (await lines(["ps", "-a", "--format", "{{.Names}}"])).find((n) => n.startsWith("hp_")) ?? `hp_selftest_${hex}`;
      const foreignId = (await lines(["ps", "-aq", "--no-trunc"]))[0] ?? "f".repeat(64);
      const foreignNet = (await lines(["network", "ls", "--format", "{{.Name}}"])).find((n) => n.startsWith("hp_")) ?? "bridge";
      const foreignVol = (await lines(["volume", "ls", "--format", "{{.Name}}"]))[0] ?? `selftest_${hex}`;
      const ownNet = netName(A);
      const storage = cName(A, "storage");
      const database = DB(V);
      const dataVolume = appStackVolumeName(V, "data");
      const [someImage] = [...IMAGES].filter((i) => i !== PG_IMAGE);
      const hardened = {
        Image: someImage,
        HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, Tmpfs: { "/tmp": "" }, NetworkMode: ownNet },
      };
      const createWith = (hostConfig, extra = {}) => JSON.stringify({ ...hardened, ...extra, HostConfig: { ...hardened.HostConfig, ...hostConfig } });
      const net = (name, role, extra = {}) => JSON.stringify({ Name: name, Driver: "bridge", Internal: true, Labels: { [ROLE_LABEL]: role }, ...extra });
      const attach = (container, aliases) => JSON.stringify({ Container: container, EndpointConfig: aliases === null ? {} : { Aliases: aliases } });
      const [repo] = someImage.split("@");
      // What the product sends: each must pass, so that every case below is denied for the one thing it changes.
      const allowedCases = [
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${DB(P)}`, createWith({ Tmpfs: { "/tmp": "", "/run/postgresql": "" } }, { Image: PG_IMAGE })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal")],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(database, [aliasOf(V)])],
        ["POST", `/v1.45/networks/${ownNet}/disconnect`, JSON.stringify({ Container: database, Force: true })],
        ["GET", `/v1.45/images/${someImage}/json`, ""],
      ];
      const refused = allowedCases.filter(([method, url, body]) => judge(method, url, body).kind !== "forward");
      assert(refused.length === 0, "judge() forwards what the product sends", refused.map(([method, url]) => `${method} ${url}`).join(" | "));
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
        ["DELETE", `/v1.45/volumes/${dataVolume}?force=true`, ""],
        // links: a foreign container, a foreign network, no name, a name of another run, a network that is not private
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(foreignName, [aliasOf(V)])],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(foreignId, [aliasOf(V)])],
        ["POST", `/v1.45/networks/${foreignNet}/connect`, attach(database, [aliasOf(V)])],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(database, null)],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(database, [])],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(database, [aliasOf(V), "db"])],
        ["POST", `/v1.45/networks/${ownNet}/connect`, attach(database, ["stk-swarmtest-000000000000-v"])],
        ["POST", `/v1.45/networks/${runPrefix}_ingress/connect`, attach(database, [aliasOf(V)])],
        ["POST", `/v1.45/networks/${ownNet}/disconnect`, JSON.stringify({ Container: foreignId, Force: true })],
        ["POST", `/v1.45/networks/${foreignNet}/disconnect`, JSON.stringify({ Container: database, Force: true })],
        // images: nothing is downloaded, not even an image of the allowlist
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=9.2.0-alpine3.24`, ""],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(someImage.split("@")[1])}`, ""],
        ["POST", "/v1.45/images/create?fromImage=traefik&tag=v3.7", ""],
        ["DELETE", `/v1.45/images/${someImage}`, ""],
        ["GET", "/v1.45/images/alpine:3/json", ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", "/v1.45/volumes/prune", ""],
        ["GET", "/v1.45/system/df", ""],
        ["POST", "/v1.45/build", ""],
        ["POST", `/v1.45/containers/${storage}/exec`, JSON.stringify({ Cmd: ["true"] })],
        ["PUT", `/v1.45/containers/${storage}/archive?path=/tmp`, ""],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ CapAdd: ["NET_ADMIN"] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ ReadonlyRootfs: false })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ PortBindings: { "6379/tcp": [{ HostPort: "6379" }] } })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Tmpfs: { "/tmp": "", "/var/run": "" } })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Tmpfs: { "/tmp": "", "/run/postgresql": "" } })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Tmpfs: {} })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({}, { Image: `${repo}@sha256:${"e".repeat(64)}` })],
        ...Object.values(PASSWORDS).map((value) => ["POST", `/v1.45/containers/create?name=${storage}`, createWith({}, { Env: [`K=${value}`] })]),
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Options: { "com.docker.network.bridge.name": "x" } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Internal: false })],
        ["POST", "/v1.45/networks/create", net(`hp_appedge_${A}`, "app_edge", { Internal: false })],
        ["POST", "/v1.45/networks/create", net(`hp_appedge_${A}`, "app_edge")],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_edge")],
        ["POST", "/v1.45/networks/create", net(ownNet, "site_internal")],
        ["POST", "/v1.45/networks/create", net(`${runPrefix}_ingress`, "ingress_public")],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: dataVolume, Driver: "local", DriverOpts: { type: "none" } })],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url]) => `${method} ${url}`).join(" | "));
      const wider = [["POST", "/v1.45/info"], ["GET", "/v1.45/info/x"]].filter(([method, url]) => judge(method, url, "").kind !== "deny");
      assert(wider.length === 0, "judge() allows GET /info and nothing wider", wider.map(([method, url]) => `${method} ${url}`).join(" | "));
      // Through the socket: read-only requests only, harmless even if the gate let them through.
      const denied = await viaGate("GET", `/v1.45/containers/hp_selftest_${hex}/json`);
      assert(denied.status === 403 && gateDenied.length === 1, "the socket answers 403 for a foreign name and records the denial", `${denied.status} ${gateDenied.length}`);
      const ping = await viaGate("GET", "/_ping");
      assert(ping.status === 200 && ping.body === "OK", "the socket forwards an allowed request to the Engine", `${ping.status} ${ping.body}`);
      gateDenied.length = 0; // the expected self-test denial; from here on any denial fails gate-clean
    });
    if (!gateOk) {
      adapter = null; // nothing was created: cleanup sends nothing through a gate that failed its self-test
      return;
    }

    const ready = await step("preflight", async () => {
      assert(engineVersion.length > 0, "the Docker Engine answers", engineVersion);
      const stale = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter(ours);
      assert(stale.length === 0, "no object name contains the run marker", stale.join(","));
      assert(IMAGES.size > 0, "the seeds name their images", "none (see plans-compile-from-seeds)");
      // Nothing is downloaded here: an image that is not local stops the run before anything is created.
      const absent = [];
      for (const image of IMAGES) {
        if ((await docker(["image", "inspect", "--format", "{{.Id}}", image]).catch(() => "")).trim() === "") absent.push(image);
      }
      assert(absent.length === 0, "every image of the seeds is local (fetch each first: docker pull <ref>)", absent.join(", "));
      info(`engine ${engineVersion}, marker ${marker}, ${String(IMAGES.size)} image(s): ${[...IMAGES].map((i) => i.split("@")[0]).join(", ")}`);
    });

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    const plansOk = await step("plans-compile-from-seeds", async () => {
      const failed = Object.entries(compiled).filter(([, c]) => !c.ok);
      assert(failed.length === 0, "every seed compiles", failed.map(([k, c]) => `${k}: ${JSON.stringify(c.issues)}`).join(" | "));
      plans = Object.fromEntries(Object.entries(compiled).map(([k, c]) => [k, ApprovedStackPlanSchema.parse(c.plan)]));
      for (const [key, port, user, files] of [
        ["v", 6379, "999:1000", []],
        ["m", 3306, "999:999", ["MARIADB_PASSWORD_FILE:database_password", "MARIADB_ROOT_PASSWORD_FILE:admin_password"]],
        ["p", 5432, "999:999", ["POSTGRES_PASSWORD_FILE:database_password"]],
      ]) {
        const plan = plans[key];
        const [db] = plan.components;
        assert(plan.components.length === 1 && db.key === "db" && same(db.expose, [port]), `${key}: one component db that exposes ${String(port)}`, JSON.stringify(plan.components.map((c) => [c.key, c.expose])));
        assert(db.runAsUser === user, `${key}: runs as ${user}`, String(db.runAsUser));
        assert(same(db.secretFiles.map((f) => `${f.envName}:${f.parameterKey}`).sort(), [...files].sort()), `${key}: its passwords are files`, JSON.stringify(db.secretFiles));
        assert(plan.ingress.length === 0 && same(plan.volumes, [{ key: "data" }]), `${key}: no address, one volume`, JSON.stringify({ i: plan.ingress, v: plan.volumes }));
        assert(db.environment.every((e) => !/PASSWORD/.test(e.name)), `${key}: no password in the environment`, JSON.stringify(db.environment.map((e) => e.name)));
      }
      assert(leaked(JSON.stringify(plans)) === 0, "no plan holds a part of a password", "leaked");
      assert(plans.v2.planHash !== plans.v.planHash && plans.v2.components[0].argv.includes("192mb"), "the second Valkey plan differs by one option", plans.v2.components[0].argv.join(" "));
      const [oldM, newM] = [plans.um1.components[0], plans.um2.components[0]];
      assert(
        plans.um1.templateVersionId === "atv_mariadb_1" && plans.um2.templateVersionId === "atv_mariadb_2" && plans.m.templateVersionId === "atv_mariadb_2",
        "the MariaDB plans are of version 1 and of version 2 (newest)",
        [plans.um1, plans.um2, plans.m].map((x) => x.templateVersionId).join(","),
      );
      assert(
        same(oldM.argv, ["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid"]) && same(newM.argv, [...oldM.argv, "--tmpdir=/var/lib/mysql"]),
        "MariaDB version 2 adds the temporary directory on the data area to the command of version 1",
        JSON.stringify([oldM.argv, newM.argv]),
      );
      assert(
        plans.um1.planHash !== plans.um2.planHash && same(oldM.image, newM.image) && same(plans.um1.volumes, plans.um2.volumes) && same(oldM.volumes, newM.volumes),
        "the two versions differ by the command only: same image, same volume and mount",
        JSON.stringify({ i: [oldM.image, newM.image], v: [oldM.volumes, newM.volumes] }),
      );
      const [oldV, newV] = [plans.uv1.components[0], plans.uv2.components[0]];
      assert(
        plans.uv1.templateVersionId === "atv_valkey_1" && plans.uv2.templateVersionId === "atv_valkey_2" && plans.v.templateVersionId === "atv_valkey_2",
        "the Valkey plans are of version 1 and of version 2 (newest)",
        [plans.uv1, plans.uv2, plans.v].map((x) => x.templateVersionId).join(","),
      );
      assert(
        oldV.resources.memoryBytes === "402653184" && newV.resources.memoryBytes === "536870912" && oldV.resources.cpuMilli === 500 && newV.resources.cpuMilli === 500,
        "Valkey version 2 raises the memory limit from 384 to 512 MiB and keeps half a processor",
        JSON.stringify([oldV.resources, newV.resources]),
      );
      assert(
        same(oldV.argv, newV.argv) && oldV.argv.includes("256mb") && plans.uv1.planHash !== plans.uv2.planHash && same(oldV.image, newV.image) && same(oldV.volumes, newV.volumes) && same(plans.uv1.volumes, plans.uv2.volumes),
        "the two versions differ by the memory limit only: same ceiling, same command, image and volume",
        JSON.stringify({ a: [oldV.argv, newV.argv], i: [oldV.image, newV.image], v: [oldV.volumes, newV.volumes] }),
      );
      const [oldP, newP] = [plans.up1.components[0], plans.up2.components[0]];
      assert(
        plans.up1.templateVersionId === "atv_postgresql_1" && plans.up2.templateVersionId === "atv_postgresql_2" && plans.p.templateVersionId === "atv_postgresql_2",
        "the PostgreSQL plans are of version 1 and of version 2 (newest)",
        [plans.up1, plans.up2, plans.p].map((x) => x.templateVersionId).join(","),
      );
      assert(
        !oldP.environment.some((e) => e.name === "PGDATA") && same(newP.environment.filter((e) => e.name === "PGDATA"), [{ name: "PGDATA", value: PG_DATA_DIRECTORY }]),
        "PostgreSQL version 2 writes the data directory in its environment; version 1 left it to the image",
        JSON.stringify([oldP.environment, newP.environment]),
      );
      assert(
        same(newP.environment.filter((e) => e.name !== "PGDATA"), oldP.environment) && same(oldP.argv, newP.argv) && same(oldP.image, newP.image) && same(oldP.volumes, newP.volumes) && same(plans.up1.volumes, plans.up2.volumes) && plans.up1.planHash !== plans.up2.planHash,
        "the two versions differ by that entry only: same image, command, password file, mount and volume",
        JSON.stringify({ e: [oldP.environment, newP.environment], i: [oldP.image, newP.image], v: [oldP.volumes, newP.volumes] }),
      );
      assert(same(newP.volumes, [{ volumeKey: "data", containerPath: "/var/lib/postgresql", readOnly: false }]), "and the volume is still mounted at /var/lib/postgresql", JSON.stringify(newP.volumes));
      assert(plans.x.organizationId === OTHER_ORG, "the foreign application belongs to another customer", plans.x.organizationId);
      for (const stackId of [V, M, P]) {
        assert(aliasOf(stackId) === stackId.replaceAll("_", "-") && aliasOf(stackId).includes(aliasMarker), `the name of ${stackId} for its links`, String(aliasOf(stackId)));
      }
      planV = plans.v;
    });
    if (!ready || !plansOk) return;

    const appsOk = await step("applications-deploy", async () => {
      const mark = gateLog.length;
      for (const plan of [plans.a, plans.b]) {
        const out = await deploy(plan);
        assert(out.pulls.every((p) => p.pulled === false), "nothing downloaded", JSON.stringify(out.pulls));
        assert(same(out.prepare.networks, [{ role: "app_internal", created: true }]), "one private network, no edge network", JSON.stringify(out.prepare.networks));
        assert(same(ownNames(await snapshot(), plan.stackId), namesOf(plan)), `exactly the objects of ${plan.stackId}`, JSON.stringify(ownNames(await snapshot(), plan.stackId)));
        await hardening(plan);
      }
      assert(gateLog.slice(mark).every((l) => !l.includes("/images/create")), "no image request beyond an inspect", "an image create");
      await shape(A);
      assert(removedSince(S0, await snapshot()).length === 0, "no pre-existing object removed", "some");
    });
    if (!appsOk) return;

    const mariadbOk = await step("mariadb-starts-hardened", async () => {
      const out = await deploy(plans.m, mariadbContents, 180_000);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      assert(leaked(JSON.stringify(out)) === 0, "the executor's answers hold no part of a password", "leaked");
      await hardening(plans.m);
      await passwordFiles(plans.m, mariadbContents);
      assert((await mariadb("db", "SELECT CURRENT_USER()")).trim().startsWith("app@"), "the user app signs in over the network with its password", "another user");
      const wrong = await rejection(mariadb("db", "SELECT 1", "0".repeat(32)));
      assert(wrong !== null && /denied/i.test(wrong.message), "a wrong password is refused", wrong ? wrong.message.slice(0, 160) : "accepted");
      const adminNet = await rejection(mariadbAdmin(["-h", "db", "-P", "3306"]));
      assert(adminNet !== null && /denied|not allowed/i.test(adminNet.message), "the administrator cannot sign in over the network", adminNet ? adminNet.message.slice(0, 160) : "accepted");
      assert((await mariadbAdmin(["--socket=/tmp/mysqld.sock"])).trim() === "root@localhost", "the administrator signs in on the local socket with its own password", "another user");
      await mariadb("db", SQL_WRITE_MARIADB);
      assert((await mariadb("db", SQL_READ)).trim() === "kept", "a row is written and read back", "another value");
      // Version 2 on an empty volume: it starts and keeps its temporary files on the data area.
      assert((await inspectOf(DB(M))).Config.Cmd.includes("--tmpdir=/var/lib/mysql"), "the newest version runs with its temporary directory", "no --tmpdir");
      assert((await mariadb("db", "SELECT @@tmpdir")).trim() === "/var/lib/mysql", "its temporary files are on the data area", "another directory");
    });

    const postgresOk = await step("postgresql-starts-hardened", async () => {
      const out = await deploy(plans.p, postgresContents, 180_000);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      assert(leaked(JSON.stringify(out)) === 0, "the executor's answers hold no part of a password", "leaked");
      await hardening(plans.p, ["/run/postgresql", "/tmp"]);
      await passwordFiles(plans.p, postgresContents);
      assert((await psql("db", "SELECT current_user")).trim() === "app", "the user app signs in over the network with its password", "another user");
      const wrong = await rejection(psql("db", "SELECT 1", "0".repeat(32)));
      assert(wrong !== null && /password authentication failed/i.test(wrong.message), "a wrong password is refused", wrong ? wrong.message.slice(0, 160) : "accepted");
      await psql("db", SQL_WRITE_POSTGRES);
      assert((await psql("db", SQL_READ)).trim() === "kept", "a row is written and read back", "another value");
      // Version 2 on an empty volume: the server keeps its data in the directory the template names.
      assert((await psql("db", SQL_DATA_DIRECTORY)).trim() === PG_DATA_DIRECTORY, `the data directory is ${PG_DATA_DIRECTORY}`, (await psql("db", SQL_DATA_DIRECTORY)).trim());
    });

    const valkeyOk = await step("valkey-starts-hardened", async () => {
      const out = await deploy(plans.v);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      await hardening(plans.v);
      assert((await valkey(DB(V), "db", "SET", "probe", "kept")) === "OK", "a key is written", "no OK");
      assert((await valkey(DB(V), "db", "GET", "probe")) === "kept", "and read back", "another value");
      // Version 2 on an empty volume: the limit is 512 MiB and the store holds up to 256 MB.
      const limits = (await inspectOf(DB(V))).HostConfig;
      assert(limits.Memory === 536870912 && limits.MemorySwap === 536870912, "the container may use 512 MiB of memory, swap included", `${String(limits.Memory)} ${String(limits.MemorySwap)}`);
      assert(await valkeyCeiling(DB(V)) === "268435456", "and the store answers a ceiling of 256 MB (268435456 bytes)", await valkeyCeiling(DB(V)));
      for (const stackId of [M, P, V]) await shape(stackId);
    });
    if (!mariadbOk || !postgresOk || !valkeyOk) return;

    await step("data-survives-restart", async () => {
      for (const [plan, contents] of [[plans.m, mariadbContents], [plans.p, postgresContents], [plans.v, []]]) {
        const before = await runOf(DB(plan.stackId));
        const out = await adapter.restartAppStackComponent(startReq(plan, "db", contents));
        assert(out.outcome === "restarted", `${plan.stackId}: restarted`, JSON.stringify(out));
        await waitHealthy(plan.stackId, ["db"], 120_000);
        const after = await runOf(DB(plan.stackId));
        assert(after.split(" ")[0] === before.split(" ")[0] && after !== before, `${plan.stackId}: the same container, started again`, `${before} -> ${after}`);
      }
      assert((await mariadb("db", SQL_READ)).trim() === "kept", "MariaDB still has its row", "another value");
      assert((await psql("db", SQL_READ)).trim() === "kept", "PostgreSQL still has its row", "another value");
      assert((await valkey(DB(V), "db", "GET", "probe")) === "kept", "Valkey still has its key", "another value");
    });

    // ADR-0039: an application created on version 1 of a database and moved to the newest version, the way the API does
    // it: the container is made again on the same volume (a new version replaces it) and started with its password files.
    const upgradeInPlace = async (newest, contents) => {
      const stackId = newest.stackId;
      const oldId = (await inspectOf(DB(stackId))).Id;
      const made = await adapter.createAppStackComponents({ plan: newest });
      assert(same(made.components, [{ componentKey: "db", outcome: "replaced" }]), "the new version replaces the container", JSON.stringify(made));
      const fresh = await inspectOf(DB(stackId));
      assert(fresh.Id !== oldId && fresh.State.Running === false, "a new container, not started", `${String(fresh.Id !== oldId)} ${String(fresh.State.Running)}`);
      assert(same((fresh.Mounts ?? []).map((mt) => mt.Name), [appStackVolumeName(stackId, "data")]), "on the same volume", JSON.stringify((fresh.Mounts ?? []).map((mt) => mt.Name)));
      const started = await adapter.startAppStackComponent(startReq(newest, "db", contents));
      assert(started.outcome === "started", "the new container starts on the data of version 1", JSON.stringify(started));
      await waitHealthy(stackId, ["db"], 180_000);
      assert(same((await inspectOf(DB(stackId))).Config.Cmd, newest.components[0].argv), "it runs the command of the newest version", JSON.stringify((await inspectOf(DB(stackId))).Config.Cmd));
    };
    /** Removal with the data, and the proof that nothing of the application is left. */
    const dropWithData = async (plan, what) => {
      const dir = path.join(secretsRoot, appStackSecretDirKey(plan.stackId, "db"));
      const out = await adapter.removeAppStack({ stackId: plan.stackId, organizationId: ORG, removeVolumes: true });
      assert(same(out.removedComponents, ["db"]) && same(out.removedVolumes, ["data"]), `${what}: removed with its data`, JSON.stringify(out));
      await gone(plan.stackId, what);
      assert(!(await exists(dir)), `${what}: the password files are gone with it`, dir);
    };

    await step("mariadb-earlier-version-upgrades", async () => {
      const [earlier, newest] = [plans.um1, plans.um2];
      const out = await deploy(earlier, mariadbContents, 180_000);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      await hardening(earlier);
      await passwordFiles(earlier, mariadbContents);
      const view = (sql) => mariadb("db", sql, PASSWORDS.mariadbApp, DB(UM));
      await view(SQL_WRITE_MARIADB);
      assert((await view(SQL_READ)).trim() === "kept", "version 1 holds a row", "another value");
      assert(!(await inspectOf(DB(UM))).Config.Cmd.includes("--tmpdir=/var/lib/mysql"), "version 1 has no temporary directory of its own", "it has one");
      assert((await view("SELECT @@tmpdir")).trim() !== "/var/lib/mysql", "version 1 keeps its temporary files outside the data area", "on the data area");
      // The defect: the temporary files of a statement go to /tmp, a 64 MB area, and a larger one stops.
      const t1 = performance.now();
      const refused = await rejection(mariadb("db", SQL_BIG_DISTINCT, PASSWORDS.mariadbApp, DB(UM), 110_000));
      assert(refused !== null && NO_SPACE.test(refused.message), "version 1 stops a statement that needs more than its temporary area", refused ? refused.message.slice(0, 200) : "it ran");
      info(`MariaDB version 1: the statement stopped after ${((performance.now() - t1) / 1000).toFixed(1)}s: ${refused.message.split("\n").at(-1).slice(0, 120)}`);
      assert((await view(SQL_READ)).trim() === "kept", "and the server still answers", "another value");
      await upgradeInPlace(newest, mariadbContents);
      await hardening(newest);
      await passwordFiles(newest, mariadbContents);
      assert((await view(SQL_READ)).trim() === "kept", "the row written on version 1 is still there", "another value");
      assert((await view("SELECT @@tmpdir")).trim() === "/var/lib/mysql", "its temporary files are on the data area", "another directory");
      const t2 = performance.now();
      const counted = (await view(SQL_BIG_DISTINCT).catch((err) => `failed: ${err.message.slice(0, 160)}`)).trim();
      const seconds = (performance.now() - t2) / 1000;
      info(`MariaDB version 2: the same statement took ${seconds.toFixed(1)}s, answer ${counted}`);
      assert(counted === "900000", "version 2 runs the same statement to its end", counted);
      assert(seconds < 120, "in under 2 minutes", `${seconds.toFixed(1)}s`);
      assert((await view(SQL_READ)).trim() === "kept", "and the row is still there", "another value");
      await dropWithData(newest, "MariaDB upgraded from version 1");
    });

    await step("valkey-earlier-version-upgrades", async () => {
      const [earlier, newest] = [plans.uv1, plans.uv2];
      const out = await deploy(earlier);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      await hardening(earlier);
      const view = (...command) => valkey(DB(UV), "db", ...command);
      const limitOf = async () => (await inspectOf(DB(UV))).HostConfig;
      assert((await view("SET", "probe", "kept")) === "OK", "version 1 holds a key", "no OK");
      assert((await view("GET", "probe")) === "kept", "and reads it back", "another value");
      assert((await limitOf()).Memory === 402653184, "version 1 may use 384 MiB of memory", String((await limitOf()).Memory));
      assert((await valkeyCeiling(DB(UV))) === "268435456", "and its ceiling is already 256 MB", await valkeyCeiling(DB(UV)));
      await upgradeInPlace(newest, []);
      await hardening(newest);
      const limits = await limitOf();
      assert(limits.Memory === 536870912 && limits.MemorySwap === 536870912, "version 2 may use 512 MiB of memory, swap included", `${String(limits.Memory)} ${String(limits.MemorySwap)}`);
      assert((await view("GET", "probe")) === "kept", "the key written on version 1 is still there", "another value");
      assert((await valkeyCeiling(DB(UV))) === "268435456", "the store answers a ceiling of 256 MB (268435456 bytes), as before", await valkeyCeiling(DB(UV)));
      assert((await view("SET", "probe2", "more")) === "OK" && (await view("GET", "probe2")) === "more", "and takes a new key", "refused");
      await dropWithData(newest, "Valkey upgraded from version 1");
    });

    await step("postgresql-earlier-version-upgrades", async () => {
      const [earlier, newest] = [plans.up1, plans.up2];
      const out = await deploy(earlier, postgresContents, 180_000);
      assert(out.pulls.every((p) => p.pulled === false) && same(out.prepare.networks, [{ role: "app_internal", created: true }]), "local image, private network only", JSON.stringify(out));
      await hardening(earlier, ["/run/postgresql", "/tmp"]);
      await passwordFiles(earlier, postgresContents);
      const view = (sql) => psql("db", sql, PASSWORDS.postgresApp, DB(UP));
      await view(SQL_WRITE_POSTGRES);
      assert((await view(SQL_READ)).trim() === "kept", "version 1 holds a row", "another value");
      // The premise of version 2: the directory the image uses by default is the one it will name.
      assert((await view(SQL_DATA_DIRECTORY)).trim() === PG_DATA_DIRECTORY, `version 1 keeps its data in ${PG_DATA_DIRECTORY}, by the default of the image`, (await view(SQL_DATA_DIRECTORY)).trim());
      await upgradeInPlace(newest, postgresContents);
      await hardening(newest, ["/run/postgresql", "/tmp"]);
      await passwordFiles(newest, postgresContents);
      assert((await view(SQL_READ)).trim() === "kept", "the row written on version 1 is still there", "another value");
      assert((await view(SQL_DATA_DIRECTORY)).trim() === PG_DATA_DIRECTORY, "version 2 keeps its data in the same directory", (await view(SQL_DATA_DIRECTORY)).trim());
      assert((await view("SELECT count(*) FROM probe")).trim() === "1", "and it did not start an empty database beside the data", (await view("SELECT count(*) FROM probe")).trim());
      await dropWithData(newest, "PostgreSQL upgraded from version 1");
    });

    const worker = cName(A, "worker");
    const ports = [[V, 6379], [M, 3306], [P, 5432]];
    await step("unlinked-application-cannot-reach", async () => {
      for (const [stackId, port] of ports) {
        assert(unknownName(await reach(worker, aliasOf(stackId), port)), `the application cannot resolve the name of ${stackId}`, "resolved or reached");
        const address = await addressOn(DB(stackId), stackId);
        assert(address !== "", `${stackId} has an address on its own network`, "none");
        assert((await reach(worker, address, port)) !== null, `the application cannot reach ${stackId} at its own address`, "reached");
        assert(same(await netsOf(DB(stackId)), [netName(stackId)]), `${stackId} is on its own network only`, (await netsOf(DB(stackId))).join(","));
      }
      assert((await reach(worker, "storage", 6379)) === null, "control: the application reaches its own component", "not reached");
      assert(unknownName(await reach(worker, "db", 6379)), "the application knows no component called db", "resolved or reached");
    });

    const linkedOk = await step("link-reaches-by-alias", async () => {
      const mark = gateLog.length;
      for (const [stackId, port] of ports) {
        const before = await runOf(DB(stackId));
        const result = await link(stackId, [A]);
        assert(result.container === true && outcomes(result) === "a:connected" && result.disconnected.length === 0, `${stackId}: attached to the application`, JSON.stringify(result));
        assert(!/[0-9a-f]{64}/.test(JSON.stringify(result)) && !JSON.stringify(result).includes("hp_"), `${stackId}: the answer names no Docker object`, JSON.stringify(result));
        assert((await runOf(DB(stackId))) === before, `${stackId}: neither restarted nor made again`, `${before} -> ${await runOf(DB(stackId))}`);
        assert(same(await netsOf(DB(stackId)), [netName(A), netName(stackId)].sort()), `${stackId}: on its own network and the application's, nothing else`, (await netsOf(DB(stackId))).join(","));
        const names = await namesOn(DB(stackId), A);
        assert(names.includes(aliasOf(stackId)) && !names.includes("db"), `${stackId}: known to the application under its own name only`, names.join(","));
        assert((await namesOn(DB(stackId), stackId)).includes("db"), `${stackId}: still db on its own network`, (await namesOn(DB(stackId), stackId)).join(","));
        assert((await reach(worker, aliasOf(stackId), port)) === null, `the application reaches ${stackId} by its name`, String(await reach(worker, aliasOf(stackId), port)));
        assert((await reach(worker, await addressOn(DB(stackId), stackId), port)) !== null, `${stackId}: its address on its own network stays out of reach`, "reached");
      }
      assert(same(attachesIn(mark).length, 3), "three attach requests, one for each database", attachesIn(mark).join(" | "));
      assert((await valkey(worker, aliasOf(V), "PING")) === "PONG", "the application talks to Valkey by its name", "no PONG");
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "and reads the key written before the link", "another value");
      assert((await mariadb(aliasOf(M), SQL_READ)).trim() === "kept", "MariaDB takes the user and the password at the name of the link", "another value");
      const wrongM = await rejection(mariadb(aliasOf(M), "SELECT 1", "0".repeat(32)));
      assert(wrongM !== null && /denied/i.test(wrongM.message), "MariaDB refuses a wrong password at that name", wrongM ? wrongM.message.slice(0, 160) : "accepted");
      assert((await psql(aliasOf(P), SQL_READ)).trim() === "kept", "PostgreSQL takes the user and the password at the name of the link", "another value");
      const wrongP = await rejection(psql(aliasOf(P), "SELECT 1", "0".repeat(32)));
      assert(wrongP !== null && /password authentication failed/i.test(wrongP.message), "PostgreSQL refuses a wrong password at that name", wrongP ? wrongP.message.slice(0, 160) : "accepted");
      assert(unknownName(await reach(worker, "db", 6379)), "the application still knows no component called db", "resolved or reached");
      const members = await membersOf(A);
      assert(same(members, [...namesOf(plans.a).containers, DB(V), DB(M), DB(P)].sort()), "the application's network holds its components and the three databases", members.join(","));
    });
    if (!linkedOk) return;

    await step("link-idempotent", async () => {
      const mark = gateLog.length;
      for (const [stackId] of ports) {
        const result = await link(stackId, [A]);
        assert(result.container === true && outcomes(result) === "a:already_connected" && result.disconnected.length === 0, `${stackId}: already attached`, JSON.stringify(result));
      }
      assert(writesIn(mark).length === 0, "the second pass changes nothing on the server", writesIn(mark).join(" | "));
    });

    const workerB = cName(B, "worker");
    await step("two-applications-stay-apart", async () => {
      const before = await runOf(DB(V));
      const result = await link(V, [A, B]);
      assert(outcomes(result) === "a:already_connected,b:connected" && result.disconnected.length === 0, "the second application is attached, the first is left alone", JSON.stringify(result));
      assert((await runOf(DB(V))) === before, "the database is neither restarted nor made again", "changed");
      assert((await valkey(workerB, aliasOf(V), "GET", "probe")) === "kept", "the second application reads the same database", "another value");
      for (const plan of [plans.a, plans.b]) {
        for (const name of namesOf(plan).containers) assert(same(await netsOf(name), [netName(plan.stackId)]), `${name} is on its own network only`, (await netsOf(name)).join(","));
      }
      const storageA = await addressOn(cName(A, "storage"), A);
      const storageB = await addressOn(cName(B, "storage"), B);
      assert(storageA !== "" && storageB !== "", "both applications have a storage address", `${storageA} ${storageB}`);
      assert((await reach(workerB, storageA, 6379)) !== null, "the second application cannot reach the first one's component", "reached");
      assert((await reach(worker, storageB, 6379)) !== null, "the first application cannot reach the second one's component", "reached");
      for (const stackId of [M, P]) assert(unknownName(await reach(workerB, aliasOf(stackId), 3306)), `the second application cannot resolve ${stackId}`, "resolved or reached");
      assert(same(await membersOf(B), [...namesOf(plans.b).containers, DB(V)].sort()), "the second application's network holds its components and that database", (await membersOf(B)).join(","));
    });

    await step("link-follows-a-replaced-database", async () => {
      const restarted = await adapter.restartAppStackComponent(startReq(planV, "db"));
      assert(restarted.outcome === "restarted", "the database is restarted", JSON.stringify(restarted));
      await waitHealthy(V, ["db"], 120_000);
      assert(same(await netsOf(DB(V)), [netName(A), netName(B), netName(V)].sort()), "a restart keeps both attachments", (await netsOf(DB(V))).join(","));
      assert((await valkey(worker, aliasOf(V), "PING")) === "PONG", "and the application still reaches it", "no PONG");
      // A new version of the database: its container is made again, on its own network only, and is not started yet.
      const oldId = (await inspectOf(DB(V))).Id;
      const made = await adapter.createAppStackComponents({ plan: plans.v2 });
      assert(same(made.components, [{ componentKey: "db", outcome: "replaced" }]), "the new version replaces the container", JSON.stringify(made));
      planV = plans.v2;
      const fresh = await inspectOf(DB(V));
      assert(fresh.Id !== oldId && fresh.State.Running === false, "a new container, not started", `${String(fresh.Id !== oldId)} ${String(fresh.State.Running)}`);
      assert(same(await netsOf(DB(V)), [netName(V)]), "the new container is on its own network only", (await netsOf(DB(V))).join(","));
      // What the API does before the start of a rollout: the same call, with the same list.
      const result = await link(V, [A, B]);
      assert(result.container === true && outcomes(result) === "a:connected,b:connected", "both applications are attached before the start", JSON.stringify(result));
      const started = await adapter.startAppStackComponent(startReq(planV, "db"));
      assert(started.outcome === "started", "the new container starts", JSON.stringify(started));
      await waitHealthy(V, ["db"], 120_000);
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "the first application reaches the new container by the same name, data kept", "another value");
      assert((await valkey(workerB, aliasOf(V), "GET", "probe")) === "kept", "and so does the second", "another value");
      assert((await inspectOf(DB(V))).Config.Cmd.includes("192mb"), "it runs the new version", "old arguments");
    });

    await step("application-stop-start-keeps-links", async () => {
      const before = await Promise.all(ports.map(([stackId]) => runOf(DB(stackId))));
      const attached = await Promise.all(ports.map(([stackId]) => netsOf(DB(stackId))));
      const stopped = await adapter.stopAppStack({ stackId: A, organizationId: ORG });
      assert(stopped.components.length === plans.a.components.length && stopped.components.every((c) => c.outcome === "stopped"), "the first application is stopped", JSON.stringify(stopped));
      for (const name of namesOf(plans.a).containers) assert((await inspectOf(name)).State.Running === false, `${name} is not running`, "running");
      assert(same(await Promise.all(ports.map(([stackId]) => netsOf(DB(stackId)))), attached), "every database stays attached to the stopped application's network", "changed");
      assert(same(await Promise.all(ports.map(([stackId]) => runOf(DB(stackId)))), before), "no database is restarted or made again", "changed");
      assert((await valkey(workerB, aliasOf(V), "GET", "probe")) === "kept", "the other application still reaches the database", "another value");
      // What the API does before the start of an application: one pass for each database it uses.
      const mark = gateLog.length;
      assert(outcomes(await link(V, [A, B])) === "a:already_connected,b:already_connected", "the pass before the start finds Valkey attached", "not attached");
      for (const stackId of [M, P]) assert(outcomes(await link(stackId, [A])) === "a:already_connected", `the pass before the start finds ${stackId} attached`, "not attached");
      assert(writesIn(mark).length === 0, "the passes change nothing on the server", writesIn(mark).join(" | "));
      for (const c of plans.a.components) {
        if (c.dependsOn.length > 0) await waitHealthy(A, c.dependsOn);
        const started = await adapter.startAppStackComponent(startReq(plans.a, c.key));
        assert(started.outcome === "started", `${c.key} starts again`, JSON.stringify(started));
      }
      await waitHealthy(A, plans.a.components.map((c) => c.key));
      for (const [stackId, port] of ports) assert((await reach(worker, aliasOf(stackId), port)) === null, `started again, the application reaches ${stackId} by its name`, String(await reach(worker, aliasOf(stackId), port)));
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "and reads the same data", "another value");
      assert(same(await Promise.all(ports.map(([stackId]) => runOf(DB(stackId)))), before), "the databases ran through all of it", "changed");
    });

    await step("application-removal-detaches-running-database", async () => {
      const before = await runOf(DB(V));
      const out = await adapter.removeAppStack({ stackId: B, organizationId: ORG, removeVolumes: true });
      assert(out.removedNetworks.includes("app_internal") && out.removedComponents.length === 2, "the application and its private network are removed", JSON.stringify(out));
      await gone(B, "application removal");
      assert((await runOf(DB(V))) === before, "the database kept running, untouched", `${before} -> ${await runOf(DB(V))}`);
      assert(same(await netsOf(DB(V)), [netName(A), netName(V)].sort()), "the database is off the removed network", (await netsOf(DB(V))).join(","));
      const result = await link(V, [A]);
      assert(outcomes(result) === "a:already_connected" && result.disconnected.length === 0, "the remaining link is as it was", JSON.stringify(result));
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "the other application still reaches the database", "another value");
    });

    await step("stopped-database-survives-application-removal", async () => {
      const prepared = await adapter.prepareAppStack({ plan: plans.n });
      assert(same(prepared.networks, [{ role: "app_internal", created: true }]), "a third application has a private network", JSON.stringify(prepared));
      const result = await link(V, [A, N]);
      assert(outcomes(result) === "a:already_connected,n:connected", "the database is attached to it", JSON.stringify(result));
      const stopped = await adapter.stopAppStack({ stackId: V, organizationId: ORG });
      assert(same(stopped.components, [{ componentKey: "db", outcome: "stopped" }]), "the database is stopped", JSON.stringify(stopped));
      assert((await netsOf(DB(V))).includes(netName(N)), "stopped, it still records the attachment", (await netsOf(DB(V))).join(","));
      const out = await adapter.removeAppStack({ stackId: N, organizationId: ORG, removeVolumes: true });
      assert(out.removedNetworks.includes("app_internal"), "the application's network is removed", JSON.stringify(out));
      await gone(N, "application removal under a stopped database");
      assert(same(await netsOf(DB(V)), [netName(A), netName(V)].sort()), "the removal took the stopped database off that network", (await netsOf(DB(V))).join(","));
      const started = await adapter.startAppStackComponent(startReq(planV, "db"));
      assert(started.outcome === "started", "so the database starts again", JSON.stringify(started));
      await waitHealthy(V, ["db"], 120_000);
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "and the remaining application reaches it", "another value");
    });

    await step("stale-attachment-repaired", async () => {
      const takeAway = async () => {
        const r = await viaGate("DELETE", `/v1.45/networks/${netName(N)}`);
        assert(r.status === 204, "the Engine removes a network whose only attached container is stopped", `${String(r.status)} ${r.body.slice(0, 120)}`);
      };
      // 1. The network of a linked application disappears while the database is stopped (nothing of ours did it).
      await adapter.prepareAppStack({ plan: plans.n });
      assert(outcomes(await link(V, [A, N])) === "a:already_connected,n:connected", "attached to the third application", "not attached");
      await adapter.stopAppStack({ stackId: V, organizationId: ORG });
      await takeAway();
      const refusedStart = await rejection(adapter.startAppStackComponent(startReq(planV, "db")));
      assert(refusedStart !== null, "the Engine cannot start a container attached to a network that is gone", "started");
      info(`start with a stale attachment: ${reasonOf(refusedStart)} (${String(refusedStart.message).slice(0, 100)})`);
      assert((await inspectOf(DB(V))).State.Running === false, "the database is still stopped", "running");
      const mended = await link(V, [A]);
      assert(mended.container === true && outcomes(mended) === "a:already_connected" && same(mended.disconnected, [N]), "the next pass takes the dead attachment off", JSON.stringify(mended));
      assert((await adapter.startAppStackComponent(startReq(planV, "db"))).outcome === "started", "and the database starts", "not started");
      await waitHealthy(V, ["db"], 120_000);
      // 2. The network is made again under the same name: the recorded attachment points at the old one.
      const again = await adapter.prepareAppStack({ plan: plans.n });
      assert(same(again.networks, [{ role: "app_internal", created: true }]), "the third application's network exists again", JSON.stringify(again));
      assert(outcomes(await link(V, [A, N])) === "a:already_connected,n:connected", "attached to it", "not attached");
      const oldNet = (await networkOf(netName(N))).Id;
      await adapter.stopAppStack({ stackId: V, organizationId: ORG });
      await takeAway();
      await adapter.prepareAppStack({ plan: plans.n });
      const newNet = (await networkOf(netName(N))).Id;
      assert(newNet !== oldNet, "the same name, another network", "the same network");
      assert((await endpointOf(DB(V), N))?.NetworkID === oldNet, "the stopped database records the old network", String((await endpointOf(DB(V), N))?.NetworkID));
      const renewed = await link(V, [A, N]);
      assert(outcomes(renewed) === "a:already_connected,n:connected" && renewed.disconnected.length === 0, "the pass before the start replaces the attachment", JSON.stringify(renewed));
      assert((await adapter.startAppStackComponent(startReq(planV, "db"))).outcome === "started", "and the database starts", "not started");
      await waitHealthy(V, ["db"], 120_000);
      assert((await endpointOf(DB(V), N))?.NetworkID === newNet, "running on the network that exists now", String((await endpointOf(DB(V), N))?.NetworkID));
      assert((await valkey(worker, aliasOf(V), "GET", "probe")) === "kept", "the application reaches it, data kept", "another value");
    });

    await step("refuses-foreign-targets", async () => {
      const prepared = await adapter.prepareAppStack({ plan: plans.x });
      assert(same(prepared.networks, [{ role: "app_internal", created: true }]), "an application of another customer has a private network", JSON.stringify(prepared));
      const nets = await netsOf(DB(V));
      const mark = gateLog.length;
      // One call at a time: the executor refuses a second change of the same database while one is running.
      const refusals = [
        ["a database in its own list", () => link(V, [A, V]), "STACK_PLAN_INVALID"],
        ["an id that is not an application id", () => link(V, [A, "../etc"]), "STACK_PLAN_INVALID"],
        ["an application with two components as the database", () => link(A, [N], "storage"), "STACK_PLAN_INVALID"],
        ["another component key", () => link(V, [A], "cache"), "STACK_PLAN_INVALID"],
        ["an application of another customer", () => link(V, [A, X]), "STACK_NAMESPACE_CONFLICT"],
      ];
      for (const [what, call, reason] of refusals) {
        const err = await rejection(call());
        assert(err?.reason === reason, `${what} is refused as ${reason}`, err ? `${reasonOf(err)} ${String(err.message).slice(0, 100)}` : "accepted");
        assert(!JSON.stringify({ m: err.message, d: err.details }).includes("hp_"), `${what}: the refusal names no Docker object`, String(err.message));
      }
      assert(writesIn(mark).length === 0, "no refusal changed anything on the server", writesIn(mark).join(" | "));
      assert(same(await netsOf(DB(V)), nets), "the database's networks are as before", (await netsOf(DB(V))).join(","));
      const asOwner = await rejection(adapter.syncAppStackLinks({ stackId: V, organizationId: OTHER_ORG, componentKey: "db", consumerStackIds: [X] }));
      assert(asOwner?.reason === "STACK_NAMESPACE_CONFLICT", "another customer cannot attach this database to its own application", asOwner ? reasonOf(asOwner) : "accepted");
      assert(writesIn(mark).length === 0 && same(await netsOf(DB(V)), nets), "and nothing changed on the server", writesIn(mark).join(" | "));
    });

    await step("detach-removes-reachability", async () => {
      const before = await Promise.all(ports.map(([stackId]) => runOf(DB(stackId))));
      const emptied = await link(V, []);
      assert(emptied.container === true && emptied.links.length === 0 && same(emptied.disconnected, [A, N].sort()), "Valkey is detached from both applications", JSON.stringify(emptied));
      for (const stackId of [M, P]) {
        const out = await link(stackId, []);
        assert(out.container === true && out.links.length === 0 && same(out.disconnected, [A]), `${stackId} is detached`, JSON.stringify(out));
      }
      for (const [stackId, port] of ports) {
        assert(same(await netsOf(DB(stackId)), [netName(stackId)]), `${stackId} is on its own network only`, (await netsOf(DB(stackId))).join(","));
        assert(unknownName(await reach(worker, aliasOf(stackId), port)), `the application can no longer resolve ${stackId}`, "resolved or reached");
      }
      assert(same(await Promise.all(ports.map(([stackId]) => runOf(DB(stackId)))), before), "no database was restarted or made again", "changed");
      assert(same(await membersOf(A), namesOf(plans.a).containers), "the application's network holds its own components only", (await membersOf(A)).join(","));
      const again = await link(V, []);
      assert(again.container === true && again.links.length === 0 && again.disconnected.length === 0, "an empty list on a detached database changes nothing", JSON.stringify(again));
      assert((await mariadb("db", SQL_READ)).trim() === "kept" && (await psql("db", SQL_READ)).trim() === "kept", "the databases still serve on their own network", "another value");
    });

    await step("remove-everything", async () => {
      assert(outcomes(await link(M, [A])) === "a:connected", "MariaDB is linked again", "not attached");
      const dirs = [plans.m, plans.p].map((plan) => path.join(secretsRoot, appStackSecretDirKey(plan.stackId, "db")));
      for (const dir of dirs) assert(await exists(dir), "the directory of the password files exists", dir);
      const out = await adapter.removeAppStack({ stackId: M, organizationId: ORG, removeVolumes: true });
      assert(same(out.removedComponents, ["db"]) && out.removedNetworks.includes("app_internal") && same(out.removedVolumes, ["data"]), "a linked database is removed with its data", JSON.stringify(out));
      await gone(M, "database removal");
      assert(same(await membersOf(A), namesOf(plans.a).containers), "the application's network is still there, with its own components only", (await membersOf(A)).join(","));
      assert((await reach(worker, "storage", 6379)) === null, "and the application still works", "storage not reached");
      for (const [stackId, organizationId] of [[P, ORG], [V, ORG], [A, ORG], [N, ORG], [X, OTHER_ORG]]) {
        await adapter.removeAppStack({ stackId, organizationId, removeVolumes: true });
        await gone(stackId, "removal");
      }
      for (const dir of dirs) assert(!(await exists(dir)), "the password files are gone with their database", dir);
      const S2 = await snapshot();
      assert(same(ownNames(S2), NONE), "nothing of this run is left", JSON.stringify(ownNames(S2)));
      assert(removedSince(S0, S2).length === 0, "no pre-existing object removed", removedSince(S0, S2).join(","));
    });

    if (!rootCasesEnabled) {
      skip(
        "host-nft-metadata-drop-on-stack-net",
        "needs root to read the host nft ruleset (run as root with HP_ACCEPT_ROOT_CASES=1); the ruleset is proven by accept-m5-firewall.mjs and the shape of a database's network (plain internal bridge, no Options, br-<id12> present) by the deploy steps",
      );
    } else {
      await step("host-nft-metadata-drop-on-stack-net", async () => {
        const chain = await run("nft", ["list", "chain", "inet", "hp_dedicated_filter", "forward"], 20_000);
        assert(chain.includes('iifname "br-*" ip daddr 169.254.0.0/16 drop'), "the host drops metadata traffic from every br-* bridge", "rule absent");
        assert(bridges.length === 4 && bridges.every((b) => b.startsWith("br-")), "the application's and the databases' bridges match br-*", bridges.join(","));
      });
    }

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only about this run's objects", gateDenied.slice(0, 3).join(" | "));
      const banned = gateLog.filter((l) => /\/(prune|system|build|exec|archive|images\/create)(\/|\?| |$)/.test(l.split(" ")[1]));
      assert(banned.length === 0, "no prune, system, build, exec, archive or image download request", banned.join(" | "));
      const edge = gateLog.filter((l) => l.includes("hp_appedge_"));
      assert(edge.length === 0, "no request named an edge network", edge.join(" | "));
      info(`gate saw ${gateLog.length} request(s), ${gateDenied.length} denied`);
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
