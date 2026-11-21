import { randomBytes } from "node:crypto";
import { constants as fsc, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { BACKUP_DISK_FREE_FLOOR_BYTES } from "./backup-jobs.js";
import type { BackupResticRepoKind, GuardedLocalRepo } from "./backup-jobs.js";
import { assertSafeIdentifier, ExecutorCodedError } from "./traefik-config.js";

/**
 * Guard for local backup repositories (HCP-SPEC-004 E4/E8). Every path is walked one segment at a time through
 * `/proc/self/fd/<parent>/<segment>` with O_NOFOLLOW|O_DIRECTORY, so a symlink planted at any level is refused and
 * no operation ever follows one. Only this module can produce a GuardedLocalRepo.
 */
export type LocalTargetIntent = "init" | "test" | "backup" | "forget" | "panelBackup" | "restore" | "archive";
export type LocalTargetProblem =
  | "local_target_unmounted"
  | "local_target_readonly"
  | "local_target_unsafe"
  | "no_space"
  | "other";

export interface LocalStatfs {
  readonly bsize: bigint;
  readonly blocks: bigint;
  readonly bavail: bigint;
  readonly files: bigint;
  readonly ffree: bigint;
}

export interface LocalTargetGuardDeps {
  /** null = HP_BACKUP_LOCAL_ROOT invalid: every call answers local_target_unsafe. */
  readonly root: string | null;
  readonly executorUid: number;
  readonly executorGid: number;
  /** Test seams. */
  readonly statfs?: (path: string, options: { readonly bigint: true }) => Promise<LocalStatfs>;
  readonly open?: (path: string, flags: number, mode: number) => Promise<FileHandle>;
  readonly randomHex?: (bytes: number) => string;
}

export type LocalTargetResult<T> = { readonly ok: true; readonly repo: T } | { readonly ok: false; readonly problem: LocalTargetProblem };

export const LOCAL_TARGET_MARKER_NAME = ".hp-local-target";
export const localTargetMarkerContent = (targetId: string): string => `hosting-panel local backup target ${targetId}\n`;
export const LOCAL_REPO_DIR_MODE = 0o2770;
export const LOCAL_TARGET_DIR_MODE = 0o700;
export const LOCAL_TARGET_ID_PATTERN = /^bkt_[0-9a-f]{32}$/;

const DIR_FLAGS = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;
const MARKER_MAX_BYTES = 256;
const ROOT_CHARS = /^[A-Za-z0-9._@+/-]+$/;
const FORBIDDEN_ROOTS = ["/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/root", "/var/lib/docker"] as const;
const WRITE_INTENTS: ReadonlySet<LocalTargetIntent> = new Set(["init", "test", "backup", "forget", "panelBackup"]);
/**
 * SPEC 6.5.5: the 1 GiB floor protects the disk from backups that add data, so only intents that grow the repository
 * carry it. forget (retention) frees space and restore/archive only read the repository (their destination is checked
 * elsewhere): they need just a small working margin for restic's lock files and the prune/index rewrite.
 */
export const LOCAL_TARGET_WORKING_MARGIN_BYTES = 64 * 1024 * 1024;
const FLOOR_INTENTS: ReadonlySet<LocalTargetIntent> = new Set(["init", "test", "backup", "panelBackup"]);
/** A probe file older than this is a leftover of a crashed guard. */
const STALE_PROBE_MS = 5 * 60_000;
const PROBE_NAME = /^\.hp-probe-[0-9a-f]{8}$/;

class Refusal extends Error {
  public constructor(public readonly problem: LocalTargetProblem) {
    super(problem);
  }
}

const refuse = (problem: LocalTargetProblem): Refusal => new Refusal(problem);
const errno = (e: unknown): string => (e as NodeJS.ErrnoException | undefined)?.code ?? "";
const noop = (): undefined => undefined;
const fdPath = (fh: FileHandle, ...rest: string[]): string => path.posix.join("/proc/self/fd", String(fh.fd), ...rest);
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

function mapFsError(e: unknown): LocalTargetProblem {
  switch (errno(e)) {
    case "ENOENT":
    case "ESTALE":
    case "ENODEV":
    case "ENXIO":
    case "EIO":
      return "local_target_unmounted";
    case "EROFS":
      return "local_target_readonly";
    case "ENOSPC":
    case "EDQUOT":
      return "no_space";
    default: // ELOOP, ENOTDIR, EACCES, EPERM, EEXIST, ...
      return "local_target_unsafe";
  }
}

/**
 * Validates HP_BACKUP_LOCAL_ROOT once at startup. Returns the root or null (local targets disabled).
 * `forbidden` = directories the executor owns for other purposes: the root may be neither inside nor above them.
 */
export function validateLocalRepoRoot(raw: string | undefined, forbidden: readonly string[]): string | null {
  if (raw === undefined || raw.length === 0 || !path.isAbsolute(raw)) return null;
  if (path.normalize(raw) !== raw || raw.endsWith("/") || !ROOT_CHARS.test(raw)) return null;
  if (raw.split("/").filter(Boolean).length < 2) return null;
  for (const other of [...FORBIDDEN_ROOTS, ...forbidden]) {
    const o = path.normalize(other).replace(/\/+$/, "");
    if (o.length > 0 && (inside(raw, o) || inside(o, raw))) return null;
  }
  return raw;
}

function checkDirStat(st: BigIntStats, deps: LocalTargetGuardDeps, exactMode?: number): void {
  const mode = Number(st.mode) & 0o7777;
  if (!st.isDirectory() || Number(st.uid) !== deps.executorUid) throw refuse("local_target_unsafe");
  if (exactMode === undefined ? (mode & 0o022) !== 0 : mode !== exactMode || Number(st.gid) !== deps.executorGid) {
    throw refuse("local_target_unsafe");
  }
}

/** Opens a directory without following a final symlink; undefined when it does not exist. */
async function tryOpenDir(p: string): Promise<FileHandle | undefined> {
  try {
    return await open(p, DIR_FLAGS);
  } catch (e) {
    if (errno(e) === "ENOENT") return undefined;
    throw refuse(mapFsError(e));
  }
}

interface SegmentOptions {
  readonly create: boolean;
  readonly mode: number;
  /** Required exact mode+gid (the repo leaf); otherwise "no group/other write". */
  readonly exact?: boolean;
  readonly missing: LocalTargetProblem;
}

async function openSegment(
  deps: LocalTargetGuardDeps,
  track: (fh: FileHandle) => FileHandle,
  parent: FileHandle,
  name: string,
  o: SegmentOptions,
): Promise<{ readonly fh: FileHandle; readonly created: boolean }> {
  const p = fdPath(parent, name);
  let fh = await tryOpenDir(p);
  let created = false;
  if (!fh) {
    if (!o.create) throw refuse(o.missing);
    try {
      await mkdir(p, 0o700);
      created = true;
    } catch (e) {
      if (errno(e) !== "EEXIST") throw refuse(mapFsError(e));
    }
    fh = await tryOpenDir(p);
    if (!fh) throw refuse("local_target_unsafe");
  }
  track(fh);
  try {
    if (created) await fh.chmod(o.mode); // fchmod on the held fd: mkdir's mode is umask-filtered
    checkDirStat(await fh.stat({ bigint: true }), deps, o.exact ? o.mode : undefined);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw refuse(mapFsError(e));
  }
  return { fh, created };
}

async function openRoot(deps: LocalTargetGuardDeps, track: (fh: FileHandle) => FileHandle): Promise<FileHandle> {
  const root = deps.root;
  if (root === null) throw refuse("local_target_unsafe");
  const fh = await tryOpenDir(root);
  if (!fh) throw refuse("local_target_unmounted");
  track(fh);
  try {
    // A symlinked ancestor makes the fd's real path differ from the configured one.
    if ((await readlink(fdPath(fh))) !== root) throw refuse("local_target_unsafe");
    checkDirStat(await fh.stat({ bigint: true }), deps);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw refuse(mapFsError(e));
  }
  return fh;
}

async function readMarker(target: FileHandle, deps: LocalTargetGuardDeps): Promise<string | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(fdPath(target, LOCAL_TARGET_MARKER_NAME), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    if (errno(e) === "ENOENT") return undefined;
    throw refuse(mapFsError(e));
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || Number(st.uid) !== deps.executorUid || st.size > BigInt(MARKER_MAX_BYTES)) {
      throw refuse("local_target_unsafe");
    }
    const buf = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw refuse(mapFsError(e));
  } finally {
    await fh.close().catch(noop);
  }
}

