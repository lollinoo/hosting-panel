#!/usr/bin/env node
/**
 * Real-Docker Engine acceptance check for M4b-1 (the engine of the WordPress import, R149-R162).
 *
 * Drives the built DockerEngineSocketAdapter: siteFiles import.* operations in the files helper and
 * runSiteJob with db.import, db.import-load, wordpress.import-finalize and wordpress.set-url, on throw-away
 * sites made the product's way (deployService + db.provision + wordpress.install).
 *
 * The db.* jobs of the product join the network hp_mariadb_net and first look for the container
 * hp_mariadb. This script never creates or touches those names: its wrapper of the adapter's Docker
 * client sends that look-up to its own database container and the job's NetworkMode to its own network.
 *
 * Machine safety: every object created carries "hp_swarmtest_m4imp_<hex>" in its name and is removed by
 * exact name in `finally` and on SIGINT/SIGTERM, containers with their anonymous volumes. No host port is
 * published, nothing is pulled, nothing is pruned, no internet is needed. Secrets reach containers only
 * as files of the temporary folder or on stdin.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (p) => import(pathToFileURL(path.resolve(repoRoot, p)).href);
const {
  DockerEngineSocketAdapter,
  ExecutorCodedError,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  SITE_FILES_PROGRAM,
  WORDPRESS_SET_URL_SCRIPT,
  buildSharedDatabaseContainerPayload,
  ensureSiteFilesProgram,
  getManagedVolumeName,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  siteFilesHelperName,
} = await load("apps/docker-executor/dist/index.js");
const {
  SITE_FILES_RESULT_SCHEMAS,
  WordpressImportLoadResultSchema,
  resolveWordpressCliImage,
  resolveWordpressImage,
  siteDatabasePrefix,
} = await load("packages/contracts/dist/index.js");
const { createApprovedServiceSpec } = await load("packages/executor-contracts/dist/index.js");

const PHP = "8.4";
const CLI_IMAGE = resolveWordpressCliImage(PHP);
const SITE_IMAGE = resolveWordpressImage(PHP);
const DB_IMAGE = "mariadb:12.3.3";
const OLD_URL = "http://old.example.test";
const NEW_URL = "http://wp-a.example.test";
// R163: the old address is rewritten where it ends a sentence, and kept where the host goes on (.example).
const addrSample = (u) => `Visit ${u}. Not ${OLD_URL}.example/x.`;
// The product's own boundary, read from the script it sends.
const EDGE = /'(\(\?![^']+)'/.exec(WORDPRESS_SET_URL_SCRIPT)?.[1] ?? "(?!missing)";
const OLD_PATTERN = String.raw`https?:(\\?/)\1` + OLD_URL.slice(7).replaceAll(".", "\\.") + EDGE;
// A table name with a backtick, a ; and a space, with the old address in one value, taken through the switch, the rewrite and the undo.
const ODD = "old_hp_o`d; d";
const ODD_AFTER = `plain ${NEW_URL}/odd`;
const qi = (n) => `\`${n.replaceAll("`", "``")}\``;
const CHUNK = 512 * 1024;
// The gate texts, read from the shipped program so the hand-built half switch writes the same bytes.
const phpConst = (name) => JSON.parse(new RegExp(`const ${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(SITE_FILES_PROGRAM)[1]);
const GATE_HTACCESS = phpConst("HP_IMPORT_GATE_HTACCESS");
const GATE_CONFIG = phpConst("HP_IMPORT_GATE_CONFIG");
const GATE_MARK = "hosting-panel import gate";

const hex = randomBytes(3).toString("hex");
const base = `hp_swarmtest_m4imp_${hex}`;
const dbContainer = `${base}_db`;
const dbNet = `${base}_dbnet`;
const uidGid = `${String(process.getuid())}:${String(process.getgid())}`;
const hex64 = () => randomBytes(32).toString("hex");
const newId = () => randomBytes(16).toString("hex");
const rnd = (n) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

function makeSite(tag, url, title) {
  const id = `${base}_${tag}`;
  const svc = `${id}_svc`;
  return {
    tag, id, svc, url, title, host: url.slice(7), container: `${id}_site`,
    net: getSiteInternalNetworkName(id), edge: getSiteEdgeNetworkName(id), volume: getManagedVolumeName(svc, "html"),
    dbName: siteDatabasePrefix(id), dbPw: hex64(), adminPw: rnd(24), ip: "",
  };
}
const src = makeSite("s", OLD_URL, "Imported Title");
const tgt = makeSite("t", NEW_URL, "Test site");

// Throw-away secrets of this run only; none of them is ever on a command line.
const ROOT_PW = hex64();
const importPws = [];
const secretList = () => ({ ROOT_PW, SRC_DB: src.dbPw, TGT_DB: tgt.dbPw, SRC_ADMIN: src.adminPw, TGT_ADMIN: tgt.adminPw,
  ...Object.fromEntries(importPws.map((p, i) => [`IMPORT_${String(i)}`, p])) });

const tracked = { containers: new Set(), networks: new Set(), volumes: new Set() };
const jobs = new Map();
const times = {};
const results = [];
const versions = {};
const disk = { start: 0, min: Infinity };
let tmp = null;
let cleanedUp = false;
let jobSeq = 0;
let helperSeq = 0;
let volumesBefore = null;
let adapter = null;
let dbRewrites = 0;
const skippedConnects = [];

class StepAssertionError extends Error {
  constructor(expected, actual) {
    super(`${expected} / ${actual}`);
  }
}

function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(expected, String(actual).slice(0, 500));
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

function docker(args, { timeoutMs = 180_000, input } = {}) {
  return new Promise((resolve) => {
    const cp = execFile("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 160 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
    cp.stdin.end(input ?? "");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (x) => createHash("sha256").update(x).digest("hex");
const sampleDisk = () => {
  const s = statfsSync("/");
  const free = s.bavail * s.bsize;
  disk.min = Math.min(disk.min, free);
  return free;
};

/** Counts the 8-character windows of `secret` found in `text`. */
function leakedWindows(text, secret) {
  let n = 0;
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) n++;
  return n;
}
const leaks = (text) => Object.entries(secretList()).filter(([, s]) => leakedWindows(text, s) > 0).map(([k]) => k);

