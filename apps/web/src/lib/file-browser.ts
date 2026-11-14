import {
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_PATH_MAX,
  SITE_FILE_SEGMENT_MAX_BYTES,
  SITE_FILES_MAX_FILE_BYTES,
  type SiteFileEntryDto,
} from "@hosting-panel/contracts";
import { errorMessage, type Messages } from "@/i18n";

export const CHUNK_BYTES = SITE_FILE_CHUNK_BYTES;
export const EDITOR_MAX_BYTES = SITE_FILE_CHUNK_BYTES;
export const LARGE_UPLOAD_HINT_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = SITE_FILES_MAX_FILE_BYTES;

export const EDITABLE_EXTENSIONS = new Set([
  "php",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "txt",
  "md",
  "xml",
  "svg",
  "ini",
  "htaccess",
  "csv",
  "log",
  "yml",
  "yaml",
  "sql",
  "conf",
]);

export const UPLOAD_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/^\/+|\/+$/g, "");
  const n = name.replace(/^\/+|\/+$/g, "");
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}

export function parentPath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "");
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "" : clean.slice(0, idx);
}

export function baseName(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "");
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? clean : clean.slice(idx + 1);
}

export function crumbs(p: string): { name: string; path: string }[] {
  const parts = p.split("/").filter(Boolean);
  return parts.map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join("/"),
  }));
}

export function isValidName(n: string): boolean {
  if (!n || n.includes("/") || /^\.+$/.test(n) || n.startsWith(".htpanel-") || hasControlChar(n)) {
    return false;
  }
  return utf8Bytes(n) <= SITE_FILE_SEGMENT_MAX_BYTES;
}

export function isValidRelativePath(p: string, allowEmpty: boolean): boolean {
  if (p === "") return allowEmpty;
  if (p.length > SITE_FILE_PATH_MAX || p.startsWith("/") || p.endsWith("/") || hasControlChar(p)) {
    return false;
  }
  const segments = p.split("/");
  return segments.every((s) => isValidName(s));
}

export function isEditable(e: SiteFileEntryDto): boolean {
  if (e.kind !== "file" || e.size > EDITOR_MAX_BYTES) return false;
  const dot = e.name.lastIndexOf(".");
  if (dot === -1 || dot === e.name.length - 1) return false;
  const ext = e.name.slice(dot + 1).toLowerCase();
  return EDITABLE_EXTENSIONS.has(ext);
}

export function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}

export function sortEntries(entries: readonly SiteFileEntryDto[], locale: string): SiteFileEntryDto[] {
  return [...entries].sort((a, b) => {
    const dirDiff = (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1);
    if (dirDiff !== 0) return dirDiff;
    return a.name.localeCompare(b.name, locale, { sensitivity: "base" });
  });
}

export function formatSize(bytes: number, locale: string): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(safe);
  }
  if (safe < 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(safe / 1024);
  }
  if (safe < 1024 * 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(safe / (1024 * 1024));
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "gigabyte",
    unitDisplay: "short",
    maximumFractionDigits: 2,
  }).format(safe / (1024 * 1024 * 1024));
}

export function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(bytes);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export interface ChunkPlan {
  readonly offset: number;
  readonly end: number;
  readonly final: boolean;
}

export function planChunks(size: number, chunkBytes = CHUNK_BYTES): ChunkPlan[] {
  if (size <= 0) return [{ offset: 0, end: 0, final: true }];
  const plans: ChunkPlan[] = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, size);
    plans.push({ offset, end, final: end === size });
  }
  return plans;
}

export type ChunkFailureDecision =
  | { action: "retry"; delayMs: number }
  | { action: "restart" }
  | { action: "fail"; code: string };

