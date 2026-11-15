#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M4a (WordPress tools, ADR 0023, W16 a-h).
 *
 * Drives the built DockerEngineSocketAdapter.runSiteJob with the product's own job specifications
 * (wordpress.install, .inspect, .update, .settle, .reset-password) on a throw-away site made the
 * product's way (deployService + wordpress.install) at http://wp-a.example.test.
 *
 * Machine safety: every object created carries "hp_swarmtest_m4wp_<hex>" in its name (the product
 * prefixes its own names with job_, hp_site_, hp_edge_ and hp_vol_) and is removed by exact name in
 * `finally` and on SIGINT/SIGTERM, containers with their anonymous volumes. No host port is published,
 * nothing is pulled, nothing is pruned. Secrets reach containers only as files of the temporary folder.
 * Needs wordpress.org: when it does not answer, the script says so and exits 1.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (p) => import(pathToFileURL(path.resolve(repoRoot, p)).href);
const {
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  WORDPRESS_INSPECT_SCRIPT,
  WORDPRESS_INSTALL_SCRIPT,
  WORDPRESS_RESET_PASSWORD_SCRIPT,
  WORDPRESS_SETTLE_SCRIPT,
  WORDPRESS_UPDATE_SCRIPT,
  buildSiteJobContainerPayload,
  getManagedVolumeName,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  purgeServiceSecrets,
  siteJobTimeoutMs,
  writeServiceSecrets,
} = await load("apps/docker-executor/dist/index.js");
const {
  WordpressStateResultSchema,
  WordpressUpdateResultSchema,
  resolveWordpressCliImage,
  resolveWordpressImage,
} = await load("packages/contracts/dist/index.js");
const { createApprovedServiceSpec } = await load("packages/executor-contracts/dist/index.js");

const PHP = "8.4";
const CLI_IMAGE = resolveWordpressCliImage(PHP);
const SITE_IMAGE = resolveWordpressImage(PHP);
const DB_IMAGE = "mariadb:12.3.3";
const IMAGE_CORE = /^wordpress:(\d+\.\d+(?:\.\d+)?)-/.exec(SITE_IMAGE)?.[1];
const SITE_HOST = "wp-a.example.test";
const READ_CEILING = Math.round(1.1 * 1024 * 1024); // exec-wp (f): the log read stays under 1.1 MiB
const SCRIPTS = {
  "wordpress.inspect": WORDPRESS_INSPECT_SCRIPT,
  "wordpress.update": WORDPRESS_UPDATE_SCRIPT,
  "wordpress.settle": WORDPRESS_SETTLE_SCRIPT,
  "wordpress.reset-password": WORDPRESS_RESET_PASSWORD_SCRIPT,
};

const hex = randomBytes(3).toString("hex");
const base = `hp_swarmtest_m4wp_${hex}`;
const siteId = base;
const serviceInstanceId = `${base}_svc`;
const siteContainer = `${base}_site`;
const dbContainer = `${base}_db`;
const probeNet = `${base}_probe`;
const siteNet = getSiteInternalNetworkName(siteId);
const edgeNet = getSiteEdgeNetworkName(siteId);
const htmlVolume = getManagedVolumeName(serviceInstanceId, "html");
const dbName = `wpa_${hex}`;

// Throw-away secrets of this run only; none of them is ever on a command line.
const rnd = (n) => randomBytes(n).toString("base64url").slice(0, n);
const DB_PASSWORD = randomBytes(32).toString("hex");
const WRONG_DB_PASSWORD = randomBytes(32).toString("hex");
const ADMIN_19 = rnd(19);
const ADMIN_64 = rnd(64);
const ADMIN_128 = randomBytes(96).toString("base64"); // 128 characters with + / =
const ADMIN_QUOTED = `q'u"o\\t-${rnd(20)}`;
const RESET_PW = rnd(40);
const SECRETS = { DB_PASSWORD, WRONG_DB_PASSWORD, ADMIN_19, ADMIN_64, ADMIN_128, ADMIN_QUOTED, RESET_PW };

const tracked = { containers: new Set(), networks: new Set(), volumes: new Set() };
const jobs = new Map(); // jobId -> record
const times = {};
const results = [];
let tmp = null;
let cleanedUp = false;
let edgeGone = false;
let siteIp = "";
let jobSeq = 0;
let volumesBefore = null;
const versions = {};
let helperSeq = 0;

class StepAssertionError extends Error {
  constructor(expected, actual) {
    super(`${expected} / ${actual}`);
  }
}

function assert(cond, expected, actual) {
  if (!cond) {
    throw new StepAssertionError(expected, String(actual).slice(0, 400));
  }
}

