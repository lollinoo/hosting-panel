import net from "node:net";
import {
  PanelMailIpcRequestSchema,
  notificationEventFromAlert,
  renderNotification,
  type AdminAlertDto,
  type NotificationMailRequest,
  type PanelMailRequest,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composePanelMail, deliverPanelMail, PANEL_MAIL_TEXTS } from "../src/panel-mail.js";

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  vi.restoreAllMocks();
});

/** A small SMTP listener: collects the DATA part, or refuses every command after the greeting with `refuse`. */
async function listener(refuse?: string) {
  const messages: string[] = [];
  const server = net.createServer((sock) => {
    sock.write("220 relay ESMTP\r\n");
    let data: string[] | null = null;
    let pending = "";
    sock.on("data", (d) => {
      pending += d.toString();
      const lines = pending.split("\r\n");
      pending = lines.pop() ?? "";
      for (const l of lines) {
        if (data) {
          if (l === ".") {
            messages.push(data.join("\n"));
            data = null;
            sock.write("250 2.0.0 Ok: queued as 4PANEL1\r\n");
          } else data.push(l);
        } else if (refuse && !l.startsWith("EHLO")) sock.write(`${refuse}\r\n`);
        else if (l === "DATA") {
          data = [];
          sock.write("354 go\r\n");
        } else if (l.startsWith("EHLO")) sock.write("250-relay\r\n250 8BITMIME\r\n");
        else if (l) sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, messages };
}

const LINK = "https://panel.example.test/reset-password#sentinel-token-1";
const req = (locale: "it" | "en"): PanelMailRequest & { kind: "password_reset" } => ({
  kind: "password_reset",
  to: "customer@example.test",
  from: "noreply@mail.example.test",
  locale,
  link: LINK,
});

describe("deliverPanelMail", () => {
  it.each(["it", "en"] as const)("submits the %s subject and body, the link on a line of its own", async (locale) => {
    const l = await listener();
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", req(locale))).resolves.toEqual({ outcome: "queued" });
    expect(l.messages).toHaveLength(1);
    const [head, body] = l.messages[0]!.split(/\n\n([\s\S]*)/);
    const texts = PANEL_MAIL_TEXTS.password_reset[locale];
    const subject = /^[\x20-\x7e]*$/.test(texts.subject)
      ? texts.subject
      : `=?UTF-8?B?${Buffer.from(texts.subject, "utf8").toString("base64")}?=`;
    expect(head).toContain(`Subject: ${subject}`);
    expect(head).toContain("To: customer@example.test");
    expect(head).toContain("From: noreply@mail.example.test");
    expect(body).toBe(texts.body(LINK));
    expect(body!.split("\n")).toContain(LINK);
    // The link is the only variable part of the body.
    expect(texts.body(LINK).replace(LINK, "")).toBe(texts.body(""));
  });

  it("gives failed with no relay address, without a connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(deliverPanelMail(null, 1, "panel", req("en"))).resolves.toEqual({ outcome: "failed" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("customer@example.test");
  });

  it("gives failed when the relay refuses, and the log names neither the address nor the link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const l = await listener("554 5.7.1 refused");
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", req("it"))).resolves.toEqual({ outcome: "failed" });
    expect(l.messages).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      component: "hp-docker-executor",
      event: "panel_mail_failed",
      kind: "password_reset",
      code: expect.any(String),
    });
    const captured = JSON.stringify([warn.mock.calls, log.mock.calls, error.mock.calls]);
    for (const secret of ["customer@example.test", LINK, "sentinel-token-1"]) expect(captured).not.toContain(secret);
  });

  it("gives failed when nothing listens on the port", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const l = await listener();
    closers.splice(0).forEach((c) => c());
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", req("en"))).resolves.toEqual({ outcome: "failed" });
  });
});

