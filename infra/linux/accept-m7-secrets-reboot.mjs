#!/usr/bin/env node
/**
 * Real-Docker acceptance check for GitHub issue #7 (a generic service with secretRefs must start again
 * after a reboot).
 *
 * Drives the built DockerEngineSocketAdapter (deployService, restartService) against /var/run/docker.sock
 * with a secrets root of its own on tmpfs. A reboot is simulated the way it happens on a server: the
 * container is stopped, its service folder vanishes (tmpfs is empty after a boot) and Docker starts the
 * container again (here: one direct Engine API start, as the restart policy does at boot). The script
 * records what Docker does then, and proves that restartService(id, secrets) and a new deployService write
 * the files again, set the root-owned folder Docker left aside without writing into it, and that the
 * container runs with the right values; a restart without secrets ends in success or a coded error, never
 * a crash.
 *
 * Machine safety: every Docker object created carries "hp_swarmtest_m7s_<hex>" in its name (the product
 * names its network hp_site_<siteId>_net, and the siteId is the run prefix): one container made from a local
 * image derived from busybox:latest with `docker commit` (nothing is pulled), its internal network, and two
 * throw-away busybox containers. A wrapper around the adapter's Docker client refuses any mutating call on
 * an object that is not of this run: deployService's attach of hp_mariadb and hp_mail_relay and its detach of
 * hp_ingress_proxy answer 404 (the product's "not created yet") and never reach the Engine. No port is
 * published, nothing is pruned. Files are written only under /dev/shm/hp_swarmtest_m7s_<hex>-*; the
 * root-owned folders Docker leaves there are removed by a throw-away busybox container (--user 0:0,
 * --cap-drop ALL, --cap-add DAC_OVERRIDE, --cap-add FOWNER) that mounts only that folder. Everything is
 * removed by exact name in `finally` and on SIGINT/SIGTERM.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (p) => import(pathToFileURL(path.resolve(repoRoot, p)).href);

const BASE_IMAGE = "busybox:latest";
const SOCKET = "/var/run/docker.sock";
const TMP_PARENT = "/dev/shm";
const runPrefix = `hp_swarmtest_m7s_${randomBytes(4).toString("hex")}`;
const siteId = runPrefix;
const svc = `${runPrefix}_svc`;
const containerName = `${runPrefix}_web`;
const baseContainer = `${runPrefix}_base`;
const cleanerName = `${runPrefix}_clean`;
const image = `${runPrefix}_img:1`;
// PID 1 leaves on SIGTERM, so a stop or a restart takes no 10 s grace.
const IMAGE_CMD = `CMD ["sh","-c","trap 'exit 0' TERM INT; sleep 86400 & wait"]`;
const secret = () => randomBytes(24).toString("base64url");
const REV1 = { DB_PASSWORD: secret(), API_TOKEN: secret() };
const REV2 = { DB_PASSWORD: REV1.DB_PASSWORD, API_TOKEN: secret() }; // revision 2 rotates one value
const NAMES = Object.keys(REV1).sort();
const myUid = process.getuid();

const created = { containers: new Set(), networks: new Set(), images: new Set() };
const guard = { skipped: [], refused: [] };
let tmpRoot = null;
let secretsRoot = null;
let serviceDir = null;

function docker(args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** One Engine API call over the socket, only ever on this run's own container. */
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

const gone = (r, what) => r.code === 0 || new RegExp(`no such ${what}|not found`, "i").test(r.stderr);

