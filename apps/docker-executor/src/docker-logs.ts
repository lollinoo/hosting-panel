export interface ServiceLogLine {
  at: string | null;
  stream: "stdout" | "stderr";
  text: string;
}

const MAX_LINE_CHARS = 2000;
const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\S+) ?/;

/** Parses Docker's multiplexed log stream (8-byte frame headers, `timestamps=1`). */
export function demuxDockerLogStream(buf: Buffer): ServiceLogLine[] {
  const lines: ServiceLogLine[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset] === 2 ? "stderr" : "stdout";
    const length = buf.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if (end > buf.length) {
      break; // truncated last frame
    }
    const payload = buf.subarray(offset + 8, end).toString("utf8");
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
