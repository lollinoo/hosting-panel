import { renderNotification, type PanelMailRequest, type PanelMailResult } from "@hosting-panel/contracts";
import { submitLocalMail } from "./smtp-submit.js";

/** Fixed texts of the panel's own mails; the link is the only variable part. */
export const PANEL_MAIL_TEXTS = {
  password_reset: {
    it: {
      subject: "Reimposta la password del pannello",
      body: (link: string) =>
        `Ciao,\n\nqualcuno ha chiesto di reimpostare la password del tuo account sul pannello di hosting.\nPer scegliere una nuova password apri questo link entro 30 minuti:\n\n${link}\n\nIl link si può usare una sola volta.\nSe non hai chiesto tu di reimpostare la password, ignora questa email: la tua password non cambia.\n`,
    },
    en: {
      subject: "Reset your panel password",
      body: (link: string) =>
        `Hello,\n\nsomeone asked to reset the password of your account on the hosting panel.\nTo choose a new password, open this link within 30 minutes:\n\n${link}\n\nThe link works only once.\nIf you did not ask for this, ignore this email: your password stays the same.\n`,
    },
  },
} as const;

/** The subject and the body of a panel mail: fixed texts, or the words of a notification's events (ADR-0040). */
export function composePanelMail(req: PanelMailRequest): { subject: string; text: string } {
  if (req.kind === "notification") {
    const { subject, text } = renderNotification(req);
    return { subject, text: `${text}\n` };
  }
  const texts = PANEL_MAIL_TEXTS[req.kind][req.locale];
  return { subject: texts.subject, text: texts.body(req.link) };
}

/** Submits one panel mail to the relay; never throws. */
export async function deliverPanelMail(
  host: string | null,
  port: number,
  heloName: string,
  req: PanelMailRequest,
): Promise<PanelMailResult> {
  if (host === null) return { outcome: "failed" };
  try {
    await submitLocalMail({ host, port, heloName, from: req.from, to: req.to, ...composePanelMail(req), timeoutMs: 5_000 });
    return { outcome: "queued" };
  } catch (err) {
    // The error message can quote the relay's reply; only the code is logged, never the address or the link.
    const code = (err as { code?: unknown } | null)?.code ?? "INTERNAL_ERROR";
    console.warn(JSON.stringify({ component: "hp-docker-executor", event: "panel_mail_failed", kind: req.kind, code }));
    return { outcome: "failed" };
  }
}
