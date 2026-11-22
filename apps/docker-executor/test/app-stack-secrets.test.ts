import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_LOG_MASK,
  APP_STACK_LOG_MASK_MIN_LENGTH,
  maskAppStackLogLines,
  purgeAppStackComponentSecrets,
  purgeAppStackSecrets,
  readAppStackComponentSecretValues,
  writeAppStackComponentSecrets,
} from "../src/app-stacks/index.js";

const ID = "stk_0123456789abcdef";

async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chmodTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

describe("stack secret files", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-secrets-"));
    cleanupTasks.push(async () => {
      await chmodTree(root);
      await rm(root, { recursive: true, force: true });
    });
    return root;
  }

  async function expectFiles(dir: string, expected: Record<string, string>): Promise<void> {
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) {
      const st = await stat(path.join(dir, name));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o444);
      expect(await readFile(path.join(dir, name), "utf8")).toBe(value);
    }
  }

  it("writes 0444 files in a 0700 directory named after the stack and component", async () => {
    const root = await tempRoot();
    await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-one-123", api_key: "value-two-456" });
    await expectFiles(path.join(root, `app_${ID}__worker`), { shared_key: "value-one-123", api_key: "value-two-456" });
  });

  it("removes the file of a key the component no longer mounts", async () => {
    const root = await tempRoot();
    const dir = path.join(root, `app_${ID}__worker`);
    await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-one-123", api_key: "value-two-456" });
    await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-three-789" });
    await expectFiles(dir, { shared_key: "value-three-789" });

    await writeAppStackComponentSecrets(root, ID, "worker", {});
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a folder that stands where a secret file should be", async () => {
    const root = await tempRoot();
    const dir = path.join(root, `app_${ID}__worker`);
    await mkdir(path.join(dir, "shared_key"), { recursive: true });

    await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-one-123" });

    await expectFiles(dir, { shared_key: "value-one-123" });
  });

  it("sets aside a component folder the executor does not own, then writes", async () => {
    const root = await tempRoot();
    const dir = path.join(root, `app_${ID}__worker`);
    await mkdir(path.join(dir, "shared_key"), { recursive: true });
    const oldDir = await open(dir, "r");
    cleanupTasks.push(() => oldDir.close());
    const before = (await oldDir.stat()).ino;
    const realUid = process.getuid?.() ?? 0;

    const spy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    try {
      await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-one-123" });
    } finally {
      spy.mockRestore();
    }

    expect((await stat(dir)).ino).not.toBe(before);
    await expectFiles(dir, { shared_key: "value-one-123" });
    expect((await readdir(root)).filter((name) => name.startsWith(".stale-"))).toEqual([]);
  });

  it("refuses a malformed stack id or key before touching the disk", async () => {
    const root = await tempRoot();
    await expect(writeAppStackComponentSecrets(root, "../x", "worker", { shared_key: "v" })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    await expect(writeAppStackComponentSecrets(root, ID, "my_key", { shared_key: "v" })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(await readdir(root)).toEqual([]);
  });

  it("purges one component, or every component of this stack only", async () => {
    const root = await tempRoot();
    for (const [stackId, key] of [[ID, "web"], [ID, "worker"], [`${ID}_`, "web"], [`${ID}x`, "web"], ["stk_other", "web"]] as const) {
      await writeAppStackComponentSecrets(root, stackId, key, { shared_key: `value-${stackId}-${key}` });
    }
    const siteDir = path.join(root, "svc_prod_web");
    await mkdir(siteDir, { mode: 0o700 });
    await writeFile(path.join(siteDir, "DB_PASSWORD"), "site-value", { mode: 0o444 });

    await purgeAppStackComponentSecrets(root, ID, "web");
    expect((await readdir(root)).sort()).toEqual([`app_${ID}___web`, `app_${ID}__worker`, `app_${ID}x__web`, "app_stk_other__web", "svc_prod_web"]);

    await writeAppStackComponentSecrets(root, ID, "web", { shared_key: "again-value" });
    await purgeAppStackSecrets(root, ID);
    expect((await readdir(root)).sort()).toEqual([`app_${ID}___web`, `app_${ID}x__web`, "app_stk_other__web", "svc_prod_web"]);
    expect(await readFile(path.join(root, `app_${ID}___web`, "shared_key"), "utf8")).toBe(`value-${ID}_-web`);
    expect(await readFile(path.join(siteDir, "DB_PASSWORD"), "utf8")).toBe("site-value");
  });

  it("purging a missing root or component is a no-op", async () => {
    const root = await tempRoot();
    await purgeAppStackSecrets(path.join(root, "missing"), ID);
    await purgeAppStackComponentSecrets(root, ID, "web");
    expect(await readdir(root)).toEqual([]);
  });

  it("reads the current values best effort", async () => {
    const root = await tempRoot();
    await writeAppStackComponentSecrets(root, ID, "worker", { shared_key: "value-one-123", api_key: "value-two-456" });
    expect((await readAppStackComponentSecretValues(root, ID, "worker")).sort()).toEqual(["value-one-123", "value-two-456"]);
    expect(await readAppStackComponentSecretValues(root, ID, "web")).toEqual([]);
    expect(await readAppStackComponentSecretValues(path.join(root, "missing"), ID, "worker")).toEqual([]);
    expect(await readAppStackComponentSecretValues(root, "../x", "worker")).toEqual([]);
  });
});

