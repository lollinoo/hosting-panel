import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { SiteFileEntryDto } from "@hosting-panel/contracts";
import { SITE_FILES_MAX_FILE_BYTES } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("path=wp-content"),
  usePathname: () => "/sites/s1/files",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { SITE_TABS } from "@/components/customer/site-tabs";
import { Dialog } from "@/components/ui/dialog";
import { FileBreadcrumb, FileTable } from "@/components/customer/file-list";
import {
  DeleteFilesForm,
  NameDialogForm,
  ReplaceFilesForm,
  createFolderLoader,
  guardDialogClose,
} from "@/components/customer/file-dialogs";
import {
  decodeEditorContent,
  encodeEditorContent,
  saveEditorFile,
} from "@/components/customer/file-editor";
import {
  UploadList,
  createInAppNavigationHandler,
  drainUploadQueue,
  prepareQueuedUploads,
  type UploadItem,
} from "@/components/customer/file-uploads";
import {
  FilesListBody,
  FilesNotReady,
  FilesPanel,
  isRootNotReadyResponse,
  precheckDownload,
} from "@/components/customer/files-panel";
import {
  CHUNK_BYTES,
  EDITOR_MAX_BYTES,
  LARGE_UPLOAD_HINT_BYTES,
  MAX_UPLOAD_BYTES,
  baseName,
  bytesToBase64,
  crumbs,
  decideChunkFailure,
  describeFileOpOutcome,
  fileErrorText,
  formatDate,
  formatSize,
  fromBase64,
  isEditable,
  isValidName,
  isValidRelativePath,
  isZip,
  joinPath,
  parentPath,
  planChunks,
  sortEntries,
  toBase64,
  uploadFile,
  validateMoveDest,
  type ChunkSender,
} from "@/lib/file-browser";

const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });

const entry = (over: Partial<SiteFileEntryDto> & { name: string }): SiteFileEntryDto => ({
  kind: "file",
  size: 100,
  modifiedAt: "2026-11-10T10:30:00Z",
  writable: true,
  ...over,
});

