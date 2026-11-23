#!/usr/bin/env node
/**
 * Real-Docker check of the backup and restore of an application (ADR-0038) through the PRODUCTION
 * DockerEngineSocketAdapter from apps/docker-executor/dist, on a local destination made like HP_BACKUP_LOCAL_ROOT:
 * a running application is refused, one snapshot holds every data volume, the job containers carry only the designed
 * privileges, the repository is ciphertext under the application's own folder, a restore brings back content, owners,
 * modes and links, the owner and mode of each volume's own folder too, and deletes what the backup does not hold, the
 * application reads its data again, a forget removes the snapshot. The files are seeded and read back by throwaway containers of this script, never by the adapter.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: the stack id stk_swarmtest_<hex>_a, so every container, network and volume
 *    name the engine derives contains swarmtest_<hex>; the job ids are op_<hex><24 random hex>, so every job container
 *    is hp_bk_op_<hex>...; the script's own containers and paths use the prefix hp_swarmtest_<hex>.
 *  - The adapter talks only to a gate socket in the temp dir. Its default-deny judge() forwards a request to
 *    /var/run/docker.sock only when every hp_ name in the URL and body is this run's, the object is this run's (name or
 *    a container id the gate saw created), and the create bodies keep the hardening; list answers are filtered to this
 *    run's objects. It never pulls. The first steps prove that it denies foreign and unsafe requests.
 *  - The destination test of the adapter names its container hp_bk_test_<16 random hex> by itself: the gate takes that
 *    one name only while this script asks for the test, and only with the body of a test of this run's destination.
 *  - The stack has no address, so no edge network exists and no proxy can be attached to anything; the routes are never
 *    published. No host port is published. Every job container has no network at all.
 *  - Every adapter directory and name option points into the temp dir, /dev/shm/hp_swarmtest_<hex>-secrets or a
 *    nonexistent own *_unused name. The backup key and the destination are this run's, in the temp dir.
 *  - The job containers carry the role site_job, as the product's do: a live executor that restarts while this script
 *    runs removes them, and the run then fails without harm. Run it when the panel is not being restarted.
 *  - The docker CLI (an independent observer) is called with an argv array only, and refuses any argument naming an
 *    hp_ object of another run; inspect/exec/logs/rm/run only ever name this run's objects.
 *  - Small resources: 100 millicpu and 32 MiB for the component, about 300 KiB of data, two small images.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): removeAppStack(..., removeVolumes: true), then leftovers
 *    by exact own names (rm -f, network rm, volume rm), gate closed, temp dirs removed.
 *
 * Run: corepack pnpm -C apps/docker-executor run build, then node infra/linux/accept-app-stack-backups.mjs
 * (needs the two images below locally: this script never pulls). Steps print PASS/FAIL/SKIP <step>; final line
 * RESULT n/m passed (a skipped step is never a pass and is not counted in n/m).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (p) => pathToFileURL(path.resolve(repoRoot, p)).href;
const { DockerEngineSocketAdapter, appStackContainerName, appStackInternalNetworkName, appStackVolumeName } = await import(
  dist("apps/docker-executor/dist/index.js")
);
const { computeAppStackPlanHash } = await import(dist("packages/hosting-domain/dist/index.js"));
const { RESTIC_IMAGE } = await import(dist("packages/contracts/dist/index.js"));

const IMAGE = "busybox@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6";
const PULL_HINTS = {
  [IMAGE]: "docker pull busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6",
  [RESTIC_IMAGE]: `docker pull ${RESTIC_IMAGE}`,
};
const ALPINE = "alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf";
const IMAGES = new Set([IMAGE, RESTIC_IMAGE]);
const USER = "65534:65534";
const MEMORY = 33_554_432;
const DOCKER_SOCK = "/var/run/docker.sock";
const ROLE_LABEL = "io.hostingpanel.network_role";
const BACKUP_OF_LABEL = "io.hostingpanel.app_backup_of";
const STACK_ID_LABEL = "io.hostingpanel.stack_id";
const COPY_CAPS = ["DAC_READ_SEARCH"];
const RESTORE_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"];
const HOST_KEYS = ["PortBindings", "Devices", "PidMode", "IpcMode", "UsernsMode"];
const UID = process.getuid();
const GID = process.getgid();
const hex = randomBytes(4).toString("hex");
const marker = `swarmtest_${hex}`;
const jobMarker = `hp_bk_op_${hex}`;
const runPrefix = `hp_swarmtest_${hex}`;
const secretsRoot = `/dev/shm/${runPrefix}-secrets`;
const ORG = `org_swarmtest_${hex}`;
const [A, B] = ["a", "b"].map((s) => `stk_swarmtest_${hex}_${s}`);
const STACKS = [A, B];
const VOLUME_KEYS = ["data", "media"];
const BACKUP_KEY = randomBytes(32).toString("hex"); // hex: can never form an hp_ token
const NEEDLE = `needle-${randomBytes(12).toString("hex")}`;
const TARGET = { kind: "local", targetId: `bkt_${randomBytes(16).toString("hex")}` };
const TEST_NAME = /^hp_bk_test_[0-9a-f]{16}$/;
const JOB_NAME = /^hp_bk_(op_[0-9a-f]{32}(?:-apply|-forget)?)_(repo|up|drop|forget|rs)(?:_([a-z][a-z0-9-]*))?$/;
const newJobId = () => `op_${hex}${randomBytes(12).toString("hex")}`;

// ---- plan: one component, two data volumes, no address (so no edge network) ----
const RES = { cpuMilli: 100, memoryBytes: String(MEMORY) };
const app = {
  key: "app",
  image: IMAGE,
  runAsUser: USER,
  argv: ["sleep", "3600"],
  environment: [],
  secretFiles: [],
  resources: RES,
  expose: [],
  dependsOn: [],
  volumes: [
    { volumeKey: "data", containerPath: "/data", readOnly: false },
    { volumeKey: "media", containerPath: "/media", readOnly: false },
  ],
  healthcheck: null,
};
const rehash = (plan) => ({ ...plan, planHash: computeAppStackPlanHash(plan) });
const planA = rehash({
  schemaVersion: 1,
  stackId: A,
  organizationId: ORG,
  hostAllocationId: `alloc_swarmtest_${hex}`,
  templateVersionId: `atv_swarmtest_${hex}`,
  revisionId: `srev_swarmtest_${hex}_1`,
  planHash: "0".repeat(64),
  components: [app],
  volumes: VOLUME_KEYS.map((key) => ({ key })),
  ingress: [],
});
const cName = appStackContainerName;
const APP = cName(A, "app");

// ---- the files this script puts in the volumes, and how it reads them back ----
// Owners the application does not have, a closed file, a link, an empty directory, a setuid file and a setgid directory.
const SEED_SCRIPT = String.raw`set -eu
cd /data
mkdir private other empty shared
printf '%s\n' "$1" > private/notes.txt
printf 'public %s\n' "$1" > public.txt
head -c 4096 /dev/urandom > other/closed.bin
printf '#!/bin/sh\nexit 0\n' > run.sh
ln -s public.txt link
head -c 262144 /dev/urandom > /media/blob.bin
chown -R 65534:65534 /data /media
chown -h 65534:65534 link
chown -R 1001:1002 other
chmod 700 private other
chmod 600 private/notes.txt
chmod 644 public.txt
chmod 400 other/closed.bin
chmod 4755 run.sh
chmod 2770 shared
chmod 750 /data
chmod 640 /media/blob.bin
chmod 700 /media`;
const DAMAGE_SCRIPT = String.raw`set -eu
cd /data
rm private/notes.txt
printf 'added after the backup\n' > extra.txt
printf 'changed\n' > public.txt
rm link
ln -s extra.txt link
chmod 777 other
chown 0:0 other/closed.bin
chmod 755 run.sh
rmdir empty
mkdir newdir
printf x > newdir/file
chown 0:0 /data
chmod 755 /data
rm /media/blob.bin
chmod 755 /media`;
// One line per entry: R = the volume's own folder, L = link, D = directory (its time apart, as m=), F = file, O = other.
const FINGERPRINT_SCRIPT = String.raw`set -eu
cd /v
printf 'R %s\n' "$(stat -c '%u:%g %a' .)"
find . -mindepth 1 | sort | while IFS= read -r f; do
  if [ -L "$f" ]; then printf 'L %s %s %s\n' "$f" "$(stat -c '%u:%g' "$f")" "$(readlink "$f")"
  elif [ -d "$f" ]; then printf 'D %s %s m=%s\n' "$f" "$(stat -c '%u:%g %a' "$f")" "$(stat -c '%Y' "$f")"
  elif [ -f "$f" ]; then printf 'F %s %s %s\n' "$f" "$(stat -c '%u:%g %a %s %Y' "$f")" "$(sha256sum "$f" | cut -c1-64)"
  else printf 'O %s %s\n' "$f" "$(stat -c '%u:%g %a %F' "$f")"
  fi
done`;

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

// ---- what is this run's ----
let tmpDir = null;
let localRoot = null;
let ingressRoot = null;
const ownIds = new Set(); // container ids the gate saw created, and the name of the destination test container
const isOwn = (ref) => ref.includes(marker) || ref.includes(jobMarker) || ownIds.has(ref);
const targetDir = () => path.join(localRoot, TARGET.targetId);
const repoDirOf = (stackId) => path.join(targetDir(), "stacks", stackId);

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
  });
}
/** The only docker CLI door: no hp_ name of another run, and object verbs only on this run's objects. */
async function docker(args, timeout = 120_000) {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !isOwn(t));
  const objectVerb =
    ["inspect", "exec", "logs", "rm", "run"].includes(args[0]) || (["network", "volume"].includes(args[0]) && ["inspect", "rm"].includes(args[1]));
  if (foreign.length > 0 || (objectVerb && !args.some((a) => isOwn(a)))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout);
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();

