import type { AlertKind, HostDiskPath, PanelComponent } from "./admin-health.js";
import type { NotificationAudience, NotificationEvent } from "./notifications.js";

/**
 * The words of a notification (ADR-0040). Fixed texts, Italian and English, as pure functions of the events:
 * the executor composes the mail with them, the API the chat message and the `text` of a webhook. Nobody types
 * the text of a notification, and the only parts that come from a user are the bounded names inside an event.
 *
 * A line is "<title of the alert>: <what it is about>". The same line is used when the alert opens and when it
 * closes: the panel knows that an alert is no longer open, not why, so a closed line makes no claim of its own.
 */

export const NOTIFICATION_LOCALES = ["it", "en"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

/** Longest text of one message, under the 4096 characters a chat message may hold. */
export const NOTIFICATION_TEXT_MAX = 3500;

interface Words {
  readonly product: string;
  readonly testSubject: string;
  readonly testText: string;
  readonly opened: string;
  readonly closed: string;
  readonly critical: string;
  /** "{n}" is the count. */
  readonly more: string;
  readonly open: string;
  readonly subjectOpened: readonly [one: string, many: string];
  readonly subjectClosed: readonly [one: string, many: string];
  readonly subjectClosedAfterOpened: readonly [one: string, many: string];
  readonly siteOf: string;
  readonly on: string;
  readonly expires: string;
  readonly validUntil: string;
  readonly full: string;
  readonly server: Readonly<Record<AlertKind, string>>;
  readonly customer: Readonly<Partial<Record<AlertKind, string>>>;
  readonly components: Readonly<Record<PanelComponent, string>>;
  readonly disks: Readonly<Record<HostDiskPath, string>>;
}

const IT: Words = {
  product: "Pannello di hosting",
  testSubject: "messaggio di prova",
  testText: "Questo è un messaggio di prova del pannello di hosting. Se lo leggi, le notifiche su questo canale funzionano.",
  opened: "Nuovi avvisi:",
  closed: "Non più aperti:",
  critical: "critico",
  more: "… e altri {n}: sono tutti nel pannello.",
  open: "Apri il pannello:",
  subjectOpened: ["{n} nuovo avviso", "{n} nuovi avvisi"],
  subjectClosed: ["{n} avviso non più aperto", "{n} avvisi non più aperti"],
  subjectClosedAfterOpened: ["{n} non più aperto", "{n} non più aperti"],
  siteOf: "sito {site}",
  on: "{what} su {site}",
  expires: "scade il {date}",
  validUntil: "valido fino al {date}",
  full: "pieno al {percent}%",
  server: {
    disk_high: "Disco quasi pieno",
    certificate_expiring: "Certificato in scadenza e non ancora rinnovato",
    certificate_not_issued: "Certificato non emesso",
    panel_certificate_expiring: "Certificato dell'indirizzo del pannello in scadenza",
    manual_certificate_expiring: "Certificato importato in scadenza",
    backup_failed: "Backup non riuscito",
    panel_backup_failed: "Backup del pannello non riuscito",
    backup_storage_test_failed: "Prova dello spazio di backup non riuscita",
    backup_target_space_low: "Spazio per i backup su questo server quasi esaurito",
    backup_site_without_target: "Sito senza una destinazione di backup utilizzabile",
    backup_partial: "Backup riuscito in una destinazione e non nell'altra",
    component_down: "Componente del pannello non in funzione",
    site_container_down: "Sito non in funzione",
    restore_undo_incomplete: "Ripristino non riuscito, sito non rimesso com'era",
    restore_stuck: "Ripristino non ancora finito",
    operation_unknown: "Operazione in uno stato indeterminato",
    operation_stuck: "Operazione ferma",
  },
  customer: {
    site_container_down: "Sito non in funzione",
    backup_failed: "Backup non riuscito",
    backup_partial: "Backup riuscito solo in parte",
    restore_undo_incomplete: "Ripristino non riuscito: il sito potrebbe non funzionare",
    certificate_expiring: "Certificato in scadenza",
    certificate_not_issued: "Certificato non ancora emesso",
    manual_certificate_expiring: "Certificato in scadenza",
  },
  components: {
    api: "API (hp-api)", web: "Pannello web (hp-web)", database: "Database del pannello (PostgreSQL)",
    executor: "Esecutore (hp-docker-executor)", host_agent: "Agente host (hp-host-agent)", docker_engine: "Docker Engine",
    ingress_proxy: "Proxy (hp_ingress_proxy)", shared_database: "Database dei siti (hp_mariadb)",
    phpmyadmin: "phpMyAdmin (hp_phpmyadmin)", sftp: "Server SFTP (hp_sftp)", mail_relay: "Relay della posta in uscita (hp_mail_relay)",
  },
  disks: { panel_data: "dati del pannello", docker_data: "dati di Docker", database_data: "database del pannello", root: "sistema" },
};

const EN: Words = {
  product: "Hosting panel",
  testSubject: "test message",
  testText: "This is a test message from the hosting panel. If you can read it, notifications on this channel work.",
  opened: "New alerts:",
  closed: "No longer open:",
  critical: "critical",
  more: "… and {n} more: they are all in the panel.",
  open: "Open the panel:",
  subjectOpened: ["{n} new alert", "{n} new alerts"],
  subjectClosed: ["{n} alert no longer open", "{n} alerts no longer open"],
  subjectClosedAfterOpened: ["{n} no longer open", "{n} no longer open"],
  siteOf: "site {site}",
  on: "{what} on {site}",
  expires: "expires on {date}",
  validUntil: "valid until {date}",
  full: "{percent}% full",
  server: {
    disk_high: "Disk almost full",
    certificate_expiring: "Certificate about to expire and not renewed yet",
    certificate_not_issued: "Certificate not issued",
    panel_certificate_expiring: "Certificate of the panel's address about to expire",
    manual_certificate_expiring: "Imported certificate about to expire",
    backup_failed: "Backup failed",
    panel_backup_failed: "Backup of the panel failed",
    backup_storage_test_failed: "Test of the backup storage failed",
    backup_target_space_low: "Backup space on this server almost used up",
    backup_site_without_target: "Site without a usable backup destination",
    backup_partial: "Backup succeeded on one destination and not on the other",
    component_down: "Panel component not working",
    site_container_down: "Site not running",
    restore_undo_incomplete: "Restore failed, site not put back as it was",
    restore_stuck: "Restore not finished yet",
    operation_unknown: "Operation in an undetermined state",
    operation_stuck: "Operation stuck",
  },
  customer: {
    site_container_down: "Site not running",
    backup_failed: "Backup failed",
    backup_partial: "Backup only partly done",
    restore_undo_incomplete: "Restore failed: the site may not work",
    certificate_expiring: "Certificate about to expire",
    certificate_not_issued: "Certificate not issued yet",
    manual_certificate_expiring: "Certificate about to expire",
  },
  components: {
    api: "API (hp-api)", web: "Web panel (hp-web)", database: "Panel database (PostgreSQL)",
    executor: "Executor (hp-docker-executor)", host_agent: "Host agent (hp-host-agent)", docker_engine: "Docker Engine",
    ingress_proxy: "Proxy (hp_ingress_proxy)", shared_database: "Sites database (hp_mariadb)",
    phpmyadmin: "phpMyAdmin (hp_phpmyadmin)", sftp: "SFTP server (hp_sftp)", mail_relay: "Outgoing mail relay (hp_mail_relay)",
  },
  disks: { panel_data: "panel data", docker_data: "Docker data", database_data: "panel database", root: "system" },
};

const WORDS: Readonly<Record<NotificationLocale, Words>> = { it: IT, en: EN };

const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{([a-z]+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : whole));

const DATE_FORMATS: Readonly<Record<NotificationLocale, Intl.DateTimeFormat>> = {
  it: new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
  en: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
};

/** The day of an instant, in UTC, in the reader's language; null when the instant cannot be read. */
function day(locale: NotificationLocale, iso: string | null): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : DATE_FORMATS[locale].format(at);
}

