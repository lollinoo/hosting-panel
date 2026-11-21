import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { BackupTarget } from "@hosting-panel/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LocalPanelRepoSource, PanelFetchResult } from "../src/backup-runner.js";
import { BackupRunner, type DockerRequest } from "../src/index.js";
import { main, type PanelFetchIo } from "../src/cli/panel-fetch.js";

const ACCESS = "HP_SENTINEL_CLI_ACCESS_551";
const SECRET = "HP_SENTINEL_CLI_SECRET_662";
const SNAP = "a1b2c3d4".repeat(8);
const ARGV = ["--endpoint", "https://s3.example.test", "--region", "eu-central-1", "--bucket", "hp-bk", "--prefix", "prod"];

function run(overrides: Partial<PanelFetchIo> & { result?: PanelFetchResult | Error } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const envRead: string[] = [];
  const fetchPanelCopy = vi.fn(async (_target: BackupTarget | LocalPanelRepoSource, _dir: string): Promise<PanelFetchResult> => {
    const result = overrides.result ?? { ok: true, snapshotId: SNAP, time: "2026-11-15T09:00:00.000Z" };
    if (result instanceof Error) throw result;
    return result;
  });
  const createAdapter = vi.fn(() => ({ fetchPanelCopy }));
  const env = new Proxy(
    { HP_PANEL_DUMP_DIR: "/tmp/hp-dump", HP_BACKUP_KEY_FILE: "/tmp/hp.key", HP_OTHER: "x" } as Record<string, string | undefined>,
    {
      get(target, key: string) {
        envRead.push(key);
        return target[key];
      },
    },
  );
  const io: PanelFetchIo = {
    argv: ARGV,
    stdin: `${ACCESS}\n${SECRET}\n`,
    env,
    uid: 990,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    createAdapter,
    ...overrides,
  };
  return { io, out, err, envRead, fetchPanelCopy, createAdapter, code: () => main(io) };
}