/** Removes this run's objects by exact name; returns what could not be removed. */
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    const problems = [];
    const notes = [];
    for (const name of [...created.containers, baseContainer, cleanerName]) {
      const r = await docker(["rm", "-f", "-v", name]);
      if (!gone(r, "container")) problems.push(`container ${name}: ${r.stderr.trim()}`);
    }
    for (const net of created.networks) {
      const r = await docker(["network", "rm", net]);
      if (!gone(r, "network")) problems.push(`network ${net}: ${r.stderr.trim()}`);
    }
    for (const img of created.images) {
      const r = await docker(["image", "rm", img]);
      if (!gone(r, "image")) problems.push(`image ${img}: ${r.stderr.trim()}`);
    }
    if (tmpRoot) {
      const rootOwned = await rootOwnedEntries(tmpRoot);
      if (rootOwned.length > 0) {
        // Folders Docker made as root: only root may empty them. The cleaner sees this run's temp root only.
        const r = await docker([
          "run", "--rm", "--pull", "never", "--name", cleanerName, "--network", "none", "--user", "0:0",
          "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
          "--security-opt", "no-new-privileges:true", "-v", `${tmpRoot}:/t`, BASE_IMAGE,
          "find", "/t", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+",
        ]);
        if (r.code !== 0) problems.push(`cleaner container: ${r.stderr.trim()}`);
        notes.push(`${String(rootOwned.length)} root-owned entries removed by the cleaner container`);
      }
      try {
        await rm(tmpRoot, { recursive: true, force: true });
      } catch (err) {
        problems.push(`temp root ${tmpRoot}: ${err.code ?? err.message}`);
      }
    }
    return { problems, notes };
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

