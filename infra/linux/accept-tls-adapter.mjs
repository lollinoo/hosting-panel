#!/usr/bin/env node
/**
 * Real-Docker check of the PRODUCTION manual-TLS path (HCP-SPEC-004, ADR 0031): DockerEngineSocketAdapter.manualTls
 * (putVersion, publish hot path, cold path with evictAcme, probe, inventory, gc) and ensureIngressProxy from
 * apps/docker-executor/dist against real Traefik containers. accept-tls-manual.mjs replays the publish sequence with the
 * store pieces; this script calls the adapter.
 *
 * The adapter's test seam (options ingressProxyContainerName, ingressNetworkName; defaults hp_ingress_proxy and
 * hp_ingress_net, payloads unchanged) lets the throwaway proxies and networks be created THROUGH ensureIngressProxy under
 * hp_swarmtest_adp_<hex>_* names:
 *  - phase 1 (proxy 1): ensureIngressProxy creates network and proxy; first publish on the empty acme.json that
 *    ensureStaticConfig leaves; hot publish, probe, inventory, stale/unknown, replay, capture refusal, rotation under
 *    load, executor restart (a fresh adapter's ensureIngressProxy recovers the state and does NOT recreate), gc.
 *  - phase 2 (proxy 2): the proxy is created with the 680febb payload (the builders are asserted byte-identical to
 *    `git show 680febb:...`), over a fixture acme.json written before it starts; the new adapter's ensureIngressProxy
 *    keeps its container id and StartedAt (upgrade, no recreate). TLS-05 cold path: an identical-name ACME entry is
 *    refused hot with acme_eviction_required (nothing touched), evictAcme:true evicts with a byte-equal 0600 backup,
 *    restarts the proxy and serves the manual fingerprint; a failed post-start probe restores the backup.
 *
 * Machine safety: the adapter talks to a gate socket (in the temp dir) that forwards to /var/run/docker.sock. The gate
 * forwards only requests whose URL and body name nothing but this run's hp_swarmtest_adp_<hex> prefix (and owned
 * container ids), answers the site-edge network lists with [] (so the proxies are never attached to the live site
 * networks), and rewrites the published-port HostIp 0.0.0.0 to 127.0.0.1 on create (and back on inspect, so the drift
 * check sees the payload unchanged). Everything else is denied and the denials are asserted to be zero. The live
 * hp_ingress_proxy is never read, probed or touched. Ports bind 127.0.0.1 only (16680/16643 and 16681/16644). All state
 * lives in os.tmpdir()/hp_swarmtest_adp_<hex>_*, removed with the containers and networks in `finally` and on
 * SIGINT/SIGTERM. Every `docker` CLI call is checked to name only this run's resources.
 *
 * Run: node infra/linux/accept-tls-adapter.mjs   (HP_TLS_KEEP=1 keeps the temp dir; needs Docker and the traefik:v3.7 image)
 * Steps (RESULT n/m passed; a step that cannot run is reported as skipped in the RESULT line, never as a pass):
 * setup-proxy-through-ensure, put-version-idempotent-and-validated, publish-on-fresh-empty-acme-store,
 * publish-hot-serves-fingerprint, probe-and-inventory-no-secrets, stale-generation-refused, publish-replay,
 * capture-refused-keeps-serving, rotation-under-load, executor-restart-recovers, gc, setup-legacy-payload-proxy,
 * upgrade-no-recreate, cold-path-refused-hot, cold-path-evicts-with-backup, cold-path-failed-probe-restores,
 * gate-clean, nothing-left.
 */
import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCert } from "./tls-test-certs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (p) => pathToFileURL(path.resolve(repoRoot, p)).href;
const { DockerEngineSocketAdapter, TraefikIngressFileManager, buildIngressProxyContainerPayload } = await import(
  dist("apps/docker-executor/dist/index.js")
);

const HOST = "127.0.0.1";
const PORT = { http: 16680, https: 16643 }; // proxy 1
const PORT2 = { http: 16681, https: 16644 }; // proxy 2 (legacy payload, cold path)
const DOMAIN = "hp-adp.test";
const h = (label) => `${label}.${DOMAIN}`;
const TRAEFIK_IMAGE = "traefik:v3.7";
const LEGACY_COMMIT = "680febb";
const runHex = randomBytes(4).toString("hex");
const runPrefix = `hp_swarmtest_adp_${runHex}`;
const proxy1 = `${runPrefix}_proxy`;
const net1 = `${runPrefix}_net`;
const proxy2 = `${runPrefix}_proxy2`;
const net2 = `${runPrefix}_net2`;
const DOCKER_SOCK = "/var/run/docker.sock";
const keepTmp = process.env.HP_TLS_KEEP === "1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p) => stat(p).then(() => true, () => false);
const versionId = () => `ctv_${randomBytes(16).toString("hex")}`;
const short = (fp) => String(fp).slice(0, 12);
const fpOfPem = (pem) => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
const b64 = (text) => Buffer.from(text).toString("base64");

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / got: ${actual}`);
}

/** The only docker CLI door: every argument that names an hp_ resource must name one of this run's. */
function docker(args) {
  const named = args.filter((a) => /hp_/.test(a) && !a.includes(runPrefix));
  if (named.length > 0) throw new Error(`refusing docker call naming ${named.join(",")}`);
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 120_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`docker ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
  });
}
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];

