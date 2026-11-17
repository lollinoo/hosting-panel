import { describe, expect, it, vi } from "vitest";
import { chunkStreamResponse, isValidChunkDto } from "@/lib/bff-chunk-stream";

function chunkOf(bytes: Uint8Array, totalSize: number, eof: boolean) {
  return {
    dataBase64: Buffer.from(bytes).toString("base64"),
    size: totalSize,
    eof,
  };
}

async function readAllBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

describe("bff-chunk-stream", () => {
  it("validates chunk DTO shape", () => {
    expect(isValidChunkDto({ dataBase64: "", size: 0, eof: true })).toBe(true);
    expect(isValidChunkDto({ dataBase64: "YQ==", size: 1, eof: true, fileName: "a.zip" })).toBe(true);
    expect(isValidChunkDto(null)).toBe(false);
    expect(isValidChunkDto({ dataBase64: "YQ==", size: -1, eof: true })).toBe(false);
    expect(isValidChunkDto({ dataBase64: "YQ==", size: 1.5, eof: true })).toBe(false);
    expect(isValidChunkDto({ dataBase64: "YQ==", size: 1, eof: "yes" })).toBe(false);
  });

  it("sets hardened download headers from options", async () => {
    const b0 = new Uint8Array([1, 2, 3]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(),
      first: chunkOf(b0, 3, true),
      fileName: 'site "backup".zip',
      contentType: "application/zip",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="site _backup_.zip"; filename*=UTF-8''site%20%22backup%22.zip`,
    );
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");

    const received = await readAllBytes(res.body!);
    expect(Array.from(received)).toEqual([1, 2, 3]);
  });

  it("streams three chunks unchanged in order and is pull-based", async () => {
    const c0 = new Uint8Array([10, 11, 12, 13]);
    const c1 = new Uint8Array([20, 21, 22]);
    const c2 = new Uint8Array([30, 31]);
    const total = c0.length + c1.length + c2.length;

    const offsets: number[] = [];
    const readChunk = vi.fn(async (offset: number) => {
      offsets.push(offset);
      if (offset === c0.length) {
        return { ok: true, status: 200, data: { data: chunkOf(c1, total, false) } };
      }
      if (offset === c0.length + c1.length) {
        return { ok: true, status: 200, data: { data: chunkOf(c2, total, true) } };
      }
      throw new Error(`Unexpected offset ${offset}`);
    });

    const res = chunkStreamResponse({
      readChunk,
      first: chunkOf(c0, total, false),
      fileName: "site-backup.zip",
      contentType: "application/zip",
    });

    // Before the reader reads chunk 0 or chunk 1, the second chunk must not be requested (highWaterMark: 0).
    await Promise.resolve();
    expect(readChunk).toHaveBeenCalledTimes(0);

    const reader = res.body!.getReader();
    const r0 = await reader.read();
    expect(r0.done).toBe(false);
    expect(Array.from(r0.value!)).toEqual(Array.from(c0));

    // After reading chunk 0, chunk 1 is still not fetched before the reader asks for it.
    await Promise.resolve();
    expect(readChunk).toHaveBeenCalledTimes(0);

    const r1 = await reader.read();
    expect(r1.done).toBe(false);
    expect(Array.from(r1.value!)).toEqual(Array.from(c1));
    expect(readChunk).toHaveBeenCalledTimes(1);

    // After reading chunk 1, chunk 2 is not fetched before the reader asks for it.
    await Promise.resolve();
    expect(readChunk).toHaveBeenCalledTimes(1);

    const r2 = await reader.read();
    expect(r2.done).toBe(false);
    expect(Array.from(r2.value!)).toEqual(Array.from(c2));

    const rEnd = await reader.read();
    expect(rEnd.done).toBe(true);
    expect(offsets).toEqual([4, 7]);
  });

  it("handles a zero-byte file with immediate eof cleanly", async () => {
    const readChunk = vi.fn();
    const res = chunkStreamResponse({
      readChunk,
      first: chunkOf(new Uint8Array(0), 0, true),
      fileName: "empty.zip",
      contentType: "application/zip",
    });

    const received = await readAllBytes(res.body!);
    expect(received.byteLength).toBe(0);
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("errors the stream on upstream failure during subsequent chunk", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(async () => ({
        ok: false,
        status: 502,
        error: { error: { code: "INTERNAL_ERROR", message: "Upstream error" } },
      })),
      first: chunkOf(c0, 8, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    await expect(readAllBytes(res.body!)).rejects.toThrow();
  });

  it("errors the stream when declared total size changes mid-stream", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const c1 = new Uint8Array([5, 6, 7, 8]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { data: chunkOf(c1, 9, true) },
      })),
      first: chunkOf(c0, 8, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    await expect(readAllBytes(res.body!)).rejects.toThrow();
  });

  it("errors the stream on an empty non-EOF chunk", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { data: chunkOf(new Uint8Array(0), 8, false) },
      })),
      first: chunkOf(c0, 8, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    await expect(readAllBytes(res.body!)).rejects.toThrow();
  });

  it("errors the stream on byte overrun past declared size", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const c1 = new Uint8Array([5, 6, 7, 8, 9]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { data: chunkOf(c1, 8, true) },
      })),
      first: chunkOf(c0, 8, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    await expect(readAllBytes(res.body!)).rejects.toThrow();
  });

  it("errors the stream on short EOF before declared size is reached", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const c1 = new Uint8Array([5, 6]);
    const res = chunkStreamResponse({
      readChunk: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { data: chunkOf(c1, 8, true) },
      })),
      first: chunkOf(c0, 8, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    await expect(readAllBytes(res.body!)).rejects.toThrow();
  });

  it("stops fetching subsequent chunks when stream is cancelled", async () => {
    const c0 = new Uint8Array([1, 2, 3, 4]);
    type ChunkResult = { ok: true; status: number; data: { data: ReturnType<typeof chunkOf> } };
    const inFlightResolver: { current: ((v: ChunkResult) => void) | null } = { current: null };
    const readChunk = vi.fn(
      () =>
        new Promise<ChunkResult>((resolve) => {
          inFlightResolver.current = resolve;
        }),
    );
    const res = chunkStreamResponse({
      readChunk,
      first: chunkOf(c0, 10, false),
      fileName: "backup.zip",
      contentType: "application/zip",
    });

    const reader = res.body!.getReader();
    const r0 = await reader.read();
    expect(r0.done).toBe(false);
    expect(readChunk).toHaveBeenCalledTimes(0);

    const pendingRead = reader.read();
    await Promise.resolve();
    expect(readChunk).toHaveBeenCalledTimes(1);

    await reader.cancel("aborted");
    inFlightResolver.current?.({
      ok: true,
      status: 200,
      data: { data: chunkOf(new Uint8Array([5, 6]), 10, false) },
    });
    await pendingRead;

    await Promise.resolve();
    expect(readChunk).toHaveBeenCalledTimes(1);
  });
});
