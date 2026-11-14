import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  SITE_FILES_LIST_MAX,
  SITE_FILES_MAX_FILE_BYTES,
  SITE_FILES_RESULT_SCHEMAS,
  type SiteFileErrorReason,
  type SiteFilesOp,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_FILES_DIR,
  SITE_FILES_PROGRAM,
  ensureSiteFilesProgram,
} from "../src/site-files-program.js";

const hasPhp = spawnSync("php", ["--version"]).status === 0;
const hasZip =
  hasPhp && spawnSync("php", ["-r", "exit(class_exists('ZipArchive') ? 0 : 1);"]).status === 0;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

async function makeTempDir(prefix = "hp-site-files-prog-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface PhpProgramOk {
  readonly ok: true;
  readonly result: Record<string, unknown>;
}

interface PhpProgramFail {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

type PhpProgramReply = PhpProgramOk | PhpProgramFail;

async function writeProgramScript(): Promise<string> {
  const progDir = await makeTempDir("hp-site-files-script-");
  await ensureSiteFilesProgram(progDir);
  return path.join(progDir, "hp-files.php");
}

function runPhpRaw(
  scriptPath: string,
  root: string,
  request: Record<string, unknown>,
): string {
  const res = spawnSync(
    "php",
    ["-d", "memory_limit=256M", "-d", "display_errors=stderr", "-d", "max_execution_time=0", scriptPath],
    {
      input: JSON.stringify(request),
      env: { ...process.env, HP_FILES_ROOT: root },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (res.status !== 0) {
    throw new Error(`php exited with ${String(res.status)}: stdout=${res.stdout} stderr=${res.stderr}`);
  }
  return res.stdout;
}

function runPhp(
  scriptPath: string,
  root: string,
  request: Record<string, unknown>,
): PhpProgramReply {
  return JSON.parse(runPhpRaw(scriptPath, root, request)) as PhpProgramReply;
}

function expectOk<O extends SiteFilesOp>(
  reply: PhpProgramReply,
  op: O,
): ReturnType<(typeof SITE_FILES_RESULT_SCHEMAS)[O]["parse"]> {
  if (!reply.ok) {
    throw new Error(`Expected ok:true, got ${reply.code}/${reply.reason}`);
  }
  return SITE_FILES_RESULT_SCHEMAS[op].parse(reply.result) as ReturnType<
    (typeof SITE_FILES_RESULT_SCHEMAS)[O]["parse"]
  >;
}

function expectRefusal(reply: PhpProgramReply, reason: SiteFileErrorReason): void {
  if (reply.ok) {
    throw new Error(`Expected refusal ${reason}, got ok:true (${JSON.stringify(reply.result)})`);
  }
  expect(SITE_FILE_ERROR_REASONS).toContain(reply.reason);
  expect(reply.reason).toBe(reason);
  expect(reply.code).toBe(SITE_FILE_REASON_CODES[reason]);
}

async function listTreeSnapshot(root: string, rel = ""): Promise<string[]> {
  const full = rel === "" ? root : path.join(root, rel);
  const items = await readdir(full);
  items.sort();
  const out: string[] = [];
  for (const item of items) {
    const childRel = rel === "" ? item : `${rel}/${item}`;
    const childFull = path.join(full, item);
    const st = await lstat(childFull);
    if (st.isSymbolicLink()) {
      out.push(`L:${childRel}`);
    } else if (st.isDirectory()) {
      out.push(`D:${childRel}`);
      out.push(...(await listTreeSnapshot(root, childRel)));
    } else if (st.isFile()) {
      const hash = createHash("sha256").update(await readFile(childFull)).digest("hex");
      out.push(`F:${childRel}:${st.size}:${hash}`);
    } else {
      out.push(`O:${childRel}`);
    }
  }
  return out;
}

interface TestZipEntry {
  readonly name: string;
  readonly data?: Buffer;
  readonly unixMode?: number;
  readonly deflate?: boolean;
  readonly spoofDeclaredSize?: number;
}

function buildTestZip(entries: readonly TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data ?? Buffer.alloc(0);
    const compMethod = entry.deflate ? 8 : 0;
    const compData = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const uncompSize = (entry.spoofDeclaredSize ?? raw.length) >>> 0;
    const compSize = compData.length >>> 0;
    const flags = 0x0800; // UTF-8 filename

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(compMethod, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x5421, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compSize, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, compData);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(entry.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(compMethod, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x5421, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compSize, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(entry.unixMode !== undefined ? ((entry.unixMode & 0xffff) << 16) >>> 0 : 0, 38);
    cdh.writeUInt32LE(offset >>> 0, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compData.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe("site files program metadata and installer", () => {
  it("exports the default directory and a clean PHP program without shell-out or interpolation", () => {
    expect(DEFAULT_SITE_FILES_DIR).toBe("/var/lib/hosting-panel/site-files");
    expect(SITE_FILES_PROGRAM.startsWith("<?php")).toBe(true);
    expect(SITE_FILES_PROGRAM).not.toContain("`");
    expect(SITE_FILES_PROGRAM).not.toContain("${");
    expect(SITE_FILES_PROGRAM).not.toMatch(
      /\b(?:exec|system|passthru|shell_exec|proc_open|popen|eval)\b/i,
    );
  });

  it("ensureSiteFilesProgram sets 0755/0644 under umask 0007 and updates atomically only on change", async () => {
    const dir = path.join(await makeTempDir(), "site-files");
    const file = path.join(dir, "hp-files.php");
    const previous = process.umask(0o007);
    try {
      await ensureSiteFilesProgram(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      expect(await readFile(file, "utf8")).toBe(SITE_FILES_PROGRAM);

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);
      const beforeMtime = (await stat(file)).mtimeMs;
      const beforeInode = (await stat(file)).ino;
      await chmod(file, 0o600);

      await ensureSiteFilesProgram(dir);
      expect((await stat(file)).mtimeMs).toBe(beforeMtime);
      expect((await stat(file)).ino).toBe(beforeInode);
      expect((await stat(file)).mode & 0o777).toBe(0o644);

      await writeFile(file, "tampered", { mode: 0o600 });
      await ensureSiteFilesProgram(dir);
      expect(await readFile(file, "utf8")).toBe(SITE_FILES_PROGRAM);
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      expect(await readdir(dir)).toEqual(["hp-files.php"]);
    } finally {
      process.umask(previous);
    }
  });
});

describe("site files program (real php)", () => {
  it.skipIf(!hasPhp)("refuses invalid, traversal, absolute, NUL/control, reserved and oversized paths", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await writeFile(path.join(root, "ok.txt"), "hello");

    const badPaths = [
      "../x",
      "a/../b",
      "a/..",
      ".",
      "a/./b",
      "/etc/passwd",
      "/ok.txt",
      "a//b",
      "a/",
      "a\u0000b",
      "a\nb",
      "a\x7fb",
      ".htpanel-upload-abc",
      "sub/.htpanel-upload-abc",
      `${"x".repeat(256)}`,
      `${"a/".repeat(513)}b`,
    ];

    for (const bad of badPaths) {
      expectRefusal(runPhp(script, root, { op: "stat", path: bad }), "invalid_path");
      expectRefusal(runPhp(script, root, { op: "read", path: bad, offset: 0, length: 10 }), "invalid_path");
      expectRefusal(runPhp(script, root, { op: "mkdir", path: bad }), "invalid_path");
    }

    expectRefusal(runPhp(script, root, { op: "mkdir", path: "" }), "invalid_path");
    expectRefusal(runPhp(script, root, { op: "read", path: "", offset: 0, length: 10 }), "invalid_path");
  });

  it.skipIf(!hasPhp)("list sorts dirs first in byte order, hides .htpanel-* and invalid UTF-8, shows links, and truncates past 5000", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();

    await mkdir(path.join(root, "zdir"));
    await mkdir(path.join(root, "Adir"));
    await writeFile(path.join(root, "b.txt"), "bb");
    await writeFile(path.join(root, "A.txt"), "a");
    await writeFile(path.join(root, ".htpanel-upload-1234567890abcdef.part"), "staging");
    await symlink("/etc", path.join(root, "out-link"));
    await symlink("missing-target", path.join(root, "broken-link"));
    await writeFile(Buffer.from(path.join(root, "bad\xffname"), "latin1"), "x").catch(() => undefined);

    const listed = expectOk(runPhp(script, root, { op: "list", path: "" }), "list");
    expect(listed.truncated).toBe(false);
    expect(listed.entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ["Adir", "dir", 0],
      ["zdir", "dir", 0],
      ["A.txt", "file", 1],
      ["b.txt", "file", 2],
      ["broken-link", "link", 14],
      ["out-link", "link", 4],
    ]);

    expectRefusal(runPhp(script, root, { op: "list", path: "b.txt" }), "not_a_directory");
    expectRefusal(runPhp(script, root, { op: "list", path: "nope" }), "not_found");

    const bigDir = path.join(root, "big");
    await mkdir(bigDir);
    for (let i = 0; i < SITE_FILES_LIST_MAX; i += 1) {
      await writeFile(path.join(bigDir, `f${String(i).padStart(4, "0")}`), "");
    }
    const atLimit = expectOk(runPhp(script, root, { op: "list", path: "big" }), "list");
    expect(atLimit.entries).toHaveLength(SITE_FILES_LIST_MAX);
    expect(atLimit.truncated).toBe(false);

    await writeFile(path.join(bigDir, "f5000"), "");
    const overLimit = expectOk(runPhp(script, root, { op: "list", path: "big" }), "list");
    expect(overLimit.entries).toHaveLength(SITE_FILES_LIST_MAX);
    expect(overLimit.truncated).toBe(true);
  });

  it.skipIf(!hasPhp)(
    "list caps JSON stdout below 1 MiB and uses unescaped Unicode when 5000 names are 200 bytes or accented",
    async () => {
      const script = await writeProgramScript();
      const root = await makeTempDir();

      const asciiDir = path.join(root, "long-ascii");
      await mkdir(asciiDir);
      const asciiPad = "a".repeat(195);
      for (let i = 0; i < SITE_FILES_LIST_MAX; i += 1) {
        await writeFile(path.join(asciiDir, `${String(i).padStart(4, "0")}-${asciiPad}`), "");
      }
      const rawAscii = runPhpRaw(script, root, { op: "list", path: "long-ascii" });
      expect(Buffer.byteLength(rawAscii, "utf8")).toBeLessThan(1_048_576);
      const parsedAscii = expectOk(JSON.parse(rawAscii) as PhpProgramReply, "list");
      expect(parsedAscii.truncated).toBe(true);
      expect(parsedAscii.entries.length).toBeGreaterThan(0);
      expect(parsedAscii.entries.length).toBeLessThan(SITE_FILES_LIST_MAX);

      const utf8Dir = path.join(root, "long-accented");
      await mkdir(utf8Dir);
      const utf8Pad = "é".repeat(97); // 194 UTF-8 bytes + 5 suffix bytes = 199 bytes (< 255 byte limit)
      for (let i = 0; i < SITE_FILES_LIST_MAX; i += 1) {
        await writeFile(path.join(utf8Dir, `${String(i).padStart(4, "0")}-${utf8Pad}`), "");
      }
      const rawUtf8 = runPhpRaw(script, root, { op: "list", path: "long-accented" });
      expect(Buffer.byteLength(rawUtf8, "utf8")).toBeLessThan(1_048_576);
      expect(rawUtf8).toContain("é");
      expect(rawUtf8).not.toContain("\\u00e9");
      const parsedUtf8 = expectOk(JSON.parse(rawUtf8) as PhpProgramReply, "list");
      expect(parsedUtf8.truncated).toBe(true);
      expect(parsedUtf8.entries.length).toBeGreaterThan(0);
      expect(parsedUtf8.entries.length).toBeLessThan(SITE_FILES_LIST_MAX);
    },
    30_000,
  );

  it.skipIf(!hasPhp)("clamps out-of-range mtime values to year 0000..9999 in list and stat", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    const futureFile = path.join(root, "future.txt");
    const pastFile = path.join(root, "past.txt");
    await writeFile(futureFile, "f");
    await writeFile(pastFile, "p");

    await utimes(futureFile, 253402300800, 253402300800);
    await utimes(pastFile, -62167219201, -62167219201);

    const futureStat = expectOk(runPhp(script, root, { op: "stat", path: "future.txt" }), "stat");
    expect(futureStat.entry.modifiedAt).toBe("9999-12-31T23:59:59Z");

    const pastStat = expectOk(runPhp(script, root, { op: "stat", path: "past.txt" }), "stat");
    expect(pastStat.entry.modifiedAt).toBe("0000-01-01T00:00:00Z");

    const listed = expectOk(runPhp(script, root, { op: "list", path: "" }), "list");
    expect(listed.entries.find((e) => e.name === "future.txt")?.modifiedAt).toBe(
      "9999-12-31T23:59:59Z",
    );
    expect(listed.entries.find((e) => e.name === "past.txt")?.modifiedAt).toBe(
      "0000-01-01T00:00:00Z",
    );
  });

  it.skipIf(!hasPhp)("stat handles root and entries without following symlinks", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await writeFile(path.join(root, "index.php"), "<?php echo 1;");
    await symlink("/etc/passwd", path.join(root, "ext-link"));

    const rootStat = expectOk(runPhp(script, root, { op: "stat", path: "" }), "stat");
    expect(rootStat.entry.name).toBe("");
    expect(rootStat.entry.kind).toBe("dir");
    expect(rootStat.entry.size).toBe(0);

    const linkStat = expectOk(runPhp(script, root, { op: "stat", path: "ext-link" }), "stat");
    expect(linkStat.entry.name).toBe("ext-link");
    expect(linkStat.entry.kind).toBe("link");

    expectRefusal(runPhp(script, root, { op: "stat", path: "missing" }), "not_found");
  });

  it.skipIf(!hasPhp)("enforces symlink confinement on read, list, write and mkdir while allowing inside links", async () => {
    const script = await writeProgramScript();
    const outer = await makeTempDir("hp-site-files-outer-");
    const root = path.join(outer, "sub", "root");
    await mkdir(root, { recursive: true });
    await mkdir(path.join(root, "wp-content", "uploads"), { recursive: true });
    await writeFile(path.join(root, "index.php"), "hello-wp");
    await writeFile(path.join(outer, "x"), "secret-outer");
    await symlink("index.php", path.join(root, "in-link"));
    await symlink("/etc", path.join(root, "out-abs"));
    await symlink("../../x", path.join(root, "out-rel"));
    await symlink("../../dangling-outside", path.join(root, "out-dangling"));
    await symlink("/etc", path.join(root, "wp-content", "uploads", "dirlink"));

    const insideRead = expectOk(
      runPhp(script, root, { op: "read", path: "in-link", offset: 0, length: 64 }),
      "read",
    );
    expect(Buffer.from(insideRead.dataBase64, "base64").toString("utf8")).toBe("hello-wp");
    expect(insideRead.eof).toBe(true);

    expectRefusal(runPhp(script, root, { op: "read", path: "out-abs/passwd", offset: 0, length: 64 }), "protected");
    expectRefusal(runPhp(script, root, { op: "list", path: "out-abs" }), "protected");
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "out-abs/pwn",
        uploadId: "upload_id_12345678",
        offset: 0,
        dataBase64: Buffer.from("x").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "protected",
    );
    expectRefusal(runPhp(script, root, { op: "mkdir", path: "out-abs/pwn" }), "protected");
    expectRefusal(runPhp(script, root, { op: "read", path: "out-rel", offset: 0, length: 64 }), "protected");
    expectRefusal(runPhp(script, root, { op: "read", path: "out-dangling", offset: 0, length: 64 }), "protected");
    expectRefusal(
      runPhp(script, root, { op: "list", path: "wp-content/uploads/dirlink" }),
      "protected",
    );
    expectRefusal(
      runPhp(script, root, { op: "read", path: "wp-content/uploads/dirlink/passwd", offset: 0, length: 64 }),
      "protected",
    );
    expectRefusal(
      runPhp(script, root, { op: "stat", path: "index.php/child" }),
      "not_a_directory",
    );
  });

  it.skipIf(!hasPhp)("reads chunks with offset/eof validation", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await writeFile(path.join(root, "data.bin"), "abcdefghij");
    await writeFile(path.join(root, "empty.bin"), "");
    await mkdir(path.join(root, "folder"));

    const c1 = expectOk(runPhp(script, root, { op: "read", path: "data.bin", offset: 0, length: 4 }), "read");
    expect(Buffer.from(c1.dataBase64, "base64").toString("utf8")).toBe("abcd");
    expect(c1.size).toBe(10);
    expect(c1.eof).toBe(false);

    const c2 = expectOk(runPhp(script, root, { op: "read", path: "data.bin", offset: 4, length: 10 }), "read");
    expect(Buffer.from(c2.dataBase64, "base64").toString("utf8")).toBe("efghij");
    expect(c2.eof).toBe(true);

    const empty = expectOk(runPhp(script, root, { op: "read", path: "empty.bin", offset: 0, length: 10 }), "read");
    expect(empty.dataBase64).toBe("");
    expect(empty.size).toBe(0);
    expect(empty.eof).toBe(true);

    expectRefusal(runPhp(script, root, { op: "read", path: "data.bin", offset: 11, length: 4 }), "upload_mismatch");
    expectRefusal(runPhp(script, root, { op: "read", path: "folder", offset: 0, length: 4 }), "is_a_directory");
    expectRefusal(runPhp(script, root, { op: "read", path: "missing", offset: 0, length: 4 }), "not_found");
  });

  it.skipIf(!hasPhp)("writes chunked uploads with replay, final empty chunk, overwrite mode preservation and offset guards", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    const uploadId = "upload_1234567890abcdef";

    const part1 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41);
    const part2 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x42);
    const part3 = Buffer.from("tail-bytes-end");
    const full = Buffer.concat([part1, part2, part3]);
    const expectedSha = createHash("sha256").update(full).digest("hex");

