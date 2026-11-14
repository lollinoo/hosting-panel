import { randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_REASON_CODES,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
  type SiteFileErrorReason,
} from "@hosting-panel/contracts";
import {
  Phase1DisabledDockerExecutor,
  createApprovedServiceSpec,
  type SiteFilesRequest,
} from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerExecutorIpcServer,
  ExecutorCodedError,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-site-files-ipc-key";
const SIGNING_KEY: IpcSigningKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};

const UPLOAD_ID_1 = "upload_0123456789abcdef";
const UPLOAD_ID_2 = "upload_fedcba9876543210";

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

function rawUnixPost(options: {
  readonly socketPath: string;
  readonly pathWithQuery: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Promise<{ readonly statusCode: number; readonly json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(options.body, "utf8");
    const req = http.request(
      {
        socketPath: options.socketPath,
        method: "POST",
        path: options.pathWithQuery,
        headers: {
          ...options.headers,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(bodyBuf.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function expectIpcReasonRefusal(
  fn: () => Promise<unknown>,
  reason: SiteFileErrorReason,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ExecutorIpcClientError);
  const err = caught as ExecutorIpcClientError;
  expect(err.code).toBe(SITE_FILE_REASON_CODES[reason]);
  expect(err.message).toBe(reason);
}

describe("Site files through signed IPC and simulator", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const fn = cleanupTasks.pop();
      if (fn) {
        await fn();
      }
    }
  });

  async function createHarness(options?: { readonly deployDefaultSite?: boolean }) {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const socketPath = path.join(
      os.tmpdir(),
      `hp-files-ipc-${randomBytes(6).toString("hex")}.sock`,
    );
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "local-simulator",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    const svc = "svc_files_1";
    const siteId = "site_files_1";
    if (options?.deployDefaultSite !== false) {
      await client.deployService(
        createApprovedServiceSpec({
          serviceInstanceId: svc,
          siteId,
          organizationId: "org_1",
          image: "wordpress:6.7-php8.3-apache",
          containerName: "hp-svc-files-1",
          volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
        }),
      );
    }

    return { simulator, server, client, socketPath, svc, siteId };
  }

  it("round-trips all nine site-file operations over the signed UDS IPC", async () => {
    const { client, svc } = await createHarness();

    // 1. list
    const rootList = await client.siteFiles({ serviceInstanceId: svc, op: "list", path: "" });
    expect(rootList.truncated).toBe(false);
    expect(rootList.entries.map((e) => e.name)).toEqual([
      "wp-content",
      "index.php",
      "wp-config.php",
    ]);

    // 2. stat (root and file)
    const rootStat = await client.siteFiles({ serviceInstanceId: svc, op: "stat", path: "" });
    expect(rootStat.entry.name).toBe("");
    expect(rootStat.entry.kind).toBe("dir");
    const indexStat = await client.siteFiles({
      serviceInstanceId: svc,
      op: "stat",
      path: "index.php",
    });
    expect(indexStat.entry.name).toBe("index.php");
    expect(indexStat.entry.kind).toBe("file");

    // 3. mkdir
    expect(
      await client.siteFiles({
        serviceInstanceId: svc,
        op: "mkdir",
        path: "wp-content/uploads/notes",
      }),
    ).toEqual({});

    // 4. write
    const content = Buffer.from("Hello, signed IPC!\n", "utf8");
    const writeRes = await client.siteFiles({
      serviceInstanceId: svc,
      op: "write",
      path: "wp-content/uploads/notes/hello.txt",
      uploadId: UPLOAD_ID_1,
      offset: 0,
      dataBase64: content.toString("base64"),
      final: true,
      overwrite: false,
    });
    expect(writeRes.received).toBe(content.length);

    // 5. read
    const readRes = await client.siteFiles({
      serviceInstanceId: svc,
      op: "read",
      path: "wp-content/uploads/notes/hello.txt",
      offset: 0,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(Buffer.from(readRes.dataBase64, "base64").equals(content)).toBe(true);
    expect(readRes.size).toBe(content.length);
    expect(readRes.eof).toBe(true);

    // 6. move
    expect(
      await client.siteFiles({
        serviceInstanceId: svc,
        op: "move",
        from: "wp-content/uploads/notes/hello.txt",
        to: "wp-content/uploads/notes/renamed.txt",
      }),
    ).toEqual({});

    // 7. archive
    const archiveRes = await client.siteFiles({
      serviceInstanceId: svc,
      op: "archive",
      paths: ["wp-content/uploads/notes"],
      to: "wp-content/uploads/notes.zip",
    });
    expect(archiveRes.entries).toBe(2);

    // 8. extract
    const extractRes = await client.siteFiles({
      serviceInstanceId: svc,
      op: "extract",
      path: "wp-content/uploads/notes.zip",
      to: "wp-content/uploads/restored",
    });
    expect(extractRes.entries).toBe(2);

    const extractedRead = await client.siteFiles({
      serviceInstanceId: svc,
      op: "read",
      path: "wp-content/uploads/restored/notes/renamed.txt",
      offset: 0,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(Buffer.from(extractedRead.dataBase64, "base64").equals(content)).toBe(true);

    // 9. delete
    expect(
      await client.siteFiles({
        serviceInstanceId: svc,
        op: "delete",
        paths: [
          "wp-content/uploads/notes",
          "wp-content/uploads/notes.zip",
          "wp-content/uploads/restored",
        ],
      }),
    ).toEqual({});

    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "stat",
          path: "wp-content/uploads/notes",
        }),
      "not_found",
    );
  });

  it("uploads in multiple 512 KiB chunks with a replayed chunk and reads back byte for byte", async () => {
    const { client, svc } = await createHarness();

    const totalSize = SITE_FILE_CHUNK_BYTES * 2 + 19_457;
    const original = Buffer.allocUnsafe(totalSize);
    for (let i = 0; i < totalSize; i += 1) {
      original[i] = (i * 31 + (i >> 8)) & 0xff;
    }

    const chunk0 = original.subarray(0, SITE_FILE_CHUNK_BYTES);
    const chunk1 = original.subarray(SITE_FILE_CHUNK_BYTES, SITE_FILE_CHUNK_BYTES * 2);
    const chunk2 = original.subarray(SITE_FILE_CHUNK_BYTES * 2);

    const r0 = await client.siteFiles({
      serviceInstanceId: svc,
      op: "write",
      path: "wp-content/uploads/large.bin",
      uploadId: UPLOAD_ID_1,
      offset: 0,
      dataBase64: chunk0.toString("base64"),
      final: false,
      overwrite: true,
    });
    expect(r0.received).toBe(SITE_FILE_CHUNK_BYTES);

    const r1 = await client.siteFiles({
      serviceInstanceId: svc,
      op: "write",
      path: "wp-content/uploads/large.bin",
      uploadId: UPLOAD_ID_1,
      offset: SITE_FILE_CHUNK_BYTES,
      dataBase64: chunk1.toString("base64"),
      final: false,
      overwrite: true,
    });
    expect(r1.received).toBe(SITE_FILE_CHUNK_BYTES * 2);

    // Replay chunk 1 (idempotent offset-addressed write).
    const r1Replay = await client.siteFiles({
      serviceInstanceId: svc,
      op: "write",
      path: "wp-content/uploads/large.bin",
      uploadId: UPLOAD_ID_1,
      offset: SITE_FILE_CHUNK_BYTES,
      dataBase64: chunk1.toString("base64"),
      final: false,
      overwrite: true,
    });
    expect(r1Replay.received).toBe(SITE_FILE_CHUNK_BYTES * 2);

    // Final chunk.
    const r2 = await client.siteFiles({
      serviceInstanceId: svc,
      op: "write",
      path: "wp-content/uploads/large.bin",
      uploadId: UPLOAD_ID_1,
      offset: SITE_FILE_CHUNK_BYTES * 2,
      dataBase64: chunk2.toString("base64"),
      final: true,
      overwrite: true,
    });
    expect(r2.received).toBe(totalSize);

    // Staging file must never be visible.
    const listed = await client.siteFiles({
      serviceInstanceId: svc,
      op: "list",
      path: "wp-content/uploads",
    });
    expect(listed.entries.some((e) => e.name.startsWith(".htpanel-"))).toBe(false);

    // Read back in chunks and compare byte for byte.
    const readChunks: Buffer[] = [];
    let offset = 0;
    const readStep = 400_000;
    while (true) {
      const part = await client.siteFiles({
        serviceInstanceId: svc,
        op: "read",
        path: "wp-content/uploads/large.bin",
        offset,
        length: readStep,
      });
      expect(part.size).toBe(totalSize);
      const buf = Buffer.from(part.dataBase64, "base64");
      readChunks.push(buf);
      offset += buf.length;
      if (part.eof) {
        break;
      }
    }

    const reassembled = Buffer.concat(readChunks);
    expect(reassembled.length).toBe(original.length);
    expect(Buffer.compare(reassembled, original)).toBe(0);
  });

  it("refuses invalid paths (traversal, absolute, control chars, reserved .htpanel-) with VALIDATION_ERROR and invalid_path", async () => {
    const { client, svc } = await createHarness();

    for (const badPath of ["a/../../b", "/etc/passwd", "a\u0000b", "a\nb", ".htpanel-x"]) {
      await expectIpcReasonRefusal(
        () => client.siteFiles({ serviceInstanceId: svc, op: "stat", path: badPath }),
        "invalid_path",
      );
    }
  });

  it("propagates every adapter R2 refusal code and exact reason token as message to the client", async () => {
    const { simulator, client, svc } = await createHarness();

    simulator.files.seed(svc, [
      { path: "escape-rel", kind: "link", target: "../../etc/passwd" },
      { path: "escape-abs", kind: "link", target: "/etc/passwd" },
      { path: "wp-content/uploads/sample.txt", kind: "file", data: "sample" },
      {
        path: "wp-content/uploads/unsafe-dotdot.zip",
        kind: "file",
        data: makeSimZip([{ p: "../evil.txt", d: Buffer.from("x").toString("base64") }]),
      },
      {
        path: "wp-content/uploads/unsafe-link.zip",
        kind: "file",
        data: makeSimZip([{ p: "lnk", link: "/etc/passwd" }]),
      },
      {
        path: "wp-content/uploads/bomb.zip",
        kind: "file",
        data: makeSimZip([{ p: "bomb.bin", d: "AAAA", s: 2 * 1024 * 1024 }]),
      },
      {
        path: "wp-content/uploads/garbage.zip",
        kind: "file",
        data: Buffer.from("not-a-zip-archive", "utf8"),
      },
    ]);

    // Symlink leaving root -> protected
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: svc, op: "read", path: "escape-rel", offset: 0, length: 64 }),
      "protected",
    );
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: svc, op: "read", path: "escape-abs", offset: 0, length: 64 }),
      "protected",
    );

    // Protected wp-content/mu-plugins/hp-mail.php (delete, move, overwrite)
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: svc, op: "delete", paths: ["wp-content/mu-plugins/hp-mail.php"] }),
      "protected",
    );
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "move",
          from: "wp-content/mu-plugins/hp-mail.php",
          to: "wp-content/uploads/hp-mail.php",
        }),
      "protected",
    );
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "write",
          path: "wp-content/mu-plugins/hp-mail.php",
          uploadId: UPLOAD_ID_1,
          offset: 0,
          dataBase64: Buffer.from("pwn").toString("base64"),
          final: true,
          overwrite: true,
        }),
      "protected",
    );

    // exists with overwrite: false
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "write",
          path: "index.php",
          uploadId: UPLOAD_ID_2,
          offset: 0,
          dataBase64: Buffer.from("new").toString("base64"),
          final: true,
          overwrite: false,
        }),
      "exists",
    );

    // upload_mismatch (offset > 0 on missing staging)
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "write",
          path: "wp-content/uploads/new.bin",
          uploadId: UPLOAD_ID_2,
          offset: 128,
          dataBase64: Buffer.from("abc").toString("base64"),
          final: true,
          overwrite: true,
        }),
      "upload_mismatch",
    );

    // not_a_directory
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: svc, op: "list", path: "index.php" }),
      "not_a_directory",
    );

    // is_a_directory
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "read",
          path: "wp-content",
          offset: 0,
          length: 64,
        }),
      "is_a_directory",
    );

    // not_found
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: svc, op: "stat", path: "no-such-file.txt" }),
      "not_found",
    );

    // archive_unsafe
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "extract",
          path: "wp-content/uploads/unsafe-dotdot.zip",
          to: "wp-content/uploads/out1",
        }),
      "archive_unsafe",
    );
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "extract",
          path: "wp-content/uploads/unsafe-link.zip",
          to: "wp-content/uploads/out2",
        }),
      "archive_unsafe",
    );

    // archive_limit
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "extract",
          path: "wp-content/uploads/bomb.zip",
          to: "wp-content/uploads/out3",
        }),
      "archive_limit",
    );

    // not_a_zip
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "extract",
          path: "wp-content/uploads/garbage.zip",
          to: "wp-content/uploads/out4",
        }),
      "not_a_zip",
    );
  });

  it("refuses a 524,289-byte chunk before reaching the adapter with QUOTA_EXCEEDED / too_large", async () => {
    const { simulator, client, svc } = await createHarness();
    const siteFilesSpy = vi.spyOn(simulator, "siteFiles");

    // 524,289 bytes -> refused before reaching adapter with QUOTA_EXCEEDED / too_large.
    const overChunkB64 = Buffer.alloc(SITE_FILE_CHUNK_BYTES + 1, 0x41).toString("base64");
    await expectIpcReasonRefusal(
      () =>
        client.siteFiles({
          serviceInstanceId: svc,
          op: "write",
          path: "wp-content/uploads/too-big-chunk.bin",
          uploadId: UPLOAD_ID_1,
          offset: 0,
          dataBase64: overChunkB64,
          final: true,
          overwrite: true,
        }),
      "too_large",
    );
    expect(siteFilesSpy).not.toHaveBeenCalled();
  });

  it("refuses an oversized IPC body (>1 MiB) before reaching the adapter", async () => {
    const { simulator, client, svc } = await createHarness();
    const siteFilesSpy = vi.spyOn(simulator, "siteFiles");

    // Body over MAX_IPC_BODY_BYTES (1 MiB) -> refused before reaching adapter.
    const overIpcCapB64 = Buffer.alloc(800_000, 0x42).toString("base64"); // ~1.067 MB JSON
    let caughtOversized: unknown;
    try {
      await client.siteFiles({
        serviceInstanceId: svc,
        op: "write",
        path: "wp-content/uploads/over-ipc-cap.bin",
        uploadId: UPLOAD_ID_1,
        offset: 0,
        dataBase64: overIpcCapB64,
        final: true,
        overwrite: true,
      });
    } catch (err: unknown) {
      caughtOversized = err;
    }
    expect(caughtOversized).toBeInstanceOf(ExecutorIpcClientError);
    expect((caughtOversized as ExecutorIpcClientError).code).toBe("VALIDATION_ERROR");
    expect(siteFilesSpy).not.toHaveBeenCalled();
  });

  it("refuses a request with a bad signature before reaching the adapter", async () => {
    const { simulator, socketPath, svc } = await createHarness();
    const siteFilesSpy = vi.spyOn(simulator, "siteFiles");

    const badClient = new SignedDockerExecutorIpcClient({
      signingKey: {
        keyId: "hmac-v1",
        algorithm: "hmac-sha256",
        secret: "wrong-secret-0123456789abcdef0123456789abcdef",
      },
      transport: "uds",
      socketPath,
    });

    await expect(
      badClient.siteFiles({ serviceInstanceId: svc, op: "list", path: "" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });

    // Tampered body after signing
    const body = JSON.stringify({ serviceInstanceId: svc, op: "list", path: "" });
    const headers = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/sites/files",
      body,
      key: SIGNING_KEY,
    });
    const tamperedBody = JSON.stringify({ serviceInstanceId: svc, op: "list", path: "wp-content" });
    const rawRes = await rawUnixPost({
      socketPath,
      pathWithQuery: "/v1/sites/files",
      headers: { ...headers },
      body: tamperedBody,
    });
    expect(rawRes.statusCode).toBe(401);
    expect(siteFilesSpy).not.toHaveBeenCalled();
  });

  it("isolates site trees and rejects unsafe or unknown serviceInstanceId values", async () => {
    const { simulator, client, socketPath } = await createHarness({ deployDefaultSite: false });

    await client.deployService(
      createApprovedServiceSpec({
        serviceInstanceId: "svc_site_a",
        siteId: "site_a",
        organizationId: "org_a",
        image: "wordpress:6.7-php8.3-apache",
        containerName: "hp-svc-site-a",
        volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
      }),
    );
    await client.deployService(
      createApprovedServiceSpec({
        serviceInstanceId: "svc_site_b",
        siteId: "site_b",
        organizationId: "org_b",
        image: "wordpress:6.7-php8.3-apache",
        containerName: "hp-svc-site-b",
        volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
      }),
    );
    simulator.files.seed("svc_site_a", [{ path: "secret-a.txt", kind: "file", data: "A-only" }]);
    simulator.files.seed("svc_site_b", [{ path: "secret-b.txt", kind: "file", data: "B-only" }]);

    // Cross-site isolation
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: "svc_site_a", op: "stat", path: "secret-b.txt" }),
      "not_found",
    );
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: "svc_site_b", op: "stat", path: "secret-a.txt" }),
      "not_found",
    );

    // Client-side guard for '/' and '..' in serviceInstanceId
    for (const badId of ["svc_site_a/svc_site_b", "svc_site_a/../svc_site_b", ".."]) {
      await expect(
        client.siteFiles({ serviceInstanceId: badId, op: "list", path: "" }),
      ).rejects.toThrow(ExecutorCodedError);

      // Even if sent directly over signed HTTP, the server rejects it with HOST_POLICY_DENIED (403).
      const rawBody = JSON.stringify({ serviceInstanceId: badId, op: "list", path: "" } satisfies SiteFilesRequest);
      const headers = signIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/sites/files",
        body: rawBody,
        key: SIGNING_KEY,
      });
      const res = await rawUnixPost({
        socketPath,
        pathWithQuery: "/v1/sites/files",
        headers: { ...headers },
        body: rawBody,
      });
      expect(res.statusCode).toBe(403);
      expect((res.json as { error: { code: string } }).error.code).toBe("HOST_POLICY_DENIED");
    }

    // Unknown serviceInstanceId -> NOT_FOUND / not_found
    await expectIpcReasonRefusal(
      () => client.siteFiles({ serviceInstanceId: "svc_unknown_999", op: "list", path: "" }),
      "not_found",
    );
  });

  it("answers NOT_SUPPORTED from Phase1DisabledDockerExecutor over IPC", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `hp-files-p1-${randomBytes(6).toString("hex")}.sock`,
    );
    const server = new DockerExecutorIpcServer({
      executor: new Phase1DisabledDockerExecutor(),
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "disabled",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    let caught: unknown;
    try {
      await client.siteFiles({ serviceInstanceId: "svc_1", op: "list", path: "" });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutorIpcClientError);
    expect((caught as ExecutorIpcClientError).code).toBe("NOT_SUPPORTED");
    expect((caught as ExecutorIpcClientError).statusCode).toBe(422);
  });
});
