import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

// QA-A4: the administrator's wording after the «Applicazioni» rename (L22-L28, ux-admin §4).

function get(dict: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
}
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
// «sito», «siti», «site», «sites» as whole words (Italian and English).
const SITE_WORD = /\bsit[oi]\b|\bsites?\b/i;

// §4.1: key, IT new, EN new, placeholders the value keeps.
const CHANGED: [string, string, string, string[]][] = [
  ["admin.nav.sites", "Applicazioni", "Applications", []],
  ["admin.sites.title", "Applicazioni", "Applications", []],
  ["admin.sites.subtitle", "Tutte le applicazioni di questo server e a chi appartengono.", "Every application on this server, and who it belongs to.", []],
  ["admin.sites.create", "Crea applicazione WordPress", "Create WordPress application", []],
  ["admin.sites.createTitle", "Crea un'applicazione WordPress", "Create a WordPress application", []],
  ["admin.sites.createHint", "L'applicazione viene preparata in pochi minuti. Compare nel pannello del proprietario appena viene assegnata.", "The application is set up in a few minutes. It appears in the owner's panel as soon as it is assigned.", []],
  ["admin.sites.moveTo", "{site} passerà a {owner}, che la vedrà e la gestirà dal suo pannello. L'applicazione si riavvia per qualche secondo.", "{site} will move to {owner}. They will see and manage it from their panel. The application restarts for a few seconds.", ["owner", "site"]],
  ["admin.sites.moveToNone", "Il cliente non vedrà più questa applicazione.", "The customer will no longer see this application.", []],
  ["admin.sites.moveFrom", "{current} non la vedrà e non la gestirà più.", "{current} will no longer see it or manage it.", ["current"]],
  ["admin.sites.empty", "Nessuna applicazione per ora.", "No applications yet.", []],
  ["admin.sites.loadError", "Non è stato possibile caricare le applicazioni. Ricarica la pagina tra un minuto.", "The applications could not be loaded. Reload the page in a minute.", []],
  ["admin.sites.domainsBack", "Torna alle applicazioni", "Back to applications", []],
  ["admin.sites.upgradeBody", "L'applicazione viene ripubblicata con la nuova versione del modello. File, database e domini restano come sono; l'applicazione si riavvia per qualche secondo.", "The application is redeployed with the new template version. Files, database and domains stay as they are; the application restarts for a few seconds.", []],
  ["admin.sites.limitReached", "Il cliente ha raggiunto il suo limite di applicazioni WordPress. Aumenta il limite nella sezione Clienti e riprova.", "The customer has reached their WordPress application limit. Raise the limit in the Customers section and try again.", []],
  ["admin.sites.customers.intro", "Quante applicazioni WordPress può avere ogni cliente. Abbassare il limite non tocca quelle esistenti: blocca solo la creazione di nuove.", "How many WordPress applications each customer may have. Lowering the limit never touches existing ones: it only blocks new ones.", []],
  ["admin.sites.customers.colSites", "Applicazioni WordPress", "WordPress applications", []],
  ["admin.sites.customers.editAria", "Modifica il limite di applicazioni WordPress di {name}", "Change the WordPress application limit of {name}", ["name"]],
  ["admin.sites.customers.editTitle", "Limite di applicazioni WordPress di {name}", "WordPress application limit of {name}", ["name"]],
  ["admin.sites.customers.maxLabel", "Numero massimo di applicazioni WordPress", "Maximum number of WordPress applications", []],
  ["admin.sites.customers.belowUsage", "{name} ha già {used} applicazioni WordPress: restano attive, ma non potrà crearne altre finché non scende sotto {max}.", "{name} already has {used} WordPress applications: they keep running, but no new one can be created until the count is below {max}.", ["max", "name", "used"]],
  ["admin.templates.subtitle", "I modelli da cui nascono le applicazioni: WordPress e, se attivi, i modelli multi-servizio. Ogni modifica del contenuto crea una nuova versione; le applicazioni esistenti restano sulla loro.", "The templates applications are created from: WordPress and, when turned on, multi-service templates. Every content change creates a new version; existing applications keep theirs.", []],
  ["admin.templates.col.sites", "Applicazioni", "Applications", []],
  ["admin.templates.detail.sitesTotal", "{count} applicazioni usano questo modello", "{count} applications use this template", ["count"]],
  ["admin.templates.detail.enabledHint", "I clienti lo vedono quando creano un'applicazione. Quelle già create non cambiano.", "Customers see it when they create an application. Existing ones do not change.", []],
  ["admin.templates.detail.archiveBody", "Il modello non sarà più offerto ai clienti né modificabile. Le applicazioni che lo usano continuano a funzionare.", "The template is no longer offered to customers nor editable. Applications that use it keep working.", []],
  ["admin.templates.detail.builtInNotice", "Modello di sistema: puoi modificarlo, aggiungere versioni o disattivarlo, ma non archiviarlo.", "Built-in template: you can edit it, add versions or turn it off, but not archive it.", []],
  ["admin.templates.editor.makeDefault", "Usala per le nuove applicazioni", "Use it for new applications", []],
  ["admin.appTemplates.tabs.label", "Tipo di modello", "Template kind", []],
  ["admin.appTemplates.tabs.sites", "WordPress", "WordPress", []],
  ["admin.appTemplates.tabs.apps", "Applicazione multi-servizio", "Multi-service application", []],
  ["admin.appTemplates.create", "Nuovo modello multi-servizio", "New multi-service template", []],
  ["admin.appTemplates.loadError", "Non è stato possibile caricare i modelli multi-servizio. Ricarica la pagina tra un minuto.", "The multi-service templates could not be loaded. Reload the page in a minute.", []],
  ["admin.appTemplates.back", "Torna ai modelli", "Back to templates", []],
  ["admin.appTemplates.notAvailable", "I modelli multi-servizio non sono attivi su questo server (flag applicationTemplatesAvailable = false).", "Multi-service templates are not enabled on this server (flag applicationTemplatesAvailable = false).", []],
  ["admin.appTemplates.more", "Elenco parziale: sono mostrati solo i primi 100 modelli multi-servizio.", "Partial list: only the first 100 multi-service templates are shown.", []],
  ["admin.terminal.back", "Torna alle applicazioni", "Back to applications", []],
  ["admin.terminal.errors.NOT_FOUND", "Questo sito o questa sessione non esiste più. Torna alle applicazioni e ricarica.", "This site or session no longer exists. Go back to applications and reload.", []],
];

