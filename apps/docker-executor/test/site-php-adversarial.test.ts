import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovedServiceSpecWireSchema,
  PHP_SETTING_KEYS,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SITE_PHP_INI_TARGET,
  SignedDockerExecutorIpcClient,
  detectOutOfBandContainerModification,
  removeSitePhpIni,
  renderPhpIni,
  sitePhpBinds,
  sitePhpIniPath,
  writeSitePhpIni,
  type DockerContainerInspectPayload,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const HEADER = "; Managed by the hosting panel; read-only.\n";
const HMAC_SECRET = "0123456789abcdef0123456789abcdef-site-php-adv-key";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-php-adv-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
  return "";
}

describe("renderPhpIni refuses ini injection through values", () => {
  const withValue = (value: unknown) => ({ memory_limit: value }) as unknown as Record<string, string>;

  it.each([
    ["LF", "256M\nauto_prepend_file=/tmp/x"],
    ["CR", "256M\rauto_prepend_file=/tmp/x"],
    ["CRLF", "256M\r\nauto_prepend_file=/tmp/x"],
    ["a trailing LF", "256M\n"],
    ["a leading LF", "\n256M"],
    ["a semicolon comment", "256M ; comment"],
    ["a section header", "[PATH=/var/www]"],
    ["a section header after the number", "256M[PHP]"],
    ["an equals sign", "=256M"],
    ["a second assignment", "256M=1"],
    ["a double quote", '"256M"'],
    ["a single quote", "'256M'"],
    ["a backtick", "`id`"],
    ["a dollar expansion", "${HOME}"],
    ["a NUL byte", "256M\0"],
    ["an embedded NUL byte", "25\u00006M"],
    ["a leading space", " 256M"],
    ["a trailing space", "256M "],
    ["a tab", "256M\t"],
    ["a lower case unit", "256m"],
    ["a MB unit", "256MB"],
    ["a fraction", "1.5G"],
    ["a plus sign", "+256M"],
    ["an octal-looking number", "0256M"],
    ["a full-width digit", "２56M"],
    ["an empty string", ""],
    ["a PHP constant name", "E_ALL"],
    ["500000 digits", `${"9".repeat(500_000)}M`],
    ["a very long run of letters", "M".repeat(100_000)],
  ])("rejects %s in a value", (_label, value) => {
    expect(codeOf(() => renderPhpIni(withValue(value)))).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["a number", 256],
    ["null", null],
    ["an array", ["256M"]],
    ["an object", { toString: () => "256M" }],
    ["a boolean", true],
  ])("rejects %s instead of a string", (_label, value) => {
    expect(codeOf(() => renderPhpIni(withValue(value)))).toBe("VALIDATION_ERROR");
  });

  it("rejects an object whose only key is undefined", () => {
    expect(codeOf(() => renderPhpIni({ memory_limit: undefined } as unknown as Record<string, string>))).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["upload_max_filesize 4097M", { upload_max_filesize: "4097M" }],
    ["post_max_size 5G", { post_max_size: "5G" }],
    ["memory_limit 65G", { memory_limit: "65G" }],
    ["memory_limit -1", { memory_limit: "-1" }],
    ["memory_limit 0", { memory_limit: "0" }],
    ["max_execution_time 0", { max_execution_time: "0" }],
    ["max_execution_time 3601", { max_execution_time: "3601" }],
    ["max_input_time 0", { max_input_time: "0" }],
    ["max_input_vars 99", { max_input_vars: "99" }],
    ["max_input_vars 100001", { max_input_vars: "100001" }],
    ["max_input_vars with a size unit", { max_input_vars: "1000K" }],
    ["max_execution_time with a leading zero", { max_execution_time: "030" }],
    ["max_execution_time as hex", { max_execution_time: "0x10" }],
    ["max_execution_time as exponent", { max_execution_time: "1e3" }],
  ])("rejects %s", (_label, settings) => {
    expect(codeOf(() => renderPhpIni(settings))).toBe("VALIDATION_ERROR");
  });

  it("accepts the exact numeric caps", () => {
    expect(
      renderPhpIni({
        memory_limit: "64G",
        upload_max_filesize: "4G",
        post_max_size: "4G",
        max_execution_time: "3600",
        max_input_time: "1",
        max_input_vars: "100000",
      }),
    ).toBe(
      `${HEADER}max_execution_time = 3600\nmax_input_time = 1\nmax_input_vars = 100000\nmemory_limit = 64G\npost_max_size = 4G\nupload_max_filesize = 4G\n`,
    );
  });

  it("only ever emits the header and plain key = value lines for accepted input", () => {
    const out = renderPhpIni({ memory_limit: "256M", max_input_vars: "1000", post_max_size: "64M" });
    const lines = out.split("\n");
    expect(lines[0]).toBe(HEADER.trimEnd());
    expect(lines.at(-1)).toBe("");
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^[a-z_]+ = [1-9][0-9]*[KMG]?$/);
    expect(out).not.toMatch(/[\r\0]/);
  });
});

