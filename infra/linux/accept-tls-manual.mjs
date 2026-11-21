#!/usr/bin/env node
/**
 * Real-process check for manual TLS certificates (HCP-SPEC-004, ADR 0031): TLS-05..TLS-10, TLS-13.
 *
 * The shipped executor code (apps/docker-executor/dist: TraefikIngressFileManager, ManualTlsStore,
 * readAcmeStoreEntries, evictAcmeEntries, waitForServed) and the shipped contracts plan
 * (planManualCertificates) drive a real Traefik v3.7.19 next to a real Pebble v2.10.3, so what is
 * proven is the code that ships, not a re-implementation. The publish sequence below is the one of
 * DockerEngineSocketAdapter.publishManualTls (verify ids -> plan -> hot path | cold eviction ->
 * probe -> markVerified | revert); the bare binary only replaces "stop/start the proxy container"
 * by stopping/starting the child process. A second, container part runs the real traefik:v3.7
 * image with the shipped container payload (uid:gid, CapDrop ALL, read-only dynamic bind) and
 * checks the 0700/0400 store, a rotation without restart, and that `docker inspect` carries no key.
 *
 * Machine safety: every listener binds 127.0.0.1 only (ports 16000-16002, 16053, 16055, 16080,
 * 16081, 16100, 16443, 16444). Binaries are downloaded once into HP_PEBBLE_CACHE (default
 * ~/.cache/hp-acme-pebble, shared with accept-acme-pebble.mjs); every download has a pinned sha256.
 * Everything else lives in one mkdtemp directory os.tmpdir()/hp_swarmtest_tls_<hex>_*, removed
 * with every child process and the optional container hp_swarmtest_tls_<hex>_proxy in `finally`
 * and on SIGINT/SIGTERM. The real hp_ingress_proxy of this host is never touched. No shell is used.
 *
 * Steps (RESULT n/m passed; the container steps are SKIPped, not counted, without Docker or the
 * local traefik:v3.7 image, or with HP_TLS_SKIP_DOCKER=1):
 *   binaries-ready, pebble-and-challtestsrv-up, static-config-manual-certs-0700, traefik-and-acme-issued,
 *   tls05-plan-says-eviction, tls05-hot-superset, tls05-cold-evict, tls07-wildcard-exact,
 *   wildcard-sibling-renews, capture-refused, tls08-rotation-under-load, bad-entry-not-fatal,
 *   tls10-restart-x5, tls09-crash-recovery, tls06-back-to-acme, tls06-refused-under-wildcard,
 *   gc-after-verify, container-serves-manual-0700, inspect-no-secrets, nothing-left.
 * `upgrade-no-recreate` (proxy created by the previous release, new executor ensure => same
 * container) is not run here: DockerEngineSocketAdapter.ensureIngressProxy owns the fixed name
 * hp_ingress_proxy, which on a host with a live proxy would be that proxy. Run it on a clean host.
 */

import { execFile, spawn } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCert, makeChain } from "./tls-test-certs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (p) => pathToFileURL(path.resolve(repoRoot, p)).href;
const {
  TraefikIngressFileManager,
  ManualTlsStore,
  acmeStorageFileName,
  buildIngressProxyContainerPayload,
  evictAcmeEntries,
  normaliseEntries,
  readAcmeStoreEntries,
  waitForServed,
} = await import(dist("apps/docker-executor/dist/index.js"));
const { planManualCertificates, traefikNameMatches } = await import(dist("packages/contracts/dist/index.js"));

const TRAEFIK_URL = "https://github.com/traefik/traefik/releases/download/v3.7.19/traefik_v3.7.19_linux_amd64.tar.gz";
const TRAEFIK_SHA256 = "97534a68335a087137d0f2adecefe37c8216ac10114dc7e5b510f2a8a12f89be";
const PEBBLE_RELEASE = "https://github.com/letsencrypt/pebble/releases/download/v2.10.3";
const PEBBLE_RAW = "https://raw.githubusercontent.com/letsencrypt/pebble/v2.10.3/test/certs";
// From the GitHub release assets' digest of v2.10.3 and, for the certs, the files at that tag.
const PEBBLE_SHA256 = {
  pebble: "7e33cf3e426b67e9e647c44e8cc91683caa8ab331f7a99e5e27fcee291c4c7e2",
  challtestsrv: "00b2c5ef525cd8ad56cda898a7cac6169a10b0fd3f2a7456fe0cec92e7b36cb6",
  minica: "0c502e52627ff7de972c7e9e065640103b4589b4e2d23d3fcf21bef1e3c8c67c",
  cert: "c87fb918d9bac8db11aa54493b5f0cf6e0725a3fe73f617d1c64737e1ab4caf9",
  key: "0977979255b0e0721c17335c056b627f66a43cf56e5a52f3cda81fb111ecf00e",
};
const HOST = "127.0.0.1";
const PORT = {
  dns: 16053, chall: 16055, acme: 16000, pebbleMgmt: 16001, tlsalpn: 16002,
  web: 16080, websecure: 16443, backend: 16100, containerWeb: 16081, containerSecure: 16444,
};
const DOMAIN = "hp-tls.test";
const h = (label) => `${label}.${DOMAIN}`;
const TRAEFIK_IMAGE = "traefik:v3.7";
const BACKEND_BODY = "hp-tls-ok";
const ACME_WAIT_MS = 180_000;
// Pebble certificates live 20 days: shorter than Traefik's 30-day renew window, so a restart renews them.
const PEBBLE_VALIDITY_SECONDS = 1_728_000;

const cacheDir = path.resolve(process.env.HP_PEBBLE_CACHE || path.join(os.homedir(), ".cache", "hp-acme-pebble"));
const runHex = randomBytes(4).toString("hex");
const runPrefix = `hp_swarmtest_tls_${runHex}`;
const containerName = `${runPrefix}_proxy`;
const children = new Set();
const servers = [];
let tmpDir = null;
let containerCreated = false;
const keepTmp = process.env.HP_TLS_KEEP === "1"; // debugging: keep logs and files of a failed run

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const exists = (p) => stat(p).then(() => true, () => false);
const versionId = () => `ctv_${randomBytes(16).toString("hex")}`;
const fpOfPem = (pem) => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
const short = (fp) => String(fp).slice(0, 12);

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / ${actual}`);
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${path.basename(file)} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout)),
    );
  });
}

/** Downloads once; the pinned sha256 must match the download and the cached file. */
async function cached(url, rel, pinnedSha) {
  const file = path.join(cacheDir, rel);
  if (!(await exists(file))) {
    await mkdir(path.dirname(file), { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    assert(res.ok, `download ${url}`, `HTTP ${String(res.status)}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert(sha256(body) === pinnedSha, `sha256 of ${url} is ${pinnedSha}`, sha256(body));
    await writeFile(`${file}.part`, body);
    await rename(`${file}.part`, file);
  }
  const actual = sha256(await readFile(file));
  assert(actual === pinnedSha, `sha256 of ${rel} is ${pinnedSha}`, actual);
  return file;
}

