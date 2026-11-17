import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { listReleaseViolations, releaseImages, releaseNodeVersion, REQUIRED_RELEASE_PATHS } from "./build-release.mjs";
import * as contracts from "../../packages/contracts/src/index.js";
import { DEFAULT_TRAEFIK_IMAGE } from "../../apps/docker-executor/src/traefik-config.js";

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

  it("requires the tmpfiles.d config bootstrap installs", () => {
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hosting-panel-tmpfiles.conf");
  });

  it("requires the eight root units of the host jobs", () => {
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-unit-restart@.path");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-unit-restart@.service");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-panel-update.path");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-panel-update.service");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-os-refresh.path");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-os-refresh.service");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-os-upgrade.path");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/systemd/hp-os-upgrade.service");
  });

  it("requires the shared release library", () => {
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/linux/lib/release.sh");
  });

  it("requires the installer and the OS library it sources", () => {
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/linux/install.sh");
    expect(REQUIRED_RELEASE_PATHS).toContain("infra/linux/lib/os.sh");
  });

  it("requires the updater, its wrapper and the shared helpers", () => {
    for (const p of ["infra/linux/update.sh", "infra/linux/hp-update", "infra/linux/lib/common.sh"]) {
      expect(REQUIRED_RELEASE_PATHS).toContain(p);
    }
  });

  it("requires the panel restore script, its wrapper, its SQL file and the fetch command", () => {
    for (const p of [
      "infra/linux/hp-restore-panel",
      "infra/linux/restore-panel.sh",
      "infra/linux/hp-restore-panel.sql",
      "apps/docker-executor/dist/cli/panel-fetch.js",
    ]) {
      expect(REQUIRED_RELEASE_PATHS).toContain(p);
    }
  });

  it("requires every migration of the tree and the image list", () => {
    const sql = readdirSync(join(__dirname, "../../packages/database/migrations")).filter((f) => f.endsWith(".sql"));
    expect(sql.length).toBeGreaterThan(17);
    for (const f of sql) expect(REQUIRED_RELEASE_PATHS).toContain(`packages/database/dist/migrations/${f}`);
    expect(REQUIRED_RELEASE_PATHS).toContain("IMAGES");
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

describe("releaseImages", () => {
  it("names every image of the built code, sorted, each once", () => {
    const images: string[] = releaseImages(contracts, DEFAULT_TRAEFIK_IMAGE);
    const named = Object.entries(contracts).filter(([k, v]) => k.endsWith("_IMAGE") && typeof v === "string").map(([, v]) => v);
    const php = contracts.SUPPORTED_PHP_VERSIONS.flatMap((v) => [contracts.resolveWordpressImage(v), contracts.resolveWordpressCliImage(v)]);
    expect(named.length).toBeGreaterThan(4);
    for (const i of [...named, DEFAULT_TRAEFIK_IMAGE, ...php]) expect(images).toContain(i);
    expect(images).toEqual([...new Set(images)].sort());
  });
});
