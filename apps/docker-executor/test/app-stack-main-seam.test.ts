import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** E20: the image allowlist is replaced only from tests, never from configuration or the environment. */
const SRC = new URL("../src/", import.meta.url);
const ALLOWLIST = /appImageAllowlist|APP_IMAGE_ALLOWLIST|AppImageAllowlistEntry/;
const ENV_READ = /process\.env|\benv\??\.[A-Z]|\benv\[/;

describe("the appImageAllowlist test seam", () => {
  it("is never mentioned by the production entry point", async () => {
    expect(await readFile(new URL("main.ts", SRC), "utf8")).not.toContain("appImageAllowlist");
  });

  it("is never built from an environment variable", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const builders: string[] = [];
    for (const file of files) {
      const text = await readFile(new URL(file, SRC), "utf8");
      if (!ALLOWLIST.test(text)) continue;
      builders.push(file);
      expect(text, file).not.toMatch(ENV_READ);
    }
    expect(builders).toContain("docker-engine-adapter.ts");
  });
});
