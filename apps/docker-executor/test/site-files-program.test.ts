import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
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
    // Prefer /dev/shm (tmpfs on Linux) so out-of-range timestamps survive kernel storage without ext4 clamping.
    let root: string | null = null;
    if (process.platform === "linux") {
      try {
        root = await mkdtemp(path.join("/dev/shm", "hp-site-files-prog-"));
        cleanup.push(() => rm(root!, { recursive: true, force: true }));
      } catch {
        root = null;
      }
    }
    if (root === null) {
      root = await makeTempDir();
    }

    const futureFile = path.join(root, "future.txt");
    const pastFile = path.join(root, "past.txt");
    await writeFile(futureFile, "f");
    await writeFile(pastFile, "p");

    // Use PHP touch() because Node fs.utimes() silently drops negative timestamps on Linux.
    const setRes = spawnSync(
      "php",
      [
        "-r",
        "touch($argv[1], (int)$argv[2]); touch($argv[3], (int)$argv[4]); clearstatcache(); echo json_encode([stat($argv[1])['mtime'], stat($argv[3])['mtime']]);",
        futureFile,
        "253402300800",
        pastFile,
        "-62167219201",
      ],
      { encoding: "utf8" },
    );
    expect(setRes.status).toBe(0);
    const [storedFuture, storedPast] = JSON.parse(setRes.stdout) as [number, number];
    expect(storedFuture).toBeGreaterThanOrEqual(2_147_483_647);
    expect(storedPast).toBeLessThan(0);

    const clampIso = (sec: number): string => {
      const clamped = Math.max(-62_167_219_200, Math.min(253_402_300_799, sec));
      return new Date(clamped * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    };
    const expectedFuture = clampIso(storedFuture);
    const expectedPast = clampIso(storedPast);
    if (storedFuture > 253_402_300_799) {
      expect(expectedFuture).toBe("9999-12-31T23:59:59Z");
    }
    if (storedPast < -62_167_219_200) {
      expect(expectedPast).toBe("0000-01-01T00:00:00Z");
    }

    const futureStat = expectOk(runPhp(script, root, { op: "stat", path: "future.txt" }), "stat");
    expect(futureStat.entry.modifiedAt).toBe(expectedFuture);

    const pastStat = expectOk(runPhp(script, root, { op: "stat", path: "past.txt" }), "stat");
    expect(pastStat.entry.modifiedAt).toBe(expectedPast);

    const listed = expectOk(runPhp(script, root, { op: "list", path: "" }), "list");
    expect(listed.entries.find((e) => e.name === "future.txt")?.modifiedAt).toBe(expectedFuture);
    expect(listed.entries.find((e) => e.name === "past.txt")?.modifiedAt).toBe(expectedPast);
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

// The WordPress import (M4b): the eight import.* operations on the real PHP program.
const STAGING_HTACCESS =
  '# hosting-panel import staging: never served\nRequire all denied\n<Files "*">\nRequire all denied\n</Files>\n<If "true">\nRequire all denied\n</If>\n';
const GATE_HTACCESS =
  '\n# BEGIN hosting-panel import gate\n<If "true">\nRequire all denied\n</If>\n# END hosting-panel import gate\n';
const GATE_CONFIG =
  '<?php if (PHP_SAPI !== "cli") { header("Retry-After: 60", true, 503); exit; } /* hosting-panel import gate */ ?>\n';
const LIVE_CONFIG = "<?php\n// panel config sentinel\ndefine('HP_MANAGED', true);\n$table_prefix = 'wp_';\n";
const LIVE_HTACCESS = "# BEGIN panel\nRewriteEngine On\n# END panel\n";
const DROP_INS = [
  "advanced-cache.php",
  "object-cache.php",
  "db.php",
  "db-error.php",
  "install.php",
  "maintenance.php",
  "php-error.php",
  "fatal-error-handler.php",
  "sunrise.php",
  "blog-deleted.php",
  "blog-inactive.php",
  "blog-suspended.php",
];
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function wpEntries(prefix: string, marker = "new"): TestZipEntry[] {
  return [
    { name: `${prefix}index.php`, data: Buffer.from(`<?php // ${marker} index`) },
    { name: `${prefix}wp-load.php`, data: Buffer.from(`<?php // ${marker} load`) },
    { name: `${prefix}wp-includes/version.php`, data: Buffer.from(`<?php $wp_version = '6.9';`) },
    { name: `${prefix}wp-content/`, data: Buffer.alloc(0) },
    { name: `${prefix}wp-content/themes/t/style.css`, data: Buffer.from(`/* ${marker} */`) },
    { name: `${prefix}wp-content/uploads/a.txt`, data: Buffer.from(marker) },
  ];
}

/** A live panel site: the gate files, core, content, a drop-in, the mail plug-in, a .maintenance. */
async function makeLiveSite(): Promise<{ root: string; outer: string }> {
  const outer = await makeTempDir("hp-import-");
  const root = path.join(outer, "root");
  await mkdir(path.join(root, "wp-includes"), { recursive: true });
  await mkdir(path.join(root, "wp-content", "mu-plugins"), { recursive: true });
  await mkdir(path.join(root, "wp-content", "themes", "old"), { recursive: true });
  await writeFile(path.join(root, "wp-config.php"), LIVE_CONFIG);
  await writeFile(path.join(root, ".htaccess"), LIVE_HTACCESS);
  await writeFile(path.join(root, ".maintenance"), "<?php $upgrading = 0;");
  await writeFile(path.join(root, "index.php"), "<?php // old index");
  await writeFile(path.join(root, "wp-load.php"), "<?php // old load");
  await writeFile(path.join(root, "old-only.txt"), "old");
  await writeFile(path.join(root, "wp-includes", "version.php"), "<?php $wp_version = '6.1';");
  await writeFile(path.join(root, "wp-content", "object-cache.php"), "<?php // old drop-in");
  await writeFile(path.join(root, "wp-content", "themes", "old", "style.css"), "/* old */");
  await writeFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "// hp-mail stand-in");
  return { root, outer };
}

