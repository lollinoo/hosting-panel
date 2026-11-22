#!/usr/bin/env node
/**
 * Real-Docker acceptance of the built-in «WordPress in contenitore» application, the first template of the extended
 * format HCP-STACK/v2 (ADR-0036), through the PRODUCTION DockerEngineSocketAdapter from apps/docker-executor/dist, called
 * step by step as the API would. The script plays the API for the two generated secrets (two random values, as §2.6 has
 * the API generate them) and proves what the format adds: images pinned by digest without an allowlist row (§2.3), the
 * `standard` run profile with its closed capability list and nothing else about privileges (§2.4), secrets delivered in
 * the environment of the component that needs them and nowhere else (§2.5), plan refusals before any Docker request,
 * WordPress installed through a throwaway proxy without anybody typing a database password, logs that hide a secret
 * that ends up in them, data that outlives a stop, a start and the replacement of the database container, a removal
 * that keeps the data and one that deletes it.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack id stk_swarmtest_<hex>_a, so every container, network and volume name
 *    the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_stk_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created), the create bodies keep the profile, and a pull names a seed digest of the template;
 *    list answers are filtered to this run's objects. A secret of the run may travel in one place only, the Env of a
 *    container of the application: anywhere else the gate denies the request. The first step proves these denials.
 *    The script's own changes (proxy removal, cleanup) go through the same gate.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_stk_<hex>-secrets or a
 *    nonexistent own *_unused name. The only proxy is a throwaway one created through the ingressProxyContainerName /
 *    ingressNetworkName seams, published on 127.0.0.1:16780/16743 only; the gate denies a connect or disconnect of a
 *    container that is not this run's, so no live proxy can be attached.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/logs and the commands run inside a container only ever name this run's objects.
 *    The two secrets are random values of this run that die with it; the login checks pass them as arguments.
 *  - Images: the digest-pinned refs of the wordpress-mariadb seed in APP_BUILT_IN_TEMPLATES, pulled by the product
 *    through the gate when missing (offline run: docker pull each <repository>@sha256:<digest> first). traefik:v3.7
 *    must be local.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true), then leftovers by
 *    exact own names through the gate, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-stack-wordpress.mjs
 * Steps: gate-self-test, preflight, snapshot-before, plan-compiles-from-seed, refused-before-docker,
 * deploy-creates-exact-set, container-standard-profile, secrets-reach-only-their-component, network-shape,
 * no-control-plane-reach, route-published-after-health, wordpress-installs, logs-mask-environment-secrets,
 * data-survives-stop-and-start, idempotent-reapply, upgrade-keeps-data, recovery-reads-only, remove-keeps-volumes,
 * destroy-data-removes-volume, host-nft-metadata-drop-on-stack-net (root only: HP_ACCEPT_ROOT_CASES=1 as root),
 * gate-clean, nothing-left.
 * Each prints PASS/FAIL/SKIP <step>; final line RESULT n/m passed (a skipped step is never a pass and is not counted).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const t0 = performance.now();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const exists = (p) => stat(p).then(() => true, () => false);
const DIST = [
  "apps/docker-executor/dist/index.js",
  "packages/policy-engine/dist/index.js",
  "packages/contracts/dist/index.js",
  "packages/hosting-domain/dist/index.js",
].map((p) => path.resolve(repoRoot, p));
const missingDist = [];
for (const file of DIST) if (!(await exists(file))) missingDist.push(path.relative(repoRoot, file));
if (missingDist.length > 0) {
  console.log(`FAIL preflight: run corepack pnpm run build first (missing ${missingDist.join(", ")})`);
  console.log("RESULT 0/1 passed in 0.0s");
  process.exit(1);
}
const [executor, policy, contracts, domain] = await Promise.all(DIST.map((file) => import(pathToFileURL(file).href)));
const {
  APP_STACK_STANDARD_CAP_ADD,
  DockerEngineSocketAdapter,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackRouteFileName,
  appStackSecretDirKey,
  appStackVolumeName,
} = executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema, appStackComponentSecretRefs } = contracts;
const { computeAppStackPlanHash } = domain;

const TRAEFIK_IMAGE = "traefik:v3.7";
const HOST = "127.0.0.1";
const PORT = { http: 16780, https: 16743 };
const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_stk_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const proxyName = `${runPrefix}_proxy`;
const ingressNet = `${runPrefix}_ingress`;
const ORG = `org_swarmtest_${hex}`;
const A = `stk_swarmtest_${hex}_a`;
const HOST1 = `wp-${hex}.hp-stk.test`;
const TITLE = `Acceptance ${hex}`;
const HEALTH_MS = 180_000;
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- secrets (the API generates them at install; here two random values that die with the run) ----
const DB_PASSWORD = randomBytes(16).toString("hex");
const ROOT_PASSWORD = randomBytes(16).toString("hex");
const ADMIN_PASSWORD = randomBytes(12).toString("hex");
const SECRET_CONTENTS = [
  { parameterKey: "db_password", version: 1, content: DB_PASSWORD },
  { parameterKey: "db_root_password", version: 1, content: ROOT_PASSWORD },
];
/** How many 8-character windows of the secret occur in a text (0 = no part of it leaked). */
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
  return n;
}
const leaks = (text) => [DB_PASSWORD, ROOT_PASSWORD].some((secret) => leakedWindows(text, secret) > 0);

