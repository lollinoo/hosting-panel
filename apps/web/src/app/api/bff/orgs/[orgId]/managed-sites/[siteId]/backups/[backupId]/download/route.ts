import {
  type BackupArchiveChunkDto,
  BackupArchiveChunkDtoSchema,
} from "@hosting-panel/contracts";
import { chunkStreamResponse, isValidChunkDto } from "@/lib/bff-chunk-stream";
import {
  FILE_CHUNK_BYTES,
  forwardSiteCall,
  isPlainObject,
} from "@/lib/bff-files";
import { validatePathSegments } from "@/lib/bff-guard";
import { getSessionFromRequest } from "@/lib/server-session";
import { fetchUpstream } from "@/lib/upstream";

type BackupCtx = {
  params: Promise<{ orgId: string; siteId: string; backupId: string }>;
};

const BACKUP_MUTATION_TIMEOUT_MS = 20_000;
const BACKUP_DOWNLOAD_CHUNK_TIMEOUT_MS = 40_000;
const FALLBACK_ARCHIVE_NAME = "backup.zip";

function isDownloadPrepareBody(body: unknown): boolean {
  return body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
}

function redirect303(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

/**
 * Start preparing a single-zip backup archive upstream.
 *
 * Purpose: enforce segment validation, CSRF/Origin checks, empty/`{}` body
 * check, and idempotency before forwarding to upstream.
 */
export async function POST(req: Request, context: BackupCtx): Promise<Response> {
  const params = await context.params;
  const backupId = params.backupId ?? "";
  return forwardSiteCall(
    req,
    { params: Promise.resolve({ ...params, backupId }) },
    `backups/${backupId}/download`,
    "POST",
    {
      timeoutMs: BACKUP_MUTATION_TIMEOUT_MS,
      idempotency: true,
      body: isDownloadPrepareBody,
    },
  );
}

/**
 * Stream a prepared backup zip archive in 512 KiB chunks without buffering.
 *
 * Purpose: validate route segments, read chunk 0 before emitting headers, turn
 * pre-first-byte errors into relative `303` redirects back to login or the
 * site's Backups tab, and pull subsequent chunks at a 40s per-chunk limit.
 */
export async function GET(req: Request, context: BackupCtx): Promise<Response> {
  const params = await context.params;
  const orgId = params.orgId ?? "";
  const siteId = params.siteId ?? "";
  const backupId = params.backupId ?? "";

  const segmentError = validatePathSegments({ orgId, siteId, backupId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (!session) {
    return redirect303("/login");
  }

  // Build relative redirect targets only from already-validated `siteId` (R83).
  const goneLocation = `/sites/${siteId}/backups?download=gone`;
  const failedLocation = `/sites/${siteId}/backups?download=failed`;

  const chunkBase = `v1/organizations/${orgId}/managed-sites/${siteId}/backups/${backupId}/download`;
  const readChunk = (offset: number) =>
    fetchUpstream<{ data: BackupArchiveChunkDto }>(
      `${chunkBase}?offset=${offset}&length=${FILE_CHUNK_BYTES}`,
      {
        method: "GET",
        accessToken: session.accessToken,
        timeoutMs: BACKUP_DOWNLOAD_CHUNK_TIMEOUT_MS,
      },
    );

  let first: Awaited<ReturnType<typeof readChunk>>;
  try {
    first = await readChunk(0);
  } catch {
    return redirect303(failedLocation);
  }

  if (!first.ok) {
    if (first.status === 401) {
      return redirect303("/login");
    }
    if (first.status === 404) {
      return redirect303(goneLocation);
    }
    return redirect303(failedLocation);
  }

  const firstChunk = first.data?.data;
  if (!isValidChunkDto(firstChunk)) {
    return redirect303(failedLocation);
  }

  const parsedFileName = BackupArchiveChunkDtoSchema.shape.fileName.safeParse(
    (firstChunk as { fileName?: unknown }).fileName,
  );
  const fileName = parsedFileName.success ? parsedFileName.data : FALLBACK_ARCHIVE_NAME;

  return chunkStreamResponse({
    readChunk,
    first: firstChunk,
    fileName,
    contentType: "application/zip",
  });
}