/** Removes crash leftovers: owned regular `.hp-probe-*` files older than STALE_PROBE_MS. Best effort, never follows links. */
async function removeStaleProbes(deps: LocalTargetGuardDeps, leaf: FileHandle): Promise<void> {
  try {
    for (const name of await readdir(fdPath(leaf))) {
      if (!PROBE_NAME.test(name)) continue;
      const p = fdPath(leaf, name);
      const st = await lstat(p, { bigint: true });
      if (st.isFile() && Number(st.uid) === deps.executorUid && Date.now() - Number(st.mtimeMs) > STALE_PROBE_MS) await unlink(p);
    }
  } catch {
    // a failed cleanup must not turn a healthy target unsafe
  }
}

async function writeProbe(deps: LocalTargetGuardDeps, leaf: FileHandle): Promise<void> {
  await removeStaleProbes(deps, leaf);
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  const p = fdPath(leaf, `.hp-probe-${hex(4)}`);
  let fh: FileHandle;
  try {
    fh = await (deps.open ?? open)(p, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw refuse(mapFsError(e));
  }
  try {
    await fh.write("x");
    await fh.sync();
  } catch (e) {
    throw refuse(mapFsError(e));
  } finally {
    await fh.close().catch(noop);
    await unlink(p).catch(noop);
  }
}

async function measure(
  deps: LocalTargetGuardDeps,
  leaf: FileHandle,
  extraBytes: number,
  intent: LocalTargetIntent,
): Promise<{ readonly availableBytes: number; readonly totalBytes: number }> {
  let st: LocalStatfs;
  try {
    st = await (deps.statfs ?? ((p, o) => statfs(p, o)))(fdPath(leaf), { bigint: true });
  } catch {
    throw refuse("local_target_unmounted");
  }
  const available = st.bavail * st.bsize;
  const margin = FLOOR_INTENTS.has(intent) ? BACKUP_DISK_FREE_FLOOR_BYTES : LOCAL_TARGET_WORKING_MARGIN_BYTES;
  const need = BigInt(margin) + BigInt(extraBytes);
  if (available < need || (st.files > 0n && st.ffree === 0n)) throw refuse("no_space");
  const clamp = (n: bigint): number => Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n);
  return { availableBytes: clamp(available), totalBytes: clamp(st.blocks * st.bsize) };
}