export function decideChunkFailure(input: {
  status: number;
  code?: string;
  reason?: string;
  offset: number;
  attempt: number;
  restarted: boolean;
  retriedFinal?: boolean;
}): ChunkFailureDecision {
  // If the final chunk failed transiently, an ALREADY_EXISTS on retry or restart may mean the first send succeeded.
  if (input.retriedFinal && (input.status === 409 || input.code === "ALREADY_EXISTS")) {
    return { action: "fail", code: "OPERATION_AMBIGUOUS" };
  }
  if (
    input.status === 0 ||
    input.status === 502 ||
    input.status === 503 ||
    input.status === 504 ||
    input.code === "RESOURCE_LOCKED"
  ) {
    const delayMs = UPLOAD_RETRY_DELAYS_MS[input.attempt];
    if (delayMs !== undefined) {
      return { action: "retry", delayMs };
    }
    return {
      action: "fail",
      code:
        input.code ||
        (input.status === 502 || input.status === 504 ? "OPERATION_AMBIGUOUS" : "DOCKER_ENGINE_UNAVAILABLE"),
    };
  }
  if (
    input.status === 400 &&
    input.offset > 0 &&
    !input.restarted &&
    (input.reason === undefined || input.reason === "upload_mismatch")
  ) {
    return { action: "restart" };
  }
  if (input.status === 401) {
    return { action: "fail", code: input.code || "UNAUTHENTICATED" };
  }
  if (input.status === 403) {
    return { action: "fail", code: input.code || "PERMISSION_DENIED" };
  }
  return { action: "fail", code: input.code || "INTERNAL_ERROR" };
}

export function validateMoveDest(
  fromDir: string,
  items: readonly SiteFileEntryDto[],
  destDir: string,
): "sameFolder" | "intoItself" | null {
  if (destDir === fromDir) return "sameFolder";
  for (const item of items) {
    if (item.kind !== "dir") continue;
    const itemPath = joinPath(fromDir, item.name);
    if (destDir === itemPath || destDir.startsWith(`${itemPath}/`)) {
      return "intoItself";
    }
  }
  return null;
}

export type WriteChunk = {
  path: string;
  uploadId: string;
  offset: number;
  dataBase64: string;
  final: boolean;
  overwrite: boolean;
};

export type ChunkSendResult = {
  status: number;
  received?: number;
  code?: string;
  reason?: string;
};

export type ChunkSender = (c: WriteChunk, signal: AbortSignal) => Promise<ChunkSendResult>;

export type UploadOutcome =
  | { ok: true }
  | {
      ok: false;
      code: string;
      status?: number;
      reason?: string;
      resume: { uploadId: string; offset: number };
    };

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function uploadFile(
  file: Blob,
  path: string,
  overwrite: boolean,
  send: ChunkSender,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
  resume?: { uploadId: string; offset: number },
): Promise<UploadOutcome> {
  let uploadId = resume?.uploadId ?? crypto.randomUUID();
  let offset = resume?.offset ?? 0;
  let attempt = 0;
  let restarted = false;
  let retriedFinal = false;

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      reason: "too_large",
      resume: { uploadId, offset },
    };
  }

  while (true) {
    if (signal.aborted) {
      return { ok: false, code: "cancelled", resume: { uploadId, offset } };
    }

    const end = file.size === 0 ? 0 : Math.min(offset + CHUNK_BYTES, file.size);
    const final = end === file.size;
    let dataBase64: string;
    try {
      dataBase64 = end > offset ? await toBase64(file.slice(offset, end)) : "";
    } catch {
      return { ok: false, code: "FILE_UNREADABLE", resume: { uploadId, offset } };
    }

    if (signal.aborted) {
      return { ok: false, code: "cancelled", resume: { uploadId, offset } };
    }

    let res: ChunkSendResult;
    try {
      res = await send({ path, uploadId, offset, dataBase64, final, overwrite }, signal);
    } catch {
      if (signal.aborted) {
        return { ok: false, code: "cancelled", resume: { uploadId, offset } };
      }
      res = { status: 0 };
    }

    if (res.status >= 200 && res.status < 300) {
      const nextOffset = typeof res.received === "number" ? res.received : end;
      onProgress(Math.min(nextOffset, file.size));
      if (final) {
        return { ok: true };
      }
      if (nextOffset <= offset) {
        return { ok: false, code: "INTERNAL_ERROR", status: res.status, resume: { uploadId, offset } };
      }
      offset = nextOffset;
      attempt = 0;
      continue;
    }

    const decision = decideChunkFailure({
      status: res.status,
      code: res.code,
      reason: res.reason,
      offset,
      attempt,
      restarted,
      retriedFinal,
    });

    if (decision.action === "retry") {
      if (
        final &&
        (res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504)
      ) {
        retriedFinal = true;
      }
      attempt += 1;
      const keptGoing = await sleepAbortable(decision.delayMs, signal);
      if (!keptGoing) {
        return { ok: false, code: "cancelled", resume: { uploadId, offset } };
      }
      continue;
    }

    if (decision.action === "restart") {
      restarted = true;
      offset = 0;
      uploadId = crypto.randomUUID();
      attempt = 0;
      onProgress(0);
      continue;
    }

    return {
      ok: false,
      code: decision.code,
      status: res.status,
      reason: res.reason,
      resume: { uploadId, offset },
    };
  }
}