async function until(what, ms, fn, every = 300) {
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

/** One handshake with SNI; sha256 of the served leaf. */
function servedFp(servername, port = PORT.https) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: HOST, port, servername, rejectUnauthorized: false }, () => {
      const fp = String(s.getPeerCertificate().fingerprint256).replaceAll(":", "").toLowerCase();
      s.destroy();
      resolve(fp);
    });
    s.setTimeout(10_000, () => s.destroy(new Error("tls timeout")));
    s.on("error", reject);
  });
}

/** The adapter's error, whatever its shape: ManualTlsStoreError.reason, else code, else message. */
const reasonOf = (err) => String(err?.reason ?? err?.code ?? err?.message ?? err);
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

let tmpDir = null;
let dockerTouched = false;
let gateServer = null;
const gateLog = [];
const gateDenied = [];
const ownIds = new Set();
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (dockerTouched) {
      const ids = (await docker(["ps", "-aq", "--filter", `name=${runPrefix}`]).catch(() => "")).split("\n").filter(Boolean);
      if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
      const nets = (await docker(["network", "ls", "-q", "--filter", `name=${runPrefix}`]).catch(() => "")).split("\n").filter(Boolean);
      if (nets.length > 0) await docker(["network", "rm", ...nets]).catch(() => undefined);
    }
    if (gateServer) {
      gateServer.closeAllConnections?.();
      await new Promise((resolve) => gateServer.close(() => resolve()));
    }
    if (tmpDir && !keepTmp) await rm(tmpDir, { recursive: true, force: true });
    else if (tmpDir) console.log(`INFO HP_TLS_KEEP=1: kept ${tmpDir}`);
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

/**
 * What the gate lets through: kind "forward" (optionally with a rewritten request body), "fake" (a canned answer) or
 * "deny". Nothing may name an hp_ resource of another run; containers are addressed by an own name or an own id.
 */
