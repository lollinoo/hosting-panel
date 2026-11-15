import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAIL_RELAY_IMAGE } from "@hosting-panel/contracts";

const root = resolve(__dirname, "../../..");
const hasHost = existsSync("/sys/fs/cgroup/cgroup.controllers") && spawnSync("bash", ["-c", "command -v docker"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "hp-os-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function detect(id: string, codename: string) {
  const file = join(dir, `${id}-${codename}`);
  writeFileSync(file, `ID=${id}\nVERSION_CODENAME=${codename}\n`);
  return spawnSync(
    "bash",
    ["-c", `export HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
    { cwd: root, encoding: "utf8" }
  );
}

describe("supported OS matrix", () => {
  it.each([
    ["ubuntu", "noble"],
    ["ubuntu", "resolute"],
    ["debian", "bookworm"],
    ["debian", "trixie"]
  ])("accepts %s %s", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${id} ${codename}`);
  });

  it.each([
    ["ubuntu", "jammy"],
    ["debian", "bullseye"]
  ])("rejects %s %s with the supported list", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).not.toBe(0);
    for (const v of ["noble", "resolute", "bookworm", "trixie"]) expect(r.stderr).toContain(v);
  });

  it("honours HP_ALLOW_OTHER_LINUX", () => {
    const file = join(dir, "other");
    writeFileSync(file, "ID=arch\nVERSION_CODENAME=\n");
    const r = spawnSync(
      "bash",
      ["-c", `export HP_ALLOW_OTHER_LINUX=1 HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
      { cwd: root, encoding: "utf8" }
    );
    expect(r.status).toBe(0);
  });
});

describe("platform baselines", () => {
  it("node and traefik baselines", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").startsWith("26")).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node).toBe(">=26.0.0");
    expect(readFileSync(join(root, "apps/docker-executor/src/traefik-config.ts"), "utf8")).toContain('"traefik:v3.7"');
  });
});

describe("per-service env files and wrappers", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const units = ["api", "web", "docker-executor", "host-agent"].map((n) => [n, read(`infra/systemd/hp-${n}.service`)] as const);
  const envFor: Record<string, string | undefined> = { api: "api.env", web: "web.env", "docker-executor": "executor.env" };

  it("each unit loads only its own env file", () => {
    for (const [n, text] of units) {
      const lines = text.split("\n").filter((l) => l.startsWith("EnvironmentFile="));
      const want = envFor[n];
      expect(lines).toEqual(want ? [`EnvironmentFile=/etc/hosting-panel/${want}`] : []);
      expect(text).not.toContain("hosting-panel.env");
    }
  });

  it("units run from the current symlink", () => {
    for (const [, text] of units) {
      const lines = text.split("\n").filter((l) => /^(ExecStart|WorkingDirectory)=/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        for (const p of l.split(/[= ]/).filter((t) => t.startsWith("/opt/"))) expect(p.startsWith("/opt/hosting-panel/current/")).toBe(true);
        expect(l).toContain("/opt/hosting-panel/current/");
      }
    }
  });

  it("web binds to HP_WEB_BIND_ADDRESS", () => {
    const web = read("infra/systemd/hp-web.service");
    expect(web).toContain("--hostname ${HP_WEB_BIND_ADDRESS}");
    // Never an empty placeholder: `next start --hostname ""` listens on all interfaces.
    expect(read("infra/linux/bootstrap-dedicated.sh")).toContain("HP_WEB_BIND_ADDRESS=127.0.0.1");
    expect(web).toMatch(/^After=.*docker\.service/m);
  });

  it.skipIf(!hasHost)("bootstrap dry-run lists the three env files with 0400", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["api.env", "web.env", "executor.env", "0400", "/usr/local/sbin/hp-accounts", "/usr/local/sbin/hp-update"]) expect(r.stdout).toContain(s);
    expect(r.stdout).not.toContain("hosting-panel.env");
  });

  it.skipIf(!hasHost)("bootstrap dry-run provisions the mariadb user, key and data dir", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["hp-mariadb", "mariadb-root.key", "0440", "/var/lib/hosting-panel/mariadb/data"]) expect(r.stdout).toContain(s);
  });

  it("tmpfiles creates the mail relay secret directory", () => {
    const lines = read("infra/systemd/hosting-panel-tmpfiles.conf").split("\n");
    expect(lines).toContain("d /run/hosting-panel/mail-relay 0755 hp-executor hp-executor -");
    expect(lines).toContain("d /run/hosting-panel 3770 root hp-ipc -");
    const boot = read("infra/linux/bootstrap-dedicated.sh");
    expect(boot).toContain("install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-mail\n");
    // Five digits: GNU install keeps the setgid bit inherited from the 3770 parent with a plain 0755.
    expect(boot).toContain("install -d -m 00755 -o hp-executor -g hp-executor /run/hosting-panel/mail-relay\n");
  });

  it.skipIf(!hasHost)("bootstrap dry-run creates the mail directories", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/run/hosting-panel/mail-relay", "/var/lib/hosting-panel/site-mail"]) expect(r.stdout).toContain(s);
  });

  it.skipIf(!hasHost)("bootstrap dry-run provisions the backup encryption key", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/etc/hosting-panel/backup.key", "0440 root:hp-executor"]) expect(r.stdout).toContain(s);
  });

  it("wrappers never put DATABASE_URL in argv", () => {
    for (const w of ["hp-accounts", "hp-break-glass"]) {
      const src = read(`infra/linux/${w}`);
      expect(src).toContain("runuser -u hp-api");
      expect(src).toContain("/usr/bin/node /opt/hosting-panel/current/");
      expect(src).not.toMatch(/node\s[^\n]*"\$DATABASE_URL"/);
    }
    const restore = read("infra/linux/hp-restore-panel");
    expect(restore).toContain('exec bash /opt/hosting-panel/current/infra/linux/restore-panel.sh "$@"');
    expect(restore).not.toContain("DATABASE_URL");
  });

  it.skipIf(!hasHost)("bootstrap dry-run creates the panel copy directory and the restore wrapper", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/var/lib/hosting-panel/panel-dump (2770 root:hp-ipc)", "/usr/local/sbin/hp-restore-panel (0750 root:root)"]) {
      expect(r.stdout).toContain(s);
    }
  });

  it("wrapper parses DATABASE_URL safely and keeps it out of argv", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // Fake runuser: report argv and the environment instead of switching user.
    writeFileSync(join(bin, "runuser"), '#!/usr/bin/env bash\necho "ARGV:$*"\necho "ENV:$DATABASE_URL"\n', { mode: 0o755 });
    const f = join(dir, "api.env");
    const url = "postgres://u:p=a&b@127.0.0.1:5432/db?sslmode=disable&x=1";
    writeFileSync(f, `ENABLE_DEV_OIDC=false\nDATABASE_URL=${url}\n`);
    const r = spawnSync("bash", [join(root, "infra/linux/hp-accounts"), "setup"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HP_API_ENV_FILE: f }
    });
    expect(r.stdout).toContain(`ENV:${url}`);
    expect(r.stdout.split("\n")[0]).not.toContain("postgres://");
    expect(r.stdout.split("\n")[0]).toContain("dist/cli/accounts.js setup");
  });
});

describe("release workflow and docs", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  it("release workflow and docs are consistent", () => {
    const wf = read(".github/workflows/release.yml");
    for (const s of ["tags:", "v*", "release:build", "release:smoke", "gh release create"]) expect(wf).toContain(s);
    const readme = read("README.md");
    for (const s of ["install.sh", "hp-update", "sha256sum -c", "hp-accounts"]) expect(readme).toContain(s);
    expect(readme).not.toContain("export DATABASE_URL=");
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
  });

  it("step 2a docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["WordPress", "mariadb-root.key", "2 GB"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of ["/v1/organizations/{orgId}/managed-sites", "/v1/admin/sites"]) expect(api).toContain(s);
    expect(existsSync(join(root, "docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
  });

  it("step 2b docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Domini e HTTPS", "acme-staging", "HSTS"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/domains",
      "/v1/admin/sites/{siteId}/domains"
    ])
      expect(api).toContain(s);
    expect(existsSync(join(root, "docs/architecture/adr/0017-domains-dns-and-acme-tls.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
  });

  it("step 2c docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Email in uscita", "587"]) expect(readme).toContain(s);
    expect(read("docs/api/openapi.yaml")).toContain("/v1/admin/mail-relay");
    const adr = read("docs/architecture/adr/0018-outgoing-mail-relay.md");
    for (const s of ["CP-01", "postqueue"]) expect(adr).toContain(s);
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
    expect(MAIL_RELAY_IMAGE).toBe("boky/postfix:5.2.1-alpine");
  });

  it("m1a file manager docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Web File Manager dei Siti", "ADR-0019"]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("sftpAvailable: false");
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/files",
      "/files/content",
      "/files/folders",
      "/files/move",
      "/files/delete",
      "/files/archive",
      "/files/extract",
      "ALREADY_EXISTS",
      "site.files.archive",
      "site.files.extract",
      "site.files.read",
      "site.files.write",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0019-site-file-manager.md");
    for (const s of ["hp_files_", "512 KiB", "2 GiB", "site.files.archive"]) {
      expect(adr).toContain(s);
    }
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
  });

  it("m1b site sftp docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Accesso SFTP per Sito", "sftpAvailable: true", "ADR-0020"]) {
      expect(readme).toContain(s);
    }
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users/{userId}/reset-password:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users/{userId}:",
      "site.sftp.manage",
      "CreateSiteSftpUserRequest",
      "SiteSftpDto",
      "SiteSftpUserCreatedDto",
      "SiteSftpPasswordResetDto",
    ]) {
      expect(api).toContain(s);
    }
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/refresh:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/updates:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/administrators/{userId}/password-reset:",
      "SiteWordpressDto:",
      "wordpressToolsAvailable",
      "site.wordpress.update",
      "pre_update",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0020-site-sftp.md");
    for (const s of ["hp_sftp", "2222", "site.sftp.manage", "/var/lib/hosting-panel/sftp"]) {
      expect(adr).toContain(s);
    }
    expect(JSON.parse(read("package.json")).version).toBe("0.5.0");
  });

  it("m2 site databases and phpmyadmin docs are consistent", () => {
    const readme = read("README.md");
    for (const s of [
      "Database per Sito & phpMyAdmin",
      "phpMyAdminAvailable: true",
      "ADR-0021",
      "docs/architecture/adr/0021-site-databases.md",
    ]) {
      expect(readme).toContain(s);
    }
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases/phpmyadmin:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases/{name}:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}/reset-password:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}/grants/{database}:",
      "site.databases.manage",
      "phpMyAdminAvailable",
      "CreateSiteDatabaseRequest",
      "CreateSiteDatabaseUserRequest",
      "SiteDatabaseDto",
      "SiteDatabaseUserDto",
      "SiteDatabasesDto",
      "SiteDatabaseCreatedDto",
      "SiteDatabaseUserCreatedDto",
      "SiteDatabasePasswordResetDto",
      "SiteDatabaseSignOnDto",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0021-site-databases.md");
    for (const s of [
      "ADR 0021",
      "hp_mariadb",
      "hp_phpmyadmin",
      "127.0.0.1",
      "8306",
      "site.databases.manage",
      "phpMyAdminAvailable",
      "/var/lib/hosting-panel/phpmyadmin",
      "CP-01",
    ]) {
      expect(adr).toContain(s);
    }
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/phpmyadmin",
    );
    const envExample = read(".env.example");
    expect(envExample).toContain("HP_PHPMYADMIN_PORT=8306");
  });

  it("m3a backups docs are consistent", () => {
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/admin/backups:",
      "/v1/admin/backups/test:",
      "/v1/admin/backups/sites:",
      "/v1/admin/backups/sites/{siteId}/run:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups:",
      "BackupProblem",
      "BackupSettingsInput",
      "BackupTestResult",
      "BackupSettings",
      "SiteBackup",
      "SiteBackups",
      "AdminSiteBackupStatus",
      "SiteBackupAccepted",
      "site.backups.create",
      "site.backups.prune",
    ]) {
      expect(api).toContain(s);
    }
    expect(api).not.toMatch(
      /productionBackupRuntimeAvailable:\s*\n\s*type:\s*boolean\s*\n\s*(?:const:\s*false|enum:\s*\[false\])/,
    );
  });

  it("m3 site backups docs are consistent", () => {
    const readme = read("README.md");
    for (const s of [
      "Backup dei Siti",
      "productionBackupRuntimeAvailable: true",
      "ADR-0022",
      "docs/architecture/adr/0022-site-backups.md",
      "backup.key",
    ]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("productionBackupRuntimeAvailable: false");
    expect(readme).not.toContain("HCP-SPEC-005");

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    for (const s of [
      "ADR 0022",
      "restic/restic:0.19.1",
      "/etc/hosting-panel/backup.key",
      "site.backups.manage",
      "productionBackupRuntimeAvailable",
      "CP-01",
      "0009_backups.sql",
    ]) {
      expect(adr).toContain(s);
    }

    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain('BACKUP_KEY_PATH="/etc/hosting-panel/backup.key"');
    expect(bootstrap).toContain('chown root:hp-executor "${BACKUP_KEY_PATH}"');

    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/admin/backups:",
      "/v1/admin/backups/test:",
      "/v1/admin/backups/sites:",
      "/v1/admin/backups/sites/{siteId}/run:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups:",
      "BackupProblem",
      "BackupSettingsInput",
      "BackupTestResult",
      "BackupSettings",
      "SiteBackup",
      "SiteBackups",
      "AdminSiteBackupStatus",
      "SiteBackupAccepted",
      "site.backups.create",
      "site.backups.prune",
    ]) {
      expect(api).toContain(s);
    }
  });

  it("m3b restore and download docs are consistent", () => {
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/backups\n",
    );
    if (hasHost) {
      const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("/var/lib/hosting-panel/backups");
    }

    expect(read("infra/systemd/hp-docker-executor.service")).toContain(
      "ReadWritePaths=/var/lib/hosting-panel",
    );
    expect(read("infra/linux/run-dev-docker.mjs")).toContain("HP_BACKUP_WORK_DIR");

    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups/{backupId}/restore:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups/{backupId}/download:",
      "RestoreBackupInput",
      "BackupArchive",
      "BackupLastRestore",
      "BackupArchiveChunk",
      "site.backups.restore",
      "site.backups.download",
      "address_not_updated",
      "undo_incomplete",
      "QUOTA_EXCEEDED",
      "/v1/admin/backups/sites/{siteId}/restore:",
      "AdminRestoreBackupInput",
      "PanelBackupLine",
      "panel.backups.create",
      "panel_dump_failed",
      "site_not_started",
    ]) {
      expect(api).toContain(s);
    }

    const getDownloadBlock = api.slice(
      api.indexOf("operationId: readSiteBackupArchiveChunk"),
      api.indexOf("\ncomponents:"),
    );
    for (const statusCode of ['"422":', '"502":', '"503":']) {
      expect(getDownloadBlock).toContain(statusCode);
    }

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    expect(adr).toContain("0010_backup_restore.sql");
    expect(adr).toContain("APPROVATO — M3a, M3b");
    expect(adr).not.toContain("presa in carico di un repository esistente");

    const readme = read("README.md");
    expect(readme).not.toContain("arrivano con la milestone successiva (**M3b**)");
  });

  it("m3c panel copy docs are consistent", () => {
    const dumpDir = "/var/lib/hosting-panel/panel-dump";
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(`install -d -m 2770 -o root -g hp-ipc ${dumpDir}\nchmod 2770 ${dumpDir}\n`);
    expect(bootstrap).toContain(
      'install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-restore-panel" /usr/local/sbin/hp-restore-panel\n',
    );
    for (const unit of ["hp-api", "hp-docker-executor"]) {
      expect(read(`infra/systemd/${unit}.service`)).toContain(`Environment=HP_PANEL_DUMP_DIR=${dumpDir}\n`);
    }
    expect(read("infra/systemd/hp-api.service")).toContain(`ReadWritePaths=/run/hosting-panel ${dumpDir}\n`);
    expect(read("infra/linux/run-dev-docker.mjs")).toContain("HP_PANEL_DUMP_DIR");

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    for (const s of ["APPROVATO — M3a, M3b, M3c", "0011_panel_backup.sql", "hp-restore-panel", "panel_dump_tool_missing"]) {
      expect(adr).toContain(s);
    }
    expect(adr).not.toContain("(arriva in **M3c**)");

    const readme = read("README.md");
    expect(readme).toContain("hp-restore-panel --endpoint");
    expect(readme).not.toContain("Limite attuale (M3b → M3c)");
  });
});
