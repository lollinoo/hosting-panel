import type { SiteFileChunkDto } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { chunkStreamResponse, isValidChunkDto } from "@/lib/bff-chunk-stream";
import { bffErrorResponse, bffJsonResponse } from "@/lib/bff-response";
import { getSessionFromRequest } from "@/lib/server-session";
import { fetchUpstream } from "@/lib/upstream";
import {
  FILE_CHUNK_BYTES,
  isSafeFilePath,
} from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

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

  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  return chunkStreamResponse({
    readChunk,
    first: firstChunk,
    fileName: basename,
    contentType: "application/octet-stream",
  });
}