describe("maskAppStackLogLines", () => {
  const line = (text: string) => ({ at: "2026-11-22T00:00:00Z", stream: "stdout" as const, text });

  it("masks values of six characters or more, longest first", () => {
    expect(APP_STACK_LOG_MASK).toBe("[REDACTED]");
    expect(APP_STACK_LOG_MASK_MIN_LENGTH).toBe(6);
    const lines = [line("key=abcdefgh and abcdef twice abcdef"), line("short=short"), { at: null, stream: "stderr" as const, text: "none here" }];
    const masked = maskAppStackLogLines(lines, ["abcdef", "short", "abcdefgh"]);
    expect(masked).toEqual([
      line("key=[REDACTED] and [REDACTED] twice [REDACTED]"),
      line("short=short"),
      { at: null, stream: "stderr", text: "none here" },
    ]);
    expect(lines[0]?.text).toBe("key=abcdefgh and abcdef twice abcdef");
  });

  it("masks each line of six characters or more of a multi-line value", () => {
    const pem = "-----BEGIN TEST KEY-----\r\nMIIBOgIBAAJBAKj34GkxFhD9\nend";
    const lines = [line("-----BEGIN TEST KEY-----"), line("key MIIBOgIBAAJBAKj34GkxFhD9 read"), line("end")];
    expect(maskAppStackLogLines(lines, [pem])).toEqual([line("[REDACTED]"), line("key [REDACTED] read"), line("end")]);
  });

  it("leaves no tail of two values that partly overlap", () => {
    expect(maskAppStackLogLines([line("a abcdefghijk b defghijk")], ["abcdefgh", "defghijk"])).toEqual([line("a [REDACTED] b [REDACTED]")]);
  });

  it("masks a line end that starts a value and a line start that ends one, from six characters", () => {
    const value = "Sup3rS3cretValue-0123456789abcdef";
    expect(
      maskAppStackLogLines([line(`url=redis://default:${value.slice(0, 18)}`), line(`${value.slice(18)}@cache`), line("ok Sup3r"), line("23456789 seen")], [value]),
    ).toEqual([line("url=redis://default:[REDACTED]"), line("[REDACTED]@cache"), line("ok Sup3r"), line("23456789 seen")]);
    expect(maskAppStackLogLines([line(`${value.slice(-6)} and ${value.slice(0, 6)}`)], [value])).toEqual([line("[REDACTED] and [REDACTED]")]);
  });

  it("returns the lines unchanged without values", () => {
    expect(maskAppStackLogLines([line("plain text")], [])).toEqual([line("plain text")]);
  });

  it.each([8_000, 16_000])("masks 2 MiB of %i-character access lines against a crafted value in linear time", (urlLength) => {
    const value = `${"a".repeat(4_000)}b${"a".repeat(4_000)}`;
    const text = `GET /${"a".repeat(urlLength)} HTTP/1.1`;
    const lines = Array.from({ length: Math.ceil((2 * 1024 * 1024) / text.length) }, () => line(text));
    const started = performance.now();
    const masked = maskAppStackLogLines(lines, [value]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(masked).toEqual(lines);
  });

  it("masks 2 MiB of repeated text against a long value and thousands of value lines in linear time", () => {
    const multiLine = Array.from({ length: 7 }, (_, v) => Array.from({ length: 2_300 }, (_, i) => `${v}${String(i).padStart(5, "0")}`).join("\n"));
    const lines = Array.from({ length: 128 }, () => line("a".repeat(16_384)));
    const started = performance.now();
    const masked = maskAppStackLogLines(lines, ["a".repeat(4_000), ...multiLine]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(masked).toEqual(lines.map(() => line(APP_STACK_LOG_MASK)));
  });
});
