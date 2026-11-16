import {
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_PATH_MAX,
  SITE_FILE_REASON_CODES,
  SITE_FILE_SEGMENT_MAX_BYTES,
  SITE_FILES_LIST_MAX,
  SITE_FILES_MAX_FILE_BYTES,
  SITE_IMPORT_LEFT_OUT,
  SiteFilesIpcRequestSchema,
  type SiteFileEntryDto,
  type SiteFileErrorReason,
  type SiteImportOp,
} from "@hosting-panel/contracts";
import type { SiteFilesRequest, SiteFilesResult } from "@hosting-panel/executor-contracts";
import { ExecutorIpcClientError } from "./client.js";
import { ExecutorCodedError } from "./traefik-config.js";

const VIRTUAL_FILES_ROOT = "/var/www/html";
const MAX_SYMLINK_HOPS = 40;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_BYTES = 1_073_741_824;
const MAX_ARCHIVE_DEPTH = 32;
const ARCHIVE_BOMB_THRESHOLD = 1_048_576;
const ARCHIVE_BOMB_RATIO = 200;
const MAX_IMPORT_ENTRIES = 200_000;
const MAX_IMPORT_BYTES = 4_294_967_296;
const DUMP_SNIFF_BYTES = 4096;
const SIM_ZIP_MAGIC = Buffer.from("HPSIMZIP\n", "utf8");
const PROTECTED_TARGETS: readonly string[] = ["wp-content/mu-plugins/hp-mail.php"];
const REASON_SET: ReadonlySet<string> = new Set(SITE_FILE_ERROR_REASONS);

/** Seed entry accepted by `SimulatedSiteFiles.seed()` for tests. */
export type SimSeedEntry =
  | {
      readonly path: string;
      readonly kind: "dir";
      readonly writable?: boolean;
      readonly mtime?: Date;
    }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly data?: Buffer | string;
      readonly writable?: boolean;
      readonly mtime?: Date;
    }
  | {
      readonly path: string;
      readonly kind: "link";
      readonly target: string;
      readonly mtime?: Date;
    };

interface SimDir {
  readonly type: "dir";
  readonly children: Map<string, SimNode>;
  mtime: Date;
  writable: boolean;
}

interface SimFile {
  readonly type: "file";
  data: Buffer;
  mtime: Date;
  writable: boolean;
}

interface SimLink {
  readonly type: "link";
  target: string;
  mtime: Date;
}

type SimNode = SimDir | SimFile | SimLink;

type ImportSlot = "archive" | "dump";
type ImportRequest = Extract<SiteFilesRequest, { op: SiteImportOp }>;
/** What `failNextImport` makes the next call of an `import.*` operation do. */
export type SimImportOutcome = SiteFileErrorReason | "undo_incomplete" | "timeout";

/** A slot's bytes; `uploadId` is set while the upload is partial. */
interface SimSlot {
  readonly data: Buffer;
  readonly uploadId: string | null;
}

/** The entries `import.switch` moved: live ones set aside, imported ones put in. */
interface SimImportPlan {
  readonly aside: SimDir;
  readonly asideWp: SimDir;
  readonly inRoot: readonly string[];
  readonly inWp: readonly string[];
}

/** One import's work folder: the unpacked WordPress root and, after the switch, its plan. */
interface SimImportWork {
  readonly site: SimDir;
  plan: SimImportPlan | null;
}

interface SimImportState {
  readonly slots: Map<ImportSlot, SimSlot>;
  readonly work: Map<string, SimImportWork>;
}

interface ResolvedParent {
  readonly dir: SimDir;
  readonly dirSegments: readonly string[];
  readonly parentReal: string;
  readonly base: string;
  readonly realRel: string;
}

interface ResolvedTarget {
  readonly node: SimDir | SimFile;
  readonly realSegments: readonly string[];
  readonly realRel: string;
}

interface SimArchiveEntry {
  readonly p: string;
  readonly d?: string;
  readonly link?: string;
  readonly s?: number;
}

type ParsedExtractEntry =
  | { readonly kind: "dir"; readonly name: string; readonly segments: readonly string[] }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly segments: readonly string[];
      readonly data: Buffer;
    };

function fileError(reason: SiteFileErrorReason): ExecutorCodedError {
  return new ExecutorCodedError(reason, SITE_FILE_REASON_CODES[reason]);
}

function compareByteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isProtected(realRel: string): boolean {
  if (realRel === "") {
    return true;
  }
  return PROTECTED_TARGETS.some(
    (target) => realRel === target || target.startsWith(`${realRel}/`),
  );
}

function makeDir(writable = true, mtime = new Date()): SimDir {
  return { type: "dir", children: new Map(), mtime, writable };
}

function makeFile(data: Buffer | string, writable = true, mtime = new Date()): SimFile {
  const buf = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
  return { type: "file", data: buf, mtime, writable };
}

function createDefaultWordpressTree(): SimDir {
  const now = new Date();
  const root = makeDir(true, now);
  root.children.set(
    "index.php",
    makeFile("<?php\n// Silence is golden.\n", true, now),
  );
  root.children.set(
    "wp-config.php",
    makeFile("<?php\n// Simulated WordPress configuration.\n", true, now),
  );

  const wpContent = makeDir(true, now);
  wpContent.children.set("plugins", makeDir(true, now));
  wpContent.children.set("themes", makeDir(true, now));
  wpContent.children.set("uploads", makeDir(true, now));

  const muPlugins = makeDir(false, now);
  muPlugins.children.set(
    "hp-mail.php",
    makeFile("<?php\n// Managed outgoing mail hook.\n", false, now),
  );
  wpContent.children.set("mu-plugins", muPlugins);
  root.children.set("wp-content", wpContent);

  return root;
}