describe("file-browser helpers", () => {
  it("joins paths, extracts parents, base names, and crumbs", () => {
    expect(joinPath("", "a")).toBe("a");
    expect(joinPath("wp-content", "themes")).toBe("wp-content/themes");
    expect(joinPath("a/", "/b")).toBe("a/b");
    expect(joinPath("a", "")).toBe("a");

    expect(parentPath("")).toBe("");
    expect(parentPath("index.php")).toBe("");
    expect(parentPath("wp-content/themes")).toBe("wp-content");
    expect(parentPath("a/b/c")).toBe("a/b");

    expect(baseName("")).toBe("");
    expect(baseName("index.php")).toBe("index.php");
    expect(baseName("wp-content/themes")).toBe("themes");

    expect(crumbs("")).toEqual([]);
    expect(crumbs("a/b")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
    ]);
  });

  it("validates single names and relative paths", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName(".")).toBe(false);
    expect(isValidName("..")).toBe(false);
    expect(isValidName("...")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
    expect(isValidName("a\u0001")).toBe(false);
    expect(isValidName("a\u007f")).toBe(false);
    expect(isValidName(".htpanel-stage")).toBe(false);
    expect(isValidName("é".repeat(128))).toBe(false); // 256 UTF-8 bytes
    expect(isValidName("a".repeat(255))).toBe(true);
    expect(isValidName(".htaccess")).toBe(true);
    expect(isValidName("wp-config.php")).toBe(true);
    expect(isValidName("café.txt")).toBe(true);

    expect(isValidRelativePath("", true)).toBe(true);
    expect(isValidRelativePath("", false)).toBe(false);
    expect(isValidRelativePath("sub/folder", false)).toBe(true);
    expect(isValidRelativePath("../escape", false)).toBe(false);
    expect(isValidRelativePath("/abs", false)).toBe(false);
    expect(isValidRelativePath("a//b", false)).toBe(false);
    expect(isValidRelativePath("a/.htpanel-x", false)).toBe(false);
  });

  it("checks editable files and zips", () => {
    expect(isEditable(entry({ name: ".htaccess", size: 120 }))).toBe(true);
    expect(isEditable(entry({ name: "wp-config.php", size: EDITOR_MAX_BYTES }))).toBe(true);
    expect(isEditable(entry({ name: "README.MD", size: 10 }))).toBe(true);
    expect(isEditable(entry({ name: "wp-config.php", size: EDITOR_MAX_BYTES + 1 }))).toBe(false);
    expect(isEditable(entry({ name: "logo.png", size: 100 }))).toBe(false);
    expect(isEditable(entry({ name: "themes", kind: "dir", size: 0 }))).toBe(false);
    expect(isEditable(entry({ name: "alias.php", kind: "link", size: 10 }))).toBe(false);

    expect(isZip("backup.zip")).toBe(true);
    expect(isZip("BACKUP.ZIP")).toBe(true);
    expect(isZip("backup.tar.gz")).toBe(false);
  });

  it("sorts folders first and names alphabetically", () => {
    const sorted = sortEntries(
      [
        entry({ name: "wp-config.php", kind: "file" }),
        entry({ name: "wp-content", kind: "dir", size: 0 }),
        entry({ name: "index.php", kind: "file" }),
        entry({ name: "assets", kind: "dir", size: 0 }),
      ],
      "en",
    );
    expect(sorted.map((e) => e.name)).toEqual(["assets", "wp-content", "index.php", "wp-config.php"]);
  });

  it("formats sizes and dates cleanly", () => {
    expect(formatSize(0, "en")).toMatch(/0/);
    expect(formatSize(512, "en")).toMatch(/512/);
    expect(formatSize(1536, "en")).toMatch(/1\.5/);
    expect(formatSize(2 * 1024 * 1024, "it")).toMatch(/2/);
    expect(formatSize(1024 * 1024 * 1024, "en")).toMatch(/1/);

    const formattedEn = formatDate("2026-11-10T10:30:00Z", "en-GB");
    const formattedIt = formatDate("2026-11-10T10:30:00Z", "it-IT");
    expect(formattedEn).toContain("2026");
    expect(formattedIt).toContain("2026");
    expect(formatDate("not-a-date", "en-GB")).toBe("not-a-date");
  });

  it("round-trips 1 MiB of random bytes through base64", async () => {
    const raw = new Uint8Array(1024 * 1024);
    for (let i = 0; i < raw.length; i += 1) {
      raw[i] = (i * 31 + 7) & 0xff;
    }
    const b64 = await toBase64(new Blob([raw]));
    const back = fromBase64(b64);
    expect(back.length).toBe(raw.length);
    expect(back).toEqual(raw);

    expect(await toBase64(new Blob([]))).toBe("");
    expect(bytesToBase64(new TextEncoder().encode("\uFEFFciao"))).toBe(
      await toBase64(new Blob([new TextEncoder().encode("\uFEFFciao")])),
    );
  });

  it("plans chunks for 0, 1, 524288, and 524289 bytes", () => {
    expect(planChunks(0)).toEqual([{ offset: 0, end: 0, final: true }]);
    expect(planChunks(1)).toEqual([{ offset: 0, end: 1, final: true }]);
    expect(planChunks(524_288)).toEqual([{ offset: 0, end: 524_288, final: true }]);
    expect(planChunks(524_289)).toEqual([
      { offset: 0, end: 524_288, final: false },
      { offset: 524_288, end: 524_289, final: true },
    ]);
  });

  it("decides retries, restarts, and failures accurately", () => {
    expect(decideChunkFailure({ status: 0, offset: 0, attempt: 0, restarted: false })).toEqual({
      action: "retry",
      delayMs: 1000,
    });
    expect(decideChunkFailure({ status: 503, offset: 0, attempt: 1, restarted: false })).toEqual({
      action: "retry",
      delayMs: 2000,
    });
    expect(decideChunkFailure({ status: 504, offset: 0, attempt: 2, restarted: false })).toEqual({
      action: "retry",
      delayMs: 4000,
    });
    expect(decideChunkFailure({ status: 502, offset: 0, attempt: 3, restarted: false })).toEqual({
      action: "fail",
      code: "OPERATION_AMBIGUOUS",
    });
    expect(
      decideChunkFailure({ status: 409, code: "RESOURCE_LOCKED", offset: 0, attempt: 0, restarted: false }),
    ).toEqual({ action: "retry", delayMs: 1000 });

    expect(
      decideChunkFailure({
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "upload_mismatch",
        offset: CHUNK_BYTES,
        attempt: 0,
        restarted: false,
      }),
    ).toEqual({ action: "restart" });
    expect(
      decideChunkFailure({
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "upload_mismatch",
        offset: CHUNK_BYTES,
        attempt: 0,
        restarted: true,
      }),
    ).toEqual({ action: "fail", code: "VALIDATION_ERROR" });
    expect(
      decideChunkFailure({
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "invalid_path",
        offset: CHUNK_BYTES,
        attempt: 0,
        restarted: false,
      }),
    ).toEqual({ action: "fail", code: "VALIDATION_ERROR" });
  });

  it("validates move destinations", () => {
    const items = [entry({ name: "themes", kind: "dir", size: 0 })];
    expect(validateMoveDest("wp-content", items, "wp-content")).toBe("sameFolder");
    expect(validateMoveDest("wp-content", items, "wp-content/themes")).toBe("intoItself");
    expect(validateMoveDest("wp-content", items, "wp-content/themes/sub")).toBe("intoItself");
    expect(validateMoveDest("wp-content", items, "")).toBeNull();
    expect(validateMoveDest("wp-content", items, "wp-content/plugins")).toBeNull();
  });

  it("maps error codes and protected reasons via fileErrorText", () => {
    expect(fileErrorText(en, "QUOTA_EXCEEDED", "upload")).toBe(en.site.files.errors.quotaUpload);
    expect(fileErrorText(en, "QUOTA_EXCEEDED", "zip")).toBe(en.site.files.errors.quotaZip);
    expect(fileErrorText(en, "PERMISSION_DENIED", "files", [{ reason: "protected" }])).toBe(
      en.site.files.errors.PERMISSION_DENIED,
    );
    expect(fileErrorText(en, "PERMISSION_DENIED", "files")).toBe(en.errors.PERMISSION_DENIED);
    expect(fileErrorText(en, "PERMISSION_DENIED", "files", [{ reason: "denied" }])).toBe(
      en.errors.PERMISSION_DENIED,
    );
    expect(fileErrorText(en, "ALREADY_EXISTS")).toBe(en.site.files.errors.ALREADY_EXISTS);
    expect(fileErrorText(en, "RESOURCE_LOCKED")).toBe(en.errors.RESOURCE_LOCKED);
    expect(fileErrorText(en, "NO_SUCH_ERROR")).toBe(en.errors.generic);
  });
});

