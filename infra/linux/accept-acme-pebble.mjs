#!/usr/bin/env node
/**
 * Real-process check for DNS-01 next to HTTP-01 (ADR 0030), without root and without Docker.
 *
 * The executor's own code (apps/docker-executor/dist) writes the Traefik static and dynamic files
 * for one site with two hosts: http01.hp-pebble.test (resolver le, HTTP-01) and
 * dns01.hp-pebble.test (resolver le-dns, lego provider httpreq). A real Traefik v3.7.19 then gets
 * both certificates from a real Pebble v2.10.3; a small shim turns lego's httpreq calls into TXT
 * records on pebble-challtestsrv. Only the ports, the directories, the DNS resolvers, the
 * propagation knob and the log level are string-patched into the generated static file.
 *
 * Machine safety: every process and listener binds 127.0.0.1 only (ports 8053, 8055, 14000,
 * 15000, 15001, 15002, 15443, 15053, 15100). Binaries are downloaded once into HP_PEBBLE_CACHE
 * (default ~/.cache/hp-acme-pebble, outside the repository); every downloaded file has a sha256
 * pinned below from the release metadata and a mismatch stops the run before anything is unpacked
 * or used. Everything else lives in one mkdtemp directory
 * os.tmpdir()/hp_swarmtest_acme_<hex>_*, removed with every child process in `finally` and on
 * SIGINT/SIGTERM. No shell is ever used.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { openSync, closeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (p) => pathToFileURL(path.resolve(repoRoot, p)).href;
const { TraefikIngressFileManager, ACME_DNS_SECRET_MOUNT, dnsProviderFileEnv, acmeStorageFileName } = await import(
  dist("apps/docker-executor/dist/index.js")
);
const { readAcmeCertificates } = await import(dist("apps/docker-executor/dist/acme-status.js"));
const { DNS_PROVIDER_FIELDS } = await import(dist("packages/contracts/dist/index.js"));

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
const PORT = { dns: 8053, chall: 8055, acme: 14000, pebbleMgmt: 15000, web: 15002, websecure: 15443, shim: 15053, backend: 15100 };
const HTTP01 = "http01.hp-pebble.test";
const DNS01 = "dns01.hp-pebble.test";
const DNS01_FQDN = `_acme-challenge.${DNS01}.`;
const BACKEND_BODY = "hp-pebble-ok";
const POLL_MS = 180_000;

const cacheDir = path.resolve(process.env.HP_PEBBLE_CACHE || path.join(os.homedir(), ".cache", "hp-acme-pebble"));
const runPrefix = `hp_swarmtest_acme_${randomBytes(4).toString("hex")}`;
const children = new Set();
const servers = [];
let tmpDir = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const exists = (p) => stat(p).then(() => true, () => false);

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
  // Pebble's tarballs ship the binaries without the execute bit.
  await chmod(path.join(dir, entry), 0o755);
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

function request(url, { method = "GET", body, ca, servername, headers = {}, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method, ca, servername, headers: { "User-Agent": "hp-accept-acme-pebble", ...headers }, rejectUnauthorized, timeout: 10_000, agent: false },
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

async function until(what, ms, fn) {
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
    await sleep(1_000);
  }
}

function listen(server, port) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
}

async function peerCert(servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: HOST, port: PORT.websecure, servername, rejectUnauthorized: false }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve(cert);
    });
    s.setTimeout(10_000, () => s.destroy(new Error("tls timeout")));
    s.on("error", reject);
  });
}

async function handshakeIsPebble(servername) {
  const cert = await until(`Pebble certificate served for ${servername}`, 20_000, async () => {
    const c = await peerCert(servername);
    return String(c.issuer?.CN ?? "").startsWith("Pebble Intermediate CA") ? c : null;
  });
  assert(String(cert.subjectaltname).includes(`DNS:${servername}`), `SAN DNS:${servername}`, cert.subjectaltname);
}

/** Inserts the test DNS knobs into the le-dns dnsChallenge block (production writes none). */
function patchDnsChallenge(text, propagationKey) {
  const lines = text.split("\n");
  const start = lines.indexOf("  le-dns:");
  assert(start >= 0, "le-dns resolver in static config", "missing");
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  if (end < 0) end = lines.length;
  const provider = lines.findIndex((l, i) => i > start && i < end && /^\s+provider: /.test(l));
  assert(provider >= 0, "provider line in le-dns", "missing");
  const indent = lines[provider].match(/^\s*/)[0];
  // Production writes no resolvers; a flow-style list, if any, is replaced by the test one.
  const block = lines.slice(start, end).filter((l) => !l.startsWith(`${indent}resolvers:`));
  const at = block.findIndex((l) => /^\s+provider: /.test(l)) + 1;
  block.splice(at, 0, `${indent}resolvers: ["${HOST}:${String(PORT.dns)}"]`, `${indent}propagation:`, `${indent}  ${propagationKey}: true`);
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

function patchStatic(text, fm, propagationKey) {
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
  return patchDnsChallenge(out, propagationKey);
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const child of children) await stopChild(child);
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
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
  const setupSteps = new Set(["binaries-ready", "pebble-and-challtestsrv-up", "static-config-two-resolvers", "traefik-listening"]);
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

  tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
  const bin = {};
  const certs = {
    minica: path.join(cacheDir, "certs", "pebble.minica.pem"),
    cert: path.join(cacheDir, "certs", "localhost", "cert.pem"),
    key: path.join(cacheDir, "certs", "localhost", "key.pem"),
  };
  const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() };
  const shimUser = "hp";
  const shimPassword = randomBytes(24).toString("hex");
  const shimCalls = [];
  const panel = {
    hostname: "panel.hp-pebble.test",
    ipv4: HOST,
    acmeEmail: "acme@hp-pebble.test",
    acmeStaging: false,
    acmeCaServer: `https://${HOST}:${String(PORT.acme)}/dir`,
    acmeCaCertFile: certs.minica,
    upstreamPort: PORT.backend,
  };
  const fm = new TraefikIngressFileManager(path.join(tmpDir, "ingress"), panel);
  const storePath = path.join(fm.acmeDirPath, acmeStorageFileName(panel));
  let traefik = null;
  let generatedStatic = "";
  let traefikEnv = null;

  const startTraefik = async (propagationKey) => {
    const cfg = path.join(tmpDir, "traefik.yml");
    await writeFile(cfg, patchStatic(generatedStatic, fm, propagationKey), { mode: 0o600 });
    traefik = startChild("traefik", bin.traefik, [`--configFile=${cfg}`], traefikEnv, traefikLog);
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
  const storedFor = (resolver, hostname, ms) =>
    until(`${hostname} stored under resolver ${resolver}`, ms, async () => {
      const read = await readAcmeCertificates(storePath, [resolver]);
      return read.certificates.find((c) => c.hostname === hostname && Date.parse(c.notAfter) > Date.now()) ?? null;
    });

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
          await cached(
            `${PEBBLE_RELEASE}/pebble-challtestsrv-linux-amd64.tar.gz`,
            "pebble-challtestsrv-linux-amd64.tar.gz",
            PEBBLE_SHA256.challtestsrv,
          ),
          "pebble-challtestsrv",
        ));
      const version = await run(bin.traefik, ["version"]);
      assert(version.includes("3.7.19"), "traefik version 3.7.19", version.split("\n")[0]);
    });

    await step("pebble-and-challtestsrv-up", async () => {
      startChild("challtestsrv", bin.chall, [
        "-dnsserver", `${HOST}:${String(PORT.dns)}`, "-management", `${HOST}:${String(PORT.chall)}`,
        "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "", "-defaultIPv4", "", "-defaultIPv6", "",
      ], baseEnv, path.join(tmpDir, "challtestsrv.log"));
      await until("challtestsrv add-a", 20_000, async () =>
        (await request(`http://${HOST}:${String(PORT.chall)}/add-a`, {
          method: "POST",
          body: { host: `${HTTP01}.`, addresses: [HOST] },
        })).status === 200,
      );
      const pebbleCfg = path.join(tmpDir, "pebble.json");
      await writeFile(pebbleCfg, JSON.stringify({
        pebble: {
          listenAddress: `${HOST}:${String(PORT.acme)}`, managementListenAddress: `${HOST}:${String(PORT.pebbleMgmt)}`,
          certificate: certs.cert, privateKey: certs.key, httpPort: PORT.web, tlsPort: 15001, ocspResponderURL: "",
          externalAccountBindingRequired: false, domainBlocklist: ["blocked-domain.example"],
          retryAfter: { authz: 1, order: 1 }, keyAlgorithm: "ecdsa",
          profiles: { default: { description: "default profile", validityPeriod: 7776000 } },
        },
      }));
      startChild("pebble", bin.pebble, ["-config", pebbleCfg, "-dnsserver", `${HOST}:${String(PORT.dns)}`],
        { ...baseEnv, PEBBLE_VA_NOSLEEP: "1", PEBBLE_WFE_NONCEREJECT: "0" }, path.join(tmpDir, "pebble.log"));
      const ca = await readFile(certs.minica);
      await until("pebble /dir", 20_000, async () =>
        (await request(`https://${HOST}:${String(PORT.acme)}/dir`, { ca })).status === 200,
      );

      // The httpreq shim (lego default mode) and the site backend, both on loopback.
      const expectedAuth = `Basic ${Buffer.from(`${shimUser}:${shimPassword}`).toString("base64")}`;
      await listen(http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* recorded as is */ }
          const authOk = req.headers.authorization === expectedAuth;
          shimCalls.push({ method: req.method, path: req.url, fqdn: body.fqdn, authOk });
          if (!authOk) return void res.writeHead(401).end();
          const action = req.method === "POST" && { "/present": "set-txt", "/cleanup": "clear-txt" }[req.url];
          if (!action || typeof body.fqdn !== "string") return void res.writeHead(404).end();
          const r = await request(`http://${HOST}:${String(PORT.chall)}/${action}`, {
            method: "POST",
            body: action === "set-txt" ? { host: body.fqdn, value: body.value } : { host: body.fqdn },
          }).catch(() => ({ status: 502 }));
          res.writeHead(r.status === 200 ? 200 : 502).end();
        });
      }), PORT.shim);
      await listen(http.createServer((_req, res) => res.writeHead(200).end(BACKEND_BODY)), PORT.backend);
    });

    await step("static-config-two-resolvers", async () => {
      const names = DNS_PROVIDER_FIELDS.httpreq.map((f) => f.name).sort();
      await fm.setDnsProviderState({ provider: "httpreq", fields: names });
      const requested = await fm.gatePanelCertificate(panel, async () => ({ a: [], aaaa: [] }));
      assert(requested === false, "panel orders nothing", String(requested));
      const ensured = await fm.ensureStaticConfig(panel);
      assert(ensured.acmeDns?.provider === "httpreq", "ensureStaticConfig returns the httpreq state", JSON.stringify(ensured.acmeDns));
      await fm.upsertServiceRoute("site_pebble", {
        serviceInstanceId: "svc_pebble",
        containerName: HOST,
        internalPort: PORT.backend,
        hosts: [
          { hostname: HTTP01, tls: true, httpsRedirect: false, redirectTo: null },
          { hostname: DNS01, tls: true, httpsRedirect: false, redirectTo: null, challenge: "dns-01" },
        ],
      });
      const site = await readFile(fm.getSiteDynamicFilePath("site_pebble"), "utf8");
      assert(/certResolver: le\n/.test(site) && /certResolver: le-dns\n/.test(site), "site routers use le and le-dns", site);

      generatedStatic = await readFile(fm.staticConfigPath, "utf8");
      const block = (name) => {
        const lines = generatedStatic.split("\n");
        const start = lines.indexOf(`  ${name}:`);
        assert(start >= 0, `resolver ${name}`, "missing");
        const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
        return lines.slice(start, end < 0 ? undefined : end);
      };
      const storage = (b) => b.find((l) => l.trim().startsWith("storage: "));
      const le = block("le");
      const leDns = block("le-dns");
      assert(storage(le) && storage(le) === storage(leDns), "le and le-dns share one storage line", `${storage(le)} | ${storage(leDns)}`);
      assert(le.some((l) => l.trim() === "entryPoint: web"), "le uses httpChallenge on web", le.join("|"));
      assert(leDns.some((l) => l.trim() === "provider: httpreq"), "le-dns uses provider httpreq", leDns.join("|"));

      // Credentials: one 0400 file per field in a 0700 dir; Traefik sees only <NAME>_FILE paths.
      const secretDir = path.join(tmpDir, "dns-secrets");
      await mkdir(secretDir, { mode: 0o700 });
      await chmod(secretDir, 0o700);
      const values = {
        HTTPREQ_ENDPOINT: `http://${HOST}:${String(PORT.shim)}`,
        HTTPREQ_USERNAME: shimUser,
        HTTPREQ_PASSWORD: shimPassword,
      };
      traefikEnv = { ...baseEnv };
      for (const entry of dnsProviderFileEnv(ensured.acmeDns)) {
        const [key, mounted] = entry.split("=");
        const name = key.replace(/_FILE$/, "");
        assert(mounted === `${ACME_DNS_SECRET_MOUNT}/${name}` && name in values, "file env under the mount", entry);
        const file = path.join(secretDir, name);
        await writeFile(file, values[name], { mode: 0o400 });
        await chmod(file, 0o400);
        traefikEnv[key] = file;
      }
      assert(Object.keys(traefikEnv).length === 2 + names.length, "one _FILE per httpreq field", Object.keys(traefikEnv).join(","));
    });

    traefikLog = path.join(tmpDir, "traefik.log");
    await step("traefik-listening", () => startTraefik("disableANSChecks"));

    await step("http-01-stored", () => storedFor("le", HTTP01, POLL_MS));
    await step("http-01-handshake", () => handshakeIsPebble(HTTP01));

    await step("dns-01-stored", async () => {
      try {
        await storedFor("le-dns", DNS01, POLL_MS);
        console.log("INFO dns-01 issued with propagation.disableANSChecks");
      } catch (err) {
        const log = await readFile(traefikLog, "utf8").catch(() => "");
        if (!/propagation/i.test(log)) throw err;
        console.log("INFO dns-01 failed on propagation with disableANSChecks; retrying with disableChecks");
        await stopChild(traefik);
        await startTraefik("disableChecks");
        await storedFor("le-dns", DNS01, POLL_MS);
        console.log("INFO dns-01 issued with propagation.disableChecks");
      }
    });
    await step("dns-01-handshake", () => handshakeIsPebble(DNS01));

    await step("shim-present-cleanup", async () => {
      const seen = (p) => shimCalls.some((c) => c.path === p && c.fqdn === DNS01_FQDN && c.authOk);
      await until("shim saw /present and /cleanup", 20_000, () => seen("/present") && seen("/cleanup"));
      const bad = shimCalls.filter((c) => !c.authOk);
      assert(bad.length === 0, "every shim call authenticated", JSON.stringify(bad));
      const resolver = new Resolver();
      resolver.setServers([`${HOST}:${String(PORT.dns)}`]);
      const a = await resolver.resolve4(DNS01).catch((err) => err.code);
      assert(typeof a === "string", `${DNS01} has no A record`, JSON.stringify(a));
    });

    await step("secrets-only-as-files", async () => {
      const env = (await readFile(`/proc/${String(traefik.pid)}/environ`, "utf8")).split("\0");
      assert(env.some((e) => e.startsWith("HTTPREQ_PASSWORD_FILE=")), "HTTPREQ_PASSWORD_FILE set", env.map((e) => e.split("=")[0]).join(","));
      assert(!env.some((e) => e.startsWith("HTTPREQ_PASSWORD=")), "no HTTPREQ_PASSWORD=", "present");
      assert(!env.some((e) => e.includes(shimPassword)), "password value not in environ", "present");
    });

    await step("https-to-backend", async () => {
      const root = (await request(`https://${HOST}:${String(PORT.pebbleMgmt)}/roots/0`, { ca: await readFile(certs.minica) })).text;
      const res = await request(`https://${HOST}:${String(PORT.websecure)}/`, { ca: root, servername: HTTP01, headers: { Host: HTTP01 } });
      assert(res.status === 200 && res.text === BACKEND_BODY, `200 ${BACKEND_BODY} (verified against the Pebble root)`, `${String(res.status)} ${res.text.slice(0, 80)}`);
    });
  } finally {
    const kids = [...children];
    await cleanup();
    total += 1;
    const alive = kids.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => c.hpName);
    const tmpLeft = tmpDir ? await exists(tmpDir) : false;
    if (alive.length === 0 && !tmpLeft && servers.every((s) => !s.listening)) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: alive=${alive.join(",") || "none"} tmp=${String(tmpLeft)}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
