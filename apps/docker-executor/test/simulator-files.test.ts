import { createHash } from "node:crypto";
import {
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_REASON_CODES,
  SITE_FILES_LIST_MAX,
  SITE_FILES_MAX_FILE_BYTES,
  SITE_FILES_RESULT_SCHEMAS,
  type SiteFileErrorReason,
} from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { describe, expect, it } from "vitest";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
  SimulatedSiteFiles,
  type SimSeedEntry,
} from "../src/index.js";

const UPLOAD_ID = "upload_0123456789ab";
const UPLOAD_ID_2 = "upload_fedcba987654";

function makeSimZip(
  entries: ReadonlyArray<{
    readonly p: string;
    readonly d?: string;
    readonly link?: string;
    readonly s?: number;
  }>,
): Buffer {
  return Buffer.from(`HPSIMZIP\n${JSON.stringify(entries)}`, "utf8");
}

async function expectFileRefusal(
  fn: () => Promise<unknown>,
  reason: SiteFileErrorReason,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ExecutorCodedError);
  const coded = caught as ExecutorCodedError;
  expect(coded.message).toBe(reason);
  expect(coded.code).toBe(SITE_FILE_REASON_CODES[reason]);
}

function makeFiles(): { files: SimulatedSiteFiles; svc: string } {
  const files = new SimulatedSiteFiles();
  const svc = "svc_sim_1";
  files.create(svc);
  return { files, svc };
}