let observers = 0;
const HARDENED = ["--pull", "never", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only"];
/** A throwaway busybox container of this script: root with only the capabilities named, no network. */
function observe(what, { caps = [], mounts, script, args = [] }) {
  observers += 1;
  return docker([
    "run", "--rm", "--name", `${runPrefix}_${String(observers)}_${what}`, ...HARDENED, "--user", "0:0",
    ...caps.flatMap((c) => ["--cap-add", c]), ...mounts.flatMap((m) => ["-v", m]), IMAGE, "sh", "-c", script, "sh", ...args,
  ]);
}
/** restic run by this script as this user, reading the application's repository through a read-only mount. */
function resticRead(what, args) {
  observers += 1;
  return docker([
    "run", "--rm", "--name", `${runPrefix}_${String(observers)}_${what}`, ...HARDENED, "--user", `${String(UID)}:${String(GID)}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "-v", `${repoDirOf(A)}:/repo:ro`, "-v", `${path.join(tmpDir, "backup.key")}:/run/secrets/backup.key:ro`,
    "-e", "RESTIC_PASSWORD_FILE=/run/secrets/backup.key", "-e", "RESTIC_CACHE_DIR=/tmp/cache", "-e", "RESTIC_REPOSITORY=/repo",
    "--entrypoint", "/usr/bin/restic", RESTIC_IMAGE, ...args,
  ]);
}
async function fingerprint(volumeKey) {
  const out = await observe(`fp_${volumeKey}`, { caps: COPY_CAPS, mounts: [`${appStackVolumeName(A, volumeKey)}:/v:ro`], script: FINGERPRINT_SCRIPT });
  const all = out.split("\n").filter(Boolean);
  return { root: all.find((l) => l.startsWith("R ")) ?? "", entries: all.filter((l) => !l.startsWith("R ")) };
}
const withoutDirTimes = (entries) => entries.map((l) => l.replace(/ m=\d+$/, ""));

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
const ownNames = (s) => ({
  containers: s.containers.filter((l) => isOwn(l.split(" ")[1])).map((l) => l.split(" ")[1]).sort(),
  networks: s.networks.filter((l) => l.includes(marker)).map((l) => l.split(" ")[1]).sort(),
  volumes: s.volumes.filter((l) => l.includes(marker)).sort(),
});

// ---- gate ----
let gateServer = null;
let expectTest = false; // true only while this script asks the adapter for the destination test
const gateLog = [];
const gateDenied = [];
const created = []; // { name, body } of every container create the gate forwarded
const deny = (why) => ({ kind: "deny", why });
const fwd = (extra = {}) => ({ kind: "forward", ...extra });
const hardeningProblem = (h) =>
  h.Privileged === true
    ? "privileges"
    : !same(h.CapDrop, ["ALL"]) || !(h.SecurityOpt ?? []).includes("no-new-privileges:true") || h.ReadonlyRootfs !== true
      ? "hardening"
      : HOST_KEYS.some((k) => h[k] !== undefined)
        ? "host access"
        : null;
const isSecretBind = (b) => b.startsWith(`${secretsRoot}/`) && b.endsWith(":ro");

/** null = a component of this run's stack: every hardening property, only its own network, volumes and secret files. */
function componentBodyProblem(body) {
  const h = body.HostConfig ?? {};
  if (body.Image !== IMAGE) return "image";
  if (h.CapAdd !== undefined) return "privileges";
  if (hardeningProblem(h) !== null) return hardeningProblem(h);
  if (!String(h.NetworkMode).includes(marker)) return "network mode";
  if ((h.Binds ?? []).some((b) => !isSecretBind(b))) return "bind";
  if ((h.Mounts ?? []).some((m) => m.Type !== "volume" || !String(m.Source).includes(marker))) return "mount";
  return Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}).some((k) => !k.includes(marker)) ? "endpoint" : null;
}

/** null = a restic job of one application of this run: no network, its own repository folder, the privileges of its kind. */
function jobBodyProblem(name, body) {
  const h = body.HostConfig ?? {};
  const labels = body.Labels ?? {};
  const [, , kind, key] = name.match(JOB_NAME) ?? [];
  const stackId = labels[BACKUP_OF_LABEL];
  if (kind === undefined || (kind === "rs") !== (key !== undefined)) return "job name";
  if (body.Image !== RESTIC_IMAGE) return "image";
  if (body.User !== "0:0") return "user";
  if (hardeningProblem(h) !== null) return hardeningProblem(h);
  if (h.Privileged !== false || h.NetworkMode !== "none") return "network mode";
  if (!STACKS.includes(stackId) || labels["io.hostingpanel.role"] !== "site_job" || labels[STACK_ID_LABEL] !== undefined) return "labels";
  const wanted = kind === "up" ? COPY_CAPS : kind === "rs" ? RESTORE_CAPS : undefined;
  if (!same(h.CapAdd, wanted)) return "capabilities";
  const volumeBinds = (h.Binds ?? []).filter((b) => !isSecretBind(b));
  const copyBind = (k) => `${appStackVolumeName(stackId, k)}:/data/${k}:ro`;
  const bindsOk =
    kind === "up"
      ? volumeBinds.length > 0 && volumeBinds.every((b) => VOLUME_KEYS.some((k) => b === copyBind(k)))
      : kind === "rs"
        ? VOLUME_KEYS.includes(key) && same(volumeBinds, [`${appStackVolumeName(stackId, key)}:/data/${key}`])
        : volumeBinds.length === 0;
  if (!bindsOk) return "bind";
  const [mount, ...more] = h.Mounts ?? [];
  const mountOk =
    more.length === 0 &&
    mount?.Type === "bind" &&
    mount.Source === repoDirOf(stackId) &&
    mount.Target === `/backup/repository/stacks/${stackId}` &&
    mount.ReadOnly === (kind === "rs");
  if (!mountOk) return "mount";
  return same(h.GroupAdd, [String(GID)]) ? null : "groups";
}

/** null = the adapter's test of this run's destination: this user, no network, only the destination's panel folder. */
function testBodyProblem(body) {
  const h = body.HostConfig ?? {};
  const labels = body.Labels ?? {};
  if (body.Image !== RESTIC_IMAGE) return "image";
  if (body.User !== `${String(UID)}:${String(GID)}`) return "user";
  if (hardeningProblem(h) !== null) return hardeningProblem(h);
  if (h.Privileged !== false || h.NetworkMode !== "none" || h.CapAdd !== undefined) return "privileges";
  if (labels["io.hostingpanel.role"] !== "site_job" || labels[STACK_ID_LABEL] !== undefined) return "labels";
  if ((h.Binds ?? []).some((b) => !isSecretBind(b))) return "bind";
  const [mount, ...more] = h.Mounts ?? [];
  const mountOk = more.length === 0 && mount?.Type === "bind" && mount.Source === path.join(targetDir(), "panel") && mount.Target === "/backup/repository/panel";
  if (!mountOk) return "mount";
  return same(h.GroupAdd, [String(GID)]) ? null : "groups";
}

function createProblem(name, body, bodyText) {
  if (leakedWindows(bodyText, BACKUP_KEY) > 0) return "secret in body";
  if (TEST_NAME.test(name)) return expectTest ? testBodyProblem(body) : "unexpected destination test";
  if (name.includes(jobMarker)) return jobBodyProblem(name, body);
  return name.includes(marker) ? componentBodyProblem(body) : "unnamed or foreign container";
}

/** Default deny: "forward" (optionally registering the created container or filtering a list) or "deny". */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const query = decodeURIComponent(u.search);
  const creating = method === "POST" && p === "/containers/create" ? (u.searchParams.get("name") ?? "") : null;
  const testName = creating !== null && expectTest && TEST_NAME.test(creating) ? creating : null;
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0]).filter((t) => !isOwn(t) && t !== testName);
  if (foreign.length > 0) return deny(`names ${foreign[0]}`);
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  let m;
  if (method === "GET" && (p === "/_ping" || p === "/version" || p === "/info")) return fwd();
  if (method === "GET" && (m = p.match(/^\/images\/(.+)\/json$/))) return IMAGES.has(m[1]) ? fwd() : deny("image");
  if (method === "GET" && ["/containers/json", "/networks", "/volumes"].includes(p)) return fwd({ filterList: p });
  if (method === "POST" && p === "/networks/create") {
    const ok =
      String(body.Name).includes(marker) &&
      [undefined, "bridge"].includes(body.Driver) &&
      body.Options?.["com.docker.network.bridge.name"] === undefined &&
      body.Labels?.[ROLE_LABEL] === "app_internal";
    return ok ? fwd() : deny("network create");
  }
  if (method === "POST" && p === "/volumes/create") {
    const ok = String(body.Name).includes(marker) && body.DriverOpts === undefined && [undefined, "local"].includes(body.Driver);
    return ok ? fwd() : deny("volume create");
  }
  if (creating !== null) {
    const problem = createProblem(creating, body, bodyText);
    return problem === null ? fwd({ register: creating }) : deny(problem);
  }
  if (method === "POST" && (m = p.match(/^\/networks\/([^/]+)\/(?:connect|disconnect)$/))) {
    return isOwn(m[1]) && isOwn(String(body.Container ?? "")) ? fwd() : deny("network attach of a foreign object");
  }
  if ((m = p.match(/^\/containers\/([^/]+)(?:\/(json|logs|start|stop|restart|kill|wait))?$/)) && isOwn(m[1])) {
    const sub = m[2];
    if (method === (sub === undefined ? "DELETE" : sub === "json" || sub === "logs" ? "GET" : "POST")) return fwd();
  }
  if ((m = p.match(/^\/(?:networks|volumes)\/([^/]+)$/)) && isOwn(m[1])) {
    if (method === "GET" || (method === "DELETE" && !u.searchParams.has("force"))) return fwd();
  }
  return deny("not an allowed request");
}

/** A list answer with this run's objects only. */
function ownOnly(listPath, text) {
  const data = JSON.parse(text);
  if (listPath === "/volumes") return { ...data, Volumes: (data.Volumes ?? []).filter((v) => String(v.Name).includes(marker)) };
  if (listPath === "/networks") return data.filter((x) => String(x.Name).includes(marker));
  return data.filter((x) => isOwn(String(x.Names?.[0] ?? "").replace(/^\//, "")));
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
      if (verdict.register !== undefined) {
        created.push({ name: verdict.register, body: JSON.parse(bodyText) });
        // The adapter removes a container by name when the create answer is lost: the test's name is own from here on.
        if (TEST_NAME.test(verdict.register)) ownIds.add(verdict.register);
      }
      const headers = { ...req.headers, host: "docker" };
      delete headers["transfer-encoding"];
      if (bodyText.length > 0 || req.method === "POST") headers["content-length"] = String(Buffer.byteLength(bodyText));
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.register !== undefined && ures.statusCode === 201) ownIds.add(JSON.parse(body.toString("utf8")).Id);
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
      up.end(bodyText);
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
let swept = false;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (adapter) {
      await adapter
        .removeAppStack({ stackId: A, organizationId: ORG, removeVolumes: true })
        .catch((err) => console.log(`INFO cleanup ${A}: ${reasonOf(err)}`));
    }
    const leftContainers = [
      ...(await lines(["ps", "-a", "--filter", `name=${marker}`, "--format", "{{.Names}}"]).catch(() => [])),
      ...(await lines(["ps", "-a", "--filter", `name=${jobMarker}`, "--format", "{{.Names}}"]).catch(() => [])),
      ...[...ownIds].filter((n) => TEST_NAME.test(n) && created.some((c) => c.name === n)),
    ].filter((n) => isOwn(n));
    for (const name of leftContainers) {
      await docker(["rm", "-f", name]).catch((err) => {
        if (!/No such container/.test(err.message)) console.log(`INFO cleanup: ${err.message}`);
      });
    }
    for (const [list, remove] of [
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
      if (!dir) continue;
      let failed = await rm(dir, { recursive: true, force: true }).then(() => null, (err) => err);
      if (failed && dir === tmpDir && localRoot) {
        // Repository files a job wrote as root that this user's group cannot remove: a root container of this script does.
        swept = true;
        await docker([
          "run", "--rm", "--name", `${runPrefix}_sweep`, ...HARDENED, "--user", "0:0", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
          "-v", `${localRoot}:/sweep`, IMAGE, "find", "/sweep", "-mindepth", "1", "-delete",
        ]).catch((err) => console.log(`INFO cleanup sweep: ${err.message}`));
        failed = await rm(dir, { recursive: true, force: true }).then(() => null, (err) => err);
      }
      if (failed) console.log(`INFO cleanup ${dir}: ${failed.message}`);
    }
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

async function main() {
  const t0 = performance.now();
  for (const image of IMAGES) {
    try {
      await docker(["image", "inspect", "--format", "{{.Id}}", image]);
    } catch {
      console.log(`SKIP accept-app-stack-backups: ${image} is not local; nothing was created (this script never pulls). Hint: ${PULL_HINTS[image]}`);
      process.exit(1);
    }
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
  const info = (msg) => console.log(`INFO ${msg}`);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  ingressRoot = path.join(tmpDir, "ingress");
  localRoot = path.join(tmpDir, "local-root");
  const backupKeyFile = path.join(tmpDir, "backup.key");
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
    panelDumpDir: path.join(tmpDir, "panel-dump"),
    backupLocalRoot: localRoot,
    backupKeyFile,
    backupNetworkName: unused("backup_net"),
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
  const bk = (req) => call("backups", req);
  const startReq = (jobId) => ({ action: "stackStart", jobId, stackId: A, organizationId: ORG, volumeKeys: VOLUME_KEYS, target: TARGET });
  const restoreReq = (jobId, snapshotId) => ({ action: "stackRestore", jobId, stackId: A, organizationId: ORG, volumeKeys: VOLUME_KEYS, target: TARGET, snapshotId });
  const forgetReq = (jobId, stackId, snapshotIds) => ({ action: "stackForget", jobId, stackId, target: TARGET, snapshotIds });
  const settled = (jobId) =>
    until(`job ${jobId} settles`, 180_000, async () => {
      const s = await bk({ action: "status", jobId });
      return s.state === "running" ? null : s;
    }, 1_000);
  const createdOf = (jobId) => created.filter((c) => c.name.startsWith(`hp_bk_${jobId}_`));
  const mutating = (mark) => gateLog.slice(mark).filter((l) => /^(POST|DELETE|PUT) /.test(l));
  let S0 = null;
  let FP0 = null;
  let backup = null; // { jobId, snapshotId }
  let restoreJobId = null;
  let safetySnapshotId = null;

  try {
    const ready = await step("preflight", async () => {
      assert((process.umask() & 0o070) === 0, "umask keeps the group bits (0002 or 0007), as the executor's unit does", process.umask().toString(8));
      // As bootstrap-dedicated.sh makes HP_BACKUP_LOCAL_ROOT: 2770, owned by the executor's user and group.
      await mkdir(localRoot, { mode: 0o770 });
      await chmod(localRoot, 0o2770);
      await writeFile(backupKeyFile, BACKUP_KEY, { mode: 0o400 });
      const st = await stat(localRoot);
      assert((st.mode & 0o7777) === 0o2770 && st.uid === UID && st.gid === GID, "the destination root is 2770 and this user's", `${(st.mode & 0o7777).toString(8)} ${st.uid}:${st.gid}`);
      assert((await statfs("/dev/shm")).type === 0x01021994, "the secret files of the jobs go on tmpfs", "not tmpfs");
    });
    if (!ready) return;

    await startGate(gateSocket);
    adapter = new DockerEngineSocketAdapter(adapterOptions);
    const gateOk = await step("gate-self-test", async () => {
      // Real names of this machine, used only as judge() inputs: no request about them is ever sent.
      const foreignName = (await lines(["ps", "-a", "--format", "{{.Names}}"])).find((n) => n.startsWith("hp_")) ?? `hp_selftest_${hex}`;
      const foreignId = (await lines(["ps", "-aq", "--no-trunc"]))[0] ?? "f".repeat(64);
      const foreignNet = (await lines(["network", "ls", "--format", "{{.Name}}"]))[0] ?? "bridge";
      const foreignVol = (await lines(["volume", "ls", "--format", "{{.Name}}"]))[0] ?? `selftest_${hex}`;
      const ownNet = appStackInternalNetworkName(A);
      const hardened = { Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true };
      const component = (hostConfig = {}, extra = {}) =>
        JSON.stringify({ Image: IMAGE, ...extra, HostConfig: { ...hardened, NetworkMode: ownNet, ...hostConfig } });
      const jobId = newJobId();
      const job = (kind, hostConfig = {}, extra = {}, labels = {}) => {
        const key = kind.startsWith("rs_") ? kind.slice(3) : null;
        const binds = kind === "up" ? [`${appStackVolumeName(A, "data")}:/data/data:ro`] : key ? [`${appStackVolumeName(A, key)}:/data/${key}`] : [];
        return JSON.stringify({
          Image: RESTIC_IMAGE,
          User: "0:0",
          Labels: { "io.hostingpanel.managed": "true", "io.hostingpanel.role": "site_job", "io.hostingpanel.job_id": jobId, [BACKUP_OF_LABEL]: A, ...labels },
          ...extra,
          HostConfig: {
            ...hardened,
            NetworkMode: "none",
            GroupAdd: [String(GID)],
            Binds: [...binds, `${secretsRoot}/job_bk_${jobId}/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro`],
            Mounts: [{ Type: "bind", Source: repoDirOf(A), Target: `/backup/repository/stacks/${A}`, ReadOnly: key !== null }],
            ...(kind === "up" ? { CapAdd: COPY_CAPS } : key ? { CapAdd: RESTORE_CAPS } : {}),
            ...hostConfig,
          },
        });
      };
      const jobName = (kind, id = jobId) => `/v1.45/containers/create?name=hp_bk_${kind.startsWith("rs_") ? `${id}-apply` : id}_${kind}`;
      const repoMount = (over) => [{ Type: "bind", Source: repoDirOf(A), Target: `/backup/repository/stacks/${A}`, ReadOnly: false, ...over }];
      const testName = `hp_bk_test_${randomBytes(8).toString("hex")}`;
      const test = (hostConfig = {}, extra = {}) =>
        JSON.stringify({
          Image: RESTIC_IMAGE,
          User: `${String(UID)}:${String(GID)}`,
          Labels: { "io.hostingpanel.managed": "true", "io.hostingpanel.role": "site_job" },
          ...extra,
          HostConfig: {
            ...hardened,
            NetworkMode: "none",
            GroupAdd: [String(GID)],
            Mounts: [{ Type: "bind", Source: path.join(targetDir(), "panel"), Target: "/backup/repository/panel", ReadOnly: false }],
            ...hostConfig,
          },
        });
      const createTest = `/v1.45/containers/create?name=${testName}`;

      // The well-formed bodies pass: every denial below is due to the one thing each case changes.
      const good = [
        ["POST", `/v1.45/containers/create?name=${APP}`, component()],
        ...["repo", "up", "drop", "forget", "rs_data", "rs_media"].map((kind) => ["POST", jobName(kind), job(kind)]),
      ].filter(([method, url, body]) => judge(method, url, body).kind !== "forward");
      assert(good.length === 0, "judge() forwards the well-formed creates of this run", good.map(([, url]) => url).join(" | "));
      assert(judge("POST", createTest, test()).kind === "deny", "a destination test nobody asked for is denied", "forwarded");
      expectTest = true;
      const testVerdicts = [
        judge("POST", createTest, test()).kind,
        ...[test({ Mounts: repoMount({}) }), test({ Mounts: [] }), test({}, { User: "0:0" }), test({ NetworkMode: "bridge" }), test({ CapAdd: COPY_CAPS }),
          test({ Binds: [`${appStackVolumeName(A, "data")}:/data/data:ro`] }), test({}, { Image: IMAGE })].map((body) => judge("POST", createTest, body).kind),
      ];
      expectTest = false;
      assert(same(testVerdicts, ["forward", ...Array(7).fill("deny")]), "judge() takes only the test of this run's destination", testVerdicts.join(","));

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
        ["POST", `/v1.45/networks/${foreignNet}/disconnect`, JSON.stringify({ Container: APP })],
        ["POST", `/v1.45/images/create?fromImage=${encodeURIComponent(RESTIC_IMAGE)}`, ""],
        ["GET", `/v1.45/images/${encodeURIComponent(ALPINE)}/json`, ""],
        ["POST", "/v1.45/containers/prune", ""],
        ["POST", "/v1.45/volumes/prune", ""],
        ["POST", `/v1.45/containers/${foreignId}/exec`, JSON.stringify({ Cmd: ["true"] })],
        ["POST", `/v1.45/containers/create?name=${foreignName}`, component()],
        ["POST", `/v1.45/containers/create?name=${APP}`, component({ Privileged: true })],
        ["POST", `/v1.45/containers/create?name=${APP}`, component({ Binds: ["/:/host"] })],
        ["POST", `/v1.45/containers/create?name=${APP}`, component({ NetworkMode: "host" })],
        ["POST", `/v1.45/containers/create?name=${APP}`, component({ CapAdd: COPY_CAPS })],
        ["POST", `/v1.45/containers/create?name=${APP}`, component({}, { Image: RESTIC_IMAGE })],
        ["POST", "/v1.45/networks/create", JSON.stringify({ Name: ownNet, Driver: "bridge", Options: { "com.docker.network.bridge.name": "x" }, Labels: { [ROLE_LABEL]: "app_internal" } })],
        // an edge network is what a live executor would attach its proxy to: this run never makes one
        ["POST", "/v1.45/networks/create", JSON.stringify({ Name: ownNet, Driver: "bridge", Labels: { [ROLE_LABEL]: "app_edge" } })],
        ["POST", "/v1.45/volumes/create", JSON.stringify({ Name: appStackVolumeName(A, "data"), Driver: "local", DriverOpts: { type: "none" } })],
        // the job containers
        ["POST", jobName("up", `op_${"0".repeat(32)}`), job("up")],
        ["POST", jobName("up"), job("up", { Privileged: true })],
        ["POST", jobName("up"), job("up", { CapAdd: ["SYS_ADMIN"] })],
        ["POST", jobName("up"), job("up", { CapAdd: [...COPY_CAPS, "SYS_ADMIN"] })],
        ["POST", jobName("up"), job("up", { CapAdd: RESTORE_CAPS })],
        ["POST", jobName("up"), job("up", { CapDrop: [] })],
        ["POST", jobName("up"), job("up", { ReadonlyRootfs: false })],
        ["POST", jobName("up"), job("up", { NetworkMode: "host" })],
        ["POST", jobName("up"), job("up", { NetworkMode: "bridge" })],
        ["POST", jobName("up"), job("up", { PidMode: "host" })],
        ["POST", jobName("up"), job("up", { Binds: ["/:/host:ro"] })],
        ["POST", jobName("up"), job("up", { Binds: [`${appStackVolumeName(A, "data")}:/data/data`] })],
        ["POST", jobName("up"), job("up", { Binds: ["hp_appvol_stk_other_data:/data/data:ro"] })],
        ["POST", jobName("up"), job("up", { Binds: [`${foreignVol}:/data/data:ro`] })],
        ["POST", jobName("up"), job("up", { GroupAdd: ["0"] })],
        ["POST", jobName("up"), job("up", { Mounts: repoMount({ Source: localRoot }) })],
        ["POST", jobName("up"), job("up", { Mounts: repoMount({ Source: path.join(targetDir(), "panel") }) })],
        ["POST", jobName("up"), job("up", { Mounts: repoMount({ Source: repoDirOf(B) }) })],
        ["POST", jobName("up"), job("up", { Mounts: repoMount({ Source: `/var/lib/hosting-panel/local-repos/${TARGET.targetId}/stacks/${A}` }) })],
        ["POST", jobName("up"), job("up", { Mounts: [...repoMount({}), { Type: "bind", Source: "/", Target: "/host" }] })],
        ["POST", jobName("up"), job("up", {}, { User: "33:33" })],
        ["POST", jobName("up"), job("up", {}, { Image: IMAGE })],
        ["POST", jobName("up"), job("up", {}, { Env: [`RESTIC_PASSWORD=${BACKUP_KEY}`] })],
        ["POST", jobName("up"), job("up", {}, {}, { [STACK_ID_LABEL]: A })],
        ["POST", jobName("up"), job("up", {}, {}, { "io.hostingpanel.role": "app_component" })],
        ["POST", jobName("up"), job("up", {}, {}, { [BACKUP_OF_LABEL]: "stk_other" })],
        ["POST", jobName("repo"), job("repo", { CapAdd: COPY_CAPS })],
        ["POST", jobName("repo"), job("up", { CapAdd: undefined })],
        ["POST", jobName("forget"), job("rs_data")],
        ["POST", jobName("rs_data"), job("rs_media")],
        ["POST", jobName("rs_data"), job("rs_data", { Binds: VOLUME_KEYS.map((k) => `${appStackVolumeName(A, k)}:/data/${k}`) })],
        ["POST", jobName("rs_data"), job("rs_data", { Mounts: repoMount({ ReadOnly: false }) })],
        ["POST", jobName("rs_data"), job("rs_data", { CapAdd: [...RESTORE_CAPS, "SYS_ADMIN"] })],
        ["POST", jobName("rs_nope"), job("rs_nope")],
      ];
      const allowed = cases.filter(([method, url, body]) => judge(method, url, body).kind !== "deny");
      assert(allowed.length === 0, "judge() denies every foreign or unsafe request", allowed.map(([method, url, body]) => `${method} ${url} ${body.slice(0, 160)}`).join(" | "));
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
      const stale = [...S0.containers, ...S0.networks, ...S0.volumes].filter((l) => l.includes(marker) || l.includes(jobMarker));
      assert(stale.length === 0, "no object of this run exists yet", stale.join(","));
      info(`S0: ${S0.containers.length} containers, ${S0.networks.length} networks, ${S0.volumes.length} volumes`);
    });

    await step("local-target-init", async () => {
      const mark = created.length;
      expectTest = true;
      let r;
      try {
        r = await bk({ action: "localInit", target: TARGET });
      } finally {
        expectTest = false;
      }
      assert(r.outcome === "ok" && r.problem === null, "the destination is created and its test passes", JSON.stringify(r));
      const tests = created.slice(mark);
      assert(tests.length === 1 && TEST_NAME.test(tests[0].name), "exactly one test container ran", tests.map((c) => c.name).join(","));
      assert(await exists(path.join(targetDir(), ".hp-local-target")), "the destination folder carries its marker file", "absent");
      const top = (await readdir(targetDir())).sort();
      assert(same(top, [".hp-local-target", "panel", "sites"]), "no folder for applications yet: the first job makes it", top.join(","));
    });

    await step("deploy-and-seed", async () => {
      const pull = await call("pullAppStackImage", { plan: planA, image: IMAGE });
      const prep = await call("prepareAppStack", { plan: planA });
      const made = await call("createAppStackComponents", { plan: planA });
      assert(pull.pulled === false, "image present: pulled false", JSON.stringify(pull));
      assert(
        prep.networks.length === 1 && prep.networks[0].created && same(prep.volumes.map((v) => `${v.volumeKey}:${String(v.created)}`), VOLUME_KEYS.map((k) => `${k}:true`)),
        "one private network and two volumes created, no edge network",
        JSON.stringify(prep),
      );
      assert(made.components.length === 1 && made.components[0].outcome === "created", "one component created", JSON.stringify(made));
      await observe("seed", {
        caps: RESTORE_CAPS,
        mounts: [`${appStackVolumeName(A, "data")}:/data`, `${appStackVolumeName(A, "media")}:/media`],
        script: SEED_SCRIPT,
        args: [NEEDLE],
      });
      const started = await call("startAppStackComponent", { plan: planA, componentKey: "app", secretFileContents: [] });
      assert(started.outcome === "started", "the application started", JSON.stringify(started));
      const own = ownNames(await snapshot());
      const expected = { containers: [APP], networks: [appStackInternalNetworkName(A)], volumes: VOLUME_KEYS.map((k) => appStackVolumeName(A, k)).sort() };
      assert(same(own, expected), "own objects: exactly one container, one network, two volumes", JSON.stringify(own));
    });

    await step("application-reads-its-data", async () => {
      const read = await docker(["exec", APP, "cat", "/data/private/notes.txt"]);
      assert(read.trim() === NEEDLE, "the application reads the file seeded for it", "other content");
      FP0 = { data: await fingerprint("data"), media: await fingerprint("media") };
      const d = FP0.data.entries;
      const names = d.map((l) => l.split(" ")[1]);
      assert(
        same(names, ["./empty", "./link", "./other", "./other/closed.bin", "./private", "./private/notes.txt", "./public.txt", "./run.sh", "./shared"]),
        "the data volume holds the seeded entries",
        names.join(","),
      );
      const has = (prefix) => d.some((l) => l.startsWith(prefix));
      const shape = {
        root: FP0.data.root === "R 65534:65534 750" && FP0.media.root === "R 65534:65534 700",
        link: has("L ./link 65534:65534 public.txt"),
        closed: has("F ./other/closed.bin 1001:1002 400 4096 "),
        otherOwner: has("D ./other 1001:1002 700 "),
        setuid: has("F ./run.sh 65534:65534 4755 "),
        setgid: has("D ./shared 65534:65534 2770 "),
        blob: FP0.media.entries.length === 1 && FP0.media.entries[0].startsWith("F ./blob.bin 65534:65534 640 262144 "),
        hashed: [...d, ...FP0.media.entries].filter((l) => l.startsWith("F ")).every((l) => / [0-9a-f]{64}$/.test(l)),
      };
      const bad = Object.keys(shape).filter((k) => !shape[k]);
      assert(bad.length === 0, "owners, modes, the link and the special bits are as seeded", `${bad.join(",")} | ${FP0.data.root} | ${d.join(" | ")} | ${FP0.media.entries.join(" | ")}`);
    });

    await step("refused-while-running", async () => {
      const mark = gateLog.length;
      const copy = await rejection(bk(startReq(newJobId())));
      assert(copy?.code === "RESOURCE_LOCKED", "a backup of a running application is refused as RESOURCE_LOCKED", copy ? reasonOf(copy) : "accepted");
      const back = await rejection(bk(restoreReq(`${newJobId()}-apply`, "a".repeat(64))));
      assert(back?.code === "RESOURCE_LOCKED", "a restore onto a running application is refused as RESOURCE_LOCKED", back ? reasonOf(back) : "accepted");
      assert(mutating(mark).length === 0, "the refusals sent no mutating request: no job container", mutating(mark).join(" | "));
      assert(!(await exists(path.join(targetDir(), "stacks"))), "the refusals wrote nothing on the destination", "stacks/ exists");
    });

    await step("stop-application", async () => {
      const r = await call("stopAppStack", { stackId: A, organizationId: ORG });
      assert(same(r.components.map((c) => `${c.componentKey}:${c.outcome}`), ["app:stopped"]), "the component stopped", JSON.stringify(r));
      const state = (await inspectOf(APP)).State.Status;
      assert(state === "exited", "the container is at rest", state);
    });

    await step("refused-for-another-customer-or-a-missing-volume", async () => {
      const mark = gateLog.length;
      const other = await rejection(bk({ ...startReq(newJobId()), organizationId: `${ORG}_other` }));
      assert(other?.code === "HOST_POLICY_DENIED", "the application of another customer is refused as HOST_POLICY_DENIED", other ? reasonOf(other) : "accepted");
      const missing = await rejection(bk({ ...startReq(newJobId()), volumeKeys: ["data", "nope"] }));
      assert(missing?.code === "NOT_FOUND", "a volume the application does not have is refused as NOT_FOUND", missing ? reasonOf(missing) : "accepted");
      assert(mutating(mark).length === 0, "the refusals sent no mutating request: no job container", mutating(mark).join(" | "));
    });

    await step("backup-copies-every-volume", async () => {
      const jobId = newJobId();
      const accepted = await bk(startReq(jobId));
      assert(accepted.jobId === jobId && ["running", "succeeded"].includes(accepted.state), "the job is accepted", JSON.stringify(accepted));
      const done = await settled(jobId);
      assert(done.state === "succeeded" && done.failure === null, "the copy succeeded", JSON.stringify(done));
      const s = done.snapshot;
      assert(/^[0-9a-f]{64}$/.test(String(s?.snapshotId)), "the job answers the snapshot id", JSON.stringify(s));
      assert(s.fileCount >= 5 && s.totalBytes >= 262_144 + 4096, "the snapshot counts the files of both volumes", JSON.stringify(s));
      backup = { jobId, snapshotId: s.snapshotId };
      const names = createdOf(jobId).map((c) => c.name);
      assert(same(names, [`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_up`]), "two job containers: the repository step, then one copy of every volume", names.join(","));
    });

    await step("job-hardening", async () => {
      assert(backup !== null, "a backup exists", "none");
      const [repo, up] = createdOf(backup.jobId).map((c) => c.body);
      for (const [name, body, caps] of [["repo", repo, undefined], ["up", up, COPY_CAPS]]) {
        const h = body.HostConfig;
        const checks = {
          User: body.User === "0:0",
          CapDrop: same(h.CapDrop, ["ALL"]),
          CapAdd: same(h.CapAdd, caps),
          SecurityOpt: same(h.SecurityOpt, ["no-new-privileges:true"]),
          ReadonlyRootfs: h.ReadonlyRootfs === true,
          Privileged: h.Privileged === false,
          NetworkMode: h.NetworkMode === "none",
          PidsLimit: h.PidsLimit === 128,
          Memory: h.Memory === 536_870_912 && h.MemorySwap === 536_870_912,
          NanoCpus: h.NanoCpus === 1_000_000_000,
          RestartPolicy: h.RestartPolicy?.Name === "no",
          Role: body.Labels["io.hostingpanel.role"] === "site_job" && body.Labels["io.hostingpanel.job_id"] === backup.jobId,
          BackupOf: body.Labels[BACKUP_OF_LABEL] === A,
          NotAStackResource: body.Labels[STACK_ID_LABEL] === undefined,
          KeyAsFile: body.Env.includes("RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD") && !body.Env.some((e) => /^RESTIC_PASSWORD=/.test(e)),
          OwnRepository: body.Env.includes(`RESTIC_REPOSITORY=/backup/repository/stacks/${A}`),
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `the ${name} container carries the designed hardening`, bad.join(","));
      }
      const volumeBinds = up.HostConfig.Binds.filter((b) => !isSecretBind(b));
      assert(same(volumeBinds, VOLUME_KEYS.map((k) => `${appStackVolumeName(A, k)}:/data/${k}:ro`)), "the copy mounts every volume read-only", volumeBinds.join(","));
      assert(repo.HostConfig.Binds.every(isSecretBind), "the repository step mounts no volume", repo.HostConfig.Binds.join(","));
      assert(same(up.Cmd.slice(-2), ["/data/data", "/data/media"]) && up.Cmd.includes("backup"), "one snapshot of the two folders", up.Cmd.join(" "));
      const left = (await readdir(secretsRoot).catch(() => [])).filter((n) => n.startsWith("job_"));
      assert(left.length === 0, "the secret files of the job are gone", left.join(","));
    });

    await step("repository-is-ciphertext-under-own-folder", async () => {
      const top = (await readdir(targetDir())).sort();
      assert(same(top, [".hp-local-target", "panel", "sites", "stacks"]), "the destination holds the three folders and its marker", top.join(","));
      const stacks = await readdir(path.join(targetDir(), "stacks"));
      assert(same(stacks, [A]), "one repository, named after the application", stacks.join(","));
      for (const dir of [path.join(targetDir(), "stacks"), repoDirOf(A)]) {
        const st = await stat(dir);
        assert((st.mode & 0o7777) === 0o2770 && st.uid === UID && st.gid === GID, `${path.relative(localRoot, dir)} is 2770 and the executor's`, `${(st.mode & 0o7777).toString(8)} ${st.uid}:${st.gid}`);
      }
      const entries = await readdir(repoDirOf(A), { recursive: true, withFileTypes: true });
      const files = entries.filter((f) => f.isFile()).map((f) => path.join(f.parentPath, f.name));
      const rel = files.map((f) => path.relative(repoDirOf(A), f));
      assert(rel.includes("config") && ["data", "index", "keys", "snapshots"].every((d) => rel.some((f) => f.startsWith(`${d}/`))), "a restic repository", rel.slice(0, 8).join(","));
      let bytes = 0;
      const open = [];
      const plain = [];
      for (const file of files) {
        const st = await stat(file);
        if ((st.mode & 0o007) !== 0 || st.gid !== GID) open.push(path.relative(repoDirOf(A), file));
        const content = await readFile(file);
        bytes += content.length;
        if (content.includes(NEEDLE) || content.includes(BACKUP_KEY)) plain.push(path.relative(repoDirOf(A), file));
      }
      assert(open.length === 0, "every repository file is the executor group's and closed to everyone else", open.slice(0, 5).join(","));
      assert(plain.length === 0, "no repository file holds the plaintext of the data or the backup key", plain.join(","));
      assert(bytes >= 262_144, "the repository holds the data", String(bytes));
      info(`repository: ${String(files.length)} files, ${String(bytes)} bytes`);
    });

    await step("snapshot-holds-both-volumes", async () => {
      assert(backup !== null, "a backup exists", "none");
      const listed = (await resticRead("ls", ["ls", "--no-lock", backup.snapshotId])).split("\n");
      const wanted = ["/data/data/private/notes.txt", "/data/data/other/closed.bin", "/data/data/link", "/data/data/empty", "/data/media/blob.bin"];
      const missing = wanted.filter((p) => !listed.includes(p));
      assert(missing.length === 0, "restic, run apart from the adapter, lists the files of both volumes in the snapshot", missing.join(","));
      const snapshots = JSON.parse(await resticRead("snapshots", ["snapshots", "--no-lock", "--json"]));
      assert(snapshots.length === 1 && snapshots[0].id === backup.snapshotId && snapshots[0].tags.includes(backup.jobId), "one snapshot, tagged with the job", JSON.stringify(snapshots).slice(0, 300));
    });

    await step("same-job-id-answers-the-same-job", async () => {
      assert(backup !== null, "a backup exists", "none");
      const mark = gateLog.length;
      const again = await bk(startReq(backup.jobId));
      assert(again.state === "succeeded" && again.snapshot?.snapshotId === backup.snapshotId, "the same job id answers the job it already ran", JSON.stringify(again));
      assert(gateLog.length === mark, "and asks Docker nothing: no second copy", gateLog.slice(mark).join(" | "));
    });

    await step("damage-data", async () => {
      await observe("damage", {
        caps: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
        mounts: [`${appStackVolumeName(A, "data")}:/data`, `${appStackVolumeName(A, "media")}:/media`],
        script: DAMAGE_SCRIPT,
      });
      const now = { data: await fingerprint("data"), media: await fingerprint("media") };
      assert(!same(withoutDirTimes(now.data.entries), withoutDirTimes(FP0.data.entries)) && now.media.entries.length === 0, "the volumes no longer hold what was backed up", "unchanged");
      assert(now.data.root === "R 0:0 755" && now.media.root === "R 65534:65534 755", "the volumes' own folders changed owner and mode too", `${now.data.root} | ${now.media.root}`);
    });

    await step("restore-brings-data-back", async () => {
      assert(backup !== null, "a backup exists", "none");
      // As the panel does: the safety copy of the data as they are, under the operation, before its write-back.
      const op = newJobId();
      await bk(startReq(op));
      const safety = await settled(op);
      assert(safety.state === "succeeded" && safety.snapshot !== null, "the safety copy of the data as they are succeeded", JSON.stringify(safety));
      safetySnapshotId = safety.snapshot.snapshotId;
      restoreJobId = `${op}-apply`;
      const accepted = await bk(restoreReq(restoreJobId, backup.snapshotId));
      assert(accepted.jobId === restoreJobId, "the job is accepted", JSON.stringify(accepted));
      const done = await settled(restoreJobId);
      assert(done.state === "succeeded" && done.failure === null, "the restore succeeded", JSON.stringify(done));
      const now = { data: await fingerprint("data"), media: await fingerprint("media") };
      for (const key of VOLUME_KEYS) {
        const before = withoutDirTimes(FP0[key].entries);
        const after = withoutDirTimes(now[key].entries);
        const diff = [...after.filter((l) => !before.includes(l)).map((l) => `+${l}`), ...before.filter((l) => !after.includes(l)).map((l) => `-${l}`)];
        assert(diff.length === 0, `volume ${key}: content, owners, modes, links and file times are those of the backup, and nothing else is left`, diff.join(" | "));
      }
      for (const key of VOLUME_KEYS) {
        assert(now[key].root === FP0[key].root, `volume ${key}: its own folder has the owner and mode of the backup again`, `${now[key].root}, was ${FP0[key].root}`);
        assert(same(now[key].entries, FP0[key].entries), `volume ${key}: the times of its directories are those of the backup`, "other times");
      }
    });

    await step("restore-job-hardening", async () => {
      assert(restoreJobId !== null, "a restore ran", "none");
      const jobs = createdOf(restoreJobId);
      assert(same(jobs.map((c) => c.name), VOLUME_KEYS.map((k) => `hp_bk_${restoreJobId}_rs_${k}`)), "one container per volume, in the order asked", jobs.map((c) => c.name).join(","));
      for (const [i, key] of VOLUME_KEYS.entries()) {
        const body = jobs[i].body;
        const h = body.HostConfig;
        const checks = {
          User: body.User === "0:0",
          CapDrop: same(h.CapDrop, ["ALL"]),
          CapAdd: same(h.CapAdd, RESTORE_CAPS),
          NetworkMode: h.NetworkMode === "none",
          OneVolume: same(h.Binds.filter((b) => !isSecretBind(b)), [`${appStackVolumeName(A, key)}:/data/${key}`]),
          RepositoryReadOnly: h.Mounts.length === 1 && h.Mounts[0].ReadOnly === true,
          Command: same(body.Cmd, ["restore", `${backup.snapshotId}:/data`, "--target", "/data", "--include", `/${key}`, "--delete", "--no-lock", "--json"]),
          NotAStackResource: body.Labels[STACK_ID_LABEL] === undefined && body.Labels[BACKUP_OF_LABEL] === A,
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        assert(bad.length === 0, `the restore of ${key} mounts only that volume, writable, and the repository read-only`, bad.join(","));
      }
    });

    await step("application-starts-and-reads-restored-data", async () => {
      const started = await call("startAppStackComponent", { plan: planA, componentKey: "app", secretFileContents: [] });
      assert(started.outcome === "started", "the application started again", JSON.stringify(started));
      const read = await docker(["exec", APP, "cat", "/data/private/notes.txt"]);
      assert(read.trim() === NEEDLE, "the application reads the restored file", "other content");
      const listing = (await docker(["exec", APP, "ls", "-A", "/data"])).split("\n").filter(Boolean).sort();
      assert(same(listing, ["empty", "link", "other", "private", "public.txt", "run.sh", "shared"]), "what was added after the backup is gone", listing.join(","));
      const closed = await rejection(docker(["exec", APP, "cat", "/data/other/closed.bin"]));
      assert(closed !== null, "a file of another owner is still closed to the application", "readable");
    });

    await step("forget-removes-the-snapshot", async () => {
      assert(backup !== null, "a backup exists", "none");
      const jobId = `${newJobId()}-forget`;
      const snapshotIds = [backup.snapshotId, ...(safetySnapshotId === null ? [] : [safetySnapshotId])];
      await bk(forgetReq(jobId, A, snapshotIds));
      const done = await settled(jobId);
      assert(done.state === "succeeded" && done.failure === null, "the forget succeeded, with the application running", JSON.stringify(done));
      const jobs = createdOf(jobId);
      assert(same(jobs.map((c) => c.name), [`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_forget`]), "the repository step, then the forget", jobs.map((c) => c.name).join(","));
      assert(jobs.every((c) => c.body.HostConfig.CapAdd === undefined && c.body.HostConfig.Binds.every(isSecretBind)), "no capability and no volume for a forget", "found");
      assert(same(jobs[1].body.Cmd, ["forget", "--prune", ...snapshotIds]), "the snapshots are forgotten and their data removed", jobs[1].body.Cmd.join(" "));
      const snapshots = JSON.parse(await resticRead("snapshots", ["snapshots", "--no-lock", "--json"])) ?? [];
      assert(snapshots.length === 0, "restic, run apart from the adapter, lists no snapshot", JSON.stringify(snapshots).slice(0, 200));
    });

    await step("forget-on-missing-repository-is-done", async () => {
      const jobId = `${newJobId()}-forget`;
      await bk(forgetReq(jobId, B, ["b".repeat(64)]));
      const done = await settled(jobId);
      assert(done.state === "succeeded" && done.failure === null, "nothing to forget where no repository exists: done", JSON.stringify(done));
      const jobs = createdOf(jobId).map((c) => c.name);
      assert(same(jobs, [`hp_bk_${jobId}_repo`]), "only the repository step ran", jobs.join(","));
      assert(!(await exists(path.join(repoDirOf(B), "config"))), "and no repository was made for it", "config exists");
    });

    await step("no-secret-anywhere", async () => {
      const bodies = JSON.stringify(created);
      assert(leakedWindows(bodies, BACKUP_KEY) === 0, "no window of the backup key in any container the adapter created", "found");
      assert(leakedWindows(JSON.stringify(results), BACKUP_KEY) === 0, "no adapter answer holds the backup key", "found");
      assert(leakedWindows(gateLog.join("\n"), BACKUP_KEY) === 0, "no request line holds the backup key", "found");
      const answers = JSON.stringify(results.filter((r) => r?.jobId !== undefined));
      assert(!answers.includes(localRoot) && !answers.includes(secretsRoot), "no job answer holds a host path", answers.slice(0, 200));
      const left = (await readdir(secretsRoot).catch(() => [])).filter((n) => n.startsWith("job_"));
      assert(left.length === 0, "no secret file of a job is left", left.join(","));
      const jobsLeft = (await lines(["ps", "-a", "--format", "{{.Names}}"])).filter((n) => n.includes(jobMarker) || (TEST_NAME.test(n) && ownIds.has(n)));
      assert(jobsLeft.length === 0, "every job container was removed by the adapter", jobsLeft.join(","));
    });

    await step("foreign-untouched", async () => {
      const s3 = await snapshot();
      const kinds = ["containers", "networks", "volumes"];
      const removed = kinds.flatMap((k) => S0[k].filter((l) => !s3[k].includes(l)));
      assert(removed.length === 0, "no pre-existing container, network or volume changed", removed.join(","));
      assert(same(s3.certs, S0.certs), "the temp ingress tree is unchanged (no route file)", s3.certs.join(","));
      const own = ownNames(s3);
      assert(same(own.networks, [appStackInternalNetworkName(A)]), "this run made one private network and no edge network", own.networks.join(","));
      const added = kinds.flatMap((k) => s3[k].filter((l) => !S0[k].includes(l) && !isOwn(l.split(" ").pop())));
      if (added.length > 0) info(`objects added meanwhile by someone else: ${added.join(", ")}`);
    });

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only about this run's objects", gateDenied.slice(0, 3).join(" | "));
      info(`gate saw ${gateLog.length} request(s), ${gateDenied.length} denied, ${created.length} container(s) created`);
    });
  } finally {
    await cleanup();
    total += 1;
    const left = [];
    for (const args of [
      ["ps", "-aq", "--filter", `name=${marker}`],
      ["ps", "-aq", "--filter", `name=${jobMarker}`],
      ["network", "ls", "-q", "--filter", `name=${marker}`],
      ["volume", "ls", "-q", "--filter", `name=${marker}`],
    ]) {
      if ((await docker(args).catch(() => "x")).trim() !== "") left.push(args.join(" "));
    }
    for (const dir of [tmpDir, secretsRoot]) if (await exists(dir)) left.push(dir);
    if (gateServer?.listening) left.push("gate");
    if (swept) info("the repository files needed a root container of this script to be removed");
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