/** What an alert is about, or null when its title says it all. */
function about(w: Words, e: NotificationEvent): string | null {
  switch (e.kind) {
    case "disk_high":
      return e.disks ? e.disks.map((d) => w.disks[d]).join(", ") : null;
    case "certificate_expiring":
    case "certificate_not_issued":
      return e.host !== null && e.site !== null ? `${e.host}, ${fill(w.siteOf, { site: e.site })}` : (e.host ?? e.site);
    case "panel_certificate_expiring":
      return e.host;
    case "manual_certificate_expiring":
      return e.name;
    case "component_down":
      return e.component ? w.components[e.component] : null;
    case "operation_unknown":
    case "operation_stuck":
      return e.operation !== null && e.site !== null ? fill(w.on, { what: e.operation, site: e.site }) : (e.operation ?? e.site);
    case "panel_backup_failed":
    case "backup_storage_test_failed":
    case "backup_target_space_low":
      return null;
    default:
      return e.site;
  }
}

/** A fact worth saying while the alert is open: an expiry day, how full a disk is. */
function fact(w: Words, locale: NotificationLocale, e: NotificationEvent): string | null {
  switch (e.kind) {
    case "disk_high":
      return e.percent === null ? null : fill(w.full, { percent: e.percent });
    case "certificate_expiring":
    case "panel_certificate_expiring": {
      const d = day(locale, e.date);
      return d === null ? null : fill(w.expires, { date: d });
    }
    case "manual_certificate_expiring": {
      const d = day(locale, e.date);
      return d === null ? null : fill(w.validUntil, { date: d });
    }
    default:
      return null;
  }
}

