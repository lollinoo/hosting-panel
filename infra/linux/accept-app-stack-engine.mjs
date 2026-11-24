#!/usr/bin/env node
/**
 * Real-Docker check of the application stack engine (HCP-SPEC-005 M3, ADR-0035) through the PRODUCTION
 * DockerEngineSocketAdapter from apps/docker-executor/dist: plan refusals before any Docker request (A12, A13), container
 * hardening, secrets only as files on tmpfs (A8), DNS between the components of a stack (A9), no reachability between
 * two stacks (A10), the private-network shape the host metadata drop applies to (A11, non-root half), idempotent
 * re-apply and read-only status (A16, A17 executor halves), volumes kept on remove (A18).
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack ids stk_swarmtest_<hex>_a|b|c, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the script's own paths use the prefix hp_swarmtest_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    a container id the gate saw created), and the create bodies keep the hardening; list answers are filtered to this
 *    run's objects. It never pulls. The first step proves that it denies foreign and unsafe requests.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_<hex>-secrets or a
 *    nonexistent own *_unused name. The routes are never published, so this run attaches no proxy to anything; the gate
 *    also denies a connect/disconnect of a container that is not this run's. No host port is published.
 *  - A live panel's own executor attaches its proxy to every network whose role label is app_edge, whoever created
 *    it. The gate therefore writes another value of that label for this run's edge networks and translates it in both
 *    directions, so a live executor never finds them; network-shape-covered-by-metadata-drop proves it and
 *    remove-keeps-volumes checks that only this run's containers are on them.
 *  - The docker CLI (an independent observer) is called with an argv array only, and refuses any argument naming an
 *    hp_ object of another run; inspect/exec/logs/rm/run only ever name this run's objects.
 *  - Small resources: 100 millicpu and 32 MiB per component, one 0.85 MiB image.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true) for the three stacks,
 *    then leftovers by exact own names (rm -f, network rm, volume rm), gate closed, temp dirs removed.
 *
 * Run: corepack pnpm -C apps/docker-executor run build, then node infra/linux/accept-app-stack-engine.mjs
 * (needs the image below locally: this script never pulls). Steps print PASS/FAIL/SKIP <step>; final line
 * RESULT n/m passed (a skipped step is never a pass and is not counted in n/m).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (p) => pathToFileURL(path.resolve(repoRoot, p)).href;
const {
  DockerEngineSocketAdapter,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackSecretDirKey,
  appStackVolumeName,
} = await import(dist("apps/docker-executor/dist/index.js"));
const { computeAppStackPlanHash } = await import(dist("packages/hosting-domain/dist/index.js"));

const IMAGE = "busybox@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6";
const PULL_HINT = "docker pull busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6";
const ALPINE = "alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf";
const IMAGES = new Set([IMAGE]);
const USER = "65534:65534";
const MEMORY = 33_554_432;
const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
// The executor of a live panel on this machine attaches its own proxy to every network whose role label is app_edge,
// whoever created it. Docker therefore holds another value for this run's edge networks, and the gate translates it in
// both directions: the adapter writes and reads app_edge, a live executor never finds the networks.
const EDGE_ROLE = "app_edge";
const EDGE_ROLE_IN_DOCKER = "app_edge_under_test";
const hex = randomBytes(4).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const [A, B, C] = ["a", "b", "c"].map((s) => `stk_swarmtest_${hex}_${s}`);
const SECRET = randomBytes(16).toString("hex"); // hex: can never form an hp_ token
const secretFileContents = [{ parameterKey: "shared_key", version: 1, content: SECRET }];
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;

// ---- plans ----
const RES = { cpuMilli: 100, memoryBytes: String(MEMORY) };
const web = {
  key: "web",
  image: IMAGE,
  runAsUser: USER,
  argv: ["httpd", "-f", "-p8080", "-h", "/etc"],
  environment: [{ name: "APP_MODE", value: "test" }],
  secretFiles: [],
  resources: RES,
  expose: [8080],
  dependsOn: [],
  volumes: [],
  healthcheck: { kind: "http", port: 8080, path: "/hostname", intervalSeconds: 5, timeoutSeconds: 3 },
};
const worker = {
  key: "worker",
  image: IMAGE,
  runAsUser: USER,
  argv: ["sleep", "3600"],
  environment: [],
  secretFiles: [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 1 }],
  resources: RES,
  expose: [],
  dependsOn: ["web"],
  volumes: [{ volumeKey: "data", containerPath: "/data", readOnly: false }],
  healthcheck: null,
};
const printer = { ...worker, key: "printer", argv: ["cat", "/run/secrets/shared_key"], volumes: [] };
const rehash = (plan) => ({ ...plan, planHash: computeAppStackPlanHash(plan) });
const planOf = (stackId, components, volumes = [], ingress = []) =>
  rehash({
    schemaVersion: 1,
    stackId,
    organizationId: ORG,
    hostAllocationId: `alloc_swarmtest_${hex}`,
    templateVersionId: `atv_swarmtest_${hex}`,
    revisionId: `srev_swarmtest_${hex}_1`,
    planHash: "0".repeat(64),
    components,
    volumes,
    ingress,
  });
const INGRESS = [{ componentKey: "web", port: 8080 }];
const planA = planOf(A, [web, worker], [{ key: "data" }], INGRESS);
const planB = planOf(B, [web, printer], [], INGRESS);
const planC = planOf(C, [web]);
const withWeb = (over) => ({ ...planA, components: [{ ...web, ...over }, worker] });
const unpinned = rehash(withWeb({ image: "busybox:1.38.0-musl" }));
const notAllowed = rehash(withWeb({ image: ALPINE }));
const overCeiling = rehash(withWeb({ resources: { ...RES, cpuMilli: 16001 } }));
const tampered = withWeb({ environment: [{ name: "APP_MODE", value: "tampered" }] }); // not rehashed
const namesOf = (plan) => ({
  containers: plan.components.map((c) => appStackContainerName(plan.stackId, c.key)).sort(),
  networks: [appStackInternalNetworkName(plan.stackId), ...(plan.ingress.length > 0 ? [appStackEdgeNetworkName(plan.stackId)] : [])].sort(),
  volumes: plan.volumes.map((v) => appStackVolumeName(plan.stackId, v.key)).sort(),
});
const cName = appStackContainerName;

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p) => stat(p).then(() => true, () => false);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);

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
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
  return n;
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
  });
}
/** The only docker CLI door: no hp_ name of another run, and object verbs only on this run's objects. */
async function docker(args, timeout = 120_000) {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !t.includes(marker));
  const objectVerb =
    ["inspect", "exec", "logs", "rm", "run"].includes(args[0]) || (["network", "volume"].includes(args[0]) && ["inspect", "rm"].includes(args[1]));
  if (foreign.length > 0 || (objectVerb && !args.some((a) => a.includes(marker)))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const networkOf = async (name) => JSON.parse(await docker(["network", "inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();

let ingressRoot = null;
async function treeDigest(dir) {
  const out = [];
  for (const f of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!f.isFile()) continue;
    const p = path.join(f.parentPath, f.name);
    out.push(`${path.relative(dir, p)} ${createHash("sha256").update(await readFile(p)).digest("hex")}`);
  }
  return out.sort();
}
const snapshot = async () => ({
  containers: await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]),
  networks: await lines(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"]),
  volumes: await lines(["volume", "ls", "--format", "{{.Name}}"]),
  certs: await treeDigest(ingressRoot),
});
/** Own names in a snapshot (default: this run; or one stack id). */
const ownNames = (s, id = marker) => ({
  containers: s.containers.filter((l) => l.includes(id)).map((l) => l.split(" ")[1]).sort(),
  networks: s.networks.filter((l) => l.includes(id)).map((l) => l.split(" ")[1]).sort(),
  volumes: s.volumes.filter((l) => l.includes(id)).sort(),
});

// ---- gate ----
let tmpDir = null;
let gateServer = null;
const gateLog = [];
const gateDenied = [];
const ownIds = new Set();
const isOwn = (ref) => ref.includes(marker) || ownIds.has(ref);
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });

/** null = the create body keeps every hardening property and names only this run's objects. */
function containerBodyProblem(body, bodyText) {
  const h = body.HostConfig ?? {};
  if (!IMAGES.has(body.Image)) return "image";
  if (h.Privileged === true || h.CapAdd !== undefined) return "privileges";
  if (!(h.CapDrop ?? []).includes("ALL") || !(h.SecurityOpt ?? []).includes("no-new-privileges:true") || h.ReadonlyRootfs !== true) {
    return "hardening";
  }
  if (["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"].some((k) => h[k] !== undefined)) return "host access";
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !b.startsWith(`${secretsRoot}/`) || !b.endsWith(":ro"))) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  if (Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker))) return "endpoint";
  return leakedWindows(bodyText, SECRET) > 0 ? "secret in body" : null;
}

/** Default deny: "forward" (optionally registering the created container id or filtering a list) or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const query = decodeURIComponent(u.search);
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t));
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version" || p === "/info")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) ? fwd() : deny("image");
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p, url: p === "/networks" ? edgeRoleFilterForDocker(rawUrl) : undefined });
  if (method === "POST" && p === "/networks/create") {
    const role = body.Labels?.[ROLE_LABEL];
    const ok =
      String(body.Name).includes(marker) &&
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      ["app_internal", EDGE_ROLE].includes(role);
    if (!ok) return deny("network create");
    if (role !== EDGE_ROLE) return fwd();
    return fwd({ body: JSON.stringify({ ...body, Labels: { ...body.Labels, [ROLE_LABEL]: EDGE_ROLE_IN_DOCKER } }) });
  }
  if (method === "POST" && p === "/volumes/create") {
    const ok = String(body.Name).includes(marker) && body.DriverOpts === undefined && [undefined, "local"].includes(body.Driver);
    return ok ? fwd() : deny("volume create");
  }
  if (method === "POST" && p === "/containers/create") {
    const problem = (u.searchParams.get("name") ?? "").includes(marker) ? containerBodyProblem(body, bodyText) : "unnamed or foreign container";
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
    if (method === "GET" || (method === "DELETE" && !u.searchParams.has("force"))) return fwd({ network: method === "GET" && m[1] === "networks" });
  }
  return deny("not an allowed request");
}

/** The address Docker receives: a label filter for the edge role names the value Docker holds. */
function edgeRoleFilterForDocker(rawUrl) {
  const u = new URL(rawUrl, "http://docker");
  const filters = JSON.parse(u.searchParams.get("filters") ?? "{}");
  const asked = `${ROLE_LABEL}=${EDGE_ROLE}`;
  if (!Array.isArray(filters.label) || !filters.label.includes(asked)) return undefined;
  filters.label = filters.label.map((l) => (l === asked ? `${ROLE_LABEL}=${EDGE_ROLE_IN_DOCKER}` : l));
  u.searchParams.set("filters", JSON.stringify(filters));
  return `${u.pathname}${u.search}`;
}
/** A network as the adapter wrote it: the edge role under its own name. */
function edgeRoleForAdapter(network) {
  if (network?.Labels?.[ROLE_LABEL] !== EDGE_ROLE_IN_DOCKER) return network;
  return { ...network, Labels: { ...network.Labels, [ROLE_LABEL]: EDGE_ROLE } };
}
/** A list answer with this run's objects only. */
function ownOnly(listPath, text) {
  const data = JSON.parse(text);
  if (listPath === "/volumes") return { ...data, Volumes: (data.Volumes ?? []).filter((v) => String(v.Name).includes(marker)) };
  if (listPath === "/networks") return data.filter((x) => String(x.Name).includes(marker)).map(edgeRoleForAdapter);
  return data.filter((x) => String(x.Names?.[0]).includes(marker));
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
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: verdict.url ?? req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.register && ures.statusCode === 201) ownIds.add(JSON.parse(body.toString("utf8")).Id);
          if (verdict.filterList && ures.statusCode === 200) body = Buffer.from(JSON.stringify(ownOnly(verdict.filterList, body.toString("utf8"))));
          if (verdict.network && ures.statusCode === 200) body = Buffer.from(JSON.stringify(edgeRoleForAdapter(JSON.parse(body.toString("utf8")))));
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
function viaGate(socketPath, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "GET", path: urlPath }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- cleanup ----
let adapter = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      for (const stackId of [A, B, C]) {
        await adapter
          .removeAppStack({ stackId, organizationId: ORG, removeVolumes: true })
          .catch((err) => console.log(`INFO cleanup ${stackId}: ${reasonOf(err)}`));
      }
    }
    for (const [list, remove] of [
      [["ps", "-a", "--filter", `name=${marker}`, "--format", "{{.Names}}"], ["rm", "-f"]],
      [["network", "ls", "--filter", `name=${marker}`, "--format", "{{.Name}}"], ["network", "rm"]],
      [["volume", "ls", "--filter", `name=${marker}`, "--format", "{{.Name}}"], ["volume", "rm"]],
    ]) {
      const names = (await lines(list).catch(() => [])).filter((n) => n.includes(marker));
      if (names.length > 0) await docker([...remove, ...names]).catch((err) => console.log(`INFO cleanup: ${err.message}`));
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
  const t0 = performance.now();
  try {
    await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
  } catch {
    console.log(`SKIP accept-app-stack-engine: ${IMAGE} is not local; nothing was created (this script never pulls). Hint: ${PULL_HINT}`);
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
  const gateSocket = path.join(tmpDir, "docker-gate.sock");
  const unused = (x) => `${runPrefix}_${x}_unused`;
  const adapterOptions = {
    dockerSocketPath: gateSocket,
    secretsRootDir: secretsRoot,
    ingressRootDir: ingressRoot,
    siteMailDir: path.join(tmpDir, "mail"),
    sitePhpDir: path.join(tmpDir, "php"),
    siteFilesDir: path.join(tmpDir, "files"),
    sftpStateDir: path.join(tmpDir, "sftp"),
    phpMyAdminConfigDir: path.join(tmpDir, "pma"),
    backupWorkDir: path.join(tmpDir, "backup"),
    sharedDbDataDir: path.join(tmpDir, "db"),
    sharedDbRootKeyFile: path.join(tmpDir, "db-root.key"),
    sharedDbContainerName: unused("shared_db"),
    sharedDbNetworkName: unused("shared_db_net"),
    ingressProxyContainerName: unused("ingress_proxy"),
    ingressNetworkName: unused("ingress_net"),
    pullMissingImages: false,
    appImageAllowlist: [{ repository: "busybox", runAsUser: USER, note: "acceptance only" }],
  };
  const results = [];
  const call = async (method, req) => {
    const r = await adapter[method](req);
    results.push(r);
    return r;
  };
  const start = (plan, componentKey) => call("startAppStackComponent", { plan, componentKey, secretFileContents });
  const status = (stackId) => call("getAppStackStatus", { stackId, organizationId: ORG });
  const remove = (stackId, removeVolumes) => call("removeAppStack", { stackId, organizationId: ORG, removeVolumes });
  const waitHealthy = (stackId, key) =>
    until(`${key} of ${stackId} healthy`, 30_000, async () => (await status(stackId)).components.find((c) => c.componentKey === key)?.health === "healthy");
  /** pull, prepare, create, start web, wait healthy, start the second component. */
  const apply = async (plan, second) => {
    const out = {
      pull: await call("pullAppStackImage", { plan, image: IMAGE }),
      prepare: await call("prepareAppStack", { plan }),
      create: await call("createAppStackComponents", { plan }),
      web: await start(plan, "web"),
    };
    await waitHealthy(plan.stackId, "web");
    out.second = await start(plan, second);
    return out;
  };
  const refusedBeforeDocker = async (fn, reason) => {
    const mark = gateLog.length;
    const err = await rejection(fn());
    assert(err !== null && err.reason === reason, `refused as ${reason}`, err ? reasonOf(err) : "accepted");
    assert(gateLog.length === mark, "refused before any Docker request (no pull, no inspect)", gateLog.slice(mark).join(" | "));
  };
  const fetchFrom = (container, url) =>
    docker(["exec", container, "wget", "-q", "-T", "3", "-O", "-", url], 20_000).then(
      (body) => body,
      () => null,
    );
  let S0 = null;

  try {
    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    const gateOk = await step("gate-self-test", async () => {
      // Real names of this machine, used only as judge() inputs: no request about them is ever sent.
      const foreignName = (await lines(["ps", "-a", "--format", "{{.Names}}"])).find((n) => n.startsWith("hp_")) ?? `hp_selftest_${hex}`;
      const foreignId = (await lines(["ps", "-aq", "--no-trunc"]))[0] ?? "f".repeat(64);
      const foreignNet = (await lines(["network", "ls", "--format", "{{.Name}}"]))[0] ?? "bridge";
      const foreignVol = (await lines(["volume", "ls", "--format", "{{.Name}}"]))[0] ?? `selftest_${hex}`;
      const ownNet = appStackInternalNetworkName(A);
      const hardened = { Image: IMAGE, HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, NetworkMode: ownNet } };
      const createWith = (hostConfig, extra = {}) =>
        JSON.stringify({ ...hardened, ...extra, HostConfig: { ...hardened.HostConfig, ...hostConfig } });
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
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignName })],
        ["POST", `/v1.45/networks/${ownNet}/connect`, JSON.stringify({ Container: foreignId })],
        ["POST", `/v1.45/networks/${foreignNet}/disconnect`, JSON.stringify({ Container: cName(A, "web") })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(IMAGE)}`, ""],
        ["GET", `/v1.45/images/${encodeURIComponent(ALPINE)}/json`, ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", `/v1.45/containers/${foreignId}/exec`, JSON.stringify({ Cmd: ["true"] })],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, createWith({})],
        ["POST", `/v1.45/containers/create?name=${cName(A, "web")}`, createWith({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${cName(A, "web")}`, createWith({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${cName(A, "web")}`, createWith({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${cName(A, "web")}`, createWith({}, { Image: ALPINE })],
        ["POST", `/v1.45/containers/create?name=${cName(A, "web")}`, createWith({}, { Env: [`K=${SECRET}`] })],
        ["POST", "/v1.45/networks/create", JSON.stringify({ Name: ownNet, Driver: "bridge", Options: { "com.docker.network.bridge.name": "x" }, Labels: { [ROLE_LABEL]: "app_internal" } })],
        ["POST", "/v1.45/networks/create", JSON.stringify({ Name: ownNet, Driver: "bridge", Labels: { [ROLE_LABEL]: "site_internal" } })],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: appStackVolumeName(A, "data"), Driver: "local", DriverOpts: { type: "none" } })],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url]) => `${method} ${url}`).join(" | "));
      const wider = [["POST", "/v1.45/info"], ["GET", "/v1.45/info/x"]].filter(([method, url]) => judge(method, url, "").kind !== "deny");
      assert(wider.length === 0, "judge() allows GET /info and nothing wider", wider.map(([method, url]) => `${method} ${url}`).join(" | "));
      // Through the socket: read-only requests only, harmless even if the gate let them through.
      const denied = await viaGate(gateSocket, `/v1.45/containers/hp_selftest_${hex}/json`);
      assert(denied.status === 403 && gateDenied.length === 1, "the socket answers 403 for a foreign name and records the denial", `${denied.status} ${gateDenied.length}`);
      const ping = await viaGate(gateSocket, "/_ping");
      assert(ping.status === 200 && ping.body === "OK", "the socket forwards an allowed request to the Engine", `${ping.status} ${ping.body}`);
      gateDenied.length = 0; // the expected self-test denial; from here on any denial fails gate-clean
    });
    if (!gateOk) {
      adapter = null; // nothing was created: cleanup sends nothing through a gate that failed its self-test
      return;
    }

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter((l) => l.includes(marker));
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    await step("refuse-unpinned-image-before-docker", async () => {
      await refusedBeforeDocker(() => call("createAppStackComponents", { plan: unpinned }), "STACK_PLAN_INVALID");
      await refusedBeforeDocker(() => call("createAppStackComponents", { plan: notAllowed }), "STACK_IMAGE_NOT_ALLOWED");
    });

    await step("refuse-over-ceiling-before-docker", async () => {
      await refusedBeforeDocker(() => call("prepareAppStack", { plan: overCeiling }), "STACK_PLAN_INVALID");
    });

    await step("refuse-tampered-plan-before-docker", async () => {
      await refusedBeforeDocker(() => call("prepareAppStack", { plan: tampered }), "STACK_PLAN_HASH_MISMATCH");
    });

    await step("apply-stack-a", async () => {
      const out = await apply(planA, "worker");
      assert(same(out.pull, { image: IMAGE, pulled: false }), "image present: pulled false", JSON.stringify(out.pull));
      assert(
        out.prepare.networks.every((n) => n.created) && out.prepare.networks.length === 2 && same(out.prepare.volumes, [{ volumeKey: "data", created: true }]),
        "two networks and one volume created",
        JSON.stringify(out.prepare),
      );
      assert(out.create.components.every((c) => c.outcome === "created") && out.create.components.length === 2, "two components created", JSON.stringify(out.create));
      assert(out.web.outcome === "started" && out.second.outcome === "started", "web and worker started", `${out.web.outcome} ${out.second.outcome}`);
      const s1 = ownNames(await snapshot());
      assert(same(s1, namesOf(planA)), "own delta: exactly 2 containers, 2 networks, 1 volume", JSON.stringify(s1));
    });

    await step("container-hardening", async () => {
      for (const name of namesOf(planA).containers) {
        const c = await inspectOf(name);
        const h = c.HostConfig;
        const labels = c.Config.Labels ?? {};
        const checks = {
          CapDrop: same(h.CapDrop, ["ALL"]),
          CapAdd: (h.CapAdd ?? []).length === 0,
          SecurityOpt: same(h.SecurityOpt, ["no-new-privileges:true"]),
          ReadonlyRootfs: h.ReadonlyRootfs === true,
          Tmpfs: typeof h.Tmpfs?.["/tmp"] === "string",
          PidsLimit: h.PidsLimit === 256,
          Memory: h.Memory === MEMORY && h.MemorySwap === MEMORY,
          NanoCpus: h.NanoCpus === 100_000_000,
          LogConfig: h.LogConfig?.Type === "json-file" && h.LogConfig.Config?.["max-size"] === "10m" && h.LogConfig.Config?.["max-file"] === "3",
          RestartPolicy: h.RestartPolicy?.Name === "unless-stopped",
          NoPorts: Object.keys(h.PortBindings ?? {}).length === 0,
          Privileged: h.Privileged === false,
          User: c.Config.User === USER,
          Labels: labels["io.hostingpanel.role"] === "app_component" && labels["io.hostingpanel.stack_id"] === A,
          NoSiteLabels: labels["io.hostingpanel.site_id"] === undefined && labels["io.hostingpanel.service_instance_id"] === undefined,
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `${name} carries the designed hardening`, bad.join(","));
      }
    });

    await step("secrets-only-as-files", async () => {
      const w = await inspectOf(cName(A, "worker"));
      assert(w.Config.Env.includes("SHARED_KEY_FILE=/run/secrets/shared_key"), "Env holds only the file path", JSON.stringify(w.Config.Env));
      for (const name of namesOf(planA).containers) {
        assert(leakedWindows(JSON.stringify(await inspectOf(name)), SECRET) === 0, `no window of the secret in the inspect JSON of ${name}`, "found");
      }
      const bind = `${path.join(secretsRoot, appStackSecretDirKey(A, "worker"), "shared_key")}:/run/secrets/shared_key:ro`;
      assert(same(w.HostConfig.Binds, [bind]), "exactly one read-only secret file bind", JSON.stringify(w.HostConfig.Binds));
      const fsType = (await statfs(secretsRoot)).type;
      assert(fsType === 0x01021994, "the secrets root is on tmpfs", fsType.toString(16));
      const read = await docker(["exec", cName(A, "worker"), "cat", "/run/secrets/shared_key"]);
      assert(read.trim() === SECRET, "the component reads the secret from its file", "other content");
      assert(leakedWindows(JSON.stringify(results), SECRET) === 0, "no adapter result holds the secret", "found");
    });

    await step("dns-between-components", async () => {
      const body = await fetchFrom(cName(A, "worker"), "http://web:8080/hostname");
      const hostname = (await inspectOf(cName(A, "web"))).Config.Hostname;
      assert(body !== null && body.trim() === hostname, "worker reaches web by its component name", String(body));
    });

    await step("host-probe-reaches-internal-bridge", async () => {
      const webObs = (await status(A)).components.find((c) => c.componentKey === "web");
      const net = await networkOf(appStackInternalNetworkName(A));
      assert(net.Internal === true, "the private network is Internal", String(net.Internal));
      assert(webObs?.probe === "passed" && webObs.health === "healthy", "the executor's HTTP probe reaches web on the Internal bridge", JSON.stringify(webObs));
    });

    await step("idempotent-reapply", async () => {
      const mark = gateLog.length;
      const pull = await call("pullAppStackImage", { plan: planA, image: IMAGE });
      const prep = await call("prepareAppStack", { plan: planA });
      const created = await call("createAppStackComponents", { plan: planA });
      const starts = [await start(planA, "web"), await start(planA, "worker")];
      assert(pull.pulled === false, "pulled false", JSON.stringify(pull));
      const ensured = [...prep.networks, ...prep.volumes];
      assert(ensured.length === 3 && ensured.every((x) => x.created === false), "created false x3", JSON.stringify(prep));
      assert(created.components.every((c) => c.outcome === "unchanged") && created.removedComponents.length === 0, "all components unchanged", JSON.stringify(created));
      assert(starts.every((s) => s.outcome === "already_running"), "already_running x2", JSON.stringify(starts));
      const writes = gateLog.slice(mark).filter((l) => /^(POST|DELETE|PUT) /.test(l));
      assert(writes.length === 0, "the re-apply sent no mutating request", writes.join(" | "));
    });

    await step("status-reads-only", async () => {
      const mark = gateLog.length;
      await status(A);
      await status(A);
      const other = gateLog.slice(mark).filter((l) => !l.startsWith("GET "));
      assert(gateLog.length > mark && other.length === 0, "status sends GET requests only", other.join(" | "));
    });

    await step("apply-stack-b", async () => {
      const out = await apply(planB, "printer");
      assert(out.pull.pulled === false && out.prepare.networks.length === 2 && out.prepare.networks.every((n) => n.created), "B prepared", JSON.stringify(out.prepare));
      assert(out.create.components.every((c) => c.outcome === "created"), "B components created", JSON.stringify(out.create));
      assert(out.web.outcome === "started" && out.second.outcome === "started", "B web and printer started", `${out.web.outcome} ${out.second.outcome}`);
    });

    await step("no-cross-stack-reachability", async () => {
      const bWeb = cName(B, "web");
      assert((await fetchFrom(bWeb, "http://web:8080/hostname")) !== null, "control: B web reaches its own stack's web", "failed");
      const nets = (await inspectOf(cName(A, "web"))).NetworkSettings.Networks;
      const targets = [
        `http://${nets[appStackEdgeNetworkName(A)].IPAddress}:8080/hostname`,
        `http://${nets[appStackInternalNetworkName(A)].IPAddress}:8080/hostname`,
        `http://${cName(A, "web")}:8080/hostname`,
      ];
      for (const url of targets) assert((await fetchFrom(bWeb, url)) === null, `B web cannot reach ${url}`, "reached");
      for (const name of namesOf(planB).containers) {
        const c = await inspectOf(name);
        const refs = [...(c.HostConfig.Binds ?? []), ...(c.Mounts ?? []).map((mt) => mt.Name ?? mt.Source)];
        assert(refs.every((r) => r.includes(B)), `${name} references only stack B's files and volumes`, refs.join(","));
      }
    });

    await step("logs-masked", async () => {
      const masked = await until("the printer logged its secret file", 20_000, async () => {
        const got = await call("getAppStackComponentLogs", { stackId: B, organizationId: ORG, componentKey: "printer", tail: 20 });
        return got.some((l) => l.text.includes("[REDACTED]")) ? got : null;
      });
      assert(masked.every((l) => leakedWindows(l.text, SECRET) === 0), "no window of the secret in any masked line", "found");
      const raw = await docker(["logs", cName(B, "printer")]);
      assert(raw.includes(SECRET), "the raw log holds the secret, so the masking did the work", "absent");
    });

    await step("network-shape-covered-by-metadata-drop", async () => {
      // Docker holds the edge role under the name the gate gives it (see EDGE_ROLE_IN_DOCKER); the adapter read app_edge.
      for (const [name, role, internal] of [[appStackInternalNetworkName(A), "app_internal", true], [appStackEdgeNetworkName(A), EDGE_ROLE_IN_DOCKER, false]]) {
        const n = await networkOf(name);
        assert(
          n.Driver === "bridge" && n.Internal === internal && n.Options?.["com.docker.network.bridge.name"] === undefined && n.Labels?.[ROLE_LABEL] === role,
          `${name}: plain bridge, Internal ${String(internal)}, no bridge.name, role ${role}`,
          JSON.stringify({ d: n.Driver, i: n.Internal, o: n.Options, r: n.Labels?.[ROLE_LABEL] }),
        );
        assert(await exists(`/sys/class/net/br-${n.Id.slice(0, 12)}`), `host interface br-${n.Id.slice(0, 12)} exists (matches iifname "br-*")`, "absent");
      }
      // What the executor of a live panel asks Docker before it attaches its proxy: no network of this run is in the answer.
      const edgeRoleList = await lines(["network", "ls", "--filter", `label=${ROLE_LABEL}=${EDGE_ROLE}`, "--format", "{{.Name}}"]);
      const listed = edgeRoleList.filter((n) => n.includes(marker));
      assert(listed.length === 0, "Docker's own list of the networks with the edge role holds no network of this run", listed.join(","));
    });

    if (!rootCasesEnabled) {
      skip(
        "host-nft-metadata-drop-on-stack-net",
        "needs root to read the host nft ruleset (run as root with HP_ACCEPT_ROOT_CASES=1); the ruleset is proven by accept-m5-firewall.mjs and the stack network shape (plain bridge, no bridge.name, br-<id12> present) by network-shape-covered-by-metadata-drop",
      );
    } else {
      await step("host-nft-metadata-drop-on-stack-net", async () => {
        const ruleset = await run("nft", ["list", "ruleset"], 20_000);
        assert(ruleset.includes('iifname "br-*" ip daddr 169.254.0.0/16 drop'), "the host drops metadata traffic from every br-* bridge", "rule absent");
      });
    }

    await step("internal-component-has-no-default-route", async () => {
      const routes = (await docker(["exec", cName(A, "worker"), "cat", "/proc/net/route"])).split("\n").slice(1).filter(Boolean);
      const defaults = routes.filter((r) => r.trim().split(/\s+/)[1] === "00000000");
      assert(routes.length > 0 && defaults.length === 0, "the worker has no default route off its private bridge", routes.join(" | "));
    });

    await step("no-docker-socket-in-components", async () => {
      for (const name of [...namesOf(planA).containers, ...namesOf(planB).containers]) {
        const c = await inspectOf(name);
        // SandboxKey is the Engine's own netns handle (/var/run/docker/netns/<id>), never visible in the container.
        const text = JSON.stringify({ ...c, NetworkSettings: { ...c.NetworkSettings, SandboxKey: undefined } });
        const hit = ["docker.sock", "/var/run"].map((s) => text.indexOf(s)).find((i) => i >= 0);
        assert(hit === undefined, `${name} has no Docker socket or /var/run`, text.slice(Math.max(0, (hit ?? 0) - 80), (hit ?? 0) + 40));
        const bad = (c.Mounts ?? []).filter((mt) =>
          mt.Type === "bind" ? !mt.Source.startsWith(`${secretsRoot}/`) || mt.RW !== false : mt.Type !== "volume" || !String(mt.Name).includes(marker),
        );
        assert(bad.length === 0, `${name} mounts only its secret files and own volumes`, JSON.stringify(bad));
      }
    });

    await step("refuse-foreign-namespace", async () => {
      const decoy = cName(C, "web");
      const decoyId = (
        await docker(["run", "-d", "--pull", "never", "--name", decoy, "--network", "none", "--cap-drop", "ALL", "--read-only", IMAGE, "sleep", "600"])
      ).trim();
      await call("prepareAppStack", { plan: planC });
      const err = await rejection(call("createAppStackComponents", { plan: planC }));
      assert(err?.reason === "STACK_NAMESPACE_CONFLICT", "an unlabelled container with the component's name refuses the create", err ? reasonOf(err) : "created");
      const d = await inspectOf(decoy);
      assert(d.Id === decoyId && d.State.Running === true, "the decoy keeps its id and keeps running", `${d.Id === decoyId} ${d.State.Status}`);
    });

    await step("remove-keeps-volumes", async () => {
      await docker(["exec", "-u", "0", cName(A, "worker"), "touch", "/data/marker"]);
      for (const id of [A, B]) {
        const attached = Object.values((await networkOf(appStackEdgeNetworkName(id))).Containers ?? {}).map((c) => String(c.Name));
        // The web component joins it at create: an empty list would make the check below prove nothing.
        assert(attached.length > 0, `the edge network of ${id} lists its containers`, "none");
        const foreign = attached.filter((n) => !n.includes(marker));
        assert(foreign.length === 0, `only this run's containers are on the edge network of ${id}`, foreign.join(","));
      }
      const mark = gateLog.length;
      const r = await remove(A, false);
      assert(same(r.retainedVolumes, ["data"]) && r.removedVolumes.length === 0, "retainedVolumes [data]", JSON.stringify(r));
      const volumeDeletes = gateLog.slice(mark).filter((l) => l.startsWith("DELETE ") && l.includes("/volumes/"));
      assert(volumeDeletes.length === 0, "no DELETE /volumes", volumeDeletes.join(" | "));
      const left = ownNames(await snapshot(), A);
      assert(same(left, { containers: [], networks: [], volumes: [appStackVolumeName(A, "data")] }), "only the volume of stack A is left", JSON.stringify(left));
      assert(!(await exists(path.join(secretsRoot, appStackSecretDirKey(A, "worker")))), "the secret dir of stack A is gone", "present");
    });

    await step("reapply-reuses-volume-data", async () => {
      const out = await apply(planA, "worker");
      assert(same(out.prepare.volumes, [{ volumeKey: "data", created: false }]), "the kept volume is reused", JSON.stringify(out.prepare.volumes));
      await docker(["exec", cName(A, "worker"), "ls", "/data/marker"]);
    });

    await step("remove-with-volumes", async () => {
      const ra = await remove(A, true);
      await remove(B, true);
      await remove(C, true);
      await docker(["rm", "-f", cName(C, "web")]); // the decoy is the script's, never the adapter's
      assert(same(ra.removedVolumes, ["data"]) && ra.retainedVolumes.length === 0, "removedVolumes [data]", JSON.stringify(ra));
      const left = ownNames(await snapshot());
      assert(same(left, { containers: [], networks: [], volumes: [] }), "zero own objects left", JSON.stringify(left));
    });

    await step("foreign-untouched", async () => {
      const s3 = await snapshot();
      const kinds = ["containers", "networks", "volumes"];
      const removed = kinds.flatMap((k) => S0[k].filter((l) => !s3[k].includes(l)));
      assert(removed.length === 0, "no pre-existing container, network or volume changed", removed.join(","));
      assert(same(s3.certs, S0.certs), "the temp ingress tree is unchanged (no route file)", s3.certs.join(","));
      const added = kinds.flatMap((k) => s3[k].filter((l) => !S0[k].includes(l)));
      if (added.length > 0) info(`objects added meanwhile by someone else: ${added.join(", ")}`);
    });

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only about this run's objects", gateDenied.slice(0, 3).join(" | "));
      info(`gate saw ${gateLog.length} request(s), ${gateDenied.length} denied`);
    });
  } finally {
    await cleanup();
    total += 1;
    const left = [];
    for (const args of [["ps", "-aq", "--filter", `name=${marker}`], ["network", "ls", "-q", "--filter", `name=${marker}`], ["volume", "ls", "-q", "--filter", `name=${marker}`]]) {
      if ((await docker(args).catch(() => "x")).trim() !== "") left.push(args[0]);
    }
    for (const dir of [tmpDir, secretsRoot]) if (await exists(dir)) left.push(dir);
    if (gateServer?.listening) left.push("gate");
    if (left.length === 0) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: ${left.join(",")}`);
    }
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`RESULT ${String(passed)}/${String(total)} passed${skipped > 0 ? `, ${String(skipped)} skipped (not counted in n/m)` : ""} in ${s}s`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
