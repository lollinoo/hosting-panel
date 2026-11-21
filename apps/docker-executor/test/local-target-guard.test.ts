import { chmod, lstat, lutimes, utimes, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_DISK_FREE_FLOOR_BYTES } from "../src/backup-jobs.js";
import {
  guardLocalTarget,
  initLocalTarget,
  LOCAL_TARGET_MARKER_NAME,
  LOCAL_TARGET_WORKING_MARGIN_BYTES,
  localTargetMarkerContent,
  validateLocalRepoRoot,
  type LocalStatfs,
  type LocalTargetGuardDeps,
  type LocalTargetIntent,
} from "../src/local-target-guard.js";

const TARGET = `bkt_${"a".repeat(32)}`;
const OTHER_TARGET = `bkt_${"b".repeat(32)}`;
const SITE = "site_one";
const GIB = 1_073_741_824n;
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

let tmp: string;
let root: string;
let outside: string;

const roomy = (bavail: bigint = 100n * GIB): LocalStatfs => ({ bsize: 1n, blocks: 200n * GIB, bavail, files: 1000n, ffree: 900n });
const deps = (over: Partial<LocalTargetGuardDeps> = {}): LocalTargetGuardDeps => ({
  root,
  executorUid: uid,
  executorGid: gid,
  statfs: async () => roomy(),
  ...over,
});
const guard = (
  d: LocalTargetGuardDeps,
  intent: LocalTargetIntent = "backup",
  extra = 0,
  scope: { kind: "site"; siteId: string } | { kind: "panel" } = { kind: "site", siteId: SITE },
) => guardLocalTarget(d, { targetId: TARGET, scope, intent, requiredExtraBytes: extra });
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o7777;

async function provisionTarget(targetId = TARGET): Promise<string> {
  const dir = path.join(root, targetId);
  await mkdir(dir, { mode: 0o770 });
  await chmod(dir, 0o2770);
  await writeFile(path.join(dir, LOCAL_TARGET_MARKER_NAME), localTargetMarkerContent(targetId), { mode: 0o600 });
  return dir;
}

// The unit runs with UMask=0007; mkdir's 0770 must not be filtered further.
let oldUmask: number | undefined;
beforeAll(() => {
  try {
    oldUmask = process.umask(0o007);
  } catch {
    // worker threads cannot change the umask
  }
});
afterAll(() => {
  if (oldUmask !== undefined) process.umask(oldUmask);
});

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "hp-guard-"));
  root = path.join(tmp, "root");
  outside = path.join(tmp, "outside");
  // What bootstrap-dedicated.sh does: the root is 2770 owned by the executor group, so new directories inherit setgid.
  await mkdir(root, { mode: 0o770 });
  await chmod(root, 0o2770);
  await mkdir(outside, { mode: 0o700 });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("validateLocalRepoRoot", () => {
  it("accepts a canonical absolute root", () => {
    expect(validateLocalRepoRoot("/var/lib/hosting-panel/local-repos", ["/var/lib/hosting-panel/backups"])).toBe(
      "/var/lib/hosting-panel/local-repos",
    );
    expect(validateLocalRepoRoot("/mnt/hp-backups", [])).toBe("/mnt/hp-backups");
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["relative", "var/lib/x"],
    ["parent segment", "/mnt/a/../b"],
    ["double slash", "/mnt//b"],
    ["trailing slash", "/mnt/b/"],
    ["root", "/"],
    ["depth one", "/mnt"],
    ["space", "/mnt/hp backups"],
    ["shell metacharacter", "/mnt/b;x"],
    ["/etc", "/etc/hp-repos"],
    ["/var/lib/docker", "/var/lib/docker/x"],
    ["/run", "/run/hp/x"],
    ["/proc", "/proc/1/x"],
    ["parent of a docker dir", "/var/lib"],
  ])("rejects %s", (_name, raw) => {
    expect(validateLocalRepoRoot(raw, [])).toBeNull();
  });

  it("rejects a root inside, equal to or above an executor directory", () => {
    const forbidden = ["/var/lib/hosting-panel/backups", "/var/lib/hosting-panel/secrets"];
    expect(validateLocalRepoRoot("/var/lib/hosting-panel/backups/local", forbidden)).toBeNull();
    expect(validateLocalRepoRoot("/var/lib/hosting-panel/backups", forbidden)).toBeNull();
    expect(validateLocalRepoRoot("/var/lib/hosting-panel", forbidden)).toBeNull();
    expect(validateLocalRepoRoot("/var/lib/hosting-panel/backups-local", forbidden)).toBe("/var/lib/hosting-panel/backups-local");
  });
});