describe("renderPhpIni refuses keys outside the closed set", () => {
  const settings = (key: string, value = "256M") => ({ [key]: value });

  it.each([
    "disable_functions",
    "open_basedir",
    "auto_prepend_file",
    "auto_append_file",
    "extension",
    "zend_extension",
    "sendmail_path",
    "error_log",
    "session.save_path",
    "allow_url_include",
    "Memory_Limit",
    "MEMORY_LIMIT",
    " memory_limit",
    "memory_limit ",
    "memory_limit[]",
    "memory_limit\0",
    "memory_limit\nauto_prepend_file",
    "memory_limit = 1\n[PHP]\nauto_prepend_file",
    "[PHP]",
    "constructor",
    "toString",
    "",
  ])("rejects the key %j", (key) => {
    expect(codeOf(() => renderPhpIni(settings(key)))).toBe("VALIDATION_ERROR");
  });

  it("rejects an own __proto__ key", () => {
    const polluted = JSON.parse('{"__proto__":{"memory_limit":"256M"},"memory_limit":"256M"}') as Record<string, string>;
    expect(codeOf(() => renderPhpIni(polluted))).toBe("VALIDATION_ERROR");
  });

  it("rejects one unknown key next to valid ones, whole object", () => {
    expect(codeOf(() => renderPhpIni({ memory_limit: "256M", disable_functions: "" }))).toBe("VALIDATION_ERROR");
  });

  it("also refuses a directive that arrives through the prototype chain", () => {
    const inherited = Object.create({ auto_prepend_file: "/tmp/x" }) as Record<string, string>;
    inherited.memory_limit = "256M";
    expect(codeOf(() => renderPhpIni(inherited))).toBe("VALIDATION_ERROR");
  });

  it("closes the set at exactly the six documented keys", () => {
    expect([...PHP_SETTING_KEYS].sort()).toEqual([
      "max_execution_time",
      "max_input_time",
      "max_input_vars",
      "memory_limit",
      "post_max_size",
      "upload_max_filesize",
    ]);
  });
});