function parseRequest(rawReq: unknown): SiteFilesRequest {
  const parsed = SiteFilesIpcRequestSchema.safeParse(rawReq);
  if (!parsed.success) {
    const rawOp =
      typeof rawReq === "object" && rawReq !== null
        ? (rawReq as Record<string, unknown>).op
        : undefined;
    for (const issue of parsed.error.issues) {
      if (REASON_SET.has(issue.message)) {
        throw fileError(issue.message as SiteFileErrorReason);
      }
      if (
        issue.code === "too_big" &&
        (issue.path[0] === "dataBase64" ||
          ((rawOp === "write" || rawOp === "import.put") && issue.path[0] === "offset"))
      ) {
        throw fileError("too_large");
      }
    }
    throw fileError("invalid_path");
  }

  const req = parsed.data;
  if (req.op === "write" || req.op === "import.put") {
    const decoded = Buffer.from(req.dataBase64, "base64");
    if (decoded.length > SITE_FILE_CHUNK_BYTES) {
      throw fileError("too_large");
    }
    if (req.offset + decoded.length > SITE_FILES_MAX_FILE_BYTES) {
      throw fileError("too_large");
    }
  }

  if (req.op === "move") {
    if (req.from === req.to || req.to.startsWith(`${req.from}/`)) {
      throw fileError("invalid_path");
    }
  }

  return req;
}

function dirAt(root: SimDir, segments: readonly string[]): SimDir {
  let cur: SimNode = root;
  for (const seg of segments) {
    if (cur.type !== "dir") {
      throw fileError("not_a_directory");
    }
    const next = cur.children.get(seg);
    if (!next) {
      throw fileError("not_found");
    }
    if (next.type !== "dir") {
      throw fileError("not_a_directory");
    }
    cur = next;
  }
  return cur;
}

function applyLinkTarget(
  target: string,
  currentDirPos: readonly string[],
): { pos: string[]; segments: string[] } {
  if (target === "") {
    throw fileError("not_found");
  }
  if (target.startsWith("/")) {
    const collapsed = target.replace(/\/+/g, "/");
    if (collapsed === VIRTUAL_FILES_ROOT) {
      return { pos: [], segments: [] };
    }
    if (collapsed.startsWith(`${VIRTUAL_FILES_ROOT}/`)) {
      const rest = collapsed.slice(VIRTUAL_FILES_ROOT.length + 1);
      return { pos: [], segments: rest === "" ? [] : rest.split("/") };
    }
    throw fileError("protected");
  }
  return { pos: [...currentDirPos], segments: target.split("/") };
}

function walkNode(
  root: SimDir,
  startSegments: readonly string[],
  segments: readonly string[],
  initialHops: number,
): ResolvedTarget {
  let pos = [...startSegments];
  let curDir = dirAt(root, pos);
  let remaining = [...segments];
  let hops = initialHops;

  while (remaining.length > 0) {
    const seg = remaining.shift()!;
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (pos.length === 0) {
        throw fileError("protected");
      }
      pos.pop();
      curDir = dirAt(root, pos);
      continue;
    }

    const next = curDir.children.get(seg);
    if (!next) {
      throw fileError("not_found");
    }
    if (next.type === "link") {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw fileError("not_found");
      }
      const expanded = applyLinkTarget(next.target, pos);
      pos = expanded.pos;
      curDir = dirAt(root, pos);
      remaining = [...expanded.segments, ...remaining];
      continue;
    }
    if (next.type === "dir") {
      pos.push(seg);
      curDir = next;
      continue;
    }

    if (remaining.length > 0) {
      throw fileError("not_a_directory");
    }
    const realSegments = [...pos, seg];
    return { node: next, realSegments, realRel: realSegments.join("/") };
  }

  return { node: curDir, realSegments: pos, realRel: pos.join("/") };
}

function resolveParent(root: SimDir, relPath: string): ResolvedParent {
  const parts = relPath.split("/");
  const base = parts[parts.length - 1]!;
  const parentParts = parts.slice(0, -1);
  const resolved = walkNode(root, [], parentParts, 0);
  if (resolved.node.type !== "dir") {
    throw fileError("not_a_directory");
  }
  const parentReal = resolved.realRel;
  const realRel = parentReal === "" ? base : `${parentReal}/${base}`;
  return {
    dir: resolved.node,
    dirSegments: resolved.realSegments,
    parentReal,
    base,
    realRel,
  };
}

function followTarget(root: SimDir, relPath: string): ResolvedTarget {
  if (relPath === "") {
    return { node: root, realSegments: [], realRel: "" };
  }
  const parent = resolveParent(root, relPath);
  const entry = parent.dir.children.get(parent.base);
  if (!entry) {
    throw fileError("not_found");
  }
  if (entry.type === "link") {
    const expanded = applyLinkTarget(entry.target, parent.dirSegments);
    return walkNode(root, expanded.pos, expanded.segments, 1);
  }
  const realSegments = [...parent.dirSegments, parent.base];
  return { node: entry, realSegments, realRel: realSegments.join("/") };
}

