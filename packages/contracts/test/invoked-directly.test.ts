import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HELPER = pathToFileURL(resolve(__dirname, "../src/invoked-directly.ts")).href;
const base = mkdtempSync(join(tmpdir(), "hp-invoked-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// releases/1.0.0/{main,lib}.mjs and current -> releases/1.0.0, like /opt/hosting-panel.
const rel = join(base, "releases", "1.0.0");
mkdirSync(rel, { recursive: true });
writeFileSync(
  join(rel, "lib.mjs"),
  `import { isInvokedDirectly } from ${JSON.stringify(HELPER)};\nexport const fromLib = isInvokedDirectly(import.meta.url);\n`,
);
writeFileSync(
  join(rel, "main.mjs"),
  `import { isInvokedDirectly } from ${JSON.stringify(HELPER)};\nimport { fromLib } from "./lib.mjs";\nconsole.log(JSON.stringify({ main: isInvokedDirectly(import.meta.url), fromLib }));\n`,
);
symlinkSync("releases/1.0.0", join(base, "current"));

function run(entry: string) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", entry], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { main: boolean; fromLib: boolean };
}

describe("isInvokedDirectly", () => {
  it("is true for the entry point started through a symlinked path", () => {
    expect(run(join(base, "current", "main.mjs"))).toEqual({ main: true, fromLib: false });
  });
  it("is true for the entry point started through its real path", () => {
    expect(run(join(rel, "main.mjs"))).toEqual({ main: true, fromLib: false });
  });
});