async function stageArchive(root: string, zip: Buffer): Promise<void> {
  await mkdir(path.join(root, ".htpanel-import"), { recursive: true });
  await writeFile(path.join(root, ".htpanel-import", "archive"), zip);
}

async function siteSnapshot(root: string): Promise<string[]> {
  return (await listTreeSnapshot(root)).filter((e) => !/^[A-Z]:\.htpanel-import(?:[/:]|$)/.test(e));
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

async function readPlan(root: string, id: string): Promise<Array<[string, string]>> {
  const text = await readFile(path.join(root, ".htpanel-import", id, "plan"), "utf8");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as [string, string]);
}

/** Unpacks a WordPress archive with a nested .htaccess and switches it in. */
async function switchedSite(script: string): Promise<{ root: string; outer: string; plan: Array<[string, string]> }> {
  const site = await makeLiveSite();
  await stageArchive(
    site.root,
    buildTestZip([
      ...wpEntries("src/"),
      { name: "src/wp-content/uploads/.htaccess", data: Buffer.from("Require all granted\n") },
      { name: "src/wp-content/themes/t/.htaccess", data: Buffer.from("Require all granted\n") },
    ]),
  );
  expectOk(runPhp(script, site.root, { op: "import.unpack", importId: ID_A }), "import.unpack");
  const switched = expectOk(runPhp(script, site.root, { op: "import.switch", importId: ID_A }), "import.switch");
  const plan = await readPlan(site.root, ID_A);
  expect(switched.moved).toBe(plan.length);
  return { ...site, plan };
}