function toEntryDto(name: string, node: SimNode, parentWritable: boolean): SiteFileEntryDto {
  if (node.type === "dir") {
    return {
      name,
      kind: "dir",
      size: 0,
      modifiedAt: node.mtime.toISOString(),
      writable: node.writable,
    };
  }
  if (node.type === "file") {
    return {
      name,
      kind: "file",
      size: node.data.length,
      modifiedAt: node.mtime.toISOString(),
      writable: node.writable,
    };
  }
  return {
    name,
    kind: "link",
    size: Buffer.byteLength(node.target, "utf8"),
    modifiedAt: node.mtime.toISOString(),
    writable: parentWritable,
  };
}

function assertDeletableSubtree(dir: SimDir, dirRel: string): void {
  for (const [name, child] of dir.children) {
    const childRel = `${dirRel}/${name}`;
    if (isProtected(childRel)) {
      throw fileError("protected");
    }
    if (child.type === "dir" && child.children.size > 0) {
      if (!child.writable) {
        throw fileError("protected");
      }
      assertDeletableSubtree(child, childRel);
    }
  }
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isValidArchiveEntryName(name: string): boolean {
  if (
    name === "" ||
    name.length > SITE_FILE_PATH_MAX ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name) ||
    hasControlChar(name)
  ) {
    return false;
  }
  const segments = name.split("/");
  return segments.every(
    (seg) =>
      seg !== "" &&
      seg !== "." &&
      seg !== ".." &&
      !seg.startsWith(".htpanel-") &&
      Buffer.byteLength(seg, "utf8") <= SITE_FILE_SEGMENT_MAX_BYTES,
  );
}

function parseSimArchive(
  data: Buffer,
  maxEntries = MAX_ARCHIVE_ENTRIES,
  maxBytes = MAX_ARCHIVE_BYTES,
): ParsedExtractEntry[] {
  if (
    data.length < SIM_ZIP_MAGIC.length ||
    !data.subarray(0, SIM_ZIP_MAGIC.length).equals(SIM_ZIP_MAGIC)
  ) {
    throw fileError("not_a_zip");
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(data.subarray(SIM_ZIP_MAGIC.length).toString("utf8"));
  } catch {
    throw fileError("not_a_zip");
  }
  if (!Array.isArray(rawJson)) {
    throw fileError("not_a_zip");
  }
  if (rawJson.length > maxEntries) {
    throw fileError("archive_limit");
  }

  const seenExactNames = new Set<string>();
  const fileNames = new Set<string>();
  const impliedDirNames = new Set<string>();
  const parsedEntries: ParsedExtractEntry[] = [];
  let totalBytes = 0;

  for (const item of rawJson) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw fileError("not_a_zip");
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.p !== "string") {
      throw fileError("not_a_zip");
    }
    if (raw.link !== undefined) {
      if (typeof raw.link !== "string") {
        throw fileError("not_a_zip");
      }
      throw fileError("archive_unsafe");
    }
    if (raw.d !== undefined && typeof raw.d !== "string") {
      throw fileError("not_a_zip");
    }
    if (
      raw.s !== undefined &&
      (typeof raw.s !== "number" || !Number.isInteger(raw.s) || raw.s < 0)
    ) {
      throw fileError("not_a_zip");
    }

    const isDir = raw.d === undefined;
    const name = isDir && raw.p.endsWith("/") ? raw.p.slice(0, -1) : raw.p;
    if (!isValidArchiveEntryName(name)) {
      throw fileError("archive_unsafe");
    }
    if (seenExactNames.has(name)) {
      throw fileError("archive_unsafe");
    }
    seenExactNames.add(name);

    const segments = name.split("/");
    if (segments.length > MAX_ARCHIVE_DEPTH) {
      throw fileError("archive_limit");
    }

    for (let i = 1; i < segments.length; i += 1) {
      impliedDirNames.add(segments.slice(0, i).join("/"));
    }

    if (isDir) {
      impliedDirNames.add(name);
      parsedEntries.push({ kind: "dir", name, segments });
      continue;
    }

    const dStr = raw.d as string;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dStr) || dStr.length % 4 !== 0) {
      throw fileError("not_a_zip");
    }
    const decoded = Buffer.from(dStr, "base64");
    const declaredSize = typeof raw.s === "number" ? raw.s : decoded.length;
    if (
      declaredSize > ARCHIVE_BOMB_THRESHOLD &&
      declaredSize > ARCHIVE_BOMB_RATIO * Math.max(1, decoded.length)
    ) {
      throw fileError("archive_limit");
    }
    if (decoded.length > declaredSize || declaredSize > SITE_FILES_MAX_FILE_BYTES) {
      throw fileError("archive_limit");
    }
    totalBytes += declaredSize;
    if (totalBytes > maxBytes) {
      throw fileError("archive_limit");
    }

    fileNames.add(name);
    parsedEntries.push({ kind: "file", name, segments, data: decoded });
  }

  for (const fileName of fileNames) {
    if (impliedDirNames.has(fileName)) {
      throw fileError("archive_unsafe");
    }
  }

  return parsedEntries;
}

/** Writes checked archive entries under `target` (no conflict checks). */
function placeEntries(target: SimDir, entries: readonly ParsedExtractEntry[], now: Date): void {
  for (const entry of entries) {
    let cur = target;
    for (let i = 0; i < entry.segments.length - 1; i += 1) {
      const seg = entry.segments[i]!;
      let child = cur.children.get(seg);
      if (!child) {
        child = makeDir(true, now);
        cur.children.set(seg, child);
        cur.mtime = now;
      }
      cur = child as SimDir;
    }

    const leafName = entry.segments[entry.segments.length - 1]!;
    if (entry.kind === "dir") {
      if (!cur.children.has(leafName)) {
        cur.children.set(leafName, makeDir(true, now));
        cur.mtime = now;
      }
    } else {
      cur.children.set(leafName, makeFile(entry.data, true, now));
      cur.mtime = now;
    }
  }
}

