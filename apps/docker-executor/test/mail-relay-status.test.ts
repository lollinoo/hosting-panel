import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerEngineSocketAdapter } from "../src/index.js";
import {
  parsePostfixDeliveries,
  summarizeMailDeliveries,
} from "../src/mail-relay-status.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) {
    await task();
  }
});

const smtp = (at: string, id: string, rest: string) => ({
  at,
  stream: "stdout" as const,
  text: `Nov  9 10:00:00 hp-mail postfix/smtp[123]: ${id}: to=<${rest}`,
});
const T = "2026-11-09T10:00:00.123456789Z";

describe("parsePostfixDeliveries", () => {
  it("classifies auth, connect, TLS and bounce lines", () => {
    const lines = [
      smtp(T, "4ABC1234", "guest@example.org>, relay=smtp.example.com[203.0.113.5]:587, delay=1.2, delays=0.1/0/0.6/0.5, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as XYZ)"),
      smtp(T, "4ABC1235", "a@b.it>, relay=none, delay=30, delays=0.1/0/30/0, dsn=4.4.1, status=deferred (connect to smtp.example.com[203.0.113.5]:587: Connection timed out)"),
      smtp(T, "4ABC1236", "a@b.it>, relay=smtp.example.com[203.0.113.5]:587, delay=1, delays=0/0/1/0, dsn=4.7.0, status=deferred (SASL authentication failed; server smtp.example.com[203.0.113.5] said: 535 5.7.8 Error: authentication failed)"),
      smtp(T, "4ABC1237", "a@b.it>, relay=smtp.example.com[203.0.113.5]:587, delay=1, delays=0/0/1/0, dsn=5.1.1, status=bounced (host smtp.example.com[203.0.113.5] said: 550 5.1.1 <a@b.it>: Recipient address rejected (in reply to RCPT TO command))"),
      smtp(T, "4ABC1238", "a@b.it>, relay=none, delay=1, delays=0/0/1/0, dsn=4.7.5, status=deferred (Server certificate not verified)"),
      {
        at: T,
        stream: "stdout" as const,
        text: "postfix/error[90]: 4ABC1239: to=<a@b.it>, relay=none, delay=60, delays=0/0/0/60, dsn=4.3.0, status=deferred (delivery temporarily suspended: unknown mail transport error)",
      },
      smtp(T, "4ABC1240", "a@b.it>, relay=none, delay=60, delays=0/0/0/60, dsn=4.3.0, status=deferred (delivery temporarily suspended: connect to smtp.x:587: Connection refused)"),
      { at: T, stream: "stdout" as const, text: "postfix/qmgr[90]: 4ABC1234: from=<noreply@x.it>, size=500, nrcpt=1 (queue active)" },
      { at: null, stream: "stdout" as const, text: smtp(T, "4ABC9999", "a@b.it>, relay=none, dsn=4.0.0, status=deferred (x)").text },
    ];
    expect(parsePostfixDeliveries(lines).map((d) => [d.queueId, d.status, d.problem])).toEqual([
      ["4ABC1234", "sent", null],
      ["4ABC1235", "deferred", "unreachable"],
      ["4ABC1236", "deferred", "auth_failed"],
      ["4ABC1237", "bounced", "rejected"],
      ["4ABC1238", "deferred", "tls_failed"],
      ["4ABC1239", "deferred", "credentials_missing"],
      ["4ABC1240", "deferred", "unreachable"],
    ]);
  });

  it("classifies the real Postfix 3.11.7 lines from the container harness (Task 9)", () => {
    const real = (text: string) => ({ at: T, stream: "stdout" as const, text: `2026-11-09T20:54:28.776150+00:00 INFO    ${text}` });
    const r = parsePostfixDeliveries([
      real("postfix/smtp[518]: 9238D4939C: to=<a@b.it>, relay=mail.provider.test[10.231.0.252]:587, delay=7.2, delays=3/0.06/4.1/0, tls=secure, dsn=4.3.0, status=deferred (local data error while talking to mail.provider.test[10.231.0.252])"),
      real("postfix/error[511]: CACE5E17D6: to=<a@b.it>, relay=none, delay=0.06, delays=0.05/0.01/0/0, dsn=4.3.0, status=deferred (delivery temporarily suspended: local data error while talking to mail.provider.test[10.231.0.252])"),
      real("postfix/smtp[550]: EDF5AE101D: to=<a@b.it>, relay=mail.provider.test[10.231.0.252]:587, delay=4.2, delays=0.01/0.09/4.1/0, tls=secure, dsn=4.7.8, status=deferred (SASL authentication failed; server mail.provider.test[10.231.0.252] said: 535 5.7.8 Authentication credentials invalid)"),
      real("postfix/smtp[441]: 3C40BE1700: to=<a@b.it>, relay=plain.provider.test[10.231.0.253]:587, delay=2.6, delays=0.01/0.08/2.5/0, tls=!secure, dsn=4.7.4, status=deferred (TLS is required, but was not offered by host plain.provider.test[10.231.0.253])"),
      real("postfix/smtp[447]: C160E6925A: to=<a@b.it>, relay=mail.provider.test[10.231.0.252]:587, delay=0.08, delays=0.01/0.02/0.04/0, tls=!secure, dsn=4.7.5, status=deferred (Server certificate not verified)"),
      real("postfix/smtp[447]: 855FC69260: to=<a@b.it>, relay=none, delay=30, delays=0.01/0/30/0, tls=secure?, dsn=4.4.1, status=deferred (connect to mail.provider.test[10.231.0.252]:587: Operation timed out)"),
      real("postfix/smtp[536]: BDC87E1705: to=<a@b.it>, relay=none, delay=0.11, delays=0.01/0.06/0.04/0, tls=secure?, dsn=4.4.1, status=deferred (connect to mail.provider.test[10.231.0.252]:587: Connection refused)"),
      real("postfix/error[607]: D4157E1810: to=<a@b.it>, relay=none, delay=0.07, delays=0.06/0.01/0/0, dsn=4.4.1, status=deferred (delivery temporarily suspended: connect to mail.provider.test[10.231.0.252]:587: Operation timed out)"),
      real("postfix/smtp[393]: 43A76E1708: to=<a@b.it>, relay=none, delay=37, delays=37/0.03/0.03/0, dsn=4.3.5, status=deferred (Host or domain name not found. Name service error for name=plain.provider.test type=A: Host not found)"),
      real("postfix/smtp[445]: 9238D4939C: to=<a@b.it>, relay=none, delay=87, delays=87/0.13/0.07/0, dsn=4.3.5, status=deferred (unable to look up host mail.provider.test: Name does not resolve)"),
      real("postfix/smtp[550]: EDF5AE101E: to=<a@b.it>, relay=mail.provider.test[10.231.0.252]:587, delay=4.2, delays=0.01/0.09/4.1/0, tls=secure, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as 7IY3FsnnGmHtgcuIwpjEe7)"),
    ]);
    expect(r.map((d) => d.problem)).toEqual([
      "credentials_missing",
      "credentials_missing",
      "auth_failed",
      "tls_failed",
      "tls_failed",
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      null,
    ]);
  });

  it("classifies a suspended nexthop by the reason that follows, qmgr included", () => {
    const q = (id: string, reason: string) => ({
      at: T,
      stream: "stdout" as const,
      text: `postfix/qmgr[90]: ${id}: to=<a@b.it>, relay=none, delay=60, delays=0/0/0/60, dsn=4.3.0, status=deferred (delivery temporarily suspended: ${reason})`,
    });
    const r = parsePostfixDeliveries([
      q("Q1", "connect to smtp.x:587: Connection refused"),
      q("Q2", "lost connection with smtp.x[1.2.3.4] while receiving the initial server greeting"),
      q("Q3", "something unforeseen"),
      q("Q4", "host mx.tlsmail.it refused to talk to me"),
    ]);
    expect(r.map((d) => d.problem)).toEqual(["unreachable", "unreachable", "other", "other"]);
  });

  it("a deferred message shows once with its latest reason, per recipient", () => {
    const d = parsePostfixDeliveries([
      smtp("2026-11-09T10:00:00Z", "Q1", "a@b.it>, relay=none, dsn=4.4.1, status=deferred (connect to h:587: Connection timed out)"),
      smtp("2026-11-09T10:05:00Z", "Q1", "a@b.it>, relay=h, dsn=4.7.0, status=deferred (SASL authentication failed)"),
      smtp("2026-11-09T10:05:00Z", "Q1", "c@d.it>, relay=h, dsn=4.7.0, status=deferred (SASL authentication failed)"),
    ]);
    const s = summarizeMailDeliveries(d, 0);
    expect(s.failures.map((f) => [f.recipient, f.problem])).toEqual([
      ["a@b.it", "auth_failed"],
      ["c@d.it", "auth_failed"],
    ]);
  });

  it("failures are newest first and capped at 50", () => {
    const d = parsePostfixDeliveries(
      Array.from({ length: 60 }, (_, i) =>
        smtp(new Date(Date.UTC(2026, 10, 9, 10, i)).toISOString(), `Q${String(i)}`, "a@b.it>, relay=none, dsn=4.0.0, status=deferred (x)"),
      ),
    );
    const s = summarizeMailDeliveries(d, 0);
    expect(s.failures).toHaveLength(50);
    expect(s.failures[0]!.at).toBe("2026-11-09T10:59:00.000Z");
  });
});

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function setup(logs: () => string) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-mail-status-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const daemon = await startMockDockerDaemon({ logsBodyFn: () => frame(logs()) });
  cleanup.push(() => daemon.close());
  const secretDir = path.join(tmp, "mail-relay");
  await mkdir(secretDir);
  // Fake relay: accepts one message and answers with a fixed queue id.
  const server = net.createServer((sock) => {
    sock.write("220 hp-mail ESMTP\r\n");
    let inData = false;
    sock.on("data", (d) => {
      for (const l of d.toString().split("\r\n")) {
        if (inData) {
          if (l === ".") {
            inData = false;
            sock.write("250 2.0.0 Ok: queued as 4TESTQ1\r\n");
          }
        } else if (l === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (l) {
          sock.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => server.close(() => r(undefined))));
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: daemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    pullMissingImages: false,
    mailRelaySecretDir: secretDir,
    mailRelayFlushWaitMs: 50,
    mailTestPollMs: 20,
    mailTestWaitMs: 200,
    mailSubmitPort: (server.address() as net.AddressInfo).port,
  });
  return { adapter, daemon };
}

const relayReq = {
  host: "smtp.provider.example",
  port: 587 as const,
  username: "u",
  password: "p",
  senderDomain: "mail.hostingco.it",
};

describe("mail relay status and test email", () => {
  it("status reports an absent relay without failing", async () => {
    const { adapter } = await setup(() => "");
    await expect(adapter.getMailRelayStatus({ since: "2026-11-08T00:00:00Z" })).resolves.toEqual({
      present: false,
      running: false,
      sentCount: 0,
      failures: [],
    });
  });

  it("status summarizes the log", async () => {
    const { adapter } = await setup(
      () =>
        `${T} postfix/smtp[1]: Q1: to=<a@b.it>, relay=h, dsn=2.0.0, status=sent (250 Ok)\n` +
        `${T} postfix/smtp[1]: Q2: to=<a@b.it>, relay=none, dsn=4.4.1, status=deferred (connect to h:587: Connection refused)\n`,
    );
    await adapter.applyMailRelay(relayReq);
    const s = await adapter.getMailRelayStatus({ since: "2026-11-09T00:00:00Z" });
    expect(s).toMatchObject({ present: true, running: true, sentCount: 1 });
    expect(s.failures).toMatchObject([{ recipient: "a@b.it", problem: "unreachable" }]);
  });

  it("sendTestMail returns the classified outcome", async () => {
    const { adapter, daemon } = await setup(
      () =>
        `${new Date().toISOString()} postfix/smtp[1]: 4TESTQ1: to=<a@b.it>, relay=h, dsn=4.7.0, status=deferred (SASL authentication failed)\n`,
    );
    await adapter.applyMailRelay(relayReq);
    [...daemon.containers.values()][0]!.networks["hp_mail_net"] = { IPAddress: "127.0.0.1" };
    await expect(adapter.sendTestMail({ to: "a@b.it", from: "noreply@mail.hostingco.it" })).resolves.toEqual({
      outcome: "deferred",
      problem: "auth_failed",
      detail: "SASL authentication failed",
    });
  });

  it("sendTestMail reports pending when no delivery line arrives in time", async () => {
    const { adapter, daemon } = await setup(() => "");
    await adapter.applyMailRelay(relayReq);
    [...daemon.containers.values()][0]!.networks["hp_mail_net"] = { IPAddress: "127.0.0.1" };
    await expect(adapter.sendTestMail({ to: "a@b.it", from: "noreply@mail.hostingco.it" })).resolves.toEqual({
      outcome: "pending",
      problem: null,
      detail: null,
    });
  });

  it("sendTestMail needs a running relay", async () => {
    const { adapter } = await setup(() => "");
    await expect(adapter.sendTestMail({ to: "a@b.it", from: "n@b.it" })).rejects.toMatchObject({
      code: "MAIL_RELAY_UNAVAILABLE",
    });
  });
});
