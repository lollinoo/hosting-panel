import { describe, expect, it } from "vitest";
import { demuxDockerLogStream } from "../src/docker-logs.js";

function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("demuxDockerLogStream", () => {
  it("splits stdout and stderr frames", () => {
    const out = demuxDockerLogStream(
      Buffer.concat([
        frame(1, "2026-01-02T03:04:05.5Z ready\n"),
        frame(2, "2026-01-02T03:04:06Z boom\n"),
      ]),
    );
    expect(out).toEqual([
      { at: "2026-01-02T03:04:05.5Z", stream: "stdout", text: "ready" },
      { at: "2026-01-02T03:04:06Z", stream: "stderr", text: "boom" },
    ]);
  });

  it("ignores a truncated trailing frame", () => {
    const whole = frame(1, "2026-01-02T03:04:05Z ok\n");
    const cut = frame(1, "2026-01-02T03:04:06Z partial\n").subarray(0, 14);
    expect(demuxDockerLogStream(Buffer.concat([whole, cut]))).toHaveLength(1);
  });

  it("caps lines at 2000 chars and tolerates a missing timestamp", () => {
    const [line] = demuxDockerLogStream(frame(1, `${"x".repeat(3000)}\n`));
    expect(line?.at).toBeNull();
    expect(line?.text).toHaveLength(2000);
  });
});
