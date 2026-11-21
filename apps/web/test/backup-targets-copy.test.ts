import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";

// SPEC §6.5 "Messaggio obbligatorio UI", verbatim.
const SPEC_WARNING_IT =
  "I backup locali sullo stesso server non proteggono dalla perdita del server o del disco. Per disaster recovery conserva una copia fuori dal server e la chiave di recupero.";
const SPEC_WARNING_EN =
  "Local backups on the same server do not protect against losing the server or its disk. For disaster recovery, keep a copy off the server and the recovery key.";

// Same bans as site-backups.test.ts (BACKUP_BANNED_PATTERN + JARGON) and ui-copy.test.ts (Italian jargon).
const BANNED =
  /\b(restic|s3|snapshot|bucket|repository|repo|container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim|schema|contenitore|contenitori|immagine|immagini|volumi|servizio|servizi|rete|reti|revisione|revisioni|organizzazione|organizzazioni)\b|HCP-SPEC|AC-F|ADR-/i;

function leaves(node: unknown, prefix = ""): Array<{ path: string; value: string }> {
  if (typeof node === "string") return [{ path: prefix, value: node }];
  if (node && typeof node === "object")
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  return [];
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const ADMIN_GROUPS = ["tabs", "targets", "policy", "recovery"] as const;
// Shell commands, the "S3" brand name and the "{name} ({kind})" pattern are not translated.
const SAME_IN_BOTH = /\.command$|^targets\.kind\.s3$|^policy\.option$/;

const customerLeaves = (m: typeof en) => [
  ...leaves(m.site.backups.target, "site.backups.target"),
  ...leaves(m.site.backups.copies, "site.backups.copies"),
  { path: "site.backups.restore.fromLabel", value: m.site.backups.restore.fromLabel },
  { path: "site.backups.status.partial", value: m.site.backups.status.partial },
  { path: "site.backups.status.partialLong", value: m.site.backups.status.partialLong },
];

describe("local-backup warning (SPEC §6.5)", () => {
  it("is the verbatim Italian sentence, with the agreed English translation", () => {
    expect(itCatalog.admin.backups.localWarning).toBe(SPEC_WARNING_IT);
    expect(en.admin.backups.localWarning).toBe(SPEC_WARNING_EN);
  });

  it("has a neutral customer twin that still says a copy on this server is not enough", () => {
    for (const m of [en, itCatalog]) {
      const twin = m.site.backups.target.localWarning;
      expect(twin).not.toBe(m.admin.backups.localWarning);
      expect(twin).not.toMatch(BANNED);
    }
    expect(itCatalog.site.backups.target.localWarning).toMatch(/server/i);
    expect(itCatalog.site.backups.target.localWarning).toMatch(/copia esterna/i);
    expect(en.site.backups.target.localWarning).toMatch(/off-server|external/i);
  });
});

describe("customer destination, copy and partial copy is neutral", () => {
  it("passes the backup and jargon bans in both languages", () => {
    const violations = [en, itCatalog].flatMap((m, i) =>
      customerLeaves(m)
        .filter((e) => BANNED.test(e.value))
        .map((e) => `${i === 0 ? "en" : "it"}.${e.path}: ${e.value}`),
    );
    expect(violations).toEqual([]);
  });

  it("offers inherit, off-server, this-server and numbered labels, and never leaks a path", () => {
    for (const m of [en, itCatalog]) {
      const t = m.site.backups.target;
      for (const k of ["title", "inherit", "offServer", "thisServer", "offServerN", "saved"] as const) {
        expect(t[k], k).toBeTruthy();
      }
      expect(placeholders(t.offServerN)).toEqual(["n"]);
      for (const e of customerLeaves(m)) expect(e.value, e.path).not.toMatch(/\/var\/|\/etc\/|localRoot|endpoint/i);
    }
    expect(en.site.backups.target.offServer).not.toBe(itCatalog.site.backups.target.offServer);
  });

  it("states a partial backup in words, not colour: partialLong differs from every other status", () => {
    for (const m of [en, itCatalog]) {
      const { status } = m.site.backups;
      expect(status.partialLong).toBeTruthy();
      expect(status.partialLong).not.toBe(status.partial);
      expect(new Set([status.running, status.succeeded, status.failed, status.partial]).size).toBe(4);
      expect(m.site.backups.restore.fromLabel).toBeTruthy();
      for (const s of ["running", "succeeded", "failed", "unknown"] as const) {
        expect(m.site.backups.copies.status[s], s).toBeTruthy();
      }
    }
  });
});

describe("local-target and missing-copy problems", () => {
  const NEW_PROBLEMS = [
    "local_target_unmounted",
    "local_target_readonly",
    "local_target_unsafe",
    "backup_copy_missing",
  ] as const;

  it("have a text in every problem map in both languages, translated, and none leaks a path", () => {
    for (const p of NEW_PROBLEMS) {
      for (const map of ["problem", "copyProblem"] as const) {
        expect(en.site.backups[map][p], `${map}.${p}`).toBeTruthy();
        expect(itCatalog.site.backups[map][p]).not.toBe(en.site.backups[map][p]);
        expect(en.site.backups[map][p]).not.toMatch(BANNED);
        expect(itCatalog.site.backups[map][p]).not.toMatch(BANNED);
      }
      expect(en.admin.backups.problem[p]).toBeTruthy();
      expect(itCatalog.admin.backups.problem[p]).not.toBe(en.admin.backups.problem[p]);
      expect(en.admin.backups.problem[p]).not.toMatch(/\/var\/|\/etc\//);
    }
    expect(en.site.backups.copies.status.missing).toBeTruthy();
    expect(itCatalog.site.backups.copies.status.missing).not.toBe(en.site.backups.copies.status.missing);
  });
});

describe("admin destinations, policy and recovery copy", () => {
  it("has the same keys and placeholders in Italian and English", () => {
    for (const g of ADMIN_GROUPS) {
      const a = leaves(en.admin.backups[g], g);
      const b = leaves(itCatalog.admin.backups[g], g);
      expect(b.map((e) => e.path)).toEqual(a.map((e) => e.path));
      b.forEach((e, i) => expect(placeholders(e.value), e.path).toEqual(placeholders(a[i]!.value)));
    }
  });

  it("is translated: no leaf is identical in IT and EN except commands and brand names", () => {
    const same: string[] = [];
    for (const g of ADMIN_GROUPS) {
      const b = leaves(itCatalog.admin.backups[g], g);
      leaves(en.admin.backups[g], g).forEach((e, i) => {
        if (!SAME_IN_BOTH.test(e.path) && e.value === b[i]!.value) same.push(e.path);
      });
      for (const e of b) expect(e.value.trim(), e.path).not.toBe("");
    }
    expect(same).toEqual([]);
  });

  it("rewrites changeWarning: a new destination, the old one archived, its backups still restorable", () => {
    expect(en.admin.backups.changeWarning).toMatch(/new destination/i);
    expect(en.admin.backups.changeWarning).toMatch(/archive/i);
    expect(en.admin.backups.changeWarning).toMatch(/restorable/i);
    expect(en.admin.backups.changeWarning).not.toMatch(/forgets/i);
    expect(itCatalog.admin.backups.changeWarning).toMatch(/nuova destinazione/i);
    expect(itCatalog.admin.backups.changeWarning).toMatch(/archiviat/i);
    expect(itCatalog.admin.backups.changeWarning).toMatch(/ripristinabil/i);
    expect(itCatalog.admin.backups.changeWarning).not.toMatch(/dimentica/i);
  });

  it("recovery text names the key file and gives S3 and local hp-restore-panel commands with the target id", () => {
    for (const m of [en, itCatalog]) {
      const r = m.admin.backups.recovery;
      expect(r.key.body).toContain("{backupKeyPath}");
      expect(r.s3.command).toMatch(/^hp-restore-panel --endpoint \{endpoint\} --region \{region\} --bucket \{bucket\}/);
      expect(r.local.command).toBe("hp-restore-panel --local-repo {root}/{targetId}/panel");
      expect(placeholders(r.s3.title)).toContain("targetId");
      expect(placeholders(r.local.title)).toContain("targetId");
      // the disk must be mounted again first; a lost disk is not promised back
      expect(r.local.body).toMatch(/mount|mont/i);
      expect(r.local.lostDisk).toMatch(/cannot|not possible|non si può|non è possibile/i);
      expect(r.local.lostDisk).not.toMatch(/\b(will|can) be restored\b|verrà ripristinat/i);
      // the page is text only (spec §9.2)
      for (const e of leaves(r)) expect(e.value, e.path).not.toMatch(/<\s*button/i);
    }
  });

  it("explains the initialise step (marker file, repeat after a new disk) in both languages", () => {
    for (const m of [en, itCatalog]) {
      const l = m.admin.backups.targets.local;
      expect(l.initialiseBody).toMatch(/marker|marcatore/i);
      expect(placeholders(l.root)).toEqual([]);
      expect(placeholders(m.admin.backups.targets.capacity)).toEqual(["free", "total"]);
      expect(placeholders(m.admin.backups.targets.lowSpace)).toEqual(["free", "total"]);
    }
  });
});
