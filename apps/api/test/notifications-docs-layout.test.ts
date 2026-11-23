import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_PROBLEMS } from "@hosting-panel/contracts";

// ADR-0040: the documents of the notifications stay true to the tree. A path a document cites exists, the runbook
// explains every reason the page can show, and no command of the runbook reads a stored secret.
const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const citedPaths = (text: string) =>
  new Set([...text.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

describe("notifications docs", () => {
  it("ADR-0040 has its header, says how it was built and what is proved, and cites existing paths", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0040-.*\.md$/.test(f));
    expect(adrs).toEqual(["0040-notifications.md"]);
    const file = `docs/architecture/adr/${adrs[0]!}`;
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento", "Migrazioni"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    for (let n = 1; n <= 12; n++) expect(adr, `N${n}`).toMatch(new RegExp(`^### N${n} — `, "m"));
    for (const s of ["## 4. Come è stato costruito", "## 5. Che cosa è provato", "Non provato:", "Punti aperti:"]) expect(adr, s).toContain(s);
    for (const s of ["0029_notifications.sql", "`notifications`", "`notification.read`", "`notification.manage`", "hp-restore-panel"]) {
      expect(adr, s).toContain(s);
    }
    const paths = citedPaths(adr);
    expect(paths.size, file).toBeGreaterThanOrEqual(40);
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    // What is proved names tests, and each of them is a file of this tree.
    const proved = [...citedPaths(between(adr, "## 5. Che cosa è provato", "Non provato:"))].filter((p) => p.endsWith(".test.ts"));
    expect(proved.length).toBeGreaterThanOrEqual(15);
  });

  it("the runbook has its eight procedures and explains every reason a message is not delivered", () => {
    const runbook = read("docs/runbooks/notifications.md");
    expect(runbook).toMatch(/^# Runbook — Notifications$/m);
    expect(runbook).toContain("## Scope and limits (read first)");
    for (let n = 1; n <= 8; n++) expect(runbook, `heading ${n}.`).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    // The rows of the table of reasons, without its header row.
    const reasons = runbook.split("\n").filter((l) => l.startsWith("| `") && !l.startsWith("| `problem` |"));
    for (const problem of NOTIFICATION_PROBLEMS) {
      expect(reasons.filter((l) => l.startsWith(`| \`${problem}\` |`)), problem).toHaveLength(1);
    }
    expect(reasons).toHaveLength(NOTIFICATION_PROBLEMS.length);
    for (const s of ["ADR-0040", "/admin/notifications", "/account/notifications", "X-Hosting-Panel-Signature", "--allow-feature-loss",
      "hp-restore-panel", "secrets-master.key", "notification_pass_failed", "notification_observe_failed", "notification_send_failed"]) {
      expect(runbook, s).toContain(s);
    }
    for (const p of citedPaths(runbook)) expect(existsSync(join(root, p)), `runbook: ${p}`).toBe(true);
  });

  it("no database command of the runbook reads an address, a key, a token or a recipient", () => {
    const runbook = read("docs/runbooks/notifications.md");
    const queries = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const sql of queries) {
      expect(sql).toMatch(/^\s*select /);
      expect(sql).not.toMatch(/config_|recipient|events?\b|\*/);
      expect(sql).not.toMatch(/\b(?:insert|update|delete|drop|alter|truncate)\b/i);
    }
  });

  it("README, HARNESS, the ER diagram and the brain files name the feature", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0040", "docs/architecture/adr/0040-notifications.md", "docs/runbooks/notifications.md", "#### Notifiche",
      "**Notifiche nell'aggiornamento.**", "`notifications`", "`0029`"]) {
      expect(readme, s).toContain(s);
    }
    // There is no capability flag for notifications: the row of the table claims none.
    const rows = between(readme, "## 2. Stato di Implementazione", "## 3. Mappa del Monorepo")
      .split("\n")
      .filter((l) => l.startsWith("|") && l.includes("ADR-0040"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/`\w+: (?:true|false)`/);
    const section = between(readme, "#### Notifiche", "\n#### ");
    for (const kind of NOTIFICATION_CHANNEL_KINDS) expect(section.toLowerCase(), kind).toContain(kind);

    const harness = read("HARNESS.md");
    for (const s of ["ADR-0040", "0029_notifications.sql", "docs/runbooks/notifications.md", "outbound-http.ts", "/admin/notifications"]) {
      expect(harness, s).toContain(s);
    }
    const er = read("docs/architecture/diagrams/domain-er-and-boundaries.md");
    for (const s of ["ADR-0040", "0029_notifications.sql", "notification_channels", "notification_channel_alerts", "notification_deliveries",
      "uq_notification_channels_server_kind", "uq_notification_channels_org_kind", "ck_notification_deliveries_pending"]) {
      expect(er, s).toContain(s);
    }
    for (const file of [".agents/brain/state.md", ".agents/brain/decisions.md"]) expect(read(file), file).toContain("ADR-0040");
  });

  it("every guard HARNESS names for ADR-0040 is a test of this tree", () => {
    const lines = read("HARNESS.md").split("\n").filter((l) => l.includes("(`ADR-0040`; guarded by "));
    expect(lines).toHaveLength(1);
    const guards = [...citedPaths(lines[0]!.slice(lines[0]!.indexOf("guarded by ")))];
    expect(guards.length).toBeGreaterThanOrEqual(5);
    for (const p of guards) {
      expect(p, p).toMatch(/\.test\.ts$/);
      expect(existsSync(join(root, p)), p).toBe(true);
    }
  });
});