function judge(method, rawUrl, bodyText) {
  const u = new URL(rawUrl, "http://docker");
  const p = decodeURIComponent(u.pathname).replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const query = decodeURIComponent(u.search);
  const foreign = [...`${p}?${query}\n${bodyText}`.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((m) => m[0]).filter((n) => !n.startsWith(runPrefix));
  if (foreign.length > 0) return { kind: "deny", why: `names ${foreign[0]}` };
  const own = (ref) => ref.startsWith(runPrefix) || ownIds.has(ref);
  if (method === "GET" && (p === "/_ping" || p === "/version")) return { kind: "forward" };
  if (method === "GET" && /^\/images\/traefik:v3\.7\/json$/.test(p)) return { kind: "forward" };
  // The site edge/internal network lists: the proxies must never be attached to the live site networks.
  if (method === "GET" && p === "/networks" && /site_(edge|internal)/.test(query)) return { kind: "fake", status: 200, json: [] };
  let m;
  if (method === "GET" && (m = p.match(/^\/networks\/([^/]+)$/)) && own(m[1])) return { kind: "forward" };
  if (method === "POST" && p === "/networks/create") {
    return String(JSON.parse(bodyText || "{}").Name).startsWith(runPrefix) ? { kind: "forward" } : { kind: "deny", why: "network name" };
  }
  if (method === "POST" && p === "/containers/create") {
    if (!/^\?name=hp_swarmtest_adp_/.test(query)) return { kind: "deny", why: "unnamed container create" };
    const payload = JSON.parse(bodyText);
    for (const list of Object.values(payload.HostConfig?.PortBindings ?? {})) for (const b of list) b.HostIp = HOST;
    return { kind: "forward", body: JSON.stringify(payload), createdContainer: true };
  }
  if ((m = p.match(/^\/containers\/([^/]+)(?:\/(json|start|stop|logs))?$/)) && own(m[1])) {
    const sub = m[2];
    const ok = sub === undefined ? method === "DELETE" : sub === "json" || sub === "logs" ? method === "GET" : method === "POST";
    if (ok) return { kind: "forward", inspect: sub === "json" };
  }
  return { kind: "deny", why: "not an allowed request" };
}

/** Unix-socket gate in front of docker.sock (see the header). */
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
        verdict = { kind: "deny", why: `unparsable (${String(err?.message)})` };
      }
      gateLog.push(`${req.method} ${req.url} -> ${verdict.kind}`);
      if (verdict.kind !== "forward") {
        if (verdict.kind === "deny") gateDenied.push(`${req.method} ${req.url}: ${verdict.why}`);
        res.writeHead(verdict.kind === "fake" ? verdict.status : 403, { "content-type": "application/json" });
        res.end(JSON.stringify(verdict.kind === "fake" ? verdict.json : { message: "gate: denied" }));
        return;
      }
      const out = verdict.body !== undefined ? Buffer.from(verdict.body) : Buffer.from(bodyText);
      const headers = { ...req.headers, host: "docker" };
      delete headers["transfer-encoding"];
      if (out.length > 0 || req.method === "POST") headers["content-length"] = String(out.length);
      const up = http.request({ socketPath: DOCKER_SOCK, method: req.method, path: req.url, headers }, (ures) => {
        const parts = [];
        ures.on("data", (c) => parts.push(c));
        ures.on("end", () => {
          let body = Buffer.concat(parts);
          if (verdict.createdContainer && ures.statusCode === 201) ownIds.add(JSON.parse(body.toString("utf8")).Id);
          // The published ports are 127.0.0.1 in Docker; the payload says 0.0.0.0: show the executor what it asked for.
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

/** A request through the gate (used to create the legacy-payload proxy exactly as an older executor did). */
function viaGate(gateSocket, method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      { socketPath: gateSocket, method, path: urlPath, headers: { "content-type": "application/json", "content-length": String(data.length) } },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/** Source of `export function <name>(...) {...}` up to its closing brace in column 0. */
function functionSource(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  return end < 0 ? null : source.slice(start, end + 3);
}
function git(args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoRoot, ...args], { timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(String(stdout)),
    );
  });
}

async function main() {
  let passed = 0;
  let total = 0;
  let skipped = 0;
  const failedSetup = { p1: false, p2: false };
  const step = async (name, fn, { needs = "p1", setup = null } = {}) => {
    total += 1;
    if (failedSetup[needs]) {
      console.log(`FAIL ${name}: skipped after setup failure`);
      return;
    }
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      if (setup) failedSetup[setup] = true;
      for (const c of [proxy1, proxy2]) {
        const tail = await docker(["logs", "--tail", "15", c]).catch(() => "");
        if (tail) console.log(`--- ${c} log tail ---\n${tail.trimEnd()}\n---`);
      }
    }
  };
  const skip = (name, why) => {
    skipped += 1;
    console.log(`SKIP ${name}: ${why}`);
  };
  const info = (msg) => console.log(`INFO ${msg}`);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  const ingressRoot = path.join(tmpDir, "ingress");
  const ingressRoot2 = path.join(tmpDir, "ingress2");
  const gateSocket = path.join(tmpDir, "docker-gate.sock");
  const hostA = h("a"); // the host that rotates under load
  const hostB = h("b"); // a second routed host with its own manual certificate (must not blink)
  const hostC = h("c"); // routed, ACME-style (no manual certificate): what a capturing wildcard would take over
  const hostD = h("d"); // phase 2: has an ACME entry in acme.json, gets a manual certificate (cold path)
  const hostE = h("e"); // phase 2: same, but its post-start probe fails
  const certA1 = makeCert({ sans: [hostA] });
  const certA2 = makeCert({ sans: [hostA] });
  const certB = makeCert({ sans: [hostB] });
  const wildcard = makeCert({ sans: [`*.${DOMAIN}`] });
  const idA1 = versionId();
  const idA2 = versionId();
  const idB = versionId();
  const idW = versionId();
  const idOrphan = versionId();
  const orphan = makeCert({ sans: [h("orphan")] });
  const put = (id, c) => ({ action: "putVersion", versionId: id, fullchainPem: c.certPem, keyPem: c.keyPem, fingerprintSha256: c.fp });
  const newAdapter = (over = {}) =>
    new DockerEngineSocketAdapter({
      dockerSocketPath: gateSocket,
      ingressRootDir: ingressRoot,
      ingressHttpPort: PORT.http,
      ingressHttpsPort: PORT.https,
      ingressProxyContainerName: proxy1,
      ingressNetworkName: net1,
      traefikImage: TRAEFIK_IMAGE,
      manualTlsProbe: { deadlineMs: 20_000, intervalMs: 200 },
      ...over,
    });
  const newAdapter2 = (probe = { deadlineMs: 20_000, intervalMs: 200 }) =>
    newAdapter({
      ingressRootDir: ingressRoot2,
      ingressHttpPort: PORT2.http,
      ingressHttpsPort: PORT2.https,
      ingressProxyContainerName: proxy2,
      ingressNetworkName: net2,
      manualTlsProbe: probe,
    });
  const route = async (fm, site, host, hostname) =>
    fm.upsertServiceRoute(site, {
      serviceInstanceId: `svc_${host}`,
      containerName: "hp-nobackend",
      internalPort: 8080,
      hosts: [{ hostname, tls: true, httpsRedirect: false, redirectTo: null, source: "manual" }],
    });
  let adapter = null;
  let proxy1Id = null;
  let startedAt = null;
  let generation = 0;
  const manifestPath = path.join(ingressRoot, "dynamic", "hp-manual-certificates.yml");
  const storeDir = path.join(ingressRoot, "dynamic", "manual-certs");

  try {
    await step("setup-proxy-through-ensure", async () => {
      assert(proxy1.startsWith("hp_swarmtest_") && net1.startsWith("hp_swarmtest_"), "throwaway names", `${proxy1} ${net1}`);
      await docker(["image", "inspect", TRAEFIK_IMAGE, "--format", "{{.Id}}"]);
      await startGate(gateSocket);
      dockerTouched = true;
      adapter = newAdapter();
      const fm = new TraefikIngressFileManager(ingressRoot, null);
      await fm.ensureStaticConfig(null);
      for (const [host, manual] of [[hostA, true], [hostB, true], [hostC, false]]) {
        await fm.upsertServiceRoute("site_adp", {
          serviceInstanceId: `svc_${host.split(".")[0]}`,
          containerName: "hp-nobackend",
          internalPort: 8080,
          hosts: [{ hostname: host, tls: true, httpsRedirect: false, redirectTo: null, ...(manual ? { source: "manual" } : {}) }],
        });
      }
      const ensured = await adapter.ensureIngressProxy();
      assert(ensured.status === "running", "ensureIngressProxy creates and starts the proxy", JSON.stringify(ensured));
      const c = await inspectOf(proxy1);
      assert(c.State.Running === true && Object.keys(c.NetworkSettings.Networks).join() === net1, "proxy running on the renamed network only", Object.keys(c.NetworkSettings.Networks).join());
      assert(c.HostConfig.NetworkMode === net1 && c.HostConfig.Privileged === false, "payload: renamed network, not privileged", c.HostConfig.NetworkMode);
      assert(c.Config.Labels["io.hostingpanel.role"] === "ingress_proxy", "managed ingress_proxy label", JSON.stringify(c.Config.Labels));
      await until("throwaway Traefik answers TLS", 40_000, () => servedFp(hostA));
      proxy1Id = c.Id;
      startedAt = c.State.StartedAt;
      info(`${proxy1} up through ensureIngressProxy (StartedAt ${startedAt}); adapter -> gate socket, ingress root ${ingressRoot}`);
      const again = await adapter.ensureIngressProxy();
      const c2 = await inspectOf(proxy1);
      assert(again.status === "running" && c2.Id === proxy1Id && c2.State.StartedAt === startedAt, "a second ensure changes nothing", `${c2.Id === proxy1Id} ${c2.State.StartedAt}`);
    }, { setup: "p1" });

    await step("put-version-idempotent-and-validated", async () => {
      const first = await adapter.manualTls(put(idA1, certA1));
      assert(first.versionId === idA1 && first.written === true, "first putVersion writes", JSON.stringify(first));
      const again = await adapter.manualTls(put(idA1, certA1));
      assert(again.written === false, "same id, same material: written=false", JSON.stringify(again));
      const other = await rejection(adapter.manualTls(put(idA1, certA2)));
      assert(other !== null && reasonOf(other) === "TLS_VERSION_CONFLICT", "same id, other material refused as TLS_VERSION_CONFLICT", other ? reasonOf(other) : "accepted");
      const lie = await rejection(adapter.manualTls({ ...put(versionId(), certA2), fingerprintSha256: "0".repeat(64) }));
      assert(lie !== null && reasonOf(lie) === "TLS_MATERIAL_INVALID", "wrong fingerprint refused as TLS_MATERIAL_INVALID", lie ? reasonOf(lie) : "accepted");
      const wrongKey = await rejection(adapter.manualTls({ ...put(versionId(), certA2), keyPem: certB.keyPem }));
      assert(wrongKey !== null && reasonOf(wrongKey) === "TLS_MATERIAL_INVALID", "key of another certificate refused", wrongKey ? reasonOf(wrongKey) : "accepted");
      for (const [id, c] of [[idA2, certA2], [idB, certB], [idW, wildcard], [idOrphan, orphan]]) await adapter.manualTls(put(id, c));
    });

    // ensureStaticConfig leaves acme.json as an EMPTY 0600 file; Traefik only fills it after an ACME account exists
    // (never, when the panel ingress is disabled = no resolver). The shipped planner must not read that as "unreadable".
    await step("publish-on-fresh-empty-acme-store", async () => {
      const store = path.join(ingressRoot, "acme", "acme.json");
      assert((await stat(store)).size === 0, "precondition: acme.json is the empty file ensureStaticConfig creates", "not empty");
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: 0,
        entries: [{ versionId: idA1, assignedHosts: [hostA] }, { versionId: idB, assignedHosts: [hostB] }],
        expect: [{ hostname: hostA, fingerprintSha256: certA1.fp }, { hostname: hostB, fingerprintSha256: certB.fp }],
      });
      assert(r.outcome === "served" && r.generation === 1, "first publish on a fresh install (empty acme.json) is served at generation 1", JSON.stringify(r));
    });
    // From here on acme.json is what Traefik writes once an account exists, so the remaining steps test the rest.
    const acmeStore = path.join(ingressRoot, "acme", "acme.json");
    if ((await stat(acmeStore)).size === 0) await writeFile(acmeStore, "{}", { mode: 0o600 });

    await step("publish-hot-serves-fingerprint", async () => {
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: 0,
        entries: [{ versionId: idA1, assignedHosts: [hostA] }, { versionId: idB, assignedHosts: [hostB] }],
        expect: [{ hostname: hostA, fingerprintSha256: certA1.fp }, { hostname: hostB, fingerprintSha256: certB.fp }],
      });
      assert(r.outcome === "served" && r.generation === 1, "outcome served at generation 1", JSON.stringify(r));
      const served = Object.fromEntries(r.served.map((s) => [s.hostname, s.fingerprintSha256]));
      assert(served[hostA] === certA1.fp && served[hostB] === certB.fp, "result.served carries the observed fingerprints", JSON.stringify(served));
      assert((await servedFp(hostA)) === certA1.fp, "independent handshake serves A1 for host a", "other");
      assert((await servedFp(hostB)) === certB.fp, "independent handshake serves B for host b", "other");
      const now = (await docker(["inspect", "-f", "{{.State.StartedAt}} {{.State.Running}}", proxy1])).trim();
      assert(now === `${startedAt} true`, "hot path left the container running with the same StartedAt", `${startedAt} -> ${now}`);
      generation = r.generation;
      assert(fpOfPem(certA1.certPem) === certA1.fp, "helper sanity: fp is the cert's sha256", "mismatch");
    });

    await step("probe-and-inventory-no-secrets", async () => {
      const probe = await adapter.manualTls({ action: "probe", hostnames: [hostA, hostB, hostA] });
      const byHost = Object.fromEntries(probe.served.map((s) => [s.hostname, s.fingerprintSha256]));
      assert(probe.served.length === 2 && byHost[hostA] === certA1.fp && byHost[hostB] === certB.fp, "probe: one row per distinct host with the served fingerprint", JSON.stringify(probe));
      const unknown = await adapter.manualTls({ action: "probe", hostnames: [h("nobody")] });
      const fpUnknown = unknown.served[0].fingerprintSha256;
      assert(fpUnknown !== certA1.fp && fpUnknown !== certB.fp, "probe: an unassigned host is not served a manual certificate", String(fpUnknown));
      const inv = await adapter.manualTls({ action: "inventory" });
      assert(inv.generation === 1 && inv.verified === true, "inventory: generation 1, verified", `${inv.generation}/${inv.verified}`);
      const ids = inv.versions.map((v) => v.versionId).sort();
      assert(JSON.stringify(ids) === JSON.stringify([idA1, idA2, idB, idW, idOrphan].sort()), "inventory lists every staged version", ids.join(","));
      const a1 = inv.versions.find((v) => v.versionId === idA1);
      assert(a1.fingerprintSha256 === certA1.fp && a1.names.includes(hostA), "inventory fingerprint and names of A1", JSON.stringify(a1));
      assert(inv.entries.length === 2 && inv.missing.length === 0, "inventory: 2 entries, nothing missing", JSON.stringify({ entries: inv.entries.length, missing: inv.missing }));
      const text = JSON.stringify([probe, inv]);
      assert(!/-----BEGIN/.test(text) && !text.includes(certA1.keyPem.split("\n")[1]), "no PEM and no key bytes in probe/inventory", "found");
    });

    await step("stale-generation-refused", async () => {
      const err = await rejection(adapter.manualTls({
        action: "publish", baseGeneration: 0,
        entries: [{ versionId: idA2, assignedHosts: [hostA] }],
        expect: [{ hostname: hostA, fingerprintSha256: certA2.fp }],
      }));
      assert(err !== null && reasonOf(err) === "TLS_MANIFEST_CONFLICT", "stale base generation refused as TLS_MANIFEST_CONFLICT", err ? reasonOf(err) : "published");
      assert((await servedFp(hostA)) === certA1.fp, "the refusal changed nothing: A1 still served", "other");
      const missing = await rejection(adapter.manualTls({
        action: "publish", baseGeneration: generation,
        entries: [{ versionId: versionId(), assignedHosts: [hostA] }], expect: [],
      }));
      assert(missing !== null && reasonOf(missing) === "TLS_VERSION_MISSING", "unknown version refused as TLS_VERSION_MISSING", missing ? reasonOf(missing) : "published");
    });

    await step("publish-replay", async () => {
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: 0,
        entries: [{ versionId: idA1, assignedHosts: [hostA] }, { versionId: idB, assignedHosts: [hostB] }],
        expect: [{ hostname: hostA, fingerprintSha256: certA1.fp }],
      });
      assert(r.outcome === "served" && r.generation === 1, "replay of the applied publish answers served at generation 1, no new generation", JSON.stringify(r));
      assert((await adapter.manualTls({ action: "inventory" })).generation === 1, "generation stays 1", "moved");
    });

    await step("capture-refused-keeps-serving", async () => {
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: generation,
        entries: [{ versionId: idA1, assignedHosts: [hostA] }, { versionId: idB, assignedHosts: [hostB] }, { versionId: idW, assignedHosts: [`*.${DOMAIN}`] }],
        expect: [],
      });
      assert(r.outcome === "captures_host" || r.outcome === "manual_overlap", "wildcard that would capture the routed ACME host c is refused", JSON.stringify(r));
      assert(r.generation === generation, "refusal leaves the generation unchanged", String(r.generation));
      assert(r.violations.some((v) => v.hostname === hostC), "violation names host c", JSON.stringify(r.violations));
      assert((await servedFp(hostA)) === certA1.fp && (await servedFp(hostB)) === certB.fp, "both manual hosts keep their certificates", "changed");
    });

    await step("rotation-under-load", async () => {
      const seen = { a: [], b: [] };
      let errors = 0;
      let stop = false;
      const worker = (host, key) => (async () => {
        while (!stop) {
          try {
            const fp = await servedFp(host);
            seen[key].push({ fp, t: Date.now() });
          } catch {
            errors += 1;
          }
          await sleep(5);
        }
      })();
      const workers = [worker(hostA, "a"), worker(hostA, "a"), worker(hostA, "a"), worker(hostB, "b"), worker(hostB, "b")];
      await sleep(600);
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: generation,
        entries: [{ versionId: idA2, assignedHosts: [hostA] }, { versionId: idB, assignedHosts: [hostB] }],
        expect: [{ hostname: hostA, fingerprintSha256: certA2.fp, notFingerprintSha256: certA1.fp }, { hostname: hostB, fingerprintSha256: certB.fp }],
      });
      const returnedAt = Date.now();
      await sleep(600);
      stop = true;
      await Promise.all(workers);
      assert(r.outcome === "served" && r.generation === generation + 1, "rotation publishes served at generation+1", JSON.stringify(r));
      generation = r.generation;
      info(`${seen.a.length} handshakes on host a, ${seen.b.length} on host b during the rotation`);
      assert(seen.a.length > 50 && seen.b.length > 30, "enough load to mean something", `${seen.a.length}/${seen.b.length}`);
      assert(errors === 0, "zero TLS errors under load", String(errors));
      const strays = seen.a.filter((x) => x.fp !== certA1.fp && x.fp !== certA2.fp);
      assert(strays.length === 0, "host a only ever served A1 or A2 (never a default or foreign certificate)", short(strays[0]?.fp));
      assert(seen.a.some((x) => x.fp === certA1.fp) && seen.a.some((x) => x.fp === certA2.fp), "the load saw both the old and the new certificate", "only one side seen");
      const late = seen.a.filter((x) => x.fp === certA1.fp && x.t > returnedAt);
      assert(late.length === 0, "no handshake completed on A1 after the publish returned", String(late.length));
      assert(seen.b.every((x) => x.fp === certB.fp), "host b (not rotated) never blinked", short(seen.b.find((x) => x.fp !== certB.fp)?.fp));
      assert((await servedFp(hostA)) === certA2.fp, "A2 is served after the publish returned", "other");
      const now = (await docker(["inspect", "-f", "{{.State.StartedAt}} {{.State.Running}} {{.RestartCount}}", proxy1])).trim();
      assert(now === `${startedAt} true 0`, "StartedAt unchanged, RestartCount 0 (no restart for a rotation)", `${startedAt} -> ${now}`);
    });

    await step("executor-restart-recovers", async () => {
      const before = await adapter.manualTls({ action: "inventory" });
      // A crash between the state file and the manifest: the manifest is gone, the state says generation N.
      await unlink(manifestPath);
      await until("Traefik drops the manual certificate once the manifest is gone", 20_000, async () => (await servedFp(hostA)) !== certA2.fp);
      adapter = newAdapter(); // the executor restarted: a fresh adapter on the same ingress root
      await adapter.ensureIngressProxy(); // recoverAtStart runs inside it, and the existing proxy is kept
      await until("A2 served again after recoverAtStart", 20_000, async () => (await servedFp(hostA)) === certA2.fp);
      assert((await servedFp(hostB)) === certB.fp, "host b served again as well", "other");
      const after = await adapter.manualTls({ action: "inventory" });
      assert(after.generation === before.generation && after.verified === true, "generation and verified survive the restart", `${before.generation}->${after.generation}/${after.verified}`);
      assert(JSON.stringify(after.entries) === JSON.stringify(before.entries), "assignments survive the restart", JSON.stringify(after.entries));
      const manifest = await readFile(manifestPath, "utf8");
      assert(!manifest.includes("BEGIN") && manifest.includes(idA2) && !manifest.includes(idA1), "manifest re-rendered from the state: references only, A2 not A1", "other content");
      const now = await inspectOf(proxy1);
      assert(now.Id === proxy1Id && now.State.StartedAt === startedAt && now.State.Running === true, "the executor restart neither recreated nor restarted the proxy", `${now.Id === proxy1Id} ${startedAt} -> ${now.State.StartedAt}`);
      const r = await adapter.manualTls({
        action: "publish", baseGeneration: after.generation,
        entries: after.entries, expect: [{ hostname: hostA, fingerprintSha256: certA2.fp }],
      });
      assert(r.outcome === "served", "the restarted adapter can publish on top of the recovered state", JSON.stringify(r));
      generation = r.generation;
    });

    await step("gc", async () => {
      const old = new Date(Date.now() - 10 * 60 * 1000);
      for (const id of [idA1, idOrphan, idW]) await utimes(path.join(storeDir, id), old, old);
      const stale = await rejection(adapter.manualTls({ action: "gc", baseGeneration: generation - 1 }));
      assert(stale !== null && reasonOf(stale) === "TLS_MANIFEST_CONFLICT", "gc with another generation refused", stale ? reasonOf(stale) : "ran");
      assert(await exists(path.join(storeDir, idA1)), "the refused gc removed nothing", "gone");
      const r = await adapter.manualTls({ action: "gc", baseGeneration: generation });
      const removed = [...r.removed].sort();
      // A1 stays: it is the lastVerified of the previous generation only until the verified publish above replaced it,
      // so it is unreferenced now; the orphan and the unused wildcard are plain orphans. A2 and B are current.
      assert(JSON.stringify(removed) === JSON.stringify([idA1, idOrphan, idW].sort()), "gc removes exactly the old-enough unreferenced versions", removed.join(","));
      assert(!(await exists(path.join(storeDir, idA1))) && (await exists(path.join(storeDir, idA2))) && (await exists(path.join(storeDir, idB))), "A1 gone; A2 and B kept on disk", "other");
      const inv = await adapter.manualTls({ action: "inventory" });
      assert(inv.missing.length === 0 && inv.versions.length === 2, "inventory after gc: A2 and B, nothing missing", JSON.stringify({ n: inv.versions.length, missing: inv.missing }));
      assert((await servedFp(hostA)) === certA2.fp && (await servedFp(hostB)) === certB.fp, "gc never interrupted serving", "changed");
    });

    // ---- phase 2: a proxy created by the 680febb release, an ACME store with identical names, the cold path ----
    const acmeD = makeCert({ sans: [hostD] });
    const acmeE = makeCert({ sans: [hostE] });
    const manD = makeCert({ sans: [hostD] }); // same names as the ACME entry: identical SNI key
    const manE = makeCert({ sans: [hostE] });
    const idD = versionId();
    const idE = versionId();
    const acmeFixture = JSON.stringify({
      le: {
        Account: { Email: "ops@example.test", Registration: { body: { status: "valid" }, uri: "" }, PrivateKey: "", KeyType: "4096" },
        Certificates: [hostD, hostE].map((main, i) => ({ domain: { main }, certificate: b64([acmeD, acmeE][i].certPem), key: "KEY", Store: "default" })),
      },
    }, null, 2);
    const acmeFile2 = path.join(ingressRoot2, "acme", "acme.json");
    let adapter2 = null;
    let proxy2Id = null;
    let startedAt2 = null;

    await step("setup-legacy-payload-proxy", async () => {
      const sources = {};
      let legacyOk = true;
      try {
        sources.old = await git(["show", `${LEGACY_COMMIT}:apps/docker-executor/src/traefik-config.ts`]);
        sources.now = await readFile(path.join(repoRoot, "apps/docker-executor/src/traefik-config.ts"), "utf8");
      } catch (err) {
        legacyOk = false;
        skip("legacy-payload-equals-680febb", `git show ${LEGACY_COMMIT} unavailable (${String(err.message).slice(0, 80)})`);
      }
      if (legacyOk) {
        for (const name of ["buildIngressProxyContainerPayload", "buildTraefikStaticYaml"]) {
          const a = functionSource(sources.old, name);
          const b = functionSource(sources.now, name);
          assert(a !== null && a === b, `${name} is byte-identical to ${LEGACY_COMMIT} (the payload of that release is the current one)`, a === null ? "not found" : "differs");
        }
      }
      const fm2 = new TraefikIngressFileManager(ingressRoot2, null);
      const ensured = await fm2.ensureStaticConfig(null);
      await writeFile(acmeFile2, acmeFixture, { mode: 0o600 }); // BEFORE any proxy runs on this root
      await route(fm2, "site_adp2", "d", hostD);
      await route(fm2, "site_adp2", "e", hostE);
      await docker(["network", "create", "--label", "io.hostingpanel.managed=true", "--label", "io.hostingpanel.network_role=ingress_public", net2]);
      const built = buildIngressProxyContainerPayload({
        traefikImage: TRAEFIK_IMAGE,
        httpHostPort: PORT2.http,
        httpsHostPort: PORT2.https,
        staticConfigHostPath: fm2.staticConfigPath,
        dynamicDirHostPath: fm2.dynamicDirPath,
        acmeDirHostPath: fm2.acmeDirPath,
        staticSha256: ensured.staticSha256,
        user: `${String(process.getuid())}:${String(process.getgid())}`,
      });
      // The only difference from the release: the test seam's network name.
      const legacy = { ...built, HostConfig: { ...built.HostConfig, NetworkMode: net2 }, NetworkingConfig: { EndpointsConfig: { [net2]: { GwPriority: 1 } } } };
      const created = await viaGate(gateSocket, "POST", `/containers/create?name=${proxy2}`, legacy);
      assert(created.status === 201, "legacy proxy created", `${created.status} ${created.body.slice(0, 120)}`);
      proxy2Id = JSON.parse(created.body).Id;
      const started = await viaGate(gateSocket, "POST", `/containers/${proxy2Id}/start`);
      assert(started.status === 204, "legacy proxy started", String(started.status));
      await until("legacy Traefik answers TLS", 40_000, () => servedFp(hostD, PORT2.https));
      const c = await inspectOf(proxy2);
      startedAt2 = c.State.StartedAt;
      assert(c.Id === proxy2Id, "ids agree", c.Id);
      info(`${proxy2} up with the ${LEGACY_COMMIT} payload (StartedAt ${startedAt2}) over a fixture acme.json with ${hostD} and ${hostE}`);
    }, { needs: "p1", setup: "p2" });

    await step("upgrade-no-recreate", async () => {
      adapter2 = newAdapter2();
      const before = await readFile(acmeFile2);
      const r = await adapter2.ensureIngressProxy();
      const c = await inspectOf(proxy2);
      assert(r.status === "running" && c.Id === proxy2Id && c.State.StartedAt === startedAt2 && c.State.Running === true, "the new adapter keeps the legacy proxy: same container id, same StartedAt", `${c.Id === proxy2Id} ${startedAt2} -> ${c.State.StartedAt}`);
      assert(c.RestartCount === 0, "RestartCount 0", String(c.RestartCount));
      assert(Buffer.compare(before, await readFile(acmeFile2)) === 0, "ensure left acme.json byte-identical", "changed");
      const again = await adapter2.ensureIngressProxy();
      assert(again.status === "running" && (await inspectOf(proxy2)).Id === proxy2Id, "and again", "recreated");
    }, { needs: "p2" });

    await step("cold-path-refused-hot", async () => {
      await adapter2.manualTls(put(idD, manD));
      await adapter2.manualTls(put(idE, manE));
      const acmeBefore = await readFile(acmeFile2);
      const r = await adapter2.manualTls({
        action: "publish", baseGeneration: 0,
        entries: [{ versionId: idD, assignedHosts: [hostD] }],
        expect: [{ hostname: hostD, fingerprintSha256: manD.fp }],
      });
      assert(r.outcome === "acme_eviction_required", "identical-name ACME entry: refused hot with acme_eviction_required", JSON.stringify(r));
      assert(r.violations.some((v) => v.hostname === hostD && v.kind === "acme_eviction_required"), "violation names the host", JSON.stringify(r.violations));
      assert(r.evicted.length === 0 && r.generation === 0, "nothing evicted, generation unchanged", JSON.stringify({ e: r.evicted, g: r.generation }));
      assert(Buffer.compare(acmeBefore, await readFile(acmeFile2)) === 0, "acme.json untouched by the refusal", "changed");
      const c = await inspectOf(proxy2);
      assert(c.State.StartedAt === startedAt2 && c.State.Running === true, "proxy not restarted by the refusal", `${startedAt2} -> ${c.State.StartedAt}`);
      assert((await servedFp(hostD, PORT2.https)) !== manD.fp, "the manual certificate is not served", "served");
    }, { needs: "p2" });

    await step("cold-path-evicts-with-backup", async () => {
      const acmeBefore = await readFile(acmeFile2);
      const r = await adapter2.manualTls({
        action: "publish", baseGeneration: 0, evictAcme: true,
        entries: [{ versionId: idD, assignedHosts: [hostD] }],
        expect: [{ hostname: hostD, fingerprintSha256: manD.fp }],
      });
      assert(r.outcome === "served" && r.generation === 1, "evictAcme:true publishes and is served at generation 1", JSON.stringify(r));
      assert(r.evicted.length === 1 && r.evicted[0].main === hostD && r.collateralHosts.length === 0, "exactly the entry of host d is evicted, no collateral", JSON.stringify({ e: r.evicted, c: r.collateralHosts }));
      const dir = path.dirname(acmeFile2);
      const backups = (await readdir(dir)).filter((f) => /^acme\.json\.hp-evict-\d{8}T\d{6}Z\.bak$/.test(f));
      assert(backups.length === 1, "one eviction backup", backups.join(","));
      const bak = path.join(dir, backups[0]);
      assert(((await stat(bak)).mode & 0o777) === 0o600, "backup mode 0600", ((await stat(bak)).mode & 0o777).toString(8));
      assert(Buffer.compare(acmeBefore, await readFile(bak)) === 0, "backup is byte-equal to the store before the eviction", "differs");
      assert(((await stat(acmeFile2)).mode & 0o777) === 0o600, "acme.json stays 0600", ((await stat(acmeFile2)).mode & 0o777).toString(8));
      const mains = JSON.parse(await readFile(acmeFile2, "utf8")).le.Certificates.map((x) => x.domain.main);
      assert(JSON.stringify(mains) === JSON.stringify([hostE]), "acme.json keeps only the entry of host e", mains.join(","));
      const c = await inspectOf(proxy2);
      assert(c.State.Running === true && c.State.StartedAt !== startedAt2, "the proxy was restarted by the cold path", `${startedAt2} -> ${c.State.StartedAt}`);
      assert((await servedFp(hostD, PORT2.https)) === manD.fp, "independent handshake serves the manual fingerprint of host d", "other");
      startedAt2 = c.State.StartedAt;
    }, { needs: "p2" });

    await step("cold-path-failed-probe-restores", async () => {
      const failing = newAdapter2({ deadlineMs: 3_000, intervalMs: 200 });
      const acmeBefore = await readFile(acmeFile2);
      const r = await failing.manualTls({
        action: "publish", baseGeneration: 1, evictAcme: true,
        entries: [{ versionId: idD, assignedHosts: [hostD] }, { versionId: idE, assignedHosts: [hostE] }],
        expect: [{ hostname: hostE, fingerprintSha256: "f".repeat(64) }],
      });
      assert(r.outcome === "not_served_reverted", "a probe that cannot succeed reverts", JSON.stringify(r));
      // acme.json is restored, so the result reports the store as untouched: nothing evicted, no collateral.
      assert(r.evicted.length === 0 && r.collateralHosts.length === 0, "the restored store reports no eviction and no collateral", JSON.stringify({ e: r.evicted, c: r.collateralHosts }));
      assert(Buffer.compare(acmeBefore, await readFile(acmeFile2)) === 0, "acme.json restored byte-for-byte from the backup", "differs");
      const restoredMains = JSON.parse(await readFile(acmeFile2, "utf8")).le.Certificates.map((x) => x.domain.main);
      assert(restoredMains.includes(hostE), "the ACME entry of host e is back in acme.json", restoredMains.join(","));
      assert(((await stat(acmeFile2)).mode & 0o777) === 0o600, "restored acme.json is 0600", ((await stat(acmeFile2)).mode & 0o777).toString(8));
      const c = await inspectOf(proxy2);
      assert(c.State.Running === true, "the proxy is running again", String(c.State.Status));
      await until("host d still served from the reverted manifest", 20_000, async () => (await servedFp(hostD, PORT2.https)) === manD.fp);
      assert((await servedFp(hostE, PORT2.https)) !== manE.fp, "host e is not served the manual certificate (reverted)", "served");
      const inv = await failing.manualTls({ action: "inventory" });
      assert(inv.verified === true && inv.entries.length === 1 && inv.entries[0].versionId === idD, "state is back on the last verified generation", JSON.stringify(inv.entries));
    }, { needs: "p2" });

    await step("gate-clean", async () => {
      assert(gateDenied.length === 0, "the gate denied nothing: the adapter asked Docker only for this run's resources", gateDenied.slice(0, 3).join(" | "));
      for (const [name, net] of [[proxy1, net1], [proxy2, net2]]) {
        const nets = Object.keys((await inspectOf(name)).NetworkSettings.Networks);
        assert(nets.length === 1 && nets[0] === net, `${name} is attached to its own network only (no live site network)`, nets.join(","));
      }
      info(`gate saw ${gateLog.length} request(s), ${gateDenied.length} denied`);
    });
  } finally {
    await cleanup();
    total += 1;
    const containerLeft = dockerTouched
      ? (await docker(["ps", "-aq", "--filter", `name=${runPrefix}`]).catch(() => "x")).trim() !== ""
      : false;
    const networkLeft = dockerTouched
      ? (await docker(["network", "ls", "-q", "--filter", `name=${runPrefix}`]).catch(() => "x")).trim() !== ""
      : false;
    const tmpLeft = tmpDir && !keepTmp ? await exists(tmpDir) : false;
    if (!containerLeft && !networkLeft && !tmpLeft && !gateServer?.listening) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: container=${String(containerLeft)} network=${String(networkLeft)} tmp=${String(tmpLeft)} gate=${String(gateServer?.listening)}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed${skipped > 0 ? `, ${String(skipped)} skipped (not counted in n/m)` : ""}`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
