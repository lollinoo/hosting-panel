import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PHP_SETTING_KEYS } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_PHP_DIR,
  SITE_PHP_INI_TARGET,
  removeSitePhpIni,
  renderPhpIni,
  sitePhpBinds,
  sitePhpIniPath,
  writeSitePhpIni,
} from "../src/site-php.js";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-site-php-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const HEADER = "; Managed by the hosting panel; read-only.\n";

/** The code carried by the error, or "" when nothing was thrown. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
  return "";
}

describe("site-php constants", () => {
  it("fixes the host directory and the in-container target", () => {
    expect(DEFAULT_SITE_PHP_DIR).toBe("/var/lib/hosting-panel/site-php");
    // zz- sorts after the mail ini (zz-hp-mail.ini), and the two never set the same key.
    expect(SITE_PHP_INI_TARGET).toBe("/usr/local/etc/php/conf.d/zz-hp-site.ini");
  });
});

describe("renderPhpIni", () => {
  it("writes the header and one sorted key = value line per setting", () => {
    expect(renderPhpIni({ memory_limit: "256M", upload_max_filesize: "64M", max_execution_time: "120" })).toBe(
      `${HEADER}max_execution_time = 120\nmemory_limit = 256M\nupload_max_filesize = 64M\n`,
    );
  });

  it("is deterministic whatever the key order of the input", () => {
    const a = renderPhpIni({ post_max_size: "64M", upload_max_filesize: "32M" });
    const b = renderPhpIni({ upload_max_filesize: "32M", post_max_size: "64M" });
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("renders every closed key", () => {
    const all = Object.fromEntries(PHP_SETTING_KEYS.map((key) => [key, /size|limit$|filesize/.test(key) ? "64M" : "300"]));
    const lines = renderPhpIni(all).split("\n");
    expect(lines.slice(1, -1).map((line) => line.split(" = ")[0])).toEqual([...PHP_SETTING_KEYS].sort());
  });

  it.each([
    ["an unknown key", { disable_functions: "exec" }],
    ["a directive-like key", { "memory_limit\nauto_prepend_file": "256M" }],
    ["a newline in a value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["a semicolon in a value", { memory_limit: "256M;" }],
    ["a quote in a value", { memory_limit: '"256M"' }],
    ["a leading dash", { memory_limit: "-1" }],
    ["a size over the cap", { upload_max_filesize: "5G" }],
    ["an empty object", {}],
  ])("rejects %s with VALIDATION_ERROR", (_label, settings) => {
    expect(codeOf(() => renderPhpIni(settings))).toBe("VALIDATION_ERROR");
  });
});

describe("sitePhpIniPath and sitePhpBinds", () => {
  it("joins the directory and the service id", () => {
    expect(sitePhpIniPath("/srv/php", "svc_1")).toBe("/srv/php/svc_1.ini");
    expect(sitePhpIniPath(DEFAULT_SITE_PHP_DIR, "svc_1")).toBe("/var/lib/hosting-panel/site-php/svc_1.ini");
  });

  it("binds only this service's own file, read-only, at the fixed target", () => {
    expect(sitePhpBinds("/srv/php", "svc_1")).toEqual([
      "/srv/php/svc_1.ini:/usr/local/etc/php/conf.d/zz-hp-site.ini:ro",
    ]);
  });

  it.each(["../x", "a/b", "", ".hidden", "a..b", "a b", "x\n", "/etc/passwd"])("refuses the service id %j", (id) => {
    expect(codeOf(() => sitePhpIniPath("/srv/php", id))).toBe("HOST_POLICY_DENIED");
    expect(codeOf(() => sitePhpBinds("/srv/php", id))).toBe("HOST_POLICY_DENIED");
  });
});

describe("writeSitePhpIni", () => {
  it("creates the directory 0755 and the file 0644 under umask 0007", async () => {
    const dir = path.join(await makeTempDir(), "site-php");
    const previous = process.umask(0o007);
    try {
      await writeSitePhpIni(dir, "svc_1", { upload_max_filesize: "64M" });
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      const file = sitePhpIniPath(dir, "svc_1");
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      expect(await readFile(file, "utf8")).toBe(`${HEADER}upload_max_filesize = 64M\n`);
    } finally {
      process.umask(previous);
    }
  });

  it("repairs the mode of an existing directory", async () => {
    const dir = path.join(await makeTempDir(), "site-php");
    await mkdir(dir, { mode: 0o700 });
    const previous = process.umask(0o007);
    try {
      await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("replaces the content on rewrite and leaves no temporary file", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "512M", max_input_vars: "2000" });
    expect(await readFile(sitePhpIniPath(dir, "svc_1"), "utf8")).toBe(
      `${HEADER}max_input_vars = 2000\nmemory_limit = 512M\n`,
    );
    expect(await readdir(dir)).toEqual(["svc_1.ini"]);
  });

  it("keeps one file per service", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await writeSitePhpIni(dir, "svc_2", { memory_limit: "512M" });
    expect((await readdir(dir)).sort()).toEqual(["svc_1.ini", "svc_2.ini"]);
    expect(await readFile(sitePhpIniPath(dir, "svc_1"), "utf8")).toContain("256M");
  });

  it("replaces a symlink planted at the target and never writes through it", async () => {
    const dir = await makeTempDir();
    const victim = path.join(await makeTempDir(), "victim.txt");
    await writeFile(victim, "untouched");
    const file = sitePhpIniPath(dir, "svc_1");
    await symlink(victim, file);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);

    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });

    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect(await readFile(file, "utf8")).toBe(`${HEADER}memory_limit = 256M\n`);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await readdir(dir)).toEqual(["svc_1.ini"]);
  });

  it("replaces a dangling symlink without creating its target", async () => {
    const dir = await makeTempDir();
    const missing = path.join(await makeTempDir(), "missing.txt");
    const file = sitePhpIniPath(dir, "svc_1");
    await symlink(missing, file);
    expect(await readlink(file)).toBe(missing);

    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });

    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bad setting or id before it creates anything", async () => {
    const dir = path.join(await makeTempDir(), "site-php");
    await expect(writeSitePhpIni(dir, "svc_1", { disable_functions: "exec" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(writeSitePhpIni(dir, "../x", { memory_limit: "256M" })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("removeSitePhpIni", () => {
  it("removes only this service's file, and again without error", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await writeSitePhpIni(dir, "svc_2", { memory_limit: "512M" });
    await removeSitePhpIni(dir, "svc_1");
    await removeSitePhpIni(dir, "svc_1");
    expect(await readdir(dir)).toEqual(["svc_2.ini"]);
  });

  it("is silent on a missing directory, an unsafe id and a directory in the way", async () => {
    const root = await makeTempDir();
    await expect(removeSitePhpIni(path.join(root, "nope"), "svc_1")).resolves.toBeUndefined();
    await expect(removeSitePhpIni(root, "../x")).resolves.toBeUndefined();
    await expect(removeSitePhpIni(path.join(root, "nope", "deeper"), "svc_1")).resolves.toBeUndefined();
    await mkdir(path.join(root, "svc_3.ini", "inner"), { recursive: true });
    await expect(removeSitePhpIni(root, "svc_3")).resolves.toBeUndefined();
  });

  it("removes a symlink without touching what it points to", async () => {
    const dir = await makeTempDir();
    const victim = path.join(await makeTempDir(), "victim.txt");
    await writeFile(victim, "untouched");
    await symlink(victim, sitePhpIniPath(dir, "svc_1"));
    await removeSitePhpIni(dir, "svc_1");
    expect(await readdir(dir)).toEqual([]);
    expect(await readFile(victim, "utf8")).toBe("untouched");
  });
});
