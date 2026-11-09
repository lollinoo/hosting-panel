import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { submitLocalMail } from "../src/smtp-submit.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function fake(greeting: string | null, onData?: (received: string[]) => void) {
  const received: string[] = [];
  let connections = 0;
  const server = net.createServer((sock) => {
    connections += 1;
    if (greeting) sock.write(greeting);
    let data = false;
    sock.on("data", (d) => {
      for (const l of d.toString().split("\r\n")) {
        if (data) {
          received.push(l);
          if (l === ".") {
            data = false;
            sock.write("250 2.0.0 Ok: queued as 4ABC123\r\n");
          }
        } else if (l === "DATA") {
          data = true;
          sock.write("354 go\r\n");
        } else if (l.startsWith("EHLO")) {
          sock.write("250-hp-mail\r\n250 8BITMIME\r\n"); // multi-line
        } else if (l) {
          received.push(l);
          sock.write("250 ok\r\n");
        }
      }
      onData?.(received);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, received, connections: () => connections };
}
const base = { host: "127.0.0.1", heloName: "panel", from: "n@x.it", to: "a@b.it", subject: "Hi", text: "one\n.dot\nend", timeoutMs: 1000 };

describe("submitLocalMail", () => {
  it("speaks SMTP and returns the queue id", async () => {
    const f = await fake("220 hp-mail ESMTP\r\n");
    await expect(submitLocalMail({ ...base, port: f.port })).resolves.toEqual({ queueId: "4ABC123" });
    expect(f.received).toContain("MAIL FROM:<n@x.it>");
    expect(f.received).toContain("RCPT TO:<a@b.it>");
    expect(f.received).toContain("..dot");
    expect(f.received).toContain("Subject: Hi");
  });

  it("refuses CR or LF in an address", async () => {
    const f = await fake("220 hi\r\n");
    for (const bad of [{ to: "a@b.it\r\nRCPT TO:<x@y>" }, { from: "a\n@b.it" }, { to: "<a@b.it>" }, { subject: "a\nBcc: x" }]) {
      await expect(submitLocalMail({ ...base, ...bad, port: f.port })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(f.connections()).toBe(0);
  });

  it("fails cleanly on a 421 greeting or a timeout", async () => {
    const down = await fake("421 busy\r\n");
    await expect(submitLocalMail({ ...base, port: down.port })).rejects.toMatchObject({ code: "MAIL_RELAY_UNAVAILABLE" });
    const silent = await fake(null);
    await expect(submitLocalMail({ ...base, port: silent.port, timeoutMs: 100 })).rejects.toMatchObject({ code: "MAIL_RELAY_UNAVAILABLE" });
  });
});
