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
 * With `--imported` the same run is made for the draft the Compose importer writes (§2.8) from the WordPress and MariaDB
 * file of the importer's tests, pasted as an administrator would: other component and volume names, a database account
 * the platform generates too, a health check that asks WordPress for a page. The import needs the digest of every image
 * tag, which the API asks the registry for: here the file names the versions the built-in template pins and the answers
 * are the digests recorded with them, so the run is repeatable and downloads nothing new. With
 * HP_ACCEPT_REGISTRY_CASES=1 it also asks the registry for those tags through the product (read-only, needs the network).
 *
 * The built-in run is made for the newest version of the template; HP_ACCEPT_WORDPRESS_VERSION=1 makes it for version 1,
 * where address-follows-host and uploads-limit fail: the reproduction of what version 2 fixes (a site that answers only
 * as the name it was installed on, uploads of up to 2 MB). no-redirect-loop is expected to fail there too, the login of
 * version 1 being on that first name.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack id stk_swarmtest_<hex>_a, so every container, network and volume name
 *    the engine derives contains swarmtest_<hex>; the script's own names and paths use hp_swarmtest_stk_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    an id the gate saw created), the create bodies keep the profile, a pull names a digest of the plan and a registry
 *    lookup a tag of the imported file (only with HP_ACCEPT_REGISTRY_CASES=1); list answers are filtered to this run's
 *    objects. A secret of the run may travel in one place only, the Env of a container of the application: anywhere
 *    else the gate denies the request. The gate-self-test step proves these denials. The script's own changes (proxy
 *    removal, cleanup) go through the same gate.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_stk_<hex>-secrets or a
 *    nonexistent own *_unused name. The only proxy is a throwaway one created through the ingressProxyContainerName /
 *    ingressNetworkName seams, published on 127.0.0.1:16780/16743 only; the gate denies a connect or disconnect of a
 *    container that is not this run's, so this run attaches no live proxy.
 *  - A live panel's own executor attaches its proxy to every network whose role label is app_edge, whoever created
 *    it (it did so to a run of this script on 2026-11-22). The gate therefore writes another value of that label for
 *    this run's edge network and translates it in both directions, so a live executor never finds the network;
 *    network-shape proves it and remove-keeps-volumes checks that only this run's containers are on it.
 *  - The docker CLI (an independent observer) is called with an argv array only and refuses any argument naming an hp_
 *    object of another run; inspect/logs and the commands run inside a container only ever name this run's objects.
 *    The secrets are random values of this run that die with it; the login checks pass them as arguments.
 *  - uploads-limit writes one page of this run into this run's site volume (docker exec of php in this run's wordpress
 *    container) and removes it in the same step.
 *  - Images: the digest-pinned refs of the wordpress-mariadb seed in APP_BUILT_IN_TEMPLATES (the imported draft pins
 *    the same two), pulled by the product through the gate when missing (offline run: docker pull each
 *    <repository>@sha256:<digest> first). traefik:v3.7 must be local.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true), then leftovers by
 *    exact own names through the gate, gate closed, temp dirs removed.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-stack-wordpress.mjs [--imported]
 *  (version 1: HP_ACCEPT_WORDPRESS_VERSION=1 node infra/linux/accept-app-stack-wordpress.mjs)
 * Steps: gate-self-test, preflight, snapshot-before, plan-compiles-from-seed, refused-before-docker,
 * deploy-creates-exact-set, container-standard-profile, secrets-reach-only-their-component, network-shape,
 * no-control-plane-reach, route-published-after-health, wordpress-installs, address-follows-host, no-redirect-loop,
 * uploads-limit (these three skipped with --imported: the administrator's draft sets neither), logs-mask-environment-secrets,
 * data-survives-stop-and-start, idempotent-reapply, upgrade-keeps-data, recovery-reads-only, remove-keeps-volumes,
 * destroy-data-removes-volume, host-nft-metadata-drop-on-stack-net (root only: HP_ACCEPT_ROOT_CASES=1 as root),
 * gate-clean, nothing-left. With --imported: compose-imports-to-draft first, plan-compiles-from-draft in place of
 * plan-compiles-from-seed and, after it, registry-lookup-reads-only (HP_ACCEPT_REGISTRY_CASES=1 only).
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
const { compileAppStackPlan, importComposeToAppTemplate, listComposeImages, validateAppTemplateSource } = policy;
const { APP_BUILT_IN_TEMPLATES, ApprovedStackPlanSchema, appStackComponentSecretRefs } = contracts;
const { computeAppStackPlanHash } = domain;

const TRAEFIK_IMAGE = "traefik:v3.7";
const HOST = "127.0.0.1";
const PORT = { http: 16780, https: 16743 };
const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
// The executor of a live panel on this machine attaches its own proxy to every network whose role label is app_edge,
// whoever created it. Docker therefore holds another value for this run's edge network, and the gate translates it in
// both directions: the adapter writes and reads app_edge, a live executor never finds the network.
const EDGE_ROLE = "app_edge";
const EDGE_ROLE_IN_DOCKER = "app_edge_under_test";
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_stk_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const proxyName = `${runPrefix}_proxy`;
const ingressNet = `${runPrefix}_ingress`;
const ORG = `org_swarmtest_${hex}`;
const A = `stk_swarmtest_${hex}_a`;
const HOST1 = `wp-${hex}.hp-stk.test`;
/** A second name of this run on the same route: the site must answer it as itself (address-follows-host). */
const HOST2 = `wp2-${hex}.hp-stk.test`;
/** The command version 2 gives WordPress: the image's own start program with the uploads limit (ADR-0036). */
const UPLOADS_ARGV = ["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"];
const TITLE = `Acceptance ${hex}`;
const HEALTH_MS = 180_000;
const rootCasesEnabled = process.env.HP_ACCEPT_ROOT_CASES === "1" && process.getuid() === 0;
/** `--imported`: the run is made for the draft the Compose importer writes, not for the built-in template. */
const IMPORTED = process.argv.slice(2).includes("--imported");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--imported");
if (unknownArgs.length > 0) {
  console.log(`FAIL preflight: unknown argument ${unknownArgs[0]} (the only one is --imported)`);
  console.log("RESULT 0/1 passed in 0.0s");
  process.exit(1);
}
/** The lookup of the image tags asks the public registry: only on request. */
const registryCasesEnabled = IMPORTED && process.env.HP_ACCEPT_REGISTRY_CASES === "1";
const COMPOSE_FILE = "packages/policy-engine/test/fixtures/compose-import/wordpress-mariadb.yml";
/** This run's: the stack-derived names carry the marker, the script's own names and paths the prefix. */
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- secrets (the API generates them at install; here random values that die with the run) ----
const DB_PASSWORD = randomBytes(16).toString("hex");
const ROOT_PASSWORD = randomBytes(16).toString("hex");
const ADMIN_PASSWORD = randomBytes(12).toString("hex");
/** What the two templates name differently. The imported file has the platform generate the database account too
 *  (kind `user`: a lowercase letter, then lowercase letters and digits, 16 in all); the built-in one fixes it. */
const T = IMPORTED
  ? {
      what: "the draft imported from the Compose file",
      db: "mariadb",
      volumes: { database: "mariadb-data", site: "wordpress-data" },
      dbUser: `u${randomBytes(8).toString("hex").slice(1)}`,
      keys: { user: "user_wordpress", password: "password_wordpress", root: "password_root" },
    }
  : {
      what: "the wordpress-mariadb seed",
      db: "db",
      volumes: { database: "database", site: "site" },
      dbUser: "wordpress",
      keys: { user: null, password: "db_password", root: "db_root_password" },
    };
const WORDPRESS = "wordpress";
const SECRET_CONTENTS = [
  ...(T.keys.user === null ? [] : [{ parameterKey: T.keys.user, version: 1, content: T.dbUser }]),
  { parameterKey: T.keys.password, version: 1, content: DB_PASSWORD },
  { parameterKey: T.keys.root, version: 1, content: ROOT_PASSWORD },
];
/** "<variable><-<secret>" per component, in the plan's order (by variable name). */
const READS = {
  db: [`MARIADB_PASSWORD<-${T.keys.password}`, `MARIADB_ROOT_PASSWORD<-${T.keys.root}`, ...(T.keys.user === null ? [] : [`MARIADB_USER<-${T.keys.user}`])],
  wordpress: [`WORDPRESS_DB_PASSWORD<-${T.keys.password}`, ...(T.keys.user === null ? [] : [`WORDPRESS_DB_USER<-${T.keys.user}`])],
};
/** The same reads as the "<variable>=<value>" a container holds. */
const heldBy = (reads) =>
  reads.map((read) => {
    const [name, key] = read.split("<-");
    return `${name}=${SECRET_CONTENTS.find((e) => e.parameterKey === key).content}`;
  });
/** How many 8-character windows of the secret occur in a text (0 = no part of it leaked). */
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
  return n;
}
const leaks = (text) => SECRET_CONTENTS.some((e) => leakedWindows(text, e.content) > 0);

