import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "hp-os-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function detect(id: string, codename: string) {
  const file = join(dir, `${id}-${codename}`);
  writeFileSync(file, `ID=${id}\nVERSION_CODENAME=${codename}\n`);
  return spawnSync(
    "bash",
    ["-c", `export HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
    { cwd: root, encoding: "utf8" }
  );
}

describe("supported OS matrix", () => {
  it.each([
    ["ubuntu", "noble"],
    ["ubuntu", "resolute"],
    ["debian", "bookworm"],
    ["debian", "trixie"]
  ])("accepts %s %s", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${id} ${codename}`);
  });

  it.each([
    ["ubuntu", "jammy"],
    ["debian", "bullseye"]
  ])("rejects %s %s with the supported list", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).not.toBe(0);
    for (const v of ["noble", "resolute", "bookworm", "trixie"]) expect(r.stderr).toContain(v);
  });

  it("honours HP_ALLOW_OTHER_LINUX", () => {
    const file = join(dir, "other");
    writeFileSync(file, "ID=arch\nVERSION_CODENAME=\n");
    const r = spawnSync(
      "bash",
      ["-c", `export HP_ALLOW_OTHER_LINUX=1 HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
      { cwd: root, encoding: "utf8" }
    );
    expect(r.status).toBe(0);
  });
});

describe("platform baselines", () => {
  it("node and traefik baselines", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").startsWith("26")).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node).toBe(">=26.0.0");
    expect(readFileSync(join(root, "apps/docker-executor/src/traefik-config.ts"), "utf8")).toContain('"traefik:v3.7"');
  });
});
