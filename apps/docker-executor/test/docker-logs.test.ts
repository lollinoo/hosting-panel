import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DockerEngineSocketAdapter } from "../src/docker-engine-adapter.js";
import { LOG_READ_MAX_BYTES, demuxDockerLogStream, readCappedBody } from "../src/docker-logs.js";

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

  it("keeps what was read of a truncated trailing frame", () => {
    const whole = frame(1, "2026-01-02T03:04:05Z ok\n");
    const cut = frame(1, "2026-01-02T03:04:06Z partial\n").subarray(0, 14);
    expect(demuxDockerLogStream(Buffer.concat([whole, cut])).map((l) => l.text)).toEqual(["ok", "2026-0"]);
  });

  it("caps lines at 2000 chars and tolerates a missing timestamp", () => {
    const [line] = demuxDockerLogStream(frame(1, `${"x".repeat(3000)}\n`));
    expect(line?.at).toBeNull();
    expect(line?.text).toHaveLength(2000);
  });
});

describe("log read cap (exec.3)", () => {
  const endless = () => {
    const chunk = frame(1, `${"x".repeat(65_535)}\n`);
    return new Readable({ read() { this.push(chunk); } });
  };

  it("readCappedBody returns 2 MiB of a stream that never ends and destroys it", async () => {
    const stream = endless();
    const body = await readCappedBody(stream, LOG_READ_MAX_BYTES);
    expect(LOG_READ_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(body.length).toBe(LOG_READ_MAX_BYTES);
    expect(stream.destroyed).toBe(true);
  });

  it("drops a last frame cut inside its 8-byte header", () => {
    const whole = frame(1, "2026-01-02T03:04:05Z ok\n");
    const cut = frame(2, "2026-01-02T03:04:06Z lost\n").subarray(0, 5);
    expect(demuxDockerLogStream(Buffer.concat([whole, cut]))).toEqual([
      { at: "2026-01-02T03:04:05Z", stream: "stdout", text: "ok" },
    ]);
  });

  it("ends a payload cut inside a multi-byte character at the last whole one", () => {
    const full = frame(2, "2026-01-02T03:04:05Z café ☃\n");
    const [line, ...rest] = demuxDockerLogStream(full.subarray(0, full.length - 2));
    expect(rest).toEqual([]);
    expect(line).toEqual({ at: "2026-01-02T03:04:05Z", stream: "stderr", text: "café " });
    expect(line?.text).not.toContain("\uFFFD");
  });

  it("readContainerLogs returns from an Engine answer that never ends and closes it", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-logcap-"));
    let closed: Promise<void> = Promise.resolve();
    const server = http.createServer((_req, res) => {
      closed = new Promise((resolve) => res.on("close", resolve));
      res.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      endless().pipe(res);
    });
    const socketPath = path.join(tmp, "docker.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const adapter = new DockerEngineSocketAdapter({
        dockerSocketPath: socketPath,
        secretsRootDir: path.join(tmp, "secrets"),
        ingressRootDir: path.join(tmp, "ingress"),
      });
      const lines = await adapter.readContainerLogs("hp-site-logcap", 500);
      // 2 MiB holds 31 whole frames of 65,544 bytes and the start of a 32nd: a larger cap gives more lines.
      expect(lines).toHaveLength(32);
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
