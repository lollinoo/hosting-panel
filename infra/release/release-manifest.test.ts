import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { listReleaseViolations, releaseNodeVersion, REQUIRED_RELEASE_PATHS } from "./build-release.mjs";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "hp-release-"));
  dirs.push(d);
  return d;
}
function touch(root: string, rel: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), "x");
}
function completeTree() {
  const d = tmp();
  for (const p of REQUIRED_RELEASE_PATHS as string[]) touch(d, p);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("listReleaseViolations", () => {
  it("reports missing required paths", async () => {
    const v: string[] = await listReleaseViolations(tmp());
    expect(v).toContain("missing: apps/api/dist/main.js");
    expect(v).toContain("missing: VERSION");
  });

  it("reports forbidden files", async () => {
    const d = completeTree();
    touch(d, "apps/api/src/x.ts");
    touch(d, ".env");
    touch(d, "a.test.ts");
    touch(d, ".env.example");
    expect((await listReleaseViolations(d)).sort()).toEqual([
      "forbidden: .env",
      "forbidden: a.test.ts",
      "forbidden: apps/api/src/x.ts"
    ]);
  });

  it("reports absolute and escaping symlinks but allows relative ones", async () => {
    const d = completeTree();
    mkdirSync(join(d, "node_modules/.pnpm/pkg"), { recursive: true });
    symlinkSync("../.pnpm/pkg", join(d, "node_modules/ok"));
    symlinkSync("/etc/passwd", join(d, "node_modules/abs"));
    symlinkSync("../../outside", join(d, "node_modules/esc"));
    expect((await listReleaseViolations(d)).sort()).toEqual([
      "symlink: node_modules/abs -> /etc/passwd",
      "symlink: node_modules/esc -> ../../outside"
    ]);
  });

  it("requires the shared release library", () => {
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/linux/lib/release.sh");
  });

  it("accepts a complete minimal tree", async () => {
    expect(await listReleaseViolations(completeTree())).toEqual([]);
  });
});

describe("releaseNodeVersion", () => {
  it("returns the exact x.y.z when the major matches .node-version", () => {
    const v: string = releaseNodeVersion("26\n", "26.13.0");
    expect(v).toBe("26.13.0");
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("rejects a running major that differs from .node-version", () => {
    expect(() => releaseNodeVersion("26", "24.11.1")).toThrow(/major 26/);
  });
});
