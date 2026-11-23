import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeMailSubject, submitLocalMail } from "../src/smtp-submit.js";

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
    expect(f.received).toContain("MAIL FROM:<n@x.it> BODY=8BITMIME");
    expect(f.received).toContain("RCPT TO:<a@b.it>");
    expect(f.received).toContain("..dot");
    expect(f.received).toContain("Subject: Hi");
  });

  it("waits for CRLF when a reply is split across chunks", async () => {
    const server = net.createServer((sock) => {
      const send = (parts: string[]) => parts.forEach((p, i) => setTimeout(() => sock.write(p), i * 20));
      send(["220 he", "llo\r\n"]);
      let data = false;
      sock.on("data", (d) => {
        for (const l of d.toString().split("\r\n")) {
          if (data) {
            if (l === ".") send(["250 2.0.0 Ok: que", "ued as 4SPLIT1\r\n"]);
          } else if (l === "DATA") {
            data = true;
            sock.write("354 go\r\n");
          } else if (l.startsWith("EHLO")) send(["250", "-x\r\n250 ok\r\n"]);
          else if (l) send(["250", " ok\r\n"]); // bare "250" before its CRLF
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    await expect(
      submitLocalMail({ ...base, port: (server.address() as net.AddressInfo).port }),
    ).resolves.toEqual({ queueId: "4SPLIT1" });
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

describe("encodeMailSubject", () => {
  const decode = (header: string) =>
    header
      .split("\r\n ")
      .map((word) => Buffer.from(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)![1]!, "base64").toString("utf8"))
      .join("");

  it("leaves a subject of printable ASCII as it is", () => {
    expect(encodeMailSubject("Reset your panel password")).toBe("Reset your panel password");
    expect(encodeMailSubject("")).toBe("");
  });

  it("writes any other subject as encoded words on short lines, whole characters only", () => {
    for (const subject of [
      "Pannello di hosting: 2 nuovi avvisi, 1 non più aperto",
      "Pannello di hosting: 12 nuovi avvisi, 34 non più aperti",
      "è".repeat(120),
      "😀".repeat(40),
      `a${"😀".repeat(30)}`,
    ]) {
      const header = encodeMailSubject(subject);
      expect(decode(header)).toBe(subject);
      const lines = `Subject: ${header}`.split("\r\n");
      for (const line of lines) {
        expect(line.length, subject).toBeLessThanOrEqual(76);
        expect(line).toMatch(/^[\x20-\x7e]+$/);
      }
      for (const line of lines.slice(1)) expect(line.startsWith(" =?UTF-8?B?")).toBe(true);
    }
  });
});