// ---- plans (the extended format: no allowlist row, generated secrets) ----
const seed = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "wordpress-mariadb");
/** Every version of the seed, oldest first; the run is made for the newest unless HP_ACCEPT_WORDPRESS_VERSION names one. */
const SEED_VERSIONS = [...(seed.previousVersions ?? []), { versionId: seed.versionId, source: seed.source }];
const wantedVersion = process.env.HP_ACCEPT_WORDPRESS_VERSION;
const VERSION = wantedVersion === undefined ? SEED_VERSIONS.length : /^[1-9][0-9]*$/.test(wantedVersion) ? Number(wantedVersion) : 0;
if (VERSION < 1 || VERSION > SEED_VERSIONS.length || (IMPORTED && wantedVersion !== undefined)) {
  console.log(
    `FAIL preflight: HP_ACCEPT_WORDPRESS_VERSION=${String(wantedVersion)} (the built-in template has versions 1 to ${String(SEED_VERSIONS.length)}; not with --imported)`,
  );
  console.log("RESULT 0/1 passed in 0.0s");
  process.exit(1);
}
const built = SEED_VERSIONS[VERSION - 1];
/** Version 2 and later: the address line and the uploads limit. */
const FIXED = !IMPORTED && VERSION >= 2;
/** The tag and the digest the seed pins for a repository. */
const pinned = (repository) => {
  const m = seed.source.match(new RegExp(`image: (${repository}:[\\w.-]+)@(sha256:[0-9a-f]{64})`));
  return { tag: m?.[1] ?? "", digest: m?.[2] ?? "" };
};
/**
 * The imported run: the Compose file as an administrator would paste it, with its two image tags set to the versions
 * the seed pins. The digest of each tag, which the API asks the registry for, is here the one the seed records.
 */
