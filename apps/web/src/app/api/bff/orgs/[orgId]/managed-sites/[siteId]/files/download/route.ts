import type { SiteFileChunkDto } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { bffErrorResponse, bffJsonResponse } from "@/lib/bff-response";
import { getSessionFromRequest } from "@/lib/server-session";
import { fetchUpstream } from "@/lib/upstream";
import {
  FILE_CHUNK_BYTES,
  attachmentDisposition,
  isSafeFilePath,
} from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

function isValidChunkDto(chunk: unknown): chunk is SiteFileChunkDto {
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

export async function GET(req: Request, context: Ctx): Promise<Response> {
  const { orgId, siteId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (!session) {
    return bffErrorResponse("UNAUTHENTICATED", "Sessione non autenticata o scaduta", 401);
  }

  let filePath: string;
  try {
    filePath = new URL(req.url).searchParams.get("path") ?? "";
  } catch {
    return bffErrorResponse("VALIDATION_ERROR", "URL della richiesta non valido", 400);
  }

  if (!isSafeFilePath(filePath, false)) {
    return bffErrorResponse("VALIDATION_ERROR", "Percorso del file non valido", 400);
  }

  const contentBase = `v1/organizations/${orgId}/managed-sites/${siteId}/files/content?path=${encodeURIComponent(filePath)}`;
  const readChunk = (offset: number) =>
    fetchUpstream<{ data: SiteFileChunkDto }>(
      `${contentBase}&offset=${offset}&length=${FILE_CHUNK_BYTES}`,
      {
        method: "GET",
        accessToken: session.accessToken,
        timeoutMs: 30_000,
      },
    );

  // Fetch chunk 0 before writing response headers so errors still return JSON with the upstream status.
  const first = await readChunk(0);
  if (!first.ok) {
    return bffJsonResponse(first.error, { status: first.status });
  }

  const firstChunk = first.data?.data;
  if (!isValidChunkDto(firstChunk)) {
    return bffErrorResponse("INTERNAL_ERROR", "Risposta del server non valida", 502);
  }

  const totalSize = firstChunk.size;
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  let pending: SiteFileChunkDto | null = firstChunk;
  let offset = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;

        let chunk: SiteFileChunkDto;
        if (pending) {
          chunk = pending;
          pending = null;
        } else {
          let next: Awaited<ReturnType<typeof readChunk>>;
          try {
            next = await readChunk(offset);
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
    { highWaterMark: 0 },
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentDisposition(basename),
      "Content-Length": String(totalSize),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
