import { isValidPathSegment } from "@/lib/bff-guard";
import {
  FILE_CHUNK_BYTES,
  MAX_CHUNK_BASE64,
  forwardSiteCall,
  isPlainObject,
  isSafeFilePath,
} from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const GET = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/content", "GET", {
    timeoutMs: 30_000,
    query: (u) => {
      const path = u.get("path") ?? "";
      if (!isSafeFilePath(path, false)) return null;

      const rawOffset = u.get("offset");
      let offset = 0;
      if (rawOffset !== null) {
        if (!/^\d+$/.test(rawOffset)) return null;
        offset = Number(rawOffset);
        if (!Number.isSafeInteger(offset)) return null;
      }

      const rawLength = u.get("length");
      let length = FILE_CHUNK_BYTES;
      if (rawLength !== null) {
        if (!/^\d+$/.test(rawLength)) return null;
        const parsed = Number(rawLength);
        if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
        length = Math.min(FILE_CHUNK_BYTES, parsed);
      }

      return `path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`;
    },
  });

export const PUT = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/content", "PUT", {
    timeoutMs: 30_000,
    body: (b) =>
      isPlainObject(b) &&
      isSafeFilePath(b.path, false) &&
      typeof b.uploadId === "string" &&
      isValidPathSegment(b.uploadId) &&
      typeof b.offset === "number" &&
      Number.isSafeInteger(b.offset) &&
      b.offset >= 0 &&
      typeof b.dataBase64 === "string" &&
      b.dataBase64.length <= MAX_CHUNK_BASE64 &&
      typeof b.final === "boolean" &&
      typeof b.overwrite === "boolean",
  });
