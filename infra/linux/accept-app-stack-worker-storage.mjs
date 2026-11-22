#!/usr/bin/env node
/**
 * Real-Docker acceptance of the built-in «worker + storage» application (HCP-SPEC-005 §19, ADR-0035) through the
 * PRODUCTION DockerEngineSocketAdapter from apps/docker-executor/dist, called step by step as the API would: plan
 * refusals before any Docker request (A12, A13), a stack with no ingress at all (no edge network, no route file),
 * hardening and the forced image user, a worker that writes to the storage component over the private network (A9),
 * the private-network shape (A11), a secret delivered only as a read-only tmpfs file (A8), idempotent re-apply (A16),
 * data that survives an upgrade, a rollback and a restart (A19), consistent pull, network and health failures (B5),
 * read-only recovery (A17), removal that keeps the data (A18) and then removal with the data.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a…e, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_stk_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created), the create bodies keep the hardening, no request carries the run's secret, and a pull
 *    names the seed digest of the template; list answers are filtered to this run's objects. The first step proves that
 *    it denies foreign and unsafe requests. The script's own changes (cleanup) go through the same gate.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_stk_<hex>-secrets or a
 *    nonexistent own *_unused name. No proxy is created, nothing is published, no network is attached to another.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/exec/top/stats only ever name this run's objects.
 *  - Images: the digest-pinned ref of the worker-storage seed in APP_BUILT_IN_TEMPLATES, pulled by the product through
 *    the gate when missing (offline run: docker pull <repository>@sha256:<digest> first).
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true) for every stack,
 *    then leftovers by exact own names through the gate, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-stack-worker-storage.mjs
 * Steps: gate-self-test, preflight, snapshot-before, plan-compiles-from-seed, refused-before-docker,
 * deploy-creates-exact-set, container-hardening, worker-writes-storage, network-shape, secrets-only-as-files,
 * idempotent-reapply, data-survives-upgrade-and-rollback, pull-failure-consistent, network-failure-consistent,
 * health-timeout-consistent, recovery-reads-only, remove-keeps-volumes, destroy-data-removes-volume,
 * host-nft-metadata-drop-on-stack-net (root only: HP_ACCEPT_ROOT_CASES=1 as root), gate-clean, nothing-left.
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
const { DockerEngineSocketAdapter, appStackContainerName, appStackEdgeNetworkName, appStackInternalNetworkName, appStackRouteFileName, appStackSecretDirKey, appStackVolumeName } =
  executor;
const { compileAppStackPlan } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema } = contracts;
const { computeAppStackPlanHash } = domain;

const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
const TMPFS_MAGIC = 0x01021994;
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_stk_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((s) => `stk_swarmtest_${hex}_${s}`);
const SECRET = randomBytes(16).toString("hex"); // hex: can never form an hp_ token
const secretFileContents = [{ parameterKey: "storage_key", version: 1, content: SECRET }];
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- plans (the seed, the default allowlist; variants by one exact replace each) ----
const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "worker-storage");
const INTERVAL = (seconds) => [{ key: "worker_interval_seconds", value: seconds }];
function variant(pairs) {
  let source = seed.source;
  for (const [from, to] of pairs) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`variant: ${JSON.stringify(from.slice(0, 40))} occurs ${String(count)} times`);
    source = source.replace(from, to);
  }
  return source;
}
const compile = (stackId, parameters, n, source = seed.source, secretVersions = new Map()) =>
  compileAppStackPlan({
    source,
    parameters,
    secretVersions,
    ids: {
      stackId,
      organizationId: ORG,
      hostAllocationId: `alloc_swarmtest_${hex}`,
      templateVersionId: seed.versionId,
      revisionId: `srev_swarmtest_${hex}_${String(n)}`,
    },
  });
const first = compile(A, INTERVAL(5), 1);
const SEED_IMAGE = first.ok ? first.plan.components[0].image : "none";
/** The B5 ref: the allowlisted repository with a digest no registry serves. */
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const FAKE_DIGEST = `@sha256:${"e".repeat(64)}`;
const FAKE_IMAGE = SEED_IMAGE.replace(DIGEST, FAKE_DIGEST);
/** The only images the gate inspects; only SEED_IMAGE is ever pulled, FAKE_IMAGE answers a failed pull. */
const IMAGES = new Set([SEED_IMAGE, FAKE_IMAGE]);
const FAKE_PULL = '{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n';
/** The storage image as the source writes it (with its tag; the plan keeps only repository@digest). */
const STORAGE_REF = seed.source.match(/ {2}storage:\n {4}image: (\S+)\n/)?.[1] ?? "none";
const storageLine = (image) => `  storage:\n    image: ${image}\n`;
const SECRET_SOURCE = () =>
  variant([
    ["    customer: true\nservices:\n", "    customer: true\n  - key: storage_key\n    label: Storage key\n    type: secret\n    required: true\n    customer: true\nservices:\n"],
    ["    depends_on:\n      - storage\n", "    depends_on:\n      - storage\n    environment:\n      - name: STORAGE_KEY_FILE\n        secret: storage_key\n"],
  ]);