    // Offset > 0 without staging file is refused
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: 10,
        dataBase64: Buffer.from("x").toString("base64"),
        final: false,
        overwrite: false,
      }),
      "upload_mismatch",
    );

    const r1 = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: 0,
        dataBase64: part1.toString("base64"),
        final: false,
        overwrite: false,
      }),
      "write",
    );
    expect(r1.received).toBe(part1.length);

    // Staging file is hidden from list
    const midList = expectOk(runPhp(script, root, { op: "list", path: "" }), "list");
    expect(midList.entries).toEqual([]);

    // Offset beyond current staged size is refused
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: part1.length + 1,
        dataBase64: Buffer.from("x").toString("base64"),
        final: false,
        overwrite: false,
      }),
      "upload_mismatch",
    );

    const r2 = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: part1.length,
        dataBase64: part2.toString("base64"),
        final: false,
        overwrite: false,
      }),
      "write",
    );
    expect(r2.received).toBe(part1.length + part2.length);

    // Replay chunk 2 idempotently
    const r2Replay = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: part1.length,
        dataBase64: part2.toString("base64"),
        final: false,
        overwrite: false,
      }),
      "write",
    );
    expect(r2Replay.received).toBe(part1.length + part2.length);

    const r3 = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: part1.length + part2.length,
        dataBase64: part3.toString("base64"),
        final: false,
        overwrite: false,
      }),
      "write",
    );
    expect(r3.received).toBe(full.length);

    // Replaying an earlier chunk after chunk 3 keeps the larger staged size
    const r2LateReplay = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: part1.length,
        dataBase64: part2.toString("base64"),
        final: false,
        overwrite: false,
      }),
      "write",
    );
    expect(r2LateReplay.received).toBe(full.length);

    // Empty final chunk commits atomically (ruling R4)
    const rFinal = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId,
        offset: full.length,
        dataBase64: "",
        final: true,
        overwrite: false,
      }),
      "write",
    );
    expect(rFinal.received).toBe(full.length);

    const writtenBytes = await readFile(path.join(root, "big.bin"));
    expect(createHash("sha256").update(writtenBytes).digest("hex")).toBe(expectedSha);
    expect(await readdir(root)).toEqual(["big.bin"]);

    // Overwrite false refuses on chunk 0
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId: "upload_2234567890abcdef",
        offset: 0,
        dataBase64: Buffer.from("new").toString("base64"),
        final: false,
        overwrite: false,
      }),
      "exists",
    );

    // Overwrite true preserves existing mode
    await chmod(path.join(root, "big.bin"), 0o640);
    const ow = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "big.bin",
        uploadId: "upload_3234567890abcdef",
        offset: 0,
        dataBase64: Buffer.from("replaced").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "write",
    );
    expect(ow.received).toBe(8);
    expect(await readFile(path.join(root, "big.bin"), "utf8")).toBe("replaced");
    expect((await stat(path.join(root, "big.bin"))).mode & 0o777).toBe(0o640);

    // Target is a symlink -> ALREADY_EXISTS even with overwrite: true
    await symlink("big.bin", path.join(root, "link-target"));
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "link-target",
        uploadId: "upload_4234567890abcdef",
        offset: 0,
        dataBase64: Buffer.from("x").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "exists",
    );

    // Staging symlink is rejected at offset > 0 and unlinked at offset === 0
    await symlink("/etc/passwd", path.join(root, ".htpanel-upload-stage_link_123456.part"));
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "clean.txt",
        uploadId: "stage_link_123456",
        offset: 1,
        dataBase64: Buffer.from("x").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "upload_mismatch",
    );
    const cleanWrite = expectOk(
      runPhp(script, root, {
        op: "write",
        path: "clean.txt",
        uploadId: "stage_link_123456",
        offset: 0,
        dataBase64: Buffer.from("ok").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "write",
    );
    expect(cleanWrite.received).toBe(2);
    expect(await readFile(path.join(root, "clean.txt"), "utf8")).toBe("ok");

    // Exceeding 2 GiB is refused
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "huge.bin",
        uploadId: "upload_5234567890abcdef",
        offset: SITE_FILES_MAX_FILE_BYTES,
        dataBase64: Buffer.from("a").toString("base64"),
        final: true,
        overwrite: true,
      }),
      "too_large",
    );
  });

  it.skipIf(!hasPhp)("mkdir, move and delete handle protected paths, move into itself, link deletion and permissions", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await mkdir(path.join(root, "wp-content", "mu-plugins"), { recursive: true });
    await writeFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "<?php // mail");
    await symlink("wp-content", path.join(root, "wpc"));

    // Protected paths (direct + via alias symlink)
    for (const p of [
      "wp-content/mu-plugins/hp-mail.php",
      "wp-content/mu-plugins",
      "wp-content",
      "wpc/mu-plugins/hp-mail.php",
      "wpc/mu-plugins",
    ]) {
      expectRefusal(runPhp(script, root, { op: "mkdir", path: p }), "protected");
      expectRefusal(runPhp(script, root, { op: "move", from: p, to: "escaped" }), "protected");
      expectRefusal(runPhp(script, root, { op: "delete", paths: [p] }), "protected");
      expectRefusal(
        runPhp(script, root, {
          op: "write",
          path: p,
          uploadId: "upload_6234567890abcdef",
          offset: 0,
          dataBase64: Buffer.from("x").toString("base64"),
          final: true,
          overwrite: true,
        }),
        "protected",
      );
    }

    // Batch delete checks all paths before deleting anything
    await writeFile(path.join(root, "keep.txt"), "keep");
    expectRefusal(
      runPhp(script, root, { op: "delete", paths: ["keep.txt", "wpc/mu-plugins/hp-mail.php"] }),
      "protected",
    );
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep");

    // mkdir and move into itself (direct and via alias)
    expectOk(runPhp(script, root, { op: "mkdir", path: "dir" }), "mkdir");
    await symlink("dir", path.join(root, "dir-alias"));
    expectRefusal(runPhp(script, root, { op: "mkdir", path: "dir" }), "exists");
    expectRefusal(runPhp(script, root, { op: "mkdir", path: "missing/sub" }), "not_found");
    expectRefusal(runPhp(script, root, { op: "move", from: "dir", to: "dir/sub" }), "invalid_path");
    expectRefusal(runPhp(script, root, { op: "move", from: "dir", to: "dir-alias/sub" }), "invalid_path");

    // Deleting a symlink to a directory leaves the target intact
    await mkdir(path.join(root, "real-uploads"));
    await writeFile(path.join(root, "real-uploads", "photo.jpg"), "jpg");
    await symlink("real-uploads", path.join(root, "updir"));
    expectOk(runPhp(script, root, { op: "delete", paths: ["updir"] }), "delete");
    expect(await readFile(path.join(root, "real-uploads", "photo.jpg"), "utf8")).toBe("jpg");

    // Recursive delete
    await mkdir(path.join(root, "dir", "nested"), { recursive: true });
    await writeFile(path.join(root, "dir", "nested", "a.txt"), "a");
    await writeFile(path.join(root, "dir", "nested", ".htpanel-leftover.part"), "part");
    expectOk(runPhp(script, root, { op: "delete", paths: ["dir"] }), "delete");
    await expect(lstat(path.join(root, "dir"))).rejects.toThrow();
  });

  it.skipIf(!hasPhp || isRoot)("maps OS permission denials on 0555 directories to PERMISSION_DENIED/protected", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    const roDir = path.join(root, "locked");
    await mkdir(roDir);
    await writeFile(path.join(roDir, "existing.txt"), "ro");
    await chmod(roDir, 0o555);
    cleanup.push(async () => {
      await chmod(roDir, 0o755).catch(() => undefined);
    });

    expectRefusal(runPhp(script, root, { op: "mkdir", path: "locked/sub" }), "protected");
    expectRefusal(
      runPhp(script, root, {
        op: "write",
        path: "locked/new.txt",
        uploadId: "upload_7234567890abcdef",
        offset: 0,
        dataBase64: Buffer.from("x").toString("base64"),
        final: true,
        overwrite: false,
      }),
      "protected",
    );
    expectRefusal(runPhp(script, root, { op: "delete", paths: ["locked/existing.txt"] }), "protected");
  });

  it.skipIf(!hasZip || isRoot)("refuses archive and extract into 0555 directories with PERMISSION_DENIED/protected", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    const roDir = path.join(root, "locked");
    await mkdir(roDir);
    await writeFile(path.join(root, "seed.txt"), "seed");
    await writeFile(
      path.join(root, "in.zip"),
      buildTestZip([{ name: "sub/a.txt", data: Buffer.from("a") }]),
    );
    await writeFile(
      path.join(root, "locked-in.zip"),
      buildTestZip([{ name: "locked/inside.txt", data: Buffer.from("x") }]),
    );
    await chmod(roDir, 0o555);
    cleanup.push(async () => {
      await chmod(roDir, 0o755).catch(() => undefined);
    });

    expectRefusal(
      runPhp(script, root, { op: "archive", paths: ["seed.txt"], to: "locked/out.zip" }),
      "protected",
    );
    expectRefusal(runPhp(script, root, { op: "extract", path: "in.zip", to: "locked" }), "protected");
    expectRefusal(
      runPhp(script, root, { op: "extract", path: "in.zip", to: "locked/sub" }),
      "protected",
    );
    expectRefusal(runPhp(script, root, { op: "extract", path: "locked-in.zip", to: "" }), "protected");
  });

  it.skipIf(!hasPhp)("sweep deletes only .htpanel-* regular files older than 24 h without following links", async () => {
    const script = await writeProgramScript();
    const outer = await makeTempDir("hp-sweep-outer-");
    const root = path.join(outer, "root");
    await mkdir(path.join(root, "nested"), { recursive: true });

    const oldDate = new Date(Date.now() - 25 * 3600 * 1000);
    const freshDate = new Date(Date.now() - 2 * 3600 * 1000);

    const staleTop = path.join(root, ".htpanel-upload-stale1.part");
    const staleNested = path.join(root, "nested", ".htpanel-archive-stale2.part");
    const freshStage = path.join(root, ".htpanel-upload-fresh.part");
    const oldNormal = path.join(root, "normal-old.txt");
    const extStale = path.join(outer, ".htpanel-upload-outside.part");

    await writeFile(staleTop, "1");
    await writeFile(staleNested, "2");
    await writeFile(freshStage, "3");
    await writeFile(oldNormal, "4");
    await writeFile(extStale, "5");

    await utimes(staleTop, oldDate, oldDate);
    await utimes(staleNested, oldDate, oldDate);
    await utimes(freshStage, freshDate, freshDate);
    await utimes(oldNormal, oldDate, oldDate);
    await utimes(extStale, oldDate, oldDate);
    await symlink(outer, path.join(root, "out-dir-link"));

    const res = runPhp(script, root, { op: "sweep" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({ removed: 2 });
    }

    await expect(lstat(staleTop)).rejects.toThrow();
    await expect(lstat(staleNested)).rejects.toThrow();
    expect(await readFile(freshStage, "utf8")).toBe("3");
    expect(await readFile(oldNormal, "utf8")).toBe("4");
    expect(await readFile(extStale, "utf8")).toBe("5");
  });
});

