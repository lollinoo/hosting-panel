// Builds a self-contained release archive: node + the extracted tree is all the server needs.
// Mechanism: copy built workspace (package.json + dist, web .next) into a staging dir, then
// `pnpm install --prod --frozen-lockfile --offline` there so node_modules matches the lockfile.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RELEASE_PATHS = [
  "VERSION",
  "RELEASE.json",
  "apps/api/dist/main.js",
  "apps/api/dist/cli/accounts.js",
  "apps/api/dist/cli/break-glass.js",
  "apps/docker-executor/dist/main.js",
  "apps/host-agent/dist/main.js",
  "apps/web/node_modules/next/dist/bin/next",
  "apps/web/.next/BUILD_ID",
  "packages/database/dist/migrations/0001_phase1_docker_native.sql",
  "infra/systemd/hp-api.service",
  "infra/systemd/hp-docker-executor.service",
  "infra/systemd/hp-host-agent.service",
  "infra/systemd/hp-web.service",
  "infra/linux/bootstrap-dedicated.sh",
  "infra/linux/install.sh",
  "infra/linux/update.sh",
  "infra/linux/lib/common.sh",
  "infra/linux/lib/os.sh",
  "infra/linux/lib/release.sh",
  "infra/linux/nftables-dedicated.conf",
  "infra/linux/hp-accounts",
  "infra/linux/hp-break-glass",
  "infra/linux/hp-update"
];

function forbidden(rel) {
  const parts = rel.split("/");
  const name = parts.at(-1);
  if (parts.includes(".git") || parts.includes(".superpowers")) return true;
  if (/(^|\/)node_modules\/\.cache(\/|$)/.test(rel)) return true;
  // Third-party packages legitimately ship .ts sources; only our own tree is checked for them.
  if (parts.includes("node_modules")) return false;
  if (name.endsWith(".test.ts")) return true;
  if (name.endsWith(".ts") && parts.slice(0, -1).includes("src")) return true;
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

/** @param {string} dir @returns {Promise<string[]>} */
export async function listReleaseViolations(dir) {
  const root = path.resolve(dir);
  const out = [];
  for (const p of REQUIRED_RELEASE_PATHS) {
    if (!existsSync(path.join(root, p))) out.push(`missing: ${p}`);
  }
  const reported = new Set();
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isSymbolicLink()) {
      const target = await readlink(abs);
      const inside = path.relative(root, path.resolve(path.dirname(abs), target));
      if (path.isAbsolute(target) || inside.startsWith("..") || path.isAbsolute(inside)) {
        out.push(`symlink: ${rel} -> ${target}`);
      }
    }
    // Report a forbidden directory once, not every file under it.
    if (forbidden(rel) && ![...reported].some((r) => rel.startsWith(`${r}/`))) {
      reported.add(rel);
      out.push(`forbidden: ${rel}`);
    }
  }
  return out;
}

/** Exact running node version for RELEASE.json; its major must match .node-version (installer downloads x.y.z). */
export function releaseNodeVersion(nodeVersionFile, runningVersion) {
  const wanted = nodeVersionFile.trim().replace(/^v/, "").split(".")[0];
  const running = runningVersion.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(running)) throw new Error(`node version ${running} is not x.y.z`);
  if (running.split(".")[0] !== wanted) {
    throw new Error(`building with node ${running} but .node-version requires major ${wanted}`);
  }
  return running;
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(cmd, args, cwd = repo) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const pkgVersion = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version;
  const version = arg("--version") ?? pkgVersion;
  if (version !== pkgVersion) {
    console.error(`--version ${version} differs from package.json version ${pkgVersion}`);
    process.exit(1);
  }
  const node = releaseNodeVersion(readFileSync(path.join(repo, ".node-version"), "utf8"), process.versions.node);
  const outDir = path.resolve(repo, arg("--out") ?? "dist-release");
  const name = `hosting-panel-${version}`;
  const stage = path.join(outDir, name);

  run("corepack", ["pnpm", "run", "build"]);

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const copy = (rel, filter) => cpSync(path.join(repo, rel), path.join(stage, rel), { recursive: true, filter });
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version"]) copy(f);
  for (const group of ["apps", "packages"]) {
    for (const pkg of readdirSync(path.join(repo, group))) {
      const rel = `${group}/${pkg}`;
      if (!existsSync(path.join(repo, rel, "package.json"))) continue;
      copy(`${rel}/package.json`);
      if (existsSync(path.join(repo, rel, "dist"))) copy(`${rel}/dist`);
    }
  }
  copy("apps/web/next.config.mjs");
  copy("apps/web/.next", (src) => !/[/\\]\.next[/\\](cache|dev)([/\\]|$)/.test(src));
  copy("infra/systemd");
  copy("infra/linux", (src) => !src.endsWith(".mjs") && !src.endsWith(".test.ts"));

  run("corepack", ["pnpm", "install", "--prod", "--frozen-lockfile", "--offline", "--ignore-scripts"], stage);
  rmSync(path.join(stage, "node_modules/.cache"), { recursive: true, force: true });

  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  const dirty = git("status", "--porcelain", "--", ".", ":(exclude)dist-release") !== "";
  const gitCommit = `${git("rev-parse", "HEAD")}${dirty ? "-dirty" : ""}`;
  writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
  writeFileSync(
    path.join(stage, "RELEASE.json"),
    `${JSON.stringify({ version, gitCommit, builtAt: new Date().toISOString(), node }, null, 2)}\n`
  );

  const violations = await listReleaseViolations(stage);
  if (violations.length > 0) {
    console.error(`release tree has violations:\n  ${violations.join("\n  ")}`);
    process.exit(1);
  }

  const archive = `${name}-linux-x64.tar.gz`;
  run("tar", ["-czf", archive, "--owner=0", "--group=0", "--numeric-owner", name], outDir);
  const hex = createHash("sha256").update(readFileSync(path.join(outDir, archive))).digest("hex");
  writeFileSync(path.join(outDir, `${archive}.sha256`), `${hex}  ${archive}\n`);
  const mb = (statSync(path.join(outDir, archive)).size / 1024 / 1024).toFixed(1);
  console.log(`release: ${path.join(outDir, archive)} (${mb} MiB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