let imported = null;
const LOOKUPS = new Set();
if (IMPORTED) {
  const file = await readFile(path.resolve(repoRoot, COMPOSE_FILE), "utf8");
  const compose = file.replace(/^(\s+image: )(wordpress|mariadb):\S+$/gm, (_all, lead, repository) => `${lead}${pinned(repository).tag}`);
  for (const image of listComposeImages(compose)) LOOKUPS.add(image);
  imported = importComposeToAppTemplate({ compose, digests: new Map([...LOOKUPS].map((image) => [image, pinned(image.split(":")[0]).digest])) });
}
const first = compileAppStackPlan({
  source: IMPORTED ? (imported.source ?? "") : built.source,
  parameters: [],
  secretVersions: new Map(SECRET_CONTENTS.map((e) => [e.parameterKey, e.version])),
  ids: {
    stackId: A,
    organizationId: ORG,
    hostAllocationId: `alloc_swarmtest_${hex}`,
    templateVersionId: IMPORTED ? `atv_swarmtest_${hex}` : built.versionId,
    revisionId: `srev_swarmtest_${hex}_1`,
  },
});
/** The digest refs of the plan: the only images the gate inspects or pulls (besides the proxy image). */
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
  if (method === "GET" && (m = p.match(/^\/distribution\/(.+)\/json$/))) return registryCasesEnabled && LOOKUPS.has(m[1]) ? fwd() : deny("registry lookup");
  if (method === "POST" && p === "/images/create") {
    const from = u.searchParams.get("fromImage") ?? "";
    const tag = u.searchParams.get("tag") ?? "";
    const ref = tag === "" ? from : tag.startsWith("sha256:") ? `${from}@${tag}` : null;
    return ref !== null && ref.includes("@sha256:") && IMAGES.has(ref) ? fwd() : deny("image pull");
  }
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p, url: p === "/networks" ? edgeRoleFilterForDocker(rawUrl) : undefined });
  if (method === "POST" && p === "/networks/create") {
    const role = body.Labels?.[ROLE_LABEL];
    const ok =
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.IPAM === undefined &&
      ((String(body.Name).includes(marker) && ["app_internal", EDGE_ROLE].includes(role)) || (body.Name === ingressNet && role === "ingress_public"));
    if (!ok) return deny("network create");
    if (role !== EDGE_ROLE) return fwd();
    return fwd({ body: JSON.stringify({ ...body, Labels: { ...body.Labels, [ROLE_LABEL]: EDGE_ROLE_IN_DOCKER } }) });
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
    if (method === "GET" || (method === "DELETE" && !(m[1] === "volumes" && u.searchParams.has("force")))) return fwd({ network: method === "GET" && m[1] === "networks" });
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
  if (listPath === "/volumes") return { ...data, Volumes: (data.Volumes ?? []).filter((v) => ours(String(v.Name))) };
  if (listPath === "/networks") return data.filter((x) => ours(String(x.Name))).map(edgeRoleForAdapter);
  return data.filter((x) => ours(String(x.Names?.[0])));
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
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: verdict.url ?? req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.register && ures.statusCode === 201) ownIds.add(JSON.parse(body.toString("utf8")).Id);
          if (verdict.filterList && ures.statusCode === 200) body = Buffer.from(JSON.stringify(ownOnly(verdict.filterList, body.toString("utf8"))));
          if (verdict.network && ures.statusCode === 200) body = Buffer.from(JSON.stringify(edgeRoleForAdapter(JSON.parse(body.toString("utf8")))));
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
    if (IMPORTED) {
      // Nothing is sent anywhere by this step: the importer is a function of the file and of the digests it is given.
      const importOk = await step("compose-imports-to-draft", async () => {
        const count = (level) => imported.report.filter((n) => n.level === level).length;
        const refused = imported.report.filter((n) => n.level === "refused").map((n) => `${n.path} ${n.code}`);
        assert(same([...LOOKUPS], [pinned("wordpress").tag, pinned("mariadb").tag]), "the file names the two versions the built-in template pins", [...LOOKUPS].join(","));
        assert(imported.ok && refused.length === 0, `${COMPOSE_FILE} imports to a draft`, refused.join(" | ") || "no draft");
        info(`import of ${[...LOOKUPS].join(" and ")}: ${count("dropped")} dropped, ${count("changed")} changed, ${count("info")} remarks`);
        const draft = validateAppTemplateSource(imported.source);
        assert(draft.ok && draft.spec.schemaVersion === 2, "the draft is a valid template of the extended format", JSON.stringify(draft.ok ? draft.spec.schemaVersion : draft.errors).slice(0, 300));
        const secrets = draft.spec.parameters.filter((p) => p.type === "secret");
        assert(same(secrets.map((p) => p.key).sort(), Object.values(T.keys).sort()), "its secrets are the three the file asks the platform for", secrets.map((p) => p.key).join(","));
        assert(secrets.every((p) => p.generate != null), "the platform generates every one of them", JSON.stringify(secrets.map((p) => p.generate ?? null)));
        assert(draft.spec.parameters.every((p) => p.customer === false), "the customer's form has no field of this template (a name and a domain are all they give)", draft.spec.parameters.filter((p) => p.customer !== false).map((p) => p.key).join(","));
      });
      if (!importOk) return;
    }
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
      const wp = cName(A, WORDPRESS);
      const siteVolume = appStackVolumeName(A, T.volumes.site);
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
        ["GET", "/v1.45/distribution/alpine:3/json", ""],
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
      info(`engine ${engineVersion}, marker ${marker}, template: ${T.what}${IMPORTED ? "" : ` version ${String(VERSION)}`}, images ${[...IMAGES].join(" ")}`);
    });

    await step("snapshot-before", async () => {
      S0 = await snapshot();
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter(ours);
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    const planOk = await step(IMPORTED ? "plan-compiles-from-draft" : "plan-compiles-from-seed", async () => {
      assert(first.ok, `${T.what} compiles with [] parameters`, JSON.stringify(first.issues));
      planA = ApprovedStackPlanSchema.parse(first.plan);
      assert(planA.schemaVersion === 2, "a plan of the extended format", String(planA.schemaVersion));
      assert(same(planA.components.map((c) => c.key), [T.db, WORDPRESS]), `components [${T.db}, ${WORDPRESS}]`, planA.components.map((c) => c.key).join(","));
      assert(same(planA.ingress, [{ componentKey: WORDPRESS, port: 80 }]), "ingress wordpress:80", JSON.stringify(planA.ingress));
      assert(same(planA.volumes.map((v) => v.key), [T.volumes.database, T.volumes.site]), `volumes [${T.volumes.database}, ${T.volumes.site}]`, JSON.stringify(planA.volumes));
      assert(planA.components.every((c) => /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(c.image)), "every image is a digest reference", planA.components.map((c) => c.image).join(" "));
      // Version 2 starts WordPress with the uploads limit; version 1 and the imported draft keep the image's command.
      const argvOf = (key) => (FIXED && key === WORDPRESS ? UPLOADS_ARGV : null);
      assert(
        planA.components.every((c) => c.profile === "standard" && c.runAsUser === null && same(c.argv, argvOf(c.key))),
        "both on the standard profile and the image user, with the command of the version",
        planA.components.map((c) => `${c.key}:${JSON.stringify(c.argv)}`).join(" "),
      );
      const addressLine = componentOf(planA, WORDPRESS).environment.filter((e) => e.name === "WORDPRESS_CONFIG_EXTRA").length;
      assert(addressLine === (FIXED ? 1 : 0), `the address line ${FIXED ? "is" : "is not"} in the environment of wordpress`, String(addressLine));
      assert(planA.components.every((c) => c.secretFiles.length === 0), "no secretFiles", "some");
      const reads = (key) => componentOf(planA, key).secretEnvironment.map((e) => `${e.name}<-${e.pieces.map((x) => x.parameterKey ?? "literal").join("+")}`);
      assert(same(reads(T.db), READS.db), "the database reads its account and the root password", reads(T.db).join(","));
      assert(same(reads(WORDPRESS), READS.wordpress), "wordpress reads the database account only", reads(WORDPRESS).join(","));
      const written = planA.components.flatMap((c) => c.environment.map((e) => e.name)).filter((name) => /PASSWORD|SECRET|TOKEN|KEY/.test(name));
      assert(written.length === 0, "no written value under a secret-looking name", written.join(","));
    });
    if (!planOk) return;
    const route = (plan, hosts) => ({ plan, routes: [{ componentKey: plan.ingress[0].componentKey, internalPort: plan.ingress[0].port, hosts: hosts.map(hostRoute) }] });
    const DB = cName(A, T.db);
    const WP = cName(A, WORDPRESS);

    if (IMPORTED && !registryCasesEnabled) {
      skip(
        "registry-lookup-reads-only",
        "asks the public registry for the tags of the file (run with HP_ACCEPT_REGISTRY_CASES=1 on a machine with the network); this run imports with the digests the built-in template pins",
      );
    } else if (IMPORTED) {
      await step("registry-lookup-reads-only", async () => {
        // What the API does for the administrator's import: tag to digest through the Engine, with no credentials.
        const mark = gateLog.length;
        for (const image of LOOKUPS) {
          const answer = await adapter.resolveAppStackImage({ image });
          assert(answer.image === image && /^sha256:[0-9a-f]{64}$/.test(answer.digest), `the registry answers a digest for ${image}`, JSON.stringify(answer));
          const used = pinned(image.split(":")[0]).digest;
          info(`${image} -> ${answer.digest}${answer.digest === used ? " (the digest of this run)" : ` (the tag was published again after it was pinned: this run keeps ${used})`}`);
        }
        const sent = gateLog.slice(mark).filter((l) => !/^GET \/(v[\d.]+\/)?(_ping|version) /.test(l));
        assert(
          sent.length === LOOKUPS.size && sent.every((l) => /^GET \/(v[\d.]+\/)?distribution\//.test(l) && l.endsWith(" -> forward")),
          "one read per tag and no other request",
          sent.join(" | "),
        );
      });
    }

    await step("refused-before-docker", async () => {
      const mark = gateLog.length;
      const db = componentOf(planA, T.db);
      const refusals = [
        ["a capability list on a component", withComponent(planA, T.db, { capAdd: ["NET_ADMIN"] }), "STACK_PLAN_INVALID"],
        ["a run profile outside the closed list", withComponent(planA, T.db, { profile: "privileged" }), "STACK_PLAN_INVALID"],
        ["an image named by tag", withComponent(planA, T.db, { image: `${db.image.split("@")[0]}:1` }), "STACK_PLAN_INVALID"],
        ["a host path", withComponent(planA, T.db, { volumes: [{ ...db.volumes[0], hostPath: "/" }] }), "STACK_PLAN_INVALID"],
        ["the Docker socket as a mount target", withComponent(planA, T.db, { volumes: [{ ...db.volumes[0], containerPath: DOCKER_SOCK }] }), "STACK_PLAN_INVALID"],
        ["a published host port", withComponent(planA, T.db, { publish: [{ hostPort: 3306 }] }), "STACK_PLAN_INVALID"],
        ["a password written in the plan", withComponent(planA, T.db, { environment: [...db.environment, { name: "MARIADB_PASSWORD", value: "x" }] }), "STACK_PLAN_INVALID"],
        ["memory over the ceiling", withComponent(planA, T.db, { resources: { ...db.resources, memoryBytes: "17179869185" } }), "STACK_PLAN_INVALID"],
        [
          "content changed after approval",
          { ...planA, components: planA.components.map((c) => (c.key === T.db ? { ...c, resources: { ...c.resources, cpuMilli: 2000 } } : c)) },
          "STACK_PLAN_HASH_MISMATCH",
        ],
      ];
      for (const [what, plan, reason] of refusals) {
        const err = await rejection(adapter.prepareAppStack({ plan }));
        assert(err?.reason === reason, `${what} refused as ${reason}`, err ? reasonOf(err) : "accepted");
      }
      const entries = [
        ["a create without the secrets", undefined, "STACK_SECRET_MISSING"],
        ["a create with one secret only", SECRET_CONTENTS.slice(0, 1), "STACK_SECRET_MISSING"],
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
      assert(same(out.prepare.volumes.map((v) => `${v.volumeKey}:${String(v.created)}`).sort(), [`${T.volumes.database}:true`, `${T.volumes.site}:true`]), "two volumes created", JSON.stringify(out.prepare.volumes));
      assert(out.create.components.every((c) => c.outcome === "created") && out.create.components.length === 2, "two components created", JSON.stringify(out.create));
      assert(out.starts.every((s) => s.outcome === "started"), "the database, then wordpress started", JSON.stringify(out.starts));
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
          Entrypoint: same(c.Config.Entrypoint ?? null, img.Config.Entrypoint ?? null) && same(c.Config.Cmd ?? null, comp.argv ?? img.Config.Cmd ?? null),
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
      assert(heldBy(READS.db).every((e) => dbEnv.includes(e)), "the database holds its account and the root password in its environment", "missing");
      assert(heldBy(READS.wordpress).every((e) => wpEnv.includes(e)), "wordpress holds the database account in its environment", "missing");
      assert(leakedWindows(wpEnv.join("\n"), ROOT_PASSWORD) === 0, "wordpress holds no part of the root password", "found");
      for (const name of [DB, WP]) {
        const c = await inspectOf(name);
        const outside = JSON.stringify({ ...c, Config: { ...c.Config, Env: [] } });
        assert(!leaks(outside), `${name}: a secret appears in its environment only (no label, command, mount or path)`, "found elsewhere");
      }
      // The values work, each for the account the template gave it and for no other.
      const login = (user, password) => phpIn(WP, DB_LOGIN, [T.db, user, password]);
      await until("the database accepts the application account", 60_000, () => login(T.dbUser, DB_PASSWORD), 2_000);
      assert(await login("root", ROOT_PASSWORD), "the root password opens the root account", "refused");
      const wrong = [[T.dbUser, ROOT_PASSWORD], ["root", DB_PASSWORD], ["root", ""], [T.dbUser, ""]];
      for (const [user, password] of wrong) {
        const who = user === "root" ? "root" : "the application account";
        assert(!(await login(user, password)), `${who} is refused with ${password === "" ? "no password" : "the other secret"}`, "accepted");
      }
      // The copies the executor keeps to mask the logs: one per reference, readable by the executor only, mounted nowhere.
      const expected = planA.components.flatMap((c) => entriesFor(planA, c.key).map((e) => `${appStackSecretDirKey(A, c.key)}/${e.parameterKey}`)).sort();
      assert(same(await secretFiles(), expected), "the executor keeps one copy per component and secret, for the log masking", (await secretFiles()).join(","));
      const modes = await Promise.all([secretsRoot, ...planA.components.map((c) => path.join(secretsRoot, appStackSecretDirKey(A, c.key)))].map(async (d) => (await stat(d)).mode & 0o777));
      assert(modes.every((mode) => mode === 0o700), "their directories are closed to every other user (0700)", modes.map((mode) => mode.toString(8)).join(","));
      assert(!leaks(JSON.stringify(await status())), "the status answer holds no part of a secret", "found");
    });

    await step("network-shape", async () => {
      // Docker holds the edge role under the name the gate gives it (see EDGE_ROLE_IN_DOCKER); the adapter read app_edge.
      for (const [name, role, internal] of [[appStackInternalNetworkName(A), "app_internal", true], [appStackEdgeNetworkName(A), EDGE_ROLE_IN_DOCKER, false]]) {
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
      assert(same(await nets(T.db), [appStackInternalNetworkName(A)]), "the database is on the private network only", (await nets(T.db)).join(","));
      assert(same(await nets(WORDPRESS), namesOf(planA).networks), "wordpress is on the private and the edge network", (await nets(WORDPRESS)).join(","));
      // What the executor of a live panel asks Docker before it attaches its proxy: this run's network is not in the answer.
      const edgeRoleList = await lines(["network", "ls", "--filter", `label=${ROLE_LABEL}=${EDGE_ROLE}`, "--format", "{{.Name}}"]);
      assert(!edgeRoleList.some(ours), "Docker's own list of the networks with the edge role does not hold this run's network", edgeRoleList.filter(ours).join(","));
    });

    await step("no-control-plane-reach", async () => {
      const opens = (host, port) => phpIn(WP, TCP_OPENS, [host, String(port)]);
      const gateways = [];
      for (const n of Object.keys((await inspectOf(WP)).NetworkSettings.Networks)) {
        const gw = (await networkOf(n)).IPAM?.Config?.[0]?.Gateway;
        if (gw) gateways.push(gw);
      }
      assert(gateways.length > 0, "wordpress has at least one network gateway to probe", "none");
      assert(await opens(T.db, 3306), "control: wordpress reaches its own database by the component name (so a refusal below is a real one)", "failed");
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
      assert(healthOf(await status(), WORDPRESS) === "healthy", "wordpress is healthy before its route is published", "not healthy");
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

    if (IMPORTED) {
      for (const name of ["address-follows-host", "no-redirect-loop", "uploads-limit"]) {
        skip(name, "the imported draft is the administrator's file: it sets neither the address line nor the uploads limit of the built-in template");
      }
    } else {
      await step("address-follows-host", async () => {
        // The application gets a second name: the site answers it as itself, not as the name it was installed on.
        const r = await adapter.publishAppStackRoutes(route(planA, [HOST1, HOST2]));
        assert(r.changed === true && same([...r.hostnames].sort(), [HOST1, HOST2].sort()), "the publish adds the second host", JSON.stringify(r));
        const home = await until(`${HOST2} is routed by the proxy`, 30_000, async () => {
          const res = await viaProxy(HOST2, "/");
          return res.status !== 0 && res.status !== 404 ? res : null;
        });
        assert(home.status === 200 && home.body.includes(TITLE), `${HOST2}/ answers the home page with 200, not a redirect to ${HOST1}`, `${String(home.status)} ${home.location}`);
        const assets = [...home.body.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)=["']([^"']+)["']/gi)].map((x) => x[1]);
        assert(assets.some((a) => a.includes(`//${HOST2}/`)), `the page's style and script addresses name ${HOST2}`, assets.slice(0, 5).join(" "));
        assert(!home.body.includes(HOST1), `the page names ${HOST1} nowhere`, assets.filter((a) => a.includes(HOST1)).slice(0, 3).join(" ") || "in its text");
        const login = await viaProxy(HOST2, "/wp-login.php");
        const action = (login.body.match(/<form\b[^>]*\bloginform\b[^>]*>/i)?.[0] ?? "").match(/\baction=["']([^"']+)["']/i)?.[1] ?? "";
        assert(login.status === 200 && action !== "" && new URL(action.replaceAll("&amp;", "&"), `http://${HOST2}/`).host === HOST2, `the login form of ${HOST2} posts to ${HOST2}`, `${String(login.status)} ${action}`);
        const first = await viaProxy(HOST1, "/");
        assert(first.status === 200 && first.body.includes(`//${HOST1}/`) && !first.body.includes(HOST2), `${HOST1} still answers as itself`, String(first.status));
      });

      await step("no-redirect-loop", async () => {
        // Where a visitor of the second name is sent: never to the first name, and to a page within five redirects.
        for (const start of ["/", "/wp-admin/", "/wp-login.php"]) {
          let host = HOST2;
          let target = start;
          const hops = [];
          for (;;) {
            const res = await viaProxy(host, target);
            if (res.status < 300 || res.status >= 400) {
              assert(res.status === 200, `${HOST2}${start} ends on a page`, `${String(res.status)} after ${hops.join(" -> ") || "no redirect"}`);
              break;
            }
            const next = new URL(res.location, `http://${host}${target}`);
            hops.push(next.href);
            assert(next.host !== HOST1, `${HOST2}${start} never sends the visitor to ${HOST1}`, hops.join(" -> "));
            assert(next.protocol === "http:" && next.host === HOST2, `${HOST2}${start} stays on ${HOST2}, over http`, hops.join(" -> "));
            assert(hops.length <= 5, `${HOST2}${start} reaches a page within five redirects`, hops.join(" -> "));
            host = next.host;
            target = `${next.pathname}${next.search}`;
          }
        }
      });

      await step("uploads-limit", async () => {
        // The limits of the web server's PHP, read by a page of this run written into the site's volume and removed in
        // this step. The PHP command line reads php.ini only: what it says proves nothing about the site.
        const file = `/var/www/html/hp-limits-${hex}.php`;
        const page = '<?php echo ini_get("upload_max_filesize"), " ", ini_get("post_max_size");';
        assert(await phpIn(WP, "exit(file_put_contents($argv[1], $argv[2]) === false ? 1 : 0);", [file, page]), "the page is written into the site", "refused");
        let answer;
        try {
          answer = await served(HOST1, `/${path.basename(file)}`, 200, () => true, 30_000);
        } finally {
          const removed = await phpIn(WP, "exit(unlink($argv[1]) ? 0 : 1);", [file]);
          if (!removed) info(`${path.basename(file)} could not be removed from the site volume (it goes with the volume)`);
        }
        const cli = (await docker(["exec", WP, "php", "-r", 'echo ini_get("upload_max_filesize"), " ", ini_get("post_max_size");'], 30_000)).trim();
        info(`the PHP command line reads ${cli} (php.ini only), the web server ${answer.body.trim().slice(0, 40)}`);
        assert(answer.body.trim() === "64M 64M", "the web server's PHP takes uploads of up to 64 MB (upload_max_filesize post_max_size)", answer.body.trim().slice(0, 80));
        const gone = await viaProxy(HOST1, `/${path.basename(file)}`);
        assert(gone.status === 404, "the page is gone from the site", String(gone.status));
      });
    }

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
      const masked = JSON.stringify(await adapter.getAppStackComponentLogs({ stackId: A, organizationId: ORG, componentKey: WORDPRESS, tail: 50 }));
      assert(masked.includes(tag), "the product's log reader returns the line of that request", "absent");
      assert(!leaks(masked) && masked.includes("[REDACTED]"), "with the password hidden", leaks(masked) ? "password found" : "no mask");
      const dbLog = JSON.stringify(await adapter.getAppStackComponentLogs({ stackId: A, organizationId: ORG, componentKey: T.db, tail: 200 }));
      assert(!leaks(dbLog), "the database log holds no part of a secret", "found");
      if (T.keys.user !== null) {
        // The database image writes the account it creates on its output: a generated account is a secret like the others.
        const own = await docker(["logs", DB]);
        info(`the database's own log ${own.includes(T.dbUser) ? "names the generated account, the product's reader hides it" : "does not name the generated account"}`);
      }
    });

    await step("data-survives-stop-and-start", async () => {
      const stop = await adapter.stopAppStack({ stackId: A, organizationId: ORG });
      assert(same(stop.components.map((c) => `${c.componentKey}:${c.outcome}`), [`${WORDPRESS}:stopped`, `${T.db}:stopped`]), "stop: wordpress, then the database", JSON.stringify(stop));
      const s = await status();
      assert([T.db, WORDPRESS].every((k) => healthOf(s, k) === "stopped"), "both reported stopped", JSON.stringify(s.components));
      const noSecret = await rejection(adapter.startAppStackComponent({ plan: planA, componentKey: T.db, secretFileContents: [] }));
      assert(noSecret?.reason === "STACK_SECRET_MISSING", "a start without the secrets is refused as STACK_SECRET_MISSING", noSecret ? reasonOf(noSecret) : "accepted");
      for (const c of planA.components) {
        if (c.dependsOn.length > 0) await waitHealthy(c.dependsOn);
        const started = await adapter.startAppStackComponent(startReq(planA, c.key));
        assert(started.outcome === "started", `${c.key} starts again`, JSON.stringify(started));
      }
      await waitHealthy([T.db, WORDPRESS]);
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
      const db = componentOf(planA, T.db);
      const next = withComponent({ ...planA, revisionId: `srev_swarmtest_${hex}_2` }, T.db, { resources: { ...db.resources, memoryBytes: String(640 * 1024 * 1024) } });
      const ids0 = await idsOf(planA);
      const file0 = await fileState(routeFile);
      const created0 = (await volumeOf(appStackVolumeName(A, T.volumes.database))).CreatedAt;
      const out = await deploy(next, planA);
      planA = next;
      const outcomes = out.create.components.map((c) => `${c.componentKey}:${c.outcome}`);
      assert(same(outcomes, [`${T.db}:replaced`, `${WORDPRESS}:unchanged`]), "only the database is replaced", outcomes.join(","));
      assert(same(out.starts.map((s) => s.outcome), ["started", "restarted"]), "the database started, wordpress restarted after it", JSON.stringify(out.starts));
      const ids1 = await idsOf(planA);
      assert(ids1[DB] !== ids0[DB] && ids1[WP] === ids0[WP], "the database Id changes, the wordpress Id stays", JSON.stringify({ ids0, ids1 }));
      assert((await inspectOf(DB)).HostConfig.Memory === 640 * 1024 * 1024, "the new database container has the new memory limit", "other");
      assert((await volumeOf(appStackVolumeName(A, T.volumes.database))).CreatedAt === created0, "the database volume is the one created at install", "recreated");
      assert(same(await fileState(routeFile), file0), "the route file is unchanged", "changed");
      await siteAnswers();
    });

    await step("recovery-reads-only", async () => {
      const fresh = new DockerEngineSocketAdapter(adapterOptions);
      const mark = gateLog.length;
      const s = await status(fresh);
      assert(same(s.components.map((c) => c.componentKey), [T.db, WORDPRESS]), "a fresh adapter reports both components", JSON.stringify(s.components));
      const other = gateLog.slice(mark).filter((l) => !l.startsWith("GET "));
      assert(gateLog.length > mark && other.length === 0, "the recovery read sends GET requests only", other.join(" | "));
    });

    await step("remove-keeps-volumes", async () => {
      const volumes = namesOf(planA).volumes;
      const created = await Promise.all(volumes.map(async (v) => (await volumeOf(v)).CreatedAt));
      const attached = Object.values((await networkOf(appStackEdgeNetworkName(A))).Containers ?? {}).map((c) => String(c.Name));
      assert(attached.every(ours), "only this run's containers are on the edge network", attached.filter((n) => !ours(n)).join(","));
      const unpublished = await adapter.unpublishAppStackRoutes({ stackId: A, organizationId: ORG });
      assert(unpublished.changed === true && !(await exists(routeFile)), "the route file is withdrawn", JSON.stringify(unpublished));
      const mark = gateLog.length;
      const r = await adapter.removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: false });
      assert(same(r.removedComponents, [WORDPRESS, T.db]), "wordpress and the database removed", JSON.stringify(r));
      assert(same([...r.removedNetworks].sort(), ["app_edge", "app_internal"]), "both networks removed", JSON.stringify(r.removedNetworks));
      assert(same([...r.retainedVolumes].sort(), [T.volumes.database, T.volumes.site]) && r.removedVolumes.length === 0, "both volumes kept", JSON.stringify(r));
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
      assert(same([...r.removedVolumes].sort(), [T.volumes.database, T.volumes.site]) && r.removedComponents.length === 0, "the second removal deletes the two volumes", JSON.stringify(r));
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