// ---- plans (the seed of the extended format: no allowlist row, two generated secrets) ----
const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "wordpress-mariadb");
const first = compileAppStackPlan({
  source: seed.source,
  parameters: [],
  secretVersions: new Map(SECRET_CONTENTS.map((e) => [e.parameterKey, e.version])),
  ids: {
    stackId: A,
    organizationId: ORG,
    hostAllocationId: `alloc_swarmtest_${hex}`,
    templateVersionId: seed.versionId,
    revisionId: `srev_swarmtest_${hex}_1`,
  },
});
/** The seed digest refs: the only images the gate inspects or pulls (besides the proxy image). */
const IMAGES = new Set(first.ok ? first.plan.components.map((c) => c.image) : []);
const rehash = (plan) => ({ ...plan, planHash: computeAppStackPlanHash(plan) });
const withComponent = (plan, key, over) => rehash({ ...plan, components: plan.components.map((c) => (c.key === key ? { ...c, ...over } : c)) });
const componentOf = (plan, key) => plan.components.find((c) => c.key === key);
const namesOf = (plan) => ({
  containers: plan.components.map((c) => appStackContainerName(plan.stackId, c.key)).sort(),
  networks: [appStackInternalNetworkName(plan.stackId), ...(plan.ingress.length > 0 ? [appStackEdgeNetworkName(plan.stackId)] : [])].sort(),
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const cName = appStackContainerName;
const isAppName = (name) => name.startsWith("hp_app_") && name.includes(marker);
const hostRoute = (hostname) => ({ hostname, tls: false, httpsRedirect: false, redirectTo: null });
/** The secret entries one component reads, as the API sends them with a start or a restart. */
const entriesFor = (plan, key) => {
  const wanted = new Set(appStackComponentSecretRefs(componentOf(plan, key)).map((ref) => ref.parameterKey));
  return SECRET_CONTENTS.filter((e) => wanted.has(e.parameterKey));
};
/** The bounding set the `standard` profile leaves, as /proc/<pid>/status prints it. */
const CAP_BIT = { CHOWN: 0, DAC_OVERRIDE: 1, FOWNER: 3, SETGID: 6, SETUID: 7, NET_BIND_SERVICE: 10 };
const CAP_MASK = APP_STACK_STANDARD_CAP_ADD.reduce((mask, cap) => mask | (1 << (CAP_BIT[cap] ?? 63)), 0).toString(16).padStart(16, "0");
const capsOf = (list) => (list ?? []).map((cap) => String(cap).replace(/^CAP_/, "")).sort();

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

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
async function docker(args, timeout = 120_000, input = "") {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !ours(t));
  const objectVerb =
    ["inspect", "exec", "top", "stats", "logs"].includes(args[0]) || (["network", "volume"].includes(args[0]) && args[1] === "inspect");
  if (foreign.length > 0 || (objectVerb && !args.some(ours))) throw new Error(`refusing docker ${args[0]} (an object of another run)`);
  return run("docker", args, timeout, input);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const networkOf = async (name) => JSON.parse(await docker(["network", "inspect", name]))[0];
const volumeOf = async (name) => JSON.parse(await docker(["volume", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();
/** PHP of the WordPress image inside an own container, argv only: resolves true when the code ends with status 0. */
const phpIn = (container, code, args) =>
  docker(["exec", container, "php", "-r", code, "--", ...args], 30_000).then(
    () => true,
    () => false,
  );
const TCP_OPENS = "exit(@fsockopen($argv[1], (int) $argv[2], $e, $s, 2) ? 0 : 1);";
const DB_LOGIN = "mysqli_report(MYSQLI_REPORT_OFF); exit(@mysqli_connect($argv[1], $argv[2], $argv[3]) ? 0 : 1);";

let ingressRoot = null;
async function treeDigest(dir) {
  const out = [];
  for (const f of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!f.isFile()) continue;
    const p = path.join(f.parentPath, f.name);
    out.push(`${path.relative(dir, p)} ${sha256(await readFile(p))}`);
  }
  return out.sort();
}
const snapshot = async () => ({
  containers: await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]),
  networks: await lines(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"]),
  volumes: await lines(["volume", "ls", "--format", "{{.Name}}"]),
  certs: await treeDigest(ingressRoot),
});
const KINDS = ["containers", "networks", "volumes"];
/** This run's names in a snapshot. */
const ownNames = (s) => ({
  containers: s.containers.filter(ours).map((l) => l.split(" ")[1]).sort(),
  networks: s.networks.filter(ours).map((l) => l.split(" ")[1]).sort(),
  volumes: s.volumes.filter(ours).sort(),
});
const removedSince = (s0, s1) => KINDS.flatMap((k) => s0[k].filter((l) => !s1[k].includes(l)));
/** Every volume the engine has that this run did not name (an image may declare one the plan does not cover). */
const otherVolumes = (s0, s1) => s1.volumes.filter((l) => !s0.volumes.includes(l) && !ours(l));

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

/** null = the create body is the `standard` profile and nothing wider, and names only this run's objects. */
function containerBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (!IMAGES.has(body.Image)) return "image";
  if (h.Privileged === true || (h.CapAdd ?? []).some((cap) => !APP_STACK_STANDARD_CAP_ADD.includes(cap))) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !same(h.SecurityOpt, ["no-new-privileges:true"])) return "hardening";
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).length > 0) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  if (Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker))) return "endpoint";
  return null;
}
/** null = the throwaway proxy: the pinned image, its own network, binds only from the temp dir, the two test ports. */
function proxyBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (body.Image !== TRAEFIK_IMAGE || h.Privileged === true || h.Devices !== undefined) return "proxy body";
  if (h.NetworkMode !== ingressNet || Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => k !== ingressNet)) return "proxy network";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${tmpDir}/`))) return "proxy bind";
  const ports = Object.values(h.PortBindings ?? {}).flatMap((list) => list.map((b) => b.HostPort));
  return ports.every((p) => [String(PORT.http), String(PORT.https)].includes(p)) ? null : "proxy port";
}

/** Default deny: "forward" (optionally with a rewritten body, registering the created id or filtering a list) or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const query = decodeURIComponent(u.search);
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t));
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  if (leaks(`${p}?${query}`)) return deny("secret in the address");
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  // A secret travels in one place only: the Env of a container of this run's application.
  const appCreate = method === "POST" && p === "/containers/create" && isAppName(u.searchParams.get("name") ?? "");
  if (leaks(appCreate ? JSON.stringify({ ...body, Env: [] }) : bodyText)) return deny("secret outside Env");
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version" || p === "/info")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) || m[1] === TRAEFIK_IMAGE ? fwd() : deny("image");
  if (method === "POST" && p === "/images/create") {
    const from = u.searchParams.get("fromImage") ?? "";
    const tag = u.searchParams.get("tag") ?? "";
    const ref = tag === "" ? from : tag.startsWith("sha256:") ? `${from}@${tag}` : null;
    return ref !== null && ref.includes("@sha256:") && IMAGES.has(ref) ? fwd() : deny("image pull");
  }
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p });
  if (method === "POST" && p === "/networks/create") {
    const role = body.Labels?.[ROLE_LABEL];
    const ok =
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.IPAM === undefined &&
      ((String(body.Name).includes(marker) && ["app_internal", "app_edge"].includes(role)) || (body.Name === ingressNet && role === "ingress_public"));
    return ok ? fwd() : deny("network create");
  }
  if (method === "POST" && p === "/volumes/create") {
    const ok = String(body.Name).includes(marker) && body.DriverOpts === undefined && [undefined, "local"].includes(body.Driver);
    return ok ? fwd() : deny("volume create");
  }
  if (method === "POST" && p === "/containers/create") {
    const name = u.searchParams.get("name") ?? "";
    if (name === proxyName) {
      const problem = proxyBodyProblem(body);
      if (problem !== null) return deny(problem);
      for (const list of Object.values(body.HostConfig?.PortBindings ?? {})) for (const b of list) b.HostIp = HOST;
      return fwd({ register: true, body: JSON.stringify(body) });
    }
    const problem = isAppName(name) ? containerBodyProblem(body) : "unnamed or foreign container";
    return problem === null ? fwd({ register: true }) : deny(problem);
  }
  if (method === "POST" && (m = p.match(/^\/networks\/([^/]+)\/(?:connect|disconnect)$/))) {
    return isOwn(m[1]) && isOwn(String(body.Container ?? "")) ? fwd() : deny("network attach of a foreign object");
  }
  if ((m = p.match(/^\/containers\/([^/]+)(?:\/(json|logs|start|stop|restart|kill|wait))?$/)) && isOwn(m[1])) {
    const sub = m[2];
    if (method === (sub === undefined ? "DELETE" : sub === "json" || sub === "logs" ? "GET" : "POST")) return fwd({ inspect: sub === "json" });
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
      if (verdict.kind !== "forward") {
        gateDenied.push(`${req.method} ${String(req.url).slice(0, 120)}: ${verdict.why}`);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "gate: denied" }));
        return;
      }
      const out = Buffer.from(verdict.body ?? bodyText);
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
          // The proxy's ports are loopback in Docker: show the executor the HostIp its payload asked for.
          if (verdict.inspect) body = Buffer.from(body.toString("utf8").replaceAll('"HostIp":"127.0.0.1"', '"HostIp":"0.0.0.0"'));
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
/** One request through the throwaway proxy with a Host header (a form makes it a POST); status 0 when nothing answered. */
function viaProxy(hostname, urlPath, { form = null, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const data = form === null ? Buffer.alloc(0) : Buffer.from(new URLSearchParams(form).toString());
    const headers = { Host: hostname };
    if (form !== null) Object.assign(headers, { "content-type": "application/x-www-form-urlencoded", "content-length": String(data.length) });
    const req = http.request({ host: HOST, port: PORT.http, path: urlPath, method: form === null ? "GET" : "POST", agent: false, headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, location: String(res.headers.location ?? ""), body: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, location: "", body: "" }));
    req.end(data);
  });
}
const served = (hostname, urlPath, status, check = () => true, ms = 60_000) =>
  until(`${hostname}${urlPath} answers ${String(status)} through the proxy`, ms, async () => {
    const r = await viaProxy(hostname, urlPath);
    if (r.status === status && check(r)) return r;
    throw new Error(`${String(r.status)} ${r.location} ${r.body.replace(/\s+/g, " ").slice(0, 160)}`);
  });

// ---- cleanup ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      await adapter
        .removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: true })
        .catch((err) => console.log(`INFO cleanup ${A}: ${reasonOf(err)}`));
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
  let proxyImageId;
  try {
    engineVersion = (await docker(["version", "--format", "{{.Server.Version}}"])).trim();
    proxyImageId = (await docker(["image", "inspect", "--format", "{{.Id}}", TRAEFIK_IMAGE])).trim();
  } catch (err) {
    console.log(`SKIP accept-app-stack-wordpress: no Docker Engine or ${TRAEFIK_IMAGE} is not local (${err.message}); nothing was created (this script never pulls the proxy image)`);
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
  ingressRoot = path.join(tmpDir, "ingress");
  gateSocket = path.join(tmpDir, "docker-gate.sock");
  const unused = (x) => `${runPrefix}_${x}_unused`;
  const adapterOptions = {
    dockerSocketPath: gateSocket,
    secretsRootDir: secretsRoot,
    ingressRootDir: ingressRoot,
    ingressHttpPort: PORT.http,
    ingressHttpsPort: PORT.https,
    ingressProxyContainerName: proxyName,
    ingressNetworkName: ingressNet,
    traefikImage: TRAEFIK_IMAGE,
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
  const status = (a = adapter) => a.getAppStackStatus({ stackId: A, organizationId: ORG });
  const healthOf = (s, key) => s.components.find((c) => c.componentKey === key)?.health;
  const waitHealthy = (keys, ms = HEALTH_MS) =>
    until(`${keys.join(",")} of ${A} healthy`, ms, async () => {
      const s = await status();
      return keys.every((k) => healthOf(s, k) === "healthy") ? s : null;
    });
  const startReq = (plan, componentKey) => ({ plan, componentKey, secretFileContents: entriesFor(plan, componentKey) });
  /** The API's deploy: pull each image, prepare, create with the secrets of the plan, start in plan order (dependencies
   *  healthy first; dependents of a replaced component restarted when a previous revision ran), then wait until every
   *  component is healthy. */
  const deploy = async (plan, previous = null) => {
    const pulls = [];
    for (const image of new Set(plan.components.map((c) => c.image))) pulls.push(await adapter.pullAppStackImage({ plan, image }));
    const prepare = await adapter.prepareAppStack({ plan });
    const create = await adapter.createAppStackComponents({ plan, secretContents: SECRET_CONTENTS });
    const hit = new Set(create.components.filter((c) => c.outcome !== "unchanged").map((c) => c.componentKey));
    const again = new Set();
    for (const c of plan.components) {
      if (previous !== null && !hit.has(c.key) && c.dependsOn.some((d) => hit.has(d))) {
        hit.add(c.key);
        again.add(c.key);
      }
    }
    const starts = [];
    for (const c of plan.components) {
      if (c.dependsOn.length > 0) await waitHealthy(c.dependsOn);
      starts.push(await (again.has(c.key) ? adapter.restartAppStackComponent(startReq(plan, c.key)) : adapter.startAppStackComponent(startReq(plan, c.key))));
    }
    await waitHealthy(plan.components.map((c) => c.key));
    return { pulls, prepare, create, starts };
  };
  const idsOf = async (plan) => Object.fromEntries(await Promise.all(namesOf(plan).containers.map(async (n) => [n, (await inspectOf(n)).Id])));
  const routeFile = path.join(ingressRoot, "dynamic", appStackRouteFileName(A));
  const fileState = async (file) => ({ sha: sha256(await readFile(file)), mtime: (await stat(file)).mtimeMs });
  const writesIn = (from) => gateLog.slice(from).filter((l) => /^(POST|DELETE|PUT) /.test(l));
  const volumeDeletesIn = (from) => gateLog.slice(from).filter((l) => /^DELETE \/(v[\d.]+\/)?volumes\//.test(l));
  const secretFiles = async () => (await treeDigest(secretsRoot)).map((l) => l.split(" ")[0]);
  const siteAnswers = () => served(HOST1, "/", 200, (r) => r.body.includes(TITLE));
  let S0 = null;
  let planA = null;
  const bridges = [];

  try {
    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    const gateOk = await step("gate-self-test", async () => {
      // Real names of this machine, used only as judge() inputs: no request about them is ever sent.
      const foreignName = (await lines(["ps", "-a", "--format", "{{.Names}}"])).find((n) => n.startsWith("hp_")) ?? `hp_selftest_${hex}`;
      const foreignId = (await lines(["ps", "-aq", "--no-trunc"]))[0] ?? "f".repeat(64);
      const foreignNet = (await lines(["network", "ls", "--format", "{{.Name}}"])).find((n) => n.startsWith("hp_")) ?? "bridge";
      const foreignVol = (await lines(["volume", "ls", "--format", "{{.Name}}"]))[0] ?? `selftest_${hex}`;
      const image = [...IMAGES][0] ?? "none";
      const ownNet = appStackInternalNetworkName(A);
      const wp = cName(A, "wordpress");
      const siteVolume = appStackVolumeName(A, "site");
      const standard = {
        Image: image,
        HostConfig: { CapDrop: ["ALL"], CapAdd: [...APP_STACK_STANDARD_CAP_ADD], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: false, NetworkMode: ownNet },
      };
      const createWith = (hostConfig, extra = {}) => JSON.stringify({ ...standard, ...extra, HostConfig: { ...standard.HostConfig, ...hostConfig } });
      const proxyBody = (over, extra = {}) =>
        JSON.stringify({ Image: TRAEFIK_IMAGE, ...extra, HostConfig: { NetworkMode: ingressNet, Binds: [`${tmpDir}/ingress/x:/x:ro`], ...over } });
      const net = (name, role, extra = {}) => JSON.stringify({ Name: name, Driver: "bridge", Labels: { [ROLE_LABEL]: role }, ...extra });
      const cases = [
        ["GET", `/v1.45/containers/${foreignName}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/json`, ""],
        ["GET", `/v1.45/containers/${foreignId}/logs?stdout=1`, ""],
        ["POST", `/v1.45/containers/${foreignId}/stop?t=10`, ""],
        ["DELETE", `/v1.45/containers/${foreignId}?force=true&v=true`, ""],
        ["GET", `/v1.45/networks/${foreignNet}`, ""],
        ["DELETE", `/v1.45/networks/${foreignNet}`, ""],
        ["DELETE", `/v1.45/volumes/${foreignVol}`, ""],
        ["DELETE", `/v1.45/volumes/${siteVolume}?force=true`, ""],
        ["POST", `/v1.45/networks/${appStackEdgeNetworkName(A)}/connect`, JSON.stringify({ Container: foreignName })],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignId })],
        ["POST", `/v1.45/networks/${foreignNet}/disconnect`, JSON.stringify({ Container: wp })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(TRAEFIK_IMAGE)}`, ""],
        ["POST", "/v1.45/images/create?fromImage=wordpress&tag=7-apache", ""],
        ["POST", `/v1.45/images/create?fromImage=mariadb&tag=sha256:${"e".repeat(64)}`, ""],
        ["GET", "/v1.45/images/alpine:3/json", ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", "/v1.45/volumes/prune", ""],
        ["GET", "/v1.45/system/df", ""],
        ["POST", "/v1.45/build", ""],
        ["POST", `/v1.45/containers/${wp}/exec`, JSON.stringify({ Cmd: ["true"] })],
        ["PUT", `/v1.45/containers/${wp}/archive?path=/tmp`, ""],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ CapAdd: ["NET_ADMIN"] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ CapAdd: [...APP_STACK_STANDARD_CAP_ADD, "SYS_ADMIN"] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ Binds: [`${secretsRoot}/x:/run/secrets/x:ro`] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ Mounts: [{ Type: "bind", Source: DOCKER_SOCK, Target: DOCKER_SOCK }] })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({ PortBindings: { "80/tcp": [{ HostPort: "8080" }] } })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({}, { Image: TRAEFIK_IMAGE })],
        ["POST", `/v1.45/containers/create?name=${proxyName}`, proxyBody({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${proxyName}`, proxyBody({ PortBindings: { "80/tcp": [{ HostPort: "80" }] } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Options: { "com.docker.network.bridge.name": "x" } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "site_internal")],
        ["POST", "/v1.45/networks/create", net(appStackEdgeNetworkName(A), "ingress_public")],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: siteVolume, Driver: "local", DriverOpts: { type: "none" } })],
        // A secret anywhere but the Env of a container of the application.
        ["GET", `/v1.45/containers/${wp}/json?x=${DB_PASSWORD}`, ""],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: siteVolume, Driver: "local", Labels: { x: DB_PASSWORD } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Labels: { [ROLE_LABEL]: "app_internal", x: ROOT_PASSWORD } })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({}, { Labels: { x: ROOT_PASSWORD } })],
        ["POST", `/v1.45/containers/create?name=${wp}`, createWith({}, { Cmd: ["--password", DB_PASSWORD.slice(4, 20)] })],
        ["POST", `/v1.45/containers/create?name=${proxyName}`, proxyBody({}, { Env: [`X=${DB_PASSWORD}`] })],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url]) => `${method} ${url.slice(0, 80)}`).join(" | "));
      const wider = [["POST", "/v1.45/info"], ["GET", "/v1.45/info/x"]].filter(([method, url]) => judge(method, url, "").kind !== "deny");
      assert(wider.length === 0, "judge() allows GET /info and nothing wider", wider.map(([method, url]) => `${method} ${url}`).join(" | "));
      // Controls: the denials above are about what each case adds, not about the body they all share.
      const plain = judge("POST", `/v1.45/containers/create?name=${wp}`, createWith({}));
      const withSecret = judge("POST", `/v1.45/containers/create?name=${wp}`, createWith({}, { Env: [`WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`] }));
      assert(plain.kind === "forward" && withSecret.kind === "forward", "judge() forwards the standard body, with a secret in Env too", `${plain.kind} ${withSecret.kind}`);
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

    await step("preflight", async () => {
      assert(engineVersion.length > 0, "the Docker Engine answers", engineVersion);
      assert(proxyImageId.startsWith("sha256:"), `${TRAEFIK_IMAGE} is local`, proxyImageId);
      const stale = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter(ours);
      assert(stale.length === 0, "no object name contains the run marker", stale.join(","));
      assert(CAP_MASK === "00000000000004cb", "the capability list of the standard profile is the one this script knows", `${CAP_MASK} ${APP_STACK_STANDARD_CAP_ADD.join(",")}`);
      info(`engine ${engineVersion}, marker ${marker}, images ${[...IMAGES].join(" ")}`);
    });

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    const planOk = await step("plan-compiles-from-seed", async () => {
      assert(first.ok, "the wordpress-mariadb seed compiles with [] parameters", JSON.stringify(first.issues));
      planA = ApprovedStackPlanSchema.parse(first.plan);
      assert(planA.schemaVersion === 2, "a plan of the extended format", String(planA.schemaVersion));
      assert(same(planA.components.map((c) => c.key), ["db", "wordpress"]), "components [db, wordpress]", planA.components.map((c) => c.key).join(","));
      assert(same(planA.ingress, [{ componentKey: "wordpress", port: 80 }]), "ingress wordpress:80", JSON.stringify(planA.ingress));
      assert(same(planA.volumes.map((v) => v.key), ["database", "site"]), "volumes [database, site]", JSON.stringify(planA.volumes));
      assert(planA.components.every((c) => /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(c.image)), "every image is a digest reference", planA.components.map((c) => c.image).join(" "));
      assert(planA.components.every((c) => c.profile === "standard" && c.runAsUser === null && c.argv === null), "both on the standard profile, image user and command", "other");
      assert(planA.components.every((c) => c.secretFiles.length === 0), "no secretFiles", "some");
      const reads = (key) => componentOf(planA, key).secretEnvironment.map((e) => `${e.name}<-${e.pieces.map((x) => x.parameterKey ?? "literal").join("+")}`);
      assert(same(reads("db"), ["MARIADB_PASSWORD<-db_password", "MARIADB_ROOT_PASSWORD<-db_root_password"]), "db reads both secrets", reads("db").join(","));
      assert(same(reads("wordpress"), ["WORDPRESS_DB_PASSWORD<-db_password"]), "wordpress reads the database password only", reads("wordpress").join(","));
      const written = planA.components.flatMap((c) => c.environment.map((e) => e.name)).filter((name) => /PASSWORD|SECRET|TOKEN|KEY/.test(name));
      assert(written.length === 0, "no written value under a secret-looking name", written.join(","));
    });
    if (!planOk) return;
    const route = (plan, hosts) => ({ plan, routes: [{ componentKey: plan.ingress[0].componentKey, internalPort: plan.ingress[0].port, hosts: hosts.map(hostRoute) }] });
    const DB = cName(A, "db");
    const WP = cName(A, "wordpress");

    await step("refused-before-docker", async () => {
      const mark = gateLog.length;
      const db = componentOf(planA, "db");
      const refusals = [
        ["a capability list on a component", withComponent(planA, "db", { capAdd: ["NET_ADMIN"] }), "STACK_PLAN_INVALID"],
        ["a run profile outside the closed list", withComponent(planA, "db", { profile: "privileged" }), "STACK_PLAN_INVALID"],
        ["an image named by tag", withComponent(planA, "db", { image: `${db.image.split("@")[0]}:1` }), "STACK_PLAN_INVALID"],
        ["a host path", withComponent(planA, "db", { volumes: [{ ...db.volumes[0], hostPath: "/" }] }), "STACK_PLAN_INVALID"],
        ["the Docker socket as a mount target", withComponent(planA, "db", { volumes: [{ ...db.volumes[0], containerPath: DOCKER_SOCK }] }), "STACK_PLAN_INVALID"],
        ["a published host port", withComponent(planA, "db", { publish: [{ hostPort: 3306 }] }), "STACK_PLAN_INVALID"],
        ["a password written in the plan", withComponent(planA, "db", { environment: [...db.environment, { name: "MARIADB_PASSWORD", value: "x" }] }), "STACK_PLAN_INVALID"],
        ["memory over the ceiling", withComponent(planA, "db", { resources: { ...db.resources, memoryBytes: "17179869185" } }), "STACK_PLAN_INVALID"],
        [
          "content changed after approval",
          { ...planA, components: planA.components.map((c) => (c.key === "db" ? { ...c, resources: { ...c.resources, cpuMilli: 2000 } } : c)) },
          "STACK_PLAN_HASH_MISMATCH",
        ],
      ];
      for (const [what, plan, reason] of refusals) {
        const err = await rejection(adapter.prepareAppStack({ plan }));
        assert(err?.reason === reason, `${what} refused as ${reason}`, err ? reasonOf(err) : "accepted");
      }
      const entries = [
        ["a create without the secrets", undefined, "STACK_SECRET_MISSING"],
        ["a create with one secret of two", SECRET_CONTENTS.slice(0, 1), "STACK_SECRET_MISSING"],
        ["a create with a secret the plan does not name", [...SECRET_CONTENTS, { parameterKey: "other", version: 1, content: "x" }], "STACK_PLAN_INVALID"],
        ["a create with two entries for one secret", [...SECRET_CONTENTS, SECRET_CONTENTS[0]], "STACK_PLAN_INVALID"],
      ];
      for (const [what, secretContents, reason] of entries) {
        const err = await rejection(adapter.createAppStackComponents(secretContents === undefined ? { plan: planA } : { plan: planA, secretContents }));
        assert(err?.reason === reason, `${what} refused as ${reason}`, err ? reasonOf(err) : "accepted");
      }
      const sent = gateLog.slice(mark).filter((l) => !/^GET \/(v[\d.]+\/)?(_ping|version) /.test(l));
      assert(sent.length === 0, "refused before any Docker request (no image inspect, no create)", sent.join(" | "));
    });

    await step("deploy-creates-exact-set", async () => {
      const out = await deploy(planA);
      info(`pull: ${out.pulls.map((p) => `${p.image} pulled=${String(p.pulled)}`).join(", ")}`);
      assert(same(out.prepare.networks.map((n) => n.created), [true, true]), "two networks created", JSON.stringify(out.prepare.networks));
      assert(same(out.prepare.volumes.map((v) => `${v.volumeKey}:${String(v.created)}`).sort(), ["database:true", "site:true"]), "two volumes created", JSON.stringify(out.prepare.volumes));
      assert(out.create.components.every((c) => c.outcome === "created") && out.create.components.length === 2, "two components created", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "started"), "db then wordpress started", JSON.stringify(out.starts));
      assert(!leaks(JSON.stringify(out)), "no adapter result holds a part of a secret", "found");
      const S1 = await snapshot();
      assert(same(ownNames(S1), namesOf(planA)), "own delta: exactly 2 containers, 2 networks, 2 volumes", JSON.stringify(ownNames(S1)));
      assert(otherVolumes(S0, S1).length === 0, "no volume besides the two of the plan (an image volume the plan missed would be one)", otherVolumes(S0, S1).join(","));
      assert(removedSince(S0, S1).length === 0, "no pre-existing object removed", removedSince(S0, S1).join(","));
    });

    await step("container-standard-profile", async () => {
      for (const comp of planA.components) {
        const name = cName(A, comp.key);
        const c = await inspectOf(name);
        const img = JSON.parse(await docker(["image", "inspect", comp.image]))[0];
        const h = c.HostConfig;
        const labels = c.Config.Labels ?? {};
        const memory = Number(comp.resources.memoryBytes);
        const mounts = (c.Mounts ?? []).map((m) => `${m.Type} ${m.Name} ${m.Destination} ${String(m.RW)}`).sort();
        const checks = {
          CapDrop: same(h.CapDrop, ["ALL"]),
          CapAdd: same(capsOf(h.CapAdd), [...APP_STACK_STANDARD_CAP_ADD].sort()),
          SecurityOpt: same(h.SecurityOpt, ["no-new-privileges:true"]),
          WritableRootfs: h.ReadonlyRootfs === false,
          NoTmpfs: Object.keys(h.Tmpfs ?? {}).length === 0,
          PidsLimit: h.PidsLimit === 512,
          Memory: h.Memory === memory && h.MemorySwap === memory,
          NanoCpus: h.NanoCpus === comp.resources.cpuMilli * 1_000_000,
          LogConfig: h.LogConfig?.Type === "json-file" && h.LogConfig.Config?.["max-size"] !== undefined && h.LogConfig.Config?.["max-file"] !== undefined,
          RestartPolicy: h.RestartPolicy?.Name === "unless-stopped",
          NoPorts: Object.keys(h.PortBindings ?? {}).length === 0,
          NoBinds: (h.Binds ?? []).length === 0,
          Mounts: same(mounts, comp.volumes.map((v) => `volume ${appStackVolumeName(A, v.volumeKey)} ${v.containerPath} true`).sort()),
          NoHostNamespaces: ["PidMode", "IpcMode", "UsernsMode", "UTSMode"].every((k) => !String(h[k] ?? "").startsWith("host")) && (h.Devices ?? []).length === 0,
          Privileged: h.Privileged === false,
          Image: c.Config.Image === comp.image && c.Image === img.Id,
          Entrypoint: same(c.Config.Entrypoint ?? null, img.Config.Entrypoint ?? null) && same(c.Config.Cmd ?? null, img.Config.Cmd ?? null),
          User: (c.Config.User ?? "") === (img.Config.User ?? ""),
          Labels: labels["io.hostingpanel.managed"] === "true" && labels["io.hostingpanel.role"] === "app_component" && labels["io.hostingpanel.stack_id"] === A,
          NoSiteLabels: labels["io.hostingpanel.site_id"] === undefined && labels["io.hostingpanel.service_instance_id"] === undefined,
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `${name} carries the standard profile and nothing wider`, bad.join(","));
        // What the kernel enforces on the running process, not what the request asked for.
        const proc = await docker(["exec", name, "cat", "/proc/1/status"]);
        const field = (k) => proc.match(new RegExp(`^${k}:\\s+(\\S+)`, "m"))?.[1];
        assert(field("CapBnd") === CAP_MASK, `${name}: the kernel bounds it to the six capabilities of the profile`, String(field("CapBnd")));
        assert(field("NoNewPrivs") === "1", `${name}: no new privileges`, String(field("NoNewPrivs")));
      }
    });

    await step("secrets-reach-only-their-component", async () => {
      const envOf = async (name) => (await inspectOf(name)).Config.Env ?? [];
      const dbEnv = await envOf(DB);
      const wpEnv = await envOf(WP);
      assert(dbEnv.includes(`MARIADB_PASSWORD=${DB_PASSWORD}`) && dbEnv.includes(`MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`), "db holds both secrets in its environment", "missing");
      assert(wpEnv.includes(`WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`), "wordpress holds the database password in its environment", "missing");
      assert(leakedWindows(wpEnv.join("\n"), ROOT_PASSWORD) === 0, "wordpress holds no part of the root password", "found");
      for (const name of [DB, WP]) {
        const c = await inspectOf(name);
        const outside = JSON.stringify({ ...c, Config: { ...c.Config, Env: [] } });
        assert(!leaks(outside), `${name}: a secret appears in its environment only (no label, command, mount or path)`, "found elsewhere");
      }
      // The values work, each for the account the template gave it and for no other.
      const login = (user, password) => phpIn(WP, DB_LOGIN, ["db", user, password]);
      await until("the database accepts the application account", 60_000, () => login("wordpress", DB_PASSWORD), 2_000);
      assert(await login("root", ROOT_PASSWORD), "the root password opens the root account", "refused");
      const wrong = [["wordpress", ROOT_PASSWORD], ["root", DB_PASSWORD], ["root", ""], ["wordpress", ""]];
      for (const [user, password] of wrong) {
        assert(!(await login(user, password)), `${user} is refused with ${password === "" ? "no password" : "the other secret"}`, "accepted");
      }
      // The copies the executor keeps to mask the logs: one per reference, readable by the executor only, mounted nowhere.
      const expected = planA.components.flatMap((c) => entriesFor(planA, c.key).map((e) => `${appStackSecretDirKey(A, c.key)}/${e.parameterKey}`)).sort();
      assert(same(await secretFiles(), expected), "the executor keeps one copy per component and secret, for the log masking", (await secretFiles()).join(","));
      const modes = await Promise.all([secretsRoot, ...planA.components.map((c) => path.join(secretsRoot, appStackSecretDirKey(A, c.key)))].map(async (d) => (await stat(d)).mode & 0o777));
      assert(modes.every((mode) => mode === 0o700), "their directories are closed to every other user (0700)", modes.map((mode) => mode.toString(8)).join(","));
      assert(!leaks(JSON.stringify(await status())), "the status answer holds no part of a secret", "found");
    });

    await step("network-shape", async () => {
      for (const [name, role, internal] of [[appStackInternalNetworkName(A), "app_internal", true], [appStackEdgeNetworkName(A), "app_edge", false]]) {
        const n = await networkOf(name);
        assert(
          n.Driver === "bridge" && n.Internal === internal && Object.keys(n.Options ?? {}).length === 0 && n.Labels?.[ROLE_LABEL] === role,
          `${name}: plain bridge, Internal ${String(internal)}, no Options, role ${role}`,
          JSON.stringify({ d: n.Driver, i: n.Internal, o: n.Options, r: n.Labels?.[ROLE_LABEL] }),
        );
        const bridge = `br-${n.Id.slice(0, 12)}`;
        assert(await exists(`/sys/class/net/${bridge}`), `host interface ${bridge} exists (matches iifname "br-*")`, "absent");
        bridges.push(bridge);
      }
      const nets = async (key) => Object.keys((await inspectOf(cName(A, key))).NetworkSettings.Networks).sort();
      assert(same(await nets("db"), [appStackInternalNetworkName(A)]), "db is on the private network only", (await nets("db")).join(","));
      assert(same(await nets("wordpress"), namesOf(planA).networks), "wordpress is on the private and the edge network", (await nets("wordpress")).join(","));
    });

    await step("no-control-plane-reach", async () => {
      const opens = (host, port) => phpIn(WP, TCP_OPENS, [host, String(port)]);
      const gateways = [];
      for (const n of Object.keys((await inspectOf(WP)).NetworkSettings.Networks)) {
        const gw = (await networkOf(n)).IPAM?.Config?.[0]?.Gateway;
        if (gw) gateways.push(gw);
      }
      assert(gateways.length > 0, "wordpress has at least one network gateway to probe", "none");
      assert(await opens("db", 3306), "control: wordpress reaches its own database by the component name (so a refusal below is a real one)", "failed");
      for (const gw of gateways) {
        for (const port of [5432, 3306, 4000]) assert(!(await opens(gw, port)), `wordpress cannot reach ${gw}:${String(port)}`, "connected");
        info(`wordpress -> ${gw}:3000 ${(await opens(gw, 3000)) ? "reachable (known limit T15)" : "refused"}`);
      }
      for (const name of [DB, WP]) {
        const c = await inspectOf(name);
        assert(!JSON.stringify(c.Mounts ?? []).includes("docker.sock"), `${name} mounts no Docker socket`, JSON.stringify(c.Mounts));
        assert(!(c.Config.Env ?? []).some((e) => e.startsWith("DOCKER_HOST=")), `${name} has no DOCKER_HOST`, "present");
      }
    });

    await step("route-published-after-health", async () => {
      await adapter.ensureIngressProxy();
      const bindings = Object.values((await inspectOf(proxyName)).HostConfig.PortBindings ?? {}).flat();
      assert(
        bindings.length === 2 && bindings.every((b) => b.HostIp === HOST && [String(PORT.http), String(PORT.https)].includes(b.HostPort)),
        "the throwaway proxy listens on loopback test ports only",
        JSON.stringify(bindings),
      );
      assert(!(await exists(routeFile)), "no route file before the publish", "present");
      assert(healthOf(await status(), "wordpress") === "healthy", "wordpress is healthy before its route is published", "not healthy");
      const r = await adapter.publishAppStackRoutes(route(planA, [HOST1]));
      assert(r.changed === true && same(r.hostnames, [HOST1]), "the publish wrote one host", JSON.stringify(r));
      const text = await readFile(routeFile, "utf8");
      const hosts = [...text.matchAll(/Host\(`([^`]+)`\)/g)].map((x) => x[1]);
      assert(same(hosts, [HOST1]), `${appStackRouteFileName(A)} routes ${HOST1} only`, hosts.join(","));
      assert(!leaks(text), "the route file holds no part of a secret", "found");
      // A WordPress that could not log in to its database answers 500 here: the redirect to the setup proves the login.
      await served(HOST1, "/", 302, (res) => res.location.endsWith("/wp-admin/install.php"));
      await served(HOST1, "/wp-admin/install.php", 200, (res) => res.body.includes("WordPress"));
      const before = await fileState(routeFile);
      const again = await adapter.publishAppStackRoutes(route(planA, [HOST1]));
      assert(again.changed === false && same(await fileState(routeFile), before), "publishing the same set keeps the file's sha256 and mtime", JSON.stringify(again));
      const files = (await treeDigest(ingressRoot)).map((l) => l.split(" ")[0]);
      const siteFiles = files.filter((f) => /(^|\/)site_[^/]*\.yml$/.test(f));
      assert(siteFiles.length === 0, "no site_*.yml in the temp ingress root", siteFiles.join(","));
    });

    await step("wordpress-installs", async () => {
      // The customer's first visit: a site title and an administrator, never a database password.
      const form = {
        weblog_title: TITLE,
        user_name: "owner",
        admin_password: ADMIN_PASSWORD,
        admin_password2: ADMIN_PASSWORD,
        pw_weak: "on",
        admin_email: `owner@${HOST1}`,
        blog_public: "0",
        language: "",
      };
      const done = await viaProxy(HOST1, "/wp-admin/install.php?step=2", { form, timeoutMs: 180_000 });
      assert(done.status === 200, "the setup form is accepted", `${String(done.status)} ${done.body.replace(/\s+/g, " ").slice(0, 200)}`);
      await siteAnswers();
      const login = await viaProxy(HOST1, "/wp-login.php");
      assert(login.status === 200 && login.body.includes("user_login"), "the login page answers", String(login.status));
      const setup = await viaProxy(HOST1, "/wp-admin/install.php");
      assert(setup.status === 200 && !setup.body.includes("admin_password2"), "the setup is closed once the site exists", String(setup.status));
    });

    await step("logs-mask-environment-secrets", async () => {
      // The value of a secret ends up in the application's own log: the web server writes every address it is asked
      // for on the container's output, and this one holds the database password. It goes through the throwaway proxy,
      // never through the gate.
      const tag = `leak-${hex}`;
      const asked = await viaProxy(HOST1, `/?${tag}=${DB_PASSWORD}`);
      assert(asked.status === 200, "the site answers the request that carries the value", String(asked.status));
      const raw = await until("the engine's log holds the line of that request", 20_000, async () => {
        const text = await docker(["logs", "--tail", "50", WP]);
        return text.includes(tag) ? text : null;
      });
      assert(raw.includes(DB_PASSWORD), "control: the engine's own log holds the password in clear", "absent");
      const masked = JSON.stringify(await adapter.getAppStackComponentLogs({ stackId: A, organizationId: ORG, componentKey: "wordpress", tail: 50 }));
      assert(masked.includes(tag), "the product's log reader returns the line of that request", "absent");
      assert(!leaks(masked) && masked.includes("[REDACTED]"), "with the password hidden", leaks(masked) ? "password found" : "no mask");
      const dbLog = JSON.stringify(await adapter.getAppStackComponentLogs({ stackId: A, organizationId: ORG, componentKey: "db", tail: 200 }));
      assert(!leaks(dbLog), "the database log holds no part of a secret", "found");
    });

    await step("data-survives-stop-and-start", async () => {
      const stop = await adapter.stopAppStack({ stackId: A, organizationId: ORG });
      assert(same(stop.components.map((c) => `${c.componentKey}:${c.outcome}`), ["wordpress:stopped", "db:stopped"]), "stop: wordpress, then db", JSON.stringify(stop));
      const s = await status();
      assert(["db", "wordpress"].every((k) => healthOf(s, k) === "stopped"), "both reported stopped", JSON.stringify(s.components));
      const noSecret = await rejection(adapter.startAppStackComponent({ plan: planA, componentKey: "db", secretFileContents: [] }));
      assert(noSecret?.reason === "STACK_SECRET_MISSING", "a start without the secrets is refused as STACK_SECRET_MISSING", noSecret ? reasonOf(noSecret) : "accepted");
      for (const c of planA.components) {
        if (c.dependsOn.length > 0) await waitHealthy(c.dependsOn);
        const started = await adapter.startAppStackComponent(startReq(planA, c.key));
        assert(started.outcome === "started", `${c.key} starts again`, JSON.stringify(started));
      }
      await waitHealthy(["db", "wordpress"]);
      await siteAnswers();
    });

    await step("idempotent-reapply", async () => {
      const own0 = ownNames(await snapshot());
      const ids0 = await idsOf(planA);
      const mark = gateLog.length;
      const out = await deploy(planA, planA);
      assert(out.pulls.every((p) => p.pulled === false), "pulled false", JSON.stringify(out.pulls));
      assert(out.prepare.networks.every((n) => n.created === false) && out.prepare.volumes.every((v) => v.created === false), "networks and volumes created false", JSON.stringify(out.prepare));
      assert(out.create.components.every((c) => c.outcome === "unchanged") && out.create.removedComponents.length === 0, "all unchanged", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "already_running"), "already_running x2", JSON.stringify(out.starts));
      assert(same(ownNames(await snapshot()), own0) && same(await idsOf(planA), ids0), "same own objects and container ids", "changed");
      assert(writesIn(mark).length === 0, "the re-apply sent no mutating request", writesIn(mark).join(" | "));
    });

    await step("upgrade-keeps-data", async () => {
      // A new revision that changes the database component only: its container is replaced, its volume is not.
      const db = componentOf(planA, "db");
      const next = withComponent({ ...planA, revisionId: `srev_swarmtest_${hex}_2` }, "db", { resources: { ...db.resources, memoryBytes: String(640 * 1024 * 1024) } });
      const ids0 = await idsOf(planA);
      const file0 = await fileState(routeFile);
      const created0 = (await volumeOf(appStackVolumeName(A, "database"))).CreatedAt;
      const out = await deploy(next, planA);
      planA = next;
      const outcomes = out.create.components.map((c) => `${c.componentKey}:${c.outcome}`);
      assert(same(outcomes, ["db:replaced", "wordpress:unchanged"]), "only the database is replaced", outcomes.join(","));
      assert(same(out.starts.map((s) => s.outcome), ["started", "restarted"]), "db started, wordpress restarted after it", JSON.stringify(out.starts));
      const ids1 = await idsOf(planA);
      assert(ids1[DB] !== ids0[DB] && ids1[WP] === ids0[WP], "db Id changes, wordpress Id stays", JSON.stringify({ ids0, ids1 }));
      assert((await inspectOf(DB)).HostConfig.Memory === 640 * 1024 * 1024, "the new database container has the new memory limit", "other");
      assert((await volumeOf(appStackVolumeName(A, "database"))).CreatedAt === created0, "the database volume is the one created at install", "recreated");
      assert(same(await fileState(routeFile), file0), "the route file is unchanged", "changed");
      await siteAnswers();
    });

    await step("recovery-reads-only", async () => {
      const fresh = new DockerEngineSocketAdapter(adapterOptions);
      const mark = gateLog.length;
      const s = await status(fresh);
      assert(same(s.components.map((c) => c.componentKey), ["db", "wordpress"]), "a fresh adapter reports both components", JSON.stringify(s.components));
      const other = gateLog.slice(mark).filter((l) => !l.startsWith("GET "));
      assert(gateLog.length > mark && other.length === 0, "the recovery read sends GET requests only", other.join(" | "));
    });

    await step("remove-keeps-volumes", async () => {
      const volumes = namesOf(planA).volumes;
      const created = await Promise.all(volumes.map(async (v) => (await volumeOf(v)).CreatedAt));
      const unpublished = await adapter.unpublishAppStackRoutes({ stackId: A, organizationId: ORG });
      assert(unpublished.changed === true && !(await exists(routeFile)), "the route file is withdrawn", JSON.stringify(unpublished));
      const mark = gateLog.length;
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: false });
      assert(same(r.removedComponents, ["wordpress", "db"]), "wordpress and db removed", JSON.stringify(r));
      assert(same([...r.removedNetworks].sort(), ["app_edge", "app_internal"]), "both networks removed", JSON.stringify(r.removedNetworks));
      assert(same([...r.retainedVolumes].sort(), ["database", "site"]) && r.removedVolumes.length === 0, "both volumes kept", JSON.stringify(r));
      assert(volumeDeletesIn(mark).length === 0, "no volume delete was sent", volumeDeletesIn(mark).join(" | "));
      for (const [i, v] of volumes.entries()) {
        const vol = await volumeOf(v);
        assert(vol.CreatedAt === created[i] && vol.Labels?.["io.hostingpanel.stack_id"] === A, `${v} is the same volume, still labelled with its stack`, JSON.stringify(vol.Labels));
      }
      const left = ownNames(await snapshot());
      assert(same(left, { containers: [proxyName], networks: [ingressNet], volumes }), "only the proxy, its network and the two volumes are left", JSON.stringify(left));
      assert((await secretFiles()).length === 0, "the executor's copies of the secrets are gone", (await secretFiles()).join(","));
    });

    await step("destroy-data-removes-volume", async () => {
      const volumes = namesOf(planA).volumes;
      const mark = gateLog.length;
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: true });
      assert(same([...r.removedVolumes].sort(), ["database", "site"]) && r.removedComponents.length === 0, "the second removal deletes the two volumes", JSON.stringify(r));
      const deletes = volumeDeletesIn(mark);
      assert(
        deletes.length === 2 && volumes.every((v) => deletes.some((l) => l.includes(encodeURIComponent(v)))) && deletes.every((l) => !l.includes("force")),
        "exactly one delete per volume, by name, without force",
        deletes.join(" | "),
      );
      const proxyGone = await viaGate("DELETE", `/v1.45/containers/${proxyName}?force=true&v=true`);
      const netGone = await viaGate("DELETE", `/v1.45/networks/${ingressNet}`);
      assert(proxyGone.status === 204 && netGone.status === 204, "the script removes the proxy and its network by exact name", `${proxyGone.status} ${netGone.status}`);
      const S2 = await snapshot();
      assert(same(ownNames(S2), { containers: [], networks: [], volumes: [] }), "zero own objects left", JSON.stringify(ownNames(S2)));
      assert(otherVolumes(S0, S2).length === 0, "no volume of another name was left behind", otherVolumes(S0, S2).join(","));
      assert(removedSince(S0, S2).length === 0, "no pre-existing object removed", removedSince(S0, S2).join(","));
    });

    if (!rootCasesEnabled) {
      skip(
        "host-nft-metadata-drop-on-stack-net",
        "needs root to read the host nft ruleset (run as root with HP_ACCEPT_ROOT_CASES=1); the ruleset is proven by accept-m5-firewall.mjs and the stack network shape (plain bridge, no Options, br-<id12> present) by network-shape",
      );
    } else {
      await step("host-nft-metadata-drop-on-stack-net", async () => {
        const chain = await run("nft", ["list", "chain", "inet", "hp_dedicated_filter", "forward"], 20_000);
        assert(chain.includes('iifname "br-*" ip daddr 169.254.0.0/16 drop'), "the host drops metadata traffic from every br-* bridge", "rule absent");
        assert(bridges.length === 2 && bridges.every((b) => b.startsWith("br-")), "the stack bridges match br-*", bridges.join(","));
      });
    }

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only about this run's objects", gateDenied.slice(0, 3).join(" | "));
      const banned = gateLog.filter((l) => /\/(prune|system|build|exec|archive)(\/|\?| |$)/.test(l.split(" ")[1]));
      assert(banned.length === 0, "no prune, system, build, exec or archive request", banned.join(" | "));
      assert(!gateLog.some(leaks), "no request address held a part of a secret", "found");
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