export function fileErrorText(
  m: Messages,
  code: string,
  scope: "files" | "upload" | "zip" = "files",
  details?: ReadonlyArray<{ field?: string; reason?: string }>,
): string {
  if (code === "FILE_UNREADABLE") {
    return m.site.files.errors.uploadRead;
  }
  if (code === "QUOTA_EXCEEDED") {
    if (scope === "zip") return m.site.files.errors.quotaZip;
    return details?.[0]?.reason === "too_large"
      ? m.site.files.errors.uploadTooLarge
      : m.site.files.errors.quotaUpload;
  }
  if (scope === "zip") {
    if (code === "PERMISSION_DENIED") return m.site.files.errors.PERMISSION_DENIED;
    if (code === "VALIDATION_ERROR") return m.site.files.errors.zipValidation;
    if (code === "ALREADY_EXISTS") return m.site.files.errors.zipExists;
    if (code === "OPERATION_INTERRUPTED") return m.site.files.errors.zipInterrupted;
  }
  if (code === "PERMISSION_DENIED") {
    return details?.[0]?.reason === "protected"
      ? m.site.files.errors.PERMISSION_DENIED
      : errorMessage(m, "PERMISSION_DENIED");
  }
  const errors = m.site.files.errors as Record<string, string>;
  if (/^[A-Z_]+$/.test(code) && Object.hasOwn(errors, code)) {
    return errors[code]!;
  }
  return errorMessage(m, code);
}

export function describeFileOpOutcome(
  m: Messages,
  op: { status: string; errorCode?: string | null; errorMessage?: string | null },
): string | null {
  if (op.status !== "failed") return null;
  return fileErrorText(m, op.errorCode ?? "", "zip");
}

/** Triggers a native browser file download using a temporary anchor element. */
export function triggerBrowserDownload(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Checks that the first byte of a file is readable before triggering a browser download. */
export async function precheckDownload(opts: {
  apiBase: string;
  path: string;
  messages: Messages;
  fetchFn?: typeof fetch;
  triggerLink?: (href: string) => void;
}): Promise<string | null> {
  const fetchImpl = opts.fetchFn ?? fetch;
  const trigger = opts.triggerLink ?? triggerBrowserDownload;
  try {
    const res = await fetchImpl(
      `${opts.apiBase}/files/content?path=${encodeURIComponent(opts.path)}&offset=0&length=1`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as {
        error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
      } | null;
      return mutationErrorFromResponse(opts.messages, res.status, json, "files");
    }
    trigger(`${opts.apiBase}/files/download?path=${encodeURIComponent(opts.path)}`);
    return null;
  } catch {
    return errorMessage(opts.messages, "NETWORK_ERROR");
  }
}

export function mutationErrorFromResponse(
  m: Messages,
  status: number,
  json: { error?: { code?: string; details?: Array<{ field?: string; reason?: string }> } } | null,
  scope: "files" | "upload" | "zip" = "files",
): string {
  const code = status === 502 || status === 504 ? "OPERATION_AMBIGUOUS" : (json?.error?.code ?? "");
  return fileErrorText(m, code, scope, json?.error?.details);
}
