import net from "node:net";
import { ExecutorCodedError } from "./traefik-config.js";

export interface SubmitLocalMailOptions {
  readonly host: string;
  readonly port: number;
  readonly heloName: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly timeoutMs: number;
}

const unavailable = (why: string) => new ExecutorCodedError(why, "MAIL_RELAY_UNAVAILABLE");

/** Minimal plain SMTP client for the relay's own bridge address: no TLS, no AUTH. */
export async function submitLocalMail(opts: SubmitLocalMailOptions): Promise<{ queueId: string }> {
  if (/[\r\n<>]/.test(opts.from) || /[\r\n<>]/.test(opts.to) || /[\r\n]/.test(opts.subject)) {
    throw new ExecutorCodedError("Invalid mail address or subject", "VALIDATION_ERROR");
  }
  const subject = /^[\x20-\x7e]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`;
  const body = opts.text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  const message =
    [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ].join("\r\n") + "\r\n.\r\n";

  const socket = net.connect({ host: opts.host, port: opts.port });
  let buffer = "";
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const fail = (err: Error) => {
    failure ??= err;
    wake?.();
  };
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buffer += d;
    wake?.();
  });
  socket.on("error", (err) => fail(unavailable(`SMTP connection failed: ${err.message}`)));
  socket.on("close", () => fail(unavailable("SMTP connection closed")));
  const timer = setTimeout(() => fail(unavailable("SMTP submission timed out")), opts.timeoutMs);

  // Resolves with the complete (possibly multi-line) reply: the last line is "NNN text" or "NNN".
  const reply = async (): Promise<{ code: number; text: string }> => {
    for (;;) {
      // The last element is an unterminated fragment: only CRLF-complete lines count.
      const lines = buffer.split("\r\n").slice(0, -1);
      const doneAt = lines.findIndex((l) => /^\d{3}( |$)/.test(l));
      if (doneAt >= 0) {
        buffer = buffer.split("\r\n").slice(doneAt + 1).join("\r\n");
        const text = lines.slice(0, doneAt + 1).join("\n");
        return { code: Number(lines[doneAt]!.slice(0, 3)), text };
      }
      if (failure) {
        throw failure;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  };
  const step = async (command: string | null, expected: (code: number) => boolean) => {
    if (command !== null) {
      socket.write(`${command}\r\n`);
    }
    const r = await reply();
    if (!expected(r.code)) {
      throw unavailable(`SMTP server answered ${String(r.code)}`);
    }
    return r;
  };
  const ok = (c: number) => c >= 200 && c < 300;

  try {
    await step(null, ok);
    await step(`EHLO ${opts.heloName}`, ok);
    await step(`MAIL FROM:<${opts.from}> BODY=8BITMIME`, ok);
    await step(`RCPT TO:<${opts.to}>`, ok);
    await step("DATA", (c) => c === 354);
    socket.write(message);
    const done = await reply();
    if (!ok(done.code)) {
      throw unavailable(`SMTP server answered ${String(done.code)}`);
    }
    const queueId = /queued as ([0-9A-Za-z]+)/.exec(done.text)?.[1];
    if (!queueId) {
      throw unavailable("SMTP server gave no queue id");
    }
    socket.write("QUIT\r\n");
    return { queueId };
  } catch (err) {
    throw err instanceof ExecutorCodedError ? err : unavailable("SMTP submission failed");
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