function assertIds(targetId: string, scope: BackupResticRepoKind): void {
  if (!LOCAL_TARGET_ID_PATTERN.test(targetId)) {
    throw new ExecutorCodedError("Invalid local backup target id", "VALIDATION_ERROR");
  }
  if (scope.kind === "site") assertSafeIdentifier(scope.siteId, "siteId");
}

function leafLocation(
  root: string,
  targetId: string,
  scope: BackupResticRepoKind,
): { readonly hostDir: string; readonly containerPath: string; readonly segments: readonly string[] } {
  const segments = scope.kind === "site" ? ["sites", scope.siteId] : ["panel"];
  return {
    hostDir: path.posix.join(root, targetId, ...segments),
    containerPath: path.posix.join("/backup/repository", ...segments),
    segments,
  };
}

async function runGuard(
  deps: LocalTargetGuardDeps,
  track: (fh: FileHandle) => FileHandle,
  req: { readonly targetId: string; readonly scope: BackupResticRepoKind; readonly intent: LocalTargetIntent; readonly requiredExtraBytes: number },
): Promise<GuardedLocalRepo> {
  const rootFh = await openRoot(deps, track);
  const root = deps.root as string;
  const target = (await openSegment(deps, track, rootFh, req.targetId, { create: false, mode: LOCAL_TARGET_DIR_MODE, missing: "local_target_unmounted" })).fh;
  // An empty mountpoint of an unmounted disk has no marker.
  const marker = await readMarker(target, deps);
  if (marker !== localTargetMarkerContent(req.targetId)) throw refuse("local_target_unmounted");

  const write = WRITE_INTENTS.has(req.intent);
  const loc = leafLocation(root, req.targetId, req.scope);
  let dir = target;
  for (const [i, name] of loc.segments.entries()) {
    const isLeaf = i === loc.segments.length - 1;
    dir = (
      await openSegment(deps, track, dir, name, {
        create: write,
        mode: isLeaf ? LOCAL_REPO_DIR_MODE : LOCAL_TARGET_DIR_MODE,
        exact: isLeaf,
        missing: "other",
      })
    ).fh;
  }

  // Re-check: the path we will hand to Docker is canonical and is the directory we hold.
  try {
    const held = await dir.stat({ bigint: true });
    const seen = await lstat(loc.hostDir, { bigint: true });
    if ((await realpath(loc.hostDir)) !== loc.hostDir || seen.dev !== held.dev || seen.ino !== held.ino) {
      throw refuse("local_target_unsafe");
    }
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw refuse(mapFsError(e));
  }

  await writeProbe(deps, dir);
  const space = await measure(deps, dir, req.requiredExtraBytes, req.intent);
  return { hostDir: loc.hostDir, containerPath: loc.containerPath, executorGid: deps.executorGid, ...space };
}