/** Every entry under dir (dir included) owned by uid 0, never following a symlink. */
async function rootOwnedEntries(dir) {
  const out = [];
  const walk = async (p) => {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    if (st.uid === 0) out.push(p);
    if (!st.isDirectory()) return;
    for (const name of await readdir(p).catch(() => [])) await walk(path.join(p, name));
  };
  await walk(dir);
  return out;
}

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / ${String(actual).slice(0, 400)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- preflight: the base image is local, or nothing is created ---
const baseImg = await docker(["image", "inspect", "--format", "{{.Id}}", BASE_IMAGE]);
if (baseImg.code !== 0) {
  console.log(`SKIP ${BASE_IMAGE} is not on this machine; nothing was created (this script never pulls)`);
  process.exit(1);
}
const { DockerEngineSocketAdapter, ExecutorCodedError, MANAGED_DOCKER_LABELS, getSiteEdgeNetworkName, getSiteInternalNetworkName } =
  await load("apps/docker-executor/dist/index.js");
const { createApprovedServiceSpec } = await load("packages/executor-contracts/dist/index.js");
const fmt = (err) =>
  err instanceof ExecutorCodedError
    ? `${err.code}: ${err.message}`
    : `${err?.name ?? "Error"}${err?.code ? ` ${String(err.code)}` : ""}: ${String(err?.message ?? err)}`;
const siteNet = getSiteInternalNetworkName(siteId);
const edgeNet = getSiteEdgeNetworkName(siteId);

/**
 * Wraps the adapter's Docker client: a mutating call reaches the Engine only for an object of this run.
 * Attaching or detaching a container that is not of this run (hp_mariadb, hp_mail_relay, hp_ingress_proxy)
 * answers 404 without a request; any other call outside the run throws.
 */
function guardAdapter(adapter) {
  const client = adapter.dockerClient;
  const orig = client.request.bind(client);
  const ours = new Set();
  const mine = (s) => typeof s === "string" && s.includes(runPrefix);
  const isOurContainer = async (ref) => {
    if (mine(ref) || ours.has(ref)) return true;
    if (!/^[0-9a-f]{64}$/.test(ref)) return false;
    const res = await orig("GET", `/containers/${ref}/json`);
    const ok = res.statusCode === 200 && mine(JSON.parse(res.body.toString("utf8")).Name);
    if (ok) ours.add(ref);
    return ok;
  };
  const refuse = (method, p) => {
    guard.refused.push(`${method} ${p}`);
    throw new Error(`refused by this run's guard: ${method} ${p}`);
  };
  client.request = async (method, p, body, opts) => {
    const [route, qs] = p.split("?");
    let m;
    if (method === "GET") {
      if ((m = /^\/(containers|networks|volumes)\/([^/]+)(?:\/json)?$/.exec(route)) && m[2] !== "json") {
        const ref = decodeURIComponent(m[2]);
        if (!mine(ref) && !(m[1] === "containers" && (await isOurContainer(ref)))) refuse(method, p);
      } else if ((m = /^\/images\/(.+)\/json$/.exec(route)) && !mine(decodeURIComponent(m[1]))) {
        refuse(method, p);
      }
      return orig(method, p, body, opts);
    }
    if (method === "POST" && route === "/containers/create") {
      const name = new URLSearchParams(qs ?? "").get("name");
      if (!mine(name)) refuse(method, p);
      created.containers.add(name);
      const res = await orig(method, p, body, opts);
      if (res.statusCode === 201) ours.add(JSON.parse(res.body.toString("utf8")).Id);
      return res;
    }
    if (
      (method === "POST" && (m = /^\/containers\/([^/]+)\/(start|stop|restart|kill)$/.exec(route))) ||
      (method === "DELETE" && (m = /^\/containers\/([^/]+)$/.exec(route)))
    ) {
      if (!(await isOurContainer(decodeURIComponent(m[1])))) refuse(method, p);
      return orig(method, p, body, opts);
    }
    if (method === "POST" && route === "/networks/create") {
      if (!mine(body?.Name)) refuse(method, p);
      created.networks.add(body.Name);
      return orig(method, p, body, opts);
    }
    if (method === "POST" && (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(route))) {
      const net = decodeURIComponent(m[1]);
      const ref = String(body?.Container ?? "");
      if (!mine(net) || !(await isOurContainer(ref))) {
        guard.skipped.push(`${m[2]} ${ref}`);
        return { statusCode: 404, body: Buffer.from('{"message":"not an object of this run"}') };
      }
      return orig(method, p, body, opts);
    }
    return refuse(method, p);
  };
  return adapter;
}

const spec = (revisionNumber, resolvedSecrets) =>
  createApprovedServiceSpec({
    serviceInstanceId: svc,
    siteId,
    organizationId: `${runPrefix}_org`,
    image,
    containerName,
    env: { APP_MODE: "acceptance" },
    resourceLimits: { cpuMilli: 250, memoryBytes: "134217728" },
    revisionNumber,
    specHash: `${runPrefix}_rev_${String(revisionNumber)}`,
    exposeHttp: false,
    volumeMounts: [],
    resolvedSecrets: { ...resolvedSecrets },
  });

async function inspect(name) {
  const r = await docker(["container", "inspect", name]);
  return r.code === 0 ? JSON.parse(r.stdout)[0] : null;
}

async function waitRunning(name, ms = 15_000) {
  const until = Date.now() + ms;
  let ins = await inspect(name);
  while (!ins?.State?.Running && Date.now() < until) {
    await sleep(200);
    ins = await inspect(name);
  }
  return ins;
}

/** kind, owner, mode and inode of one path, never following a symlink. */
async function describe(p) {
  try {
    const st = await lstat(p);
    const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other";
    return { kind, uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8).padStart(4, "0"), ino: st.ino };
  } catch (err) {
    return { kind: err.code ?? "error" };
  }
}
const show = (d) => (d.uid === undefined ? d.kind : `${d.kind} ${String(d.uid)}:${String(d.gid)} ${d.mode}`);

const staleEntries = async () => (await readdir(secretsRoot)).filter((n) => n.startsWith(".stale-")).sort();

/** The two values read from inside the running container. */
async function expectSecretsInside(expected) {
  const ins = await waitRunning(containerName);
  assert(ins?.State?.Running === true, "container running", JSON.stringify(ins?.State ?? null));
  for (const [name, value] of Object.entries(expected)) {
    const r = await docker(["exec", containerName, "cat", `/run/secrets/${name}`]);
    assert(r.code === 0, `cat /run/secrets/${name} in the container`, r.stderr.trim());
    assert(r.stdout === value, `/run/secrets/${name} holds the expected value`, `differs (${String(r.stdout.length)} bytes read)`);
    assert(ins.Config.Env.includes(`${name}_FILE=/run/secrets/${name}`), `${name}_FILE in the env`, ins.Config.Env.join(" "));
    assert(
      ins.HostConfig.Binds.includes(`${path.join(serviceDir, name)}:/run/secrets/${name}:ro`),
      `read-only bind of ${name} from the service folder`,
      ins.HostConfig.Binds.join(" "),
    );
  }
  return ins;
}