describe("the IPC wire schema refuses the same inputs", () => {
  const baseWire = {
    serviceInstanceId: "svc_php",
    siteId: "site_php",
    organizationId: "org_php",
    image: "wordpress:6-php8.3-apache",
    containerName: "hp-site-php",
  };
  const parse = (phpIni: unknown) => ApprovedServiceSpecWireSchema.safeParse({ ...baseWire, phpIni });

  it("accepts a valid phpIni and keeps it", () => {
    const parsed = parse({ memory_limit: "256M" });
    expect(parsed.success && parsed.data.phpIni).toEqual({ memory_limit: "256M" });
  });

  it("accepts a spec without phpIni", () => {
    const parsed = ApprovedServiceSpecWireSchema.safeParse(baseWire);
    expect(parsed.success && parsed.data.phpIni).toBeUndefined();
  });

  it.each([
    ["an unknown key", { disable_functions: "exec" }],
    ["an unknown key next to a valid one", { memory_limit: "256M", auto_prepend_file: "/x" }],
    ["a newline value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["a CR value", { memory_limit: "256M\r" }],
    ["a semicolon value", { memory_limit: "256M;" }],
    ["a section value", { memory_limit: "[PHP]" }],
    ["a NUL value", { memory_limit: "256M\0" }],
    ["an over-cap value", { upload_max_filesize: "5G" }],
    ["a number instead of a string", { memory_limit: 256 }],
    ["an empty object", {}],
    ["null", null],
    ["an array", [{ memory_limit: "256M" }]],
    ["a string", "memory_limit = 256M"],
  ])("refuses phpIni with %s", (_label, phpIni) => {
    expect(parse(phpIni).success).toBe(false);
  });

  describe("over a signed IPC deploy", () => {
    async function setup() {
      const tmp = await makeTempDir();
      const mockDaemon = await startMockDockerDaemon();
      cleanups.push(() => mockDaemon.close());
      const sitePhpDir = path.join(tmp, "site-php");
      const adapter = new DockerEngineSocketAdapter({
        dockerSocketPath: mockDaemon.socketPath,
        secretsRootDir: path.join(tmp, "secrets"),
        ingressRootDir: path.join(tmp, "ingress"),
        sitePhpDir,
        pullMissingImages: false,
        backupWorkDir: path.join(tmp, "backups"),
      });
      const socketPath = `/tmp/hp-exec-adv-${randomBytes(5).toString("hex")}.sock`;
      const server = new DockerExecutorIpcServer({
        executor: adapter,
        keyring: { "hmac-v1": VERIFICATION_KEY },
        transport: "uds",
        socketPath,
      });
      cleanups.push(() => server.stop());
      await server.start();
      const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, transport: "uds", socketPath });
      return { client, mockDaemon, sitePhpDir };
    }

    it.each([
      ["an unknown key", { disable_functions: "exec" }],
      ["a newline value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ])("a forged phpIni with %s is rejected and nothing is written or created", async (_label, phpIni) => {
      const { client, mockDaemon, sitePhpDir } = await setup();
      const good = createApprovedServiceSpec({
        serviceInstanceId: "svc_php",
        siteId: "site_php",
        organizationId: "org_php",
        image: "wordpress:6-php8.3-apache",
        containerName: "hp-site-php",
        env: {},
        resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
        pidsLimit: 128,
        revisionNumber: 1,
        specHash: "hash_php",
        exposeHttp: false,
        internalPort: 80,
        volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
      });
      const forged = { ...good, phpIni } as unknown as Parameters<typeof client.deployService>[0];
      await expect(client.deployService(forged)).rejects.toThrow();
      expect(mockDaemon.containers.size).toBe(0);
      await expect(stat(sitePhpDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("service ids cannot escape the ini directory", () => {
  const ESCAPES = [
    "../x",
    "..",
    ".",
    "a/../b",
    "a/b",
    "/etc/passwd",
    "/abs",
    "x\0y",
    "x\0",
    "a\\b",
    "..\\x",
    "%2e%2e%2fx",
    "x\r",
    "a\nb",
    "x ",
    " x",
    "ｓvc",
    "a".repeat(129),
  ];

  it.each(ESCAPES)("sitePhpIniPath and sitePhpBinds refuse %j", (id) => {
    expect(codeOf(() => sitePhpIniPath("/srv/php", id))).toBe("HOST_POLICY_DENIED");
    expect(codeOf(() => sitePhpBinds("/srv/php", id))).toBe("HOST_POLICY_DENIED");
  });

  it("an id ending in .ini or .tmp stays a plain file name inside the directory", () => {
    expect(sitePhpIniPath("/srv/php", "svc_1.ini")).toBe("/srv/php/svc_1.ini.ini");
    expect(path.dirname(sitePhpIniPath("/srv/php", "a".repeat(128)))).toBe("/srv/php");
  });

  it("writeSitePhpIni with an escaping id creates nothing, not even the directory", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "site-php");
    for (const id of ESCAPES) {
      await expect(writeSitePhpIni(dir, id, { memory_limit: "256M" })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("removeSitePhpIni with an escaping id leaves files outside the directory alone", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "site-php");
    await mkdir(dir);
    await writeFile(path.join(root, "victim.ini"), "keep");
    await writeFile(path.join(dir, "keep.ini"), "keep");
    for (const id of ["../victim", "../victim.ini", "/" + path.join(root, "victim"), "a/../../victim"]) {
      await expect(removeSitePhpIni(dir, id)).resolves.toBeUndefined();
    }
    expect(await readFile(path.join(root, "victim.ini"), "utf8")).toBe("keep");
    expect(await readdir(dir)).toEqual(["keep.ini"]);
  });
});

describe("writeSitePhpIni on hostile file system state", () => {
  it("replaces a hard link and leaves the other name of the inode untouched", async () => {
    const dir = await makeTempDir();
    const victim = path.join(await makeTempDir(), "victim.txt");
    await writeFile(victim, "untouched");
    await link(victim, sitePhpIniPath(dir, "svc_1"));

    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });

    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await readFile(sitePhpIniPath(dir, "svc_1"), "utf8")).toBe(`${HEADER}memory_limit = 256M\n`);
  });

  it("replaces a symlink to a directory without writing into that directory", async () => {
    const dir = await makeTempDir();
    const targetDir = await makeTempDir();
    await symlink(targetDir, sitePhpIniPath(dir, "svc_1"));

    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });

    expect((await lstat(sitePhpIniPath(dir, "svc_1"))).isFile()).toBe(true);
    expect(await readdir(targetDir)).toEqual([]);
  });

  it("refuses a non-empty directory at the ini path, keeps it and leaves no temporary file", async () => {
    const dir = await makeTempDir();
    const inDir = path.join(sitePhpIniPath(dir, "svc_1"), "inner.txt");
    await mkdir(sitePhpIniPath(dir, "svc_1"));
    await writeFile(inDir, "keep");

    await expect(writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" })).rejects.toThrow();

    expect(await readFile(inDir, "utf8")).toBe("keep");
    expect((await lstat(sitePhpIniPath(dir, "svc_1"))).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual(["svc_1.ini"]);
  });

  it("refuses an empty directory at the ini path and leaves no temporary file", async () => {
    const dir = await makeTempDir();
    await mkdir(sitePhpIniPath(dir, "svc_1"));
    await expect(writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" })).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["svc_1.ini"]);
  });

  it("resets a loose existing file to 0644 whatever the umask", async () => {
    const dir = await makeTempDir();
    const file = sitePhpIniPath(dir, "svc_1");
    await writeFile(file, "old", { mode: 0o666 });
    await chmod(file, 0o666);
    const previous = process.umask(0o077);
    try {
      await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    } finally {
      process.umask(previous);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it("repairs a world-writable directory to 0755", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "site-php");
    await mkdir(dir);
    await chmod(dir, 0o777);
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
  });

  it("writes the file with no NUL or CR and exactly the rendered text", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M", post_max_size: "64M" });
    const content = await readFile(sitePhpIniPath(dir, "svc_1"), "utf8");
    expect(content).toBe(renderPhpIni({ memory_limit: "256M", post_max_size: "64M" }));
    expect(content).not.toMatch(/[\r\0]/);
  });

  it("a rejected rewrite keeps the previous content", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await expect(writeSitePhpIni(dir, "svc_1", { memory_limit: "256M\n[x]" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readFile(sitePhpIniPath(dir, "svc_1"), "utf8")).toBe(`${HEADER}memory_limit = 256M\n`);
    expect(await readdir(dir)).toEqual(["svc_1.ini"]);
  });
});

describe("removeSitePhpIni never throws", () => {
  it("resolves for a missing file in an existing directory", async () => {
    const dir = await makeTempDir();
    await expect(removeSitePhpIni(dir, "svc_missing")).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("resolves when a path component of the directory is a regular file", async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, "file"), "x");
    await expect(removeSitePhpIni(path.join(root, "file", "sub"), "svc_1")).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)("resolves when the directory is not writable and keeps the file", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await chmod(dir, 0o500);
    try {
      await expect(removeSitePhpIni(dir, "svc_1")).resolves.toBeUndefined();
      expect(await readdir(dir)).toEqual(["svc_1.ini"]);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it("does not touch a sibling service whose id only shares a prefix", async () => {
    const dir = await makeTempDir();
    await writeSitePhpIni(dir, "svc_1", { memory_limit: "256M" });
    await writeSitePhpIni(dir, "svc_10", { memory_limit: "512M" });
    await removeSitePhpIni(dir, "svc_1");
    expect(await readdir(dir)).toEqual(["svc_10.ini"]);
  });
});

describe("sitePhpBinds is exactly one read-only bind", () => {
  it("is a single string ending in the fixed target and :ro", () => {
    const binds = sitePhpBinds("/srv/php", "svc_1");
    expect(binds).toHaveLength(1);
    expect(binds[0]).toBe(`/srv/php/svc_1.ini:${SITE_PHP_INI_TARGET}:ro`);
    expect(binds[0]!.split(":")).toEqual(["/srv/php/svc_1.ini", "/usr/local/etc/php/conf.d/zz-hp-site.ini", "ro"]);
  });

  it("two services never share a source file", () => {
    expect(sitePhpBinds("/srv/php", "svc_1")[0]).not.toBe(sitePhpBinds("/srv/php", "svc_2")[0]);
  });
});

describe("docker adapter with hostile or absent phpIni", () => {
  const specInput = (phpIni?: Record<string, string>, revision = 1) => ({
    serviceInstanceId: "svc_php",
    siteId: "site_php",
    organizationId: "org_php",
    image: "wordpress:6-php8.3-apache",
    containerName: "hp-site-php",
    env: {},
    resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
    pidsLimit: 128,
    revisionNumber: revision,
    specHash: `hash_php${String(revision)}`,
    exposeHttp: false,
    internalPort: 80,
    volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
    ...(phpIni !== undefined ? { phpIni } : {}),
  });
  const VOLUME_BIND = "hp_vol_svc_php_html:/var/www/html";

  async function setup() {
    const tmp = await makeTempDir();
    const mockDaemon = await startMockDockerDaemon();
    cleanups.push(() => mockDaemon.close());
    const sitePhpDir = path.join(tmp, "site-php");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      sitePhpDir,
      pullMissingImages: false,
      backupWorkDir: path.join(tmp, "backups"),
    });
    return { adapter, mockDaemon, sitePhpDir, tmp };
  }
  const binds = (d: Awaited<ReturnType<typeof setup>>["mockDaemon"]) =>
    [...d.containers.values()].find((c) => c.name === "hp-site-php")?.hostConfig.Binds ?? [];

  it("an empty phpIni object changes nothing: no directory, no bind", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({})));
    expect(binds(mockDaemon)).toEqual([VOLUME_BIND]);
    await expect(stat(sitePhpDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a forged empty phpIni on the spec itself changes nothing either", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    const forged = { ...createApprovedServiceSpec(specInput()), phpIni: {} };
    await adapter.deployService(forged);
    expect(binds(mockDaemon)).toEqual([VOLUME_BIND]);
    await expect(stat(sitePhpDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a deploy without phpIni neither reads nor removes an existing file nor binds it", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await writeSitePhpIni(sitePhpDir, "svc_php", { memory_limit: "256M" });
    await adapter.deployService(createApprovedServiceSpec(specInput()));
    expect(binds(mockDaemon)).toEqual([VOLUME_BIND]);
    expect(await readFile(sitePhpIniPath(sitePhpDir, "svc_php"), "utf8")).toBe(`${HEADER}memory_limit = 256M\n`);
    expect(await adapter.getObservedState("svc_php")).toMatchObject({ outOfBandModified: false });
  });

  it.each([
    ["an unknown key", { disable_functions: "exec" }],
    ["a newline value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["a non-string value", { memory_limit: 256 }],
  ])("a forged spec with %s fails before any file or container exists", async (_label, phpIni) => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    const forged = { ...createApprovedServiceSpec(specInput()), phpIni } as unknown as Parameters<typeof adapter.deployService>[0];
    await expect(adapter.deployService(forged)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockDaemon.containers.size).toBe(0);
    await expect(stat(sitePhpDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failed ini write leaves the running container of the previous revision in place", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ memory_limit: "256M" })));
    const before = [...mockDaemon.containers.keys()];
    await rm(sitePhpIniPath(sitePhpDir, "svc_php"));
    await mkdir(path.join(sitePhpIniPath(sitePhpDir, "svc_php"), "inner"), { recursive: true });

    await expect(adapter.deployService(createApprovedServiceSpec(specInput({ memory_limit: "512M" }, 2)))).rejects.toThrow();

    expect([...mockDaemon.containers.keys()]).toEqual(before);
    expect(binds(mockDaemon)).toEqual([VOLUME_BIND, `${sitePhpIniPath(sitePhpDir, "svc_php")}:${SITE_PHP_INI_TARGET}:ro`]);
  });

  it("a planted symlink at the ini path is replaced on deploy and its target is untouched", async () => {
    const { adapter, mockDaemon, sitePhpDir, tmp } = await setup();
    const victim = path.join(tmp, "victim.txt");
    await writeFile(victim, "untouched");
    await mkdir(sitePhpDir, { recursive: true });
    await symlink(victim, sitePhpIniPath(sitePhpDir, "svc_php"));

    await adapter.deployService(createApprovedServiceSpec(specInput({ memory_limit: "256M" })));

    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect((await lstat(sitePhpIniPath(sitePhpDir, "svc_php"))).isSymbolicLink()).toBe(false);
    expect(binds(mockDaemon)).toHaveLength(2);
  });

  it("the container gets exactly one ini bind, read-only, from its own file", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ memory_limit: "256M", upload_max_filesize: "64M" })));
    const iniBinds = binds(mockDaemon).filter((bind) => bind.includes("zz-hp-site.ini"));
    expect(iniBinds).toEqual([`${path.join(sitePhpDir, "svc_php.ini")}:/usr/local/etc/php/conf.d/zz-hp-site.ini:ro`]);
    expect(binds(mockDaemon).filter((bind) => bind.includes(sitePhpDir))).toHaveLength(1);
  });

  it("deleting a service removes its ini even when no container exists, and keeps other services' files", async () => {
    const { adapter, sitePhpDir } = await setup();
    await writeSitePhpIni(sitePhpDir, "svc_php", { memory_limit: "256M" });
    await writeSitePhpIni(sitePhpDir, "svc_other", { memory_limit: "512M" });
    await expect(adapter.deleteService("svc_php")).resolves.toMatchObject({ status: "succeeded" });
    expect(await readdir(sitePhpDir)).toEqual(["svc_other.ini"]);
  });

  it("deleting with an escaping id is refused and removes nothing", async () => {
    const { adapter, sitePhpDir, tmp } = await setup();
    await writeSitePhpIni(sitePhpDir, "svc_php", { memory_limit: "256M" });
    await writeFile(path.join(tmp, "victim.ini"), "keep");
    await expect(adapter.deleteService("../victim")).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(await readFile(path.join(tmp, "victim.ini"), "utf8")).toBe("keep");
    expect(await readdir(sitePhpDir)).toEqual(["svc_php.ini"]);
  });
});

describe("simulator with hostile or absent phpIni", () => {
  const baseSpec = () =>
    createApprovedServiceSpec({
      serviceInstanceId: "svc_php",
      siteId: "site_php",
      organizationId: "org_php",
      image: "wordpress:6-php8.3-apache",
      containerName: "hp-site-php",
      env: {},
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 128,
      revisionNumber: 1,
      specHash: "hash_php",
      exposeHttp: false,
      internalPort: 80,
    });

  it("a forged empty phpIni records nothing", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await sim.deployService({ ...baseSpec(), phpIni: {} });
    expect(sim.phpIniByService.size).toBe(0);
  });

  it.each([
    ["an unknown key", { auto_prepend_file: "/x" }],
    ["a carriage return", { memory_limit: "256M\r[PHP]" }],
  ])("a forged phpIni with %s fails and records nothing", async (_label, phpIni) => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await expect(sim.deployService({ ...baseSpec(), phpIni } as unknown as ReturnType<typeof baseSpec>)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(sim.phpIniByService.size).toBe(0);
  });
});

describe("detectOutOfBandContainerModification with the PHP bind", () => {
  const PHP_DIR = "/srv/test-site-php";
  const OWN = `${PHP_DIR}/svc_php.ini`;
  const inspectWith = (binds: readonly string[]): DockerContainerInspectPayload => ({
    Id: "ctr_php",
    Config: {
      Labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_php",
        [MANAGED_DOCKER_LABELS.organizationId]: "org_php",
        [MANAGED_DOCKER_LABELS.siteId]: "site_php",
      },
      Env: [],
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: "hp_site_site_php_net",
      Binds: binds,
    },
  });
  const drift = (binds: readonly string[]) =>
    detectOutOfBandContainerModification(inspectWith(binds), "svc_php", "/run/hosting-panel/secrets", undefined, undefined, PHP_DIR);

  it.each([
    ["the directory itself at the ini target", `${PHP_DIR}:${SITE_PHP_INI_TARGET}:ro`],
    ["the directory mounted elsewhere", `${PHP_DIR}:/etc/php:ro`],
    ["its own file at another target", `${OWN}:/usr/local/etc/php/conf.d/zz-hp-mail.ini:ro`],
    ["its own file at php.ini", `${OWN}:/usr/local/etc/php/php.ini:ro`],
    ["its own file with a read-write mode", `${OWN}:${SITE_PHP_INI_TARGET}:rw`],
    ["its own file with extra mount options", `${OWN}:${SITE_PHP_INI_TARGET}:ro,z`],
    ["its own file through a double slash", `${PHP_DIR}//svc_php.ini:${SITE_PHP_INI_TARGET}:ro`],
    ["its own file through a dot segment", `${PHP_DIR}/./svc_php.ini:${SITE_PHP_INI_TARGET}:ro`],
    ["a traversal that resolves to its own file", `${PHP_DIR}/x/../svc_php.ini:${SITE_PHP_INI_TARGET}:ro`],
    ["a service id that only shares the prefix", `${PHP_DIR}/svc_php2.ini:${SITE_PHP_INI_TARGET}:ro`],
    ["a relative source", `svc_php.ini:${SITE_PHP_INI_TARGET}:ro`],
    ["a host file at the ini target", `/etc/passwd:${SITE_PHP_INI_TARGET}:ro`],
  ])("%s is drift", (_label, bind) => {
    expect(drift([bind])).toBe(true);
  });

  it("an extra bind next to its own file is drift", () => {
    expect(drift([OWN + `:${SITE_PHP_INI_TARGET}:ro`, "/etc/shadow:/x:ro"])).toBe(true);
  });

  it("a missing PHP bind is not drift: the check only flags binds that should not be there", () => {
    expect(drift([])).toBe(false);
    expect(drift(["hp_vol_svc_php_html:/var/www/html"])).toBe(false);
  });
});