// §4.2
const NEW_KEYS: [string, string, string][] = [
  ["admin.templates.col.kind", "Tipo", "Kind"],
  ["admin.sites.colKind", "Tipo", "Kind"],
  ["admin.sites.stacksLoadError", "Non è stato possibile caricare le applicazioni multi-servizio. Ricarica la pagina tra un minuto.", "The multi-service applications could not be loaded. Reload the page in a minute."],
  ["admin.sites.stacksTruncated", "Sono mostrate solo le prime 200 applicazioni multi-servizio.", "Only the first 200 multi-service applications are shown."],
  ["admin.appTemplates.detail.editDetails", "Modifica nome, descrizione e categoria", "Edit name, description and category"],
  ["admin.appTemplates.detail.detailsHint", "I clienti vedono questo nome, questa descrizione e questa categoria. Le nuove versioni non li cambiano: si modificano solo qui.", "Customers see this name, description and category. New versions do not change them: you change them only here."],
  ["admin.appTemplates.detail.editContent", "Modifica contenuto", "Edit content"],
  ["admin.appTemplates.detail.editContentHint", "Si apre la versione predefinita. Salvando crei una nuova versione: quelle esistenti e le applicazioni già installate non cambiano.", "The default version opens. Saving creates a new version: existing versions and installed applications do not change."],
];