describe("uploadFile", () => {
  it("uploads a 1.2 MiB file in 512 KiB chunks with final only on the last chunk", async () => {
    const bytes = new Uint8Array(Math.round(1.2 * 1024 * 1024));
    const blob = new Blob([bytes]);
    const calls: { offset: number; len: number; final: boolean; uploadId: string }[] = [];
    const progress: number[] = [];

    const send: ChunkSender = async (c) => {
      const len = fromBase64(c.dataBase64).length;
      calls.push({ offset: c.offset, len, final: c.final, uploadId: c.uploadId });
      return { status: 200, received: c.offset + len };
    };

    const res = await uploadFile(
      blob,
      "big.bin",
      false,
      send,
      (n) => progress.push(n),
      new AbortController().signal,
    );

    expect(res).toEqual({ ok: true });
    expect(calls.map((c) => [c.offset, c.final])).toEqual([
      [0, false],
      [524_288, false],
      [1_048_576, true],
    ]);
    expect(new Set(calls.map((c) => c.uploadId)).size).toBe(1);
    expect(progress.at(-1)).toBe(bytes.length);
  });

  it("uploads an empty file as one final chunk with empty base64", async () => {
    const calls: { dataBase64: string; final: boolean; offset: number }[] = [];
    const res = await uploadFile(
      new Blob([]),
      "empty.txt",
      false,
      async (c) => {
        calls.push({ dataBase64: c.dataBase64, final: c.final, offset: c.offset });
        return { status: 200, received: 0 };
      },
      () => {},
      new AbortController().signal,
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([{ dataBase64: "", final: true, offset: 0 }]);
  });

  it("retries 503 at the same offset with the same uploadId", async () => {
    vi.useFakeTimers();
    try {
      const seen: { offset: number; uploadId: string }[] = [];
      let count = 0;
      const promise = uploadFile(
        new Blob([new Uint8Array(10)]),
        "a.txt",
        false,
        async (c) => {
          seen.push({ offset: c.offset, uploadId: c.uploadId });
          count += 1;
          if (count === 1) return { status: 503, code: "DOCKER_ENGINE_UNAVAILABLE" };
          return { status: 200, received: 10 };
        },
        () => {},
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await promise;
      expect(outcome).toEqual({ ok: true });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses server received offset to drive next chunk", async () => {
    const offsets: number[] = [];
    const blob = new Blob([new Uint8Array(600_000)]);
    const res = await uploadFile(
      blob,
      "f.bin",
      false,
      async (c) => {
        offsets.push(c.offset);
        if (c.offset === 0) return { status: 200, received: 300_000 };
        return { status: 200, received: 600_000 };
      },
      () => {},
      new AbortController().signal,
    );
    expect(res).toEqual({ ok: true });
    expect(offsets).toEqual([0, 300_000]);
  });

  it("restarts once from 0 with a new uploadId on 400 upload_mismatch and fails on a second 400", async () => {
    const blob = new Blob([new Uint8Array(CHUNK_BYTES + 10)]);
    const calls: { offset: number; uploadId: string }[] = [];
    const res = await uploadFile(
      blob,
      "x.bin",
      false,
      async (c) => {
        calls.push({ offset: c.offset, uploadId: c.uploadId });
        if (c.offset === 0) return { status: 200, received: CHUNK_BYTES };
        return { status: 400, code: "VALIDATION_ERROR", reason: "upload_mismatch" };
      },
      () => {},
      new AbortController().signal,
    );
    expect(calls).toHaveLength(4); // 0 -> 524288 (400, restart) -> 0 (new id) -> 524288 (400, fail)
    expect(calls[0]!.uploadId).toBe(calls[1]!.uploadId);
    expect(calls[2]!.uploadId).toBe(calls[3]!.uploadId);
    expect(calls[2]!.uploadId).not.toBe(calls[0]!.uploadId);
    expect(res).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      status: 400,
      reason: "upload_mismatch",
      resume: { uploadId: calls[2]!.uploadId, offset: CHUNK_BYTES },
    });
  });

  it("returns UNAUTHENTICATED with resume data on 401 and cancelled on abort", async () => {
    const blob = new Blob([new Uint8Array(CHUNK_BYTES + 10)]);
    const r401 = await uploadFile(
      blob,
      "x.bin",
      false,
      async (c) => (c.offset === 0 ? { status: 200, received: CHUNK_BYTES } : { status: 401, code: "UNAUTHENTICATED" }),
      () => {},
      new AbortController().signal,
    );
    expect(r401.ok).toBe(false);
    if (!r401.ok) {
      expect(r401.code).toBe("UNAUTHENTICATED");
      expect(r401.resume.offset).toBe(CHUNK_BYTES);
    }

    const ac = new AbortController();
    const rAbort = await uploadFile(
      blob,
      "x.bin",
      false,
      async () => {
        ac.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      () => {},
      ac.signal,
    );
    expect(rAbort.ok).toBe(false);
    if (!rAbort.ok) {
      expect(rAbort.code).toBe("cancelled");
    }
  });
});

describe("Files tab navigation and catalog", () => {
  it("places files tab right after domains with href /sites/:id/files", () => {
    const keys = SITE_TABS.map((t) => t.key);
    expect(keys).toEqual(["overview", "domains", "files", "logs"]);
    expect(SITE_TABS[2]!.href("s1")).toBe("/sites/s1/files");
  });

  it("keeps SFTP keys and wording out of cycle 1 catalogs", () => {
    const collectKeys = (obj: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) => {
        const keyPath = prefix ? `${prefix}.${k}` : k;
        return typeof v === "object" && v !== null
          ? [keyPath, ...collectKeys(v as Record<string, unknown>, keyPath)]
          : [keyPath];
      });

    for (const m of [en, itMsgs]) {
      for (const k of collectKeys(m.site.files as unknown as Record<string, unknown>)) {
        expect(k, `key ${k}`).not.toMatch(/sftp/i);
      }
      expect(m.site.files.upload.largeHint).not.toMatch(/\bsftp\b/i);
      expect(m.site.files.truncated).not.toMatch(/\bsftp\b/i);
      expect(m.site.files.errors.quotaZip).not.toMatch(/\bsftp\b/i);
    }
  });
});

describe("Files UI static markup", () => {
  it("FileTable renders headers, row names, select labels, folder dash, shortcut, and lock text", () => {
    const entries: SiteFileEntryDto[] = [
      entry({ name: "wp-content", kind: "dir", size: 0 }),
      entry({ name: "index.php", kind: "file", size: 420 }),
      entry({ name: "hp-mail.php", kind: "file", size: 200, writable: false }),
      entry({ name: "current", kind: "link", size: 0 }),
    ];
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(
        wrap(
          m,
          createElement(FileTable, {
            entries,
            folderName: m.site.files.rootLabel,
            selected: new Set(["index.php"]),
            onToggle: () => {},
            onToggleAll: () => {},
            onOpen: () => {},
            locale: m.common.dateLocale,
          }),
        ),
      ).replaceAll("&#x27;", "'");
      expect(html).toContain(m.site.files.list.name);
      expect(html).toContain(m.site.files.list.size);
      expect(html).toContain(m.site.files.list.changed);
      expect(html).toContain(`aria-label="${m.site.files.list.select.replace("{name}", "index.php")}"`);
      expect(html).toContain(`aria-label="${m.site.files.list.selectAll}"`);
      expect(html).toContain(m.site.files.list.protected);
      expect(html).toContain(m.site.files.list.shortcut);
      expect(html).toContain("—");
      expect(html).toContain("wp-content");
      expect(html).toContain("hp-mail.php");
    }
  });

  it("FileBreadcrumb marks the last crumb with aria-current=page", () => {
    const htmlRoot = renderToStaticMarkup(
      wrap(en, createElement(FileBreadcrumb, { path: "", onOpen: () => {} })),
    );
    expect(htmlRoot).toContain('aria-current="page"');
    expect(htmlRoot).toContain(en.site.files.rootLabel);

    const htmlSub = renderToStaticMarkup(
      wrap(en, createElement(FileBreadcrumb, { path: "wp-content/themes", onOpen: () => {} })),
    );
    expect(htmlSub).toContain("<button");
    expect(htmlSub).toMatch(/<span[^>]*aria-current="page"[^>]*>themes<\/span>/);
  });

  it("DeleteFilesForm shows count body for three items and consequence text for single items", () => {
    const three = [entry({ name: "a.php" }), entry({ name: "b.php" }), entry({ name: "c", kind: "dir", size: 0 })];
    for (const m of [en, itMsgs]) {
      const htmlMany = renderToStaticMarkup(
        wrap(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(DeleteFilesForm, { items: three, onConfirm: async () => null, onCancel: () => {} }),
          ),
        ),
      ).replaceAll("&#x27;", "'");
      expect(htmlMany).toContain(m.site.files.delete.titleMany.replace("{count}", "3"));
      expect(htmlMany).toContain(m.site.files.delete.bodyMany.replace("{count}", "3"));
      expect(htmlMany).toContain(m.site.files.delete.confirm);

      const htmlFolder = renderToStaticMarkup(
        wrap(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(DeleteFilesForm, {
              items: [entry({ name: "uploads", kind: "dir", size: 0 })],
              onConfirm: async () => null,
              onCancel: () => {},
            }),
          ),
        ),
      ).replaceAll("&#x27;", "'");
      expect(htmlFolder).toContain(m.site.files.delete.bodyFolder);
    }
  });

  it("NameDialogForm and ReplaceFilesForm render accessible labels and actions", () => {
    const nameHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(NameDialogForm, {
            title: en.site.files.newFolder.title,
            label: en.site.files.newFolder.label,
            hint: en.site.files.nameRule,
            initial: "",
            submitLabel: en.site.files.newFolder.submit,
            workingLabel: en.site.files.newFolder.working,
            onSubmit: async () => null,
            onCancel: () => {},
          }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    expect(nameHtml).toContain(en.site.files.newFolder.label);
    expect(nameHtml).toContain(en.site.files.nameRule);
    expect(nameHtml).toContain("for=");

    const replaceHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(ReplaceFilesForm, {
            names: ["index.php", "style.css"],
            onReplace: () => {},
            onSkip: () => {},
            onCancel: () => {},
          }),
        ),
      ),
    );
    expect(replaceHtml).toContain("index.php, style.css");
    expect(replaceHtml).toContain(en.site.files.upload.replace);
    expect(replaceHtml).toContain(en.site.files.upload.skip);
  });

  it("UploadList shows summary, progress label, and large-file hint without mentioning SFTP", () => {
    const items: UploadItem[] = [
      {
        id: "1",
        file: new File(["x"], "theme.zip"),
        path: "theme.zip",
        overwrite: false,
        sent: 1,
        status: "done",
        error: null,
      },
      {
        id: "2",
        file: { name: "video.mp4", size: LARGE_UPLOAD_HINT_BYTES + 1 } as File,
        path: "video.mp4",
        overwrite: false,
        sent: 50 * 1024 * 1024,
        status: "uploading",
        error: null,
      },
    ];
    const html = renderToStaticMarkup(
      wrap(
        en,
        createElement(UploadList, {
          items,
          onCancel: () => {},
          onRetry: () => {},
          onCancelAll: () => {},
          onDismiss: () => {},
        }),
      ),
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="video.mp4"');
    expect(html).toContain(en.site.files.upload.largeHint);
    expect(html).not.toMatch(/sftp/i);
  });

  it("FilesNotReady and FilesPanel render expected markup and no SFTP link", () => {
    for (const m of [en, itMsgs]) {
      const notReadyHtml = renderToStaticMarkup(wrap(m, createElement(FilesNotReady))).replaceAll("&#x27;", "'");
      expect(notReadyHtml).toContain(m.site.files.notReady);
      expect(notReadyHtml).not.toContain('role="toolbar"');
    }

    const panelHtml = renderToStaticMarkup(
      wrap(en, createElement(FilesPanel, { apiBase: "/api/bff/orgs/o1/managed-sites/s1", orgId: "o1", siteId: "s1", csrfToken: "c" })),
    );
    expect(panelHtml).toContain('role="toolbar"');
    expect(panelHtml).toContain(`aria-label="${en.site.files.breadcrumb}"`);
    expect(panelHtml).toContain(en.site.files.loading);
    expect(panelHtml).not.toMatch(/sftp/i);
  });
});