async function withHandles<T>(
  fn: (track: (fh: FileHandle) => FileHandle) => Promise<T>,
): Promise<{ readonly ok: true; readonly repo: T } | { readonly ok: false; readonly problem: LocalTargetProblem }> {
  const handles: FileHandle[] = [];
  try {
    return { ok: true, repo: await fn((fh) => (handles.push(fh), fh)) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, problem: e.problem };
    throw e;
  } finally {
    await Promise.all(handles.map((h) => h.close().catch(noop)));
  }
}

/** Runs immediately before every container that binds a local repo. Never creates `<root>/<targetId>`. */
export async function guardLocalTarget(
  deps: LocalTargetGuardDeps,
  req: {
    readonly targetId: string;
    readonly scope: BackupResticRepoKind;
    readonly intent: LocalTargetIntent;
    readonly requiredExtraBytes: number;
  },
): Promise<LocalTargetResult<GuardedLocalRepo>> {
  assertIds(req.targetId, req.scope);
  if (!Number.isSafeInteger(req.requiredExtraBytes) || req.requiredExtraBytes < 0) {
    throw new ExecutorCodedError("Invalid required byte estimate", "VALIDATION_ERROR");
  }
  return withHandles((track) => runGuard(deps, track, req));
}

/**
 * The only code path that creates `<root>/<targetId>`: directory 0700, marker (atomic), `sites/` 0700, `panel/` 2770,
 * then the full guard on the panel repo. Idempotent; a foreign marker or a non-empty unmarked directory is unsafe.
 */
export async function initLocalTarget(
  deps: LocalTargetGuardDeps,
  targetId: string,
): Promise<LocalTargetResult<GuardedLocalRepo>> {
  const scope: BackupResticRepoKind = { kind: "panel" };
  assertIds(targetId, scope);
  return withHandles(async (track) => {
    const rootFh = await openRoot(deps, track);
    const target = (await openSegment(deps, track, rootFh, targetId, { create: true, mode: LOCAL_TARGET_DIR_MODE, missing: "local_target_unmounted" })).fh;
    const expected = localTargetMarkerContent(targetId);
    const existing = await readMarker(target, deps);
    if (existing !== undefined) {
      if (existing !== expected) throw refuse("local_target_unsafe");
    } else {
      try {
        if ((await readdir(fdPath(target))).length > 0) throw refuse("local_target_unsafe");
        const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
        const tmp = fdPath(target, `${LOCAL_TARGET_MARKER_NAME}.${hex(4)}.tmp`);
        const fh = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
        try {
          await fh.write(expected);
          await fh.sync();
        } finally {
          await fh.close().catch(noop);
        }
        await rename(tmp, fdPath(target, LOCAL_TARGET_MARKER_NAME));
        await target.sync();
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw refuse(mapFsError(e));
      }
    }
    await openSegment(deps, track, target, "sites", { create: true, mode: LOCAL_TARGET_DIR_MODE, missing: "other" });
    await openSegment(deps, track, target, "panel", { create: true, mode: LOCAL_REPO_DIR_MODE, exact: true, missing: "other" });
    const guarded = await runGuard(deps, track, { targetId, scope, intent: "init", requiredExtraBytes: 0 });
    return guarded;
  });
}