/** The service folder as the executor leaves it: its own 0700 folder of 0444 regular files, nothing else. */
async function expectHostFolder(expected) {
  const dir = await describe(serviceDir);
  assert(dir.kind === "dir" && dir.uid === myUid && dir.mode === "0700", `service folder dir ${String(myUid)} 0700`, show(dir));
  const names = (await readdir(serviceDir)).sort();
  assert(JSON.stringify(names) === JSON.stringify(Object.keys(expected).sort()), "only the secret files", names.join(","));
  for (const name of names) {
    const f = await describe(path.join(serviceDir, name));
    assert(f.kind === "file" && f.uid === myUid && f.mode === "0444", `${name} file ${String(myUid)} 0444`, show(f));
  }
}

/**
 * A boot: the container stops, the tmpfs loses the service folder, Docker starts the container again.
 * Returns what Docker answered and what it left on disk.
 */
async function simulateReboot() {
  const stop = await engine("POST", `/containers/${containerName}/stop?t=5`);
  assert(stop.status === 204 || stop.status === 304, "container stopped", `${String(stop.status)} ${stop.body}`);
  await rm(serviceDir, { recursive: true, force: true });
  const before = await describe(serviceDir);
  assert(before.kind === "ENOENT", "service folder gone, as after a boot", show(before));
  const start = await engine("POST", `/containers/${containerName}/start`);
  await sleep(500);
  const ins = await inspect(containerName);
  const dir = await describe(serviceDir);
  const leaves = {};
  for (const name of NAMES) leaves[name] = await describe(path.join(serviceDir, name));
  let message = start.body.trim();
  try {
    message = JSON.parse(start.body).message ?? message;
  } catch {
    // an empty 204 body
  }
  const state = ins?.State ?? {};
  const after =
    `state ${String(state.Status)} running=${String(state.Running)} exit=${String(state.ExitCode)} restarts=${String(ins?.RestartCount)}; ` +
    `service folder ${show(dir)}; ${NAMES.map((n) => `${n} ${show(leaves[n])}`).join("; ")}`;
  const note = `docker start answered HTTP ${String(start.status)}${message ? `: ${message}` : ""}; ${after}`;
  const brief = `reboot again: docker start answered HTTP ${String(start.status)}${/not a directory/i.test(message) ? " (not a directory)" : ""}; ${after}`;
  return { start, message, state, dir, leaves, note, brief };
}

/** What issue #7 reports: Docker refuses the start and leaves root-owned folders where the files were. */
function expectRebootFailure(boot) {
  assert(boot.start.status >= 400, "Docker refuses to start the container", `${String(boot.start.status)} ${boot.message}`);
  assert(/not a directory/i.test(boot.message), "the refusal says 'not a directory'", boot.message);
  assert(boot.state.Running === false, "container not running", JSON.stringify(boot.state));
  assert(boot.dir.kind === "dir" && boot.dir.uid === 0, "Docker made the service folder, owned by root", show(boot.dir));
  for (const name of NAMES) {
    const leaf = boot.leaves[name];
    assert(leaf.kind === "dir" && leaf.uid === 0, `a root-owned folder where the file ${name} was`, show(leaf));
  }
}

