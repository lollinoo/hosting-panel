import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ServiceLogLine } from "@hosting-panel/executor-contracts";

/** Most of a container log body the executor holds for one read (R207 exec.3). */
export const LOG_READ_MAX_BYTES = 2 * 1024 * 1024;

/** Reads a stream to its end, or keeps its first `max` bytes and destroys it. */
export function readCappedBody(stream: Readable, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      total += buf.length;
      if (total >= max) {
        stream.destroy();
        resolve(Buffer.concat(chunks).subarray(0, max));
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const MAX_LINE_CHARS = 2000;
const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\S+) ?/;

/** Parses Docker's multiplexed log stream (8-byte frame headers, `timestamps=1`). */
export function demuxDockerLogStream(buf: Buffer): ServiceLogLine[] {
  const lines: ServiceLogLine[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset] === 2 ? "stderr" : "stdout";
    // A last frame cut by the read cap keeps what was read; the decoder holds back a character the cut split.
    const end = Math.min(buf.length, offset + 8 + buf.readUInt32BE(offset + 4));
    const payload = new StringDecoder("utf8").write(buf.subarray(offset + 8, end));
    offset = end;
    for (const raw of payload.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        continue;
      }
      const match = TIMESTAMP_PREFIX.exec(line);
      const parsed = match?.[1] ? new Date(match[1]) : null;
      const at = parsed && !Number.isNaN(parsed.getTime()) ? match![1]! : null;
      lines.push({
        at,
        stream,
        text: (at ? line.slice(match![0].length) : line).slice(0, MAX_LINE_CHARS),
      });
    }
  }
  return lines;
}

/** Joins the stdout frames of a log body; null once they pass `ceiling` bytes (the rest is never copied). */
export function readJobStdout(body: Buffer, ceiling: number): string | null {
  const parts: Buffer[] = [];
  let total = 0;
  for (let offset = 0; offset + 8 <= body.length; ) {
    const end = Math.min(body.length, offset + 8 + body.readUInt32BE(offset + 4));
    if (body[offset] === 1) {
      total += end - offset - 8;
      if (total > ceiling) {
        return null;
      }
      parts.push(body.subarray(offset + 8, end));
    }
    offset = end;
  }
  return Buffer.concat(parts, total).toString("utf8");
}

/** phpMyAdmin access lines carry the CSRF token and SQL in the query string (D11); Apache's `\"` stays inside it. */
export const PHPMYADMIN_QUERY_PATTERN = /\?(?:\\.|[^\s"\\])*/g;

/** Masks every query string of a phpMyAdmin log line. */
export function maskPhpMyAdminQuery(text: string): string {
  return text.replace(PHPMYADMIN_QUERY_PATTERN, "?[masked]");
}