describe("site files program WordPress import (real php + ZipArchive)", () => {
  it.skipIf(!hasZip)("import.put checks the first bytes, a new uploadId at 0 replaces the slot, stat says partial then complete", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const staging = path.join(root, ".htpanel-import");
    const put = (slot: string, uploadId: string, offset: number, data: Buffer, final: boolean) =>
      runPhp(script, root, { op: "import.put", slot, uploadId, offset, dataBase64: data.toString("base64"), final });
    const upA = "uploadAAAAAAAAAAAAAA";
    const upB = "uploadBBBBBBBBBBBBBB";
    const zip = buildTestZip(wpEntries(""));

    expectRefusal(put("archive", upA, 0, Buffer.from("%PDF-1.7 not a zip"), true), "not_a_zip");
    expectRefusal(put("dump", upA, 0, Buffer.from("CREATE TABLE x (\u0000);"), true), "dump_not_sql");
    expect(await readFile(path.join(staging, ".htaccess"), "utf8")).toBe(STAGING_HTACCESS);
    let state = expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(state).toEqual({
      archive: { state: "empty", size: 0, uploadId: null },
      dump: { state: "empty", size: 0, uploadId: null },
      remains: false,
    });

    const gz = zlib.gzipSync(Buffer.from("INSERT INTO t VALUES (1);\n"));
    expect(expectOk(put("dump", upA, 0, gz, true), "import.put").received).toBe(gz.length);
    expectOk(put("archive", upA, 0, zip.subarray(0, 10), false), "import.put");
    expectRefusal(put("archive", upB, 10, zip.subarray(10), true), "upload_mismatch");
    state = expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(state.archive).toEqual({ state: "partial", size: 10, uploadId: upA });
    expect(state.dump).toEqual({ state: "complete", size: gz.length, uploadId: null });

    expectOk(put("archive", upB, 0, zip, true), "import.put");
    state = expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(state.archive).toEqual({ state: "complete", size: zip.length, uploadId: null });
    expect(await readFile(path.join(staging, "archive"))).toEqual(zip);
    expect((await readdir(staging)).sort()).toEqual([".htaccess", "archive", "dump"]);

    // A refused first chunk of a new upload leaves the slot empty (A1 order).
    expectRefusal(put("dump", upB, 0, Buffer.from("x\u0000y"), false), "dump_not_sql");
    state = expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(state.dump).toEqual({ state: "empty", size: 0, uploadId: null });
    expect(state.archive.state).toBe("complete");
  });

  it.skipIf(!hasZip)("import.take moves a picked file, leaves a refused one, and refuses links, folders and protected paths", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const zip = buildTestZip(wpEntries(""));
    await mkdir(path.join(root, "up"));
    await writeFile(path.join(root, "up", "site.zip"), zip);
    await writeFile(path.join(root, "bad.sql"), Buffer.from("x\u0000y"));
    await writeFile(path.join(root, "notzip.txt"), "hello");
    await symlink("up/site.zip", path.join(root, "link.zip"));

    expect(expectOk(runPhp(script, root, { op: "import.take", slot: "archive", path: "up/site.zip" }), "import.take").size).toBe(zip.length);
    expect(await exists(path.join(root, "up", "site.zip"))).toBe(false);
    expect(await readFile(path.join(root, ".htpanel-import", "archive"))).toEqual(zip);

    expectRefusal(runPhp(script, root, { op: "import.take", slot: "dump", path: "bad.sql" }), "dump_not_sql");
    expect(await exists(path.join(root, "bad.sql"))).toBe(true);
    expectRefusal(runPhp(script, root, { op: "import.take", slot: "archive", path: "notzip.txt" }), "not_a_zip");
    expect(await readFile(path.join(root, "notzip.txt"), "utf8")).toBe("hello");
    expectRefusal(runPhp(script, root, { op: "import.take", slot: "archive", path: "link.zip" }), "is_a_directory");
    expectRefusal(runPhp(script, root, { op: "import.take", slot: "archive", path: "up" }), "is_a_directory");
    expectRefusal(
      runPhp(script, root, { op: "import.take", slot: "dump", path: "wp-content/mu-plugins/hp-mail.php" }),
      "protected",
    );
    expectRefusal(runPhp(script, root, { op: "import.take", slot: "dump", path: "wp-config.php" }), "protected");
    expectRefusal(runPhp(script, root, { op: "import.take", slot: "dump", path: ".htpanel-import/archive" }), "invalid_path");
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(LIVE_CONFIG);
    const state = expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(state.archive.state).toBe("complete");
    expect(state.dump.state).toBe("empty");
  });

  it.skipIf(!hasZip)("the staging folder is rewritten before every operation, a linked one is unlinked, and .htpanel entries are refused", async () => {
    const script = await writeProgramScript();
    const { root, outer } = await makeLiveSite();
    const staging = path.join(root, ".htpanel-import");
    await mkdir(staging);
    await writeFile(path.join(staging, ".htaccess"), "Require all granted\n");
    expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(await readFile(path.join(staging, ".htaccess"), "utf8")).toBe(STAGING_HTACCESS);
    await rm(path.join(staging, ".htaccess"));
    expectRefusal(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "files_missing");
    expect(await readFile(path.join(staging, ".htaccess"), "utf8")).toBe(STAGING_HTACCESS);

    await rm(staging, { recursive: true });
    const elsewhere = path.join(outer, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "keep.txt"), "keep");
    await symlink(elsewhere, staging);
    expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat");
    expect(await exists(staging)).toBe(false);
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
    await symlink(elsewhere, staging);
    expectOk(runPhp(script, root, { op: "import.discard" }), "import.discard");
    expect(await exists(staging)).toBe(false);
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);

    await stageArchive(root, buildTestZip([...wpEntries("src/"), { name: "src/.htpanel-x", data: Buffer.from("x") }]));
    expectRefusal(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "archive_unsafe");
  });

  it.skipIf(!hasZip)("import.unpack finds the root in the only folder, ignores macOS additions, leaves out the closed list and renames every .htaccess", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const leftOutEntries: TestZipEntry[] = [
      { name: "src/wp-config.php", data: Buffer.from("<?php touch('MARK_CFG');") },
      { name: "src/.htaccess", data: Buffer.from("Require all granted\n") },
      { name: "src/.maintenance", data: Buffer.from("<?php") },
      { name: "src/wp-content/mu-plugins/mark.php", data: Buffer.from("<?php touch('MARK_MU');") },
      ...DROP_INS.map((d) => ({ name: `src/wp-content/${d}`, data: Buffer.from("<?php") })),
    ];
    await stageArchive(
      root,
      buildTestZip([
        ...wpEntries("src/"),
        ...leftOutEntries,
        { name: "src/wp-content/uploads/.htaccess", data: Buffer.from("Require all granted\n") },
        { name: "src/wp-content/mu-plugins/.htaccess", data: Buffer.from("x") },
        { name: "__MACOSX/src/._index.php", data: Buffer.from("x") },
        { name: "__MACOSX/src/.htaccess", data: Buffer.from("x") },
        { name: ".DS_Store", data: Buffer.from("x") },
      ]),
    );
    const res = expectOk(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "import.unpack");
    expect(res.leftOut).toEqual([
      "wp-config.php",
      ".htaccess",
      ".maintenance",
      "wp-content/mu-plugins",
      ...DROP_INS.map((d) => `wp-content/${d}`),
    ]);
    const work = path.join(root, ".htpanel-import", ID_A);
    const site = path.join(work, "site");
    expect((await readdir(work)).sort()).toEqual(["htaccess.list", "site", "wp-config.php"]);
    expect(await readFile(path.join(work, "wp-config.php"), "utf8")).toContain("503");
    expect(await readFile(path.join(site, ".htaccess.imported"), "utf8")).toBe("Require all granted\n");
    expect(await readFile(path.join(site, "wp-content", "uploads", ".htaccess.hpimport"), "utf8")).toBe("Require all granted\n");
    expect(await readFile(path.join(work, "htaccess.list"), "utf8")).toBe("wp-content/uploads/.htaccess\n");
    const tree = await listTreeSnapshot(site);
    expect(tree.map((e) => e.split(":")[1]).sort()).toEqual(
      [
        ".htaccess.imported",
        "index.php",
        "wp-content",
        "wp-content/themes",
        "wp-content/themes/t",
        "wp-content/themes/t/style.css",
        "wp-content/uploads",
        "wp-content/uploads/.htaccess.hpimport",
        "wp-content/uploads/a.txt",
        "wp-includes",
        "wp-includes/version.php",
        "wp-load.php",
      ].sort(),
    );
    for (const e of tree) {
      const rel = e.split(":")[1] ?? "";
      expect((await stat(path.join(site, rel))).mode & 0o777).toBe(e.startsWith("D:") ? 0o755 : 0o644);
    }
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(LIVE_CONFIG);

    await stageArchive(root, buildTestZip(wpEntries("")));
    const top = expectOk(runPhp(script, root, { op: "import.unpack", importId: ID_B }), "import.unpack");
    expect(top.leftOut).toEqual([]);
    expect(await readFile(path.join(root, ".htpanel-import", ID_B, "site", "index.php"), "utf8")).toBe("<?php // new index");
    expect(await exists(path.join(work, "site"))).toBe(true);
  });

  it.skipIf(!hasZip)("import.unpack refuses what is not one WordPress or is unsafe, and replaces only its own stale folder", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const work = path.join(root, ".htpanel-import", ID_A);
    const cases: Array<[TestZipEntry[], SiteFileErrorReason]> = [
      [[...wpEntries("a/"), ...wpEntries("b/")], "archive_not_wordpress"],
      [[...wpEntries("a/"), { name: "readme.txt", data: Buffer.from("x") }], "archive_not_wordpress"],
      [wpEntries("").filter((e) => !e.name.endsWith("version.php")), "archive_not_wordpress"],
      [[...wpEntries(""), { name: "wp-content/.htaccess.hpimport", data: Buffer.from("x") }], "archive_unsafe"],
      [[...wpEntries(""), { name: "wp-content/.htaccess/", data: Buffer.alloc(0) }], "archive_unsafe"],
      [[...wpEntries(""), { name: "../evil.php", data: Buffer.from("x") }], "archive_unsafe"],
      [[...wpEntries(""), { name: "/abs.php", data: Buffer.from("x") }], "archive_unsafe"],
      [[...wpEntries(""), { name: "link", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 }], "archive_unsafe"],
    ];
    for (const [entries, reason] of cases) {
      await stageArchive(root, buildTestZip(entries));
      expectRefusal(runPhp(script, root, { op: "import.unpack", importId: ID_A }), reason);
      expect(await exists(path.join(work, "site"))).toBe(false);
    }
    expect(await exists(path.join(root, "evil.php"))).toBe(false);

    await stageArchive(root, buildTestZip(wpEntries("")));
    await mkdir(path.join(work, "site"), { recursive: true });
    await writeFile(path.join(work, "site", "stale.txt"), "stale");
    await mkdir(path.join(root, ".htpanel-import", ID_B));
    await writeFile(path.join(root, ".htpanel-import", ID_B, "other.txt"), "other");
    expectOk(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "import.unpack");
    expect(await exists(path.join(work, "site", "stale.txt"))).toBe(false);
    expect(await readFile(path.join(root, ".htpanel-import", ID_B, "other.txt"), "utf8")).toBe("other");

    await writeFile(path.join(work, "plan"), "");
    expectRefusal(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "staging_unsafe");
    expect(await exists(path.join(work, "site", "index.php"))).toBe(true);
  });

  it.skipIf(!hasZip)("the import ceilings apply only to the import: 20,001 entries pass import.unpack and still fail the plain extract", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const filler = Array.from({ length: 20_001 - wpEntries("").length }, (_, i) => ({ name: `wp-content/uploads/f${i}` }));
    const zip = buildTestZip([...wpEntries(""), ...filler]);
    await writeFile(path.join(root, "big.zip"), zip);
    expectRefusal(runPhp(script, root, { op: "extract", path: "big.zip", to: "out" }), "archive_limit");
    expect(await exists(path.join(root, "out"))).toBe(false);
    await stageArchive(root, zip);
    expect(expectOk(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "import.unpack").entries).toBe(20_001);
  });

  it.skipIf(!hasZip)("import.switch writes the plan without a skipped entry, gates wp-config.php and .htaccess, and swaps the tree", async () => {
    const script = await writeProgramScript();
    const { root, plan } = await switchedSite(script);
    const skipped = [".htpanel-import", ".htaccess", "wp-config.php", "wp-content", ".maintenance", "wp-content/mu-plugins"];
    for (const [kind, rel] of plan) {
      expect(["O", "I"]).toContain(kind);
      expect(skipped).not.toContain(rel);
    }
    expect(plan.filter(([k]) => k === "O").map(([, r]) => r).sort()).toEqual(
      ["index.php", "old-only.txt", "wp-content/object-cache.php", "wp-content/themes", "wp-includes", "wp-load.php"].sort(),
    );
    const config = await readFile(path.join(root, "wp-config.php"), "utf8");
    expect(config).toBe(GATE_CONFIG + LIVE_CONFIG);
    expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
    expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // new index");
    expect(await exists(path.join(root, "old-only.txt"))).toBe(false);
    expect(await exists(path.join(root, "wp-content", "object-cache.php"))).toBe(false);
    expect(await readFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "utf8")).toBe("// hp-mail stand-in");
    expect(await exists(path.join(root, ".maintenance"))).toBe(true);
    const work = path.join(root, ".htpanel-import", ID_A);
    expect(await readFile(path.join(work, "wp-config.live"), "utf8")).toBe(LIVE_CONFIG);
    expect(await readFile(path.join(work, "htaccess.live"), "utf8")).toBe(LIVE_HTACCESS);
    expect(await readFile(path.join(work, "aside", "old-only.txt"), "utf8")).toBe("old");
    expectRefusal(runPhp(script, root, { op: "import.switch", importId: ID_A }), "staging_unsafe");
  });

  it.skipIf(!hasZip)("a switch cut after k moves, then undo (twice), gives the tree before byte for byte", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { plan: probe } = await switchedSite(script);
    for (const k of [0, 1, probe.length - 1, probe.length]) {
      const { root, plan } = await switchedSite(script);
      const work = path.join(root, ".htpanel-import", ID_A);
      // Undo the last moves by hand so the swap looks stopped after k of them (R154).
      for (const [kind, rel] of plan.slice(k).reverse()) {
        const [from, to] = kind === "O" ? [path.join(root, rel), path.join(work, "aside", rel)] : [path.join(work, "site", rel), path.join(root, rel)];
        await rename(to, from);
      }
      expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
      expect(await siteSnapshot(root)).toEqual(before);
      expect(await exists(work)).toBe(false);
      expect(await exists(path.join(root, ".htpanel-import", "archive"))).toBe(true);
      expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
      expect(await siteSnapshot(root)).toEqual(before);
    }
  });

  it.skipIf(!hasZip)("undo with a lost entry answers complete:false and keeps the gate, the saved files and the work folder (R152, R155)", async () => {
    const script = await writeProgramScript();
    const { root } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    await rm(path.join(work, "aside", "old-only.txt"));
    for (let i = 0; i < 2; i += 1) {
      expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
      expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
      expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
      expect(await readFile(path.join(work, "wp-config.live"), "utf8")).toBe(LIVE_CONFIG);
      expect(await readFile(path.join(work, "htaccess.live"), "utf8")).toBe(LIVE_HTACCESS);
      expect(await exists(path.join(work, "plan"))).toBe(true);
    }
    expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // old index");
  });

  it.skipIf(!hasZip)("undo without its work folder answers complete:false while either gate still stands (R164.5.4)", async () => {
    const script = await writeProgramScript();
    const { root } = await switchedSite(script);
    const cfg = path.join(root, "wp-config.php");
    const hta = path.join(root, ".htaccess");
    await rm(path.join(root, ".htpanel-import", ID_A), { recursive: true });
    const undo = () => expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo");
    expect(undo()).toEqual({ complete: false });
    expect(await readFile(cfg, "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
    expect(await readFile(hta, "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
    await writeFile(hta, LIVE_HTACCESS);
    expect(undo()).toEqual({ complete: false });
    expect(await readFile(cfg, "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
    await writeFile(cfg, LIVE_CONFIG);
    await writeFile(hta, LIVE_HTACCESS + GATE_HTACCESS);
    expect(undo()).toEqual({ complete: false });
    await writeFile(hta, LIVE_HTACCESS);
    expect(undo()).toEqual({ complete: true });
  });

  it.skipIf(!hasZip)("undo answers complete:false and changes nothing when a name both trees hold is lost from aside (R164.5.4)", async () => {
    const script = await writeProgramScript();
    for (const rel of ["index.php", "wp-includes"]) {
      const { root } = await switchedSite(script);
      const work = path.join(root, ".htpanel-import", ID_A);
      await rm(path.join(work, "aside", rel), { recursive: true });
      const before = await listTreeSnapshot(root);
      expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
      expect(await listTreeSnapshot(root)).toEqual(before);
      expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
      expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
      expect(await readFile(path.join(work, "wp-config.live"), "utf8")).toBe(LIVE_CONFIG);
      expect(await readFile(path.join(work, "htaccess.live"), "utf8")).toBe(LIVE_HTACCESS);
      expect(await exists(path.join(work, "plan"))).toBe(true);
    }
  });

  /** A full undo killed while deleting its work folder: site and aside gone, the plan and wp-config.live left (R165.2). */
  async function undoKilledInDeletion(script: string): Promise<{ root: string; work: string }> {
    const { root } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    const plan = await readFile(path.join(work, "plan"));
    const savedConfig = await readFile(path.join(work, "wp-config.live"));
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
    await mkdir(work);
    await writeFile(path.join(work, "plan"), plan);
    await writeFile(path.join(work, "wp-config.live"), savedConfig);
    return { root, work };
  }

  it.skipIf(!hasZip)("undo rerun after a full undo killed while deleting its work folder answers complete:true once both gates are off (R165.2)", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { root, work } = await undoKilledInDeletion(script);
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
    expect(await exists(work)).toBe(false);
    expect(await siteSnapshot(root)).toEqual(before);
  });

  it.skipIf(!hasZip)("undo rerun after a killed deletion answers complete:false and changes nothing while either gate stands (R165.2)", async () => {
    const script = await writeProgramScript();
    const { root } = await undoKilledInDeletion(script);
    const cfg = path.join(root, "wp-config.php");
    const hta = path.join(root, ".htaccess");
    for (const [config, htaccess] of [
      [GATE_CONFIG + LIVE_CONFIG, LIVE_HTACCESS],
      [LIVE_CONFIG, LIVE_HTACCESS + GATE_HTACCESS],
    ] as const) {
      await writeFile(cfg, config);
      await writeFile(hta, htaccess);
      const before = await listTreeSnapshot(root);
      expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
      expect(await listTreeSnapshot(root)).toEqual(before);
    }
  });

  /** A deletion killed inside work/site, then the open site makes wp-content/uploads (import-only) and edits wp-config.php. */
  async function openSiteAfterKilledDeletion(script: string): Promise<{ root: string; work: string; config: string }> {
    const { root, work } = await undoKilledInDeletion(script);
    await mkdir(path.join(work, "site", "wp-content"), { recursive: true });
    await mkdir(path.join(root, "wp-content", "uploads"));
    await writeFile(path.join(root, "wp-content", "uploads", "photo.txt"), "customer upload");
    const config = LIVE_CONFIG + "// edited by the open site\n";
    await writeFile(path.join(root, "wp-config.php"), config);
    return { root, work, config };
  }

  it.skipIf(!hasZip)("undo rerun with both gates off moves nothing, writes nothing and only deletes the work folder (R166.4)", async () => {
    const script = await writeProgramScript();
    const { root, work, config } = await openSiteAfterKilledDeletion(script);
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
    expect(await exists(work)).toBe(false);
    expect(await readFile(path.join(root, "wp-content", "uploads", "photo.txt"), "utf8")).toBe("customer upload");
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(config);
  });

  it.skipIf(!hasZip)("undo rerun over an open site's new entry answers complete:false and moves nothing while a gate stands (R166.4)", async () => {
    const script = await writeProgramScript();
    const { root, config } = await openSiteAfterKilledDeletion(script);
    await writeFile(path.join(root, "wp-config.php"), GATE_CONFIG + config);
    const before = await listTreeSnapshot(root);
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
    expect(await listTreeSnapshot(root)).toEqual(before);
  });

  it.skipIf(!hasZip)("undo of a swap stopped before any move never pulls a live file into the work folder", async () => {
    const script = await writeProgramScript();
    const { root, plan } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    for (const [kind, rel] of [...plan].reverse()) {
      const [from, to] = kind === "O" ? [path.join(root, rel), path.join(work, "aside", rel)] : [path.join(work, "site", rel), path.join(root, rel)];
      await rename(to, from);
    }
    await rm(path.join(work, "site", "index.php"));
    // Neither copy is in the work folder, so the live index.php may be the imported one (R164.5.4).
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
    expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // old index");
    expect(await exists(path.join(work, "site", "index.php"))).toBe(false);
    expect(await exists(path.join(work, "aside", "index.php"))).toBe(false);
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
  });

  it.skipIf(!hasZip)("a forged plan line is skipped and moves nothing outside the site", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { root, outer } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    await writeFile(path.join(outer, "x"), "outside");
    await mkdir(path.join(work, "aside", "wp-content", "mu-plugins"));
    const forged = [
      ["I", "../x"],
      ["O", "../x"],
      ["O", "/etc/hostname"],
      ["I", "wp-content/mu-plugins"],
      ["O", "wp-content/mu-plugins"],
      ["O", "wp-content/../../x"],
      ["Z", "index.php"],
    ];
    await writeFile(
      path.join(work, "plan"),
      (await readFile(path.join(work, "plan"), "utf8")) + forged.map((f) => `${JSON.stringify(f)}\n`).join("") + "not json\n",
    );
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
    expect(await readFile(path.join(outer, "x"), "utf8")).toBe("outside");
    expect(await siteSnapshot(root)).toEqual(before);
  });

  it.skipIf(!hasZip)("import.finish strips exactly the gate, puts .htaccess back, names nested files back and is a no-op the second time", async () => {
    const script = await writeProgramScript();
    const { root } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    // What finalize does to the guarded file (wp config set table_prefix).
    const edited = (await readFile(path.join(root, "wp-config.php"), "utf8")).replace("'wp_'", "'old_'");
    await writeFile(path.join(root, "wp-config.php"), edited);
    await rm(path.join(root, "wp-content", "themes", "t", ".htaccess.hpimport"));
    await symlink("/etc/hostname", path.join(root, "wp-content", "themes", "t", ".htaccess.hpimport"));
    await writeFile(path.join(work, "htaccess.list"), "wp-content/uploads/.htaccess\nwp-content/themes/t/.htaccess\n../x/.htaccess\n");

    for (let i = 0; i < 2; i += 1) {
      expect(expectOk(runPhp(script, root, { op: "import.finish", importId: ID_A }), "import.finish")).toEqual({});
      const config = await readFile(path.join(root, "wp-config.php"), "utf8");
      expect(config).toBe(LIVE_CONFIG.replace("'wp_'", "'old_'"));
      expect(config.startsWith("<?php")).toBe(true);
      expect(config).not.toContain("hosting-panel import gate");
      expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS);
      expect(await readFile(path.join(root, "wp-content", "uploads", ".htaccess"), "utf8")).toBe("Require all granted\n");
      expect((await lstat(path.join(root, "wp-content", "themes", "t", ".htaccess.hpimport"))).isSymbolicLink()).toBe(true);
      expect(await exists(path.join(root, "wp-content", "themes", "t", ".htaccess"))).toBe(false);
      expect(await exists(path.join(root, ".htpanel-import"))).toBe(false);
      expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // new index");
      expect(await readFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "utf8")).toBe("// hp-mail stand-in");
    }
  });

  it.skipIf(!hasZip)("import.finish leaves a gate whose bytes were changed in place and refuses", async () => {
    const script = await writeProgramScript();
    const { root } = await switchedSite(script);
    const changed = (await readFile(path.join(root, "wp-config.php"), "utf8")).replace("503", "200");
    await writeFile(path.join(root, "wp-config.php"), changed);
    expectRefusal(runPhp(script, root, { op: "import.finish", importId: ID_A }), "staging_unsafe");
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(changed);
    expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
    expect(await exists(path.join(root, ".htpanel-import", ID_A, "plan"))).toBe(true);
  });

  it.skipIf(!hasZip)("remains: stat reports a work folder with a plan, discard keeps only that folder and answers success", async () => {
    const script = await writeProgramScript();
    const { root } = await makeLiveSite();
    const staging = path.join(root, ".htpanel-import");
    await mkdir(path.join(staging, ID_A), { recursive: true });
    await mkdir(path.join(staging, ID_B), { recursive: true });
    await writeFile(path.join(staging, "archive"), "PK\u0003\u0004");
    await writeFile(path.join(staging, "dump.upload"), "uploadAAAAAAAAAAAAAA");
    await writeFile(path.join(staging, ".htpanel-upload-uploadAAAAAAAAAAAAAA.part"), "part");
    expect(expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat").remains).toBe(false);

    await writeFile(path.join(staging, ID_A, "plan"), '["O","index.php"]\n');
    await writeFile(path.join(staging, ID_A, "wp-config.live"), LIVE_CONFIG);
    expect(expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat").remains).toBe(true);
    expect(expectOk(runPhp(script, root, { op: "import.discard" }), "import.discard")).toEqual({});
    expect((await readdir(staging)).sort()).toEqual([".htaccess", ID_A]);
    expect((await readdir(path.join(staging, ID_A))).sort()).toEqual(["plan", "wp-config.live"]);
    expect(expectOk(runPhp(script, root, { op: "import.stat" }), "import.stat").remains).toBe(true);

    await rm(path.join(staging, ID_A, "plan"));
    expectOk(runPhp(script, root, { op: "import.discard" }), "import.discard");
    expect(await exists(staging)).toBe(false);
    expect(expectOk(runPhp(script, root, { op: "import.discard" }), "import.discard")).toEqual({});
  });

  /** A plan line as hp_import_read_plan keeps it (hp_import_plan_rel_ok, hp_import_skip, hp_rel_ok), else null. */
  function followedPlanLine(line: string): [string, string] | null {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(e) || e.length !== 2 || (e[0] !== "O" && e[0] !== "I") || typeof e[1] !== "string") {
      return null;
    }
    const rel = e[1];
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const ok =
      /^(wp-content\/)?[^/]+$/.test(rel) &&
      ![...rel].some((c) => c < " " || c === "\x7f") &&
      base !== "." &&
      base !== ".." &&
      Buffer.byteLength(base) <= 255 &&
      ![".htaccess", "wp-config.php", "wp-content", ".maintenance", "wp-content/mu-plugins"].includes(rel) &&
      !base.startsWith(".hp_rs_") &&
      !base.startsWith(".htpanel-");
    return ok ? [e[0], rel] : null;
  }

  /** ADR 0024 §4.26 file steps done by hand with plain moves, as an administrator would. */
  async function handRepair(root: string, id: string, keep?: string): Promise<void> {
    const work = path.join(root, ".htpanel-import", id);
    const plan = (await readFile(path.join(work, "plan"), "utf8"))
      .split("\n")
      .map(followedPlanLine)
      .filter((e): e is [string, string] => e !== null);
    const outs = new Set(plan.filter(([k]) => k === "O").map(([, r]) => r));
    const both = new Set(plan.filter(([k, r]) => k === "I" && outs.has(r)).map(([, r]) => r));
    // First check, before any move: a name in both trees with neither copy in the work folder stops the steps.
    for (const rel of both) {
      if (!(await exists(path.join(work, "aside", rel))) && !(await exists(path.join(work, "site", rel)))) {
        throw new Error(`hand repair stops: neither copy of ${rel} is in the work folder`);
      }
    }
    // The entry at <rel> goes to site/<rel>; when that place is taken, to the administrator's own folder (R175.1).
    const putAway = async (rel: string): Promise<void> => {
      let to = path.join(work, "site", rel);
      if (await exists(to)) {
        expect(keep).toBeDefined();
        to = path.join(keep as string, rel);
        await mkdir(path.dirname(to), { recursive: true });
      }
      await rename(path.join(root, rel), to);
    };
    for (const rel of new Set(plan.map(([, r]) => r))) {
      const [live, aside, site] = [path.join(root, rel), path.join(work, "aside", rel), path.join(work, "site", rel)];
      if (await exists(aside)) {
        // Step a: a name still in aside/: what sits at its place goes to site/<rel>, then aside/<rel> goes back.
        if (await exists(live)) {
          await putAway(rel);
        }
        await rename(aside, live);
      } else if (!outs.has(rel) && (await exists(live))) {
        // Step b: a name only imported and still in the site goes to site/<rel>.
        await putAway(rel);
      } else if (outs.has(rel)) {
        // Step c: aside/<rel> is gone: already back when the imported copy is in site/<rel> or the name is only O.
        expect(!both.has(rel) || (await exists(site))).toBe(true);
      }
    }
    // Step d: the check before the gates come off.
    for (const [kind, rel] of plan) {
      const live = await exists(path.join(root, rel));
      expect(kind === "O" ? live && !(await exists(path.join(work, "aside", rel))) : outs.has(rel) || !live).toBe(true);
    }
    // Step e: each half starts from its saved file; without wp-config.live nothing is removed and the steps stop.
    if (!(await exists(path.join(work, "wp-config.live")))) {
      throw new Error("hand repair stops: wp-config.live is missing");
    }
    await rm(path.join(root, "wp-config.php"));
    await rename(path.join(work, "wp-config.live"), path.join(root, "wp-config.php"));
    const hta = path.join(root, ".htaccess");
    if (await exists(path.join(work, "htaccess.live"))) {
      await rm(hta);
      await rename(path.join(work, "htaccess.live"), hta);
    } else if (await exists(path.join(work, "htaccess.absent"))) {
      await rm(hta);
    } else {
      // Neither saved file: only the gate's block comes off, in place.
      await writeFile(hta, (await readFile(hta, "utf8")).replace(GATE_HTACCESS, ""));
    }
    // Step f: the work folder goes.
    await rm(work, { recursive: true });
  }

  it.skipIf(!hasZip)("hand repair §4.26 after an undo stopped half way gives the old site back", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { root } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    // A file where only the old site had a name stops the undo half way.
    await writeFile(path.join(root, "old-only.txt"), "intruder");
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
    expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // old index");
    expect(await exists(path.join(work, "aside", "index.php"))).toBe(false);
    expect(await readFile(path.join(work, "aside", "old-only.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
    await handRepair(root, ID_A);
    expect(await siteSnapshot(root)).toEqual(before);
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(LIVE_CONFIG);
    expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS);
    expect(await exists(work)).toBe(false);
  });

  it.skipIf(!hasZip)("hand repair §4.26 right after a full switch (exit 92, no undo run) gives the old site back, htaccess.absent too", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    for (const hadHtaccess of [true, false]) {
      const { root } = await makeLiveSite();
      if (!hadHtaccess) {
        await rm(path.join(root, ".htaccess"));
      }
      await stageArchive(root, buildTestZip(wpEntries("src/")));
      expectOk(runPhp(script, root, { op: "import.unpack", importId: ID_A }), "import.unpack");
      expectOk(runPhp(script, root, { op: "import.switch", importId: ID_A }), "import.switch");
      const work = path.join(root, ".htpanel-import", ID_A);
      expect(await exists(path.join(work, "htaccess.absent"))).toBe(!hadHtaccess);
      expect(await readFile(path.join(root, "index.php"), "utf8")).toBe("<?php // new index");
      await handRepair(root, ID_A);
      expect(await siteSnapshot(root)).toEqual(hadHtaccess ? before : before.filter((e) => !e.startsWith("F:.htaccess:")));
      expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(LIVE_CONFIG);
      expect(await exists(work)).toBe(false);
    }
  });


  it.skipIf(!hasZip)("hand repair §4.26 stops before any move when a name in both trees has neither copy in the work folder", async () => {
    const script = await writeProgramScript();
    const { root, plan } = await switchedSite(script);
    expect(plan).toContainEqual(["O", "wp-includes"]);
    expect(plan).toContainEqual(["I", "wp-includes"]);
    // The old wp-includes is lost from aside/; the imported one sits in the site.
    await rm(path.join(root, ".htpanel-import", ID_A, "aside", "wp-includes"), { recursive: true });
    const state = await listTreeSnapshot(root);
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
    expect(await listTreeSnapshot(root)).toEqual(state);
    await expect(handRepair(root, ID_A)).rejects.toThrow("neither copy of wp-includes");
    expect(await listTreeSnapshot(root)).toEqual(state);
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);
    expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS + GATE_HTACCESS);
  });

  it.skipIf(!hasZip)("hand repair §4.26 keeps wp-config.php without wp-config.live, and only strips the .htaccess gate without its saved file", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { root: noConfig } = await switchedSite(script);
    await rm(path.join(noConfig, ".htpanel-import", ID_A, "wp-config.live"));
    await expect(handRepair(noConfig, ID_A)).rejects.toThrow("wp-config.live is missing");
    expect(await readFile(path.join(noConfig, "wp-config.php"), "utf8")).toBe(GATE_CONFIG + LIVE_CONFIG);

    const { root: noHtaccess } = await switchedSite(script);
    await rm(path.join(noHtaccess, ".htpanel-import", ID_A, "htaccess.live"));
    await handRepair(noHtaccess, ID_A);
    expect(await siteSnapshot(noHtaccess)).toEqual(before);
    expect(await readFile(path.join(noHtaccess, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS);
  });

  it.skipIf(!hasZip)("hand repair §4.26 moves the entry at a name whose site/<rel> is taken to the administrator's own folder", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    const { root, outer, plan } = await switchedSite(script);
    const work = path.join(root, ".htpanel-import", ID_A);
    const rel = "wp-content/uploads";
    expect(plan).toContainEqual(["I", rel]);
    expect(plan).not.toContainEqual(["O", rel]);
    // As a switch stopped by an SFTP upload at a name the archive also has: the imported copy is still in site/<rel>.
    await rename(path.join(root, rel), path.join(work, "site", rel));
    await mkdir(path.join(root, rel));
    await writeFile(path.join(root, rel, "sftp.txt"), "uploaded");
    expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: false });
    const keep = path.join(outer, "kept");
    await handRepair(root, ID_A, keep);
    expect(await siteSnapshot(root)).toEqual(before);
    expect(await readFile(path.join(root, "wp-config.php"), "utf8")).toBe(LIVE_CONFIG);
    expect(await readFile(path.join(root, ".htaccess"), "utf8")).toBe(LIVE_HTACCESS);
    expect(await exists(work)).toBe(false);
    expect(await readFile(path.join(keep, rel, "sftp.txt"), "utf8")).toBe("uploaded");
  });

  it.skipIf(!hasZip)("hand repair §4.26 skips the plan lines the program skips: a planted wp-content/mu-plugins line leaves the folder in the site", async () => {
    const script = await writeProgramScript();
    const before = await siteSnapshot((await makeLiveSite()).root);
    for (const byHand of [false, true]) {
      const { root, plan } = await switchedSite(script);
      expect(plan.map(([, r]) => r)).not.toContain("wp-content/mu-plugins");
      const planFile = path.join(root, ".htpanel-import", ID_A, "plan");
      await writeFile(planFile, (await readFile(planFile, "utf8")) + '["I","wp-content/mu-plugins"]\n');
      if (byHand) {
        await handRepair(root, ID_A);
      } else {
        expect(expectOk(runPhp(script, root, { op: "import.undo", importId: ID_A }), "import.undo")).toEqual({ complete: true });
      }
      expect(await siteSnapshot(root)).toEqual(before);
      expect(await readFile(path.join(root, "wp-content", "mu-plugins", "hp-mail.php"), "utf8")).toBe("// hp-mail stand-in");
    }
  });
});