describe("site files program zip operations (real php + ZipArchive)", () => {
  it.skipIf(!hasZip)("archive skips symlinks and .htpanel-* and round-trips cleanly through extract", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await mkdir(path.join(root, "wp-content", "uploads"), { recursive: true });
    await mkdir(path.join(root, "wp-content", "empty-dir"), { recursive: true });
    await writeFile(path.join(root, "wp-content", "uploads", "a.txt"), "hello-zip");
    await writeFile(path.join(root, "wp-content", ".htpanel-stage.part"), "ignore-me");
    await symlink("/etc", path.join(root, "wp-content", "uploads", "dirlink"));

    const archived = expectOk(
      runPhp(script, root, { op: "archive", paths: ["wp-content"], to: "site.zip" }),
      "archive",
    );
    // wp-content, wp-content/empty-dir, wp-content/uploads, wp-content/uploads/a.txt
    expect(archived.entries).toBe(4);

    const extracted = expectOk(
      runPhp(script, root, { op: "extract", path: "site.zip", to: "restored" }),
      "extract",
    );
    expect(extracted.entries).toBe(4);
    expect(await readFile(path.join(root, "restored", "wp-content", "uploads", "a.txt"), "utf8")).toBe(
      "hello-zip",
    );
    expect((await lstat(path.join(root, "restored", "wp-content", "empty-dir"))).isDirectory()).toBe(true);
    await expect(lstat(path.join(root, "restored", "wp-content", "uploads", "dirlink"))).rejects.toThrow();
    await expect(lstat(path.join(root, "restored", "wp-content", ".htpanel-stage.part"))).rejects.toThrow();

    // Archive refuses sources in different folders and existing targets
    await writeFile(path.join(root, "top.txt"), "top");
    expectRefusal(
      runPhp(script, root, { op: "archive", paths: ["top.txt", "wp-content/uploads/a.txt"], to: "bad.zip" }),
      "invalid_path",
    );
    expectRefusal(
      runPhp(script, root, { op: "archive", paths: ["top.txt"], to: "site.zip" }),
      "exists",
    );

    // Archiving only a symlink produces a valid empty zip that extracts cleanly into root ("")
    const emptyArc = expectOk(
      runPhp(script, root, { op: "archive", paths: ["wp-content/uploads/dirlink"], to: "empty.zip" }),
      "archive",
    );
    expect(emptyArc.entries).toBe(0);
    const emptyExt = expectOk(
      runPhp(script, root, { op: "extract", path: "empty.zip", to: "" }),
      "extract",
    );
    expect(emptyExt.entries).toBe(0);

    // Extract merges into an existing folder
    await mkdir(path.join(root, "merged"));
    await writeFile(path.join(root, "merged", "keep.txt"), "kept");
    const mergedExt = expectOk(
      runPhp(script, root, { op: "extract", path: "site.zip", to: "merged" }),
      "extract",
    );
    expect(mergedExt.entries).toBe(4);
    expect(await readFile(path.join(root, "merged", "keep.txt"), "utf8")).toBe("kept");
    expect(await readFile(path.join(root, "merged", "wp-content", "uploads", "a.txt"), "utf8")).toBe(
      "hello-zip",
    );
  });

  it.skipIf(!hasZip)("extract refuses unsafe names, symlinks, specials, limits, existing targets and garbage with nothing left behind", async () => {
    const script = await writeProgramScript();
    const root = await makeTempDir();
    await mkdir(path.join(root, "wp-content", "mu-plugins"), { recursive: true });
    await writeFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "protected");
    await writeFile(path.join(root, "existing.txt"), "keep-me");

    const unsafeArchives: Array<[string, Buffer, SiteFileErrorReason]> = [
      ["dotdot.zip", buildTestZip([{ name: "ok.txt", data: Buffer.from("ok") }, { name: "../evil", data: Buffer.from("x") }]), "archive_unsafe"],
      ["abs.zip", buildTestZip([{ name: "/abs", data: Buffer.from("x") }]), "archive_unsafe"],
      ["drive.zip", buildTestZip([{ name: "C:x", data: Buffer.from("x") }]), "archive_unsafe"],
      ["backslash.zip", buildTestZip([{ name: "a\\b", data: Buffer.from("x") }]), "archive_unsafe"],
      ["dup.zip", buildTestZip([{ name: "dup.txt", data: Buffer.from("1") }, { name: "dup.txt", data: Buffer.from("2") }]), "archive_unsafe"],
      ["reserved.zip", buildTestZip([{ name: ".htpanel-evil", data: Buffer.from("x") }]), "archive_unsafe"],
      ["symlink.zip", buildTestZip([{ name: "s", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 }]), "archive_unsafe"],
      ["fifo.zip", buildTestZip([{ name: "p", data: Buffer.alloc(0), unixMode: 0o010644 }]), "archive_unsafe"],
      [
        "deep.zip",
        buildTestZip([{ name: `${Array.from({ length: 33 }, (_, i) => `d${i}`).join("/")}`, data: Buffer.from("x") }]),
        "archive_limit",
      ],
      [
        "many.zip",
        buildTestZip(Array.from({ length: 20_001 }, (_, i) => ({ name: `f${i}.txt` }))),
        "archive_limit",
      ],
      [
        "bomb.zip",
        buildTestZip([{ name: "bomb.bin", data: Buffer.alloc(20 * 1024 * 1024), deflate: true }]),
        "archive_limit",
      ],
      [
        "spoof.zip",
        buildTestZip([
          { name: "ok/first.txt", data: Buffer.from("first") },
          { name: "ok/overrun.bin", data: Buffer.alloc(256 * 1024), deflate: true, spoofDeclaredSize: 10 },
        ]),
        "archive_limit",
      ],
      ["garbage.zip", Buffer.from("not-a-zip-at-all"), "not_a_zip"],
      [
        "conflict.zip",
        buildTestZip([
          { name: "brand-new.txt", data: Buffer.from("x") },
          { name: "existing.txt", data: Buffer.from("overwrite") },
        ]),
        "exists",
      ],
      [
        "prot.zip",
        buildTestZip([{ name: "wp-content/mu-plugins/hp-mail.php", data: Buffer.from("pwn") }]),
        "protected",
      ],
    ];

    for (const [zipName, zipBytes] of unsafeArchives) {
      await writeFile(path.join(root, zipName), zipBytes);
    }

    const baseline = await listTreeSnapshot(root);

    for (const [zipName, , expectedReason] of unsafeArchives) {
      const to = zipName === "conflict.zip" || zipName === "prot.zip" ? "" : "out";
      expectRefusal(runPhp(script, root, { op: "extract", path: zipName, to }), expectedReason);
      expect(await listTreeSnapshot(root)).toEqual(baseline);
    }
  });
});
