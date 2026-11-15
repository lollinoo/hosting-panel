import { attachmentDisposition } from "@/lib/bff-files";
import type { UpstreamResponse } from "@/lib/upstream";

export interface StreamChunk {
  dataBase64: string;
  size: number;
  eof: boolean;
}

export interface ChunkStreamOptions<T extends StreamChunk = StreamChunk> {
  readChunk: (offset: number) => Promise<UpstreamResponse<{ data: T }>>;
  first: T;
  fileName: string;
  contentType: string;
}

/**
 * Validates the common fields of a chunked-download payload returned by upstream.
 */
export function isValidChunkDto(chunk: unknown): chunk is StreamChunk {
  if (typeof chunk !== "object" || chunk === null) return false;
  const c = chunk as Record<string, unknown>;
  return (
    typeof c.dataBase64 === "string" &&
    typeof c.size === "number" &&
    Number.isInteger(c.size) &&
    c.size >= 0 &&
    typeof c.eof === "boolean"
  );
}

/**
 * Wraps chunked upstream reads into a hardened download Response once chunk 0
 * has been fetched.
 *
 * Purpose: stream arbitrary-size site files and backup archives without
 * buffering the whole payload in memory or prefetching ahead of the client.
 * Inputs: chunk 0 (`first`), subsequent-chunk fetcher (`readChunk`), sanitized
 * download `fileName`, and HTTP `contentType`.
 * Outputs: streaming HTTP 200 Response with hardened download headers.
 * Side effects: errors the stream if upstream fails, size changes, or byte
 * offsets mismatch; stops pulling further chunks once cancelled.
 */
export function chunkStreamResponse<T extends StreamChunk>(
  opts: ChunkStreamOptions<T>,
): Response {
  const totalSize = opts.first.size;
  let pending: T | null = opts.first;
  let offset = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;

        let chunk: T;
        if (pending) {
          chunk = pending;
          pending = null;
        } else {
          let next: UpstreamResponse<{ data: T }>;
          try {
            next = await opts.readChunk(offset);
          } catch (err) {
            if (!cancelled) controller.error(err);
            return;
          }
          if (cancelled) return;
          if (!next.ok) {
            controller.error(new Error("Upstream chunk fetch failed"));
            return;
          }
          const nextChunk = next.data?.data;
          if (!isValidChunkDto(nextChunk)) {
            controller.error(new Error("Invalid chunk payload"));
            return;
          }
          chunk = nextChunk;
        }

        if (chunk.size !== totalSize) {
          controller.error(new Error("File size changed during download"));
          return;
        }

        const bytes = Buffer.from(chunk.dataBase64, "base64");
        if (bytes.byteLength === 0 && !chunk.eof) {
          controller.error(new Error("Empty chunk before end of file"));
          return;
        }
        if (offset + bytes.byteLength > totalSize) {
          controller.error(new Error("File chunk exceeded expected size"));
          return;
        }

        offset += bytes.byteLength;
        if (bytes.byteLength > 0) {
          controller.enqueue(new Uint8Array(bytes));
        }

        if (chunk.eof) {
          if (offset !== totalSize) {
            controller.error(new Error("Unexpected end of file before expected size"));
            return;
          }
          controller.close();
          return;
        }

        if (offset === totalSize) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    // Keep highWaterMark at 0 so the next chunk is only fetched when the reader pulls.
    { highWaterMark: 0 },
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": opts.contentType,
      "Content-Disposition": attachmentDisposition(opts.fileName),
      "Content-Length": String(totalSize),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
