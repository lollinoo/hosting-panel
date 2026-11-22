#!/usr/bin/env node
/**
 * Real-Docker acceptance of the built-in «HTTP + cache» application (HCP-SPEC-005 §19, ADR-0035) through the
 * PRODUCTION DockerEngineSocketAdapter from apps/docker-executor/dist, called step by step as the API would: plan
 * refusals before any Docker request (A12, A13), pull by digest, networks, create and start in dependency order,
 * hardening, health and DNS between the components (A9), the private-network shape and no reach to the control plane
 * (A11), no reach between two stacks (A10), the route file published after health and served by a throwaway proxy
 * (A14), route changes without a proxy recreate (B3), truthful health, stop and start (A15), idempotent re-apply (A16),
 * an upgrade that replaces only the changed component, read-only recovery (A17), removal without orphans.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a|b, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_stk_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created), the create bodies keep the hardening, and a pull names a seed digest of the template;
 *    list answers are filtered to this run's objects. The first step proves that it denies foreign and unsafe requests.
 *    The script's own changes (stop of a component, proxy removal, cleanup) go through the same gate.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_stk_<hex>-secrets or a
 *    nonexistent own *_unused name. The only proxy is a throwaway one created through the ingressProxyContainerName /
 *    ingressNetworkName seams, published on 127.0.0.1:16780/16743 only; the gate denies a connect or disconnect of a
 *    container that is not this run's, so no live proxy can be attached.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/exec/top/stats only ever name this run's objects.
 *  - Images: the digest-pinned refs of the http-cache seed in APP_BUILT_IN_TEMPLATES, pulled by the product through the
 *    gate when missing (offline run: docker pull each <repository>@sha256:<digest> first). traefik:v3.7 must be local.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true) for both stacks,
 *    then leftovers by exact own names through the gate, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-stack-http-cache.mjs
 * Steps: gate-self-test, preflight, snapshot-before, plan-compiles-from-seed, refused-before-docker,
 * deploy-creates-exact-set, container-hardening, health-and-dns, network-shape, no-control-plane-reach, no-cross-stack,
 * route-published-after-health, route-change-no-proxy-recreate, health-reports-unhealthy, idempotent-reapply,
 * upgrade-changes-only-changed-component, recovery-reads-only, remove-leaves-no-orphans,
 * host-nft-metadata-drop-on-stack-net (root only: HP_ACCEPT_ROOT_CASES=1 as root), gate-clean, nothing-left.
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
const { DockerEngineSocketAdapter, appStackContainerName, appStackEdgeNetworkName, appStackInternalNetworkName, appStackRouteFileName, appStackVolumeName } =
  executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema } = contracts;
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
const [A, B] = ["a", "b"].map((s) => `stk_swarmtest_${hex}_${s}`);
const HOST1 = `web-${hex}.hp-stk.test`;
const HOST2 = `web2-${hex}.hp-stk.test`;
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- plans (the seed, the default allowlist) ----
const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "http-cache");
const compile = (stackId, parameters, n) =>
  compileAppStackPlan({
    source: seed.source,
    parameters,
    secretVersions: new Map(),
    ids: {
      stackId,
      organizationId: ORG,
      hostAllocationId: `alloc_swarmtest_${hex}`,
      templateVersionId: seed.versionId,
      revisionId: `srev_swarmtest_${hex}_${String(n)}`,
    },
  });
const first = compile(A, [], 1);
/** The seed digest refs: the only images the gate inspects or pulls (besides the proxy image). */
const IMAGES = new Set(first.ok ? first.plan.components.map((c) => c.image) : []);
const rehash = (plan) => ({ ...plan, planHash: computeAppStackPlanHash(plan) });
const withComponent = (plan, key, over) => rehash({ ...plan, components: plan.components.map((c) => (c.key === key ? { ...c, ...over } : c)) });
const namesOf = (plan) => ({
  containers: plan.components.map((c) => appStackContainerName(plan.stackId, c.key)).sort(),
  networks: [appStackInternalNetworkName(plan.stackId), ...(plan.ingress.length > 0 ? [appStackEdgeNetworkName(plan.stackId)] : [])].sort(),
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const cName = appStackContainerName;
const hostRoute = (hostname) => ({ hostname, tls: false, httpsRedirect: false, redirectTo: null });

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
  if (foreign.length > 0 || (objectVerb && !args.some(ours))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout, input);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const networkOf = async (name) => JSON.parse(await docker(["network", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();
/** stdout of nc inside an own container, or null when nc failed (refused, unreachable, unresolvable). */
const ncFrom = (container, args, input) =>
  docker(["exec", ...(input === undefined ? [] : ["-i"]), container, "nc", ...args], 20_000, input).then(
    (out) => out,
    () => null,
  );
const MEMCACHED_VERSION = "version\r\nquit\r\n";

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
const isOwn = (ref) => ours(ref) || ownIds.has(ref);
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });

/** null = the stack create body keeps every hardening property and names only this run's objects. */
function containerBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (!IMAGES.has(body.Image)) return "image";
  if (h.Privileged === true || h.CapAdd !== undefined) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !(h.SecurityOpt ?? []).includes("no-new-privileges:true")) return "hardening";
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${secretsRoot}/`) || !b.endsWith(":ro"))) return "bind";
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
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
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
    const problem = name.startsWith("hp_app_") && name.includes(marker) ? containerBodyProblem(body) : "unnamed or foreign container";
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
        gateDenied.push(`${req.method} ${req.url}: ${verdict.why}`);
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
/** GET / through the throwaway proxy with a Host header; status 0 when nothing answered. */
function viaProxy(hostname) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT.http, path: "/", method: "GET", agent: false, headers: { Host: hostname } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });
}
const served = (hostname, status, check = () => true) =>
  until(`${hostname} answers ${String(status)} through the proxy`, 20_000, async () => {
    const r = await viaProxy(hostname);
    return r.status === status && check(r.body) ? r : null;
  });

// ---- cleanup ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      for (const stackId of [A, B]) {
        await adapter
          .removeAppStack({ stackId, organizationId: ORG, removeVolumes: true })
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
    console.log(`SKIP accept-app-stack-http-cache: no Docker Engine or ${TRAEFIK_IMAGE} is not local (${err.message}); nothing was created (this script never pulls the proxy image)`);
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
  const status = (stackId, a = adapter) => a.getAppStackStatus({ stackId, organizationId: ORG });
  const healthOf = (s, key) => s.components.find((c) => c.componentKey === key)?.health;
  const waitHealthy = (stackId, keys, ms = 60_000) =>
    until(`${keys.join(",")} of ${stackId} healthy`, ms, async () => {
      const s = await status(stackId);
      return keys.every((k) => healthOf(s, k) === "healthy") ? s : null;
    });
  const startReq = (plan, componentKey) => ({ plan, componentKey, secretFileContents: [] });
  /** The API's deploy: pull each image, prepare, create, start in plan order (dependencies healthy first; dependents of a
   *  replaced component restarted when a previous revision ran), then wait until every component is healthy. */
  const deploy = async (plan, previous = null) => {
    const pulls = [];
    for (const image of new Set(plan.components.map((c) => c.image))) pulls.push(await adapter.pullAppStackImage({ plan, image }));
    const prepare = await adapter.prepareAppStack({ plan });
    const create = await adapter.createAppStackComponents({ plan });
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
      if (c.dependsOn.length > 0) await waitHealthy(plan.stackId, c.dependsOn);
      starts.push(await (again.has(c.key) ? adapter.restartAppStackComponent(startReq(plan, c.key)) : adapter.startAppStackComponent(startReq(plan, c.key))));
    }
    await waitHealthy(plan.stackId, plan.components.map((c) => c.key));
    return { pulls, prepare, create, starts };
  };
  const idsOf = async (plan) => Object.fromEntries(await Promise.all(namesOf(plan).containers.map(async (n) => [n, (await inspectOf(n)).Id])));
  const routeFile = (stackId) => path.join(ingressRoot, "dynamic", appStackRouteFileName(stackId));
  const fileState = async (file) => ({ sha: sha256(await readFile(file)), mtime: (await stat(file)).mtimeMs });
  const writesIn = (from) => gateLog.slice(from).filter((l) => /^(POST|DELETE|PUT) /.test(l));
  let S0 = null;
  let planA = null;
  let planB = null;
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
      const web = cName(A, "web");
      const hardened = { Image: image, HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, NetworkMode: ownNet } };
      const createWith = (hostConfig, extra = {}) => JSON.stringify({ ...hardened, ...extra, HostConfig: { ...hardened.HostConfig, ...hostConfig } });
      const proxyBody = (over) =>
        JSON.stringify({ Image: TRAEFIK_IMAGE, HostConfig: { NetworkMode: ingressNet, Binds: [`${tmpDir}/ingress/x:/x:ro`], ...over } });
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
        ["DELETE", `/v1.45/volumes/${appStackVolumeName(A, "data")}?force=true`, ""],
        ["POST", `/v1.45/networks/${appStackEdgeNetworkName(A)}/connect`, JSON.stringify({ Container: foreignName })],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignId })],
        ["POST", `/v1.45/networks/${foreignNet}/disconnect`, JSON.stringify({ Container: web })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(TRAEFIK_IMAGE)}`, ""],
        ["POST", "/v1.45/images/create?fromImage=memcached&tag=1.6.45-alpine3.24", ""],
        ["POST", `/v1.45/images/create?fromImage=memcached&tag=sha256:${"e".repeat(64)}`, ""],
        ["GET", "/v1.45/images/alpine:3/json", ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", "/v1.45/volumes/prune", ""],
        ["GET", "/v1.45/system/df", ""],
        ["POST", "/v1.45/build", ""],
        ["POST", `/v1.45/containers/${web}/exec`, JSON.stringify({ Cmd: ["true"] })],
        ["PUT", `/v1.45/containers/${web}/archive?path=/tmp`, ""],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({ CapAdd: ["NET_ADMIN"] })],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({ PortBindings: { "8080/tcp": [{ HostPort: "8080" }] } })],
        ["POST", `/v1.45/containers/create?name=${web}`, createWith({}, { Image: TRAEFIK_IMAGE })],
        ["POST", `/v1.45/containers/create?name=${proxyName}`, proxyBody({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${proxyName}`, proxyBody({ PortBindings: { "80/tcp": [{ HostPort: "80" }] } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Options: { "com.docker.network.bridge.name": "x" } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "site_internal")],
        ["POST", "/v1.45/networks/create", net(appStackEdgeNetworkName(A), "ingress_public")],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: appStackVolumeName(A, "data"), Driver: "local", DriverOpts: { type: "none" } })],
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

    await step("preflight", async () => {
      assert(engineVersion.length > 0, "the Docker Engine answers", engineVersion);
      assert(proxyImageId.startsWith("sha256:"), `${TRAEFIK_IMAGE} is local`, proxyImageId);
      const stale = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter(ours);
      assert(stale.length === 0, "no object name contains the run marker", stale.join(","));
      info(`engine ${engineVersion}, marker ${marker}, images ${[...IMAGES].join(" ")}`);
    });

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    const planOk = await step("plan-compiles-from-seed", async () => {
      assert(first.ok, "the http-cache seed compiles with [] parameters", JSON.stringify(first.issues));
      planA = ApprovedStackPlanSchema.parse(first.plan);
      const cache = planA.components.find((c) => c.key === "cache");
      assert(same(planA.components.map((c) => c.key), ["cache", "web"]), "components [cache, web]", planA.components.map((c) => c.key).join(","));
      assert(same(cache.argv, ["memcached", "-m", "48", "-c", "256"]), "cache argv", JSON.stringify(cache.argv));
      assert(same(planA.ingress, [{ componentKey: "web", port: 8080 }]), "ingress web:8080", JSON.stringify(planA.ingress));
      assert(planA.components.every((c) => c.secretFiles.length === 0), "no secretFiles", "some");
      const b = compile(B, [], 1);
      assert(b.ok, "the seed compiles for stack b", JSON.stringify(b.issues));
      planB = b.plan;
    });
    if (!planOk) return;
    const cacheOf = (plan) => plan.components.find((c) => c.key === "cache");
    const CACHE_PORT = String(cacheOf(planA).expose[0]);
    const route = (plan, hosts) => ({ plan, routes: [{ componentKey: plan.ingress[0].componentKey, internalPort: plan.ingress[0].port, hosts: hosts.map(hostRoute) }] });

    await step("refused-before-docker", async () => {
      const mark = gateLog.length;
      const cache = cacheOf(planA);
      const lookAlike = withComponent(planA, "cache", { image: `docker.io/library/${cache.image}` });
      const errImage = await rejection(adapter.pullAppStackImage({ plan: lookAlike, image: lookAlike.components[0].image }));
      assert(errImage?.reason === "STACK_IMAGE_NOT_ALLOWED", "look-alike image refused as STACK_IMAGE_NOT_ALLOWED", errImage ? reasonOf(errImage) : "accepted");
      const web = planA.components.find((c) => c.key === "web");
      const huge = withComponent(planA, "web", { resources: { ...web.resources, memoryBytes: "17179869185" } });
      const errMemory = await rejection(adapter.prepareAppStack({ plan: huge }));
      assert(errMemory?.reason === "STACK_PLAN_INVALID", "memory over the ceiling refused as STACK_PLAN_INVALID", errMemory ? reasonOf(errMemory) : "accepted");
      const sent = gateLog.slice(mark).filter((l) => !/^GET \/(v[\d.]+\/)?(_ping|version) /.test(l));
      assert(sent.length === 0, "refused before any Docker request (no image inspect, no pull, no create)", sent.join(" | "));
    });

    await step("deploy-creates-exact-set", async () => {
      const out = await deploy(planA);
      info(`pull: ${out.pulls.map((p) => `${p.image} pulled=${String(p.pulled)}`).join(", ")}`);
      assert(same(out.prepare.networks.map((n) => n.created), [true, true]) && out.prepare.volumes.length === 0, "two networks created, no volume", JSON.stringify(out.prepare));
      assert(out.create.components.every((c) => c.outcome === "created") && out.create.components.length === 2, "two components created", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "started"), "cache then web started", JSON.stringify(out.starts));
      const S1 = await snapshot();
      assert(same(ownNames(S1), namesOf(planA)), "own delta: exactly 2 containers, 2 networks, 0 volumes", JSON.stringify(ownNames(S1)));
      assert(removedSince(S0, S1).length === 0, "no pre-existing object removed", removedSince(S0, S1).join(","));
    });

    await step("container-hardening", async () => {
      for (const comp of planA.components) {
        const name = cName(A, comp.key);
        const c = await inspectOf(name);
        const img = JSON.parse(await docker(["image", "inspect", comp.image]))[0];
        const h = c.HostConfig;
        const labels = c.Config.Labels ?? {};
        const memory = Number(comp.resources.memoryBytes);
        const checks = {
          CapDrop: same(h.CapDrop, ["ALL"]),
          CapAdd: (h.CapAdd ?? []).length === 0,
          SecurityOpt: (h.SecurityOpt ?? []).includes("no-new-privileges:true"),
          ReadonlyRootfs: h.ReadonlyRootfs === true,
          Tmpfs: same(Object.keys(h.Tmpfs ?? {}), ["/tmp"]),
          PidsLimit: h.PidsLimit === 256,
          Memory: h.Memory === memory && h.MemorySwap === memory,
          NanoCpus: h.NanoCpus === comp.resources.cpuMilli * 1_000_000,
          LogConfig: h.LogConfig?.Type === "json-file" && h.LogConfig.Config?.["max-size"] !== undefined && h.LogConfig.Config?.["max-file"] !== undefined,
          NoPorts: Object.keys(h.PortBindings ?? {}).length === 0,
          NoMounts: (h.Binds ?? []).length === 0 && (c.Mounts ?? []).length === 0,
          Privileged: h.Privileged === false,
          Image: c.Config.Image === comp.image && c.Image === img.Id,
          Entrypoint: same(c.Config.Entrypoint ?? null, img.Config.Entrypoint ?? null),
          Labels: labels["io.hostingpanel.managed"] === "true" && labels["io.hostingpanel.role"] === "app_component" && labels["io.hostingpanel.stack_id"] === A,
          NoSiteLabels: labels["io.hostingpanel.site_id"] === undefined && labels["io.hostingpanel.service_instance_id"] === undefined,
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `${name} carries the designed hardening`, bad.join(","));
        const uids = (await docker(["top", name, "-o", "pid,uid"])).split("\n").slice(1).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
        assert(uids.length > 0 && !uids.includes("0"), `${name} runs no process as root`, uids.join(","));
      }
    });

    await step("health-and-dns", async () => {
      await waitHealthy(A, ["cache", "web"]);
      const answer = await ncFrom(cName(A, "web"), ["-w", "3", "cache", CACHE_PORT], MEMCACHED_VERSION);
      assert(answer?.includes("VERSION ") === true, "web reaches the cache by its component name", JSON.stringify(answer));
      const names = namesOf(planA).containers;
      for (const l of await lines(["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}", ...names])) info(`stats ${l}`);
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
      assert(same(await nets("cache"), [appStackInternalNetworkName(A)]), "cache is on the private network only", (await nets("cache")).join(","));
      assert(same(await nets("web"), namesOf(planA).networks), "web is on the private and the edge network", (await nets("web")).join(","));
      for (const c of namesOf(planA).containers) {
        const off = (await nets(c.slice(`hp_app_${A}_`.length))).filter((n) => !n.includes(marker));
        assert(off.length === 0, `${c} is on no network of another owner`, off.join(","));
      }
    });

    await step("no-control-plane-reach", async () => {
      const web = cName(A, "web");
      const gateways = [];
      for (const n of Object.keys((await inspectOf(web)).NetworkSettings.Networks)) {
        const gw = (await networkOf(n)).IPAM?.Config?.[0]?.Gateway;
        if (gw) gateways.push(gw);
      }
      assert(gateways.length > 0, "web has at least one network gateway to probe", "none");
      const control = await ncFrom(web, ["-z", "-w", "2", "cache", CACHE_PORT]);
      assert(control !== null, "control: nc -z reaches the own cache (so a refusal below is a real one)", "failed");
      for (const gw of gateways) {
        for (const port of ["5432", "3306", "4000"]) {
          assert((await ncFrom(web, ["-z", "-w", "2", gw, port])) === null, `web cannot reach ${gw}:${port}`, "connected");
        }
        info(`web -> ${gw}:3000 ${(await ncFrom(web, ["-z", "-w", "2", gw, "3000"])) === null ? "refused" : "reachable (known limit T15)"}`);
      }
      for (const name of namesOf(planA).containers) {
        const c = await inspectOf(name);
        assert(!JSON.stringify(c.Mounts ?? []).includes("docker.sock"), `${name} mounts no Docker socket`, JSON.stringify(c.Mounts));
        assert(!(c.Config.Env ?? []).some((e) => e.startsWith("DOCKER_HOST=")), `${name} has no DOCKER_HOST`, "present");
      }
    });

    await step("no-cross-stack", async () => {
      await deploy(planB);
      const bWeb = cName(B, "web");
      const aCacheIp = (await inspectOf(cName(A, "cache"))).NetworkSettings.Networks[appStackInternalNetworkName(A)].IPAddress;
      for (const target of [aCacheIp, cName(A, "cache")]) {
        const got = await ncFrom(bWeb, ["-w", "3", target, CACHE_PORT], MEMCACHED_VERSION);
        assert(got?.includes("VERSION") !== true, `stack b cannot reach ${target}`, JSON.stringify(got));
      }
      const own = await ncFrom(bWeb, ["-w", "3", "cache", CACHE_PORT], MEMCACHED_VERSION);
      assert(own?.includes("VERSION ") === true, "control: stack b reaches its own cache", JSON.stringify(own));
      const aNets = namesOf(planA).networks;
      for (const name of namesOf(planB).containers) {
        const on = Object.keys((await inspectOf(name)).NetworkSettings.Networks).filter((n) => aNets.includes(n));
        assert(on.length === 0, `${name} is on no network of stack a`, on.join(","));
      }
      await adapter.removeAppStack({ stackId: B, organizationId: ORG, removeVolumes: true });
      const left = ownNames(await snapshot(), B);
      assert(same(left, { containers: [], networks: [], volumes: [] }), "stack b is gone completely", JSON.stringify(left));
    });

    await step("route-published-after-health", async () => {
      await adapter.ensureIngressProxy();
      const bindings = Object.values((await inspectOf(proxyName)).HostConfig.PortBindings ?? {}).flat();
      assert(
        bindings.length === 2 && bindings.every((b) => b.HostIp === HOST && [String(PORT.http), String(PORT.https)].includes(b.HostPort)),
        "the throwaway proxy listens on loopback test ports only",
        JSON.stringify(bindings),
      );
      const file = routeFile(A);
      assert(!(await exists(file)), "no route file before the publish", "present");
      assert(healthOf(await status(A), "web") === "healthy", "web is healthy before its route is published", "not healthy");
      const r = await adapter.publishAppStackRoutes(route(planA, [HOST1]));
      assert(r.changed === true && same(r.hostnames, [HOST1]), "the publish wrote one host", JSON.stringify(r));
      const text = await readFile(file, "utf8");
      const hosts = [...text.matchAll(/Host\(`([^`]+)`\)/g)].map((x) => x[1]);
      assert(same(hosts, [HOST1]), `${appStackRouteFileName(A)} routes ${HOST1} only`, hosts.join(","));
      await served(HOST1, 200, (body) => body.includes("Welcome to nginx!"));
      const before = await fileState(file);
      const again = await adapter.publishAppStackRoutes(route(planA, [HOST1]));
      assert(again.changed === false && same(await fileState(file), before), "publishing the same set keeps the file's sha256 and mtime", JSON.stringify(again));
      const files = (await treeDigest(ingressRoot)).map((l) => l.split(" ")[0]);
      const siteFiles = files.filter((f) => /(^|\/)site_[^/]*\.yml$/.test(f));
      assert(siteFiles.length === 0, "no site_*.yml in the temp ingress root", siteFiles.join(","));
    });

    await step("route-change-no-proxy-recreate", async () => {
      const p0 = await inspectOf(proxyName);
      const mark = gateLog.length;
      await adapter.publishAppStackRoutes(route(planA, [HOST1, HOST2]));
      await served(HOST2, 200);
      await adapter.publishAppStackRoutes(route(planA, [HOST1]));
      await served(HOST2, 404);
      await served(HOST1, 200);
      const p1 = await inspectOf(proxyName);
      assert(p1.Id === p0.Id && p1.State.StartedAt === p0.State.StartedAt, "the proxy keeps its Id and StartedAt", `${p1.Id === p0.Id} ${p1.State.StartedAt}`);
      const creates = gateLog.slice(mark).filter((l) => l.includes("/containers/create"));
      assert(creates.length === 0, "no container create during the route changes", creates.join(" | "));
    });

    await step("health-reports-unhealthy", async () => {
      const cache = cName(A, "cache");
      const stopped = await viaGate("POST", `/v1.45/containers/${cache}/stop?t=10`);
      assert(stopped.status === 204, "the cache stops", String(stopped.status));
      let sawHealthy = false;
      await until("cache reported not healthy", 30_000, async () => {
        const h = healthOf(await status(A), "cache");
        if (h === "healthy") sawHealthy = true;
        return h !== undefined && h !== "healthy";
      });
      assert(!sawHealthy, "a stopped cache is never reported healthy", "healthy");
      const back = await adapter.startAppStackComponent(startReq(planA, "cache"));
      assert(back.outcome === "started", "startAppStackComponent starts the cache again", JSON.stringify(back));
      await waitHealthy(A, ["cache"]);
      // Stop and start of the whole stack, as the customer's stop and start would.
      const stop = await adapter.stopAppStack({ stackId: A, organizationId: ORG });
      assert(same(stop.components.map((c) => `${c.componentKey}:${c.outcome}`), ["web:stopped", "cache:stopped"]), "stop: web, then cache", JSON.stringify(stop));
      const s = await status(A);
      assert(["cache", "web"].every((k) => healthOf(s, k) === "stopped"), "both reported stopped", JSON.stringify(s.components));
      for (const c of planA.components) {
        if (c.dependsOn.length > 0) await waitHealthy(A, c.dependsOn);
        await adapter.startAppStackComponent(startReq(planA, c.key));
      }
      await waitHealthy(A, ["cache", "web"]);
      await served(HOST1, 200);
    });

    await step("idempotent-reapply", async () => {
      const own0 = ownNames(await snapshot());
      const ids0 = await idsOf(planA);
      const mark = gateLog.length;
      const out = await deploy(planA, planA);
      assert(out.pulls.every((p) => p.pulled === false), "pulled false", JSON.stringify(out.pulls));
      assert(out.prepare.networks.every((n) => n.created === false), "networks created false", JSON.stringify(out.prepare));
      assert(out.create.components.every((c) => c.outcome === "unchanged") && out.create.removedComponents.length === 0, "all unchanged", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "already_running"), "already_running x2", JSON.stringify(out.starts));
      assert(same(ownNames(await snapshot()), own0) && same(await idsOf(planA), ids0), "same own objects and container ids", "changed");
      assert(writesIn(mark).length === 0, "the re-apply sent no mutating request", writesIn(mark).join(" | "));
    });

    await step("upgrade-changes-only-changed-component", async () => {
      const next = compile(A, [{ key: "cache_memory_mb", value: 64 }], 2);
      assert(next.ok, "revision 2 compiles", JSON.stringify(next.issues));
      const ids0 = await idsOf(planA);
      const file0 = await fileState(routeFile(A));
      const out = await deploy(next.plan, planA);
      planA = next.plan;
      const outcomes = out.create.components.map((c) => `${c.componentKey}:${c.outcome}`);
      assert(same(outcomes, ["cache:replaced", "web:unchanged"]), "only the cache is replaced", outcomes.join(","));
      const ids1 = await idsOf(planA);
      const [cache, web] = namesOf(planA).containers;
      assert(ids1[cache] !== ids0[cache] && ids1[web] === ids0[web], "cache Id changes, web Id stays", JSON.stringify({ ids0, ids1 }));
      assert(same(await fileState(routeFile(A)), file0), "the route file is unchanged", "changed");
      const cmd = (await inspectOf(cache)).Config.Cmd;
      assert(same(cmd, ["memcached", "-m", "64", "-c", "256"]), "the new cache runs with 64 MB", JSON.stringify(cmd));
      await served(HOST1, 200);
    });

    await step("recovery-reads-only", async () => {
      const fresh = new DockerEngineSocketAdapter(adapterOptions);
      const mark = gateLog.length;
      const s = await status(A, fresh);
      assert(same(s.components.map((c) => c.componentKey), ["cache", "web"]), "a fresh adapter reports both components", JSON.stringify(s.components));
      const other = gateLog.slice(mark).filter((l) => !l.startsWith("GET "));
      assert(gateLog.length > mark && other.length === 0, "the recovery read sends GET requests only", other.join(" | "));
    });

    await step("remove-leaves-no-orphans", async () => {
      const unpublished = await adapter.unpublishAppStackRoutes({ stackId: A, organizationId: ORG });
      assert(unpublished.changed === true, "the route file is withdrawn", JSON.stringify(unpublished));
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: false });
      assert(same(r.removedComponents, ["web", "cache"]) && r.retainedVolumes.length === 0, "web and cache removed, no volume to keep", JSON.stringify(r));
      assert(!(await exists(routeFile(A))), `${appStackRouteFileName(A)} is gone`, "present");
      const left = ownNames(await snapshot());
      assert(same(left, { containers: [proxyName], networks: [ingressNet], volumes: [] }), "only the throwaway proxy and its network are left", JSON.stringify(left));
      const proxyGone = await viaGate("DELETE", `/v1.45/containers/${proxyName}?force=true&v=true`);
      const netGone = await viaGate("DELETE", `/v1.45/networks/${ingressNet}`);
      assert(proxyGone.status === 204 && netGone.status === 204, "the script removes the proxy and its network by exact name", `${proxyGone.status} ${netGone.status}`);
      const S2 = await snapshot();
      assert(same(ownNames(S2), { containers: [], networks: [], volumes: [] }), "zero own objects left", JSON.stringify(ownNames(S2)));
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