/** Unpacks a verified tarball into the cache and returns the path of the named binary. */
async function unpack(tarball, name) {
  const entry = (await run("tar", ["-tzf", tarball])).split("\n").find((l) => path.basename(l) === name);
  assert(entry, `${name} inside ${path.basename(tarball)}`, "missing");
  const dir = `${tarball}.d`;
  await mkdir(dir, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", dir]);
  await chmod(path.join(dir, entry), 0o755); // Pebble's tarballs ship the binaries without the execute bit
  return path.join(dir, entry);
}

function startChild(name, file, args, env, logPath) {
  const fd = openSync(logPath, "a");
  const child = spawn(file, args, { env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.exited = new Promise((resolve) => child.once("exit", resolve));
  child.once("error", () => {});
  child.hpName = name;
  children.add(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await Promise.race([child.exited.then(() => true), sleep(5_000).then(() => false)])) === false) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

function request(url, { method = "GET", body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method, ca, headers: { "User-Agent": "hp-accept-tls-manual" }, timeout: 10_000, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout ${url}`)));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
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

function listen(server, port) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
}

/** One TLS handshake with SNI; fingerprint, issuer, serial and the served chain (leaf first). */
function peer(port, servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: HOST, port, servername, rejectUnauthorized: false }, () => {
      const leaf = s.getPeerCertificate(true);
      const chain = [];
      for (let c = leaf, guard = 0; c && guard < 6; guard += 1) {
        chain.push(String(c.fingerprint256).replaceAll(":", "").toLowerCase());
        if (!c.issuerCertificate || c.issuerCertificate === c) break;
        c = c.issuerCertificate;
      }
      s.destroy();
      resolve({ fp: chain[0], chain, issuer: leaf.issuer?.CN ?? "", serial: leaf.serialNumber });
    });
    s.setTimeout(10_000, () => s.destroy(new Error("tls timeout")));
    s.on("error", reject);
  });
}
const peerCert = (servername) => peer(PORT.websecure, servername);

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const child of children) await stopChild(child);
    if (containerCreated) await run("docker", ["rm", "-f", containerName]).catch(() => undefined);
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (tmpDir && !keepTmp) await rm(tmpDir, { recursive: true, force: true });
    else if (tmpDir) console.log(`INFO HP_TLS_KEEP=1: kept ${tmpDir}`);
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

async function main() {
  let passed = 0;
  let total = 0;
  let setupFailed = false;
  let traefikLog = null;
  const setupSteps = new Set(["binaries-ready", "pebble-and-challtestsrv-up", "static-config-manual-certs-0700", "traefik-and-acme-issued"]);
  const step = async (name, fn) => {
    total += 1;
    if (setupFailed) {
      console.log(`FAIL ${name}: skipped after setup failure`);
      return;
    }
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      if (setupSteps.has(name)) setupFailed = true;
      const tail = traefikLog ? await readFile(traefikLog, "utf8").catch(() => "") : "";
      if (tail) console.log(`--- traefik.log tail ---\n${tail.trimEnd().split("\n").slice(-30).join("\n")}\n---`);
    }
  };
  let skipped = 0;
  const skip = (name, why) => {
    skipped += 1;
    console.log(`SKIP ${name}: ${why}`);
  };
  const info = (msg) => console.log(`INFO ${msg}`);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  const bin = {};
  const certs = {
    minica: path.join(cacheDir, "certs", "pebble.minica.pem"),
    cert: path.join(cacheDir, "certs", "localhost", "cert.pem"),
    key: path.join(cacheDir, "certs", "localhost", "key.pem"),
  };
  const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() };
  const panel = {
    hostname: h("panel"),
    ipv4: HOST,
    acmeEmail: `acme@${DOMAIN}`,
    acmeStaging: false,
    acmeCaServer: `https://${HOST}:${String(PORT.acme)}/dir`,
    acmeCaCertFile: certs.minica,
    upstreamPort: PORT.backend,
  };
  const ingressRoot = path.join(tmpDir, "ingress");
  const dynDir = path.join(path.resolve(ingressRoot), "dynamic");
  // The manifest refers to the manual-certs dir as the proxy sees it: here the host path of the bare binary.
  const fm = new TraefikIngressFileManager(ingressRoot, panel, { manualCertMountDir: path.join(dynDir, "manual-certs") });
  const storePath = path.join(fm.acmeDirPath, acmeStorageFileName(panel));
  const manifestPath = path.join(fm.dynamicDirPath, "hp-manual-certificates.yml");
  const storeDeps = (writeManifest) => ({
    dir: fm.manualCertsDirPath,
    statePath: fm.manualTlsStatePath,
    mountDir: fm.dynamicDirPath,
    writeManifest,
    gcGraceMs: 0, // the store's default 5-minute grace protects a put that is not yet published
  });
  const store = new ManualTlsStore(storeDeps((content) => fm.writeManualCertificateManifest(content)));
  let traefik = null;
  let generatedStatic = "";

  // ---- helpers over the shipped modules -------------------------------------------------------------

  const startTraefik = async () => {
    const cfg = path.join(tmpDir, "traefik.yml");
    await writeFile(cfg, generatedStatic, { mode: 0o600 });
    traefik = startChild("traefik", bin.traefik, [`--configFile=${cfg}`], baseEnv, traefikLog);
    await until(`traefik on ${HOST}:${String(PORT.websecure)}`, 30_000, () =>
      new Promise((resolve, reject) => {
        assert(traefik.exitCode === null, "traefik running", `exit ${String(traefik.exitCode)}`);
        const s = net.connect(PORT.websecure, HOST, () => {
          s.end();
          resolve(true);
        });
        s.on("error", reject);
      }),
    );
  };
  const restartTraefik = async () => {
    await stopChild(traefik);
    await startTraefik();
  };
  const patchStatic = (text) => {
    let out = text;
    for (const [from, to] of [
      ['":80"', `"${HOST}:${String(PORT.web)}"`],
      ['":443"', `"${HOST}:${String(PORT.websecure)}"`],
      ["/etc/traefik/dynamic", fm.dynamicDirPath],
      ["/etc/traefik/acme", fm.acmeDirPath],
      ["log:\n  format: json", "log:\n  format: json\n  level: DEBUG"],
    ]) {
      assert(out.includes(from), `anchor ${JSON.stringify(from)} in static config`, "missing");
      out = out.split(from).join(to);
    }
    return out;
  };

  /** A routed host of the panel: mode "acme" (certResolver le), "manual" (source manual) or null (removed). */
  const setRoute = async (label, mode) => {
    const k = label.replace(/[^a-z0-9]/g, "_");
    if (mode === null) return void (await fm.removeServiceRoute(`svc_${k}`, "site_tls"));
    await fm.upsertServiceRoute("site_tls", {
      serviceInstanceId: `svc_${k}`,
      containerName: HOST,
      internalPort: PORT.backend,
      hosts: [{ hostname: h(label), tls: true, httpsRedirect: false, redirectTo: null, ...(mode === "manual" ? { source: "manual" } : {}) }],
    });
  };

  const acmeJson = async () => JSON.parse(await readFile(storePath, "utf8"));
  const acmeFp = async (host) => {
    const entry = ((await acmeJson()).le?.Certificates ?? []).find((c) => c.domain.main === host);
    return entry ? fpOfPem(Buffer.from(entry.certificate, "base64").toString("utf8")) : null;
  };
  const acmeHas = async (host) => (await readAcmeStoreEntries(storePath)).entries.some((e) => e.names.includes(host));
  const served = async (host, want, ms = 30_000) => {
    const t0 = Date.now();
    await until(`${host} serves ${short(want)}`, ms, async () => (await peerCert(host)).fp === want, 250);
    return Date.now() - t0;
  };
  const sample = async (host, n) => {
    const seen = new Map();
    for (let i = 0; i < n; i += 1) {
      const fp = (await peerCert(host)).fp;
      seen.set(fp, (seen.get(fp) ?? 0) + 1);
    }
    return seen;
  };
  const putVersion = async (id, cert) => {
    const r = await store.putVersion({
      versionId: id,
      fullchainPem: cert.fullchainPem ?? cert.certPem,
      keyPem: cert.keyPem,
      fingerprintSha256: cert.fp,
    });
    assert(r.written === true, `version ${id} written`, JSON.stringify(r));
  };

  /**
   * DockerEngineSocketAdapter.publishManualTls on the bare binary: CAS state -> plan -> hot path, or with
   * evictAcme the cold path (stop, re-plan on what remains, evict with backup, publish files, start) -> probe ->
   * markVerified | revert. Plan refusals return an outcome and write nothing.
   */
  const publish = async (entries, { expect = [], evictAcme = false } = {}) => {
    const state = await store.readState();
    const base = state?.generation ?? 0;
    const wanted = normaliseEntries(entries);
    const inventory = await store.inventory();
    const names = new Map(inventory.versions.map((v) => [v.versionId, v.names]));
    const missing = wanted.map((e) => e.versionId).filter((id) => !names.has(id));
    assert(missing.length === 0, "every published version stored", missing.join(","));
    const assigned = new Set(wanted.flatMap((e) => e.assignedHosts));
    const planEntries = wanted.map((e) => ({ versionId: e.versionId, names: names.get(e.versionId), assignedHosts: e.assignedHosts }));
    const guardHosts = (await fm.listRoutedHostnames()).filter((x) => !assigned.has(x));
    const acme = await readAcmeStoreEntries(storePath);
    const plan = planManualCertificates({
      entries: planEntries,
      acme: acme.entries.map((e) => ({ id: e.id, source: "acme", names: e.names })),
      guardHosts,
    });
    const refusal = (outcome) => ({ outcome, generation: base, violations: plan.violations, served: {}, evicted: [], backupPath: null, collateralHosts: [] });
    const hard = plan.violations.filter((v) => v.kind !== "acme_eviction_required");
    if (hard.length > 0) return refusal(hard.some((v) => v.kind === "manual_overlap") ? "manual_overlap" : "captures_host");
    const evictionHosts = plan.violations.map((v) => v.hostname);
    if (evictionHosts.length > 0 && !evictAcme) return refusal("acme_eviction_required");
    const expectations = expect.flatMap((e) => [
      ...(e.fingerprintSha256 ? [{ hostname: e.hostname, fingerprintSha256: e.fingerprintSha256 }] : []),
      ...(e.notFingerprintSha256 ? [{ hostname: e.hostname, notFingerprintSha256: e.notFingerprintSha256 }] : []),
    ]);
    const verify = async (generation, extra) => {
      const report = expectations.length === 0
        ? { served: true, observed: {} }
        : await waitForServed(expectations, { host: HOST, port: PORT.websecure, deadlineMs: 30_000 });
      if (report.served) await store.markVerified(generation);
      else await store.revertToLastVerified();
      return { outcome: report.served ? "served" : "not_served_reverted", generation, violations: [], served: report.observed, evicted: [], backupPath: null, collateralHosts: [], ...extra };
    };

    if (evictionHosts.length === 0) {
      const { generation } = await store.publishFiles(base, wanted);
      return verify(generation, {});
    }

    await stopChild(traefik);
    let backupPath = null;
    try {
      const fresh = await readAcmeStoreEntries(storePath);
      const hosts = evictionHosts.map((x) => x.toLowerCase());
      const dropped = fresh.entries.filter((e) => e.names.some((n) => hosts.some((x) => traefikNameMatches(x, n))));
      const droppedIds = new Set(dropped.map((e) => e.id));
      const collateral = [...new Set(dropped.flatMap((e) => e.names).map((n) => n.toLowerCase()).filter((n) => !n.startsWith("*") && !assigned.has(n)))].sort();
      const replan = planManualCertificates({
        entries: planEntries,
        acme: fresh.entries.filter((e) => !droppedIds.has(e.id)).map((e) => ({ id: e.id, source: "acme", names: e.names })),
        guardHosts: [...new Set([...guardHosts, ...collateral])],
      });
      if (replan.violations.length > 0) {
        await startTraefik();
        return refusal(replan.violations.some((v) => v.kind === "manual_overlap") ? "manual_overlap" : "captures_host");
      }
      const eviction = await evictAcmeEntries(storePath, hosts, new Date());
      backupPath = eviction.backupPath;
      const { generation } = await store.publishFiles(base, wanted);
      await startTraefik();
      return verify(generation, { evicted: eviction.evicted.map((e) => ({ resolver: e.resolver, main: e.main })), backupPath, collateralHosts: collateral });
    } catch (err) {
      if (backupPath) await copyFile(backupPath, storePath).catch(() => undefined);
      if (traefik.exitCode !== null) await startTraefik().catch(() => undefined);
      throw err;
    }
  };

  /** Load: handshake workers with SNI plus HTTPS workers hitting the backend; counts what was served. */
  const startLoad = (host, { handshakes = 6, requests = 3 } = {}) => {
    const st = { stop: false, seen: new Map(), tlsErr: 0, http200: 0, httpErr: 0 };
    const handshakeWorker = async () => {
      while (!st.stop) {
        try {
          const fp = (await peerCert(host)).fp;
          st.seen.set(fp, (st.seen.get(fp) ?? 0) + 1);
        } catch {
          st.tlsErr += 1;
        }
      }
    };
    const requestWorker = async () => {
      while (!st.stop) {
        try {
          const code = await new Promise((resolve, reject) => {
            const req = https.request({ host: HOST, port: PORT.websecure, servername: host, headers: { Host: host }, rejectUnauthorized: false, agent: false }, (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            });
            req.on("error", reject);
            req.end();
          });
          if (code === 200) st.http200 += 1;
          else st.httpErr += 1;
        } catch {
          st.httpErr += 1;
        }
      }
    };
    st.total = () => [...st.seen.values()].reduce((a, b) => a + b, 0);
    st.done = Promise.all([...Array(handshakes)].map(handshakeWorker).concat([...Array(requests)].map(requestWorker)));
    return st;
  };

  // ---- state the steps share -------------------------------------------------------------------------
  const v = {}; // label -> { id, cert }
  const mk = (label, cert) => (v[label] = { id: versionId(), cert });
  const entry = (label, ...hosts) => ({ versionId: v[label].id, assignedHosts: hosts });
  const manifestIds = async () => [...new Set([...(await readFile(manifestPath, "utf8").catch(() => "")).matchAll(/ctv_[0-9a-f]{32}/g)].map((m) => m[0]))];
  const acmeFps = {};

  try {
    await step("binaries-ready", async () => {
      await cached(`${PEBBLE_RAW}/pebble.minica.pem`, "certs/pebble.minica.pem", PEBBLE_SHA256.minica);
      await cached(`${PEBBLE_RAW}/localhost/cert.pem`, "certs/localhost/cert.pem", PEBBLE_SHA256.cert);
      await cached(`${PEBBLE_RAW}/localhost/key.pem`, "certs/localhost/key.pem", PEBBLE_SHA256.key);
      bin.traefik =
        process.env.HP_TRAEFIK_BIN ||
        (await unpack(await cached(TRAEFIK_URL, "traefik_v3.7.19_linux_amd64.tar.gz", TRAEFIK_SHA256), "traefik"));
      bin.pebble =
        process.env.HP_PEBBLE_BIN ||
        (await unpack(await cached(`${PEBBLE_RELEASE}/pebble-linux-amd64.tar.gz`, "pebble-linux-amd64.tar.gz", PEBBLE_SHA256.pebble), "pebble"));
      bin.chall =
        process.env.HP_CHALLTESTSRV_BIN ||
        (await unpack(
          await cached(`${PEBBLE_RELEASE}/pebble-challtestsrv-linux-amd64.tar.gz`, "pebble-challtestsrv-linux-amd64.tar.gz", PEBBLE_SHA256.challtestsrv),
          "pebble-challtestsrv",
        ));
      const version = await run(bin.traefik, ["version"]);
      assert(version.includes("3.7.19"), "traefik version 3.7.19", version.split("\n")[0]);
      info("traefik 3.7.19, pebble v2.10.3");
    });

    await step("pebble-and-challtestsrv-up", async () => {
      startChild("challtestsrv", bin.chall, [
        "-dnsserver", `${HOST}:${String(PORT.dns)}`, "-management", `${HOST}:${String(PORT.chall)}`,
        "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "", "-defaultIPv4", HOST, "-defaultIPv6", "",
      ], baseEnv, path.join(tmpDir, "challtestsrv.log"));
      const pebbleCfg = path.join(tmpDir, "pebble.json");
      await writeFile(pebbleCfg, JSON.stringify({
        pebble: {
          listenAddress: `${HOST}:${String(PORT.acme)}`, managementListenAddress: `${HOST}:${String(PORT.pebbleMgmt)}`,
          certificate: certs.cert, privateKey: certs.key, httpPort: PORT.web, tlsPort: PORT.tlsalpn, ocspResponderURL: "",
          externalAccountBindingRequired: false, retryAfter: { authz: 1, order: 1 }, keyAlgorithm: "ecdsa",
          profiles: { default: { description: "default profile", validityPeriod: PEBBLE_VALIDITY_SECONDS } },
        },
      }));
      startChild("pebble", bin.pebble, ["-config", pebbleCfg, "-dnsserver", `${HOST}:${String(PORT.dns)}`],
        { ...baseEnv, PEBBLE_VA_NOSLEEP: "1", PEBBLE_WFE_NONCEREJECT: "0" }, path.join(tmpDir, "pebble.log"));
      const ca = await readFile(certs.minica);
      await until("pebble /dir", 20_000, async () => (await request(`https://${HOST}:${String(PORT.acme)}/dir`, { ca })).status === 200);
      await listen(http.createServer((_req, res) => res.writeHead(200).end(BACKEND_BODY)), PORT.backend);
    });

    await step("static-config-manual-certs-0700", async () => {
      const requested = await fm.gatePanelCertificate(panel, async () => ({ a: [], aaaa: [] }));
      assert(requested === false, "panel orders nothing", String(requested));
      await fm.ensureStaticConfig(panel);
      const dir = await stat(fm.manualCertsDirPath);
      assert(dir.isDirectory() && (dir.mode & 0o777) === 0o700, "dynamic/manual-certs is a 0700 directory", (dir.mode & 0o777).toString(8));
      assert(dir.uid === process.getuid(), "manual-certs owned by the executor uid", String(dir.uid));
      assert(!(await exists(manifestPath)), "no manifest on a fresh install", "present");
      assert((await store.readState()) === null, "no manual-tls state on a fresh install", "present");
      generatedStatic = patchStatic(await readFile(fm.staticConfigPath, "utf8"));
    });

    traefikLog = path.join(tmpDir, "traefik.log");
    await step("traefik-and-acme-issued", async () => {
      for (const label of ["shop", "a.w", "plain"]) await setRoute(label, "acme");
      await startTraefik();
      for (const label of ["shop", "a.w", "plain"]) {
        await until(`ACME certificate for ${h(label)} stored`, ACME_WAIT_MS, () => acmeHas(h(label)), 1000);
        acmeFps[label] = await acmeFp(h(label));
        await served(h(label), acmeFps[label]);
      }
      info(`ACME issued: ${Object.entries(acmeFps).map(([k, f]) => `${k}=${short(f)}`).join(" ")}`);
    });

    await step("tls05-plan-says-eviction", async () => {
      mk("shop1", makeCert({ sans: [h("shop")] }));
      await putVersion(v.shop1.id, v.shop1.cert);
      const r = await publish([entry("shop1", h("shop"))], { expect: [{ hostname: h("shop"), fingerprintSha256: v.shop1.cert.fp }] });
      assert(r.outcome === "acme_eviction_required", "same-key manual cert refused with acme_eviction_required", JSON.stringify(r.violations));
      assert(r.violations.every((x) => x.kind === "acme_eviction_required" && x.hostname === h("shop")), "violation names shop", JSON.stringify(r.violations));
      assert(!(await exists(manifestPath)), "nothing written: no manifest", "present");
      assert((await store.readState()) === null, "nothing written: no state", "present");
      assert((await peerCert(h("shop"))).fp === acmeFps.shop, "shop still served by the ACME certificate", "changed");
    });

    await step("tls05-hot-superset", async () => {
      mk("hi", makeCert({ sans: [h("shop"), h("zz.shop")] }));
      await putVersion(v.hi.id, v.hi.cert);
      const pid = traefik.pid;
      const r = await publish([entry("hi", h("shop"))], { expect: [{ hostname: h("shop"), fingerprintSha256: v.hi.cert.fp }] });
      assert(r.outcome === "served" && r.generation === 1, "superset-SAN cert served on the hot path (generation 1)", `${r.outcome} ${String(r.generation)}`);
      assert(traefik.pid === pid && traefik.exitCode === null, "proxy not restarted", "restarted");
      assert(await acmeHas(h("shop")), "ACME entry for shop untouched (nothing evicted)", "gone");
      await setRoute("shop", "manual"); // design order: put -> publish -> routes
      await sleep(3000);
      const seen = await sample(h("shop"), 6);
      assert(seen.size === 1 && seen.has(v.hi.cert.fp), "shop keeps the manual certificate after the route flip", JSON.stringify([...seen]));
      for (let i = 0; i < 3; i += 1) {
        await restartTraefik();
        assert((await peerCert(h("shop"))).fp === v.hi.cert.fp, `restart ${String(i + 1)}/3 serves the manual certificate`, "ACME won");
      }
    });

    await step("tls05-cold-evict", async () => {
      const before = await readFile(storePath);
      const refused = await publish([entry("shop1", h("shop"))], { expect: [{ hostname: h("shop"), fingerprintSha256: v.shop1.cert.fp }] });
      assert(refused.outcome === "acme_eviction_required", "without confirmation the same-key set is refused", refused.outcome);
      const r = await publish([entry("shop1", h("shop"))], { expect: [{ hostname: h("shop"), fingerprintSha256: v.shop1.cert.fp }], evictAcme: true });
      assert(r.outcome === "served", "cold path serves the manual certificate", `${r.outcome} ${JSON.stringify(r.violations)}`);
      assert(r.evicted.length === 1 && r.evicted[0].main === h("shop"), "exactly the shop entry evicted", JSON.stringify(r.evicted));
      assert(r.collateralHosts.length === 0, "no collateral hosts", r.collateralHosts.join(","));
      const bak = await stat(r.backupPath);
      assert((bak.mode & 0o777) === 0o600, "backup is 0600", (bak.mode & 0o777).toString(8));
      assert(Buffer.compare(await readFile(r.backupPath), before) === 0, "backup equals the original acme.json bytes", "differs");
      assert(!(await acmeHas(h("shop"))), "shop removed from acme.json", "still there");
      assert(await acmeHas(h("a.w")) && await acmeHas(h("plain")), "other ACME entries kept", "lost");
      let wins = 0;
      for (let i = 0; i < 5; i += 1) {
        await restartTraefik();
        await sleep(1000);
        if ((await peerCert(h("shop"))).fp === v.shop1.cert.fp) wins += 1;
      }
      assert(wins === 5, "5/5 restarts serve the manual certificate", `${String(wins)}/5`);
      await sleep(20_000);
      assert(!(await acmeHas(h("shop"))), "no new ACME order for shop after 20 s", "ordered");
      info(`evicted ${String(r.evicted.length)} entry, backup ${path.basename(r.backupPath)}, restarts 5/5, no re-order`);
    });

    await step("tls07-wildcard-exact", async () => {
      mk("wild", makeCert({ sans: [`*.w.${DOMAIN}`] }));
      const chain = makeChain({ sans: [h("e.w")] });
      mk("e1", { ...chain.leaf, fullchainPem: chain.fullchainPem, keyPem: chain.keyPem, fp: chain.fp });
      v.e1.chain = chain;
      await putVersion(v.wild.id, v.wild.cert);
      await putVersion(v.e1.id, v.e1.cert);
      const t0 = Date.now();
      const r = await publish(
        [entry("shop1", h("shop")), entry("wild", h("b.w")), entry("e1", h("e.w"))],
        { expect: [{ hostname: h("b.w"), fingerprintSha256: v.wild.cert.fp }, { hostname: h("e.w"), fingerprintSha256: v.e1.cert.fp }] },
      );
      assert(r.outcome === "served", "wildcard + exact + shop set served", `${r.outcome} ${JSON.stringify(r.violations)}`);
      await setRoute("b.w", "manual");
      await setRoute("e.w", "manual");
      const reloadMs = Date.now() - t0;
      const a = await sample(h("a.w"), 5);
      const e = await sample(h("e.w"), 5);
      const b = await sample(h("b.w"), 5);
      const now = await acmeFp(h("a.w"));
      assert(a.size === 1 && a.has(now), "a.w keeps the current ACME certificate", JSON.stringify([...a]));
      assert(e.size === 1 && e.has(v.e1.cert.fp), "e.w served by its exact certificate", JSON.stringify([...e]));
      assert(b.size === 1 && b.has(v.wild.cert.fp), "b.w served by the wildcard", JSON.stringify([...b]));
      const deep = (await peerCert(h("x.b.w"))).fp;
      const apex = (await peerCert(h("w"))).fp;
      assert(deep !== v.wild.cert.fp, "x.b.w (two levels) is not covered by *.w", "wildcard served");
      assert(apex !== v.wild.cert.fp, "apex w is not covered by *.w", "wildcard served");
      const eChain = (await peerCert(h("e.w"))).chain;
      assert(eChain.length === 2 && eChain[1] === v.e1.chain.intermediate.fp, "e.w serves leaf + intermediate (root not sent)", eChain.map(short).join(">"));
      info(`publish+reload ${String(reloadMs)} ms; chain served ${String(eChain.length)} certs`);
    });

    await step("wildcard-sibling-renews", async () => {
      // Pebble certificates (20 days) are inside Traefik's 30-day renew window: every start renews them. A renewal that
      // races the router load can fail on the HTTP-01 fetch (403) and is only retried at the next start, so allow 3 starts.
      const before = (await peerCert(h("a.w"))).serial;
      let renewed = null;
      for (let attempt = 1; attempt <= 3 && renewed === null; attempt += 1) {
        await restartTraefik();
        renewed = await until("a.w renewed by Pebble while *.w is loaded", 50_000, async () => {
          const c = await peerCert(h("a.w"));
          return c.issuer.startsWith("Pebble") && c.serial !== before ? c : null;
        }, 1000).catch(() => null);
        if (renewed === null) info(`renewal attempt ${String(attempt)} did not land, restarting`);
      }
      assert(renewed !== null, "a.w renewed by Pebble while *.w is loaded", "no new serial after 3 starts");
      assert((await peerCert(h("b.w"))).fp === v.wild.cert.fp, "b.w still on the wildcard", "changed");
    });

    await step("capture-refused", async () => {
      const generation = (await store.readState()).generation;
      const manifestBefore = await readFile(manifestPath);
      // (a) a new ACME sibling under the loaded wildcard
      await setRoute("c.w", "acme");
      const set = [entry("shop1", h("shop")), entry("wild", h("b.w")), entry("e1", h("e.w"))];
      const a = await publish(set);
      assert(a.outcome === "captures_host" && a.violations.some((x) => x.hostname === h("c.w")), "new ACME c.w under *.w refused as captures_host", JSON.stringify(a.violations));
      await sleep(15_000);
      assert(!(await acmeHas(h("c.w"))), "c.w never ordered while the wildcard is loaded", "ordered");
      assert((await peerCert(h("c.w"))).fp === v.wild.cert.fp, "c.w is captured by the wildcard (what the plan prevents)", "not captured");
      await setRoute("c.w", null);
      // (b) a certificate whose CN is another host's name although the SAN is not (Traefik serves on the CN)
      mk("cn", makeCert({ cn: h("plain"), sans: [h("zzz")] }));
      await putVersion(v.cn.id, v.cn.cert);
      const b = await publish([...set, entry("cn", h("zzz"))]);
      assert(b.outcome === "captures_host" && b.violations.some((x) => x.hostname === h("plain")), "CN-capture of plain refused as captures_host", JSON.stringify(b.violations));
      const state = await store.readState();
      assert(state.generation === generation, "generation unchanged by the refusals", String(state.generation));
      assert(Buffer.compare(await readFile(manifestPath), manifestBefore) === 0, "manifest bytes unchanged by the refusals", "changed");
      const plain = await peerCert(h("plain"));
      assert(plain.issuer.startsWith("Pebble") && plain.fp !== v.cn.cert.fp, "plain still served by its ACME certificate, not the CN certificate", `${plain.issuer} ${short(plain.fp)}`);
    });

    await step("tls08-rotation-under-load", async () => {
      mk("shop2", makeCert({ sans: [h("shop")] }));
      await putVersion(v.shop2.id, v.shop2.cert);
      const pid = traefik.pid;
      const load = startLoad(h("shop"));
      await sleep(2000);
      const t0 = Date.now();
      const r = await publish(
        [entry("shop2", h("shop")), entry("wild", h("b.w")), entry("e1", h("e.w"))],
        { expect: [{ hostname: h("shop"), fingerprintSha256: v.shop2.cert.fp }] },
      );
      const switchMs = Date.now() - t0;
      await until("3000 handshakes under load", 120_000, () => load.total() >= 3000, 250);
      await sleep(2000);
      load.stop = true;
      await load.done;
      const foreign = [...load.seen.keys()].filter((f) => f !== v.shop1.cert.fp && f !== v.shop2.cert.fp);
      assert(r.outcome === "served", "rotation published and served", `${r.outcome} ${JSON.stringify(r.violations)}`);
      assert(load.total() >= 3000, "at least 3000 handshakes during the rotation", String(load.total()));
      assert(load.tlsErr === 0 && load.httpErr === 0, "0 TLS errors and 0 HTTP errors", `tls ${String(load.tlsErr)} http ${String(load.httpErr)}`);
      assert(foreign.length === 0, "only the old or new certificate served", foreign.map(short).join(","));
      assert(traefik.pid === pid && traefik.exitCode === null, "same proxy process", "restarted");
      info(`switch ${String(switchMs)} ms; handshakes v1=${String(load.seen.get(v.shop1.cert.fp) ?? 0)} v2=${String(load.seen.get(v.shop2.cert.fp) ?? 0)}; https 200=${String(load.http200)}`);
    });

    await step("bad-entry-not-fatal", async () => {
      const brokenId = versionId();
      const missingId = versionId();
      v.brokenId = brokenId;
      const dir = path.join(fm.manualCertsDirPath, brokenId);
      await mkdir(dir, { mode: 0o700 });
      await writeFile(path.join(dir, "fullchain.pem"), v.shop1.cert.certPem, { mode: 0o400 });
      await writeFile(path.join(dir, "privkey.pem"), v.wild.cert.keyPem, { mode: 0o400 }); // key of another certificate
      const good = (await store.readState()).current.entries.map((e) => e.versionId);
      await fm.writeManualCertificateManifest(store.renderManifest([...good, brokenId, missingId]));
      await sleep(5000);
      const ok = (await peerCert(h("shop"))).fp === v.shop2.cert.fp && (await peerCert(h("b.w"))).fp === v.wild.cert.fp && (await peerCert(h("e.w"))).fp === v.e1.cert.fp;
      assert(ok, "shop v2, b.w wildcard and e.w exact still served with a mismatched-key and a missing entry in the manifest", "lost");
      const recovered = await store.recoverAtStart();
      assert(recovered.recovered === true && recovered.missing.length === 0, "recoverAtStart rewrites the manifest from the state", JSON.stringify(recovered));
      const ids = await manifestIds();
      assert(ids.length === good.length && !ids.includes(brokenId) && !ids.includes(missingId), "manifest is back to the published set", ids.length.toString());
    });

    await step("tls10-restart-x5", async () => {
      let ok = 0;
      for (let i = 0; i < 5; i += 1) {
        await restartTraefik();
        const good =
          (await peerCert(h("shop"))).fp === v.shop2.cert.fp &&
          (await peerCert(h("b.w"))).fp === v.wild.cert.fp &&
          (await peerCert(h("e.w"))).fp === v.e1.cert.fp &&
          (await peerCert(h("a.w"))).issuer.startsWith("Pebble"); // renewed at every start, so no fixed fingerprint
        if (good) ok += 1;
      }
      assert(ok === 5, "5/5 restarts serve every host correctly on the first handshake", `${String(ok)}/5`);
    });

    await step("tls09-crash-recovery", async () => {
      mk("e2", makeCert({ sans: [h("e.w")] }));
      await putVersion(v.e2.id, v.e2.cert);
      const manifestBefore = await readFile(manifestPath);
      const base = (await store.readState()).generation;
      const set = [entry("shop2", h("shop")), entry("wild", h("b.w")), entry("e2", h("e.w"))];
      // The executor dies after the state write and before the manifest rename.
      const crashing = new ManualTlsStore(storeDeps(async () => { throw new Error("simulated crash before the manifest rename"); }));
      const crash = await crashing.publishFiles(base, set).then(() => null, (err) => err);
      assert(crash?.message.includes("simulated crash"), "publish interrupted before the manifest", String(crash));
      const interrupted = await store.readState();
      assert(interrupted.generation === base + 1 && interrupted.verified === false, "state already at generation+1, verified:false", JSON.stringify({ g: interrupted.generation, v: interrupted.verified }));
      assert(Buffer.compare(await readFile(manifestPath), manifestBefore) === 0, "manifest still the previous generation", "changed");
      await sleep(3000);
      assert((await peerCert(h("e.w"))).fp === v.e1.cert.fp, "the previous certificate keeps serving", "changed");
      // Executor start: a fresh store instance, as after a process restart.
      const restarted = new ManualTlsStore(storeDeps((content) => fm.writeManualCertificateManifest(content)));
      const recovered = await restarted.recoverAtStart();
      assert(recovered.recovered === true && recovered.generation === base + 1, "recoverAtStart reads the state", JSON.stringify(recovered));
      // An unverified generation is never rendered at start: the last verified set is, and the old certificate serves.
      assert(Buffer.compare(await readFile(manifestPath), manifestBefore) === 0, "recoverAtStart renders the last verified set", "changed");
      assert((await peerCert(h("e.w"))).fp === v.e1.cert.fp, "the last verified certificate still serves after recovery", "changed");
      // The panel retries the interrupted publish with the same base: a replay renders the interrupted set.
      const replay = await restarted.publishFiles(base, set);
      assert(replay.replayed === true && replay.generation === base + 1, "the retried publish is a replay of the interrupted generation", JSON.stringify(replay));
      await served(h("e.w"), v.e2.cert.fp);
      await restarted.markVerified(base + 1);
      const settled = await restarted.readState();
      assert(settled.verified === true && settled.lastVerified?.generation === base + 1, "generation verified after the probe", JSON.stringify(settled.lastVerified));
    });

    await step("tls06-back-to-acme", async () => {
      const gen = (await store.readState()).generation;
      await setRoute("shop", "acme"); // routes first: the manual certificate still covers the host, no order yet
      await sleep(3000);
      assert((await peerCert(h("shop"))).fp === v.shop2.cert.fp, "shop still manual after the route flip", "changed");
      const t0 = Date.now();
      const r = await publish(
        [entry("wild", h("b.w")), entry("e2", h("e.w"))],
        { expect: [{ hostname: h("shop"), notFingerprintSha256: v.shop2.cert.fp }] },
      );
      assert(r.outcome === "served" && r.generation === gen + 1, "publish without the shop version served", `${r.outcome} ${JSON.stringify(r.violations)}`);
      const back = await until("shop served by an ACME certificate again", 120_000, async () => {
        const c = await peerCert(h("shop"));
        return c.issuer.startsWith("Pebble") ? c : null;
      }, 500);
      await sleep(1000);
      assert(back.fp === (await acmeFp(h("shop"))), "served certificate is the one in acme.json", "differs");
      const tie = await sample(h("shop"), 6);
      assert(tie.size === 1, "no ambiguous tie after the switch", JSON.stringify([...tie]));
      info(`ACME certificate served ${String(Date.now() - t0)} ms after the unpublish (default certificate in the gap)`);
    });

    await step("tls06-refused-under-wildcard", async () => {
      const state = await store.readState();
      const manifestBefore = await readFile(manifestPath);
      await setRoute("d.w", "manual");
      await setRoute("b.w", "acme");
      const r = await publish([entry("wild", h("d.w")), entry("e2", h("e.w"))]);
      assert(r.outcome === "captures_host" && r.violations.some((x) => x.hostname === h("b.w")), "b.w back to ACME while *.w stays loaded is refused", `${r.outcome} ${JSON.stringify(r.violations)}`);
      assert((await store.readState()).generation === state.generation, "generation unchanged", "changed");
      assert(Buffer.compare(await readFile(manifestPath), manifestBefore) === 0, "manifest unchanged", "changed");
      await setRoute("b.w", "manual");
      await setRoute("d.w", null);
    });

    await step("gc-after-verify", async () => {
      const state = await store.readState();
      assert(state.verified === true, "state verified before GC", "not verified");
      const keep = new Set(state.current.entries.map((e) => e.versionId).concat((state.lastVerified?.entries ?? []).map((e) => e.versionId)));
      const gone = [v.shop1.id, v.hi.id, v.shop2.id, v.e1.id, v.cn.id, v.brokenId];
      const early = await store.gc(state.generation + 1).then(() => "accepted", (err) => err.reason);
      assert(early === "TLS_MANIFEST_CONFLICT", "GC with a stale generation refused", String(early));
      const r = await store.gc(state.generation);
      assert(gone.every((id) => r.removed.includes(id)), "old, unassigned and broken version dirs removed", r.removed.join(","));
      assert(keep.size === 2 && [...keep].every((id) => !r.removed.includes(id)), "published versions kept", [...keep].join(","));
      for (const id of gone) assert(!(await exists(path.join(fm.manualCertsDirPath, id))), `version dir ${id} gone`, "present");
      for (const id of keep) {
        const dir = await stat(path.join(fm.manualCertsDirPath, id));
        const key = await stat(path.join(fm.manualCertsDirPath, id, "privkey.pem"));
        assert((dir.mode & 0o777) === 0o700 && (key.mode & 0o777) === 0o400 && key.uid === process.getuid(), "kept dir 0700, key 0400, owner executor", `${(dir.mode & 0o777).toString(8)} ${(key.mode & 0o777).toString(8)}`);
      }
      const names = await readdir(fm.manualCertsDirPath);
      assert(names.every((n) => !n.startsWith(".stage-")), "no stage directory left", names.join(","));
      assert((await peerCert(h("e.w"))).fp === v.e2.cert.fp && (await peerCert(h("b.w"))).fp === v.wild.cert.fp, "served certificates unchanged by the GC", "changed");
    });

    // ---- container part: the real traefik:v3.7 image with the shipped payload (never hp_ingress_proxy) ----
    const dockerWhy = await (async () => {
      if (process.env.HP_TLS_SKIP_DOCKER === "1") return "HP_TLS_SKIP_DOCKER=1";
      try {
        await run("docker", ["image", "inspect", TRAEFIK_IMAGE, "--format", "{{.Id}}"]);
        return null;
      } catch (err) {
        return `docker or local ${TRAEFIK_IMAGE} unavailable (${String(err.message).slice(0, 80)})`;
      }
    })();
    const container = {};
    if (dockerWhy) {
      skip("container-serves-manual-0700", dockerWhy);
      skip("inspect-no-secrets", dockerWhy);
    } else {
      await step("container-serves-manual-0700", async () => {
        const root = path.join(tmpDir, "ingress-docker");
        const fm2 = new TraefikIngressFileManager(root, null); // default mount: /etc/traefik/dynamic/manual-certs
        const ensured = await fm2.ensureStaticConfig(null);
        const store2 = new ManualTlsStore({
          dir: fm2.manualCertsDirPath,
          statePath: fm2.manualTlsStatePath,
          mountDir: "/etc/traefik/dynamic",
          writeManifest: (content) => fm2.writeManualCertificateManifest(content),
          gcGraceMs: 0,
        });
        const host = h("ctr");
        const certA = makeCert({ sans: [host] });
        const certB = makeCert({ sans: [host] });
        const idA = versionId();
        const idB = versionId();
        for (const [id, c] of [[idA, certA], [idB, certB]]) {
          await store2.putVersion({ versionId: id, fullchainPem: c.certPem, keyPem: c.keyPem, fingerprintSha256: c.fp });
        }
        await fm2.upsertServiceRoute("site_ctr", {
          serviceInstanceId: "svc_ctr", containerName: "hp-nobackend", internalPort: 8080,
          hosts: [{ hostname: host, tls: true, httpsRedirect: false, redirectTo: null, source: "manual" }],
        });
        await store2.publishFiles(0, [{ versionId: idA, assignedHosts: [host] }]);
        const manifestText = await readFile(path.join(fm2.dynamicDirPath, "hp-manual-certificates.yml"), "utf8");
        // The shipped container payload (uid:gid, CapDrop ALL, ro dynamic bind); only the name, the network and the ports are ours.
        const p = buildIngressProxyContainerPayload({
          traefikImage: TRAEFIK_IMAGE,
          staticConfigHostPath: fm2.staticConfigPath,
          dynamicDirHostPath: fm2.dynamicDirPath,
          acmeDirHostPath: fm2.acmeDirPath,
          staticSha256: ensured.staticSha256,
          user: `${String(process.getuid())}:${String(process.getgid())}`,
        });
        const args = [
          "run", "-d", "--name", containerName, "--user", p.User, "--label", "hp_swarmtest=1",
          ...p.HostConfig.CapDrop.flatMap((c) => ["--cap-drop", c]), ...p.HostConfig.CapAdd.flatMap((c) => ["--cap-add", c]),
          ...p.HostConfig.SecurityOpt.flatMap((o) => ["--security-opt", o]), "--pids-limit", String(p.HostConfig.PidsLimit),
          ...p.HostConfig.Binds.flatMap((b) => ["-v", b]),
          "-p", `${HOST}:${String(PORT.containerWeb)}:80`, "-p", `${HOST}:${String(PORT.containerSecure)}:443`,
          p.Image, ...p.Cmd,
        ];
        containerCreated = true;
        await run("docker", args);
        const probe = (fp) => waitForServed([{ hostname: host, fingerprintSha256: fp }], { host: HOST, port: PORT.containerSecure, deadlineMs: 40_000 });
        const first = await probe(certA.fp);
        assert(first.served, "container cold start serves the 0700/0400 manual certificate", JSON.stringify(first.observed));
        const startedAt = (await run("docker", ["inspect", "-f", "{{.State.StartedAt}}", containerName])).trim();
        const version = (await run("docker", ["exec", containerName, "traefik", "version"])).split("\n").find((l) => /Version:/.test(l)) ?? "";
        const published = await store2.publishFiles(1, [{ versionId: idB, assignedHosts: [host] }]);
        assert(published.generation === 2, "second generation published", String(published.generation));
        const rotated = await probe(certB.fp);
        assert(rotated.served, "container serves the rotated certificate without a restart", JSON.stringify(rotated.observed));
        const after = (await run("docker", ["inspect", "-f", "{{.State.StartedAt}} {{.State.Running}}", containerName])).trim();
        assert(after === `${startedAt} true`, "container StartedAt unchanged by the rotation", `${startedAt} -> ${after}`);
        const modes = [];
        for (const f of [fm2.manualCertsDirPath, path.join(fm2.manualCertsDirPath, idB), path.join(fm2.manualCertsDirPath, idB, "privkey.pem")]) {
          modes.push((await stat(f)).mode & 0o777);
        }
        assert(modes[0] === 0o700 && modes[1] === 0o700 && modes[2] === 0o400, "store modes 0700 / 0700 / 0400", modes.map((m) => m.toString(8)).join("/"));
        Object.assign(container, { certKeyPem: certA.keyPem, certBKeyPem: certB.keyPem, manifestText, p });
        info(`${version.trim()} in ${TRAEFIK_IMAGE}; rotation in container without restart`);
      });

      await step("inspect-no-secrets", async () => {
        assert(container.p, "the container step ran", "missing");
        const inspect = await run("docker", ["inspect", containerName]);
        const logs = await run("docker", ["logs", containerName]).catch(() => "");
        const bodyOf = (pem) => pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
        for (const [label, text] of [["docker inspect", inspect], ["container logs", logs], ["manifest", container.manifestText]]) {
          assert(!/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(text), `no PEM marker in ${label}`, "found");
          for (const pem of [container.certKeyPem, container.certBKeyPem]) {
            assert(!text.includes(bodyOf(pem).slice(0, 40)), `no key bytes in ${label}`, "found");
          }
        }
        const info0 = JSON.parse(inspect)[0];
        const binds = info0.HostConfig.Binds ?? [];
        assert(!binds.some((b) => b.includes("docker.sock")), "no docker.sock bind", binds.join(","));
        assert(binds.some((b) => b.endsWith("/etc/traefik/dynamic:ro")), "dynamic directory bound read-only", binds.join(","));
        assert(info0.HostConfig.Privileged === false && JSON.stringify(info0.HostConfig.CapDrop) === '["ALL"]', "not privileged, CapDrop ALL", JSON.stringify(info0.HostConfig.CapDrop));
        assert(info0.Config.User === `${String(process.getuid())}:${String(process.getgid())}`, "runs as the executor uid:gid", info0.Config.User);
        const envNames = (info0.Config.Env ?? []).map((e) => e.split("=")[0]).filter((n) => !["PATH"].includes(n));
        assert(envNames.length === 0, "no environment beyond the image's PATH", envNames.join(","));
        assert(/certFile: "\/etc\/traefik\/dynamic\/manual-certs\/ctv_[0-9a-f]{32}\/fullchain\.pem"/.test(container.manifestText) && !container.manifestText.includes("BEGIN"), "manifest holds file references only", "other content");
      });
    }
  } finally {
    const kids = [...children];
    await cleanup();
    total += 1;
    const alive = kids.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => c.hpName);
    const tmpLeft = tmpDir && !keepTmp ? await exists(tmpDir) : false;
    const containerLeft = containerCreated
      ? (await run("docker", ["ps", "-aq", "--filter", `name=${runPrefix}`]).catch(() => "x")).trim() !== ""
      : false;
    if (alive.length === 0 && !tmpLeft && !containerLeft && servers.every((s) => !s.listening)) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: alive=${alive.join(",") || "none"} tmp=${String(tmpLeft)} container=${String(containerLeft)}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed${skipped > 0 ? `, ${String(skipped)} skipped (not counted in n/m)` : ""}`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