describe("panel-fetch CLI", () => {
  it("prints one JSON line and exits 0 with the target read from flags and stdin", async () => {
    const ctx = run();
    expect(await ctx.code()).toBe(0);
    expect(ctx.out).toEqual([JSON.stringify({ snapshotId: SNAP, time: "2026-11-15T09:00:00.000Z" })]);
    expect(ctx.err).toEqual([]);
    expect(ctx.createAdapter).toHaveBeenCalledWith({ backupKeyFile: "/tmp/hp.key", panelDumpDir: "/tmp/hp-dump" });
    expect(ctx.fetchPanelCopy).toHaveBeenCalledWith(
      {
        endpoint: "https://s3.example.test",
        region: "eu-central-1",
        bucket: "hp-bk",
        prefix: "prod",
        accessKeyId: ACCESS,
        secretAccessKey: SECRET,
      },
      "/tmp/hp-dump",
      expect.any(AbortSignal),
    );
    expect(new Set(ctx.envRead)).toEqual(new Set(["HP_PANEL_DUMP_DIR", "HP_BACKUP_KEY_FILE"]));
  });

  it("accepts CRLF, no trailing newline, and an absent prefix", async () => {
    const ctx = run({ stdin: `${ACCESS}\r\n${SECRET}`, argv: ARGV.slice(0, 6) });
    expect(await ctx.code()).toBe(0);
    expect(ctx.fetchPanelCopy.mock.calls[0]![0]).toMatchObject({ prefix: "", accessKeyId: ACCESS, secretAccessKey: SECRET });
  });

  it.each([
    ["one line", { stdin: `${ACCESS}\n` }],
    ["three lines", { stdin: `${ACCESS}\n${SECRET}\nextra\n` }],
    ["empty stdin", { stdin: "" }],
    ["an empty secret", { stdin: `${ACCESS}\n\n` }],
    ["a key with a backtick", { stdin: `${ACCESS}\`\n${SECRET}\n` }],
    ["root", { uid: 0 }],
    ["an unknown flag", { argv: [...ARGV, "--force"] }],
    ["a positional argument", { argv: [...ARGV, "extra"] }],
    ["a missing bucket", { argv: ARGV.slice(0, 4) }],
    ["a bad region", { argv: ARGV.map((a) => (a === "eu-central-1" ? "EU CENTRAL" : a)) }],
    ["a bad endpoint", { argv: ARGV.map((a) => (a.startsWith("https://") ? "not a url" : a)) }],
  ] as const)("refuses %s with exit 2 and never builds the adapter", async (_label, overrides) => {
    const ctx = run(overrides);
    expect(await ctx.code()).toBe(2);
    expect(ctx.createAdapter).not.toHaveBeenCalled();
    expect(ctx.out).toEqual([]);
    expect(ctx.err).toEqual(["panel-fetch: refused"]);
    expect(JSON.stringify(ctx.err)).not.toContain(SECRET);
    expect(JSON.stringify(ctx.err)).not.toContain(ACCESS);
  });

  it.each([
    ["refused", 2],
    ["unreachable", 3],
    ["tls_failed", 3],
    ["wrong_region", 3],
    ["auth_failed", 3],
    ["bucket_missing", 3],
    ["no_copy", 4],
    ["wrong_key", 5],
    ["key_file_missing", 5],
    ["no_space", 6],
    ["local_target_unmounted", 7],
    ["local_target_unsafe", 8],
    ["write_denied", 1],
    ["timeout", 1],
    ["other", 1],
  ] as const)("maps %s to exit %i with one stderr line and no values", async (problem, exit) => {
    const ctx = run({ result: { ok: false, problem } });
    expect(await ctx.code()).toBe(exit);
    expect(ctx.out).toEqual([]);
    expect(ctx.err).toEqual([`panel-fetch: ${problem}`]);
  });

  it("an adapter error is exit 1, class other, and the message is not printed", async () => {
    const ctx = run({ result: new Error(`boom ${SECRET}`) });
    expect(await ctx.code()).toBe(1);
    expect(ctx.err).toEqual(["panel-fetch: other"]);
  });

  it("uses the executor defaults when the environment is empty", async () => {
    const ctx = run({ env: {} });
    expect(await ctx.code()).toBe(0);
    expect(ctx.createAdapter).toHaveBeenCalledWith({
      backupKeyFile: "/etc/hosting-panel/backup.key",
      panelDumpDir: "/var/lib/hosting-panel/panel-dump",
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "on %s during the fetch cleans up through the runner's own finally and exits 1 (R122)",
    async (sig) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "hp-pf-sig-"));
      try {
        const dumpDir = path.join(root, "panel-dump");
        const secretsRootDir = path.join(root, "secrets");
        await mkdir(dumpDir, { mode: 0o2770 });
        await writeFile(path.join(root, "backup.key"), `${"cafe1234".repeat(8)}\n`);
        const requests: string[] = [];
        let waiting!: () => void;
        const reachedWait = new Promise<void>((resolve) => (waiting = resolve));
        let killed!: () => void;
        const kill = new Promise<void>((resolve) => (killed = resolve));
        const ok = (statusCode: number, body: unknown = {}) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
        const request: DockerRequest = async (method, reqPath) => {
          requests.push(`${method} ${reqPath}`);
          if (reqPath.startsWith("/containers/create")) return ok(201, { Id: "pf_ref" });
          if (reqPath.endsWith("/wait")) {
            // The container has written all four names and is still running.
            for (const n of ["restore.pgdump", "restore.key", ".restore.pgdump.part", ".restore.key.part"]) {
              await writeFile(path.join(dumpDir, n), "x");
            }
            waiting();
            await kill;
            return ok(200, { StatusCode: 137 });
          }
          if (reqPath.endsWith("/kill")) killed();
          return ok(204);
        };
        const runner = new BackupRunner({
          request,
          ensureImage: async () => undefined,
          ensureBackupNetwork: async () => undefined,
          listSiteDatabases: async () => [],
          secretsRootDir,
          backupKeyFile: path.join(root, "backup.key"),
          sharedDbRootKeyFile: path.join(root, "mariadb-root"),
          sharedDbNetworkName: "hp_shared_db_net",
          backupNetworkName: "hp_backup_net",
          executorUser: "990:990",
          backupWorkDir: path.join(root, "work"),
          panelDumpDir: dumpDir,
          fetch: (async () => new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof fetch,
        });
        const before = process.listeners(sig);
        const ctx = run({
          env: { HP_PANEL_DUMP_DIR: dumpDir },
          createAdapter: () => ({ fetchPanelCopy: (t, d, s) => runner.fetchPanelCopy(t, d, s) }),
        });
        const code = ctx.code();
        await reachedWait;
        expect((await readdir(secretsRootDir)).some((n) => n.startsWith("job_bk_pf_"))).toBe(true);
        const added = process.listeners(sig).filter((l) => !before.includes(l));
        expect(added).toHaveLength(1);
        added[0]!(sig);
        expect(await code).toBe(1);
        expect(requests).toContain("DELETE /containers/pf_ref?force=true&v=true");
        expect(await readdir(dumpDir)).toEqual([]);
        expect(await readdir(secretsRootDir)).toEqual([]);
        expect(process.listeners(sig)).toEqual(before);
        expect(ctx.out).toEqual([]);
        expect(JSON.stringify([ctx.err, requests])).not.toMatch(/cafe1234|HP_SENTINEL/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["making sure of the image", "image"],
    ["the check of the storage", "probe"],
  ] as const)("on SIGINT while %s never ends, exits 1 at once and writes nothing (R124)", async (_label, hang) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hp-pf-early-"));
    try {
      const dumpDir = path.join(root, "panel-dump");
      const secretsRootDir = path.join(root, "secrets");
      await mkdir(dumpDir, { mode: 0o2770 });
      await mkdir(secretsRootDir);
      await writeFile(path.join(root, "backup.key"), `${"cafe1234".repeat(8)}\n`);
      const requests: string[] = [];
      let hung!: () => void;
      const reachedHang = new Promise<void>((resolve) => (hung = resolve));
      const never = <T>(): Promise<T> => {
        hung();
        return new Promise<T>(() => undefined);
      };
      const runner = new BackupRunner({
        request: async (method, reqPath) => {
          requests.push(`${method} ${reqPath}`);
          return { statusCode: 204, body: Buffer.from("{}") };
        },
        ensureImage: async () => (hang === "image" ? never<undefined>() : undefined),
        ensureBackupNetwork: async () => undefined,
        listSiteDatabases: async () => [],
        secretsRootDir,
        backupKeyFile: path.join(root, "backup.key"),
        sharedDbRootKeyFile: path.join(root, "mariadb-root"),
        sharedDbNetworkName: "hp_shared_db_net",
        backupNetworkName: "hp_backup_net",
        executorUser: "990:990",
        backupWorkDir: path.join(root, "work"),
        panelDumpDir: dumpDir,
        fetch: (async () =>
          hang === "probe" ? never<Response>() : new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof fetch,
      });
      const before = process.listeners("SIGINT");
      const ctx = run({
        env: { HP_PANEL_DUMP_DIR: dumpDir },
        createAdapter: () => ({ fetchPanelCopy: (t, d, s) => runner.fetchPanelCopy(t, d, s) }),
      });
      const code = ctx.code();
      await reachedHang;
      process.listeners("SIGINT").filter((l) => !before.includes(l))[0]!("SIGINT");
      expect(await code).toBe(1);
      expect(ctx.err).toEqual(["panel-fetch: interrupted"]);
      expect(ctx.out).toEqual([]);
      expect(requests.some((r) => r.startsWith("POST /containers/create"))).toBe(false);
      expect(await readdir(dumpDir)).toEqual([]);
      expect(await readdir(secretsRootDir)).toEqual([]);
      expect(process.listeners("SIGINT")).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 3000);
  it("when the kill fails, removes the still running container before it deletes the files (R124)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hp-pf-kill-"));
    try {
      const dumpDir = path.join(root, "panel-dump");
      const secretsRootDir = path.join(root, "secrets");
      await mkdir(dumpDir, { mode: 0o2770 });
      await writeFile(path.join(root, "backup.key"), `${"cafe1234".repeat(8)}\n`);
      let waiting!: () => void;
      const reachedWait = new Promise<void>((resolve) => (waiting = resolve));
      const ok = (statusCode: number, body: unknown = {}) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
      const request: DockerRequest = async (method, reqPath) => {
        if (reqPath.startsWith("/containers/create")) return ok(201, { Id: "pf_ref" });
        if (reqPath.endsWith("/wait")) {
          waiting();
          return new Promise(() => undefined);
        }
        if (reqPath.endsWith("/kill")) return ok(500);
        // The container still runs until it is removed and writes the key once more.
        if (method === "DELETE") await writeFile(path.join(dumpDir, ".restore.key.part"), "x");
        return ok(204);
      };
      const runner = new BackupRunner({
        request,
        ensureImage: async () => undefined,
        ensureBackupNetwork: async () => undefined,
        listSiteDatabases: async () => [],
        secretsRootDir,
        backupKeyFile: path.join(root, "backup.key"),
        sharedDbRootKeyFile: path.join(root, "mariadb-root"),
        sharedDbNetworkName: "hp_shared_db_net",
        backupNetworkName: "hp_backup_net",
        executorUser: "990:990",
        backupWorkDir: path.join(root, "work"),
        panelDumpDir: dumpDir,
        fetch: (async () => new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof fetch,
      });
      const stop = new AbortController();
      const result = runner.fetchPanelCopy(
        { endpoint: "https://s3.example.test", region: "eu-central-1", bucket: "hp-bk", prefix: "prod", accessKeyId: ACCESS, secretAccessKey: SECRET },
        dumpDir,
        stop.signal,
      );
      await reachedWait;
      stop.abort();
      expect(await result).toMatchObject({ ok: false });
      expect(await readdir(dumpDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("--local-repo", () => {
    /** A restic repository layout owned by the test user, in the 2770 shape the executor leaves (E1). */
    async function repo(mode = 0o2770): Promise<{ root: string; dir: string }> {
      const root = await mkdtemp(path.join(os.tmpdir(), "hp-pf-local-"));
      const dir = path.join(root, "local-repos", `bkt_${"a".repeat(32)}`, "panel");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "config"), "x");
      for (const n of ["keys", "data", "snapshots", "index"]) await mkdir(path.join(dir, n));
      await chmod(dir, mode);
      return { root, dir };
    }
    const local = (dir: string, overrides: Parameters<typeof run>[0] = {}) =>
      run({ argv: ["--local-repo", dir], stdin: "", ...overrides });

    it("prints one JSON line with --local-repo and empty stdin, passing the directory and no S3 keys", async () => {
      const { root, dir } = await repo();
      try {
        const ctx = local(dir);
        expect(await ctx.code()).toBe(0);
        expect(ctx.out).toEqual([JSON.stringify({ snapshotId: SNAP, time: "2026-11-15T09:00:00.000Z" })]);
        expect(ctx.err).toEqual([]);
        expect(ctx.fetchPanelCopy).toHaveBeenCalledWith({ kind: "local_repo", repoDir: dir }, "/tmp/hp-dump", expect.any(AbortSignal));
        expect(new Set(ctx.envRead)).toEqual(new Set(["HP_PANEL_DUMP_DIR", "HP_BACKUP_KEY_FILE"]));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("accepts the group bits of the executor layout (0770, 2770, 0750)", async () => {
      for (const mode of [0o770, 0o2770, 0o750]) {
        const { root, dir } = await repo(mode);
        try {
          expect(await local(dir).code()).toBe(0);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    });

    it.each([
      ["an S3 flag", ["--bucket", "hp-bk"]],
      ["the whole S3 group", ARGV],
      ["a prefix", ["--prefix", "p"]],
    ] as const)("refuses --local-repo mixed with %s (exit 2)", async (_label, extra) => {
      const { root, dir } = await repo();
      try {
        const ctx = local(dir, { argv: ["--local-repo", dir, ...extra] });
        expect(await ctx.code()).toBe(2);
        expect(ctx.createAdapter).not.toHaveBeenCalled();
        expect(ctx.err).toEqual(["panel-fetch: refused"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.each([["a key line", `${ACCESS}\n`], ["a newline", "\n"], ["a space", " "]])(
      "refuses --local-repo with %s on stdin (exit 2)",
      async (_label, stdin) => {
        const { root, dir } = await repo();
        try {
          const ctx = local(dir, { stdin });
          expect(await ctx.code()).toBe(2);
          expect(ctx.createAdapter).not.toHaveBeenCalled();
          expect(JSON.stringify(ctx.err)).not.toContain(ACCESS);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ["a relative path", "local-repos/x/panel"],
      ["an empty value", ""],
      ["the root", "/"],
      ["a space", "/mnt/old disk/panel"],
      ["a colon", "/mnt/old:ro/panel"],
      ["a comma", "/mnt/old,x/panel"],
      ["a newline", "/mnt/old\n/panel"],
      ["a path of 256 characters", `/${"a".repeat(255)}`],
    ])("refuses %s with exit 2 before touching anything", async (_label, dir) => {
      const ctx = local(dir);
      expect(await ctx.code()).toBe(2);
      expect(ctx.createAdapter).not.toHaveBeenCalled();
      expect(ctx.err).toEqual(["panel-fetch: refused"]);
    });

    const DUMP = "/tmp/hp-dump";
    it.each([
      ["a dot-dot", (d: string) => [`${d}/../panel`, DUMP]],
      ["a double slash", (d: string) => [d.replace("/local-repos/", "//local-repos/"), DUMP]],
      ["a trailing slash", (d: string) => [`${d}/`, DUMP]],
      ["a dot component", (d: string) => [`${d}/.`, DUMP]],
      ["a denylisted path", () => ["/etc/ssl", DUMP]],
      ["/var/lib/docker", () => ["/var/lib/docker/volumes", DUMP]],
      ["the panel dump directory", (d: string) => [d, d]],
      ["a directory above the panel dump directory", (d: string) => [d, path.join(d, "out")]],
      ["a directory inside the panel dump directory", (d: string) => [d, path.dirname(d)]],
    ] as const)("refuses %s with exit 8", async (_label, make) => {
      const { root, dir } = await repo();
      try {
        const [arg, dump] = make(dir);
        const ctx = local(arg!, { env: { HP_PANEL_DUMP_DIR: dump } });
        expect(await ctx.code()).toBe(8);
        expect(ctx.createAdapter).not.toHaveBeenCalled();
        expect(ctx.err).toEqual(["panel-fetch: local_target_unsafe"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("refuses a symlink as the directory, as a parent and as config or a repository folder (exit 8)", async () => {
      const { root, dir } = await repo();
      try {
        const link = path.join(root, "link");
        await symlink(dir, link);
        const viaParent = path.join(root, "parent-link");
        await symlink(path.join(root, "local-repos"), viaParent);
        for (const target of [link, `${viaParent}/bkt_${"a".repeat(32)}/panel`]) {
          const ctx = local(target);
          expect(await ctx.code()).toBe(8);
          expect(ctx.createAdapter).not.toHaveBeenCalled();
        }
        await rm(path.join(dir, "config"));
        await symlink("/etc/hostname", path.join(dir, "config"));
        expect(await local(dir).code()).toBe(8);
        await rm(path.join(dir, "config"));
        await writeFile(path.join(dir, "config"), "x");
        await rm(path.join(dir, "data"), { recursive: true });
        await symlink("/tmp", path.join(dir, "data"));
        expect(await local(dir).code()).toBe(8);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("refuses a world-writable directory or config (exit 8)", async () => {
      const { root, dir } = await repo();
      try {
        await chmod(dir, 0o777);
        expect(await local(dir).code()).toBe(8);
        await chmod(dir, 0o2770);
        await chmod(path.join(dir, "config"), 0o666);
        expect(await local(dir).code()).toBe(8);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.skipIf(!existsSync("/usr/share") || process.getuid?.() === 0)("refuses a directory owned by root (exit 8)", async () => {
      const ctx = local("/usr/share");
      expect(await ctx.code()).toBe(8);
      expect(ctx.createAdapter).not.toHaveBeenCalled();
    });

    it("refuses a file in place of the directory (exit 8)", async () => {
      const { root, dir } = await repo();
      try {
        expect(await local(path.join(dir, "config")).code()).toBe(8);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("maps a missing directory, at any level, to exit 7 (the old disk is not mounted)", async () => {
      const { root, dir } = await repo();
      try {
        for (const missing of [path.join(root, "gone", "panel"), `${dir}-other`, path.join(root, "x")]) {
          const ctx = local(missing);
          expect(await ctx.code()).toBe(7);
          expect(ctx.err).toEqual(["panel-fetch: local_target_unmounted"]);
          expect(ctx.createAdapter).not.toHaveBeenCalled();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("maps a directory that is not a restic repository to exit 4 (no copy)", async () => {
      const { root, dir } = await repo();
      try {
        await rm(path.join(dir, "snapshots"), { recursive: true });
        const ctx = local(dir);
        expect(await ctx.code()).toBe(4);
        expect(ctx.err).toEqual(["panel-fetch: no_copy"]);
        await rm(path.join(dir, "config"));
        expect(await local(dir).code()).toBe(4);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("passes the runner's local problems through as 7 and 8", async () => {
      const { root, dir } = await repo();
      try {
        for (const [problem, exit] of [["local_target_unmounted", 7], ["local_target_unsafe", 8], ["wrong_key", 5], ["no_space", 6], ["no_copy", 4]] as const) {
          expect(await local(dir, { result: { ok: false, problem } }).code()).toBe(exit);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