describe("Cycle 1 fix-round-1 regression tests", () => {
  it("Defect 1: unreadable file in uploadFile and pump fails cleanly with read error text and advances queue", async () => {
    const badBlob = new Blob(["ok"]);
    badBlob.slice = () => badBlob;
    badBlob.arrayBuffer = async () => {
      throw new DOMException("NotReadableError", "NotReadableError");
    };
    const unreadable = await uploadFile(
      badBlob,
      "missing.txt",
      false,
      async () => {
        throw new Error("should not send");
      },
      () => {},
      new AbortController().signal,
    );
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) {
      expect(unreadable.code).toBe("FILE_UNREADABLE");
      expect(fileErrorText(en, unreadable.code, "upload")).toBe(en.site.files.errors.uploadRead);
    }

    const queue: UploadItem[] = [
      { id: "1", file: badBlob as File, path: "bad.txt", overwrite: false, sent: 0, status: "waiting", error: null },
      {
        id: "2",
        file: new File(["hello"], "good.txt"),
        path: "good.txt",
        overwrite: false,
        sent: 0,
        status: "waiting",
        error: null,
      },
    ];
    const sentPaths: string[] = [];
    await drainUploadQueue({
      getNextWaiting: () => queue.find((it) => it.status === "waiting"),
      shouldStop: () => false,
      onStart: (id) => {
        const it = queue.find((x) => x.id === id)!;
        it.status = "uploading";
      },
      sendItem: (item, signal) =>
        uploadFile(
          item.file,
          item.path,
          item.overwrite,
          async (chunk) => {
            sentPaths.push(chunk.path);
            return { status: 200, received: item.file.size };
          },
          () => {},
          signal,
        ),
      setAbortController: () => {},
      onOutcome: (item, outcome) => {
        const target = queue.find((x) => x.id === item.id)!;
        if (outcome.ok) {
          target.status = "done";
        } else {
          target.status = "failed";
          target.error = fileErrorText(en, outcome.code, "upload");
        }
      },
      onUnexpectedError: (item) => {
        const target = queue.find((x) => x.id === item.id)!;
        target.status = "failed";
        target.error = en.errors.generic;
      },
    });

    expect(queue[0]!.status).toBe("failed");
    expect(queue[0]!.error).toBe(en.site.files.errors.uploadRead);
    expect(queue[1]!.status).toBe("done");
    expect(sentPaths).toEqual(["good.txt"]);
  });

  it("Defect 2: failed zip/unzip operations pick zip-scoped text by errorCode, ignoring sentence errorMessage", () => {
    expect(
      describeFileOpOutcome(en, {
        status: "failed",
        errorCode: "VALIDATION_ERROR",
        errorMessage: "Not a valid zip archive",
      }),
    ).toBe(en.site.files.errors.zipValidation);
    expect(fileErrorText(en, "VALIDATION_ERROR", "zip")).toBe(en.site.files.errors.zipValidation);
    expect(fileErrorText(en, "PERMISSION_DENIED", "zip")).toBe(en.site.files.errors.PERMISSION_DENIED);
    expect(fileErrorText(en, "ALREADY_EXISTS", "zip")).toBe(en.site.files.errors.zipExists);
    expect(fileErrorText(en, "QUOTA_EXCEEDED", "zip")).toBe(en.site.files.errors.quotaZip);
    expect(fileErrorText(en, "OPERATION_INTERRUPTED", "zip")).toBe(en.site.files.errors.zipInterrupted);
    expect(fileErrorText(en, "VALIDATION_ERROR", "files")).toBe(en.site.files.errors.VALIDATION_ERROR);
  });

  it("Defect 3: files over 2 GiB fail on queue without sending and too_large maps to uploadTooLarge", async () => {
    expect(MAX_UPLOAD_BYTES).toBe(SITE_FILES_MAX_FILE_BYTES);
    const oversized = { name: "huge.tar", size: MAX_UPLOAD_BYTES + 1 } as File;
    const prepared = prepareQueuedUploads([{ file: oversized, path: "huge.tar", overwrite: false }], en);
    expect(prepared.startPump).toBe(false);
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]!.status).toBe("failed");
    expect(prepared.items[0]!.error).toBe(en.site.files.errors.uploadTooLarge);
    expect(prepared.items[0]!.error).toContain("2 GB");

    const sendSpy = vi.fn();
    const res = await uploadFile(oversized, "huge.tar", false, sendSpy, () => {}, new AbortController().signal);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      code: "QUOTA_EXCEEDED",
      reason: "too_large",
      resume: { uploadId: expect.any(String), offset: 0 },
    });

    expect(fileErrorText(en, "QUOTA_EXCEEDED", "upload", [{ reason: "too_large" }])).toBe(
      en.site.files.errors.uploadTooLarge,
    );
    expect(fileErrorText(en, "QUOTA_EXCEEDED", "upload", [{ reason: "disk_full" }])).toBe(
      en.site.files.errors.quotaUpload,
    );
  });

  it("Defect 4: downloads pre-check GET files/content?offset=0&length=1 and abort download when pre-check fails", async () => {
    const triggered: string[] = [];
    const fetch404 = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await precheckDownload({
      apiBase: "/api/bff/orgs/o1/managed-sites/s1",
      path: "gone.zip",
      messages: en,
      fetchFn: fetch404 as unknown as typeof fetch,
      triggerLink: (href) => triggered.push(href),
    });
    expect(fetch404).toHaveBeenCalledWith(
      "/api/bff/orgs/o1/managed-sites/s1/files/content?path=gone.zip&offset=0&length=1",
      { cache: "no-store" },
    );
    expect(triggered).toEqual([]);
    expect(err).toBe(en.site.files.errors.NOT_FOUND);

    const fetchOk = vi.fn(async () => new Response(JSON.stringify({ data: { dataBase64: "", size: 0, eof: true } }), { status: 200 }));
    const okErr = await precheckDownload({
      apiBase: "/api/bff/orgs/o1/managed-sites/s1",
      path: "ok.zip",
      messages: en,
      fetchFn: fetchOk as unknown as typeof fetch,
      triggerLink: (href) => triggered.push(href),
    });
    expect(okErr).toBeNull();
    expect(triggered).toEqual(["/api/bff/orgs/o1/managed-sites/s1/files/download?path=ok.zip"]);
  });

  it("Defect 5 & 9: editor detects external modification before PUT and preserves CRLF line endings", async () => {
    const decoded = decodeEditorContent("a\r\nb\r\n");
    expect(decoded).toEqual({ text: "a\nb\n", crlf: true });
    expect(encodeEditorContent("a\nc\n", decoded.crlf)).toBe("a\r\nc\r\n");

    const fetchConflict = vi.fn(async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          data: {
            entries: [entry({ name: "wp-config.php", size: 120, modifiedAt: "2026-11-10T11:00:00Z" })],
            truncated: false,
          },
        }),
        { status: 200 },
      ),
    );
    const conflictOutcome = await saveEditorFile({
      apiBase: "/api/bff/orgs/o1/managed-sites/s1",
      csrfToken: "csrf",
      path: "wp-config.php",
      text: "edited",
      crlf: false,
      openedMeta: { size: 100, modifiedAt: "2026-11-10T10:30:00Z" },
      messages: en,
      fetchFn: fetchConflict as unknown as typeof fetch,
    });
    expect(conflictOutcome).toEqual({ status: "conflict" });
    expect(fetchConflict).toHaveBeenCalledTimes(1);
    expect(fetchConflict.mock.calls[0]![0]).toBe("/api/bff/orgs/o1/managed-sites/s1/files?path=");

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchSaveCrlf = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ data: { size: 6 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            entries: [entry({ name: "script.bat", size: 6, modifiedAt: "2026-11-10T10:30:00Z" })],
            truncated: false,
          },
        }),
        { status: 200 },
      );
    });
    const saveOutcome = await saveEditorFile({
      apiBase: "/api/bff/orgs/o1/managed-sites/s1",
      csrfToken: "csrf",
      path: "script.bat",
      text: "a\nc",
      crlf: true,
      openedMeta: { size: 6, modifiedAt: "2026-11-10T10:30:00Z" },
      messages: en,
      fetchFn: fetchSaveCrlf as unknown as typeof fetch,
    });
    expect(saveOutcome.status).toBe("saved");
    const putCall = calls.find((c) => c.method === "PUT")!;
    const parsedPut = JSON.parse(putCall.body!) as { dataBase64: string };
    expect(Buffer.from(parsedPut.dataBase64, "base64").toString("utf-8")).toBe("a\r\nc");
  });

  it("Defect 6: reloading an already populated folder keeps the FileTable in the DOM with a role=status indicator", () => {
    const entries: SiteFileEntryDto[] = [entry({ name: "index.php", kind: "file", size: 420 })];
    const html = renderToStaticMarkup(
      wrap(
        en,
        createElement(FilesListBody, {
          loading: true,
          loadError: null,
          entries,
          entriesFolder: "wp-content",
          folder: "wp-content",
          selected: new Set<string>(),
          onToggle: () => {},
          onToggleAll: () => {},
          onOpen: () => {},
          onRetry: () => {},
          locale: en.common.dateLocale,
        }),
      ),
    );
    expect(html).toContain("<table");
    expect(html).toContain("index.php");
    expect(html).toContain('role="status"');
    expect(html).toContain(en.site.files.loading);
  });

  it("Defect 7: clicking an in-app link during active uploads confirms with leaveWarning and blocks navigation when declined", () => {
    let active = true;
    const confirmCalls: string[] = [];
    let allow = false;
    const handler = createInAppNavigationHandler({
      hasActive: () => active,
      getWarning: () => en.site.files.upload.leaveWarning,
      confirm: (msg) => {
        confirmCalls.push(msg);
        return allow;
      },
      currentOrigin: "http://localhost:3000",
      currentHref: "http://localhost:3000/sites/s1/files",
    });

    const link = {
      tagName: "A",
      getAttribute: (name: string) => (name === "href" ? "/sites/s1/domains" : null),
      hasAttribute: () => false,
    };
    const fakeTarget = {
      closest: (sel: string) => (sel === "a[href]" ? link : null),
    };
    let prevented = false;
    let stopped = false;
    handler({
      target: fakeTarget as unknown as EventTarget,
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    } as unknown as MouseEvent);

    expect(confirmCalls).toEqual([en.site.files.upload.leaveWarning]);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);

    allow = true;
    prevented = false;
    handler({
      target: fakeTarget as unknown as EventTarget,
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    expect(prevented).toBe(false);

    active = false;
    handler({
      target: fakeTarget as unknown as EventTarget,
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    expect(confirmCalls).toHaveLength(2);
  });

  it("Defect 8: lost answer on final chunk ending in ALREADY_EXISTS becomes OPERATION_AMBIGUOUS", async () => {
    expect(
      decideChunkFailure({
        status: 409,
        code: "ALREADY_EXISTS",
        offset: 0,
        attempt: 0,
        restarted: true,
        retriedFinal: true,
      }),
    ).toEqual({ action: "fail", code: "OPERATION_AMBIGUOUS" });

    const blob = new Blob([new Uint8Array(CHUNK_BYTES + 10)]);
    let step = 0;
    const outcome = await uploadFile(
      blob,
      "archive.zip",
      false,
      async (c) => {
        step += 1;
        if (step === 1 && c.offset === 0) return { status: 200, received: CHUNK_BYTES };
        if (step === 2 && c.final) return { status: 504 };
        if (step === 3 && c.final) return { status: 400, code: "VALIDATION_ERROR", reason: "upload_mismatch" };
        if (step === 4 && c.offset === 0) return { status: 409, code: "ALREADY_EXISTS" };
        throw new Error(`unexpected step ${step}`);
      },
      () => {},
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("OPERATION_AMBIGUOUS");
      expect(fileErrorText(en, outcome.code, "upload")).toBe(en.site.files.errors.OPERATION_AMBIGUOUS);
    }
  });

  it("Defect 11: Move dialog folder loader ignores stale out-of-order responses", async () => {
    let folders: SiteFileEntryDto[] = [];
    let loadError: string | null = null;
    let loading = false;

    const resolvers = new Map<string, (res: Response) => void>();
    const fakeFetch = vi.fn(
      (url: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          resolvers.set(String(url), resolve);
        }),
    );

    const loader = createFolderLoader({
      apiBase: "/api/bff/orgs/o1/managed-sites/s1",
      locale: "en",
      messages: en,
      fetchFn: fakeFetch as unknown as typeof fetch,
      onLoading: (v) => {
        loading = v;
      },
      onFolders: (dirs) => {
        folders = dirs;
      },
      onError: (err) => {
        loadError = err;
      },
    });

    const pA = loader.load("folder-a");
    const pB = loader.load("folder-b");

    resolvers.get("/api/bff/orgs/o1/managed-sites/s1/files?path=folder-b")!(
      new Response(JSON.stringify({ data: { entries: [entry({ name: "b-child", kind: "dir", size: 0 })] } }), {
        status: 200,
      }),
    );
    await pB;

    resolvers.get("/api/bff/orgs/o1/managed-sites/s1/files?path=folder-a")!(
      new Response(JSON.stringify({ data: { entries: [entry({ name: "a-child", kind: "dir", size: 0 })] } }), {
        status: 200,
      }),
    );
    await pA;

    expect(loading).toBe(false);
    expect(loadError).toBeNull();
    expect(folders.map((d) => d.name)).toEqual(["b-child"]);
  });

  it("Defect 12: guardDialogClose ignores closing while a request is running", () => {
    let busy = true;
    const onOpenChange = vi.fn();
    const guarded = guardDialogClose(() => busy, onOpenChange);

    guarded(false);
    expect(onOpenChange).not.toHaveBeenCalled();

    busy = false;
    guarded(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Defect 14: root listing NOT_FOUND maps to notReady while subfolder NOT_FOUND stays a listing error", () => {
    expect(isRootNotReadyResponse("", 404, "NOT_FOUND")).toBe(true);
    expect(isRootNotReadyResponse("", 404)).toBe(true);
    expect(isRootNotReadyResponse("wp-content", 404, "NOT_FOUND")).toBe(false);
    expect(isRootNotReadyResponse("", 503, "DOCKER_ENGINE_UNAVAILABLE")).toBe(false);
  });
});
