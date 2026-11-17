import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITE_TYPES } from "@hosting-panel/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// General files of the five subsystems in every layer: they may not name a site type (ADR 0029, D10).
const SUBSYSTEM_FILES: Readonly<Record<string, readonly string[]>> = {
  files: [
    "apps/api/src/sites/site-files.service.ts", "apps/api/src/sites/site-files-applier.ts", "apps/api/src/controllers/site-files.controller.ts",
    "packages/contracts/src/site-files.ts", "packages/contracts/src/site-files-ipc.ts",
    "apps/docker-executor/src/site-files-helper.ts", "apps/docker-executor/src/site-files-program.ts", "apps/docker-executor/src/simulator-files.ts",
    "apps/web/src/components/customer/files-panel.tsx", "apps/web/src/components/customer/file-dialogs.tsx", "apps/web/src/components/customer/file-editor.tsx",
    "apps/web/src/components/customer/file-list.tsx", "apps/web/src/components/customer/file-uploads.tsx",
    "apps/web/src/lib/bff-files.ts", "apps/web/src/lib/file-browser.ts",
  ],
  sftp: [
    "apps/api/src/sites/site-sftp.service.ts", "apps/api/src/controllers/site-sftp.controller.ts", "packages/contracts/src/site-sftp.ts",
    "apps/docker-executor/src/sftp-platform.ts", "apps/web/src/components/customer/sftp-access.tsx",
    "apps/api/src/sites/sha512-crypt.ts",
  ],
  databases: [
    "apps/api/src/sites/site-databases.service.ts", "apps/api/src/controllers/site-databases.controller.ts", "packages/contracts/src/site-databases.ts",
    "apps/docker-executor/src/site-databases.ts", "apps/docker-executor/src/shared-database.ts", "apps/docker-executor/src/phpmyadmin-platform.ts",
    "apps/docker-executor/src/simulator-databases.ts", "apps/web/src/components/customer/site-databases.tsx",
    "apps/web/src/lib/phpmyadmin-forwarder.ts", "apps/web/src/lib/phpmyadmin-upstream.ts",
  ],
  backups: [
    "apps/api/src/backups/site-backups.service.ts", "apps/api/src/backups/site-backups-applier.ts", "apps/api/src/backups/site-restore-applier.ts",
    "apps/api/src/backups/site-restore.service.ts", "apps/api/src/controllers/site-backups.controller.ts", "packages/contracts/src/backups.ts",
    "apps/docker-executor/src/backup-runner.ts", "apps/docker-executor/src/backup-jobs.ts", "apps/docker-executor/src/restore-jobs.ts",
    "apps/docker-executor/src/panel-jobs.ts", "apps/docker-executor/src/simulator-backups.ts",
    "apps/web/src/components/customer/site-backups.tsx", "apps/web/src/components/customer/restore-backup-dialog.tsx",
    "apps/api/src/backups/backup-retention.ts", "apps/api/src/backups/backup-scheduler.service.ts", "apps/api/src/backups/backup-settings.service.ts",
    "apps/api/src/backups/panel-backup-applier.ts", "apps/api/src/backups/panel-dump.ts", "apps/api/src/controllers/admin-backups.controller.ts",
    "apps/web/src/components/admin/backup-settings.tsx",
  ],
  terminal: [
    "apps/api/src/terminal/admin-terminal.service.ts", "apps/api/src/controllers/admin-terminal.controller.ts", "packages/contracts/src/admin-terminal.ts",
    "apps/docker-executor/src/terminal-docker.ts", "apps/docker-executor/src/terminal-sessions.ts", "apps/docker-executor/src/docker-exec.ts",
    "apps/docker-executor/src/simulator-terminal.ts", "apps/web/src/components/admin/terminal-console.tsx",
    "apps/web/src/lib/terminal-session.ts", "apps/web/src/lib/terminal-text.ts",
  ],
  shared: ["packages/contracts/src/ipc-schemas.ts", "packages/executor-contracts/src/spec.ts"],
};

// Files that decide which site work blocks an update: they name no type either (R206 A3).
const UPDATE_BLOCK_FILES: readonly string[] = ["apps/api/src/host/host-jobs.ts"];

// Web pages and BFF routes of the five subsystems: every .ts/.tsx below each folder is general.
const BFF = "apps/web/src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]";
const SUBSYSTEM_DIRS: readonly string[] = [
  "apps/web/src/app/sites/[siteId]/files", "apps/web/src/app/sites/[siteId]/database", "apps/web/src/app/sites/[siteId]/backups",
  "apps/web/src/app/admin/backups", "apps/web/src/app/admin/sites/[siteId]/terminal",
  "apps/web/src/app/api/admin/backups", "apps/web/src/app/api/admin/terminal", "apps/web/src/app/api/admin/sites/[siteId]/terminal",
  `${BFF}/files`, `${BFF}/sftp`, `${BFF}/databases`, `${BFF}/database-users`, `${BFF}/backups`,
];