describe("QA-A4 admin copy: every changed and new key (§4.1, §4.2)", () => {
  const ALL_KEYS = [...CHANGED.map((r) => r[0]), ...NEW_KEYS.map((r) => r[0])];

  it("the key tables have no duplicates", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it.each(ALL_KEYS)("%s exists in IT and EN as a non-blank string", (key) => {
    for (const [name, dict] of [["it", itMsgs], ["en", en]] as const) {
      const v = get(dict, key);
      expect(typeof v, `${name}:${key}`).toBe("string");
      expect((v as string).trim().length, `${name}:${key}`).toBeGreaterThan(0);
      expect(v, `${name}:${key} has no edge whitespace`).toBe((v as string).trim());
      expect(v as string, `${name}:${key} has no raw tab or newline`).not.toMatch(/[\n\t]/);
    }
  });

  it.each(ALL_KEYS)("%s keeps the same {placeholders} in IT and EN", (key) => {
    expect(placeholders(get(itMsgs, key) as string), key).toEqual(placeholders(get(en, key) as string));
  });

  it.each(CHANGED)("%s keeps the placeholders it had", (key, _it, _en, vars) => {
    expect(placeholders(get(itMsgs, key) as string)).toEqual(vars);
    expect(placeholders(get(en, key) as string)).toEqual(vars);
  });

  // The design's exact sentence, except where the engineer reworded it and kept the meaning: those rows only have to say the
  // same things (checked below), not the same letters.
  const REWORDED = new Set(["admin.sites.upgradeBody"]);
  it.each(CHANGED.filter((r) => !REWORDED.has(r[0])))("%s says the agreed Italian and English wording", (key, itValue, enValue) => {
    expect(get(itMsgs, key)).toBe(itValue);
    expect(get(en, key)).toBe(enValue);
  });

  it("admin.sites.upgradeBody still tells: new template version, files/database/domains stay, a short restart; and names an application, not a site", () => {
    const itText = get(itMsgs, "admin.sites.upgradeBody") as string;
    const enText = get(en, "admin.sites.upgradeBody") as string;
    expect(itText).toMatch(/applicazione/);
    expect(itText).toMatch(/nuova versione del modello/);
    expect(itText).toMatch(/File, database e domini restano come sono/);
    expect(itText).toMatch(/si riavvia per qualche secondo/);
    expect(enText).toMatch(/application/);
    expect(enText).toMatch(/new template version/);
    expect(enText).toMatch(/Files, database and domains stay as they are/);
    expect(enText).toMatch(/restarts for a few seconds/);
  });

  it.each(NEW_KEYS)("%s (new) says the agreed Italian and English wording", (key, itValue, enValue) => {
    expect(get(itMsgs, key)).toBe(itValue);
    expect(get(en, key)).toBe(enValue);
  });

  it.each(ALL_KEYS)("%s has no unbalanced brace or leftover placeholder syntax", (key) => {
    for (const dict of [itMsgs, en]) {
      const v = get(dict, key) as string;
      expect(v.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });

  it("the Italian and English values are different texts, except the kind names that are the same word", () => {
    const SAME = new Set(["admin.appTemplates.tabs.sites"]);
    for (const key of ALL_KEYS) {
      if (SAME.has(key)) continue;
      expect(get(itMsgs, key), key).not.toBe(get(en, key));
    }
  });
});

describe("QA-A4 admin copy: the managed thing is no longer called a site (L23)", () => {
  const NO_SITE_WORD = [
    "admin.nav.sites",
    "admin.sites.title",
    "admin.sites.empty",
    "admin.sites.loadError",
    "admin.sites.domainsBack",
    "admin.templates.col.sites",
    "admin.terminal.back",
  ];

  it.each(NO_SITE_WORD)("%s has no «sito/siti» (IT) and no «site/sites» (EN)", (key) => {
    expect(get(itMsgs, key) as string).not.toMatch(SITE_WORD);
    expect(get(en, key) as string).not.toMatch(SITE_WORD);
  });

  it("the same keys name an application in both languages", () => {
    for (const key of NO_SITE_WORD) {
      expect(get(itMsgs, key) as string, key).toMatch(/applicazion/i);
      expect(get(en, key) as string, key).toMatch(/application/i);
    }
  });

  it("the whole admin.sites section (titles, hints, limits) never uses the old category word, except where a placeholder or a WordPress site is named", () => {
    // Section strings that may still say «sito/site»: none are listed in §4.1 as unchanged, so none should.
    const keys = CHANGED.map((r) => r[0]).filter((k) => k.startsWith("admin.sites.") || k.startsWith("admin.templates.") || k.startsWith("admin.appTemplates."));
    for (const key of keys) {
      const itText = (get(itMsgs, key) as string).replace(/\{site\}/g, "");
      const enText = (get(en, key) as string).replace(/\{site\}/g, "");
      expect(itText, key).not.toMatch(SITE_WORD);
      expect(enText, key).not.toMatch(SITE_WORD);
    }
  });

  it("the one admin.terminal error that still says «sito» is the one that names the WordPress site and its session", () => {
    expect(get(itMsgs, "admin.terminal.errors.NOT_FOUND")).toMatch(/\bsito\b/);
    expect(get(en, "admin.terminal.errors.NOT_FOUND")).toMatch(/\bsite\b/);
  });
});

describe("QA-A4 admin copy: «Server» keeps meaning the host machines (X12)", () => {
  it.each([
    ["admin.nav.server"],
    ["admin.hosts.title"],
  ])("%s still says «Server» in both languages", (key) => {
    expect(get(itMsgs, key)).toBe("Server");
    expect(get(en, key)).toBe("Server");
  });

  it("the sidebar entry for sites is a different word from the sidebar entry for servers", () => {
    expect(get(itMsgs, "admin.nav.sites")).not.toBe(get(itMsgs, "admin.nav.server"));
    expect(get(en, "admin.nav.sites")).not.toBe(get(en, "admin.nav.server"));
  });
});

describe("QA-A4 admin copy: sections that list WordPress sites only keep «Sito» (X12)", () => {
  it.each([
    ["admin.health.colSite", "Sito", "Site"],
    ["admin.backups.columns.site", "Sito", "Site"],
  ])("%s keeps its value", (key, itValue, enValue) => {
    expect(get(itMsgs, key)).toBe(itValue);
    expect(get(en, key)).toBe(enValue);
  });

  it("the other admin.updates / admin.certificates site columns were not renamed", () => {
    expect(get(itMsgs, "admin.updates.sites.colSite")).toBe("Sito");
    expect(get(en, "admin.updates.sites.colSite")).toBe("Site");
    expect(get(itMsgs, "admin.certificates.inventory.columns.site")).toBe("Sito");
    expect(get(en, "admin.certificates.inventory.columns.site")).toBe("Site");
  });
});
