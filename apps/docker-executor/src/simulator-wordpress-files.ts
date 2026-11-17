import {
  SITE_FILES_MAX_FILE_BYTES,
  SITE_IMPORT_LEFT_OUT,
  type SiteImportOp,
} from "@hosting-panel/contracts";
import type { SiteFilesRequest, SiteFilesResult } from "@hosting-panel/executor-contracts";
import { ExecutorIpcClientError } from "./client.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "./site-types/index.js";
import {
  SIM_ZIP_MAGIC,
  dirAt,
  fileError,
  isProtected,
  makeDir,
  makeFile,
  parseSimArchive,
  placeEntries,
  resolveParent,
  type SimDir,
  type SimRoot,
} from "./simulator-files.js";
import type { SimImportOutcome, SimulatorSiteOps, SimulatorSiteType } from "./simulator-site-types.js";

const MAX_IMPORT_ENTRIES = 200_000;
const MAX_IMPORT_BYTES = 4_294_967_296;
const DUMP_SNIFF_BYTES = 4096;

type ImportSlot = "archive" | "dump";
type ImportRequest = Extract<SiteFilesRequest, { op: SiteImportOp }>;

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

/** The import in one simulator: slots and work folders per service, and the next failures. */
export class SimulatedWordpressImport implements SimulatorSiteOps {
  private readonly imports = new Map<string, SimImportState>();
  public readonly importFailures = new Map<SiteImportOp, SimImportOutcome>();

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

  /** Forgets the service's import state. */
  public drop(svc: string): void {
    this.imports.delete(svc);
  }

  public handle(root: SimRoot, req: ImportRequest): unknown {
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

  private applyImport(root: SimRoot, s: SimImportState, req: ImportRequest): unknown {
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

  private importTake(root: SimRoot, s: SimImportState, slot: ImportSlot, path: string): SiteFilesResult<"import.take"> {
    const src = resolveParent(root, path);
    const node = src.dir.children.get(src.base);
    if (!node || node.type === "link" || src.base.startsWith(".htpanel-")) {
      throw fileError("not_found");
    }
    if (node.type === "dir") {
      throw fileError("is_a_directory");
    }
    if (isProtected(root, src.realRel) || !src.dir.writable) {
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

/** WordPress in the simulator: its seed tree, its protected mail hook and the import. */
export const WORDPRESS_SIMULATOR_SITE_TYPE: SimulatorSiteType = {
  def: WORDPRESS_EXECUTOR_SITE_TYPE.def,
  protectedPaths: WORDPRESS_EXECUTOR_SITE_TYPE.files.protectedPaths,
  shellId: "uid=33(www-data) gid=33(www-data) groups=33(www-data)",
  seed: createDefaultWordpressTree,
  ops: WORDPRESS_EXECUTOR_SITE_TYPE.files.ops,
  createOps: () => new SimulatedWordpressImport(),
};