/** Refuses a slot whose first bytes are not an archive (the simulator's zip) or an SQL export. */
function sniffSlot(slot: ImportSlot, data: Buffer): void {
  if (slot === "archive") {
    if (!data.subarray(0, SIM_ZIP_MAGIC.length).equals(SIM_ZIP_MAGIC)) {
      throw fileError("not_a_zip");
    }
  } else if (!(data[0] === 0x1f && data[1] === 0x8b) && data.subarray(0, DUMP_SNIFF_BYTES).includes(0)) {
    throw fileError("dump_not_sql");
  }
}

function isWordpressRoot(dir: SimDir): boolean {
  const includes = dir.children.get("wp-includes");
  return (
    includes?.type === "dir" &&
    includes.children.get("version.php")?.type === "file" &&
    dir.children.get("wp-load.php")?.type === "file" &&
    dir.children.get("wp-content")?.type === "dir"
  );
}

/** Root names the switch never moves (the helper's skip list). */
function keepsRootName(name: string): boolean {
  return (
    [".htaccess", "wp-config.php", "wp-content", ".maintenance"].includes(name) ||
    name.startsWith(".hp_rs_") ||
    name.startsWith(".htpanel-")
  );
}

/** Moves the named children of `from` that `to` lacks; returns the names moved. */
function moveNames(from: SimDir, to: SimDir, names: readonly string[]): string[] {
  const moved: string[] = [];
  for (const name of names) {
    const node = from.children.get(name);
    if (node && !to.children.has(name)) {
      to.children.set(name, node);
      from.children.delete(name);
      moved.push(name);
    }
  }
  return moved;
}

function snapshotNode(node: SimNode): unknown {
  const modifiedAt = node.mtime.toISOString();
  if (node.type === "file") {
    return {
      type: "file",
      writable: node.writable,
      modifiedAt,
      size: node.data.length,
      data: Buffer.from(node.data),
    };
  }
  if (node.type === "link") {
    return {
      type: "link",
      target: node.target,
      modifiedAt,
    };
  }
  const children: Record<string, unknown> = {};
  const sortedNames = [...node.children.keys()].sort(compareByteOrder);
  for (const name of sortedNames) {
    children[name] = snapshotNode(node.children.get(name)!);
  }
  return {
    type: "dir",
    writable: node.writable,
    modifiedAt,
    children,
  };
}

/**
 * In-memory simulation of per-service WordPress file trees for the simulator executor backend.
 * Implements the same confinement, protected-path, upload-staging, and archive limits as the real helper.
 */
export class SimulatedSiteFiles {
  private readonly trees = new Map<string, SimDir>();
  private readonly staging = new Map<string, Buffer>();
  private readonly imports = new Map<string, SimImportState>();
  private readonly importFailures = new Map<SiteImportOp, SimImportOutcome>();

  /** Dispatches a validated `SiteFilesRequest` against the service's in-memory tree. */
  public async handle<R extends SiteFilesRequest>(rawReq: R): Promise<SiteFilesResult<R["op"]>> {
    const req = parseRequest(rawReq);
    const root = this.trees.get(req.serviceInstanceId);
    if (!root) {
      throw fileError("not_found");
    }

    switch (req.op) {
      case "list":
        return this.handleList(root, req.path) as SiteFilesResult<R["op"]>;
      case "stat":
        return this.handleStat(root, req.path) as SiteFilesResult<R["op"]>;
      case "read":
        return this.handleRead(root, req.path, req.offset, req.length) as SiteFilesResult<R["op"]>;
      case "write":
        return this.handleWrite(root, req) as SiteFilesResult<R["op"]>;
      case "mkdir":
        return this.handleMkdir(root, req.path) as SiteFilesResult<R["op"]>;
      case "move":
        return this.handleMove(root, req.from, req.to) as SiteFilesResult<R["op"]>;
      case "delete":
        return this.handleDelete(root, req.paths) as SiteFilesResult<R["op"]>;
      case "archive":
        return this.handleArchive(root, req.paths, req.to) as SiteFilesResult<R["op"]>;
      case "extract":
        return this.handleExtract(root, req.path, req.to) as SiteFilesResult<R["op"]>;
      default:
        return this.handleImport(root, req) as SiteFilesResult<R["op"]>;
    }
  }

  /** Makes the next call of `op` fail with a reason, answer an incomplete undo, or time out after its effect. */
  public failNextImport(op: SiteImportOp, outcome: SimImportOutcome): void {
    if (outcome === "undo_incomplete" && op !== "import.undo") {
      throw new Error("undo_incomplete applies to import.undo only");
    }
    this.importFailures.set(op, outcome);
  }

  /** Read-only view for tests: whether the import gate is on, and which imports hold a plan. */
  public importState(svc: string): { gate: boolean; plans: string[] } {
    const work = this.imports.get(svc)?.work ?? new Map<string, SimImportWork>();
    const plans = [...work].filter(([, w]) => w.plan !== null).map(([id]) => id).sort();
    return { gate: plans.length > 0, plans };
  }