function formatErr(err) {
  return err instanceof ExecutorCodedError ? `${err.code}: ${err.message}` : String(err?.message ?? err);
}

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const notes = (await fn()) ?? [];
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    for (const n of notes) console.log(`  ${n}`);
    return true;
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${formatErr(err)}`);
    return false;
  }
}

function docker(args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counts the 8-character windows of `secret` found in `text`. */
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
  return n;
}
const leaks = (text) =>
  Object.entries(SECRETS)
    .filter(([, s]) => leakedWindows(text, s) > 0)
    .map(([k]) => k);

/** Splits a multiplexed Docker log body into its two streams. */
function demux(buf) {
  const out = { stdout: [], stderr: [] };
  for (let o = 0; o + 8 <= buf.length; ) {
    const end = Math.min(buf.length, o + 8 + buf.readUInt32BE(o + 4));
    out[buf[o] === 2 ? "stderr" : "stdout"].push(buf.subarray(o + 8, end));
    o = end;
  }
  return { stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8") };
}

/** Watches the adapter's own Docker calls: inspect at start, bytes it read, raw log before its delete. */
function instrument(adapter) {
  const client = adapter.dockerClient;
  const orig = client.request.bind(client);
  const byId = new Map();
  client.request = async (method, p, body, opts) => {
    const del = method === "DELETE" ? /^\/containers\/([0-9a-f]{64})\?/.exec(p) : null;
    if (del && byId.has(del[1])) {
      const raw = await orig("GET", `/containers/${del[1]}/logs?stdout=1&stderr=1`);
      byId.get(del[1]).raw = { status: raw.statusCode, bytes: raw.body.length, ...demux(raw.body) };
    }
    const res = await orig(method, p, body, opts);
    const created = method === "POST" ? /^\/containers\/create\?name=(job_[^&]+)$/.exec(p) : null;
    if (created && res.statusCode === 201) {
      byId.set(JSON.parse(res.body.toString("utf8")).Id, jobs.get(decodeURIComponent(created[1])));
    }
    const m = /^\/containers\/([0-9a-f]{64})\/(start|logs)/.exec(p);
    const rec = m ? byId.get(m[1]) : undefined;
    if (rec && m[2] === "start" && res.statusCode === 204) {
      const ins = await docker(["container", "inspect", m[1]]);
      rec.inspect = ins.ok ? JSON.parse(ins.stdout)[0] : null;
    }
    if (rec && m[2] === "logs") {
      rec.adapterLogBytes += res.body.length;
      (rec.logStatuses ??= []).push(res.statusCode);
    }
    return res;
  };
  return adapter;
}

function newAdapter(extra = {}) {
  return instrument(
    new DockerEngineSocketAdapter({
      dockerSocketPath: "/var/run/docker.sock",
      secretsRootDir: path.join(tmp, "secrets"),
      siteMailDir: path.join(tmp, "mail"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      sharedDbContainerName: `${base}_shared_db_unused`,
      sharedDbNetworkName: `${base}_shared_net_unused`,
      sharedDbDataDir: path.join(tmp, "shared-db"),
      sharedDbRootKeyFile: path.join(tmp, "root.key"),
      ...extra,
    }),
  );
}

/** One job through the product's runSiteJob; every record is kept for the scans at the end. */
async function job(adapter, kind, params = {}, resolvedSecrets) {
  const jobId = `job_${base}_${String(++jobSeq)}`;
  const rec = { jobId, kind, params, online: !edgeGone, adapterLogBytes: 0 };
  jobs.set(jobId, rec);
  tracked.containers.add(jobId);
  const t0 = performance.now();
  try {
    rec.res = await adapter.runSiteJob({
      jobId, kind, siteId, organizationId: "org_swarmtest", serviceInstanceId,
      params: { phpVersion: PHP, ...params }, ...(resolvedSecrets ? { resolvedSecrets } : {}),
    });
    return rec.res;
  } finally {
    rec.ms = performance.now() - t0;
    (times[kind] ??= []).push(rec.ms);
  }
}

/** A short container of this script on the site's html volume: set-up, planting files, looking. */
async function helper({ network = "none", user = "33:33", script, env = {} }) {
  const name = `${base}_h${String(++helperSeq)}`;
  tracked.containers.add(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await docker(["run", "--rm", "--name", name, "--network", network, "--user", user,
    "-v", `${htmlVolume}:/var/www/html`, "-w", "/var/www/html", ...envArgs, "--entrypoint", "sh", CLI_IMAGE, "-c", script]);
  assert(r.ok, `helper ${name} exits 0`, r.stderr.trim());
  return r.stdout.trim();
}

function httpRequest(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: siteIp, port: 80, path: urlPath, method, headers: { Host: SITE_HOST, ...headers }, timeout: 30_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.length < 64 && chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, cookies: res.headers["set-cookie"] ?? [], body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(password) {
  const body = new URLSearchParams({ log: "admin", pwd: password, "wp-submit": "Log In", testcookie: "1" }).toString();
  const res = await httpRequest("POST", "/wp-login.php", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": String(Buffer.byteLength(body)),
    Cookie: "wordpress_test_cookie=WP%20Cookie%20check",
  });
  return { status: res.status, loggedIn: res.cookies.some((c) => c.startsWith("wordpress_logged_in_")) };
}

async function assertLogin(password, what) {
  const l = await login(password);
  assert(l.status === 302 && l.loggedIn, `${what}: login 302 with wordpress_logged_in_ cookie`, JSON.stringify(l));
}

const maintenancePresent = async () =>
  (await helper({ script: "[ -e .maintenance ] && echo yes || echo no" })) === "yes";
const filesSnapshot = () =>
  helper({ user: "0:0", script: "find /var/www/html -printf '%p %s %T@ %u\\n' | sort | sha256sum" });

const pluginVersionPhp = (v) => `$f = "wp-content/plugins/classic-editor/classic-editor.php";
$c = preg_replace("/^(\\s*\\*\\s*Version:\\s*).*$/m", '\${1}${v}', file_get_contents($f), 1); file_put_contents($f, $c) || exit(1);`;

/** What step 5 checks on one `docker inspect` of a running WordPress job; [] when the shape is right. */
function shapeProblems(rec, ins) {
  const p = [];
  const cmd = ins?.Config?.Entrypoint ?? [];
  const want = ["timeout", "-s", "KILL", String(siteJobTimeoutMs(rec.kind) / 1000 + 5), "sh", "-c", SCRIPTS[rec.kind]];
  // R139: our whole command is the entry point (the image's docker-entrypoint.sh never runs), no Cmd, an init as process 1.
  if (JSON.stringify(cmd) !== JSON.stringify(want)) p.push("Entrypoint is not timeout -s KILL <limit+5> sh -c <constant>");
  if (ins?.Config?.Cmd != null) p.push(`a Cmd is set: ${JSON.stringify(ins.Config.Cmd).slice(0, 60)}`);
  if (ins?.HostConfig?.Init !== true) p.push(`Init ${String(ins?.HostConfig?.Init)}`);
  for (const v of Object.values(rec.params)) if (String(v).length >= 3 && cmd.join("\n").includes(String(v))) p.push(`value ${String(v)} in Entrypoint`);
  const secretsSeen = leaks(JSON.stringify([ins?.Config?.Env, cmd, ins?.Config?.Labels]));
  if (secretsSeen.length > 0) p.push(`secret in Env/Entrypoint/Labels: ${secretsSeen.join(",")}`);
  const mounts = JSON.stringify([ins?.HostConfig?.Binds, ins?.Mounts]);
  if (mounts.includes("docker.sock")) p.push("Docker socket mounted");
  const hc = ins?.HostConfig ?? {};
  if (ins?.Config?.User !== "33:33") p.push(`User ${String(ins?.Config?.User)}`);
  if (hc.Memory !== 536870912 || hc.MemorySwap !== 536870912) p.push(`Memory ${String(hc.Memory)}/${String(hc.MemorySwap)}`);
  if (hc.PidsLimit !== 128) p.push(`PidsLimit ${String(hc.PidsLimit)}`);
  if (hc.Privileged !== false || !(hc.CapDrop ?? []).includes("ALL")) p.push("privileged or capabilities kept");
  const lc = hc.LogConfig ?? {};
  if (lc.Type !== "json-file" || lc.Config?.["max-size"] !== "1m" || lc.Config?.["max-file"] !== "1") p.push(`LogConfig ${JSON.stringify(lc)}`);
  const nets = Object.keys(ins?.NetworkSettings?.Networks ?? {}).sort();
  const wantNets = (rec.online && (rec.kind === "wordpress.inspect" || rec.kind === "wordpress.update") ? [siteNet, edgeNet] : [siteNet]).sort();
  if (JSON.stringify(nets) !== JSON.stringify(wantNets)) p.push(`networks ${nets.join(",")} (want ${wantNets.join(",")})`);
  return p;
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const n of tracked.containers) await docker(["rm", "-f", "-v", n]);
  for (const n of tracked.networks) await docker(["network", "rm", n]);
  for (const n of tracked.volumes) await docker(["volume", "rm", "-f", n]);
  if (tmp) await rm(tmp, { recursive: true, force: true });
}

async function createProbeNetwork() {
  for (let i = 0; i < 8; i++) {
    const subnet = `10.${String(200 + Math.floor(Math.random() * 50))}.${String(Math.floor(Math.random() * 256))}.0/24`;
    tracked.networks.add(probeNet);
    const r = await docker(["network", "create", "--driver", "bridge", "--subnet", subnet, probeNet]);
    if (r.ok) return subnet;
  }
  throw new Error("no free /24 for the probe network");
}

async function main() {
  const t0 = performance.now();
  for (const img of [CLI_IMAGE, SITE_IMAGE, DB_IMAGE]) {
    assert((await docker(["image", "inspect", img])).ok, `image ${img} on this machine (nothing is pulled)`, "missing");
  }
  volumesBefore = new Set((await docker(["volume", "ls", "-q"])).stdout.split("\n").filter(Boolean));
  const engine = (await docker(["version", "--format", "{{.Server.Version}}"])).stdout.trim();
  tmp = await mkdtemp(path.join(os.tmpdir(), `${base}_`));
  Object.assign(versions, { engine, cliImage: CLI_IMAGE, siteImage: SITE_IMAGE });

  await createProbeNetwork();
  tracked.containers.add(`${base}_probe`);
  const probe = await docker(["run", "--rm", "--name", `${base}_probe`, "--network", probeNet, "--entrypoint", "sh", CLI_IMAGE,
    "-c", "curl -fsS -o /dev/null --max-time 15 https://api.wordpress.org/core/version-check/1.7/"], 60_000);
  if (!probe.ok) {
    console.log("wordpress.org not reachable");
    return false;
  }

  const adapter = newAdapter();
  const st = {}; // values carried from step to step
  const step2 = [];
  const checkLogin = async (pw, what) => {
    try {
      await assertLogin(pw, what);
    } catch (err) {
      step2.push(formatErr(err));
    }
  };
  const install = (adminPw, dbPw = DB_PASSWORD) =>
    job(adapter, "wordpress.install", { dbName, dbUser: dbName, siteUrl: `http://${SITE_HOST}`, title: "Test site",
      adminUser: "admin", adminEmail: "admin@example.test" }, { HP_DB_PASSWORD: dbPw, HP_ADMIN_PASSWORD: adminPw });

  const siteOk = await step("site-made-the-product-way", async () => {
    tracked.containers.add(siteContainer).add(dbContainer);
    tracked.networks.add(edgeNet).add(siteNet);
    tracked.volumes.add(htmlVolume);
    const deployed = await adapter.deployService(createApprovedServiceSpec({
      serviceInstanceId, siteId, organizationId: "org_swarmtest", image: SITE_IMAGE, containerName: siteContainer,
      env: {}, resourceLimits: { cpuMilli: 1000, memoryBytes: "536870912" }, exposeHttp: true, internalPort: 80,
      volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
    }));
    assert(deployed.status === "succeeded", "deployService succeeded", JSON.stringify(deployed));
    const pwFile = path.join(tmp, "db-password");
    await writeFile(pwFile, DB_PASSWORD, { mode: 0o644 });
    await chmod(pwFile, 0o644);
    const db = await docker(["run", "-d", "--name", dbContainer, "--network", siteNet, "--network-alias", "hp-mariadb",
      "-v", `${pwFile}:/run/hp/db-password:ro`, "-e", "MARIADB_RANDOM_ROOT_PASSWORD=1", "-e", `MARIADB_DATABASE=${dbName}`,
      "-e", `MARIADB_USER=${dbName}`, "-e", "MARIADB_PASSWORD_FILE=/run/hp/db-password", DB_IMAGE]);
    assert(db.ok, "database container starts", db.stderr);
    for (let i = 0; ; i++) {
      if ((await docker(["exec", dbContainer, "healthcheck.sh", "--connect", "--innodb_initialized"])).ok) break;
      assert(i < 90, "database ready within 90 s", "not ready");
      await sleep(1000);
    }
    const ins = JSON.parse((await docker(["container", "inspect", siteContainer])).stdout)[0];
    siteIp = ins.NetworkSettings.Networks[edgeNet]?.IPAddress ?? "";
    assert(siteIp !== "", "site has an address on its edge network", "none");
    // The failed install (wrong database password) first: its tail is the one that used to leak.
    const bad = await install(ADMIN_64, WRONG_DB_PASSWORD);
    assert(bad.exitCode !== 0, "install with a wrong database password fails", bad.exitCode);
    st.failedInstallExit = bad.exitCode;
    await helper({ script: "rm -f wp-config.php" }); // set-up: back to a site without configuration
    const r = await install(ADMIN_19);
    assert(r.exitCode === 0, "install exit 0", `${String(r.exitCode)} ${r.outputTail}`);
    await checkLogin(ADMIN_19, "19-character password");
    const home = await httpRequest("GET", "/");
    assert(home.status === 200, "GET / answers 200", home.status);
    return [`site at ${siteIp} (edge network), install exit 0, failed install exit ${String(bad.exitCode)}`];
  });
  if (!siteOk) return true;

  // Step 2's installs; its verdict waits for the tails of every job of the run.
  for (const [pw, what] of [[ADMIN_64, "64-character"], [ADMIN_128, "128-character"], [ADMIN_QUOTED, "quoted"]]) {
    const r = await install(pw);
    if (r.exitCode !== 0) step2.push(`install with ${what} password exit ${String(r.exitCode)}`);
    await checkLogin(pw, `${what} password`);
  }

  await step("check-lists-the-outdated-plugin", async () => {
    const php = `$z = new ZipArchive; if ($z->open("/tmp/c.zip") !== true || !$z->extractTo("wp-content/plugins")) exit(1);\n${pluginVersionPhp("0.1")}`;
    await helper({ network: probeNet, env: { HP_PHP: php },
      script: 'curl -fsSL --max-time 60 -o /tmp/c.zip https://downloads.wordpress.org/plugin/classic-editor.zip && php -r "$HP_PHP"' });
    await helper({ network: siteNet, script: "wp plugin activate classic-editor --skip-themes" });
    const r = await job(adapter, "wordpress.inspect");
    assert(r.exitCode === 0, "exit 0", `${String(r.exitCode)} ${r.outputTail}`);
    assert(WordpressStateResultSchema.safeParse(r.result).success, "result passes WordpressStateResultSchema", JSON.stringify(r.result));
    assert(r.result.updatesKnown === true, "updatesKnown true", r.result.updatesKnown);
    const ce = r.result.plugins.find((p) => p.name === "classic-editor");
    assert(ce?.version === "0.1" && typeof ce.updateVersion === "string", "classic-editor 0.1 with an updateVersion", JSON.stringify(ce));
    const admin = r.result.administrators.find((a) => a.login === "admin");
    assert(admin, "administrators hold the first administrator", JSON.stringify(r.result.administrators));
    assert(r.result.coreVersion === IMAGE_CORE, `core version ${String(IMAGE_CORE)} of the image`, r.result.coreVersion);
    Object.assign(st, { online: r.result, adminId: admin.id, ceNew: ce.updateVersion });
    Object.assign(versions, { core: r.result.coreVersion, coreUpdate: r.result.coreUpdate, classicEditorOffered: ce.updateVersion });
    return [`core ${r.result.coreVersion} (update offered: ${String(r.result.coreUpdate)}), ${String(r.result.plugins.length)} plugins, classic-editor 0.1 -> ${ce.updateVersion}, admin id ${String(admin.id)}`];
  });

  await step("honest-after-failed-lookups", async () => {
    // R140: the test request works (curl is not WordPress), WordPress's own lookups fail; an update is really waiting.
    const muPath = "wp-content/mu-plugins/hp-nolookup.php";
    const mu = `<?php
add_filter('pre_http_request', function ($pre, $args, $url) { $p = (string) parse_url($url, PHP_URL_PATH); if (parse_url($url, PHP_URL_HOST) === 'api.wordpress.org' && (str_contains($p, 'update-check') || str_contains($p, 'version-check'))) return new WP_Error('hp_test', 'lookup refused'); return $pre; }, 10, 3);
`;
    await helper({ env: { HP_FILE: mu }, script: `mkdir -p wp-content/mu-plugins && printf '%s' "$HP_FILE" > ${muPath}` });
    let r;
    try {
      r = await job(adapter, "wordpress.inspect");
    } finally {
      await helper({ script: `rm -f ${muPath}` });
    }
    assert(r.exitCode === 0 && WordpressStateResultSchema.safeParse(r.result).success, "exit 0 with a valid result", `${String(r.exitCode)} ${r.outputTail}`);
    const named = [...r.result.plugins, ...r.result.themes].filter((i) => i.updateVersion !== null);
    assert(r.result.updatesKnown === false && r.result.coreUpdate === null && named.length === 0, "updatesKnown false, no update version at all", JSON.stringify(r.result).slice(0, 300));
    assert(r.result.plugins.find((p) => p.name === "classic-editor")?.version === "0.1", "the installed versions are still listed", JSON.stringify(r.result.plugins));
    // The step can fail: without the plugin the same check names the waiting update again.
    const again = await job(adapter, "wordpress.inspect");
    const ce = again.result?.plugins.find((p) => p.name === "classic-editor");
    assert(again.result?.updatesKnown === true && ce?.updateVersion === st.ceNew, `without the plugin: known, classic-editor -> ${String(st.ceNew)}`, JSON.stringify(ce));
    // R147.1: a site with no plugin (WordPress then stores no `checked`); the plugins come back as they were for the later steps.
    await helper({ network: siteNet, script: "wp plugin deactivate --all --skip-themes && mv wp-content/plugins wp-content/hp-plugins-away && mkdir wp-content/plugins" });
    let none, noneRefused;
    try {
      none = await job(adapter, "wordpress.inspect");
      await helper({ env: { HP_FILE: mu }, script: `printf '%s' "$HP_FILE" > ${muPath}` });
      noneRefused = await job(adapter, "wordpress.inspect");
    } finally {
      await helper({ network: siteNet, script: `rm -f ${muPath} && rmdir wp-content/plugins && mv wp-content/hp-plugins-away wp-content/plugins && wp plugin activate classic-editor --skip-themes` });
    }
    assert(none.exitCode === 0 && none.result?.plugins.length === 0 && none.result.updatesKnown === true, "no plugin, lookups answered: exit 0, updatesKnown true",
      `${String(none.exitCode)} ${JSON.stringify(none.result ?? none.outputTail).slice(0, 300)}`);
    const noneNamed = [...(noneRefused.result?.plugins ?? []), ...(noneRefused.result?.themes ?? [])].filter((i) => i.updateVersion !== null);
    assert(noneRefused.exitCode === 0 && WordpressStateResultSchema.safeParse(noneRefused.result).success && noneRefused.result.updatesKnown === false &&
      noneRefused.result.coreUpdate === null && noneNamed.length === 0, "no plugin, lookups refused: updatesKnown false, no update version at all",
      `${String(noneRefused.exitCode)} ${JSON.stringify(noneRefused.result ?? noneRefused.outputTail).slice(0, 300)}`);
    return [`lookups refused: exit 0, updatesKnown false, no update version (classic-editor 0.1 listed); plugin removed: known, 0.1 -> ${String(ce.updateVersion)}`,
      "no plugin at all: answered -> updatesKnown true; refused -> updatesKnown false, no update version"];
  });

  await step("one-plugin-updated", async () => {
    const r = await job(adapter, "wordpress.update", { target: "plugin:classic-editor" });
    assert(r.exitCode === 0, "exit 0", `${String(r.exitCode)} ${r.outputTail}`);
    assert(WordpressUpdateResultSchema.safeParse(r.result).success, "result passes WordpressUpdateResultSchema", JSON.stringify(r.result));
    const item = r.result.items.find((i) => i.name === "classic-editor");
    assert(item?.type === "plugin" && item.status === "updated" && item.oldVersion === "0.1" && item.newVersion === st.ceNew,
      `classic-editor updated 0.1 -> ${String(st.ceNew)}`, JSON.stringify(r.result));
    const again = await job(adapter, "wordpress.inspect");
    const ce = again.result?.plugins.find((p) => p.name === "classic-editor");
    assert(ce?.version === st.ceNew && ce.updateVersion === null, "second check: new version, no update waiting", JSON.stringify(ce));
    const foreign = await helper({ user: "0:0", script: "find /var/www/html ! -user 33 | head -5" });
    assert(foreign === "", "every file of the site belongs to user 33", foreign);
    assert(!(await maintenancePresent()), "no .maintenance file", "present");
    const home = await httpRequest("GET", "/");
    assert(home.status === 200, "GET / answers 200", home.status);
    const notes = [`classic-editor ${item.oldVersion} -> ${String(item.newVersion)}, files uid 33, no marker, GET / 200`];
    if (st.online?.coreUpdate) {
      const c = await job(adapter, "wordpress.update", { target: "core" });
      const ci = c.result?.items.find((i) => i.type === "core");
      assert(c.exitCode === 0 && ci?.status === "updated", "core updated", JSON.stringify(c.result ?? c.outputTail));
      const h = await httpRequest("GET", "/");
      const v = (await job(adapter, "wordpress.inspect")).result?.coreVersion;
      assert(h.status === 200 && v === st.online.coreUpdate, `GET / 200 and core ${st.online.coreUpdate}`, `${String(h.status)} ${String(v)}`);
      notes.push(`core ${String(ci.oldVersion)} -> ${String(ci.newVersion)}, GET / 200`);
      versions.coreAfter = v;
    } else {
      notes.push("no newer WordPress was offered: a core update could not be shown");
    }
    return notes;
  });

  await step("password-reset", async () => {
    assert(typeof st.adminId === "number", "the check reported the administrator's id", st.adminId);
    const r = await job(adapter, "wordpress.reset-password", { userId: String(st.adminId) }, { HP_ADMIN_PASSWORD: RESET_PW });
    assert(r.exitCode === 0 && !("result" in r), "exit 0, no result", `${String(r.exitCode)} ${r.outputTail}`);
    assert(leakedWindows(r.outputTail, RESET_PW) === 0, "no window of the password in the tail", "found");
    await assertLogin(RESET_PW, "new password");
    const old = await login(ADMIN_QUOTED);
    assert(old.status === 200 && !old.loggedIn, "old password: 200 without the cookie", JSON.stringify(old));
    const subId = await helper({ network: siteNet, env: { HP_PHP: 'echo wp_insert_user(["user_login" => "subscriber", "user_pass" => wp_generate_password(24), "role" => "subscriber"]);' },
      script: 'wp eval --skip-plugins --skip-themes "$HP_PHP"' });
    assert(/^[1-9]\d*$/.test(subId), "set-up: a subscriber exists", subId);
    const sub = await job(adapter, "wordpress.reset-password", { userId: subId }, { HP_ADMIN_PASSWORD: rnd(24) });
    assert(sub.exitCode === 40, "a user who is no administrator: exit 40 (not_administrator)", sub.exitCode);
    await assertLogin(RESET_PW, "first administrator after the refused reset");
    return [`admin ${String(st.adminId)}: new 302+cookie, old 200 no cookie; subscriber ${subId}: exit 40, admin still logs in`];
  });

  await step("hostile-site-code", async () => {
    const forged = '{"coreVersion":"9.9.9-forged","coreUpdate":null,"updatesKnown":true,"plugins":[{"name":"forged-by-site","title":"forged","status":"active","version":"1","updateVersion":null}],"themes":[],"administrators":[{"id":1,"login":"forged"}]}';
    const hostile = `<?php
// Throw-away test code: tries the result channel on every load, floods both streams once.
$forged = '${forged}';
$proof = __DIR__ . '/../hp-hostile-ran.log'; // what the code did, so the step can tell "it ran" from "it never loaded"
$opened = [];
foreach (['php://fd/3', '/proc/1/fd/1', '/proc/1/fd/2'] as $t) { $h = @fopen($t, 'w'); $opened[] = $t . '=' . ($h ? 'open' : 'refused'); if ($h) { @fwrite($h, "\\n$forged\\n"); @fclose($h); } }
$w = ['out' => 0, 'err' => 0];
if (!file_exists('/tmp/hp-flooded')) {
  touch('/tmp/hp-flooded');
  $l = str_repeat('flood ', 10) . "\\n";
  for ($i = 0; $i < 200000; $i++) { $w['out'] += (int) fwrite(STDOUT, $l); $w['err'] += (int) fwrite(STDERR, $l); }
  $big = str_repeat('A', 50 << 20) . "\\n"; $w['out'] += (int) fwrite(STDOUT, $big); $w['err'] += (int) fwrite(STDERR, $big); unset($big);
  $w['out'] += (int) fwrite(STDOUT, "\\n$forged\\n"); $w['err'] += (int) fwrite(STDERR, "\\n$forged\\n");
}
@file_put_contents($proof, 'ran ' . implode(' ', $opened) . ' wrote-out=' . $w['out'] . ' wrote-err=' . $w['err'] . ' fds=' . implode(',', array_map(fn ($f) => (string) @readlink($f), ['/proc/self/fd/1', '/proc/self/fd/2', '/proc/1/fd/1', '/proc/1/fd/2'])) . ' cmd=' . str_replace("\\0", ' ', (string) @file_get_contents('/proc/self/cmdline')) . ' ppid=' . str_replace("\\0", ' ', (string) @file_get_contents('/proc/' . posix_getppid() . '/cmdline')) . "\\n", FILE_APPEND);
`;
    const muPath = "wp-content/mu-plugins/hp-hostile.php";
    const proofPath = "wp-content/hp-hostile-ran.log";
    await helper({ env: { HP_FILE: hostile }, script: `mkdir -p wp-content/mu-plugins && printf '%s' "$HP_FILE" > ${muPath}` });
    let r;
    try {
      r = await job(adapter, "wordpress.inspect");
    } finally {
      st.hostileProof = (await helper({ script: `cat ${proofPath} 2>/dev/null; rm -f ${muPath} ${proofPath}` })); // by exact path
    }
    const rec = [...jobs.values()].at(-1);
    st.hostileRec = rec;
    const resultText = JSON.stringify(r.result ?? null);
    assert(!resultText.includes("forged"), "no forged value in the result", resultText);
    assert(r.result ? r.exitCode === 0 && WordpressStateResultSchema.safeParse(r.result).success : [0, 70].includes(r.exitCode),
      "the true result, or none (result_unreadable)", `${String(r.exitCode)} ${resultText.slice(0, 200)}`);
    assert(rec.ms < siteJobTimeoutMs("wordpress.inspect"), "the job ends inside its limit", rec.ms);
    assert(rec.adapterLogBytes <= READ_CEILING, `the adapter read at most ${String(READ_CEILING)} bytes`, rec.adapterLogBytes);
    assert(rec.raw && rec.raw.bytes <= READ_CEILING, "the whole kept log stays inside its 1 MiB bound", rec.raw?.bytes);
    assert(r.outputTail.length <= 4096, "the tail is bounded (4 KiB)", r.outputTail.length);
    // The step can fail: the proof file shows the hostile code really ran inside the job and its writes went out.
    assert(/^ran .*wrote-err=[1-9]/m.test(st.hostileProof), "the hostile code ran inside the job and flooded and forged", st.hostileProof || "no proof file");
    const xss = "<img src=x onerror=alert(1)>";
    await helper({ env: { HP_FILE: `<?php\n/*\n * Plugin Name: ${xss}\n * Version: 1.0\n */\n` },
      script: `mkdir -p wp-content/plugins/hp-title && printf '%s' "$HP_FILE" > wp-content/plugins/hp-title/hp-title.php` });
    const n = await job(adapter, "wordpress.inspect");
    assert(n.exitCode === 0 && WordpressStateResultSchema.safeParse(n.result).success, "a normal check works again", `${String(n.exitCode)} ${n.outputTail}`);
    const t = n.result.plugins.find((p) => p.name === "hp-title");
    assert(t?.title === xss, "the hostile title comes back as plain text", JSON.stringify(t));
    // Site code must run only inside the job's script, under its own KILL limit, never in the image's entrypoint check.
    const early = st.hostileProof.split("\n").filter((l) => /cmd=php \S+ help |docker-entrypoint/.test(l));
    assert(early.length === 0, "site code runs only inside the job's own script (under timeout -s KILL)",
      `it ran before the script, in the cli image's entrypoint check: ${early[0]?.replace(/^ran .*? fds=/, "fds=").slice(0, 220) ?? ""}`);
    return [`exit ${String(r.exitCode)}, result ${r.result ? "true one" : "absent"}, adapter read ${String(rec.adapterLogBytes)} B, log kept ${String(rec.raw.bytes)} B, tail ${String(r.outputTail.length)} chars, ${(rec.ms / 1000).toFixed(1)} s`];
  });

  await step("cut-short-then-settled", async () => {
    await helper({ env: { HP_PHP: pluginVersionPhp("0.1") }, script: 'php -r "$HP_PHP"' });
    await helper({ env: { HP_FILE: "<?php\nadd_filter('upgrader_pre_download', function ($r) { sleep(120); return $r; });\n" },
      script: "mkdir -p wp-content/mu-plugins && printf '%s' \"$HP_FILE\" > wp-content/mu-plugins/hp-slow.php" });
    const before = await job(adapter, "wordpress.inspect");
    assert(before.result?.plugins.find((p) => p.name === "classic-editor")?.updateVersion, "an update waits again", JSON.stringify(before.result?.plugins));
    const short = newAdapter({ jobTimeoutMs: 20_000 });
    let r;
    try {
      r = await job(short, "wordpress.update", { target: "plugin:classic-editor" });
    } finally {
      await helper({ script: "rm -f wp-content/mu-plugins/hp-slow.php" });
    }
    const rec = [...jobs.values()].at(-1);
    assert(r.exitCode === 124, "exit 124 (timed_out)", `${String(r.exitCode)} ${r.outputTail}`);
    assert(rec.ms >= 20_000 && rec.ms < 30_000, "answer a few seconds after the 20 s limit", rec.ms);
    assert(!(await docker(["container", "inspect", rec.jobId])).ok, "the job's container is gone", "still there");
    let planted = false;
    if (!(await maintenancePresent())) {
      planted = true;
      await helper({ script: "echo '<?php $upgrading = time(); ?>' > .maintenance" });
    }
    const down = await httpRequest("GET", "/");
    assert(down.status === 503, "GET / answers 503 while the marker is there", down.status);
    const s = await job(adapter, "wordpress.settle");
    assert(s.exitCode === 0, "settle exit 0", `${String(s.exitCode)} ${s.outputTail}`);
    assert(!(await maintenancePresent()), "the marker is gone", "present");
    const up = await httpRequest("GET", "/");
    assert(up.status === 200, "GET / answers 200", up.status);
    const c = await job(adapter, "wordpress.inspect");
    const onDisk = await helper({ script: "sed -n 's/^[ *]*Version: *//p' wp-content/plugins/classic-editor/classic-editor.php | head -1" });
    const ce = c.result?.plugins.find((p) => p.name === "classic-editor");
    assert(c.exitCode === 0 && ce?.version === onDisk, `the check reports the real version (${onDisk})`, JSON.stringify(ce));
    return [`killed at ${(rec.ms / 1000).toFixed(1)} s, marker ${planted ? "planted by this script (WordPress left none)" : "left by WordPress"}, 503 -> settle -> 200, classic-editor ${onDisk}`];
  });

  await step("ends-by-itself", async () => {
    // runSiteJob cannot show this (its own timer fires first, with 124): the product's payload is started here, with no timer of ours.
    const kind = "wordpress.reset-password";
    const limitS = siteJobTimeoutMs(kind) / 1000;
    const jobId = `job_${base}_hang`;
    const name = `${base}_hang`;
    const secretsRoot = path.join(tmp, "secrets");
    const muPath = "wp-content/mu-plugins/hp-hang.php";
    const resolvedSecrets = { HP_ADMIN_PASSWORD: rnd(24) };
    tracked.containers.add(name);
    await helper({ script: `mkdir -p wp-content/mu-plugins && echo '<?php sleep(600);' > ${muPath}` });
    try {
      const files = await writeServiceSecrets(secretsRoot, jobId, resolvedSecrets); // the adapter's way: files, read-only binds
      const payload = buildSiteJobContainerPayload({ jobId, kind, siteId, organizationId: "org_swarmtest", serviceInstanceId,
        params: { phpVersion: PHP, userId: String(st.adminId ?? 1) }, resolvedSecrets }, { executorUser: "0:0", rootKeyHostPath: "/nonexistent", ...files });
      const created = await adapter.dockerClient.request("POST", `/containers/create?name=${name}`, payload);
      assert(created.statusCode === 201, "the product's payload creates a container", created.statusCode);
      assert((await docker(["start", name])).ok, "the container starts", "start failed");
      const waited = await docker(["wait", name], (limitS + 60) * 1000);
      const st1 = JSON.parse((await docker(["container", "inspect", name])).stdout)[0]?.State ?? {};
      const secs = (Date.parse(st1.FinishedAt) - Date.parse(st1.StartedAt)) / 1000;
      const events = await docker(["events", "--since", st1.StartedAt, "--until", String(Math.ceil(Date.now() / 1000)),
        "--filter", `container=${name}`, "--format", "{{.Action}}"], 30_000);
      const actions = events.stdout.split("\n").filter(Boolean);
      assert(waited.ok && st1.ExitCode === 137 && st1.OOMKilled === false, "exit 137 (KILL), not out of memory", `${waited.stdout.trim()} ${JSON.stringify(st1).slice(0, 200)}`);
      assert(secs >= limitS && secs <= limitS + 15, `ended between ${String(limitS)} s and ${String(limitS + 15)} s`, secs);
      assert(events.ok && actions.includes("die") && !actions.some((a) => a === "kill" || a === "stop"), "nobody stopped it from outside (no kill or stop event)", actions.join(","));
      return [`${kind} with a mu-plugin that sleeps 600 s: exit ${String(st1.ExitCode)} after ${secs.toFixed(1)} s (limit ${String(limitS)} s), events ${actions.join(",")}`];
    } finally {
      await docker(["rm", "-f", "-v", name]);
      await helper({ script: `rm -f ${muPath}` });
      await purgeServiceSecrets(secretsRoot, jobId);
    }
  });

  await step("honest-without-internet", async () => {
    // Our own site container and network: detach, then remove the edge network so the job runs offline.
    await docker(["network", "disconnect", "-f", edgeNet, siteContainer]);
    assert((await docker(["network", "rm", edgeNet])).ok, "edge network removed", "still there");
    edgeGone = true;
    const r = await job(adapter, "wordpress.inspect");
    assert(r.exitCode === 0 && WordpressStateResultSchema.safeParse(r.result).success, "exit 0 with a valid result", `${String(r.exitCode)} ${r.outputTail}`);
    const known = (s) => s.updatesKnown !== false || s.coreUpdate !== null || s.plugins.some((p) => p.updateVersion) || s.themes.some((t) => t.updateVersion);
    assert(!known(r.result), "updatesKnown false and no update named", JSON.stringify(r.result).slice(0, 300));
    assert(known(st.online), "the same check fails on the online answer of step 3", "it passes");
    const snap = await filesSnapshot();
    const u = await job(adapter, "wordpress.update", { target: "plugin:classic-editor" });
    assert(u.exitCode === 30, "update exit 30 (wordpress_org_unreachable)", `${String(u.exitCode)} ${u.outputTail}`);
    assert((await filesSnapshot()) === snap, "no file changed", "changed");
    return [`inspect exit 0 updatesKnown false, ${String(r.result.plugins.length)} plugins; update exit 30, files unchanged`];
  });

  await step("job-shape", async () => {
    const wp = [...jobs.values()].filter((j) => j.kind in SCRIPTS);
    const problems = wp.flatMap((j) => shapeProblems(j, j.inspect).map((p) => `${j.kind} ${j.jobId}: ${p}`));
    assert(problems.length === 0, "every WordPress job has the designed shape", problems.join("; "));
    for (const kind of Object.keys(SCRIPTS)) assert(wp.some((j) => j.kind === kind && j.inspect), `a ${kind} job was inspected`, "none");
    assert(wp.some((j) => !j.online && j.inspect) && wp.some((j) => j.inspect && j === st.hostileRec), "offline and hostile jobs inspected", "missing");
    const installs = [...jobs.values()].filter((j) => j.kind === "wordpress.install");
    const seen = installs.flatMap((j) => leaks(JSON.stringify([j.inspect?.Config?.Env, j.inspect?.Config?.Entrypoint, j.inspect?.Config?.Cmd, j.inspect?.Config?.Labels])));
    assert(seen.length === 0, "no secret in Env, Entrypoint, Cmd or labels of an install", seen.join(","));
    const badInstalls = installs.filter((j) => JSON.stringify(j.inspect?.Config?.Entrypoint) !== JSON.stringify(["sh", "-c", WORDPRESS_INSTALL_SCRIPT]) ||
      j.inspect?.Config?.Cmd != null || j.inspect?.HostConfig?.Init !== true);
    assert(installs.length > 0 && badInstalls.length === 0, "every install: Entrypoint sh -c <constant>, no Cmd, Init true",
      JSON.stringify(badInstalls[0]?.inspect?.Config?.Cmd ?? badInstalls[0]?.inspect?.HostConfig?.Init ?? null));
    // The step can fail: the same check finds one changed byte of the script, a Cmd of ours, a missing init.
    const one = wp[0];
    const ep = one.inspect.Config.Entrypoint;
    for (const [what, bent] of [
      ["a changed script", { ...one.inspect, Config: { ...one.inspect.Config, Entrypoint: [...ep.slice(0, -1), `${ep.at(-1)} `] } }],
      ["a Cmd", { ...one.inspect, Config: { ...one.inspect.Config, Cmd: ["wp", "shell"] } }],
      ["no init", { ...one.inspect, HostConfig: { ...one.inspect.HostConfig, Init: null } }],
    ]) assert(shapeProblems(one, bent).length > 0, `the check sees ${what}`, "it does not");
    return [`${String(wp.length)} WordPress jobs inspected while running (${String(wp.filter((j) => !j.online).length)} offline), ${String(installs.length)} installs`];
  });

  await step("secrets-never-in-a-tail", () => {
    assert(leakedWindows(`x${ADMIN_128.slice(5, 13)}y`, ADMIN_128) > 0, "self-check: the scan finds a planted window", "missing");
    const problems = [...step2];
    for (const j of jobs.values()) {
      const inTail = leaks(j.res?.outputTail ?? "");
      if (inTail.length > 0) problems.push(`${j.kind} ${j.jobId} tail holds ${inTail.join(",")}`);
      const inRaw = leaks(`${j.raw?.stdout ?? ""}${j.raw?.stderr ?? ""}`);
      if (inRaw.length > 0) problems.push(`${j.kind} ${j.jobId} raw log holds ${inRaw.join(",")}`);
    }
    assert(problems.length === 0, "logins 302 + cookie and no 8-character window of any secret", problems.join("; "));
    return [`${String(jobs.size)} job tails and raw logs scanned (failed install exit ${String(st.failedInstallExit)}); 19/64/128/quoted logins 302 + cookie`];
  });

  versions.totalS = ((performance.now() - t0) / 1000).toFixed(1);
  return true;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig}: removing what this run created`);
    void cleanup().finally(() => process.exit(130));
  });
}

const started = performance.now();
let reachable = false;
try {
  reachable = await main();
} catch (err) {
  console.log(`FAIL run: ${formatErr(err)}`);
} finally {
  await cleanup();
}

if (reachable) {
  await step("nothing-left", async () => {
    const left = [];
    for (const n of tracked.containers) if ((await docker(["container", "inspect", n])).ok) left.push(n);
    for (const n of tracked.networks) if ((await docker(["network", "inspect", n])).ok) left.push(n);
    for (const n of tracked.volumes) if ((await docker(["volume", "inspect", n])).ok) left.push(n);
    for (const kind of [["ps", "-a"], ["volume", "ls"], ["network", "ls"]]) {
      const r = await docker([...kind, "--filter", `name=${base}`, "-q"]);
      if (r.stdout.trim()) left.push(`${kind.join(" ")}: ${r.stdout.trim()}`);
    }
    const after = (await docker(["volume", "ls", "-q"])).stdout.split("\n").filter(Boolean);
    const fresh = after.filter((v) => !volumesBefore.has(v));
    if (fresh.length > 0) left.push(`new volumes: ${fresh.join(",")}`);
    if (await access(tmp).then(() => true, () => false)) left.push(`temporary folder ${tmp}`);
    assert(left.length === 0, "nothing of this run left", left.join("; "));
    return [`${String(tracked.containers.size)} containers, ${String(tracked.networks.size)} networks, ${String(tracked.volumes.size)} volume removed by name; volume list as before; temporary folder gone`];
  });
  console.log("Versions:", JSON.stringify(versions));
  console.log("Job times (s):", JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) =>
    [k, { n: v.length, min: +(Math.min(...v) / 1000).toFixed(1), max: +(Math.max(...v) / 1000).toFixed(1) }]))));
}
const failed = results.filter((r) => !r.ok);
console.log(`${String(results.length - failed.length)}/${String(results.length)} passed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exitCode = reachable && failed.length === 0 ? 0 : 1;
