import { X509Certificate, createHash, createPrivateKey, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { traefikCertificateNames } from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

// Manual TLS certificate store (HCP-SPEC-004, arch-tls-ingress D2-D4, D7, D12).
//   <dir>/<versionId>/{fullchain,privkey}.pem   immutable version dirs, 0700 dir / 0400 files, owned by the executor uid
//   <dir>/.stage-<versionId>-<rand>/            write area, renamed into place after re-verification
//   <statePath>                                 manual-tls-state.json (0600): generation CAS, verified flag, last verified set
// The manifest (file refs only) is rendered here and written through the injected writeManifest, which is the
// dynamic-config write lock of TraefikIngressFileManager. Nothing here logs or throws PEM material.

export const MANUAL_CERTS_DIR_NAME = "manual-certs";
export const MANUAL_TLS_FULLCHAIN_FILE = "fullchain.pem";
export const MANUAL_TLS_KEY_FILE = "privkey.pem";
export const MANUAL_TLS_MANIFEST_HEADER = "# Managed by hp-docker-executor — DO NOT EDIT";

const VERSION_ID_PATTERN = /^ctv_[0-9a-f]{32}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const STAGE_PREFIX = ".stage-";
const MAX_FILE_BYTES = 600 * 1024;
const STAGE_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_GC_GRACE_MS = 5 * 60 * 1000;

/**
 * `reason` is the design's error name. ErrorCode has no TLS_* members yet, so `code` carries the closest existing one;
 * the HTTP layer that wires this store maps on `reason` (and `versionIds` for TLS_VERSION_MISSING).
 */
export type ManualTlsStoreErrorReason =
  | "TLS_MANIFEST_CONFLICT"
  | "TLS_VERSION_MISSING"
  | "TLS_VERSION_CONFLICT"
  | "TLS_MATERIAL_INVALID"
  | "TLS_STORE_UNSAFE"
  | "TLS_STATE_INVALID";

const REASON_CODE = {
  TLS_MANIFEST_CONFLICT: "CERTIFICATE_IN_USE",
  TLS_VERSION_MISSING: "CERTIFICATE_IN_USE",
  TLS_VERSION_CONFLICT: "CERTIFICATE_IN_USE",
  TLS_MATERIAL_INVALID: "CERTIFICATE_INVALID",
  TLS_STORE_UNSAFE: "HOST_POLICY_DENIED",
  TLS_STATE_INVALID: "INTERNAL_ERROR",
} as const;

export class ManualTlsStoreError extends ExecutorCodedError {
  public readonly reason: ManualTlsStoreErrorReason;
  public readonly versionIds: readonly string[];

  public constructor(reason: ManualTlsStoreErrorReason, message: string, versionIds: readonly string[] = []) {
    super(message, REASON_CODE[reason]);
    this.name = "ManualTlsStoreError";
    this.reason = reason;
    this.versionIds = versionIds;
  }
}

export interface ManualTlsEntry {
  readonly versionId: string;
  readonly assignedHosts: readonly string[];
}

export interface ManualTlsState {
  readonly schema: 1;
  readonly generation: number;
  readonly current: { readonly entries: readonly ManualTlsEntry[] };
  readonly verified: boolean;
  readonly lastVerified: { readonly generation: number; readonly entries: readonly ManualTlsEntry[] } | null;
  readonly updatedAt: string;
}

export interface ManualTlsVersionInfo {
  readonly versionId: string;
  readonly fingerprintSha256: string;
  readonly notAfter: string;
  readonly names: string[];
}

export interface ManualTlsStoreDeps {
  /** <ingressRoot>/dynamic/manual-certs */
  readonly dir: string;
  /** <ingressRoot>/manual-tls-state.json (outside dynamic/) */
  readonly statePath: string;
  /** Where the proxy sees `dynamic/` (default /etc/traefik/dynamic): the prefix of the manifest file refs. */
  readonly mountDir?: string;
  /** Writes the manifest through the dynamic-config lock; null removes it. */
  readonly writeManifest: (content: string | null) => Promise<void>;
  /** The manifest as it is on disk (null when absent): gc never collects a version it still lists. */
  readonly readManifest?: () => Promise<string | null>;
  /** Owner every file must have (default process.getuid()). */
  readonly uid?: number;
  readonly now?: () => Date;
  /** Version dirs younger than this are never collected (a put not yet published). Default 5 min. */
  readonly gcGraceMs?: number;
  /** Stage-dir suffix source (tests plant a symlink at the predictable path). */
  readonly randomSuffix?: () => string;
}

interface VersionDetail extends ManualTlsVersionInfo {
  readonly fullchainSha256: string;
  readonly keySha256: string;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const withNewline = (pem: string): string => (pem.endsWith("\n") ? pem : `${pem}\n`);
const STORED_FILE_ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ELOOP", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);
const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

export function normaliseEntries(entries: readonly ManualTlsEntry[]): ManualTlsEntry[] {
  const seen = new Set<string>();
  const out = entries.map((entry) => {
    if (!VERSION_ID_PATTERN.test(entry.versionId) || seen.has(entry.versionId)) {
      throw new ManualTlsStoreError("TLS_MATERIAL_INVALID", "Invalid or duplicate certificate version id");
    }
    seen.add(entry.versionId);
    const assignedHosts = [...new Set(entry.assignedHosts.map((host) => host.toLowerCase()))].sort();
    return { versionId: entry.versionId, assignedHosts };
  });
  return out.sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
}

const sameEntries = (a: readonly ManualTlsEntry[], b: readonly ManualTlsEntry[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The leaf's names as Traefik indexes it (CN even when it is not a SAN). */
function leafNames(cert: X509Certificate): string[] {
  const cn = /^CN=(.*)$/m.exec(cert.subject)?.[1] ?? "";
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const san = /(?:^|, )(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g;
  for (const m of (cert.subjectAltName ?? "").matchAll(san)) {
    const raw = m[2]!;
    (m[1] === "DNS" ? dnsNames : ipAddresses).push(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
  }
  return traefikCertificateNames({ commonName: cn, dnsNames, ipAddresses });
}

function parseState(raw: string): ManualTlsState {
  const bad = (): never => {
    throw new ManualTlsStoreError("TLS_STATE_INVALID", "manual-tls-state.json is not a valid state file");
  };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return bad();
  }
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const entriesOf = (v: unknown): ManualTlsEntry[] => {
    if (!Array.isArray(v)) return bad();
    return v.map((e: unknown) => {
      const rec = e as { versionId?: unknown; assignedHosts?: unknown } | null;
      if (
        typeof rec?.versionId !== "string" ||
        !VERSION_ID_PATTERN.test(rec.versionId) ||
        !Array.isArray(rec.assignedHosts) ||
        rec.assignedHosts.some((h) => typeof h !== "string")
      ) {
        return bad();
      }
      return { versionId: rec.versionId, assignedHosts: rec.assignedHosts as string[] };
    });
  };
  const s = data as Record<string, unknown> | null;
  if (!s || s.schema !== 1 || !isInt(s.generation) || typeof s.verified !== "boolean" || typeof s.updatedAt !== "string") {
    return bad();
  }
  const current = (s.current as { entries?: unknown } | null)?.entries;
  const lv = s.lastVerified as { generation?: unknown; entries?: unknown } | null;
  if (lv !== null && (typeof lv !== "object" || !isInt(lv.generation))) return bad();
  return {
    schema: 1,
    generation: s.generation,
    current: { entries: entriesOf(current) },
    verified: s.verified,
    lastVerified: lv === null ? null : { generation: lv.generation as number, entries: entriesOf(lv.entries) },
    updatedAt: s.updatedAt,
  };
}

async function fsyncPath(target: string): Promise<void> {
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ManualTlsStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly mountDir: string;
  private readonly uid: number | undefined;
  private readonly now: () => Date;
  private readonly gcGraceMs: number;
  private readonly randomSuffix: () => string;
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(private readonly deps: ManualTlsStoreDeps) {
    this.dir = deps.dir;
    this.statePath = deps.statePath;
    this.mountDir = (deps.mountDir ?? "/etc/traefik/dynamic").replace(/\/+$/, "");
    this.uid = deps.uid ?? process.getuid?.();
    this.now = deps.now ?? (() => new Date());
    this.gcGraceMs = deps.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.randomSuffix = deps.randomSuffix ?? (() => randomBytes(3).toString("hex"));
  }

  /** Mutations run one at a time: state read-modify-write must not interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // -- store directory -----------------------------------------------------------------------------------------

  private unsafe(what: string): ManualTlsStoreError {
    return new ManualTlsStoreError("TLS_STORE_UNSAFE", `Manual certificate store refused: ${what}`);
  }

  /**
   * lstat the store dir: a real directory owned by the executor, not group/world accessible. Runs on every
   * operation. Absent: created 0700 when `create`, otherwise false.
   */
  private async checkStoreDir(create: boolean): Promise<boolean> {
    let info = await lstat(this.dir).catch((err: unknown) => {
      if (errnoCode(err) === "ENOENT") return null;
      throw err;
    });
    if (info === null) {
      if (!create) return false;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      info = await lstat(this.dir);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw this.unsafe("store path is not a plain directory");
    if (this.uid !== undefined && info.uid !== this.uid) throw this.unsafe("store directory has another owner");
    if ((info.mode & 0o077) !== 0) throw this.unsafe("store directory is accessible to group or others");
    return true;
  }

  private async ensureStoreDir(): Promise<void> {
    await this.checkStoreDir(true);
  }

  private versionDir(versionId: string): string {
    if (!VERSION_ID_PATTERN.test(versionId)) {
      throw new ManualTlsStoreError("TLS_MATERIAL_INVALID", "Invalid certificate version id");
    }
    return path.join(this.dir, versionId);
  }

  /** O_NOFOLLOW read of one stored file; the fd's fstat must say regular, ours, 0400, small. */
  private async readStoredFile(file: string): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      // Only "the file is not there / not a plain file we may read" means invalid; EIO, EMFILE... fail the operation.
      if (STORED_FILE_ABSENT_CODES.has(errnoCode(err) ?? "")) return null;
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o400 || info.size > MAX_FILE_BYTES) return null;
      if (this.uid !== undefined && info.uid !== this.uid) return null;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /** Parses a stored version; null when it is absent or fails any check (symlink, owner, mode, parse, key match). Other I/O errors throw. */
  private async readVersion(versionId: string): Promise<VersionDetail | null> {
    const dir = this.versionDir(versionId);
    const info = await lstat(dir).catch((err: unknown) => {
      if (errnoCode(err) === "ENOENT") return null; // a transient error (EIO, EMFILE) must not read as "missing"
      throw err;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    if (this.uid !== undefined && info.uid !== this.uid) return null;
    if ((info.mode & 0o777) !== 0o700) return null; // anyone able to unlink a 0400 file could replace it
    const [chain, key] = await Promise.all([
      this.readStoredFile(path.join(dir, MANUAL_TLS_FULLCHAIN_FILE)),
      this.readStoredFile(path.join(dir, MANUAL_TLS_KEY_FILE)),
    ]);
    if (!chain || !key) return null;
    try {
      const cert = new X509Certificate(chain);
      const privateKey = createPrivateKey(key);
      if (!cert.checkPrivateKey(privateKey)) return null;
      return {
        versionId,
        fingerprintSha256: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
        notAfter: new Date(cert.validTo).toISOString(),
        names: leafNames(cert),
        fullchainSha256: sha256(chain),
        keySha256: sha256(privateKey.export({ type: "pkcs8", format: "der" })),
      };
    } catch {
      return null;
    }
  }

  // -- putVersion (D2) -----------------------------------------------------------------------------------------

  public putVersion(input: {
    readonly versionId: string;
    readonly fullchainPem: string;
    readonly keyPem: string;
    readonly fingerprintSha256: string;
  }): Promise<{ versionId: string; written: boolean }> {
    return this.serial(() => this.putVersionLocked(input));
  }

  private async putVersionLocked(input: {
    readonly versionId: string;
    readonly fullchainPem: string;
    readonly keyPem: string;
    readonly fingerprintSha256: string;
  }): Promise<{ versionId: string; written: boolean }> {
    const { versionId } = input;
    const target = this.versionDir(versionId);
    const invalid = (): ManualTlsStoreError =>
      new ManualTlsStoreError("TLS_MATERIAL_INVALID", "Certificate material does not match the request");
    const fullchain = withNewline(input.fullchainPem);
    const keyPem = withNewline(input.keyPem);
    if (
      !FINGERPRINT_PATTERN.test(input.fingerprintSha256) ||
      Buffer.byteLength(fullchain) > MAX_FILE_BYTES ||
      Buffer.byteLength(keyPem) > MAX_FILE_BYTES
    ) {
      throw invalid();
    }

    // Parse and match before anything touches the disk: a bad request leaves no directory behind.
    let wanted: { fullchainSha256: string; keySha256: string };
    try {
      const cert = new X509Certificate(fullchain);
      const privateKey = createPrivateKey(keyPem);
      if (
        cert.fingerprint256.replaceAll(":", "").toLowerCase() !== input.fingerprintSha256 ||
        !cert.checkPrivateKey(privateKey)
      ) {
        throw invalid();
      }
      wanted = {
        fullchainSha256: sha256(fullchain),
        keySha256: sha256(privateKey.export({ type: "pkcs8", format: "der" })),
      };
    } catch (err) {
      throw err instanceof ManualTlsStoreError ? err : invalid();
    }

    await this.ensureStoreDir();

    const existing = await this.existingOutcome(target, versionId, input.fingerprintSha256, wanted);
    if (existing === "same") return { versionId, written: false };

    const stage = path.join(this.dir, `${STAGE_PREFIX}${versionId}-${this.randomSuffix()}`);
    let staged = false;
    try {
      await mkdir(stage, { mode: 0o700 }); // EEXIST (planted file or symlink) fails: never reused, never removed
      staged = true;
      const created = await lstat(stage);
      if (!created.isDirectory() || created.isSymbolicLink()) throw this.unsafe("stage path is not a plain directory");
      await this.writeNew(path.join(stage, MANUAL_TLS_FULLCHAIN_FILE), fullchain);
      await this.writeNew(path.join(stage, MANUAL_TLS_KEY_FILE), keyPem);
      await fsyncPath(stage);

      // Re-open what is on disk and verify it is exactly the request.
      const chainBack = await this.readStoredFile(path.join(stage, MANUAL_TLS_FULLCHAIN_FILE));
      const keyBack = await this.readStoredFile(path.join(stage, MANUAL_TLS_KEY_FILE));
      if (!chainBack || !keyBack) throw this.unsafe("stored file failed the owner/mode check");
      const certBack = new X509Certificate(chainBack);
      if (
        certBack.fingerprint256.replaceAll(":", "").toLowerCase() !== input.fingerprintSha256 ||
        !certBack.checkPrivateKey(createPrivateKey(keyBack))
      ) {
        throw invalid();
      }

      try {
        await rename(stage, target);
      } catch (err) {
        if (errnoCode(err) !== "ENOTEMPTY" && errnoCode(err) !== "EEXIST") throw err;
        // A concurrent put won the rename: judge what is there now.
        const raced = await this.existingOutcome(target, versionId, input.fingerprintSha256, wanted);
        await rm(stage, { recursive: true, force: true });
        if (raced === "same") return { versionId, written: false };
        throw err;
      }
      await fsyncPath(this.dir);
      return { versionId, written: true };
    } catch (err) {
      if (staged) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof ManualTlsStoreError) throw err;
      if (errnoCode(err) === "EEXIST") throw this.unsafe("stage path already exists");
      throw err;
    }
  }

  /** "none" = nothing at the target (or a broken own directory, removed); "same" = identical immutable version. */
  private async existingOutcome(
    target: string,
    versionId: string,
    fingerprintSha256: string,
    wanted: { fullchainSha256: string; keySha256: string },
  ): Promise<"none" | "same"> {
    const info = await lstat(target).catch((err: unknown) => {
      if (errnoCode(err) === "ENOENT") return null;
      throw err;
    });
    if (info === null) return "none";
    if (!info.isDirectory() || info.isSymbolicLink()) throw this.unsafe("version path is not a plain directory");
    if (this.uid !== undefined && info.uid !== this.uid) throw this.unsafe("version directory has another owner");
    const stored = await this.readVersion(versionId);
    if (stored === null) {
      // Our own directory that no longer verifies (restore with a changed owner, truncated file): replace it.
      await rm(target, { recursive: true, force: true });
      return "none";
    }
    if (
      stored.fingerprintSha256 === fingerprintSha256 &&
      stored.fullchainSha256 === wanted.fullchainSha256 &&
      stored.keySha256 === wanted.keySha256
    ) {
      return "same";
    }
    throw new ManualTlsStoreError("TLS_VERSION_CONFLICT", "Certificate version already exists with other material", [
      versionId,
    ]);
  }

  private async writeNew(file: string, content: string): Promise<void> {
    const handle = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o400,
    );
    try {
      await handle.chmod(0o400);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  // -- state (D3) ----------------------------------------------------------------------------------------------

  /** null when no state file exists (never published, or a host restored without it). */
  public async readState(): Promise<ManualTlsState | null> {
    let handle;
    try {
      handle = await open(this.statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return null;
      throw new ManualTlsStoreError("TLS_STATE_INVALID", "manual-tls-state.json cannot be opened");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024) {
        throw new ManualTlsStoreError("TLS_STATE_INVALID", "manual-tls-state.json is not a regular file");
      }
      return parseState(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }

  private async writeState(state: Omit<ManualTlsState, "schema" | "updatedAt">): Promise<ManualTlsState> {
    const full: ManualTlsState = { schema: 1, ...state, updatedAt: this.now().toISOString() };
    const parent = path.dirname(this.statePath);
    const tmp = path.join(parent, `.${path.basename(this.statePath)}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(full)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.statePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await fsyncPath(parent);
    return full;
  }

  // -- manifest (D4) -------------------------------------------------------------------------------------------

  /** Stable bytes from the sorted id set only (no generation, no timestamp); null when empty. */
  public renderManifest(versionIds: readonly string[]): string | null {
    const ids = [...new Set(versionIds)].sort();
    if (ids.length === 0) return null;
    const lines = [MANUAL_TLS_MANIFEST_HEADER, "tls:", "  certificates:"];
    for (const id of ids) {
      if (!VERSION_ID_PATTERN.test(id)) throw new ManualTlsStoreError("TLS_MATERIAL_INVALID", "Invalid version id");
      const base = `${this.mountDir}/${MANUAL_CERTS_DIR_NAME}/${id}`;
      lines.push(
        `    - certFile: "${base}/${MANUAL_TLS_FULLCHAIN_FILE}"`,
        `      keyFile: "${base}/${MANUAL_TLS_KEY_FILE}"`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private writeManifestFor(entries: readonly ManualTlsEntry[]): Promise<void> {
    return this.deps.writeManifest(this.renderManifest(entries.map((e) => e.versionId)));
  }

  /** Ids with no valid stored version. */
  private async missingOf(ids: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    if (!(await this.checkStoreDir(false))) return [...new Set(ids)].sort();
    for (const id of [...new Set(ids)].sort()) if ((await this.readVersion(id)) === null) missing.push(id);
    return missing;
  }

  // -- publication (D7) ----------------------------------------------------------------------------------------

  /**
   * Compare-and-swap on the generation: every version must verify, then state {generation+1, verified:false} is
   * persisted, then the manifest is rewritten. A replay of the identical set (state already at base+1) writes no
   * state again and only re-asserts the manifest.
   */
  public publishFiles(
    baseGeneration: number,
    entries: readonly ManualTlsEntry[],
  ): Promise<{ generation: number; replayed: boolean }> {
    return this.serial(async () => {
      const wanted = normaliseEntries(entries);
      const state = await this.readState();
      const generation = state?.generation ?? 0;
      const replay = state !== null && generation === baseGeneration + 1 && sameEntries(state.current.entries, wanted);
      if (!replay && generation !== baseGeneration) {
        throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was read");
      }
      const missing = await this.missingOf(wanted.map((e) => e.versionId));
      if (missing.length > 0) {
        throw new ManualTlsStoreError("TLS_VERSION_MISSING", "Certificate versions are missing on the executor", missing);
      }
      if (replay) {
        await this.writeManifestFor(wanted);
        return { generation, replayed: true };
      }
      const next = await this.writeState({
        generation: generation + 1,
        current: { entries: wanted },
        verified: false,
        lastVerified: state?.lastVerified ?? null,
      });
      await this.writeManifestFor(wanted);
      return { generation: next.generation, replayed: false };
    });
  }

  /** The probe confirmed `generation` is what is served: it becomes the last verified set. */
  public markVerified(generation: number): Promise<ManualTlsState> {
    return this.serial(async () => {
      const state = await this.readState();
      if (state === null || state.generation !== generation) {
        throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was published");
      }
      return this.writeState({
        generation,
        current: state.current,
        verified: true,
        lastVerified: { generation, entries: state.current.entries },
      });
    });
  }

  /** Failed probe: put the last verified set (or none) back in state and manifest. Generation is kept. */
  public revertToLastVerified(): Promise<ManualTlsState> {
    return this.serial(async () => {
      const state = await this.readState();
      if (state === null) {
        throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "Nothing was published, nothing to revert");
      }
      const last = state.lastVerified ?? { generation: state.generation, entries: [] };
      // A verified version whose files vanished is not put back: the manifest never names a missing file.
      const missing = await this.missingOf(last.entries.map((e) => e.versionId));
      const lastVerified = { generation: last.generation, entries: last.entries.filter((e) => !missing.includes(e.versionId)) };
      const next = await this.writeState({
        generation: state.generation,
        current: { entries: lastVerified.entries },
        verified: true,
        lastVerified,
      });
      await this.writeManifestFor(lastVerified.entries);
      return next;
    });
  }

  /**
   * Executor start: state present => re-render the manifest (a crash between state and manifest): from `current`
   * when it was verified, else from the last verified set (an unverified current was never probed here; the
   * panel's replay publishes it again). Versions whose files are gone are left out of the manifest and reported. State absent => the manifest is never
   * touched (previous release after a rollback, or a host restored without the state file).
   * A publish that was mid-probe when the executor died is not lost: its request died with the process, so the
   * manifest converges to the last verified set (state stays unverified) and the API's retry of the same publish
   * replays it. The adapter never runs this while a publish of this process is in flight.
   */
  public recoverAtStart(): Promise<{ recovered: boolean; generation: number; missing: string[] }> {
    return this.serial(async () => {
      const state = await this.readState();
      if (state === null) return { recovered: false, generation: 0, missing: [] };
      const source = state.verified ? state.current.entries : (state.lastVerified?.entries ?? []);
      const missing = await this.missingOf(source.map((e) => e.versionId));
      const present = source.filter((e) => !missing.includes(e.versionId));
      await this.writeManifestFor(present);
      return { recovered: true, generation: state.generation, missing };
    });
  }

  // -- inventory (no PEM) and GC (D12) -------------------------------------------------------------------------

  private async listVersionIds(): Promise<string[]> {
    if (!(await this.checkStoreDir(false))) return [];
    const names = await readdir(this.dir).catch((err: unknown) => {
      if (errnoCode(err) === "ENOENT") return [] as string[];
      throw err;
    });
    return names.filter((name) => VERSION_ID_PATTERN.test(name)).sort();
  }

  public async inventory(): Promise<{
    generation: number;
    verified: boolean;
    versions: ManualTlsVersionInfo[];
    entries: ManualTlsEntry[];
    missing: string[];
  }> {
    const state = await this.readState();
    const versions: ManualTlsVersionInfo[] = [];
    for (const id of await this.listVersionIds()) {
      const detail = await this.readVersion(id);
      if (detail) {
        versions.push({
          versionId: id,
          fingerprintSha256: detail.fingerprintSha256,
          notAfter: detail.notAfter,
          names: detail.names,
        });
      }
    }
    const referenced = [
      ...(state?.current.entries ?? []),
      ...(state?.lastVerified?.entries ?? []),
    ].map((e) => e.versionId);
    const have = new Set(versions.map((v) => v.versionId));
    return {
      generation: state?.generation ?? 0,
      verified: state?.verified ?? true,
      versions,
      entries: state ? state.current.entries.map((e) => ({ ...e, assignedHosts: [...e.assignedHosts] })) : [],
      missing: [...new Set(referenced)].filter((id) => !have.has(id)).sort(),
    };
  }

  /**
   * Removes version dirs outside current ∪ lastVerified, only while verified:true and the generation is the
   * caller's, and never a dir younger than the grace window. Stale stage dirs (> 1 h) go regardless. With no state
   * nothing is considered an orphan. Each entry is lstat-checked (plain dir, ours) before `rm -r`.
   */
  public gc(baseGeneration: number): Promise<{ removed: string[] }> {
    return this.serial(async () => {
      const state = await this.readState();
      if (state !== null && state.generation !== baseGeneration) {
        throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was read");
      }
      if (!(await this.checkStoreDir(false))) return { removed: [] };
      const names = await readdir(this.dir).catch((err: unknown) => {
        if (errnoCode(err) === "ENOENT") return [] as string[];
        throw err;
      });
      // The manifest on disk can still list a set the state no longer holds (a failed manifest write).
      const onDisk = (await this.deps.readManifest?.()) ?? "";
      const nowMs = this.now().getTime();
      const keep = new Set([
        ...[...(state?.current.entries ?? []), ...(state?.lastVerified?.entries ?? [])].map((e) => e.versionId),
        ...(onDisk.match(/ctv_[0-9a-f]{32}/g) ?? []),
      ]);
      const removed: string[] = [];
      for (const name of names.sort()) {
        const isStage = name.startsWith(STAGE_PREFIX);
        const isVersion = VERSION_ID_PATTERN.test(name);
        if (!isStage && !isVersion) continue;
        if (isVersion && (state === null || !state.verified || keep.has(name))) continue;
        const full = path.join(this.dir, name);
        const info = await lstat(full).catch(() => null);
        if (!info?.isDirectory() || info.isSymbolicLink()) continue;
        if (this.uid !== undefined && info.uid !== this.uid) continue;
        const age = nowMs - info.mtimeMs;
        if (isStage ? age < STAGE_MAX_AGE_MS : age < this.gcGraceMs) continue;
        await rm(full, { recursive: true, force: true });
        if (isVersion) removed.push(name);
      }
      return { removed };
    });
  }
}