const HEALTH_6380_SOURCE = () =>
  variant([["      - 6379\n    healthcheck:\n      kind: tcp\n      port: 6379\n", "      - 6379\n      - 6380\n    healthcheck:\n      kind: tcp\n      port: 6380\n"]]);
const rehash = (plan) => ({ ...plan, planHash: computeAppStackPlanHash(plan) });
const withComponent = (plan, key, over) => rehash({ ...plan, components: plan.components.map((c) => (c.key === key ? { ...c, ...over } : c)) });
const namesOf = (plan) => ({
  containers: plan.components.map((c) => appStackContainerName(plan.stackId, c.key)).sort(),
  networks: [appStackInternalNetworkName(plan.stackId), ...(plan.ingress.length > 0 ? [appStackEdgeNetworkName(plan.stackId)] : [])].sort(),
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const NONE = { containers: [], networks: [], volumes: [] };
const cName = appStackContainerName;

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);
/** How many 8-character windows of the secret occur in a text (0 = no part of it leaked). */
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
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
const volumeOf = async (name) => JSON.parse(await docker(["volume", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();
/** The counter the worker increments, read inside the storage component (null when unset or unreadable). */
const ticks = async (stackId) => {
  const out = (await docker(["exec", cName(stackId, "storage"), "valkey-cli", "GET", "worker:ticks"], 20_000).catch(() => "")).trim();
  return /^[0-9]+$/.test(out) ? Number(out) : null;
};

let ingressRoot = null;
async function files(dir) {
  const out = [];
  for (const f of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (f.isFile()) out.push(path.relative(dir, path.join(f.parentPath, f.name)));
  }
  return out.sort();
}
const snapshot = async () => ({
  containers: await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]),
  networks: await lines(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"]),
  volumes: await lines(["volume", "ls", "--format", "{{.Name}}"]),
  certs: await files(ingressRoot),
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
/** "network": the next own network create or connect answers an injected 500 once (B5). */
let faultOnce = null;
const isOwn = (ref) => ours(ref) || ownIds.has(ref);
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });
const fake = (status, body, kind = "fake") => ({ kind, status, body });

/** null = the stack create body keeps every hardening property and names only this run's objects. */
function containerBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (body.Image !== SEED_IMAGE) return "image";
  if (h.Privileged === true || h.CapAdd !== undefined) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !(h.SecurityOpt ?? []).includes("no-new-privileges:true")) return "hardening";
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${secretsRoot}/`) || !b.endsWith(":ro"))) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  if (Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker))) return "endpoint";
  return null;
}

/** Default deny: "forward" (optionally registering the created id or filtering a list), a canned answer, or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const query = decodeURIComponent(u.search);
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t));
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  if (leakedWindows(`${p}?${query}\n${bodyText}`, SECRET) > 0) return deny("secret in request");
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) ? fwd() : deny("image");
  if (method === "POST" && p === "/images/create") {
    const from = u.searchParams.get("fromImage") ?? "";
    const tag = u.searchParams.get("tag") ?? "";
    const ref = tag === "" ? from : tag.startsWith("sha256:") ? `${from}@${tag}` : null;
    if (ref === FAKE_IMAGE) return fake(200, FAKE_PULL);
    return ref === SEED_IMAGE ? fwd() : deny("image pull");
  }
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p });
  if (faultOnce === "network" && method === "POST" && (p === "/networks/create" || /^\/networks\/[^/]+\/connect$/.test(p))) {
    faultOnce = null;
    return fake(500, '{"message":"injected fault"}', "FAULT");
  }
  if (method === "POST" && p === "/networks/create") {
    const ok =
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.IPAM === undefined &&
      String(body.Name).includes(marker) &&
      ["app_internal", "app_edge"].includes(body.Labels?.[ROLE_LABEL]);
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
  if (method === "POST" && (m = p.match(/^\/networks\/([^/]+)\/(?:connect|disconnect)$/))) {
    return isOwn(m[1]) && isOwn(String(body.Container ?? "")) ? fwd() : deny("network attach of a foreign object");
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
      if (verdict.kind !== "forward") {
        res.writeHead(verdict.status, { "content-type": "application/json" });
        res.end(verdict.body);
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

// ---- cleanup ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      for (const stackId of [A, B, C, D, E]) {
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
  try {
    engineVersion = (await docker(["version", "--format", "{{.Server.Version}}"])).trim();
  } catch (err) {
    console.log(`SKIP accept-app-stack-worker-storage: no Docker Engine (${err.message}); nothing was created`);
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
  const status = (stackId, a = adapter) => a.getAppStackStatus({ stackId, organizationId: ORG });
  const healthOf = (s, key) => s.components.find((c) => c.componentKey === key)?.health;
  const waitHealthy = (stackId, keys, ms = 60_000) =>
    until(`${keys.join(",")} of ${stackId} healthy`, ms, async () => {
      const s = await status(stackId);
      return keys.every((k) => healthOf(s, k) === "healthy") ? s : null;
    });
  const startReq = (plan, componentKey, contents = []) => ({ plan, componentKey, secretFileContents: contents });
  /** The API's deploy: pull each image, prepare, create, start in plan order (dependencies healthy first; dependents of a
   *  replaced component restarted when a previous revision ran), then wait until every component is healthy. */
  const deploy = async (plan, previous = null, contents = []) => {
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
      const req = startReq(plan, c.key, contents);
      starts.push(await (again.has(c.key) ? adapter.restartAppStackComponent(req) : adapter.startAppStackComponent(req)));
    }
    await waitHealthy(plan.stackId, plan.components.map((c) => c.key));
    return { pulls, prepare, create, starts };
  };
  const idsOf = async (plan) => Object.fromEntries(await Promise.all(namesOf(plan).containers.map(async (n) => [n, (await inspectOf(n)).Id])));
  const writesIn = (from) => gateLog.slice(from).filter((l) => /^(POST|DELETE|PUT) /.test(l));
  const volumeDeletesIn = (from) => gateLog.slice(from).filter((l) => /^DELETE \/(v[\d.]+\/)?volumes\//.test(l));
  const gone = async (stackId, what) => {
    const left = ownNames(await snapshot(), stackId);
    assert(same(left, NONE), `${what}: no object of ${stackId} is left`, JSON.stringify(left));
  };
  let S0 = null;
  let planA = null;
  let v0 = null;
  const dataVolume = () => appStackVolumeName(A, "data");
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
      const ownNet = appStackInternalNetworkName(A);
      const storage = cName(A, "storage");
      const hardened = { Image: SEED_IMAGE, HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, NetworkMode: ownNet } };
      const createWith = (hostConfig, extra = {}) => JSON.stringify({ ...hardened, ...extra, HostConfig: { ...hardened.HostConfig, ...hostConfig } });
      const net = (name, role, extra = {}) => JSON.stringify({ Name: name, Driver: "bridge", Labels: { [ROLE_LABEL]: role }, ...extra });
      const [repo] = SEED_IMAGE.split("@");
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
        ["DELETE", `/v1.45/volumes/${dataVolume()}?force=true`, ""],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignName })],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignId })],
        ["POST", `/v1.45/networks/${foreignNet}/connect`, JSON.stringify({ Container: storage })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=9.2.0-alpine3.24`, ""],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(repo)}&tag=sha256:${"d".repeat(64)}`, ""],
        ["POST", "/v1.45/images/create?fromImage=traefik&tag=v3.7", ""],
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
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({ PortBindings: { "6379/tcp": [{ HostPort: "6379" }] } })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({}, { Image: FAKE_IMAGE })],
        ["POST", `/v1.45/containers/create?name=${storage}`, createWith({}, { Env: [`K=${SECRET}`] })],
        ["POST", "/v1.45/networks/create", net(ownNet, "app_internal", { Options: { "com.docker.network.bridge.name": "x" } })],
        ["POST", "/v1.45/networks/create", net(ownNet, "site_internal")],
        ["POST", "/v1.45/networks/create", net(`${runPrefix}_ingress`, "ingress_public")],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: dataVolume(), Driver: "local", DriverOpts: { type: "none" } })],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url]) => `${method} ${url}`).join(" | "));
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
      const stale = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter(ours);
      assert(stale.length === 0, "no object name contains the run marker", stale.join(","));
      info(`engine ${engineVersion}, marker ${marker}, image ${SEED_IMAGE}`);
    });

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    const planOk = await step("plan-compiles-from-seed", async () => {
      assert(first.ok, "the worker-storage seed compiles with worker_interval_seconds 5", JSON.stringify(first.issues));
      planA = ApprovedStackPlanSchema.parse(first.plan);
      const [storage, worker] = planA.components;
      assert(same(planA.components.map((c) => c.key), ["storage", "worker"]), "components [storage, worker]", planA.components.map((c) => c.key).join(","));
      assert(planA.components.every((c) => c.runAsUser === "999:1000"), "both run as 999:1000", planA.components.map((c) => c.runAsUser).join(","));
      assert(same(storage.volumes, [{ volumeKey: "data", containerPath: "/data", readOnly: false }]), "storage mounts data:/data rw", JSON.stringify(storage.volumes));
      assert(worker.volumes.length === 0 && planA.ingress.length === 0, "the worker mounts nothing, no ingress", JSON.stringify(planA.ingress));
      assert(worker.argv.includes("5"), "the worker argv holds the interval 5", JSON.stringify(worker.argv));
      assert(planA.components.every((c) => c.secretFiles.length === 0), "no secretFiles", "some");
    });
    if (!planOk) return;

    await step("refused-before-docker", async () => {
      const mark = gateLog.length;
      const noUser = withComponent(planA, "storage", { runAsUser: null });
      const errUser = await rejection(adapter.pullAppStackImage({ plan: noUser, image: SEED_IMAGE }));
      assert(
        errUser?.reason === "STACK_IMAGE_NOT_ALLOWED" && String(errUser.message).includes("user_mismatch"),
        "storage without the forced user refused as STACK_IMAGE_NOT_ALLOWED (user_mismatch)",
        errUser ? `${reasonOf(errUser)} ${errUser.message}` : "accepted",
      );
      const worker = planA.components.find((c) => c.key === "worker");
      const shell = withComponent(planA, "worker", { argv: ["sh", ...worker.argv.slice(1)] });
      const errShell = await rejection(adapter.prepareAppStack({ plan: shell }));
      assert(errShell?.reason === "STACK_PLAN_INVALID", "a shell as argv[0] refused as STACK_PLAN_INVALID", errShell ? reasonOf(errShell) : "accepted");
      const sent = gateLog.slice(mark).filter((l) => !/^GET \/(v[\d.]+\/)?(_ping|version) /.test(l));
      assert(sent.length === 0, "refused before any Docker request (no image inspect, no pull, no create)", sent.join(" | "));
    });

    await step("deploy-creates-exact-set", async () => {
      const local = (await docker(["image", "inspect", "--format", "{{.Id}}", SEED_IMAGE]).catch(() => "")).trim() !== "";
      const mark = gateLog.length;
      const out = await deploy(planA);
      info(`pull: ${out.pulls.map((p) => `${p.image} pulled=${String(p.pulled)}`).join(", ")}`);
      const pulls = gateLog.slice(mark).filter((l) => l.includes("/images/create"));
      assert(!local || pulls.length === 0, "no image pull when the seed image is already local", pulls.join(" | "));
      assert(
        same(out.prepare.networks, [{ role: "app_internal", created: true }]) && same(out.prepare.volumes, [{ volumeKey: "data", created: true }]),
        "one private network and one volume created, no edge network",
        JSON.stringify(out.prepare),
      );
      assert(same(out.create.components.map((c) => `${c.componentKey}:${c.outcome}`), ["storage:created", "worker:created"]), "two components created", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "started"), "storage then worker started", JSON.stringify(out.starts));
      const S1 = await snapshot();
      assert(same(ownNames(S1), namesOf(planA)), "own delta: exactly 2 containers, 1 network, 1 volume", JSON.stringify(ownNames(S1)));
      assert(!S1.networks.some((l) => l.endsWith(` ${appStackEdgeNetworkName(A)}`)), "no edge network", "present");
      assert(removedSince(S0, S1).length === 0, "no pre-existing object removed", removedSince(S0, S1).join(","));
      const s = await status(A);
      assert(s.networks.edge === false && s.routes.published === false, "status: no edge network, no route", JSON.stringify({ n: s.networks, r: s.routes }));
      assert(S1.certs.length === 0 && !(await exists(path.join(ingressRoot, "dynamic", appStackRouteFileName(A)))), "no route file", S1.certs.join(","));
      const labels = (await volumeOf(dataVolume())).Labels ?? {};
      assert(labels["io.hostingpanel.stack_id"] === A && labels["io.hostingpanel.app_volume_key"] === "data", "the data volume carries the stack id", JSON.stringify(labels));
    });

    await step("container-hardening", async () => {
      const img = JSON.parse(await docker(["image", "inspect", SEED_IMAGE]))[0];
      for (const comp of planA.components) {
        const name = cName(A, comp.key);
        const c = await inspectOf(name);
        const h = c.HostConfig;
        const labels = c.Config.Labels ?? {};
        const memory = Number(comp.resources.memoryBytes);
        const mounts = (c.Mounts ?? []).map((mt) => `${mt.Type}:${mt.Name}:${mt.Destination}:${String(mt.RW)}`);
        const wantMounts = comp.key === "storage" ? [`volume:${dataVolume()}:/data:true`] : [];
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
          NoBinds: (h.Binds ?? []).length === 0,
          Mounts: same(mounts, wantMounts),
          Privileged: h.Privileged === false,
          User: c.Config.User === "999:1000",
          Image: c.Config.Image === comp.image && c.Image === img.Id,
          Entrypoint: same(c.Config.Entrypoint ?? null, img.Config.Entrypoint ?? null),
          Labels: labels["io.hostingpanel.managed"] === "true" && labels["io.hostingpanel.role"] === "app_component" && labels["io.hostingpanel.stack_id"] === A,
          NoSiteLabels: labels["io.hostingpanel.site_id"] === undefined && labels["io.hostingpanel.service_instance_id"] === undefined,
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `${name} carries the designed hardening`, `${bad.join(",")} ${JSON.stringify(mounts)}`);
        const uids = (await docker(["top", name, "-o", "pid,uid"])).split("\n").slice(1).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
        assert(uids.length > 0 && !uids.includes("0"), `${name} runs no process as root`, uids.join(","));
      }
    });

    await step("worker-writes-storage", async () => {
      const c1 = await until("the worker counter reaches 1", 30_000, async () => {
        const n = await ticks(A);
        return n !== null && n >= 1 ? n : null;
      });
      await sleep(6_000);
      const c2 = await ticks(A);
      assert(c2 !== null && c2 > c1, "the counter grows between two reads 6 s apart", `${String(c1)} -> ${String(c2)}`);
      info(`worker:ticks ${String(c1)} -> ${String(c2)}`);
      for (const l of await lines(["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}", ...namesOf(planA).containers])) info(`stats ${l}`);
    });

    await step("network-shape", async () => {
      const name = appStackInternalNetworkName(A);
      const n = await networkOf(name);
      assert(
        n.Driver === "bridge" && n.Internal === true && Object.keys(n.Options ?? {}).length === 0 && n.Labels?.[ROLE_LABEL] === "app_internal",
        `${name}: plain bridge, Internal true, no Options, role app_internal`,
        JSON.stringify({ d: n.Driver, i: n.Internal, o: n.Options, r: n.Labels?.[ROLE_LABEL] }),
      );
      const bridge = `br-${n.Id.slice(0, 12)}`;
      assert(await exists(`/sys/class/net/${bridge}`), `host interface ${bridge} exists (matches iifname "br-*")`, "absent");
      bridges.push(bridge);
      for (const c of namesOf(planA).containers) {
        const nets = Object.keys((await inspectOf(c)).NetworkSettings.Networks).sort();
        assert(same(nets, [name]), `${c} is on the private network only`, nets.join(","));
      }
    });

    await step("secrets-only-as-files", async () => {
      const compiled = compile(B, INTERVAL(5), 1, SECRET_SOURCE(), new Map([["storage_key", 1]]));
      assert(compiled.ok, "the secret variant compiles", JSON.stringify(compiled.issues));
      const planB = compiled.plan;
      const files0 = planB.components.find((c) => c.key === "worker").secretFiles;
      assert(same(files0, [{ envName: "STORAGE_KEY_FILE", parameterKey: "storage_key", version: 1 }]), "the worker gets one secret file", JSON.stringify(files0));
      assert(leakedWindows(JSON.stringify(planB), SECRET) === 0, "the plan holds no part of the secret", "found");
      const results = await deploy(planB, null, secretFileContents);
      const w = await inspectOf(cName(B, "worker"));
      assert((w.Config.Env ?? []).includes("STORAGE_KEY_FILE=/run/secrets/storage_key"), "Env holds only the file path", JSON.stringify(w.Config.Env));
      for (const name of namesOf(planB).containers) {
        assert(leakedWindows(JSON.stringify(await inspectOf(name)), SECRET) === 0, `no window of the secret in the inspect JSON of ${name}`, "found");
      }
      const bind = `${path.join(secretsRoot, appStackSecretDirKey(B, "worker"), "storage_key")}:/run/secrets/storage_key:ro`;
      assert(same(w.HostConfig.Binds, [bind]), "exactly one read-only secret file bind", JSON.stringify(w.HostConfig.Binds));
      const fsType = (await statfs(secretsRoot)).type;
      assert(fsType === TMPFS_MAGIC, "the secrets root is on tmpfs", fsType.toString(16));
      const read = await docker(["exec", cName(B, "worker"), "cat", "/run/secrets/storage_key"]);
      assert(read.trim() === SECRET, "the worker reads the secret from its file", "other content");
      assert(leakedWindows(JSON.stringify(results), SECRET) === 0, "no adapter result holds the secret", "found");
      await adapter.removeAppStack({ stackId: B, organizationId: ORG, removeVolumes: true });
      await gone(B, "removed with its data");
      assert(!(await exists(path.join(secretsRoot, appStackSecretDirKey(B, "worker")))), "the secret dir of the stack is gone", "present");
    });

    await step("idempotent-reapply", async () => {
      const own0 = ownNames(await snapshot());
      const ids0 = await idsOf(planA);
      const mark = gateLog.length;
      const out = await deploy(planA, planA);
      assert(out.pulls.every((p) => p.pulled === false), "pulled false", JSON.stringify(out.pulls));
      assert(out.prepare.networks.every((n) => n.created === false) && out.prepare.volumes.every((v) => v.created === false), "network and volume created false", JSON.stringify(out.prepare));
      assert(out.create.components.every((c) => c.outcome === "unchanged") && out.create.removedComponents.length === 0, "all unchanged", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "already_running"), "already_running x2", JSON.stringify(out.starts));
      assert(same(ownNames(await snapshot()), own0) && same(await idsOf(planA), ids0), "same own objects and container ids", "changed");
      assert(writesIn(mark).length === 0, "the re-apply sent no mutating request", writesIn(mark).join(" | "));
    });

    await step("data-survives-upgrade-and-rollback", async () => {
      const [storage, worker] = namesOf(planA).containers;
      const c0 = await ticks(A);
      assert(c0 !== null && c0 >= 1, "a counter to keep", String(c0));
      v0 = (await volumeOf(dataVolume())).CreatedAt;
      const mark = gateLog.length;
      const ids0 = await idsOf(planA);
      const next = compile(A, INTERVAL(6), 2);
      assert(next.ok, "revision 2 compiles", JSON.stringify(next.issues));
      const up = await deploy(next.plan, planA);
      assert(same(up.create.components.map((c) => `${c.componentKey}:${c.outcome}`), ["storage:unchanged", "worker:replaced"]), "upgrade replaces only the worker", JSON.stringify(up.create));
      const ids1 = await idsOf(planA);
      assert(ids1[worker] !== ids0[worker] && ids1[storage] === ids0[storage], "worker Id changes, storage Id stays", JSON.stringify({ ids0, ids1 }));
      assert((await inspectOf(worker)).Config.Cmd.includes("6"), "the new worker runs every 6 s", "other argv");
      const back = await deploy(planA, next.plan);
      assert(same(back.create.components.map((c) => `${c.componentKey}:${c.outcome}`), ["storage:unchanged", "worker:replaced"]), "rollback recreates only the worker", JSON.stringify(back.create));
      const ids2 = await idsOf(planA);
      assert(ids2[worker] !== ids1[worker] && ids2[storage] === ids0[storage], "worker recreated, storage unchanged", JSON.stringify({ ids1, ids2 }));
      const restarted = await adapter.restartAppStackComponent(startReq(planA, "storage"));
      assert(restarted.outcome === "restarted", "the adapter restarts the storage", JSON.stringify(restarted));
      await waitHealthy(A, ["storage", "worker"]);
      const c1 = await until("the counter is readable after the restart", 30_000, () => ticks(A));
      assert(c1 >= c0, "the counter survived upgrade, rollback and restart (append-only file on the volume)", `${String(c0)} -> ${String(c1)}`);
      const v = await volumeOf(dataVolume());
      assert(v.Name === dataVolume() && v.CreatedAt === v0, "the same volume, same CreatedAt", `${v.Name} ${v.CreatedAt} vs ${v0}`);
      assert(volumeDeletesIn(mark).length === 0, "no volume removal requested", volumeDeletesIn(mark).join(" | "));
      info(`worker:ticks ${String(c0)} -> ${String(c1)} across upgrade, rollback and storage restart`);
    });

    await step("pull-failure-consistent", async () => {
      const ids0 = await idsOf(planA);
      const compiled = compile(C, INTERVAL(5), 1, variant([[storageLine(STORAGE_REF), storageLine(STORAGE_REF.replace(DIGEST, FAKE_DIGEST))]]));
      assert(compiled.ok, "the unknown-digest variant compiles (allowlisted repository)", JSON.stringify(compiled.issues));
      const err = await rejection(adapter.pullAppStackImage({ plan: compiled.plan, image: FAKE_IMAGE }));
      assert(err?.reason === "STACK_IMAGE_PULL_FAILED", "the pull of an unknown digest fails as STACK_IMAGE_PULL_FAILED", err ? reasonOf(err) : "accepted");
      const s = await status(C);
      assert(s.components.length === 0 && !s.networks.internal && s.volumes.length === 0, "status reports nothing for the stack", JSON.stringify(s));
      await gone(C, "after the failed pull");
      assert(same(await idsOf(planA), ids0), "the first stack's container Ids are unchanged", "changed");
    });

    await step("network-failure-consistent", async () => {
      const compiled = compile(D, INTERVAL(5), 1);
      assert(compiled.ok, "the seed compiles for stack d", JSON.stringify(compiled.issues));
      const planD = compiled.plan;
      await adapter.pullAppStackImage({ plan: planD, image: SEED_IMAGE });
      faultOnce = "network";
      const err = await rejection(adapter.prepareAppStack({ plan: planD }));
      assert(err !== null && /^[A-Z_]+$/.test(reasonOf(err)), "prepare rejects with a coded reason", err ? reasonOf(err) : "accepted");
      assert(faultOnce === null && gateLog.some((l) => l.endsWith("-> FAULT")), "the injected fault was the cause", String(faultOnce));
      info(`prepare under a network fault: ${reasonOf(err)} ${String(err.message)}`);
      const s = await status(D);
      const own = ownNames(await snapshot(), D);
      assert(
        s.components.length === own.containers.length && s.networks.internal === own.networks.length > 0 && s.volumes.length === own.volumes.length,
        "the status read lists exactly the objects that exist",
        JSON.stringify({ s: { c: s.components, n: s.networks, v: s.volumes }, own }),
      );
      assert(own.containers.length === 0, "no container was created", own.containers.join(","));
      await deploy(planD);
      await adapter.removeAppStack({ stackId: D, organizationId: ORG, removeVolumes: true });
      await gone(D, "removed with its data");
    });

    await step("health-timeout-consistent", async () => {
      const ids0 = await idsOf(planA);
      const compiled = compile(E, INTERVAL(5), 1, HEALTH_6380_SOURCE());
      assert(compiled.ok, "the 6380 health variant compiles", JSON.stringify(compiled.issues));
      const planE = compiled.plan;
      await adapter.pullAppStackImage({ plan: planE, image: SEED_IMAGE });
      await adapter.prepareAppStack({ plan: planE });
      await adapter.createAppStackComponents({ plan: planE });
      await adapter.startAppStackComponent(startReq(planE, "storage"));
      const seen = new Set();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        seen.add(String(healthOf(await status(E), "storage")));
        await sleep(2_000);
      }
      assert(!seen.has("healthy") && seen.has("unhealthy"), "storage is never reported healthy within 30 s", [...seen].join(","));
      await adapter.removeAppStack({ stackId: E, organizationId: ORG, removeVolumes: true });
      await gone(E, "removed with its data");
      assert(same(await idsOf(planA), ids0), "the first stack's container Ids are unchanged", "changed");
    });

    await step("recovery-reads-only", async () => {
      const fresh = new DockerEngineSocketAdapter(adapterOptions);
      const mark = gateLog.length;
      const s = await status(A, fresh);
      assert(same(s.components.map((c) => c.componentKey), ["storage", "worker"]), "a fresh adapter reports both components", JSON.stringify(s.components));
      assert(same(s.volumes, ["data"]), "and the data volume", JSON.stringify(s.volumes));
      const other = gateLog.slice(mark).filter((l) => !l.startsWith("GET "));
      assert(gateLog.length > mark && other.length === 0, "the recovery read sends GET requests only", other.join(" | "));
    });

    await step("remove-keeps-volumes", async () => {
      const mark = gateLog.length;
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: false });
      assert(
        same(r.removedComponents, ["worker", "storage"]) && same(r.removedNetworks, ["app_internal"]) && same(r.retainedVolumes, ["data"]) && r.removedVolumes.length === 0,
        "worker and storage removed, the network removed, the data volume kept",
        JSON.stringify(r),
      );
      assert(volumeDeletesIn(mark).length === 0, "no volume removal requested", volumeDeletesIn(mark).join(" | "));
      const v = await volumeOf(dataVolume());
      assert(v.CreatedAt === v0 && v.Labels?.["io.hostingpanel.stack_id"] === A, "the data volume is still there with its labels and CreatedAt", JSON.stringify({ c: v.CreatedAt, l: v.Labels }));
      const S2 = await snapshot();
      assert(same(ownNames(S2), { ...NONE, volumes: [dataVolume()] }), "zero orphans except the retained volume", JSON.stringify(ownNames(S2)));
      assert(removedSince(S0, S2).length === 0, "no pre-existing object removed", removedSince(S0, S2).join(","));
    });

    await step("destroy-data-removes-volume", async () => {
      const mark = gateLog.length;
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: true });
      assert(same(r.removedVolumes, ["data"]) && r.removedComponents.length === 0, "the data volume is removed", JSON.stringify(r));
      const deletes = volumeDeletesIn(mark);
      assert(
        deletes.length === 1 && deletes[0].includes(encodeURIComponent(dataVolume())) && !deletes[0].includes("force"),
        "exactly one DELETE of that volume, without force",
        deletes.join(" | "),
      );
      await gone(A, "removed with its data");
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
        assert(bridges.length === 1 && bridges[0].startsWith("br-"), "the stack bridge matches br-*", bridges.join(","));
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