describe("guardLocalTarget", () => {
  it("rejects malformed ids before touching the filesystem", async () => {
    for (const targetId of ["../x", "bkt_x", `${TARGET}/..`, "bkt_" + "A".repeat(32)]) {
      await expect(
        guardLocalTarget(deps(), { targetId, scope: { kind: "panel" }, intent: "test", requiredExtraBytes: 0 }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    for (const siteId of ["..", "a/b", "../etc", ""]) {
      await expect(guard(deps(), "backup", 0, { kind: "site", siteId })).rejects.toBeDefined();
    }
    await expect(guard(deps(), "backup", -1)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readdir(root)).toEqual([]);
  });

  it("answers unsafe for every call when the root is disabled", async () => {
    await provisionTarget();
    expect(await guard(deps({ root: null }))).toEqual({ ok: false, problem: "local_target_unsafe" });
  });

  it("creates sites/<siteId> and the leaf by setgid inheritance (2770) for a write intent", async () => {
    await provisionTarget();
    const result = await guard(deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repo).toMatchObject({
      hostDir: path.join(root, TARGET, "sites", SITE),
      containerPath: `/backup/repository/sites/${SITE}`,
      executorGid: gid,
      availableBytes: Number(100n * GIB),
      totalBytes: Number(200n * GIB),
    });
    expect(await mode(path.join(root, TARGET, "sites"))).toBe(0o2770);
    expect(await mode(result.repo.hostDir)).toBe(0o2770);
    expect((await stat(result.repo.hostDir)).gid).toBe(gid);
    expect(await readdir(result.repo.hostDir)).toEqual([]); // probe removed
  });

  it("uses <root>/<targetId>/panel for the panel scope", async () => {
    await provisionTarget();
    const result = await guard(deps(), "panelBackup", 0, { kind: "panel" });
    expect(result).toMatchObject({ ok: true, repo: { hostDir: path.join(root, TARGET, "panel"), containerPath: "/backup/repository/panel" } });
    expect(await mode(path.join(root, TARGET, "panel"))).toBe(0o2770);
  });

  it("is idempotent on an existing 2770 leaf", async () => {
    await provisionTarget();
    expect((await guard(deps())).ok).toBe(true);
    expect((await guard(deps())).ok).toBe(true);
  });

  it("reports unmounted for a missing root and does not create it", async () => {
    await rm(root, { recursive: true });
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unmounted" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never creates <targetId> for any intent but reports unmounted", async () => {
    const intents: LocalTargetIntent[] = ["test", "backup", "forget", "panelBackup", "restore", "archive"];
    for (const intent of intents) {
      expect(await guard(deps(), intent)).toEqual({ ok: false, problem: "local_target_unmounted" });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("reports unmounted when the marker is missing and writes nothing", async () => {
    const dir = await provisionTarget();
    await rm(path.join(dir, LOCAL_TARGET_MARKER_NAME));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unmounted" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports unmounted for a foreign marker (another target's content)", async () => {
    const dir = await provisionTarget();
    await writeFile(path.join(dir, LOCAL_TARGET_MARKER_NAME), localTargetMarkerContent(OTHER_TARGET));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unmounted" });
    expect(await readdir(dir)).toEqual([LOCAL_TARGET_MARKER_NAME]);
  });

  it("refuses a marker that is a symlink, a directory or too large", async () => {
    const dir = await provisionTarget();
    const marker = path.join(dir, LOCAL_TARGET_MARKER_NAME);
    await rm(marker);
    await writeFile(path.join(outside, "m"), localTargetMarkerContent(TARGET));
    await symlink(path.join(outside, "m"), marker);
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
    await rm(marker);
    await mkdir(marker);
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
    await rm(marker, { recursive: true });
    await writeFile(marker, "x".repeat(300));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
  });

  it("refuses a root that is a symlink", async () => {
    await provisionTarget();
    const link = path.join(tmp, "rootlink");
    await symlink(root, link);
    expect(await guard(deps({ root: link }))).toEqual({ ok: false, problem: "local_target_unsafe" });
  });

  it("refuses a root with a symlinked ancestor (readlink mismatch)", async () => {
    await provisionTarget();
    const link = path.join(tmp, "parentlink");
    await symlink(tmp, link);
    expect(await guard(deps({ root: path.join(link, "root") }))).toEqual({ ok: false, problem: "local_target_unsafe" });
  });

  it("refuses wrong modes and a foreign owner on root and target", async () => {
    await provisionTarget();
    await chmod(root, 0o777);
    expect(await guard(deps())).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    await chmod(root, 0o2770);
    await chmod(path.join(root, TARGET), 0o770); // group-writable without setgid
    expect(await guard(deps())).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    await chmod(path.join(root, TARGET), 0o2770);
    expect((await guard(deps({ executorUid: uid + 1 }))).ok).toBe(false);
    expect(await guard(deps({ executorUid: uid + 1 }))).toEqual({ ok: false, problem: "local_target_unsafe" });
  });

  it("refuses <targetId> replaced by a symlink to another directory, leaving it untouched", async () => {
    const real = await provisionTarget(OTHER_TARGET);
    await symlink(real, path.join(root, TARGET));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(real)).toEqual([LOCAL_TARGET_MARKER_NAME]);
  });

  it("refuses sites/ and the leaf as symlinks to outside and writes nothing there", async () => {
    const dir = await provisionTarget();
    await symlink(outside, path.join(dir, "sites"));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(outside)).toEqual([]);

    await rm(path.join(dir, "sites"));
    await mkdir(path.join(dir, "sites"), { mode: 0o770 });
    await chmod(path.join(dir, "sites"), 0o2770);
    await symlink(outside, path.join(dir, "sites", SITE));
    expect(await guard(deps())).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await guard(deps(), "restore")).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(outside)).toEqual([]);
    expect(await mode(outside)).toBe(0o700); // a symlink target is never chmod-ed
  });

  it.each([0o700, 0o777, 0o2750])("refuses an existing leaf with mode %o", async (leafMode) => {
    const dir = await provisionTarget();
    await mkdir(path.join(dir, "sites"), { mode: 0o770 });
    await chmod(path.join(dir, "sites"), 0o2770);
    const leaf = path.join(dir, "sites", SITE);
    await mkdir(leaf);
    await chmod(leaf, leafMode);
    expect(await guard(deps())).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    expect(await mode(leaf)).toBe(leafMode); // never auto-fixed
  });

  it("refuses an existing leaf whose gid is not the executor gid", async () => {
    await provisionTarget();
    expect((await guard(deps())).ok).toBe(true);
    expect(await guard(deps({ executorGid: gid + 1 }))).toMatchObject({ ok: false, problem: "local_target_unsafe" });
  });

  it("read intents never create a missing leaf and answer other", async () => {
    const dir = await provisionTarget();
    for (const intent of ["restore", "archive"] as const) {
      expect(await guard(deps(), intent)).toEqual({ ok: false, problem: "other" });
    }
    expect(await readdir(dir)).toEqual([LOCAL_TARGET_MARKER_NAME]);
    await mkdir(path.join(dir, "sites"), { mode: 0o770 });
    await chmod(path.join(dir, "sites"), 0o2770);
    expect(await guard(deps(), "restore")).toEqual({ ok: false, problem: "other" });
    expect(await readdir(path.join(dir, "sites"))).toEqual([]);
  });

  it("read intents accept an existing leaf and probe it too", async () => {
    await provisionTarget();
    await guard(deps());
    expect((await guard(deps(), "restore")).ok).toBe(true);
    const failing = deps({ open: async () => Promise.reject(Object.assign(new Error("ro"), { code: "EROFS" })) });
    expect(await guard(failing, "archive")).toEqual({ ok: false, problem: "local_target_readonly" });
  });

  it.each([
    ["EROFS", "local_target_readonly"],
    ["ENOSPC", "no_space"],
    ["EDQUOT", "no_space"],
    ["EACCES", "local_target_unsafe"],
    ["EPERM", "local_target_unsafe"],
  ])("maps a probe %s to %s", async (code, problem) => {
    await provisionTarget();
    const failing = deps({ open: async () => Promise.reject(Object.assign(new Error(code), { code })) });
    expect(await guard(failing)).toEqual({ ok: false, problem });
  });

  it("maps a write failure after the probe file opened and removes the probe", async () => {
    await provisionTarget();
    const real = open;
    const seam = deps({
      open: async (p, flags, m) => {
        const fh = await real(p, flags, m);
        vi.spyOn(fh, "write").mockRejectedValue(Object.assign(new Error("full"), { code: "ENOSPC" }));
        return fh;
      },
    });
    expect(await guard(seam)).toEqual({ ok: false, problem: "no_space" });
    expect(await readdir(path.join(root, TARGET, "sites", SITE))).toEqual([]);
  });

  describe("stale probe files", () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const leaf = () => path.join(root, TARGET, "sites", SITE);

    it("removes owned regular .hp-probe-* leftovers older than a few minutes, and nothing else", async () => {
      await provisionTarget();
      await guard(deps()); // creates the leaf
      const stale = path.join(leaf(), ".hp-probe-deadbeef");
      const fresh = path.join(leaf(), ".hp-probe-cafebabe");
      const other = path.join(leaf(), "config");
      const odd = path.join(leaf(), ".hp-probe-zz");
      const link = path.join(leaf(), ".hp-probe-0badf00d");
      for (const f of [stale, fresh, other, odd]) await writeFile(f, "x");
      await symlink(other, link);
      for (const f of [stale, other, odd]) await utimes(f, old, old);
      await lutimes(link, old, old);
      expect((await guard(deps())).ok).toBe(true);
      expect((await readdir(leaf())).sort()).toEqual([".hp-probe-0badf00d", ".hp-probe-cafebabe", ".hp-probe-zz", "config"]);
      expect(await readFile(other, "utf8")).toBe("x"); // the symlink was left alone, its target untouched
    });
  });

  describe("space", () => {
    it("fails below floor + estimate and passes on exact equality (bigint)", async () => {
      await provisionTarget();
      const extra = 5_000_000_000;
      const need = BigInt(BACKUP_DISK_FREE_FLOOR_BYTES) + BigInt(extra);
      const at = (bavail: bigint) => guard(deps({ statfs: async () => ({ ...roomy(), bavail, bsize: 1n }) }), "backup", extra);
      expect(await at(need - 1n)).toEqual({ ok: false, problem: "no_space" });
      expect((await at(need)).ok).toBe(true);
    });

    it("applies the 1 GiB floor only to intents that write to the repository", async () => {
      await provisionTarget();
      const low = deps({ statfs: async () => roomy(400n * 1024n * 1024n) }); // 400 MiB free
      for (const intent of ["init", "test", "backup", "panelBackup"] as const) {
        expect(await guard(low, intent), intent).toEqual({ ok: false, problem: "no_space" });
      }
      for (const intent of ["forget", "restore", "archive"] as const) {
        expect((await guard(low, intent)).ok, intent).toBe(true);
      }
    });

    it("forget/restore/archive keep a small working margin (and an inode) for restic's locks", async () => {
      await provisionTarget();
      const margin = LOCAL_TARGET_WORKING_MARGIN_BYTES;
      for (const intent of ["forget", "restore", "archive"] as const) {
        const at = (bavail: bigint) => guard(deps({ statfs: async () => roomy(bavail) }), intent);
        expect(await at(BigInt(margin) - 1n), intent).toEqual({ ok: false, problem: "no_space" });
        expect((await at(BigInt(margin))).ok, intent).toBe(true);
        expect(await guard(deps({ statfs: async () => ({ ...roomy(), ffree: 0n }) }), intent)).toEqual({ ok: false, problem: "no_space" });
      }
    });

    it("multiplies bavail by bsize and applies no 2x factor", async () => {
      await provisionTarget();
      const blocks = (BigInt(BACKUP_DISK_FREE_FLOOR_BYTES) + 1000n) / 4096n + 1n;
      const st = { ...roomy(), bsize: 4096n, bavail: blocks };
      expect((await guard(deps({ statfs: async () => st }), "backup", 1000)).ok).toBe(true);
      expect(await guard(deps({ statfs: async () => ({ ...st, bavail: 10n }) }))).toEqual({ ok: false, problem: "no_space" });
    });

    it("does not lose precision above 2^53 in the comparison", async () => {
      await provisionTarget();
      const huge = { bsize: 4096n, blocks: 1n << 60n, bavail: (1n << 60n) - 1n, files: 10n, ffree: 5n };
      const result = await guard(deps({ statfs: async () => huge }));
      expect(result).toMatchObject({ ok: true, repo: { availableBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER } });
    });

    it("fails with no inodes left", async () => {
      await provisionTarget();
      expect(await guard(deps({ statfs: async () => ({ ...roomy(), ffree: 0n }) }))).toEqual({ ok: false, problem: "no_space" });
      // filesystems without inode accounting report files = 0
      expect((await guard(deps({ statfs: async () => ({ ...roomy(), files: 0n, ffree: 0n }) }))).ok).toBe(true);
    });

    it("maps a statfs rejection to unmounted instead of crashing", async () => {
      await provisionTarget();
      const failing = deps({ statfs: async () => Promise.reject(Object.assign(new Error("gone"), { code: "EIO" })) });
      expect(await guard(failing)).toEqual({ ok: false, problem: "local_target_unmounted" });
    });

    it("measures the leaf through its descriptor", async () => {
      await provisionTarget();
      const statfsSeam = vi.fn(async () => roomy());
      await guard(deps({ statfs: statfsSeam }));
      expect(statfsSeam).toHaveBeenCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/\d+$/), { bigint: true });
    });
  });
});

describe("RestrictSUIDSGID (hp-docker-executor.service)", () => {
  const SGID = 0o2000;
  // Like the unit's sandbox: asking for S_ISGID in a mkdir mode fails; inheritance from the parent still works.
  const restricted = async (p: string, m: number): Promise<unknown> => {
    if ((m & (SGID | 0o4000)) !== 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return mkdir(p, m);
  };

  it("never asks for S_ISGID: init and the first site copy work with a mkdir that refuses the bit", async () => {
    const calls: number[] = [];
    const seam = deps({ mkdir: async (p, m) => (calls.push(m), restricted(p, m)) });
    expect((await initLocalTarget(seam, TARGET)).ok).toBe(true);
    expect((await guard(seam)).ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(4); // target, sites, panel, sites/<siteId>
    expect(calls.every((m) => (m & SGID) === 0)).toBe(true);
    expect(await mode(path.join(root, TARGET, "sites", SITE))).toBe(0o2770);
    expect(await mode(path.join(root, TARGET, "panel"))).toBe(0o2770);
  });

  it("refuses a root without setgid before creating anything and points to the documented fix", async () => {
    await chmod(root, 0o770);
    const result = await initLocalTarget(deps({ mkdir: restricted }), TARGET);
    expect(result).toMatchObject({ ok: false, problem: "local_target_unsafe", detail: expect.stringContaining("chmod 2770") });
    expect(await readdir(root)).toEqual([]);
    await chmod(root, 0o700);
    expect(await initLocalTarget(deps(), TARGET)).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a root of another group and removes a directory that did not inherit the executor group", async () => {
    expect(await initLocalTarget(deps({ executorGid: gid + 1 }), TARGET)).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(root)).toEqual([]);
    await provisionTarget();
    // a target directory that lost the bit is refused, never repaired with a chmod
    await chmod(path.join(root, TARGET), 0o770);
    expect(await guard(deps({ mkdir: restricted }))).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(path.join(root, TARGET))).toEqual([LOCAL_TARGET_MARKER_NAME]);
  });

  it("refuses a directory the filesystem created without the inherited bit and cleans it up", async () => {
    await provisionTarget();
    const noInherit = deps({
      mkdir: async (p, m) => {
        await mkdir(p, m);
        await chmod(p, 0o770); // a filesystem that does not propagate setgid
      },
    });
    expect(await guard(noInherit)).toMatchObject({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(path.join(root, TARGET))).toEqual([LOCAL_TARGET_MARKER_NAME]);
    expect((await guard(deps())).ok).toBe(true); // fixed root => works at once
  });
});

describe("initLocalTarget", () => {
  it("creates the target, marker, sites and panel 2770 (inherited), then guards", async () => {
    const result = await initLocalTarget(deps(), TARGET);
    expect(result).toMatchObject({ ok: true, repo: { hostDir: path.join(root, TARGET, "panel"), containerPath: "/backup/repository/panel" } });
    const dir = path.join(root, TARGET);
    expect(await mode(dir)).toBe(0o2770);
    expect(await readFile(path.join(dir, LOCAL_TARGET_MARKER_NAME), "utf8")).toBe(localTargetMarkerContent(TARGET));
    expect(await mode(path.join(dir, LOCAL_TARGET_MARKER_NAME))).toBe(0o600);
    expect(await mode(path.join(dir, "sites"))).toBe(0o2770);
    expect(await mode(path.join(dir, "panel"))).toBe(0o2770);
    expect((await readdir(dir)).sort()).toEqual([LOCAL_TARGET_MARKER_NAME, "panel", "sites"]);
    expect((await guard(deps(), "backup")).ok).toBe(true);
  });

  it("is idempotent", async () => {
    expect((await initLocalTarget(deps(), TARGET)).ok).toBe(true);
    expect((await initLocalTarget(deps(), TARGET)).ok).toBe(true);
  });

  it("repairs a crash between mkdir and marker (empty directory)", async () => {
    await mkdir(path.join(root, TARGET), { mode: 0o770 });
    await chmod(path.join(root, TARGET), 0o2770);
    expect((await initLocalTarget(deps(), TARGET)).ok).toBe(true);
  });

  it("refuses a foreign marker and a non-empty unmarked directory", async () => {
    const dir = await provisionTarget();
    await writeFile(path.join(dir, LOCAL_TARGET_MARKER_NAME), localTargetMarkerContent(OTHER_TARGET));
    expect(await initLocalTarget(deps(), TARGET)).toEqual({ ok: false, problem: "local_target_unsafe" });
    await rm(path.join(dir, LOCAL_TARGET_MARKER_NAME));
    await writeFile(path.join(dir, "stray"), "x");
    expect(await initLocalTarget(deps(), TARGET)).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(dir)).toEqual(["stray"]);
  });

  it("refuses a symlinked target and a missing root, creating nothing", async () => {
    await symlink(outside, path.join(root, TARGET));
    expect(await initLocalTarget(deps(), TARGET)).toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(await readdir(outside)).toEqual([]);
    await rm(root, { recursive: true });
    expect(await initLocalTarget(deps(), TARGET)).toEqual({ ok: false, problem: "local_target_unmounted" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the guard result: read-only, no space and a disabled root", async () => {
    const ro = deps({ open: async () => Promise.reject(Object.assign(new Error("ro"), { code: "EROFS" })) });
    expect(await initLocalTarget(ro, TARGET)).toEqual({ ok: false, problem: "local_target_readonly" });
    expect(await initLocalTarget(deps({ statfs: async () => roomy(1n) }), OTHER_TARGET)).toEqual({ ok: false, problem: "no_space" });
    expect(await initLocalTarget(deps({ root: null }), TARGET)).toEqual({ ok: false, problem: "local_target_unsafe" });
    await expect(initLocalTarget(deps(), "../x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