/** The new .stale-* entry is the very folder Docker made (same inode), moved aside and left as Docker made it. */
async function expectSetAside(staleBefore, boot) {
  const after = await staleEntries();
  const added = after.filter((n) => !staleBefore.includes(n));
  assert(added.length === 1, "exactly one folder set aside", after.join(","));
  const aside = path.join(secretsRoot, added[0]);
  const d = await describe(aside);
  assert(d.kind === "dir" && d.uid === 0 && d.ino === boot.dir.ino, "the root-owned folder Docker made, renamed", `${show(d)} ino ${String(d.ino)} / ${String(boot.dir.ino)}`);
  const inside = (await readdir(aside)).sort();
  assert(JSON.stringify(inside) === JSON.stringify(NAMES), "it holds only the folders Docker made", inside.join(","));
  for (const name of NAMES) {
    const leaf = await describe(path.join(aside, name));
    const content = await readdir(path.join(aside, name));
    assert(leaf.kind === "dir" && leaf.uid === 0 && leaf.ino === boot.leaves[name].ino, `${name} still Docker's folder`, show(leaf));
    assert(content.length === 0, `nothing written into ${name}`, content.join(","));
  }
  return added[0];
}

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
    const notes = [];
    try {
      await fn(notes);
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${fmt(err)}`);
      if (name.startsWith("1-")) setupFailed = true;
    }
    for (const n of notes) console.log(`  ${n}`);
  };

  created.networks.add(siteNet).add(edgeNet);
  let adapter = null;

  try {
    await step("1-deploy-with-secrets", async (notes) => {
      tmpRoot = await mkdtemp(path.join(TMP_PARENT, `${runPrefix}-`));
      secretsRoot = path.join(tmpRoot, "secrets");
      serviceDir = path.join(secretsRoot, svc);
      await mkdir(secretsRoot, { mode: 0o700 });
      const root = await describe(secretsRoot);
      assert(root.kind === "dir" && root.uid === myUid && root.mode === "0700", `secrets root dir ${String(myUid)} 0700`, show(root));

      created.images.add(image);
      const base = await docker(["create", "--pull", "never", "--name", baseContainer, BASE_IMAGE]);
      assert(base.code === 0, "base container created", base.stderr.trim());
      const commit = await docker(["commit", "--change", IMAGE_CMD, baseContainer, image]);
      assert(commit.code === 0, "local image derived from busybox", commit.stderr.trim());
      const rmBase = await docker(["rm", "-f", baseContainer]);
      assert(rmBase.code === 0, "base container removed", rmBase.stderr.trim());

      adapter = guardAdapter(
        new DockerEngineSocketAdapter({
          dockerSocketPath: SOCKET,
          pullMissingImages: false,
          secretsRootDir: secretsRoot,
          executorUid: myUid,
          ingressRootDir: path.join(tmpRoot, "ingress"),
          siteMailDir: path.join(tmpRoot, "mail"),
          sharedDbContainerName: `${runPrefix}_shared_db_unused`,
          sharedDbNetworkName: `${runPrefix}_shared_net_unused`,
          sharedDbDataDir: path.join(tmpRoot, "shared-db"),
          sharedDbRootKeyFile: path.join(tmpRoot, "root.key"),
        }),
      );
      const res = await adapter.deployService(spec(1, REV1));
      assert(res.status === "succeeded", "deployService succeeded", JSON.stringify(res));
      await expectSecretsInside(REV1);
      await expectHostFolder(REV1);
      notes.push(`guard answered 404 without a request for: ${guard.skipped.join(", ") || "nothing"}`);
    });

    let boot1 = null;
    await step("2-reboot-docker-start", async (notes) => {
      boot1 = await simulateReboot();
      notes.push(boot1.note);
      expectRebootFailure(boot1);
    });

    await step("3-restart-with-secrets", async (notes) => {
      assert(boot1 !== null, "a reboot before", "none");
      const staleBefore = await staleEntries();
      const res = await adapter.restartService(svc, REV1);
      assert(res.status === "succeeded", "restartService succeeded", JSON.stringify(res));
      await expectSecretsInside(REV1);
      await expectHostFolder(REV1);
      const aside = await expectSetAside(staleBefore, boot1);
      notes.push(`set aside: ${aside} (root-owned, same inode as Docker's folder, its ${String(NAMES.length)} folders empty)`);
    });

    await step("4-reboot-then-deploy-rev2", async (notes) => {
      const boot = await simulateReboot();
      notes.push(boot.brief);
      expectRebootFailure(boot);
      const oldId = (await inspect(containerName))?.Id;
      const staleBefore = await staleEntries();
      const res = await adapter.deployService(spec(2, REV2));
      assert(res.status === "succeeded", "deployService of revision 2 succeeded", JSON.stringify(res));
      const ins = await expectSecretsInside(REV2);
      assert(ins.Id !== oldId, "a new container", `${String(ins.Id)} / ${String(oldId)}`);
      const rev = ins.Config.Labels[MANAGED_DOCKER_LABELS.revisionNumber];
      assert(rev === "2", "revision 2 label", String(rev));
      await expectHostFolder(REV2);
      const aside = await expectSetAside(staleBefore, boot);
      notes.push(`set aside: ${aside}`);
    });

    await step("5-restart-without-secrets", async (notes) => {
      const boot = await simulateReboot();
      notes.push(boot.brief);
      expectRebootFailure(boot);
      const staleBefore = await staleEntries();
      for (const secrets of [undefined, {}]) {
        let outcome;
        try {
          const res = await adapter.restartService(svc, secrets);
          assert(res.status === "succeeded", "a result is succeeded", JSON.stringify(res));
          outcome = `resolved ${res.status}`;
        } catch (err) {
          assert(err instanceof ExecutorCodedError, "a coded executor error, not a crash", fmt(err));
          outcome = `rejected ${fmt(err)}`;
        }
        notes.push(`restartService(id, ${JSON.stringify(secrets) ?? "undefined"}): ${outcome}`);
        const dir = await describe(serviceDir);
        assert(dir.kind === "dir" && dir.uid === 0 && dir.ino === boot.dir.ino, "the folder Docker made is left in place", show(dir));
        for (const name of NAMES) {
          const leaf = await describe(path.join(serviceDir, name));
          assert(leaf.kind === "dir" && leaf.uid === 0 && leaf.ino === boot.leaves[name].ino, `nothing written at ${name}`, show(leaf));
        }
        const stale = await staleEntries();
        assert(JSON.stringify(stale) === JSON.stringify(staleBefore), "nothing set aside", stale.join(","));
      }
      const ins = await inspect(containerName);
      notes.push(`container afterwards: state ${String(ins?.State?.Status)} running=${String(ins?.State?.Running)}`);
    });

    await step("5b-restart-with-secrets-recovers", async () => {
      const staleBefore = await staleEntries();
      const res = await adapter.restartService(svc, REV2);
      assert(res.status === "succeeded", "restartService succeeded", JSON.stringify(res));
      await expectSecretsInside(REV2);
      await expectHostFolder(REV2);
      const stale = await staleEntries();
      assert(stale.length === staleBefore.length + 1, "the Docker-made folder set aside", stale.join(","));
    });
  } finally {
    // The cleanup step runs even after a setup failure.
    setupFailed = false;
    await step("6-cleanup", async (notes) => {
      const { problems, notes: n } = await cleanup();
      notes.push(...n);
      assert(problems.length === 0, "every object of this run removed", problems.join("; "));
    });
    total += 1;
    const left = [];
    for (const [what, args] of [
      ["containers", ["ps", "-a", "--filter", `name=${runPrefix}`, "-q"]],
      ["networks", ["network", "ls", "--filter", `name=${runPrefix}`, "-q"]],
      ["volumes", ["volume", "ls", "--filter", `name=${runPrefix}`, "-q"]],
      ["images", ["image", "ls", "--filter", `reference=${runPrefix}*`, "-q"]],
    ]) {
      const r = await docker(args);
      if (r.code !== 0 || r.stdout.trim() !== "") left.push(`${what}: ${r.stdout.trim() || r.stderr.trim()}`);
    }
    const files = (await readdir(TMP_PARENT).catch(() => [])).filter((n) => n.startsWith(runPrefix));
    if (files.length > 0) left.push(`files: ${files.join(",")}`);
    if (left.length === 0) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: ${left.join("; ")}`);
    }
    if (guard.refused.length > 0) console.log(`  guard refused: ${guard.refused.join(", ")}`);
    console.log(`RESULT ${String(passed)}/${String(total)} passed`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