/** One line of a message, without its bullet. */
export function notificationLine(locale: NotificationLocale, audience: NotificationAudience, event: NotificationEvent): string {
  const w = WORDS[locale];
  const title = (audience === "customer" ? w.customer[event.kind] : undefined) ?? w.server[event.kind];
  const subject = about(w, event);
  const extra = event.state === "opened" ? fact(w, locale, event) : null;
  const mark = event.state === "opened" && event.severity === "critical" && audience === "server" ? `[${w.critical}] ` : "";
  return `${mark}${title}${subject === null ? "" : `: ${subject}`}${extra === null ? "" : ` (${extra})`}`;
}

export interface NotificationTextInput {
  readonly locale: NotificationLocale;
  readonly audience: NotificationAudience;
  readonly events: readonly NotificationEvent[];
  /** Events that happened with these and are not in `events`. */
  readonly omitted: number;
  readonly test: boolean;
  /** Where to read more; an https address written by the panel, or null. */
  readonly link: string | null;
}

export interface NotificationText {
  /** One line, with no text typed by a user. */
  readonly subject: string;
  readonly text: string;
}

const plural = (forms: readonly [string, string], n: number): string => fill(n === 1 ? forms[0] : forms[1], { n });

/** The subject and the text of one message. */
export function renderNotification(input: NotificationTextInput): NotificationText {
  const w = WORDS[input.locale];
  const tail = input.link === null ? "" : `\n\n${w.open} ${input.link}`;
  if (input.test) return { subject: `${w.product}: ${w.testSubject}`, text: `${w.testText}${tail}` };

  const opened = input.events.filter((e) => e.state === "opened");
  const closed = input.events.filter((e) => e.state === "closed");
  const counts: string[] = [];
  if (opened.length > 0) counts.push(plural(w.subjectOpened, opened.length));
  if (closed.length > 0) counts.push(plural(opened.length > 0 ? w.subjectClosedAfterOpened : w.subjectClosed, closed.length));
  const subject = `${w.product}: ${counts.join(", ")}`;

  // Lines are added while the text stays under the limit; what is left out is counted with `omitted`.
  const budget = NOTIFICATION_TEXT_MAX - tail.length - fill(w.more, { n: 99999 }).length - 2;
  const parts: string[] = [];
  let used = 0;
  let left = input.omitted;
  for (const [heading, list] of [[w.opened, opened], [w.closed, closed]] as const) {
    if (list.length === 0) continue;
    const lines: string[] = [];
    for (const event of list) {
      const line = `- ${notificationLine(input.locale, input.audience, event)}`;
      const cost = line.length + 1 + (lines.length === 0 ? heading.length + 2 : 0);
      if (used + cost > budget) {
        left += 1;
        continue;
      }
      used += cost;
      lines.push(line);
    }
    if (lines.length > 0) parts.push(`${heading}\n${lines.join("\n")}`);
  }
  if (left > 0) parts.push(fill(w.more, { n: left }));
  return { subject, text: `${parts.join("\n\n")}${tail}` };
}