  /** Creates the miniature WordPress file tree if this service does not yet have one. */
  public create(svc: string): void {
    // Preserve an existing tree on service redeploy, matching persistent Docker named volumes.
    if (!this.trees.has(svc)) {
      this.trees.set(svc, createDefaultWordpressTree());
    }
  }

  /** Removes the service's in-memory file tree and any pending upload staging buffers. */
  public drop(svc: string): void {
    this.trees.delete(svc);
    this.imports.delete(svc);
    const prefix = `${svc}\0`;
    for (const key of [...this.staging.keys()]) {
      if (key.startsWith(prefix)) {
        this.staging.delete(key);
      }
    }
  }

  /** Populates or extends a service's in-memory file tree for test scenarios. */
  public seed(svc: string, entries: SimSeedEntry[]): void {
    let root = this.trees.get(svc);
    if (!root) {
      root = makeDir(true);
      this.trees.set(svc, root);
    }

    for (const entry of entries) {
      const normalized = entry.path.replace(/\/{2,}/g, "/").replace(/\/$/, "");
      if (normalized === "") {
        if (entry.kind === "dir") {
          if (entry.writable !== undefined) {
            root.writable = entry.writable;
          }
          if (entry.mtime !== undefined) {
            root.mtime = entry.mtime;
          }
        }
        continue;
      }

      const parts = normalized.split("/");
      let cur = root;
      for (const part of parts.slice(0, -1)) {
        let next = cur.children.get(part);
        if (!next) {
          next = makeDir(true, entry.mtime ?? new Date());
          cur.children.set(part, next);
        }
        if (next.type !== "dir") {
          throw new Error(`Cannot seed '${entry.path}': intermediate segment '${part}' is not a dir`);
        }
        cur = next;
      }

      const leaf = parts[parts.length - 1]!;
      const mtime = entry.mtime ?? new Date();
      if (entry.kind === "dir") {
        const existing = cur.children.get(leaf);
        if (existing && existing.type === "dir") {
          if (entry.writable !== undefined) {
            existing.writable = entry.writable;
          }
          if (entry.mtime !== undefined) {
            existing.mtime = entry.mtime;
          }
        } else {
          cur.children.set(leaf, makeDir(entry.writable ?? true, mtime));
        }
      } else if (entry.kind === "file") {
        cur.children.set(
          leaf,
          makeFile(entry.data ?? Buffer.alloc(0), entry.writable ?? true, mtime),
        );
      } else {
        cur.children.set(leaf, { type: "link", target: entry.target, mtime });
      }
    }
  }

  /** Returns a deep-cloned, deterministic snapshot of the service tree, or `null` when absent. */
  public snapshot(svc: string): unknown {
    const root = this.trees.get(svc);
    return root ? snapshotNode(root) : null;
  }