describe("SimulatedSiteFiles", () => {
  describe("lifecycle and adapter wiring", () => {
    it("refuses all operations with NOT_FOUND / not_found before create and after drop", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_missing";
      expect(files.snapshot(svc)).toBeNull();

      await expectFileRefusal(() => files.handle({ serviceInstanceId: svc, op: "list", path: "" }), "not_found");
      await expectFileRefusal(() => files.handle({ serviceInstanceId: svc, op: "stat", path: "" }), "not_found");
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "index.php", offset: 0, length: 10 }),
        "not_found",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "a.txt",
            uploadId: UPLOAD_ID,
            offset: 0,
            dataBase64: Buffer.from("x").toString("base64"),
            final: true,
            overwrite: true,
          }),
        "not_found",
      );
      await expectFileRefusal(() => files.handle({ serviceInstanceId: svc, op: "mkdir", path: "d" }), "not_found");
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "move", from: "a", to: "b" }),
        "not_found",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "delete", paths: ["a"] }),
        "not_found",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "archive", paths: ["a"], to: "out.zip" }),
        "not_found",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "out.zip", to: "" }),
        "not_found",
      );

      files.create(svc);
      // Start an in-flight upload so we also verify drop clears staging state
      await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "staged.txt",
        uploadId: UPLOAD_ID,
        offset: 0,
        dataBase64: Buffer.from("abc").toString("base64"),
        final: false,
        overwrite: true,
      });

      files.drop(svc);
      expect(files.snapshot(svc)).toBeNull();
      await expectFileRefusal(() => files.handle({ serviceInstanceId: svc, op: "list", path: "" }), "not_found");

      // Re-creating should not see previous staging state
      files.create(svc);
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "staged.txt",
            uploadId: UPLOAD_ID,
            offset: 3,
            dataBase64: "",
            final: true,
            overwrite: true,
          }),
        "upload_mismatch",
      );
    });

    it("creates a miniature WordPress tree and preserves existing files on duplicate create()", async () => {
      const { files, svc } = makeFiles();
      const rootList = SITE_FILES_RESULT_SCHEMAS.list.parse(
        await files.handle({ serviceInstanceId: svc, op: "list", path: "" }),
      );
      expect(rootList.truncated).toBe(false);
      expect(rootList.entries.map((e) => [e.name, e.kind, e.writable])).toEqual([
        ["wp-content", "dir", true],
        ["index.php", "file", true],
        ["wp-config.php", "file", true],
      ]);

      const wpContent = await files.handle({ serviceInstanceId: svc, op: "list", path: "wp-content" });
      expect(wpContent.entries.map((e) => [e.name, e.kind, e.writable])).toEqual([
        ["mu-plugins", "dir", false],
        ["plugins", "dir", true],
        ["themes", "dir", true],
        ["uploads", "dir", true],
      ]);

      const muPlugins = await files.handle({
        serviceInstanceId: svc,
        op: "list",
        path: "wp-content/mu-plugins",
      });
      expect(muPlugins.entries.map((e) => [e.name, e.kind, e.writable])).toEqual([
        ["hp-mail.php", "file", false],
      ]);

      await files.handle({ serviceInstanceId: svc, op: "mkdir", path: "custom-dir" });
      files.create(svc);
      const afterRedeploy = await files.handle({ serviceInstanceId: svc, op: "list", path: "" });
      expect(afterRedeploy.entries.map((e) => e.name)).toContain("custom-dir");
    });

    it("integrates with InMemoryDockerSimulatorAdapter deploy, delete, purge, and engine availability", async () => {
      const adapter = new InMemoryDockerSimulatorAdapter();
      const svcNoVol = "svc_no_vol";
      await adapter.deployService(
        createApprovedServiceSpec({
          serviceInstanceId: svcNoVol,
          siteId: "site_no_vol",
          organizationId: "org_1",
          image: "wordpress:7.1.4-php8.4-apache",
          containerName: "hp_site_no_vol",
        }),
      );
      await expectFileRefusal(
        () => adapter.siteFiles({ serviceInstanceId: svcNoVol, op: "list", path: "" }),
        "not_found",
      );

      const svc = "svc_wp_1";
      await adapter.deployService(
        createApprovedServiceSpec({
          serviceInstanceId: svc,
          siteId: "site_wp_1",
          organizationId: "org_1",
          image: "wordpress:7.1.4-php8.4-apache",
          containerName: "hp_site_wp_1",
          volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
        }),
      );

      const listed = await adapter.siteFiles({ serviceInstanceId: svc, op: "list", path: "" });
      expect(listed.entries.map((e) => e.name)).toContain("index.php");

      // deleteService keeps the volume until purgeSite
      await adapter.deleteService(svc);
      const stillThere = await adapter.siteFiles({ serviceInstanceId: svc, op: "list", path: "" });
      expect(stillThere.entries.map((e) => e.name)).toContain("index.php");

      await adapter.purgeSite("site_wp_1");
      await expectFileRefusal(
        () => adapter.siteFiles({ serviceInstanceId: svc, op: "list", path: "" }),
        "not_found",
      );

      adapter.setEngineReachable(false);
      await expect(
        adapter.siteFiles({ serviceInstanceId: svc, op: "list", path: "" }),
      ).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    });
  });

  describe("path validation and schema parsing", () => {
    it("refuses traversal, absolute paths, control chars, reserved .htpanel- names, and oversized paths", async () => {
      const { files, svc } = makeFiles();
      const badPaths = [
        "../x",
        "a/../b",
        "/etc/x",
        ".",
        "./a",
        "a\u0000b",
        "a\nb",
        "a\x7fb",
        ".htpanel-upload-x",
        "wp-content/.htpanel-foo",
        "a".repeat(256),
        `${"a/".repeat(512)}b`, // > 1024 chars
      ];

      for (const bad of badPaths) {
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "list", path: bad }),
          "invalid_path",
        );
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "mkdir", path: bad }),
          "invalid_path",
        );
      }

      // Empty path is rejected for item operations
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "mkdir", path: "" }),
        "invalid_path",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "", offset: 0, length: 10 }),
        "invalid_path",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "delete", paths: [""] }),
        "invalid_path",
      );

      // Normalizes repeated/trailing slashes and allows backslash in regular file names
      await files.handle({ serviceInstanceId: svc, op: "mkdir", path: "wp-content//uploads//sub-norm/" });
      const st = await files.handle({
        serviceInstanceId: svc,
        op: "stat",
        path: "wp-content//uploads//sub-norm/",
      });
      expect(st.entry.name).toBe("sub-norm");

      await files.handle({ serviceInstanceId: svc, op: "mkdir", path: "a\\b" });
      const listed = await files.handle({ serviceInstanceId: svc, op: "list", path: "" });
      expect(listed.entries.map((e) => e.name)).toContain("a\\b");
    });
  });

  describe("list and stat", () => {
    it("sorts directories first then byte order, hides .htpanel-*, and truncates past 5000 entries", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_list";
      const seedEntries: SimSeedEntry[] = [
        { path: "z.txt", kind: "file", data: "1" },
        { path: "a.txt", kind: "file", data: "2" },
        { path: "Z-dir", kind: "dir" },
        { path: "a-dir", kind: "dir" },
        { path: ".htpanel-hidden", kind: "file", data: "secret" },
      ];
      files.seed(svc, seedEntries);

      const listed = await files.handle({ serviceInstanceId: svc, op: "list", path: "" });
      expect(listed.truncated).toBe(false);
      expect(listed.entries.map((e) => e.name)).toEqual(["Z-dir", "a-dir", "a.txt", "z.txt"]);

      const statRoot = SITE_FILES_RESULT_SCHEMAS.stat.parse(
        await files.handle({ serviceInstanceId: svc, op: "stat", path: "" }),
      );
      expect(statRoot.entry.name).toBe("");
      expect(statRoot.entry.kind).toBe("dir");
      expect(statRoot.entry.size).toBe(0);

      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "list", path: "a.txt" }),
        "not_a_directory",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "stat", path: "missing.txt" }),
        "not_found",
      );

      // Truncation past SITE_FILES_LIST_MAX
      const manySvc = "svc_many";
      const manyEntries: SimSeedEntry[] = Array.from({ length: SITE_FILES_LIST_MAX + 5 }, (_, i) => ({
        path: `file-${String(i).padStart(4, "0")}.txt`,
        kind: "file" as const,
        data: "",
      }));
      files.seed(manySvc, manyEntries);
      const manyListed = SITE_FILES_RESULT_SCHEMAS.list.parse(
        await files.handle({ serviceInstanceId: manySvc, op: "list", path: "" }),
      );
      expect(manyListed.entries).toHaveLength(SITE_FILES_LIST_MAX);
      expect(manyListed.truncated).toBe(true);
    });
  });

  describe("symlinks and confinement", () => {
    function seedWithLinks(): { files: SimulatedSiteFiles; svc: string } {
      const files = new SimulatedSiteFiles();
      const svc = "svc_links";
      files.create(svc);
      files.seed(svc, [
        { path: "wp-content/uploads/a.txt", kind: "file", data: "inside-upload" },
        { path: "in-link", kind: "link", target: "index.php" },
        { path: "abs-in-link", kind: "link", target: "/var/www/html/wp-content/uploads/a.txt" },
        { path: "updir", kind: "link", target: "wp-content/uploads" },
        { path: "out-abs", kind: "link", target: "/etc" },
        { path: "out-prefix", kind: "link", target: "/var/www/html2/secret" },
        { path: "out-rel", kind: "link", target: "../../etc/passwd" },
        { path: "wp-content/uploads/dirlink", kind: "link", target: "../../../etc/passwd" },
        { path: "dangling", kind: "link", target: "does-not-exist.txt" },
        { path: "loop-a", kind: "link", target: "loop-b" },
        { path: "loop-b", kind: "link", target: "loop-a" },
        { path: "wpc", kind: "link", target: "wp-content" },
      ]);
      return { files, svc };
    }

    it("lists links as kind 'link' without following and allows inside links", async () => {
      const { files, svc } = seedWithLinks();
      const listed = await files.handle({ serviceInstanceId: svc, op: "list", path: "" });
      const byName = new Map(listed.entries.map((e) => [e.name, e]));
      expect(byName.get("out-abs")?.kind).toBe("link");
      expect(byName.get("out-rel")?.kind).toBe("link");
      expect(byName.get("in-link")?.kind).toBe("link");
      expect(byName.get("loop-a")?.kind).toBe("link");

      const statLink = await files.handle({ serviceInstanceId: svc, op: "stat", path: "out-abs" });
      expect(statLink.entry.kind).toBe("link");

      const readIn = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "in-link",
        offset: 0,
        length: 1024,
      });
      expect(Buffer.from(readIn.dataBase64, "base64").toString("utf8")).toContain("<?php");

      const readAbsIn = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "abs-in-link",
        offset: 0,
        length: 1024,
      });
      expect(Buffer.from(readAbsIn.dataBase64, "base64").toString("utf8")).toBe("inside-upload");

      const listUp = await files.handle({ serviceInstanceId: svc, op: "list", path: "updir" });
      expect(listUp.entries.map((e) => e.name)).toContain("a.txt");

      const statThroughLink = await files.handle({
        serviceInstanceId: svc,
        op: "stat",
        path: "updir/a.txt",
      });
      expect(statThroughLink.entry.name).toBe("a.txt");
      expect(statThroughLink.entry.kind).toBe("file");

      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "updir", offset: 0, length: 64 }),
        "is_a_directory",
      );
    });

    it("refuses links escaping the root with PERMISSION_DENIED / protected and loops/dangling with NOT_FOUND", async () => {
      const { files, svc } = seedWithLinks();
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "out-abs/passwd", offset: 0, length: 64 }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "out-rel", offset: 0, length: 64 }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "out-prefix", offset: 0, length: 64 }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "list", path: "out-abs" }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "list", path: "wp-content/uploads/dirlink" }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "stat", path: "out-abs/passwd" }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "mkdir", path: "out-abs/newdir" }),
        "protected",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "out-abs/x.txt",
            uploadId: UPLOAD_ID,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "delete", paths: ["out-abs/passwd"] }),
        "protected",
      );

      // Dangling and symlink loop -> not_found
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "dangling", offset: 0, length: 64 }),
        "not_found",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "loop-a", offset: 0, length: 64 }),
        "not_found",
      );
    });
  });

  describe("read", () => {
    it("reads chunked slices, handles empty files, and rejects dirs and bad offsets", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_read";
      files.create(svc);
      files.seed(svc, [
        { path: "hello.txt", kind: "file", data: "hello world" },
        { path: "empty.txt", kind: "file", data: "" },
      ]);

      const c1 = SITE_FILES_RESULT_SCHEMAS.read.parse(
        await files.handle({ serviceInstanceId: svc, op: "read", path: "hello.txt", offset: 0, length: 5 }),
      );
      expect(Buffer.from(c1.dataBase64, "base64").toString("utf8")).toBe("hello");
      expect(c1.size).toBe(11);
      expect(c1.eof).toBe(false);

      const c2 = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "hello.txt",
        offset: 5,
        length: 100,
      });
      expect(Buffer.from(c2.dataBase64, "base64").toString("utf8")).toBe(" world");
      expect(c2.eof).toBe(true);

      const emptyRes = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "empty.txt",
        offset: 0,
        length: 100,
      });
      expect(emptyRes).toEqual({ dataBase64: "", size: 0, eof: true });

      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "wp-content", offset: 0, length: 10 }),
        "is_a_directory",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "read", path: "hello.txt", offset: 12, length: 10 }),
        "upload_mismatch",
      );
    });
  });

  describe("write staging semantics", () => {
    it("writes 3 chunks with replay, empty final chunk, sha match, and mode preservation", async () => {
      const { files, svc } = makeFiles();
      const part0 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41);
      const part1 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x42);
      const part2 = Buffer.from("tail-bytes", "utf8");
      const full = Buffer.concat([part0, part1, part2]);

      const r0 = SITE_FILES_RESULT_SCHEMAS.write.parse(
        await files.handle({
          serviceInstanceId: svc,
          op: "write",
          path: "wp-content/uploads/blob.bin",
          uploadId: UPLOAD_ID,
          offset: 0,
          dataBase64: part0.toString("base64"),
          final: false,
          overwrite: false,
        }),
      );
      expect(r0.received).toBe(part0.length);

      // Staging must not appear in list before final
      const listMid = await files.handle({
        serviceInstanceId: svc,
        op: "list",
        path: "wp-content/uploads",
      });
      expect(listMid.entries).toEqual([]);

      const r1 = await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/blob.bin",
        uploadId: UPLOAD_ID,
        offset: part0.length,
        dataBase64: part1.toString("base64"),
        final: false,
        overwrite: false,
      });
      expect(r1.received).toBe(part0.length + part1.length);

      // Replay chunk 1 (idempotent)
      const r1Replay = await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/blob.bin",
        uploadId: UPLOAD_ID,
        offset: part0.length,
        dataBase64: part1.toString("base64"),
        final: false,
        overwrite: false,
      });
      expect(r1Replay.received).toBe(part0.length + part1.length);

      // Write part2 as non-final, then accept empty final chunk (R4)
      const r2 = await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/blob.bin",
        uploadId: UPLOAD_ID,
        offset: part0.length + part1.length,
        dataBase64: part2.toString("base64"),
        final: false,
        overwrite: false,
      });
      expect(r2.received).toBe(full.length);

      const rFinal = await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/blob.bin",
        uploadId: UPLOAD_ID,
        offset: full.length,
        dataBase64: "",
        final: true,
        overwrite: false,
      });
      expect(rFinal.received).toBe(full.length);

      // Read back and verify sha256
      const c0 = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/blob.bin",
        offset: 0,
        length: SITE_FILE_CHUNK_BYTES,
      });
      const c1 = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/blob.bin",
        offset: SITE_FILE_CHUNK_BYTES,
        length: SITE_FILE_CHUNK_BYTES,
      });
      const c2 = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/blob.bin",
        offset: SITE_FILE_CHUNK_BYTES * 2,
        length: SITE_FILE_CHUNK_BYTES,
      });
      const readBack = Buffer.concat([
        Buffer.from(c0.dataBase64, "base64"),
        Buffer.from(c1.dataBase64, "base64"),
        Buffer.from(c2.dataBase64, "base64"),
      ]);
      expect(createHash("sha256").update(readBack).digest("hex")).toBe(
        createHash("sha256").update(full).digest("hex"),
      );

      // Overwrite false fails on existing file
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "wp-content/uploads/blob.bin",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: "YQ==",
            final: false,
            overwrite: false,
          }),
        "exists",
      );

      // Overwrite true replaces file
      await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/blob.bin",
        uploadId: UPLOAD_ID_2,
        offset: 0,
        dataBase64: Buffer.from("replaced").toString("base64"),
        final: true,
        overwrite: true,
      });
      const replaced = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/blob.bin",
        offset: 0,
        length: 100,
      });
      expect(Buffer.from(replaced.dataBase64, "base64").toString("utf8")).toBe("replaced");
    });

    it("refuses upload_mismatch, existing dir/link overwrite, quota limits, and non-writable dirs", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_write_err";
      files.create(svc);
      files.seed(svc, [
        { path: "in-link", kind: "link", target: "index.php" },
        { path: "ro-dir", kind: "dir", writable: false },
      ]);

      // Offset > 0 with missing staging -> upload_mismatch
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "new.txt",
            uploadId: UPLOAD_ID,
            offset: 5,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "upload_mismatch",
      );

      // Offset > staged length -> upload_mismatch
      await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "new.txt",
        uploadId: UPLOAD_ID,
        offset: 0,
        dataBase64: Buffer.from("hi").toString("base64"),
        final: false,
        overwrite: true,
      });
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "new.txt",
            uploadId: UPLOAD_ID,
            offset: 10,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "upload_mismatch",
      );

      // Existing dir or link -> exists even with overwrite: true
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "wp-content/uploads",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "exists",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "in-link",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "exists",
      );

      // Chunk > 512 KiB (both 1 byte over and larger) -> too_large
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "huge.bin",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: Buffer.alloc(SITE_FILE_CHUNK_BYTES + 1).toString("base64"),
            final: true,
            overwrite: true,
          }),
        "too_large",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "huge.bin",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: Buffer.alloc(SITE_FILE_CHUNK_BYTES + 100).toString("base64"),
            final: true,
            overwrite: true,
          }),
        "too_large",
      );

      // offset + chunk > 2 GiB -> too_large
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "huge2.bin",
            uploadId: UPLOAD_ID_2,
            offset: SITE_FILES_MAX_FILE_BYTES,
            dataBase64: Buffer.from("x").toString("base64"),
            final: true,
            overwrite: true,
          }),
        "too_large",
      );

      // Single empty final chunk creates 0-byte file
      const emptyWrite = await files.handle({
        serviceInstanceId: svc,
        op: "write",
        path: "zero.bin",
        uploadId: UPLOAD_ID_2,
        offset: 0,
        dataBase64: "",
        final: true,
        overwrite: false,
      });
      expect(emptyWrite.received).toBe(0);

      // Non-writable dir or non-writable file overwrite -> protected
      files.seed(svc, [{ path: "ro.txt", kind: "file", data: "old", writable: false }]);
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "ro.txt",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "protected",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "ro-dir/x.txt",
            uploadId: UPLOAD_ID_2,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "protected",
      );
    });
  });

  describe("protected entries, mkdir, move, and delete", () => {
    it("refuses mkdir, write, move, and delete on protected paths and via alias links", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_prot";
      files.create(svc);
      files.seed(svc, [{ path: "wpc", kind: "link", target: "wp-content" }]);

      const protectedTargets = [
        "wp-content",
        "wp-content/mu-plugins",
        "wp-content/mu-plugins/hp-mail.php",
        "wpc/mu-plugins",
        "wpc/mu-plugins/hp-mail.php",
      ];

      for (const p of protectedTargets) {
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "mkdir", path: p }),
          "protected",
        );
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "delete", paths: [p] }),
          "protected",
        );
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "move", from: p, to: "moved" }),
          "protected",
        );
        await expectFileRefusal(
          () =>
            files.handle({
              serviceInstanceId: svc,
              op: "write",
              path: p,
              uploadId: UPLOAD_ID,
              offset: 0,
              dataBase64: "YQ==",
              final: true,
              overwrite: true,
            }),
          "protected",
        );
      }

      // Writing a new file inside non-writable wp-content/mu-plugins -> protected
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "write",
            path: "wp-content/mu-plugins/evil.php",
            uploadId: UPLOAD_ID,
            offset: 0,
            dataBase64: "YQ==",
            final: true,
            overwrite: true,
          }),
        "protected",
      );

      // Moving into a protected path -> protected
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "move",
            from: "index.php",
            to: "wp-content/mu-plugins/hp-mail.php",
          }),
        "protected",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "move",
            from: "index.php",
            to: "wp-content/mu-plugins/extra.php",
          }),
        "protected",
      );
    });

    it("handles mkdir, move (including move_into_itself via link), and delete (including link deletion and batch atomicity)", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_ops";
      files.create(svc);
      files.seed(svc, [
        { path: "wp-content/uploads/keep.txt", kind: "file", data: "keep" },
        { path: "updir", kind: "link", target: "wp-content/uploads" },
        { path: "ro-parent", kind: "dir", writable: false },
        { path: "ro-parent/child.txt", kind: "file", data: "locked" },
      ]);

      await files.handle({ serviceInstanceId: svc, op: "mkdir", path: "wp-content/uploads/sub" });
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "mkdir", path: "wp-content/uploads/sub" }),
        "exists",
      );

      // move_into_itself direct and via alias link
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "move",
            from: "wp-content/uploads",
            to: "wp-content/uploads/sub/nested",
          }),
        "invalid_path",
      );
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "move",
            from: "wp-content/uploads",
            to: "updir/sub/nested",
          }),
        "invalid_path",
      );

      // Move file into existing target -> exists
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "move",
            from: "index.php",
            to: "wp-config.php",
          }),
        "exists",
      );

      // Move file and verify
      await files.handle({
        serviceInstanceId: svc,
        op: "move",
        from: "wp-content/uploads/keep.txt",
        to: "wp-content/uploads/sub/moved.txt",
      });
      const movedStat = await files.handle({
        serviceInstanceId: svc,
        op: "stat",
        path: "wp-content/uploads/sub/moved.txt",
      });
      expect(movedStat.entry.kind).toBe("file");

      // Deleting a link removes only the link and leaves target intact
      await files.handle({ serviceInstanceId: svc, op: "delete", paths: ["updir"] });
      const uploadsStat = await files.handle({
        serviceInstanceId: svc,
        op: "stat",
        path: "wp-content/uploads/sub/moved.txt",
      });
      expect(uploadsStat.entry.kind).toBe("file");

      // Batch delete atomicity: if one entry fails, nothing is deleted
      const snapBefore = files.snapshot(svc);
      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "delete",
            paths: ["wp-content/uploads/sub/moved.txt", "does-not-exist"],
          }),
        "not_found",
      );
      expect(files.snapshot(svc)).toEqual(snapBefore);

      // Deleting non-empty non-writable directory -> protected
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "delete", paths: ["ro-parent"] }),
        "protected",
      );
      expect(files.snapshot(svc)).toEqual(snapBefore);
    });
  });

  describe("archive and extract (HPSIMZIP format)", () => {
    it("archives trees skipping links and .htpanel-*, and round-trips through extract", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_zip";
      files.create(svc);
      files.seed(svc, [
        { path: "wp-content/uploads/hello.txt", kind: "file", data: "hello zip" },
        { path: "wp-content/uploads/empty.txt", kind: "file", data: "" },
        { path: "wp-content/uploads/empty-dir", kind: "dir" },
        { path: "wp-content/uploads/sym", kind: "link", target: "/etc/passwd" },
        { path: "wp-content/uploads/.htpanel-ignore", kind: "file", data: "tmp" },
      ]);

      const archived = SITE_FILES_RESULT_SCHEMAS.archive.parse(
        await files.handle({
          serviceInstanceId: svc,
          op: "archive",
          paths: ["wp-content"],
          to: "site.zip",
        }),
      );
      // wp-content/, mu-plugins/, hp-mail.php, plugins/, themes/, uploads/, empty-dir/, empty.txt, hello.txt = 9
      expect(archived.entries).toBe(9);

      const extracted = SITE_FILES_RESULT_SCHEMAS.extract.parse(
        await files.handle({
          serviceInstanceId: svc,
          op: "extract",
          path: "site.zip",
          to: "restored",
        }),
      );
      expect(extracted.entries).toBe(9);

      const readRestored = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "restored/wp-content/uploads/hello.txt",
        offset: 0,
        length: 100,
      });
      expect(Buffer.from(readRestored.dataBase64, "base64").toString("utf8")).toBe("hello zip");

      const readEmpty = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "restored/wp-content/uploads/empty.txt",
        offset: 0,
        length: 100,
      });
      expect(readEmpty).toEqual({ dataBase64: "", size: 0, eof: true });

      // Skipped symlink and .htpanel-* are absent from restored
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "stat", path: "restored/wp-content/uploads/sym" }),
        "not_found",
      );
      const restoredUploads = await files.handle({
        serviceInstanceId: svc,
        op: "list",
        path: "restored/wp-content/uploads",
      });
      expect(restoredUploads.entries.map((e) => e.name)).toEqual(["empty-dir", "empty.txt", "hello.txt"]);

      // Extract into root "" merges directories cleanly
      await files.seed(svc, [
        {
          path: "patch.zip",
          kind: "file",
          data: makeSimZip([
            { p: "wp-content/" },
            { p: "wp-content/uploads/patched.txt", d: Buffer.from("ok").toString("base64") },
          ]),
        },
      ]);
      const rootExtract = await files.handle({
        serviceInstanceId: svc,
        op: "extract",
        path: "patch.zip",
        to: "",
      });
      expect(rootExtract.entries).toBe(2);
      const patched = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/patched.txt",
        offset: 0,
        length: 50,
      });
      expect(Buffer.from(patched.dataBase64, "base64").toString("utf8")).toBe("ok");

      // Extract into existing wp-content directory succeeds for non-protected targets
      await files.seed(svc, [
        {
          path: "theme.zip",
          kind: "file",
          data: makeSimZip([{ p: "themes/child/style.css", d: Buffer.from("body{}").toString("base64") }]),
        },
      ]);
      const themeExtract = await files.handle({
        serviceInstanceId: svc,
        op: "extract",
        path: "theme.zip",
        to: "wp-content",
      });
      expect(themeExtract.entries).toBe(1);
      const css = await files.handle({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/themes/child/style.css",
        offset: 0,
        length: 50,
      });
      expect(Buffer.from(css.dataBase64, "base64").toString("utf8")).toBe("body{}");
    });

    it("refuses archive with different folders, depth > 32, existing destination, or protected destination", async () => {
      const { files, svc } = makeFiles();
      const deepPath = `${Array.from({ length: 33 }, () => "d").join("/")}/leaf.txt`;
      files.seed(svc, [{ path: deepPath, kind: "file", data: "x" }]);

      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "archive",
            paths: ["d"],
            to: "too-deep.zip",
          }),
        "archive_limit",
      );

      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "archive",
            paths: ["index.php", "wp-content/uploads"],
            to: "bad.zip",
          }),
        "invalid_path",
      );

      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "archive",
            paths: ["index.php"],
            to: "wp-config.php",
          }),
        "exists",
      );

      await expectFileRefusal(
        () =>
          files.handle({
            serviceInstanceId: svc,
            op: "archive",
            paths: ["index.php"],
            to: "wp-content/mu-plugins/out.zip",
          }),
        "protected",
      );
    });

    it("refuses unsafe, symlink, oversized, invalid, conflicting, and protected extracts leaving nothing behind", async () => {
      const files = new SimulatedSiteFiles();
      const svc = "svc_bad_zips";
      files.create(svc);
      files.seed(svc, [
        { path: "garbage.zip", kind: "file", data: "not-a-sim-zip" },
        { path: "badjson.zip", kind: "file", data: "HPSIMZIP\n{bad" },
        { path: "dotdot.zip", kind: "file", data: makeSimZip([{ p: "../evil.txt", d: "YQ==" }]) },
        { path: "abs.zip", kind: "file", data: makeSimZip([{ p: "/etc/evil", d: "YQ==" }]) },
        { path: "drive.zip", kind: "file", data: makeSimZip([{ p: "C:evil", d: "YQ==" }]) },
        { path: "backslash.zip", kind: "file", data: makeSimZip([{ p: "a\\b", d: "YQ==" }]) },
        { path: "reserved.zip", kind: "file", data: makeSimZip([{ p: ".htpanel-bad", d: "YQ==" }]) },
        {
          path: "dup.zip",
          kind: "file",
          data: makeSimZip([
            { p: "a.txt", d: "YQ==" },
            { p: "a.txt", d: "Yg==" },
          ]),
        },
        {
          path: "filedir.zip",
          kind: "file",
          data: makeSimZip([
            { p: "a", d: "YQ==" },
            { p: "a/b.txt", d: "Yg==" },
          ]),
        },
        {
          path: "symlink.zip",
          kind: "file",
          data: makeSimZip([{ p: "s", link: "/etc/passwd" }]),
        },
        {
          path: "too-many.zip",
          kind: "file",
          data: makeSimZip(
            Array.from({ length: 20_001 }, (_, i) => ({ p: `f_${String(i)}`, d: "" })),
          ),
        },
        {
          path: "deep.zip",
          kind: "file",
          data: makeSimZip([{ p: `${Array.from({ length: 33 }, () => "d").join("/")}/f.txt`, d: "" }]),
        },
        {
          path: "bomb.zip",
          kind: "file",
          data: makeSimZip([{ p: "bomb.bin", d: "AAAA", s: 20 * 1024 * 1024 }]),
        },
        {
          path: "over1g.zip",
          kind: "file",
          data: makeSimZip([
            { p: "big1.bin", d: "AAAA", s: 600 * 1024 * 1024 },
            { p: "big2.bin", d: "AAAA", s: 600 * 1024 * 1024 },
          ]),
        },
        {
          path: "conflict.zip",
          kind: "file",
          data: makeSimZip([
            { p: "new-first.txt", d: "YQ==" },
            { p: "index.php", d: "YQ==" },
          ]),
        },
        {
          path: "prot-file.zip",
          kind: "file",
          data: makeSimZip([{ p: "wp-content/mu-plugins/hp-mail.php", d: "YQ==" }]),
        },
        {
          path: "prot-dir.zip",
          kind: "file",
          data: makeSimZip([{ p: "wp-content/mu-plugins/new.php", d: "YQ==" }]),
        },
      ]);

      const snapBefore = files.snapshot(svc);

      // Garbage and bad json -> not_a_zip (also must NOT create missing 'to')
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "garbage.zip", to: "out1" }),
        "not_a_zip",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "badjson.zip", to: "out1" }),
        "not_a_zip",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "wp-content", to: "out1" }),
        "is_a_directory",
      );

      // Unsafe entries and symlinks -> archive_unsafe
      for (const name of [
        "dotdot.zip",
        "abs.zip",
        "drive.zip",
        "backslash.zip",
        "reserved.zip",
        "dup.zip",
        "filedir.zip",
        "symlink.zip",
      ]) {
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "extract", path: name, to: "out2" }),
          "archive_unsafe",
        );
      }

      // Limits -> archive_limit
      for (const name of ["too-many.zip", "deep.zip", "bomb.zip", "over1g.zip"]) {
        await expectFileRefusal(
          () => files.handle({ serviceInstanceId: svc, op: "extract", path: name, to: "out3" }),
          "archive_limit",
        );
      }

      // Conflicts -> exists (including destination itself being a file)
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "conflict.zip", to: "" }),
        "exists",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "conflict.zip", to: "index.php" }),
        "exists",
      );

      // Protected targets -> protected
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "prot-file.zip", to: "" }),
        "protected",
      );
      await expectFileRefusal(
        () => files.handle({ serviceInstanceId: svc, op: "extract", path: "prot-dir.zip", to: "" }),
        "protected",
      );

      // Verify nothing was created or modified by any of the refused extracts
      expect(files.snapshot(svc)).toEqual(snapBefore);
    });
  });
});