describe("PanelMailIpcRequestSchema", () => {
  it("refuses http, control characters, an over-long link and an unknown kind", () => {
    const ok = req("en");
    expect(PanelMailIpcRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { link: "http://panel.example.test/reset-password#x" },
      { link: `${LINK}\n` },
      { link: `${LINK}\u0007` },
      { link: `https://panel.example.test/${"a".repeat(512)}` },
      { kind: "welcome" },
    ]) {
      expect(PanelMailIpcRequestSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});

describe("notification mail", () => {
  const down: AdminAlertDto = {
    kind: "site_container_down",
    severity: "critical",
    subject: "site_1",
    since: null,
    details: { siteId: "site_1", siteName: "Shop", observed: "stopped" },
  };
  const failed: AdminAlertDto = {
    kind: "backup_failed",
    severity: "warning",
    subject: "site_1",
    since: null,
    details: { siteId: "site_1", siteName: "Shop", failedAt: "2026-11-23T10:00:00.000Z" },
  };
  const notification = (patch: Partial<NotificationMailRequest> = {}): NotificationMailRequest => ({
    kind: "notification",
    to: "owner@example.test",
    from: "noreply@mail.example.test",
    locale: "it",
    audience: "customer",
    events: [
      notificationEventFromAlert(down, "0".repeat(24), "opened"),
      notificationEventFromAlert(failed, "1".repeat(24), "closed"),
    ],
    omitted: 0,
    test: false,
    link: "https://panel.example.test/",
    ...patch,
  });
  /** The Subject header of a received message, its folded lines joined and its encoded words read. */
  const subjectOf = (head: string) => {
    const lines = head.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Subject: "));
    const parts = [lines[at]!.slice("Subject: ".length)];
    for (let i = at + 1; lines[i]?.startsWith(" "); i += 1) parts.push(lines[i]!.slice(1));
    return parts
      .map((p) => {
        const word = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(p);
        return word ? Buffer.from(word[1]!, "base64").toString("utf8") : p;
      })
      .join("");
  };

  it("is written by the executor from the events, in the language asked for", async () => {
    const l = await listener();
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", notification())).resolves.toEqual({ outcome: "queued" });
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", notification({ locale: "en", audience: "server", link: null }))).resolves.toEqual({ outcome: "queued" });
    expect(l.messages).toHaveLength(2);
    const [itHead, itBody] = l.messages[0]!.split(/\n\n([\s\S]*)/);
    expect(subjectOf(itHead!)).toBe("Pannello di hosting: 1 nuovo avviso, 1 non più aperto");
    expect(itHead).toContain("To: owner@example.test");
    expect(itHead).toContain("From: noreply@mail.example.test");
    for (const line of itHead!.split("\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(itBody).toBe(
      [
        "Nuovi avvisi:",
        "- Sito non in funzione: Shop",
        "",
        "Non più aperti:",
        "- Backup non riuscito: Shop",
        "",
        "Apri il pannello: https://panel.example.test/",
        "",
      ].join("\n"),
    );
    const [enHead, enBody] = l.messages[1]!.split(/\n\n([\s\S]*)/);
    expect(subjectOf(enHead!)).toBe("Hosting panel: 1 new alert, 1 no longer open");
    expect(enBody).toBe(["New alerts:", "- [critical] Site not running: Shop", "", "No longer open:", "- Backup failed: Shop", ""].join("\n"));
  });

  it("is the same text a webhook or a chat receives", () => {
    for (const locale of ["it", "en"] as const) {
      const mail = notification({ locale });
      const { subject, text } = renderNotification(mail);
      expect(composePanelMail(mail)).toEqual({ subject, text: `${text}\n` });
    }
    expect(composePanelMail(notification({ test: true, events: [] }))).toEqual({
      subject: "Pannello di hosting: messaggio di prova",
      text: "Questo è un messaggio di prova del pannello di hosting. Se lo leggi, le notifiche su questo canale funzionano.\n\nApri il pannello: https://panel.example.test/\n",
    });
  });

  it("takes no text from the request: a subject or a body sent with it is refused", () => {
    const mail = notification();
    expect(PanelMailIpcRequestSchema.safeParse(mail).success).toBe(true);
    for (const extra of [{ subject: "Hello" }, { text: "Hello" }, { body: "Hello" }]) {
      expect(PanelMailIpcRequestSchema.safeParse({ ...mail, ...extra }).success).toBe(false);
    }
    const named = { ...mail, events: [{ ...mail.events[0]!, site: "Shop\r\nBcc: x@example.test" }] };
    expect(PanelMailIpcRequestSchema.safeParse(named).success).toBe(false);
  });

  it("logs a failure by kind and code only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const l = await listener("554 5.7.1 refused");
    await expect(deliverPanelMail("127.0.0.1", l.port, "panel", notification())).resolves.toEqual({ outcome: "failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      component: "hp-docker-executor",
      event: "panel_mail_failed",
      kind: "notification",
      code: expect.any(String),
    });
    for (const hidden of ["owner@example.test", "Shop", "panel.example.test"]) expect(JSON.stringify(warn.mock.calls)).not.toContain(hidden);
  });
});