  private handleList(root: SimDir, relPath: string): SiteFilesResult<"list"> {
    const target = followTarget(root, relPath);
    if (target.node.type !== "dir") {
      throw fileError("not_a_directory");
    }

    const entries: SiteFileEntryDto[] = [];
    let truncated = false;
    for (const [name, child] of target.node.children) {
      if (name.startsWith(".htpanel-")) {
        continue;
      }
      if (entries.length >= SITE_FILES_LIST_MAX) {
        truncated = true;
        break;
      }
      entries.push(toEntryDto(name, child, target.node.writable));
    }

    entries.sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      return aDir !== bDir ? aDir - bDir : compareByteOrder(a.name, b.name);
    });

    return { entries, truncated };
  }

  private handleStat(root: SimDir, relPath: string): SiteFilesResult<"stat"> {
    if (relPath === "") {
      return {
        entry: {
          name: "",
          kind: "dir",
          size: 0,
          modifiedAt: root.mtime.toISOString(),
          writable: root.writable,
        },
      };
    }

    const parent = resolveParent(root, relPath);
    const child = parent.dir.children.get(parent.base);
    if (!child || parent.base.startsWith(".htpanel-")) {
      throw fileError("not_found");
    }
    return { entry: toEntryDto(parent.base, child, parent.dir.writable) };
  }

  private handleRead(
    root: SimDir,
    relPath: string,
    offset: number,
    length: number,
  ): SiteFilesResult<"read"> {
    const target = followTarget(root, relPath);
    if (target.node.type !== "file") {
      throw fileError("is_a_directory");
    }

    const size = target.node.data.length;
    if (offset > size) {
      throw fileError("upload_mismatch");
    }
    const end = Math.min(size, offset + length);
    const slice = target.node.data.subarray(offset, end);
    return {
      dataBase64: slice.toString("base64"),
      size,
      eof: end >= size,
    };
  }

  private handleWrite(
    root: SimDir,
    req: Extract<SiteFilesRequest, { op: "write" }>,
  ): SiteFilesResult<"write"> {
    const chunk = Buffer.from(req.dataBase64, "base64");
    const parent = resolveParent(root, req.path);

    const existing = parent.dir.children.get(parent.base);
    if (isProtected(parent.realRel) || !parent.dir.writable) {
      throw fileError("protected");
    }
    if (existing) {
      if (existing.type !== "file" || !req.overwrite) {
        throw fileError("exists");
      }
      if (!existing.writable) {
        throw fileError("protected");
      }
    }

    const stagingKey = `${req.serviceInstanceId}\0${parent.parentReal}\0${req.uploadId}`;
    const staged = this.staging.get(stagingKey);
    const curLen = staged?.length ?? 0;
    if (req.offset > curLen) {
      throw fileError("upload_mismatch");
    }

    const targetLen = req.final
      ? req.offset + chunk.length
      : Math.max(curLen, req.offset + chunk.length);
    const nextBuf = Buffer.alloc(targetLen);
    if (staged) {
      staged.copy(nextBuf, 0, 0, Math.min(staged.length, targetLen));
    }
    chunk.copy(nextBuf, req.offset);

    if (!req.final) {
      this.staging.set(stagingKey, nextBuf);
      return { received: nextBuf.length };
    }

    const now = new Date();
    const preservedWritable = existing?.type === "file" ? existing.writable : true;
    parent.dir.children.set(parent.base, makeFile(nextBuf, preservedWritable, now));
    parent.dir.mtime = now;
    this.staging.delete(stagingKey);
    return { received: nextBuf.length };
  }

  private handleMkdir(root: SimDir, relPath: string): SiteFilesResult<"mkdir"> {
    const parent = resolveParent(root, relPath);
    if (isProtected(parent.realRel) || !parent.dir.writable) {
      throw fileError("protected");
    }
    if (parent.dir.children.has(parent.base)) {
      throw fileError("exists");
    }
    const now = new Date();
    parent.dir.children.set(parent.base, makeDir(true, now));
    parent.dir.mtime = now;
    return {};
  }

  private handleMove(root: SimDir, from: string, to: string): SiteFilesResult<"move"> {
    const src = resolveParent(root, from);
    const srcNode = src.dir.children.get(src.base);
    if (!srcNode) {
      throw fileError("not_found");
    }
    if (isProtected(src.realRel) || !src.dir.writable) {
      throw fileError("protected");
    }

    const dst = resolveParent(root, to);
    if (isProtected(dst.realRel) || !dst.dir.writable) {
      throw fileError("protected");
    }
    if (srcNode.type === "dir" && (dst.realRel === src.realRel || dst.realRel.startsWith(`${src.realRel}/`))) {
      throw fileError("invalid_path");
    }
    if (dst.dir.children.has(dst.base)) {
      throw fileError("exists");
    }

    const now = new Date();
    src.dir.children.delete(src.base);
    src.dir.mtime = now;
    dst.dir.children.set(dst.base, srcNode);
    dst.dir.mtime = now;
    return {};
  }

  private handleDelete(root: SimDir, paths: readonly string[]): SiteFilesResult<"delete"> {
    const targets: ResolvedParent[] = [];
    for (const relPath of paths) {
      const target = resolveParent(root, relPath);
      const node = target.dir.children.get(target.base);
      if (!node) {
        throw fileError("not_found");
      }
      if (isProtected(target.realRel) || !target.dir.writable) {
        throw fileError("protected");
      }
      if (node.type === "dir" && node.children.size > 0) {
        if (!node.writable) {
          throw fileError("protected");
        }
        assertDeletableSubtree(node, target.realRel);
      }
      targets.push(target);
    }

    const now = new Date();
    for (const target of targets) {
      target.dir.children.delete(target.base);
      target.dir.mtime = now;
    }
    return {};
  }

  private handleArchive(
    root: SimDir,
    paths: readonly string[],
    to: string,
  ): SiteFilesResult<"archive"> {
    const dst = resolveParent(root, to);
    if (isProtected(dst.realRel) || !dst.dir.writable) {
      throw fileError("protected");
    }
    if (dst.dir.children.has(dst.base)) {
      throw fileError("exists");
    }

    const sources: Array<{ base: string; node: SimNode }> = [];
    let expectedParent: string | null = null;
    const seenBases = new Set<string>();

    for (const relPath of paths) {
      const src = resolveParent(root, relPath);
      const srcNode = src.dir.children.get(src.base);
      if (!srcNode) {
        throw fileError("not_found");
      }
      if (expectedParent === null) {
        expectedParent = src.parentReal;
      } else if (src.parentReal !== expectedParent) {
        throw fileError("invalid_path");
      }
      if (!seenBases.has(src.base)) {
        seenBases.add(src.base);
        sources.push({ base: src.base, node: srcNode });
      }
    }

    const archiveEntries: SimArchiveEntry[] = [];
    let totalBytes = 0;

    const visit = (name: string, node: SimNode, relInZip: string, depth: number): void => {
      if (name.startsWith(".htpanel-") || node.type === "link") {
        return;
      }
      if (depth > MAX_ARCHIVE_DEPTH || archiveEntries.length >= MAX_ARCHIVE_ENTRIES) {
        throw fileError("archive_limit");
      }
      if (node.type === "file") {
        totalBytes += node.data.length;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          throw fileError("archive_limit");
        }
        archiveEntries.push({ p: relInZip, d: node.data.toString("base64") });
        return;
      }

      archiveEntries.push({ p: `${relInZip}/` });
      const childNames = [...node.children.keys()].sort(compareByteOrder);
      for (const childName of childNames) {
        visit(childName, node.children.get(childName)!, `${relInZip}/${childName}`, depth + 1);
      }
    };

    for (const src of sources) {
      visit(src.base, src.node, src.base, 1);
    }

    const payload = Buffer.concat([
      SIM_ZIP_MAGIC,
      Buffer.from(JSON.stringify(archiveEntries), "utf8"),
    ]);
    const now = new Date();
    dst.dir.children.set(dst.base, makeFile(payload, true, now));
    dst.dir.mtime = now;
    return { entries: archiveEntries.length };
  }

  private handleExtract(
    root: SimDir,
    archivePath: string,
    to: string,
  ): SiteFilesResult<"extract"> {
    const src = followTarget(root, archivePath);
    if (src.node.type !== "file") {
      throw fileError("is_a_directory");
    }

    const entries = parseSimArchive(src.node.data);

    let destParent: ResolvedParent | null = null;
    let destDir: SimDir | null = null;
    let destRealRel = "";

    if (to === "") {
      destDir = root;
    } else {
      destParent = resolveParent(root, to);
      const existing = destParent.dir.children.get(destParent.base);
      if (existing) {
        if (existing.type !== "dir") {
          if (isProtected(destParent.realRel)) {
            throw fileError("protected");
          }
          throw fileError("exists");
        }
        destDir = existing;
        destRealRel = destParent.realRel;
      } else {
        if (isProtected(destParent.realRel) || !destParent.dir.writable) {
          throw fileError("protected");
        }
        destRealRel = destParent.realRel;
      }
    }

    // Pass 2: verify every target against existing tree and permissions before mutating anything.
    for (const entry of entries) {
      let curDir: SimDir | null = destDir;
      let stoppedEarly = false;

      for (let i = 0; i < entry.segments.length - 1; i += 1) {
        const seg = entry.segments[i]!;
        const segRel =
          destRealRel === ""
            ? entry.segments.slice(0, i + 1).join("/")
            : `${destRealRel}/${entry.segments.slice(0, i + 1).join("/")}`;
        if (!curDir) {
          if (isProtected(segRel)) {
            throw fileError("protected");
          }
          continue;
        }
        const existing = curDir.children.get(seg);
        if (!existing) {
          if (!curDir.writable || isProtected(segRel)) {
            throw fileError("protected");
          }
          curDir = null;
          stoppedEarly = true;
          continue;
        }
        if (existing.type !== "dir") {
          if (isProtected(segRel)) {
            throw fileError("protected");
          }
          throw fileError("exists");
        }
        curDir = existing;
      }

      const leafName = entry.segments[entry.segments.length - 1]!;
      const leafRel = destRealRel === "" ? entry.name : `${destRealRel}/${entry.name}`;
      if (!curDir || stoppedEarly) {
        if (isProtected(leafRel)) {
          throw fileError("protected");
        }
        continue;
      }

      const existingLeaf = curDir.children.get(leafName);
      if (entry.kind === "file") {
        if (isProtected(leafRel)) {
          throw fileError("protected");
        }
        if (existingLeaf) {
          throw fileError("exists");
        }
        if (!curDir.writable) {
          throw fileError("protected");
        }
      } else if (existingLeaf) {
        if (existingLeaf.type !== "dir") {
          if (isProtected(leafRel)) {
            throw fileError("protected");
          }
          throw fileError("exists");
        }
      } else {
        if (isProtected(leafRel) || !curDir.writable) {
          throw fileError("protected");
        }
      }
    }

    // Pass 3: apply all mutations atomically now that all checks succeeded.
    const now = new Date();
    if (!destDir && destParent) {
      destDir = makeDir(true, now);
      destParent.dir.children.set(destParent.base, destDir);
      destParent.dir.mtime = now;
    }

    placeEntries(destDir!, entries, now);
    return { entries: entries.length };
  }

  private handleImport(root: SimDir, req: ImportRequest): unknown {
    const outcome = this.importFailures.get(req.op);
    this.importFailures.delete(req.op);
    if (outcome !== undefined && outcome !== "timeout" && outcome !== "undo_incomplete") {
      throw fileError(outcome);
    }
    let state = this.imports.get(req.serviceInstanceId);
    if (!state) {
      state = { slots: new Map(), work: new Map() };
      this.imports.set(req.serviceInstanceId, state);
    }
    const result = outcome === "undo_incomplete" ? { complete: false } : this.applyImport(root, state, req);
    if (outcome === "timeout") {
      // The client's own answer when its wait ends after the request was sent.
      throw new ExecutorIpcClientError(
        "Timed out waiting for docker-executor IPC response after mutating command dispatch",
        "OPERATION_AMBIGUOUS",
        502,
        true,
      );
    }
    return result;
  }

  private applyImport(root: SimDir, s: SimImportState, req: ImportRequest): unknown {
    switch (req.op) {
      case "import.put":
        return this.importPut(s, req);
      case "import.take":
        return this.importTake(root, s, req.slot, req.path);
      case "import.stat": {
        const slot = (name: ImportSlot) => {
          const v = s.slots.get(name);
          return v === undefined
            ? { state: "empty", size: 0, uploadId: null }
            : { state: v.uploadId === null ? "complete" : "partial", size: v.data.length, uploadId: v.uploadId };
        };
        const remains = [...s.work.values()].some((w) => w.plan !== null);
        return { archive: slot("archive"), dump: slot("dump"), remains };
      }
      case "import.discard":
        s.slots.clear();
        for (const [id, w] of s.work) {
          if (w.plan === null) {
            s.work.delete(id);
          }
        }
        return {};
      case "import.unpack":
        return this.importUnpack(s, req.importId);
      case "import.switch":
        return this.importSwitch(root, s, req.importId);
      case "import.undo":
        return this.importUndo(root, s, req.importId);
      case "import.finish":
        s.work.delete(req.importId);
        s.slots.clear();
        return {};
    }
  }

  private importPut(s: SimImportState, req: Extract<ImportRequest, { op: "import.put" }>): SiteFilesResult<"import.put"> {
    const chunk = Buffer.from(req.dataBase64, "base64");
    if (req.offset === 0 && s.slots.get(req.slot)?.uploadId !== req.uploadId) {
      s.slots.delete(req.slot);
      sniffSlot(req.slot, chunk);
    }
    const cur = s.slots.get(req.slot);
    const staged = cur?.uploadId === req.uploadId ? cur.data : undefined;
    if (req.offset > (staged?.length ?? 0)) {
      throw fileError("upload_mismatch");
    }
    const targetLen = req.final
      ? req.offset + chunk.length
      : Math.max(staged?.length ?? 0, req.offset + chunk.length);
    const next = Buffer.alloc(targetLen);
    staged?.copy(next, 0, 0, Math.min(staged.length, targetLen));
    chunk.copy(next, req.offset);
    s.slots.set(req.slot, { data: next, uploadId: req.final ? null : req.uploadId });
    return { received: next.length };
  }

  private importTake(root: SimDir, s: SimImportState, slot: ImportSlot, path: string): SiteFilesResult<"import.take"> {
    const src = resolveParent(root, path);
    const node = src.dir.children.get(src.base);
    if (!node || node.type === "link" || src.base.startsWith(".htpanel-")) {
      throw fileError("not_found");
    }
    if (node.type === "dir") {
      throw fileError("is_a_directory");
    }
    if (isProtected(src.realRel) || !src.dir.writable) {
      throw fileError("protected");
    }
    if (node.data.length > SITE_FILES_MAX_FILE_BYTES) {
      throw fileError("too_large");
    }
    sniffSlot(slot, node.data);
    src.dir.children.delete(src.base);
    src.dir.mtime = new Date();
    s.slots.set(slot, { data: node.data, uploadId: null });
    return { size: node.data.length };
  }

  private importUnpack(s: SimImportState, importId: string): SiteFilesResult<"import.unpack"> {
    if (s.work.get(importId)?.plan) {
      throw fileError("staging_unsafe");
    }
    s.work.delete(importId);
    const archive = s.slots.get("archive");
    if (!archive || archive.uploadId !== null) {
      throw fileError("files_missing");
    }
    const entries = parseSimArchive(archive.data, MAX_IMPORT_ENTRIES, MAX_IMPORT_BYTES);
    if (entries.some((e) => e.segments[e.segments.length - 1] === ".htaccess.hpimport")) {
      throw fileError("archive_unsafe");
    }
    const x = makeDir();
    placeEntries(x, entries, new Date());
    // What macOS adds at the top is ignored, never taken (R156.2).
    if (x.children.get("__MACOSX")?.type === "dir") {
      x.children.delete("__MACOSX");
    }
    if (x.children.get(".DS_Store")?.type === "file") {
      x.children.delete(".DS_Store");
    }
    let site = x;
    if (!isWordpressRoot(x)) {
      const only = [...x.children.values()];
      if (only.length !== 1 || only[0]!.type !== "dir" || !isWordpressRoot(only[0]!)) {
        throw fileError("archive_not_wordpress");
      }
      site = only[0]!;
    }
    const leftOut = SITE_IMPORT_LEFT_OUT.filter((rel) => {
      const [first, second] = rel.split("/") as [string, string | undefined];
      const dir = second === undefined ? site : site.children.get(first);
      const name = second ?? first;
      const node = dir?.type === "dir" ? dir.children.get(name) : undefined;
      if (!node) {
        return false;
      }
      (dir as SimDir).children.delete(name);
      if (rel === ".htaccess") {
        site.children.set(".htaccess.imported", node);
      }
      return true;
    });
    s.work.set(importId, { site, plan: null });
    return { entries: entries.length, leftOut };
  }

  private importSwitch(root: SimDir, s: SimImportState, importId: string): SiteFilesResult<"import.switch"> {
    const w = s.work.get(importId);
    if (!w) {
      throw fileError("files_missing");
    }
    if (w.plan) {
      throw fileError("staging_unsafe");
    }
    const wp = dirAt(root, ["wp-content"]);
    const siteWp = dirAt(w.site, ["wp-content"]);
    const notMu = (name: string): boolean => name !== "mu-plugins";
    const aside = makeDir();
    const asideWp = makeDir();
    const out =
      moveNames(root, aside, [...root.children.keys()].filter((n) => !keepsRootName(n))).length +
      moveNames(wp, asideWp, [...wp.children.keys()].filter(notMu)).length;
    const inRoot = moveNames(w.site, root, [...w.site.children.keys()].filter((n) => !keepsRootName(n)));
    const inWp = moveNames(siteWp, wp, [...siteWp.children.keys()].filter(notMu));
    w.plan = { aside, asideWp, inRoot, inWp };
    return { moved: out + inRoot.length + inWp.length };
  }

  private importUndo(root: SimDir, s: SimImportState, importId: string): SiteFilesResult<"import.undo"> {
    const work = s.work.get(importId);
    const plan = work?.plan;
    if (work && plan) {
      const wp = dirAt(root, ["wp-content"]);
      const site = work.site;
      moveNames(wp, dirAt(site, ["wp-content"]), plan.inWp);
      moveNames(root, site, plan.inRoot);
      moveNames(plan.asideWp, wp, [...plan.asideWp.children.keys()]);
      moveNames(plan.aside, root, [...plan.aside.children.keys()]);
      // Gate and plan stay until every live entry is back (R152.2).
      if (plan.aside.children.size + plan.asideWp.children.size > 0) {
        return { complete: false };
      }
    }
    s.work.delete(importId);
    return { complete: true };
  }
}