function demux(buf) {
  const out = { stdout: [], stderr: [] };
  for (let o = 0; o + 8 <= buf.length; ) {
    const end = Math.min(buf.length, o + 8 + buf.readUInt32BE(o + 4));
    out[buf[o] === 2 ? "stderr" : "stdout"].push(buf.subarray(o + 8, end));
    o = end;
  }
  return { stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8") };
}

/**
 * Wraps the adapter's Docker calls: hp_mariadb / hp_mariadb_net become this run's own database and network,
 * any other use of those names stops the run; each job is inspected at start and its raw log kept.
 */
function instrument(a) {
  const client = a.dockerClient;
  const orig = client.request.bind(client);
  const byId = new Map();
  client.request = async (method, p0, body0, opts) => {
    let p = p0;
    let body = body0;
    if (method === "GET" && p === `/containers/${SHARED_DB_CONTAINER_NAME}/json`) p = `/containers/${dbContainer}/json`;
    if (method === "POST" && p.startsWith("/containers/create?name=job_") && body?.HostConfig?.NetworkMode === SHARED_DB_NETWORK_NAME) {
      body = { ...body, HostConfig: { ...body.HostConfig, NetworkMode: dbNet } };
      dbRewrites++;
    }
    // deployService attaches hp_mariadb and hp_mail_relay to each new site network: the first goes to this
    // run's database, any other container that is not this run's answers 404 (the product's "not created yet").
    const conn = method === "POST" ? /^\/networks\/([^/]+)\/connect$/.exec(p) : null;
    if (conn && body?.Container === SHARED_DB_CONTAINER_NAME) {
      body = { ...body, Container: dbContainer };
      dbRewrites++;
    } else if (conn && !/^[0-9a-f]{64}$/.test(body?.Container ?? "") && !String(body?.Container).includes(base)) {
      skippedConnects.push(String(body?.Container));
      return { statusCode: 404, body: Buffer.from('{"message":"not a container of this run"}') };
    }
    if (p.includes(SHARED_DB_CONTAINER_NAME) || JSON.stringify(body ?? null).includes(`"${SHARED_DB_CONTAINER_NAME}`)) {
      throw new Error(`refused: the adapter asked for ${method} ${p} with a shared database name`);
    }
    const del = method === "DELETE" ? /^\/containers\/([0-9a-f]{64})\?/.exec(p) : null;
    if (del && byId.has(del[1])) {
      const raw = await orig("GET", `/containers/${del[1]}/logs?stdout=1&stderr=1`);
      byId.get(del[1]).raw = demux(raw.body);
    }
    const res = await orig(method, p, body, opts);
    const created = method === "POST" ? /^\/containers\/create\?name=(job_[^&]+)$/.exec(p) : null;
    if (created && res.statusCode === 201) byId.set(JSON.parse(res.body.toString("utf8")).Id, jobs.get(decodeURIComponent(created[1])));
    const m = /^\/containers\/([0-9a-f]{64})\/start/.exec(p);
    const rec = m ? byId.get(m[1]) : undefined;
    if (rec && res.statusCode === 204) {
      const ins = await docker(["container", "inspect", m[1]]);
      rec.inspect = ins.ok ? JSON.parse(ins.stdout)[0] : null;
    }
    return res;
  };
  return a;
}

/** One job through the product's runSiteJob. */
async function job(site, kind, params = {}, resolvedSecrets) {
  const jobId = `job_${base}_${String(++jobSeq)}`;
  const rec = { jobId, kind, params };
  jobs.set(jobId, rec);
  tracked.containers.add(jobId);
  const t0 = performance.now();
  try {
    rec.res = await adapter.runSiteJob({
      jobId, kind, siteId: site.id, organizationId: "org_swarmtest", serviceInstanceId: site.svc,
      params: kind.startsWith("wordpress.") ? { phpVersion: PHP, ...params } : params,
      ...(resolvedSecrets ? { resolvedSecrets } : {}),
    });
    return rec.res;
  } finally {
    rec.ms = performance.now() - t0;
    (times[kind] ??= []).push(rec.ms);
    sampleDisk();
  }
}
const jobOk = (r, what) => assert(r.exitCode === 0, `${what} exit 0`, `${String(r.exitCode)} ${r.outputTail ?? ""}`);
const loadResult = (r) => {
  if (r.result !== undefined) return r.result;
  const last = (r.outputTail ?? "").trim().split("\n").at(-1) ?? "";
  try {
    const p = WordpressImportLoadResultSchema.safeParse(JSON.parse(last));
    return p.success ? p.data : undefined;
  } catch {
    return undefined;
  }
};

/** One files-helper operation; its answer must pass the contracts schema. */
async function files(site, op, extra = {}) {
  tracked.containers.add(siteFilesHelperName(site.svc));
  const t0 = performance.now();
  try {
    const res = await adapter.siteFiles({ serviceInstanceId: site.svc, op, ...extra });
    const parsed = SITE_FILES_RESULT_SCHEMAS[op].safeParse(res);
    assert(parsed.success, `${op} answer passes its contracts schema`, JSON.stringify(res));
    return res;
  } finally {
    (times[`files ${op}`] ??= []).push(performance.now() - t0);
    sampleDisk();
  }
}
/** The coded refusal of an operation that must fail. */
async function refusal(promise) {
  try {
    const res = await promise;
    return { ok: true, res };
  } catch (err) {
    return { ok: false, code: err?.code, reason: err?.message };
  }
}

async function putSlot(site, slot, bytes, { chunk = CHUNK, onPartial } = {}) {
  const uploadId = randomBytes(12).toString("hex");
  let partialDone = false;
  for (let off = 0; ; ) {
    const end = Math.min(bytes.length, off + chunk);
    const final = end === bytes.length;
    const r = await files(site, "import.put", { slot, uploadId, offset: off, dataBase64: bytes.subarray(off, end).toString("base64"), final });
    assert(r.received === end, `import.put received ${String(end)} so far`, r.received);
    off = end;
    if (final) break;
    if (onPartial && !partialDone) {
      partialDone = true;
      await onPartial(uploadId);
    }
  }
  return uploadId;
}

/** A short container of this script on a site's html volume. */
async function helper(site, { network = "none", user = "33:33", script, env = {}, input } = {}) {
  const name = `${base}_h${String(++helperSeq)}`;
  tracked.containers.add(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await docker(["run", "--rm", "-i", "--name", name, "--network", network, "--user", user,
    "-v", `${site.volume}:/var/www/html`, "-w", "/var/www/html", ...envArgs, "--entrypoint", "sh", CLI_IMAGE, "-c", script], { input });
  assert(r.ok, `helper ${name} exits 0`, r.stderr.trim());
  sampleDisk();
  return r.stdout.trim();
}
const php = (site, code, opts = {}) => helper(site, { ...opts, env: { ...(opts.env ?? {}), HP_PHP: code }, script: 'php -r "$HP_PHP"' });
const wp = (site, cmd) => helper(site, { network: site.net, script: cmd });

/** SQL in this run's own database container, as root through a cnf file made from the key file. */
async function sql(query, cnf = "/tmp/root.cnf") {
  const r = await docker(["exec", dbContainer, "mariadb", `--defaults-extra-file=${cnf}`, "-N", "-B", "-e", query]);
  if (!r.ok) throw new StepAssertionError(`SQL ok: ${query.slice(0, 80)}`, r.stderr.trim());
  return r.stdout.trim();
}
const importLeftovers = () =>
  sql("SELECT CONCAT('schema ', SCHEMA_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME REGEXP '^hp_i[sam]_' UNION ALL SELECT CONCAT('user ', User) FROM mysql.user WHERE User LIKE 'hp\\_iu\\_%'");

async function tableSums(site) {
  const names = (await sql(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${site.dbName}' ORDER BY TABLE_NAME`)).split("\n").filter(Boolean);
  if (names.length === 0) return "no tables";
  return sha(await sql(`CHECKSUM TABLE ${names.map((n) => `\`${site.dbName}\`.${qi(n)}`).join(", ")} EXTENDED`));
}

// Every entry outside the staging folder: type, mode, owner, size, inode and mtime; the two files the gate
// rewrites (wp-config.php, .htaccess) by content, since a restore writes them anew.
const SNAPSHOT_PHP = String.raw`function w($d, &$o) {
  foreach (scandir($d) as $n) {
    if ($n === '.' || $n === '..') continue;
    $p = "$d/$n";
    if ($p === './.htpanel-import') continue;
    $s = lstat($p); $t = $s['mode'] & 0170000; $m = decoct($s['mode']);
    if ($t === 0040000) { $o[] = "$p d $m {$s['uid']}"; w($p, $o); }
    elseif ($n === '.htaccess' || $n === 'wp-config.php') $o[] = "$p f $m {$s['uid']} " . hash_file('sha256', $p);
    else $o[] = "$p $m {$s['size']} {$s['uid']} {$s['ino']} {$s['mtime']}" . ($t === 0120000 ? ' -> ' . readlink($p) : '');
  }
}
chdir('/var/www/html'); $o = array(); w('.', $o); sort($o); echo implode("\n", $o);`;
const filesSnapshot = async (site) => (await php(site, SNAPSHOT_PHP, { user: "0:0" })).split("\n");
function snapDiff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...a.filter((x) => !sb.has(x)).map((x) => `-${x}`), ...b.filter((x) => !sa.has(x)).map((x) => `+${x}`)];
}

async function state(site) {
  return { files: await filesSnapshot(site), tables: await tableSums(site), schemas: await sql("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY 1") };
}
function sameState(before, after, what) {
  const d = snapDiff(before.files, after.files);
  assert(d.length === 0, `${what}: the same files`, d.slice(0, 4).join(" | "));
  assert(before.tables === after.tables, `${what}: the same CHECKSUM TABLE`, "changed");
  assert(before.schemas === after.schemas, `${what}: the same schema list`, after.schemas.replaceAll("\n", ","));
}

function httpRequest(site, method, urlPath, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: site.ip, port: 80, path: urlPath, method, headers: { Host: site.host }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.length < 64 && chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on("error", reject);
    req.end();
  });
}
async function assertTitle(site, title, what) {
  const r = await httpRequest(site, "GET", "/");
  assert(r.status === 200 && r.body.includes(`<title>${title}`), `${what}: GET / 200 with <title>${title}`, `${String(r.status)} ${/<title>[^<]*/.exec(r.body)?.[0] ?? "no title"}`);
}
const looksLikeWordpress = (body) => /wp-content|wp-includes|wp-admin|WordPress/i.test(body);

/** Ten rounds over three paths, 200 ms apart: never a 200, never a WordPress page; returns the statuses seen. */
async function gateProbe(site) {
  const seen = {};
  const bad = [];
  for (let i = 0; i < 10; i++) {
    for (const p of ["/", "/wp-admin/install.php", "/wp-login.php"]) {
      let st;
      try {
        const r = await httpRequest(site, "GET", p, { timeoutMs: 10_000 });
        st = String(r.status);
        if (r.status === 200 || looksLikeWordpress(r.body)) bad.push(`${p} ${st}`);
      } catch (err) {
        st = `error ${formatErr(err)}`;
      }
      seen[st] = (seen[st] ?? 0) + 1;
    }
    await sleep(200);
  }
  return { seen, bad };
}

/** Minimal zip writer: stored entries, Unix attributes, zip64 trailer past 65,535 entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const n = entries.length;
  const trailer = [];
  if (n > 0xffff) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(n), 24); z.writeBigUInt64LE(BigInt(n), 32); z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(offset + cd.length), 8); loc.writeUInt32LE(1, 16);
    trailer.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(n, 0xffff), 8); end.writeUInt16LE(Math.min(n, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, ...trailer, end]);
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const n of tracked.containers) await docker(["rm", "-f", "-v", n]);
  for (const n of tracked.networks) await docker(["network", "rm", n]);
  for (const n of tracked.volumes) await docker(["volume", "rm", "-f", n]);
  if (tmp) await rm(tmp, { recursive: true, force: true });
}

async function createDbNetwork() {
  tracked.networks.add(dbNet);
  for (let i = 0; i < 8; i++) {
    const subnet = `10.${String(200 + Math.floor(Math.random() * 50))}.${String(Math.floor(Math.random() * 256))}.0/24`;
    const r = await docker(["network", "create", "--driver", "bridge", "--subnet", subnet, dbNet]);
    if (r.ok) return subnet;
  }
  throw new Error("no free /24 for the database network");
}

async function startDatabase() {
  const subnet = await createDbNetwork();
  const dataDir = path.join(tmp, "db-data");
  const keyFile = path.join(tmp, "root.key");
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(keyFile, ROOT_PW, { mode: 0o400 });
  const p = buildSharedDatabaseContainerPayload({ image: DB_IMAGE, user: uidGid, dataDirHostPath: dataDir, rootKeyHostPath: keyFile, adminSubnet: subnet });
  const payload = {
    ...p,
    HostConfig: { ...p.HostConfig, NetworkMode: dbNet, RestartPolicy: { Name: "no" } },
    NetworkingConfig: { EndpointsConfig: { [dbNet]: { Aliases: ["hp-mariadb"] } } },
  };
  assert(!("PortBindings" in payload.HostConfig), "no published port on the database", "PortBindings");
  tracked.containers.add(dbContainer);
  const c = await adapter.dockerClient.request("POST", `/containers/create?name=${dbContainer}`, payload);
  assert(c.statusCode === 201, "database container created", `${String(c.statusCode)} ${c.body.toString("utf8").slice(0, 200)}`);
  const s = await adapter.dockerClient.request("POST", `/containers/${dbContainer}/start`);
  assert(s.statusCode === 204, "database container started", s.statusCode);
  const cnf = await docker(["exec", dbContainer, "sh", "-c", `umask 077; printf '[client]\\nuser=root\\npassword=%s\\n' "$(cat /run/secrets/mariadb-root)" > /tmp/root.cnf`]);
  assert(cnf.ok, "root cnf written inside the database container", cnf.stderr);
  for (let i = 0; ; i++) {
    if ((await docker(["exec", dbContainer, "mariadb", "--defaults-extra-file=/tmp/root.cnf", "-e", "SELECT 1"])).ok) break;
    assert(i < 90, "database ready within 90 s", "not ready");
    await sleep(1000);
  }
  versions.mariadb = await sql("SELECT VERSION()");
}

/** A site the product's way: deployService, db.provision, wordpress.install; the database joins its network. */
async function makeSiteTheProductWay(site) {
  tracked.containers.add(site.container);
  tracked.networks.add(site.edge).add(site.net);
  tracked.volumes.add(site.volume);
  const deployed = await adapter.deployService(createApprovedServiceSpec({
    serviceInstanceId: site.svc, siteId: site.id, organizationId: "org_swarmtest", image: SITE_IMAGE, containerName: site.container,
    env: {}, resourceLimits: { cpuMilli: 1000, memoryBytes: "536870912" }, exposeHttp: true, internalPort: 80,
    volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }], siteMail: true,
  }));
  assert(deployed.status === "succeeded", `deployService ${site.tag} succeeded`, JSON.stringify(deployed));
  const dbIns = JSON.parse((await docker(["container", "inspect", dbContainer])).stdout)[0];
  const aliases = dbIns.NetworkSettings.Networks[site.net]?.Aliases ?? [];
  assert(aliases.includes("hp-mariadb"), "deployService put the database on the site network as hp-mariadb", JSON.stringify(aliases));
  const ins = JSON.parse((await docker(["container", "inspect", site.container])).stdout)[0];
  site.ip = ins.NetworkSettings.Networks[site.edge]?.IPAddress ?? "";
  assert(site.ip !== "", "site has an address on its edge network", "none");
  jobOk(await job(site, "db.provision", { dbName: site.dbName, dbUser: site.dbName }, { HP_DB_PASSWORD: site.dbPw }), "db.provision");
  await install(site);
}
const install = async (site) =>
  jobOk(await job(site, "wordpress.install", { dbName: site.dbName, dbUser: site.dbName, siteUrl: site.url, title: site.title,
    adminUser: "admin", adminEmail: "admin@example.test" }, { HP_DB_PASSWORD: site.dbPw, HP_ADMIN_PASSWORD: site.adminPw }), "wordpress.install");

async function removeSite(site) {
  for (const n of [siteFilesHelperName(site.svc), site.container]) await docker(["rm", "-f", "-v", n]);
  await docker(["network", "disconnect", "-f", site.net, dbContainer]);
  for (const n of [site.edge, site.net]) await docker(["network", "rm", n]);
  await docker(["volume", "rm", "-f", site.volume]);
}

// The export: the source tree under one top folder, a top-level __MACOSX and four planted entries.
const BUILD_ZIP_PHP = String.raw`chdir('/var/www/html');
$z = new ZipArchive;
if ($z->open('/tmp/e.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) exit(2);
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('.', FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
foreach ($it as $f) {
  $rel = substr($f->getPathname(), 2);
  if ($rel === 'wp-config.php' || $rel === 'wp-content/mu-plugins' || str_starts_with($rel, 'wp-content/mu-plugins/') || $f->isLink()) continue;
  if ($f->isDir()) $z->addEmptyDir("site/$rel"); else $z->addFile($f->getPathname(), "site/$rel");
}
$cfg = preg_replace('/^<\?php/', "<?php @file_put_contents(__DIR__ . '/hp-marker-wp-config', '1');", file_get_contents('wp-config.php'), 1);
$z->addFromString('site/wp-config.php', $cfg);
$z->addFromString('site/wp-content/object-cache.php', "<?php @file_put_contents(ABSPATH . 'hp-marker-object-cache', '1'); http_response_code(500); exit('broken object cache');\n");
$z->addEmptyDir('site/wp-content/mu-plugins');
$z->addFromString('site/wp-content/mu-plugins/mark.php', "<?php @file_put_contents(ABSPATH . 'hp-marker-mu-plugin', '1');\n");
$z->addFromString('site/wp-content/uploads/.htaccess', "# nested .htaccess of the export\nOptions -Indexes\n");
$z->addFromString('__MACOSX/site/._wp-load.php', "\x00\x05\x16\x07 resource fork");
$n = $z->numFiles;
if (!$z->close()) exit(3);
fwrite(STDERR, "$n\n");`;

// The half-done switch of R154, built by hand: saved files, gate, plan, then only the first HP_K moves.
const HALF_SWITCH_PHP = String.raw`chdir('/var/www/html');
$w = '.htpanel-import/' . getenv('HP_ID'); $site = "$w/site"; $aside = "$w/aside";
foreach (array(array('wp-config.php', 'wp-config.live'), array('.htaccess', 'htaccess.live')) as [$live, $saved]) {
  copy($live, "$w/$saved") || exit(2); chmod("$w/$saved", fileperms($live) & 0777);
}
file_put_contents('.htaccess', file_get_contents("$w/htaccess.live") . getenv('HP_G1')) || exit(2);
file_put_contents('wp-config.php', getenv('HP_G2') . file_get_contents("$w/wp-config.live")) || exit(2);
@mkdir($aside); @mkdir("$aside/wp-content");
$skip = array('.htpanel-import', '.htaccess', 'wp-config.php', 'wp-content', '.maintenance', 'wp-content/mu-plugins');
$ok = fn($r) => !in_array($r, $skip, true) && !str_starts_with(basename($r), '.hp_rs_') && !str_starts_with(basename($r), '.htpanel-');
$plan = array();
foreach (array(array('O', '.'), array('I', $site)) as [$k, $b])
  foreach (array('', 'wp-content/') as $d)
    foreach (array_diff(scandir($d === '' ? $b : "$b/wp-content"), array('.', '..')) as $n)
      if ($ok($d . $n)) $plan[] = array($k, $d . $n);
file_put_contents("$w/plan", implode('', array_map(fn($e) => json_encode($e, JSON_UNESCAPED_SLASHES) . "\n", $plan))) || exit(2);
$outs = count(array_filter($plan, fn($e) => $e[0] === 'O'));
$k = getenv('HP_K') === 'all' ? count($plan) : $outs + intdiv(count($plan) - $outs, 2);
foreach (array_slice($plan, 0, $k) as [$t, $r]) rename($t === 'O' ? $r : "$site/$r", $t === 'O' ? "$aside/$r" : $r) || exit(3);
echo json_encode(array('plan' => count($plan), 'outs' => $outs, 'done' => $k));`;

async function main() {
  const t0 = performance.now();
  for (const img of [CLI_IMAGE, SITE_IMAGE, DB_IMAGE]) {
    assert((await docker(["image", "inspect", img])).ok, `image ${img} on this machine (nothing is pulled)`, "missing");
  }
  volumesBefore = new Set((await docker(["volume", "ls", "-q"])).stdout.split("\n").filter(Boolean));
  disk.start = sampleDisk();
  const sampler = setInterval(sampleDisk, 1000);
  sampler.unref();
  Object.assign(versions, { engine: (await docker(["version", "--format", "{{.Server.Version}}"])).stdout.trim(), cliImage: CLI_IMAGE, siteImage: SITE_IMAGE, dbImage: DB_IMAGE });
  tmp = await mkdtemp(path.join(os.tmpdir(), `${base}_`));
  await chmod(tmp, 0o755);
  const filesDir = path.join(tmp, "site-files");
  await ensureSiteFilesProgram(filesDir);
  adapter = instrument(new DockerEngineSocketAdapter({
    dockerSocketPath: "/var/run/docker.sock",
    secretsRootDir: path.join(tmp, "secrets"),
    siteMailDir: path.join(tmp, "mail"),
    ingressRootDir: path.join(tmp, "ingress"),
    siteFilesDir: filesDir,
    filesHelperIdleMs: 120_000,
    pullMissingImages: false,
    sharedDbContainerName: `${base}_shared_db_unused`,
    sharedDbNetworkName: `${base}_shared_net_unused`,
    sharedDbDataDir: path.join(tmp, "shared-db-unused"),
    sharedDbRootKeyFile: path.join(tmp, "root.key"),
  }));
  await startDatabase();

  const st = {};
  const ok1 = await step("source-site-and-its-export", async () => {
    await makeSiteTheProductWay(src);
    // Prefix old_: the first install's wp_ tables go, the second install makes old_ ones.
    await wp(src, "wp db clean --yes && wp config set table_prefix old_ --type=variable");
    await install(src);
    await wp(src, `wp post create --post_title='Old post' --post_status=publish --post_content='Read ${OLD_URL}/about/ first.' --porcelain >/dev/null && ` +
      `wp option add hp_test_serial '{"url":"${OLD_URL}/x","n":1}' --format=json && ` +
      `wp post create --post_title='Address sample' --post_status=publish --post_content='${addrSample(OLD_URL)}' --porcelain >/dev/null && ` +
      `wp user update 1 --user_url=${OLD_URL} >/dev/null`);
    await sql(`CREATE TABLE \`${src.dbName}\`.${qi(ODD)} (id INT PRIMARY KEY, v VARCHAR(64)) ENGINE=InnoDB; INSERT INTO \`${src.dbName}\`.${qi(ODD)} VALUES (1, 'plain'), (2, '${OLD_URL}/odd')`);
    const r = await docker(["exec", dbContainer, "mariadb-dump", "--defaults-extra-file=/tmp/root.cnf", "--single-transaction", "--default-character-set=utf8mb4", src.dbName]);
    assert(r.ok && r.stdout.includes("CREATE TABLE `old_options`") && r.stdout.includes(`${OLD_URL}`), "mariadb-dump of old_ tables with the old address", r.stderr);
    st.dump = Buffer.from(r.stdout, "utf8");
    const name = `${base}_h${String(++helperSeq)}`;
    tracked.containers.add(name);
    const z = await docker(["run", "--rm", "--name", name, "--network", "none", "--user", "33:33", "-v", `${src.volume}:/var/www/html:ro`,
      "-e", `HP_PHP=${BUILD_ZIP_PHP}`, "--entrypoint", "sh", CLI_IMAGE, "-c", 'php -r "$HP_PHP" && base64 -w0 /tmp/e.zip'], { timeoutMs: 300_000 });
    assert(z.ok, "the export zip is built", z.stderr.slice(0, 300));
    st.zip = Buffer.from(z.stdout, "base64");
    st.zipEntries = Number(z.stderr.trim().split("\n").at(-1));
    st.srcConfig = await helper(src, { script: "cat wp-config.php" });
    // The source goes now: the rest of the run needs only its export (and less disk).
    await removeSite(src);
    return [`old_ site at ${OLD_URL}; dump ${String(st.dump.length)} bytes; zip ${String(st.zip.length)} bytes, ${String(st.zipEntries)} entries (one top folder, __MACOSX, foreign wp-config.php, object-cache.php, mu-plugins/mark.php, nested uploads/.htaccess)`];
  });
  if (!ok1) return true;

  const ok2 = await step("staging-is-never-served", async () => {
    await makeSiteTheProductWay(tgt);
    await wp(tgt, "wp post create --post_title='Target post' --post_status=publish --porcelain >/dev/null");
    await assertTitle(tgt, "Test site", "fresh target");
    st.mailBefore = await docker(["exec", tgt.container, "sha256sum", "/var/www/html/wp-content/mu-plugins/hp-mail.php"]);
    assert(st.mailBefore.ok, "the site mail plug-in is mounted", st.mailBefore.stderr);
    const statuses = [];
    const probe = async (paths, label) => {
      for (const p of paths) {
        const r = await httpRequest(tgt, "GET", p);
        statuses.push(`${label} ${p} ${String(r.status)}`);
        assert(r.status === 403, `${label}: GET ${p} answers 403`, `${String(r.status)} ${r.body.slice(0, 80)}`);
      }
    };
    const hostile = "Options +Indexes\n<FilesMatch \".*\">\nRequire all granted\n</FilesMatch>\nRewriteEngine On\nRewriteRule ^peek$ .htpanel-import/archive [L]\n";
    st.archiveUpload = await putSlot(tgt, "archive", st.zip);
    await putSlot(tgt, "dump", st.dump, {
      chunk: Math.min(CHUNK, Math.ceil(st.dump.length / 3)),
      onPartial: async (uploadId) => {
        const part = `/.htpanel-import/.htpanel-upload-${uploadId}.part`;
        const paths = ["/.htpanel-import/archive", "/.htpanel-import/.htaccess", part, "/.htpanel-import/"];
        await probe(paths, "plain");
        await helper(tgt, { env: { HP_X: hostile }, script: 'mv .htaccess .htaccess.hpsave && printf "%s" "$HP_X" > .htaccess' });
        try {
          await probe([...paths, "/peek"], "hostile");
        } finally {
          await helper(tgt, { script: "mv -f .htaccess.hpsave .htaccess" });
        }
      },
    });
    await probe(["/.htpanel-import/dump"], "plain");
    await helper(tgt, { env: { HP_X: hostile }, script: 'mv .htaccess .htaccess.hpsave && printf "%s" "$HP_X" > .htaccess' });
    try {
      await probe(["/.htpanel-import/dump", "/.htpanel-import/archive"], "hostile");
    } finally {
      await helper(tgt, { script: "mv -f .htaccess.hpsave .htaccess" });
    }
    const s = await files(tgt, "import.stat");
    assert(s.archive.state === "complete" && s.archive.size === st.zip.length && s.dump.state === "complete" && s.dump.size === st.dump.length && s.remains === false,
      "import.stat: both slots complete with their sizes, remains false", JSON.stringify(s));
    // import.take: a site file fills the dump slot; a path outside the site is refused.
    await helper(tgt, { script: "cp .htpanel-import/dump wp-content/hp-take.sql" });
    const t = await files(tgt, "import.take", { slot: "dump", path: "wp-content/hp-take.sql" });
    assert(t.size === st.dump.length, "import.take answers the file size", JSON.stringify(t));
    const after = await helper(tgt, { script: "[ -e wp-content/hp-take.sql ] && echo still || echo gone; sha256sum < .htpanel-import/dump" });
    assert(after.startsWith("gone") && after.includes(sha(st.dump)), "the site file moved into the dump slot", after);
    const out = await refusal(files(tgt, "import.take", { slot: "dump", path: "../../../etc/hostname" }));
    assert(!out.ok, "import.take of a path outside the site is refused", JSON.stringify(out.res));
    await helper(tgt, { script: "ln -s /etc/hostname wp-content/hp-link.sql" });
    const viaLink = await refusal(files(tgt, "import.take", { slot: "dump", path: "wp-content/hp-link.sql" }));
    await helper(tgt, { script: "rm -f wp-content/hp-link.sql" });
    assert(!viaLink.ok, "import.take of a link to outside the site is refused", JSON.stringify(viaLink.res));
    const s2 = await files(tgt, "import.stat");
    assert(s2.dump.state === "complete" && s2.dump.size === st.dump.length, "the refused takes left the dump slot alone", JSON.stringify(s2.dump));
    return [`${String(statuses.length)} requests to staged paths, all 403 (archive, dump, staging .htaccess, the folder, a half-written part; again with a hostile root .htaccess and a rewrite to the archive)`,
      `import.stat complete/complete remains:false; import.take moved a site file in (${String(t.size)} bytes); refused: outside path ${out.code}/${out.reason}, link ${viaLink.code}/${viaLink.reason}`];
  });
  if (!ok2) return true;

  const run = { id: newId(), pw: hex64(), gate: [] };
  importPws.push(run.pw);
  const ok3 = await step("import-in-the-ruled-order", async () => {
    const u = await files(tgt, "import.unpack", { importId: run.id });
    run.unpack = u;
    for (const rel of ["wp-config.php", ".htaccess", "wp-content/mu-plugins", "wp-content/object-cache.php"]) {
      assert(u.leftOut.includes(rel), `unpack leftOut names ${rel}`, JSON.stringify(u.leftOut));
    }
    jobOk(await job(tgt, "db.import", { step: "prepare", importId: run.id }, { HP_IMPORT_DB_PASSWORD: run.pw }), "db.import prepare");
    const l = await job(tgt, "db.import-load", { importId: run.id }, { HP_IMPORT_DB_PASSWORD: run.pw });
    jobOk(l, "db.import-load");
    assert(WordpressImportLoadResultSchema.safeParse(l.result).success && l.result.prefix === "old_" && l.result.oldUrl === OLD_URL,
      "load answer passes WordpressImportLoadResultSchema with prefix old_ and the old address", JSON.stringify(l.result));
    const sw = await files(tgt, "import.switch", { importId: run.id });
    run.gate.push(["after import.switch", await gateProbe(tgt)]);
    jobOk(await job(tgt, "db.import", { step: "switch", importId: run.id }), "db.import switch");
    run.gate.push(["after db.import switch", await gateProbe(tgt)]);
    jobOk(await job(tgt, "wordpress.import-finalize", { tablePrefix: l.result.prefix, siteUrl: NEW_URL, previousUrl: l.result.oldUrl }), "wordpress.import-finalize");
    run.gate.push(["after finalize, before import.finish", await gateProbe(tgt)]);
    await files(tgt, "import.finish", { importId: run.id });
    jobOk(await job(tgt, "db.import", { step: "finish", importId: run.id }), "db.import finish");
    const t1 = performance.now();
    const seen = [];
    for (;;) {
      const r = await httpRequest(tgt, "GET", "/", { timeoutMs: 10_000 }).catch((err) => ({ status: formatErr(err), body: "" }));
      const at = performance.now() - t1;
      if (r.status === 200) {
        run.up = { ms: at, seen };
        break;
      }
      seen.push(`${String(r.status)}@${(at / 1000).toFixed(1)}s`);
      assert(at < 10_000, "GET / answers 200 within 10 s of the finish", seen.join(","));
      await sleep(250);
    }
    return [`unpack ${String(u.entries)} entries, leftOut ${u.leftOut.join(",")}; load ${JSON.stringify(l.result)}; switch moved ${String(sw.moved)}`,
      `GET / 200 after ${(run.up.ms / 1000).toFixed(2)} s${seen.length ? ` (before: ${seen.join(",")})` : ""}`];
  });

  await step("gate-holds-through-the-switch", () => {
    assert(run.gate.length === 3, "three probe points reached", `${String(run.gate.length)} reached`);
    const bad = run.gate.flatMap(([at, g]) => g.bad.map((b) => `${at}: ${b}`));
    assert(bad.length === 0, "never a 200, never a WordPress page", bad.slice(0, 5).join("; "));
    const late503 = run.up.seen.filter((s) => s.startsWith("503"));
    const tooLong = run.up.seen.some((s) => !s.startsWith("503") || Number(s.split("@")[1].slice(0, -1)) > 2);
    assert(!tooLong, "after the finish at most 2 s of 503 before the 200", run.up.seen.join(","));
    return [...run.gate.map(([at, g]) => `${at}: ${Object.entries(g.seen).map(([s, n]) => `${String(n)}x ${s}`).join(", ")} (30 requests)`),
      `after import.finish: ${String(late503.length)} answers 503 before the 200`];
  });
  if (!ok3) return true;

  await step("imported-site-answers-with-its-title", async () => {
    await assertTitle(tgt, "Imported Title", "imported site");
    let addrProblem = null;
    const dry = (from, mode = "") => wp(tgt, `wp search-replace '${from}' 'x.invalid' ${mode}--dry-run --all-tables-with-prefix --skip-columns=guid --skip-plugins --skip-themes --report-changed-only --format=table 2>&1 | grep -v '^+'`);
    const hits = await dry(OLD_PATTERN, "--regex ");
    if (!/Success: 0 replacements/.test(hits)) {
      const at = (col) => `SUBSTRING(${col}, GREATEST(1, LOCATE('${OLD_URL}', ${col}) - 24), 64)`;
      const where = await sql(`SELECT CONCAT('post ', ID, ' ', post_type, ' [', ${at("post_content")}, ']') FROM \`${tgt.dbName}\`.old_posts WHERE post_content LIKE '%${OLD_URL}%' ` +
        `UNION ALL SELECT CONCAT('user ', ID, ' user_url [', user_url, ']') FROM \`${tgt.dbName}\`.old_users WHERE user_url LIKE '%${OLD_URL}%'`);
      addrProblem = new StepAssertionError(`search-replace --regex dry run with the product's boundary finds nothing of ${OLD_URL} outside guid`, `${hits.replace(/\s+/g, " ")} At: ${where.replaceAll("\n", " | ")}`);
    }
    const bare = (await dry(OLD_URL.slice(7))).replace(/\s+/g, " ");
    const userUrl = await sql(`SELECT user_url FROM \`${tgt.dbName}\`.old_users WHERE ID=1`);
    const sample = await sql(`SELECT post_content FROM \`${tgt.dbName}\`.old_posts WHERE post_title='Address sample'`);
    assert(userUrl === NEW_URL && sample === addrSample(NEW_URL), "user_url and the sentence ending with the address hold the new one; ${OLD_URL}.example/x is unchanged",
      `${userUrl} | ${sample}`);
    const odd = await sql(`SELECT GROUP_CONCAT(v ORDER BY id SEPARATOR ' ') FROM \`${tgt.dbName}\`.${qi(ODD)}`);
    assert(odd === ODD_AFTER, "the table named with a backtick, ; and space came through the switch, its old address rewritten", odd);
    const opt = JSON.parse(await wp(tgt, "wp eval --skip-plugins --skip-themes 'echo json_encode(get_option(\"hp_test_serial\"));'"));
    const raw = await sql(`SELECT option_value FROM \`${tgt.dbName}\`.old_options WHERE option_name='hp_test_serial'`);
    assert(opt?.url === `${NEW_URL}/x` && raw.startsWith("a:2:{"), "the serialized option unserializes to an array with the new address", `${JSON.stringify(opt)} ${raw}`);
    const cfg = await helper(tgt, { script: "cat wp-config.php" });
    const foreign = [/define\(\s*'DB_NAME',\s*'([^']+)'/, /define\(\s*'DB_USER',\s*'([^']+)'/, /define\(\s*'DB_PASSWORD',\s*'([^']+)'/].map((re) => re.exec(st.srcConfig)?.[1]);
    assert(cfg.startsWith("<?php") && !cfg.includes(GATE_MARK) && cfg.includes("HP_MANAGED"), "wp-config.php starts with <?php, no gate, HP_MANAGED", cfg.slice(0, 60).replace(/\s+/g, " "));
    assert(cfg.includes(`'${tgt.dbName}'`) && cfg.includes(tgt.dbPw), "wp-config.php holds the panel's database name and password", "missing");
    assert(foreign.every((f) => f && !cfg.includes(f)) && !cfg.includes("hp-marker"), "none of the export's credentials or marker in wp-config.php", "found");
    const look = await helper(tgt, { user: "0:0", script:
      "find . -name 'hp-marker-*'; [ -e wp-content/object-cache.php ] && echo has-object-cache; [ -e wp-content/mu-plugins/mark.php ] && echo has-mu-mark; " +
      "find . -name '*.hpimport' -o -name '.htpanel-import' | sed 's/^/left /'; find . -path ./wp-content/mu-plugins -prune -o ! -uid 33 -print | sed 's/^/owner /'; true" });
    assert(look === "", "no marker, no object-cache.php, no foreign mu-plugin, no .hpimport, no staging, every file uid 33", look.split("\n").slice(0, 5).join("; "));
    const hta = await helper(tgt, { script: "cat wp-content/uploads/.htaccess; echo ===; cat .htaccess" });
    assert(hta.startsWith("# nested .htaccess of the export"), "the nested .htaccess is back under its own name", hta.slice(0, 60));
    assert(/^# BEGIN hosting-panel/m.test(hta.split("===")[1]) && !hta.includes(GATE_MARK), "root .htaccess has the panel block and no gate", "missing");
    const left = await importLeftovers();
    assert(left === "", "no hp_is_/hp_ia_/hp_im_ schema and no hp_iu_ account", left);
    const mail = await docker(["exec", tgt.container, "sha256sum", "/var/www/html/wp-content/mu-plugins/hp-mail.php"]);
    assert(mail.ok && mail.stdout === st.mailBefore.stdout, "the site mail plug-in is mounted and unchanged", mail.stderr || mail.stdout);
    if (addrProblem) throw new StepAssertionError(`every other check of this step passed; ${addrProblem.message.split(" / ")[0]}`, addrProblem.message.split(" / ").slice(1).join(" / "));
    return [`200 with <title>Imported Title; regex dry run with the product's boundary: 0 of ${OLD_URL} outside guid; user_url ${userUrl}; "${sample}"; serialized option holds the new address; ${ODD} row read back`,
      `the bare host old.example.test outside guid (not an address; the rewrite needs scheme+host+delimiter): ${bare.slice(0, 400)}`,
      "wp-config.php: panel credentials, HP_MANAGED, no gate, none foreign; no markers; nested .htaccess back; uid 33; panel block; no staging, schema or account left; mail unchanged"];
  });

  await step("address-job-still-works", async () => {
    const db = `\`${tgt.dbName}\``;
    await sql(`UPDATE ${db}.old_users SET user_url='${OLD_URL}' WHERE ID=1; UPDATE ${db}.old_posts SET post_content='${addrSample(OLD_URL)}' WHERE post_title='Address sample'`);
    jobOk(await job(tgt, "wordpress.set-url", { siteUrl: NEW_URL, previousUrl: OLD_URL }), "wordpress.set-url");
    const userUrl = await sql(`SELECT user_url FROM ${db}.old_users WHERE ID=1`);
    const sample = await sql(`SELECT post_content FROM ${db}.old_posts WHERE post_title='Address sample'`);
    assert(userUrl === NEW_URL && sample === addrSample(NEW_URL), "set-url: user_url and the sentence ending with the address hold the new one; ${OLD_URL}.example/x is unchanged",
      `${userUrl} | ${sample}`);
    await assertTitle(tgt, "Imported Title", "after set-url");
    // R165.3: a second run with the same addresses finds nothing to write.
    const sums = await tableSums(tgt);
    jobOk(await job(tgt, "wordpress.set-url", { siteUrl: NEW_URL, previousUrl: OLD_URL }), "wordpress.set-url again");
    const sums2 = await tableSums(tgt);
    assert(sums2 === sums, "a second wordpress.set-url with the same addresses changes no table", `${sums} -> ${sums2}`);
    return [`wordpress.set-url exit 0 on the imported old_ tables, GET / 200; user_url ${userUrl}; "${sample}"`, `second run exit 0, table sums unchanged (${sums.slice(0, 12)})`];
  });

  // A foreign-key pair in the live schema, read back after every undo.
  await sql(`CREATE TABLE \`${tgt.dbName}\`.old_hp_parent (id INT PRIMARY KEY) ENGINE=InnoDB; ` +
    `CREATE TABLE \`${tgt.dbName}\`.old_hp_child (id INT PRIMARY KEY, parent INT, FOREIGN KEY (parent) REFERENCES old_hp_parent (id)) ENGINE=InnoDB; ` +
    `INSERT INTO \`${tgt.dbName}\`.old_hp_parent VALUES (1); INSERT INTO \`${tgt.dbName}\`.old_hp_child VALUES (1, 1)`);

  await step("refused-exports-change-nothing", async () => {
    const d = st.dump.toString("utf8");
    const at = (needle) => {
      const i = d.indexOf(needle);
      assert(i > 0, `the dump holds ${needle}`, "missing");
      return i;
    };
    const ins = at("INSERT INTO `old_options`");
    const unlock = d.indexOf("UNLOCK TABLES;\n", ins) + "UNLOCK TABLES;\n".length;
    const trailer = at("-- Dump completed");
    const before = d.slice(0, trailer);
    const definerLine = before.split("\n").length;
    const withTail = (sqlText) => Buffer.from(`${before}${sqlText}\n${d.slice(trailer)}`, "utf8");
    const cases = [
      ["cut mid-statement", Buffer.from(d.slice(0, ins + 60), "utf8"), 60],
      ["cut at a statement boundary", Buffer.from(d.slice(0, unlock), "utf8"), 53],
      ["cut gzip", zlib.gzipSync(st.dump).subarray(0, 4000), 51],
      ["two databases (prefixes old_ and two_)", Buffer.from(d + d.replaceAll("`old_", "`two_"), "utf8"), 55],
      ["USE of another schema", Buffer.from(`USE \`mysql\`;\n${d}`, "utf8"), 61],
      ["GRANT", withTail("GRANT ALL PRIVILEGES ON *.* TO 'hp_other'@'%';"), 61],
      ["DEFINER view", withTail("CREATE DEFINER=`root`@`localhost` VIEW `old_hp_view` AS SELECT 1 AS x;"), 61, definerLine],
      ["DATA DIRECTORY", withTail("CREATE TABLE `old_hp_dd` (id INT) ENGINE=InnoDB DATA DIRECTORY='/tmp';"), 57],
      ["wp_blogs (old_blogs)", withTail("CREATE TABLE `old_blogs` (blog_id INT) ENGINE=InnoDB;"), 56],
      ["symlinked slot", st.dump, 50, undefined, true],
    ];
    const problems = [];
    const notes = [];
    for (const [name, bytes, want, line, link] of cases) {
      const b = await state(tgt);
      const id = newId();
      const pw = hex64();
      importPws.push(pw);
      await putSlot(tgt, "dump", bytes);
      if (link) await helper(tgt, { script: "rm -f .htpanel-import/dump && ln -s ../wp-config.php .htpanel-import/dump" });
      jobOk(await job(tgt, "db.import", { step: "prepare", importId: id }, { HP_IMPORT_DB_PASSWORD: pw }), `${name}: prepare`);
      const r = await job(tgt, "db.import-load", { importId: id }, { HP_IMPORT_DB_PASSWORD: pw });
      const res = loadResult(r);
      let note = `${name}: exit ${String(r.exitCode)}${res ? ` ${JSON.stringify(res)}` : ""}`;
      if (r.exitCode !== want) problems.push(`${name}: exit ${String(want)} / ${String(r.exitCode)} ${(r.outputTail ?? "").slice(-160)}`);
      if ((want === 60 || want === 61) && !(res && "line" in res && res.line > 0 && typeof res.errorNumber === "number")) {
        problems.push(`${name}: a {line, errorNumber} answer / ${JSON.stringify(res)}`);
      }
      if (line !== undefined && res?.line !== line) note += ` (statement on line ${String(line)})`;
      const u1 = await job(tgt, "db.import", { step: "undo", importId: id });
      const u2 = await files(tgt, "import.undo", { importId: id });
      if (u1.exitCode !== 0 || u2.complete !== true) problems.push(`${name}: undo pair 0/{complete:true} / ${String(u1.exitCode)}/${JSON.stringify(u2)}`);
      try {
        sameState(b, await state(tgt), name);
        await assertTitle(tgt, "Imported Title", name);
      } catch (err) {
        problems.push(formatErr(err));
      }
      notes.push(note);
    }
    const left = await importLeftovers();
    if (left !== "") problems.push(`left after the refusals: ${left}`);
    assert(problems.length === 0, "each refusal with its exit code, the site unchanged", problems.join("; "));
    return ["target: the imported site at http://wp-a.example.test (old_ tables, after set-url); after each case files, CHECKSUM TABLE, schema list equal and GET / 200 with its title", ...notes];
  });

  await step("refused-archives-change-nothing", async () => {
    const b = await state(tgt);
    const problems = [];
    const notes = [];
    const notZip = await refusal(files(tgt, "import.put", { slot: "archive", uploadId: randomBytes(12).toString("hex"), offset: 0,
      dataBase64: Buffer.from("this is not a zip archive\n").toString("base64"), final: true }));
    if (notZip.ok || notZip.reason !== "not_a_zip") problems.push(`not a zip: not_a_zip / ${JSON.stringify(notZip)}`);
    notes.push(`not a zip: refused at upload ${String(notZip.code)}/${String(notZip.reason)}`);
    const t0 = performance.now();
    const many = makeZip(Array.from({ length: 200_001 }, (_, i) => ({ name: `e/${i.toString(36)}` })));
    const archives = [
      ["no WordPress", makeZip([{ name: "site/readme.txt", data: Buffer.from("hello\n") }]), "archive_not_wordpress"],
      ["a .. entry", makeZip([{ name: "site/../../hp-evil.php", data: Buffer.from("<?php echo 1;\n") }]), "archive_unsafe"],
      ["a symlink entry", makeZip([{ name: "site/hp-link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }]), "archive_unsafe"],
      ["200,001 empty entries", many, "archive_limit"],
    ];
    for (const [name, bytes, want] of archives) {
      const s0 = performance.now();
      await putSlot(tgt, "archive", bytes);
      const u = await refusal(files(tgt, "import.unpack", { importId: newId() }));
      if (u.ok || u.reason !== want) problems.push(`${name}: ${want} / ${JSON.stringify(u)}`);
      notes.push(`${name}: ${String(u.code)}/${String(u.reason)} (${String(bytes.length)} bytes, ${((performance.now() - s0) / 1000).toFixed(1)} s)`);
    }
    notes.push(`200,001 entries: built, uploaded and refused in ${((performance.now() - t0) / 1000).toFixed(1)} s total for the three crafted zips plus it; zip ${(many.length / 1048576).toFixed(1)} MiB`);
    const outside = await helper(tgt, { user: "0:0", script: "find . -path ./.htpanel-import -prune -o \\( -name hp-evil.php -o -name hp-link -o -path ./readme.txt -o -path ./site -o -path ./e \\) -print" });
    if (outside !== "") problems.push(`archive entries outside .htpanel-import: ${outside}`);
    try {
      sameState(b, await state(tgt), "after the refused archives");
      await assertTitle(tgt, "Imported Title", "after the refused archives");
    } catch (err) {
      problems.push(formatErr(err));
    }
    assert(problems.length === 0, "each archive refused with its reason, the site unchanged", problems.join("; "));
    return notes;
  });

  await step("undo-after-the-switch", async () => {
    const b = await state(tgt);
    const id = newId();
    const pw = hex64();
    importPws.push(pw);
    await putSlot(tgt, "archive", st.zip);
    await putSlot(tgt, "dump", st.dump);
    await files(tgt, "import.unpack", { importId: id });
    jobOk(await job(tgt, "db.import", { step: "prepare", importId: id }, { HP_IMPORT_DB_PASSWORD: pw }), "prepare");
    jobOk(await job(tgt, "db.import-load", { importId: id }, { HP_IMPORT_DB_PASSWORD: pw }), "load");
    await files(tgt, "import.switch", { importId: id });
    jobOk(await job(tgt, "db.import", { step: "switch", importId: id }), "db.import switch");
    const home = await sql(`SELECT option_value FROM \`${tgt.dbName}\`.old_options WHERE option_name='home'`);
    assert(home === OLD_URL, "after the switch the live schema holds the export (home = old address)", home);
    await docker(["exec", "-i", dbContainer, "sh", "-c", "umask 077; cat > /tmp/site.cnf"], { input: `[client]\nuser=${tgt.dbName}\npassword=${tgt.dbPw}\nhost=127.0.0.1\nprotocol=tcp\n` });
    const asSite = (q) => docker(["exec", dbContainer, "mariadb", "--defaults-extra-file=/tmp/site.cnf", "-e", q]);
    const trg = `\`${tgt.dbName}\`.hp_swarmtest_m4_trg`;
    const made = await asSite(`CREATE TRIGGER ${trg} BEFORE INSERT ON \`${tgt.dbName}\`.old_posts FOR EACH ROW SET NEW.post_title = NEW.post_title`);
    assert(made.ok, "the site's own account makes a trigger on an imported table", made.stderr.trim());
    const blocked = await job(tgt, "db.import", { step: "undo", importId: id });
    const mark = await sql(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='hp_im_${id}'`);
    const home2 = await sql(`SELECT option_value FROM \`${tgt.dbName}\`.old_options WHERE option_name='home'`);
    assert(blocked.exitCode === 92 && mark === "after" && home2 === OLD_URL, "undo with a trigger in the live schema answers 92 and renames nothing (marker after, live still the export)",
      `${String(blocked.exitCode)} ${mark} ${home2}`);
    const dropped = await asSite(`DROP TRIGGER ${trg}`);
    assert(dropped.ok, "the site's account drops its trigger", dropped.stderr.trim());
    const notes = [`trigger on old_posts by the site account: db.import undo 92, marker after, live home ${home2}; trigger dropped`];
    for (const pass of ["first", "second"]) {
      const u1 = await job(tgt, "db.import", { step: "undo", importId: id });
      const u2 = await files(tgt, "import.undo", { importId: id });
      assert(u1.exitCode === 0 && u2.complete === true, `${pass} undo pair: db.import undo 0 and {complete:true}`, `${String(u1.exitCode)} ${JSON.stringify(u2)}`);
      sameState(b, await state(tgt), `${pass} undo pair`);
      await assertTitle(tgt, "Imported Title", `${pass} undo pair`);
      notes.push(`${pass} pair: exit 0, {complete:true}, files/tables/schemas equal, 200`);
    }
    const odd = await sql(`SELECT GROUP_CONCAT(v ORDER BY id SEPARATOR ' ') FROM \`${tgt.dbName}\`.${qi(ODD)}`);
    assert(odd === ODD_AFTER, "the table named with a backtick, ; and space is back after the undo", odd);
    const rows = await sql(`SELECT (SELECT COUNT(*) FROM \`${tgt.dbName}\`.old_posts WHERE post_title='Old post'), (SELECT COUNT(*) FROM \`${tgt.dbName}\`.old_hp_child)`, "/tmp/site.cnf");
    assert(rows === "1\t1", "the site's account reads its old rows", rows);
    const fk = await docker(["exec", dbContainer, "mariadb", "--defaults-extra-file=/tmp/site.cnf", "-e", `INSERT INTO \`${tgt.dbName}\`.old_hp_child VALUES (2, 99)`]);
    assert(!fk.ok && fk.stderr.includes("1452"), "a foreign-key child insert still fails (1452)", fk.stderr.trim() || "it succeeded");
    const left = await importLeftovers();
    assert(left === "", "no staging or aside schema and no staging account", left);
    return [...notes, `site account reads its rows; FK child insert refused with 1452; ${ODD} row back; no hp_is_/hp_ia_/hp_im_/hp_iu_ left`];
  });

  await step("killed-in-the-middle-of-the-swap", async () => {
    await helper(tgt, { script: "printf 'only on the target\\n' > hp-target-only.txt" });
    const b = await state(tgt);
    const env = (id, k) => ({ HP_ID: id, HP_K: k, HP_G1: GATE_HTACCESS, HP_G2: GATE_CONFIG });
    const id = newId();
    await files(tgt, "import.unpack", { importId: id });
    const half = JSON.parse(await php(tgt, HALF_SWITCH_PHP, { env: env(id, "half") }));
    const gated = await helper(tgt, { script: "grep -c 'hosting-panel import gate' wp-config.php .htaccess" });
    const u = await files(tgt, "import.undo", { importId: id });
    assert(u.complete === true, "import.undo of the half-done swap answers {complete:true}", JSON.stringify(u));
    sameState(b, await state(tgt), "after the repaired swap");
    await assertTitle(tgt, "Imported Title", "after the repaired swap");

    // Unrepairable: a moved-out entry missing on both sides.
    const id2 = newId();
    await files(tgt, "import.unpack", { importId: id2 });
    const all = JSON.parse(await php(tgt, HALF_SWITCH_PHP, { env: env(id2, "all") }));
    const w = `.htpanel-import/${id2}`;
    const sums = `sha256sum wp-config.php .htaccess ${w}/wp-config.live ${w}/htaccess.live ${w}/plan`;
    const kept = await helper(tgt, { script: `rm ${w}/aside/hp-target-only.txt && ${sums}` });
    const u2 = await files(tgt, "import.undo", { importId: id2 });
    const kept2 = await helper(tgt, { script: `${sums}; [ -d ${w} ] && echo folder-kept` });
    assert(u2.complete === false, "import.undo with an entry missing on both sides answers {complete:false}", JSON.stringify(u2));
    assert(kept2 === `${kept}\nfolder-kept`, "gate, saved files and plan unchanged, work folder kept", kept2.slice(-120));
    // Put the missing entry back by hand; the next undo completes and the gate goes.
    await helper(tgt, { script: "printf 'only on the target\\n' > hp-target-only.txt" });
    const u3 = await files(tgt, "import.undo", { importId: id2 });
    assert(u3.complete === true, "after the entry is back, import.undo completes", JSON.stringify(u3));
    await assertTitle(tgt, "Imported Title", "after the second repair");
    await helper(tgt, { script: "rm -f hp-target-only.txt" });
    return [`half-done: plan ${String(half.plan)} entries (${String(half.outs)} out), ${String(half.done)} moves done, gate in ${gated.replaceAll("\n", ",")}; undo {complete:true}, files and tables equal`,
      `unrepairable (plan ${String(all.plan)}, all moved, one moved-out entry deleted from aside): {complete:false}, gate/saved files/plan unchanged, folder kept; repaired by hand then {complete:true}`];
  });

  await step("an-unfinished-import-is-left-alone", async () => {
    const id = newId();
    const w = `.htpanel-import/${id}`;
    await files(tgt, "import.stat");
    await helper(tgt, { script: `mkdir -p ${w}/site ${w}/aside && printf '["O","hp-not-here"]\\n' > ${w}/plan && printf 'x' > ${w}/wp-config.live` });
    const list = () => helper(tgt, { script: `find ${w} -exec stat -c '%n %s %i %Y' {} + | sort` });
    const before = await list();
    const s = await files(tgt, "import.stat");
    assert(s.remains === true, "import.stat answers remains:true", JSON.stringify(s));
    await files(tgt, "import.discard");
    const s2 = await files(tgt, "import.stat");
    assert(s2.archive.state === "empty" && s2.dump.state === "empty" && s2.remains === true, "discard empties both slots, remains stays true", JSON.stringify(s2));
    assert((await list()) === before, "discard leaves the work folder untouched", "changed");
    const again = await refusal(files(tgt, "import.unpack", { importId: id }));
    assert(!again.ok && again.reason === "staging_unsafe", "import.unpack with the same id refused staging_unsafe", JSON.stringify(again));
    await helper(tgt, { script: `rm -rf ${w}` });
    await files(tgt, "import.discard");
    const s3 = await files(tgt, "import.stat");
    assert(s3.remains === false, "after removing the folder by hand, remains false", JSON.stringify(s3));
    return ["remains:true; discard emptied the slots, the folder listing unchanged; unpack refused staging_unsafe",
      "API refusal earlier_import_unfinished: apps/api/test/site-wordpress-import.integration.test.ts \"busy: files_incomplete, and earlier_import_unfinished while the simulator holds a plan (R155)\""];
  });

  await step("no-secret-in-any-tail", () => {
    assert(leakedWindows(`x${ROOT_PW.slice(5, 13)}y`, ROOT_PW) > 0, "self-check: the scan finds a planted window", "missing");
    const problems = [];
    const kinds = new Set();
    for (const j of jobs.values()) {
      const inTail = leaks(j.res?.outputTail ?? "");
      if (inTail.length) problems.push(`${j.kind} ${j.jobId} tail: ${inTail.join(",")}`);
      const inRaw = leaks(`${j.raw?.stdout ?? ""}${j.raw?.stderr ?? ""}`);
      if (inRaw.length) problems.push(`${j.kind} ${j.jobId} raw log: ${inRaw.join(",")}`);
      if (j.inspect) {
        kinds.add(j.kind);
        const c = j.inspect.Config ?? {};
        const inCfg = leaks(JSON.stringify([c.Env, c.Cmd, c.Entrypoint, c.Labels]));
        if (inCfg.length) problems.push(`${j.kind} ${j.jobId} Env/Cmd/labels: ${inCfg.join(",")}`);
      }
    }
    for (const k of ["db.provision", "wordpress.install", "db.import", "db.import-load", "wordpress.import-finalize", "wordpress.set-url"]) {
      if (!kinds.has(k)) problems.push(`no ${k} job inspected while it ran`);
    }
    assert(problems.length === 0, "no 8-character window of any secret in a tail, raw log, Env, Cmd or labels", problems.join("; "));
    return [`${String(jobs.size)} jobs: tails and raw logs scanned for ${String(Object.keys(secretList()).length)} secrets (root, both site DB passwords, both admin passwords, ${String(importPws.length)} staging secrets); ${String(kinds.size)} kinds inspected while running; ${String(dbRewrites)} hp_mariadb requests sent to this run's own database and network; connects answered 404 for ${[...new Set(skippedConnects)].join(",") || "none"}`];
  });

  versions.wordpress = await wp(tgt, "wp core version").catch(() => "?");
  versions.totalS = ((performance.now() - t0) / 1000).toFixed(1);
  clearInterval(sampler);
  return true;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig}: removing what this run created`);
    void cleanup().finally(() => process.exit(130));
  });
}

const started = performance.now();
let reached = false;
try {
  reached = await main();
} catch (err) {
  console.log(`FAIL run: ${formatErr(err)}`);
} finally {
  await cleanup();
}

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
  const fresh = volumesBefore ? after.filter((v) => !volumesBefore.has(v)) : [];
  if (fresh.length) left.push(`new volumes: ${fresh.join(",")}`);
  if (tmp && (await access(tmp).then(() => true, () => false))) left.push(`temporary folder ${tmp}`);
  assert(left.length === 0, "nothing of this run left", left.join("; "));
  return [`${String(tracked.containers.size)} containers, ${String(tracked.networks.size)} networks, ${String(tracked.volumes.size)} volumes removed by name; volume list as before; temporary folder gone`,
    `peak disk use ${((disk.start - disk.min) / 1048576).toFixed(0)} MiB (free space of / sampled every second)`];
});
console.log("Versions:", JSON.stringify(versions));
console.log("Times (s):", JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) =>
  [k, { n: v.length, min: +(Math.min(...v) / 1000).toFixed(2), max: +(Math.max(...v) / 1000).toFixed(2) }]))));
const failed = results.filter((r) => !r.ok);
console.log(`${String(results.length - failed.length)}/${String(results.length)} passed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(reached && failed.length === 0 ? 0 : 1);