/** Every .ts/.tsx file below the subsystem folders, relative to the root. */
async function dirFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of SUBSYSTEM_DIRS) {
    for (const f of await readdir(path.join(ROOT, dir), { recursive: true })) if (/\.tsx?$/.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}

// Catalog groups of the general tabs: [file, top-level key, group key].
const CATALOG_GROUPS = (["en", "it"] as const).flatMap((c) => [
  [`apps/web/src/i18n/${c}.ts`, "site", "files"], [`apps/web/src/i18n/${c}.ts`, "site", "database"],
  [`apps/web/src/i18n/${c}.ts`, "site", "backups"], [`apps/web/src/i18n/${c}.ts`, "admin", "terminal"],
] as const);

const WORDS = /wordpress|wp-|wp_/i;
// The executor module's own values that carry none of the words (B's module, by name).
const MODULE_VALUES = [".maintenance", "mu-plugins", "www-data"];
const VALUES = [
  ...Object.values(SITE_TYPES).flatMap((d) => [`"${d.files.volumeSuffix}"`, d.files.mountPath, d.files.owner, d.templateId]),
  // The database name prefix of a type, as a quoted literal ("wp").
  ...Object.values(SITE_TYPES).flatMap((d) => (d.database ? [`"${d.database.namePrefix}"`] : [])),
  ...MODULE_VALUES,
];

// Lines allowed to hold a word or a value, each with its reason; matched by file and text (whole trimmed line when exact), not line number.
const ALLOW: readonly { readonly file: string; readonly text: string; readonly reason: string; readonly exact?: boolean }[] = [
  { file: "apps/web/src/lib/file-browser.ts", text: '"html",', reason: "an editable file extension", exact: true },
  { file: "apps/docker-executor/src/phpmyadmin-platform.ts", text: "33:33", reason: "the phpMyAdmin image's own user" },
  { file: "apps/docker-executor/src/phpmyadmin-platform.ts", text: "/var/www/html/tmp", reason: "the phpMyAdmin image's own directory" },
  { file: "packages/contracts/src/ipc-schemas.ts", text: '"wordpress.', reason: "job kinds of the type in the shared job-kind enum (wiring, ADR 0029)" },
  // R205 addendum 5: the panel's own restic containers touch no site file.
  { file: "apps/docker-executor/src/backup-jobs.ts", text: 'export const BACKUP_RESTIC_USER = "33:33"', reason: "user of the restic containers that touch no site file (R205 addendum 5)" },
];

/** Lines of one file that name a site type, as "file:line hit". */
export function siteTypeViolations(rel: string, text: string, firstLine = 1): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const hit = WORDS.exec(line)?.[0] ?? VALUES.find((v) => line.includes(v));
    if (hit && !ALLOW.some((a) => a.file === rel && (a.exact ? line.trim() === a.text : line.includes(a.text)))) out.push(`${rel}:${firstLine + i} ${hit}`);
  });
  return out;
}

/** One group of a catalog, found by its indentation. */
function catalogGroup(text: string, top: string, group: string): { readonly start: number; readonly body: string } {
  const lines = text.split("\n");
  const t = lines.indexOf(`  ${top}: {`);
  const s = lines.findIndex((l, i) => i > t && l === `    ${group}: {`);
  const e = lines.findIndex((l, i) => i > s && l === "    },");
  expect([t, s, e].every((n) => n >= 0), `${top}.${group}`).toBe(true);
  return { start: s + 1, body: lines.slice(s, e + 1).join("\n") };
}

describe("site-type boundary (ADR 0029, D10)", () => {
  it("the guard fails on each forged line", () => {
    for (const line of ['kind: "wordpress.set-url",', "const p = `wp_${h}`;", '"wp-config.php"', 'path: "/var/www/html",',
      'owner: "33:33"', 'suffix: "html"', '"tpl_site_wordpress"', "WordPress", '".maintenance"', '"mu-plugins"',
      'user: "www-data",', 'namePrefix: "wp",', 'heavy: ["site.wordpress.update"],']) {
      expect(siteTypeViolations("x.ts", line), line).not.toEqual([]);
    }
    expect(siteTypeViolations("x.ts", 'const ok = "html5";\nconst t = definition.files.mountPath;\nconst q = "wpx";')).toEqual([]);
  });

  it("the allow line of file-browser.ts covers that exact line only (R206 addendum 2)", () => {
    const rel = "apps/web/src/lib/file-browser.ts";
    expect(siteTypeViolations(rel, '  "html",')).toEqual([]);
    expect(siteTypeViolations(rel, '  "html", "/var/www/html",')).not.toEqual([]);
  });

  it("every listed file exists, and every subsystem folder holds files", async () => {
    for (const rel of [...Object.values(SUBSYSTEM_FILES).flat(), ...UPDATE_BLOCK_FILES, ...new Set(CATALOG_GROUPS.map((g) => g[0]))]) {
      await expect(access(path.join(ROOT, rel)), rel).resolves.toBeUndefined();
    }
    expect((await dirFiles()).length).toBeGreaterThanOrEqual(SUBSYSTEM_DIRS.length);
  });

  it("the five subsystems name no site type", async () => {
    const found: string[] = [];
    for (const rel of [...Object.values(SUBSYSTEM_FILES).flat(), ...UPDATE_BLOCK_FILES, ...(await dirFiles())]) {
      found.push(...siteTypeViolations(rel, await readFile(path.join(ROOT, rel), "utf8")));
    }
    expect(found).toEqual([]);
  });

  it("the catalog groups of the general tabs name no site type", async () => {
    const found: string[] = [];
    for (const [file, top, group] of CATALOG_GROUPS) {
      const { start, body } = catalogGroup(await readFile(path.join(ROOT, file), "utf8"), top, group);
      found.push(...siteTypeViolations(file, body, start));
    }
    expect(found).toEqual([]);
  });
});
