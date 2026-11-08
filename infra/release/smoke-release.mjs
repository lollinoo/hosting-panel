// Extracts a release archive and checks the API and web start from it with node only.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const archive = process.argv[2];
if (!archive) {
  console.error("usage: smoke-release.mjs <archive.tar.gz>");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`smoke: ${msg}`);
  process.exit(1);
};
const [expected, sumName] = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/);
if (sumName !== path.basename(archive)) fail(`.sha256 names ${sumName}, expected ${path.basename(archive)}`);
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (expected !== actual) {
  fail(`sha256 mismatch: expected ${expected}, got ${actual}`);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

async function waitFor200(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const tmp = mkdtempSync(path.join(tmpdir(), "hp-smoke-"));
const children = [];
async function cleanup() {
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r).kill("SIGKILL"))
    )
  );
  rmSync(tmp, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => cleanup().finally(() => process.exit(1)));
}

const archiveName = path.basename(archive);
let ok;
try {
  execFileSync("tar", ["-xzf", path.resolve(archive), "-C", tmp]);
  const entries = readdirSync(tmp);
  const topName = archiveName.replace(/-linux-x64\.tar\.gz$/, "");
  if (entries.length !== 1 || entries[0] !== topName || !/^hosting-panel-[^/]+$/.test(topName)) {
    throw new Error(`archive must contain exactly one top-level dir ${topName}, found: ${entries.join(", ")}`);
  }
  const root = path.join(tmp, topName);
  // Strip the caller's env down so nothing from a dev shell (DATABASE_URL, dev flags) leaks in.
  const baseEnv = { PATH: process.env.PATH, HOME: tmp, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
  const start = (label, args, cwd, env) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...baseEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    children.push(child);
    return child;
  };

  const apiPort = await freePort();
  const api = start("api", ["dist/main.js"], path.join(root, "apps/api"), {
    API_PORT: String(apiPort),
    API_HOST: "127.0.0.1",
    HP_RUNTIME_BACKEND: "disabled"
  });
  const apiOk = await waitFor200(`http://127.0.0.1:${apiPort}/health/live`, api, 30_000);
  console.log(`smoke: api /health/live ${apiOk ? "OK" : "FAILED"}`);

  let webOk = false;
  if (apiOk) {
    const webPort = await freePort();
    const web = start(
      "web",
      ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
      path.join(root, "apps/web"),
      { API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, BFF_SESSION_SECRET: randomBytes(16).toString("hex") }
    );
    webOk = await waitFor200(`http://127.0.0.1:${webPort}/login`, web, 30_000);
    console.log(`smoke: web /login ${webOk ? "OK" : "FAILED"}`);
  }
  ok = apiOk && webOk;
} catch (err) {
  console.error(`smoke: ${err.message}`);
  ok = false;
} finally {
  await cleanup();
}
console.log(ok ? "smoke: PASS" : "smoke: FAIL");
process.exit(ok ? 0 : 1);
