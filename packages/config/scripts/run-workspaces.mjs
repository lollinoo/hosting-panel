import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REL_DIR_PATTERN = /^(packages|apps)\/[a-zA-Z0-9._-]+$/;
const SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9:_-]+$/;
const WORKSPACE_ROOT_DIRS = ["packages", "apps"];

function discoverWorkspacePackages(workspaceRoot) {
  const discovered = [];

  for (const groupDir of WORKSPACE_ROOT_DIRS) {
    const absGroupDir = join(workspaceRoot, groupDir);
    if (!existsSync(absGroupDir)) {
      continue;
    }

    const entries = readdirSync(absGroupDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const relDir = posix.join(groupDir, entry.name);
      const manifestPath = join(absGroupDir, entry.name, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const dependencyNames = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);

      discovered.push({
        name: manifest.name ?? relDir,
        relDir,
        scripts: manifest.scripts ?? {},
        dependencyNames,
      });
    }
  }

  return sortPackagesTopologically(discovered);
}

function sortPackagesTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const state = new Map();
  const ordered = [];

  function visit(pkg) {
    const current = state.get(pkg.name);
    if (current === "visited") {
      return;
    }
    if (current === "visiting") {
      throw new Error(`Circular workspace dependency detected involving ${pkg.name}`);
    }

    state.set(pkg.name, "visiting");
    const internalDeps = [...pkg.dependencyNames]
      .filter((depName) => depName !== pkg.name && byName.has(depName))
      .sort((a, b) => a.localeCompare(b));

    for (const depName of internalDeps) {
      visit(byName.get(depName));
    }

    state.set(pkg.name, "visited");
    ordered.push(pkg);
  }

  for (const pkg of packages) {
    visit(pkg);
  }

  return ordered;
}

function main() {
  const scriptName = process.argv[2];
  if (!scriptName || !SCRIPT_NAME_PATTERN.test(scriptName)) {
    console.error("Usage: node packages/config/scripts/run-workspaces.mjs <script-name>");
    process.exit(1);
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(currentDir, "../../..");
  const packages = discoverWorkspacePackages(workspaceRoot);

  for (const pkg of packages) {
    if (typeof pkg.scripts[scriptName] !== "string") {
      continue;
    }

    if (!REL_DIR_PATTERN.test(pkg.relDir)) {
      throw new Error(`Unsafe workspace directory path: ${pkg.relDir}`);
    }

    console.log(`\n> ${pkg.name} (${pkg.relDir}) :: ${scriptName}`);
    const result =
      process.platform === "win32"
        ? spawnSync(
            "cmd.exe",
            ["/d", "/s", "/c", `corepack pnpm -C ${pkg.relDir} run ${scriptName}`],
            {
              cwd: workspaceRoot,
              stdio: "inherit",
            },
          )
        : spawnSync("corepack", ["pnpm", "-C", pkg.relDir, "run", scriptName], {
            cwd: workspaceRoot,
            stdio: "inherit",
          });

    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

main();
