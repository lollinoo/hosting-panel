import { chmod, lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PHP_VERSION,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  resolveWordpressImage,
  siteDatabasePrefix,
  type BackupTarget,
} from "@hosting-panel/contracts";
import { BACKUP_DISK_FREE_FLOOR_BYTES, BACKUP_JOB_MEMORY_BYTES, BACKUP_TMPFS } from "../src/backup-jobs.js";
import {
  ARCHIVE_EXIT_CODES,
  ARCHIVE_SCRIPT,
  BACKUP_ARCHIVE_TTL_MS,
  BACKUP_RESTORE_FETCH_TIMEOUT_MS,
  BACKUP_RESTORE_FILES_TIMEOUT_MS,
  BACKUP_RESTORE_FINISH_TIMEOUT_MS,
  BACKUP_RESTORE_LOCK_WAIT_S,
  BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
  BACKUP_RESTORE_SETTLE_START_MS,
  BACKUP_RESTORE_SWITCH_TIMEOUT_MS,
  BACKUP_RESTORE_UNDO_TIMEOUT_MS,
  BACKUP_ARCHIVE_TIMEOUT_MS,
  RESTORE_EXIT_DB_IMPORT_FAILED,
  RESTORE_EXIT_DB_UNREACHABLE,
  RESTORE_EXIT_DEFINER_MISSING,
  RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF,
  RESTORE_EXIT_FILES_PLAN_EXISTS,
  RESTORE_EXIT_FINISH_CLEANUP_FAILED,
  RESTORE_EXIT_GATE_REMOVE_FAILED,
  RESTORE_EXIT_INVALID_DB_NAME,
  RESTORE_EXIT_INVALID_FILENAMES,
  RESTORE_EXIT_INVALID_OBJECT_NAME,
  RESTORE_EXIT_NO_SPACE,
  RESTORE_EXIT_TIMEOUT,
  RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY,
  RESTORE_FETCH_EXIT_CODES,
  RESTORE_FILES_EXIT_CODES,
  RESTORE_FINISH_EXIT_CODES,
  RESTORE_PREPARE_EXIT_CODES,
  RESTORE_SWITCH_EXIT_CODES,
  RESTORE_UNDO_EXIT_CODES,
  buildArchiveContainerPayload,
  buildRestoreDbScript,
  buildRestoreFetchScript,
  buildRestoreFilesScript,
  buildRestoreFetchContainerPayload,
  buildRestoreFilesContainerPayload,
  buildRestoreFinishContainerPayload,
  buildRestorePrepareContainerPayload,
  buildRestoreSwitchContainerPayload,
  buildRestoreUndoDbContainerPayload,
  buildRestoreUndoFilesContainerPayload,
  classifyArchiveExitCode,
  classifyRestoreFetchExitCode,
  classifyRestoreFilesExitCode,
  classifyRestoreFinishExitCode,
  classifyRestorePrepareExitCode,
  classifyRestoreSwitchExitCode,
  classifyRestoreUndoExitCode,
  readRestoreNote,
  writeRestoreNote,
  type BackupContainerSpec,
  type RestoreNote,
} from "../src/restore-jobs.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE as WP } from "../src/site-types/index.js";
import { RESTORE_MAINTENANCE_FILE_CONTENT } from "../src/site-types/wordpress-restore.js";

const RESTORE_DB_SCRIPT = buildRestoreDbScript(WP);
const RESTORE_FETCH_SCRIPT = buildRestoreFetchScript(WP);
const RESTORE_FILES_SCRIPT = buildRestoreFilesScript(WP);

const JOB_ID = "op_0123456789abcdef0123456789abcdef";
const HEX_ID = "0123456789abcdef0123456789abcdef";
const OTHER_JOB_ID = "op_fedcba9876543210fedcba9876543210";
const SITE_ID = "site_ab12cd34ef56";
const SERVICE_ID = "site_ab12cd34ef56";
const SNAPSHOT_ID = "a".repeat(64);
const STAGING_VOL = `hp_bk_${JOB_ID}`;
const SITE_VOL = `hp_vol_${SERVICE_ID}_html`;
const BACKUP_NET = "hp_net_backup";
const SHARED_DB_NET = "hp_net_shared_db";

const SECRET_SENTINELS = [
  "FAKE_ACCESS_KEY_SENTINEL_12345",
  "FAKE_SECRET_KEY_SENTINEL_67890",
  "FAKE_BACKUP_ENCRYPTION_KEY_SENTINEL_ABCDEF",
  "FAKE_MARIADB_ROOT_PASSWORD_SENTINEL_XYZ",
];

const TARGET: BackupTarget = {
  endpoint: "https://s3.eu-central-1.wasabisys.com",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: SECRET_SENTINELS[0]!,
  secretAccessKey: SECRET_SENTINELS[1]!,
};

const RESTIC_SECRET_BINDS = [
  "/run/hosting-panel/secrets/job/AWS_SHARED_CREDENTIALS_FILE:/run/secrets/AWS_SHARED_CREDENTIALS_FILE:ro",
  "/run/hosting-panel/secrets/job/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro",
];
const RESTIC_SECRET_ENV = [
  "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/AWS_SHARED_CREDENTIALS_FILE",
  "RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD",
];

const DB_SECRET_BINDS = ["/run/hosting-panel/secrets/job/MARIADB_ROOT:/run/secrets/MARIADB_ROOT:ro"];
const DB_SECRET_ENV = ["MARIADB_ROOT_FILE=/run/secrets/MARIADB_ROOT"];

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hp-restore-jobs-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertHardenedContainer(spec: BackupContainerSpec): void {
  const { payload } = spec;
  expect(payload.HostConfig.Privileged).toBe(false);
  expect(payload.HostConfig.ReadonlyRootfs).toBe(true);
  expect(payload.HostConfig.CapDrop).toEqual(["ALL"]);
  expect(payload.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
  expect(payload.HostConfig.PidsLimit).toBe(128);
  expect(payload.HostConfig.NanoCpus).toBe(1_000_000_000);
  expect(payload.HostConfig.Memory).toBe(BACKUP_JOB_MEMORY_BYTES);
  expect(payload.HostConfig.MemorySwap).toBe(BACKUP_JOB_MEMORY_BYTES);
  expect(payload.HostConfig.Tmpfs).toEqual({ "/tmp": BACKUP_TMPFS });
  expect(payload.HostConfig.RestartPolicy).toEqual({ Name: "no" });
  expect(payload.HostConfig.Binds.some((b) => b.includes("docker.sock"))).toBe(false);
  expect(payload.Labels["io.hostingpanel.managed"]).toBe("true");
  expect(payload.Labels["io.hostingpanel.site_id"]).toBe(SITE_ID);
  expect(payload.Labels["io.hostingpanel.job_id"]).toBe(JOB_ID);
  const serialized = JSON.stringify({
    Env: payload.Env,
    Cmd: payload.Cmd,
    Entrypoint: payload.Entrypoint,
    Labels: payload.Labels,
  });
  for (const sentinel of SECRET_SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("restore-jobs constants and scripts", () => {
  it("exports E14 time limits and unique named exit codes", () => {
    expect(BACKUP_RESTORE_FETCH_TIMEOUT_MS).toBe(7_200_000);
    expect(BACKUP_RESTORE_PREPARE_TIMEOUT_MS).toBe(3_600_000);
    expect(BACKUP_RESTORE_SWITCH_TIMEOUT_MS).toBe(120_000);
    expect(BACKUP_RESTORE_FILES_TIMEOUT_MS).toBe(60_000);
    expect(BACKUP_RESTORE_UNDO_TIMEOUT_MS).toBe(300_000);
    expect(BACKUP_RESTORE_FINISH_TIMEOUT_MS).toBe(1_800_000);
    expect(BACKUP_RESTORE_LOCK_WAIT_S).toBe(5);
    expect(BACKUP_RESTORE_SETTLE_START_MS).toBe(150_000);
    expect(BACKUP_ARCHIVE_TIMEOUT_MS).toBe(7_200_000);
    expect(BACKUP_ARCHIVE_TTL_MS).toBe(3_600_000);

    const exitCodes = [
      RESTORE_EXIT_DB_UNREACHABLE,
      RESTORE_EXIT_NO_SPACE,
      RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF,
      RESTORE_EXIT_INVALID_DB_NAME,
      RESTORE_EXIT_DB_IMPORT_FAILED,
      RESTORE_EXIT_DEFINER_MISSING,
      RESTORE_EXIT_INVALID_OBJECT_NAME,
      RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY,
      RESTORE_EXIT_FILES_PLAN_EXISTS,
      RESTORE_EXIT_INVALID_FILENAMES,
      RESTORE_EXIT_GATE_REMOVE_FAILED,
      RESTORE_EXIT_FINISH_CLEANUP_FAILED,
      RESTORE_EXIT_TIMEOUT,
    ];
    expect(new Set(exitCodes).size).toBe(exitCodes.length);
    expect(RESTORE_EXIT_GATE_REMOVE_FAILED).not.toBe(RESTORE_EXIT_FINISH_CLEANUP_FAILED);
    expect(RESTORE_MAINTENANCE_FILE_CONTENT).toBe("<?php $upgrading = time(); ?>");
  });

  it("embeds required SQL, atomic mv, mail plugin, scheduler, and R77/R79/R81 safeguards", () => {
    expect(RESTORE_DB_SCRIPT).toContain("lock_wait_timeout");
    expect(RESTORE_DB_SCRIPT).toContain("RENAME TABLE");
    expect(RESTORE_DB_SCRIPT).toContain("event_scheduler");
    expect(RESTORE_DB_SCRIPT).toContain(RESTORE_MAINTENANCE_FILE_CONTENT);
    expect(RESTORE_DB_SCRIPT).toContain("/var/tmp/c");
    expect(RESTORE_DB_SCRIPT).toContain("gate_recorded");
    expect(RESTORE_DB_SCRIPT).toContain("gate_kept");
    expect(RESTORE_DB_SCRIPT).toContain(`exit ${RESTORE_EXIT_GATE_REMOVE_FAILED}`);

    expect(RESTORE_FILES_SCRIPT).toContain("mv --exchange -T");
    expect(RESTORE_FILES_SCRIPT).toContain("hp-mail.php");
    expect(RESTORE_FILES_SCRIPT).toContain("wp-content/mu-plugins");
    expect(RESTORE_FILES_SCRIPT).not.toContain("exit 94");

    expect(RESTORE_FETCH_SCRIPT).not.toContain("exit 94");
    expect(RESTORE_FETCH_SCRIPT).toContain("/var/www/html/.hp_rs_");
    expect(RESTORE_FETCH_SCRIPT).toContain("/var/tmp/c");
    expect(RESTORE_FETCH_SCRIPT).toContain(":/backup/files");
    expect(RESTORE_FETCH_SCRIPT).toContain(":/backup/databases");

    expect(ARCHIVE_SCRIPT).toContain("restic");
    expect(ARCHIVE_SCRIPT).toContain("dump --archive zip");
    expect(ARCHIVE_SCRIPT).toContain("s3.bucket-lookup=path");
  });

  it("enforces R77 in RESTORE_DB_SCRIPT: touches nothing under /var/www/html except .maintenance* and .hp_rs_<H>", () => {
    // Strip the header definitions and assert every $W reference in RESTORE_DB_SCRIPT is strictly
    // $W itself (sync/df), $W/.maintenance(.hp.*), or $W/.hp_rs_$HP_H ($R).
    const refs = [...RESTORE_DB_SCRIPT.matchAll(/(?:\$W|\/var\/www\/html)(\/[^\s"'`;)]+)?/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const match of refs) {
      const suffix = match[1];
      if (!suffix) continue;
      expect(suffix).toMatch(/^\/(?:\.maintenance(?:\.hp\.\$\$)?|\.hp_rs_\$HP_H)$/);
    }
    expect(RESTORE_DB_SCRIPT).not.toContain("wp-config");
    expect(RESTORE_DB_SCRIPT).not.toContain("wp-content");
    expect(RESTORE_DB_SCRIPT).not.toContain("$R/c");
  });

  it("enforces R88-R92 safeguards in RESTORE_DB_SCRIPT", () => {
    // R88: safe SQL construction, control-char/backslash check, quoted -- view args
    expect(RESTORE_DB_SCRIPT).toContain("EXECUTE IMMEDIATE");
    expect(RESTORE_DB_SCRIPT).toContain("append_renames");
    expect(RESTORE_DB_SCRIPT).toContain("check_obj_names");
    expect(RESTORE_DB_SCRIPT).toContain("while IFS= read -r v; do");
    expect(RESTORE_DB_SCRIPT).toContain('-- "$@"');
    expect(RESTORE_DB_SCRIPT).toContain(`exit ${RESTORE_EXIT_INVALID_OBJECT_NAME}`);
    expect(RESTORE_DB_SCRIPT).not.toContain("for t in $ts");
    expect(RESTORE_DB_SCRIPT).not.toContain("for s in $schemas");
    expect(RESTORE_DB_SCRIPT).not.toContain("$D0 \"$1\" $v");

    // R89 & R90: undo gates on $S/gate_recorded only; gate_kept preserves .maintenance atomically via cp -aP
    const undoSection = RESTORE_DB_SCRIPT.slice(RESTORE_DB_SCRIPT.indexOf("undo)"), RESTORE_DB_SCRIPT.indexOf("finish)"));
    expect(undoSection).not.toContain("record_gate");
    expect(undoSection).toContain('[ ! -f "$S/gate_recorded" ] || gate_on');
    expect(undoSection).toContain('[ ! -f "$S/gate_recorded" ] || restore_gate');
    expect(RESTORE_DB_SCRIPT).toContain('cp -aP "$W/.maintenance" "$S/gate_kept.tmp"');
    expect(RESTORE_DB_SCRIPT).toContain('cp -aP "$S/gate_kept" "$tmp_gate"');
    expect(RESTORE_DB_SCRIPT).toContain('[ -L "$W/.maintenance" ] || [ -f "$W/.maintenance" ]');

    // R91 & R92(1): prepare strips own DB qualifier outside INSERT/REPLACE and replays dumps with --sandbox --binary-mode
    expect(RESTORE_DB_SCRIPT).toContain("strip_db_qual");
    expect(RESTORE_DB_SCRIPT).toContain("run_m_sql()");
    expect(RESTORE_DB_SCRIPT).toContain("--sandbox --binary-mode");
  });
});

// Runs the script's strip_db_qual shell function (host awk) on a dump text.
function runStrip(db: string, input: string): { status: number | null; out: string } {
  const lines = RESTORE_DB_SCRIPT.split("\n");
  const start = lines.indexOf("strip_db_qual() {");
  const end = lines.indexOf("}", start);
  const fn = lines.slice(start, end + 1).join("\n");
  const r = spawnSync("sh", ["-c", `${fn}\nstrip_db_qual "$1"`, "sh", db], { input, encoding: "utf8" });
  return { status: r.status, out: r.stdout };
}

describe("restore-jobs strip_db_qual (R88/R91)", () => {
  const DB = "wp_aaaaaaaaaaaa";
  const HDR = "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER";

  it("never touches a quoted name that only contains the database qualifier", () => {
    const dump = [
      "CREATE TABLE `wp_aaaaaaaaaaaa.t(i int);CREATE DATABASE hp_pwnq;#` (",
      "  `id` int(11) DEFAULT NULL",
      ");",
      "INSERT INTO `x` VALUES (1,'wp_aaaaaaaaaaaa.y');",
      "",
    ].join("\n");
    expect(runStrip(DB, dump)).toEqual({ status: 0, out: dump });
  });

  it("drops the own-database qualifier from a trigger header only, keeping the body", () => {
    const dump = [
      "DELIMITER ;;",
      `${HDR}`,
      "  wp_aaaaaaaaaaaa.`tr ``2`",
      "  before insert or update ON `wp_aaaaaaaaaaaa`.src FOR EACH ROW INSERT INTO wp_aaaaaaaaaaaa.aud(tag) VALUES('a') ",
      "*/;;",
      `${HDR} "wp_aaaaaaaaaaaa"."t3" AFTER DELETE ON src FOR EACH ROW SET @x=1 `,
      "*/;;",
      "DELIMITER ;",
      "",
    ].join("\n");
    expect(runStrip(DB, dump)).toEqual({
      status: 0,
      out: [
        "DELIMITER ;;",
        `${HDR}`,
        "  `tr ``2`",
        "  before insert or update ON src FOR EACH ROW INSERT INTO wp_aaaaaaaaaaaa.aud(tag) VALUES('a') ",
        "*/;;",
        `${HDR} "t3" AFTER DELETE ON src FOR EACH ROW SET @x=1 `,
        "*/;;",
        "DELIMITER ;",
        "",
      ].join("\n"),
    });
  });

  // Header forms as mariadb-dump 12.3.3 writes them (R100); the rest of the text stays byte-identical.
  it.each([
    [
      "IF NOT EXISTS and an unquoted non-ASCII name",
      `${HDR} IF\nNOT  EXISTS wp_aaaaaaaaaaaa.tr_é BEFORE INSERT ON wp_aaaaaaaaaaaa.t FOR EACH ROW SET @a=1 \n*/;;\n`,
      `${HDR} IF\nNOT  EXISTS tr_é BEFORE INSERT ON t FOR EACH ROW SET @a=1 \n*/;;\n`,
    ],
    [
      "no whitespace next to quoted names",
      `${HDR}\`wp_aaaaaaaaaaaa\`.\`tr\`BEFORE DELETE ON\`wp_aaaaaaaaaaaa\`.\`t\`FOR EACH ROW SET @e=1 \n*/;;\n`,
      `${HDR}\`tr\`BEFORE DELETE ON\`t\`FOR EACH ROW SET @e=1 \n*/;;\n`,
    ],
    [
      "lower-case keywords",
      `${HDR.replace("TRIGGER", "trigger")} wp_aaaaaaaaaaaa.tr after delete on wp_aaaaaaaaaaaa.t for each row set @f=1 \n*/;;\n`,
      `${HDR.replace("TRIGGER", "trigger")} tr after delete on t for each row set @f=1 \n*/;;\n`,
    ],
    [
      "a name starting with IF and spaces around the dot",
      `${HDR} iffy AFTER INSERT ON wp_aaaaaaaaaaaa\n.\nt FOR EACH ROW SET @i=1 \n*/;;\n`,
      `${HDR} iffy AFTER INSERT ON t FOR EACH ROW SET @i=1 \n*/;;\n`,
    ],
  ])("accepts a trigger header with %s", (_label, dump, out) => {
    expect(runStrip(DB, dump)).toEqual({ status: 0, out });
  });

  it.each([
    ["another database", `${HDR} wp_bbbbbbbbbbbb.t1 AFTER INSERT ON src FOR EACH ROW SET @x=1 \n*/;;\n`],
    ["a comment before ON", `${HDR} t1 AFTER DELETE /* c2 */ ON wp_aaaaaaaaaaaa.src FOR EACH ROW SET @x=1 \n*/;;\n`],
    ["no trigger keyword", "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGR t1 AFTER INSERT ON src FOR\n*/;;\n"],
    ["another database on the table", `${HDR} t1 AFTER INSERT ON other.src FOR EACH ROW SET @x=1 \n*/;;\n`],
    ["a comment in the header", `${HDR} t1 /*x*/ AFTER INSERT ON src FOR EACH ROW SET @x=1 \n*/;;\n`],
    ["a header cut at the end of the dump", `${HDR} t1 AFTER INSERT\n`],
  ])("fails closed on a trigger header with %s", (_label, dump) => {
    expect(runStrip(DB, dump).status).not.toBe(0);
  });
});

describe("restore-jobs container payload builders", () => {
  it("builds hardened _rs_fetch payload with both volumes, restic image, user 33:33, and no MariaDB secret", () => {
    const spec = buildRestoreFetchContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      snapshotId: SNAPSHOT_ID,
      target: TARGET,
      backupNetworkName: BACKUP_NET,
      secretBinds: RESTIC_SECRET_BINDS,
      secretFileEnv: RESTIC_SECRET_ENV,
      stagingVolumeName: STAGING_VOL,
    });

    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_rs_fetch`);
    expect(spec.payload.Image).toBe(RESTIC_IMAGE);
    expect(spec.payload.User).toBe("33:33");
    expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", RESTORE_FETCH_SCRIPT]);
    expect(spec.payload.HostConfig.NetworkMode).toBe(BACKUP_NET);
    expect(spec.payload.HostConfig.Binds).toEqual([
      `${SITE_VOL}:/var/www/html`,
      `${STAGING_VOL}:/var/tmp`,
      ...RESTIC_SECRET_BINDS,
    ]);
    expect(spec.payload.Env).toContain(`HP_SNAP=${SNAPSHOT_ID}`);
    expect(spec.payload.Env).toContain(`HP_H=${HEX_ID}`);
    expect(spec.payload.Env).toContain(`HP_FLOOR=${BACKUP_DISK_FREE_FLOOR_BYTES}`);
    expect(spec.payload.Env).toContain("HP_REGION=eu-central-1");
    assertHardenedContainer(spec);
  });

  it("builds hardened _rs_prepare payload with staging volume ONLY (no site volume)", () => {
    const spec = buildRestorePrepareContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      stagingVolumeName: STAGING_VOL,
      sharedDbNetworkName: SHARED_DB_NET,
      secretBinds: DB_SECRET_BINDS,
      secretFileEnv: DB_SECRET_ENV,
    });

    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_rs_prepare`);
    expect(spec.payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(spec.payload.User).toBe("33:33");
    expect(spec.payload.Cmd).toEqual(["sh", "-c", RESTORE_DB_SCRIPT]);
    expect(spec.payload.HostConfig.NetworkMode).toBe(SHARED_DB_NET);
    expect(spec.payload.HostConfig.Binds).toEqual([`${STAGING_VOL}:/var/tmp`, ...DB_SECRET_BINDS]);
    expect(spec.payload.HostConfig.Binds.some((b) => b.includes("/var/www/html"))).toBe(false);
    expect(spec.payload.HostConfig.Binds.some((b) => b.includes(SITE_VOL))).toBe(false);
    expect(spec.payload.Env).toContain("HP_STEP=prepare");
    expect(spec.payload.Env).toContain(`HP_H=${HEX_ID}`);
    expect(spec.payload.Env).toContain(`HP_PREFIX=${siteDatabasePrefix(SITE_ID)}`);
    expect(spec.payload.Env).toContain(`HP_LOCK_S=${BACKUP_RESTORE_LOCK_WAIT_S}`);
    assertHardenedContainer(spec);
  });

  it("builds hardened _rs_switch, _rs_finish, and _rs_undo_db payloads with exact mounts", () => {
    const switchSpec = buildRestoreSwitchContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      stagingVolumeName: STAGING_VOL,
      sharedDbNetworkName: SHARED_DB_NET,
      secretBinds: DB_SECRET_BINDS,
      secretFileEnv: DB_SECRET_ENV,
    });
    expect(switchSpec.containerName).toBe(`hp_bk_${JOB_ID}_rs_switch`);
    expect(switchSpec.payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(switchSpec.payload.User).toBe("33:33");
    expect(switchSpec.payload.HostConfig.NetworkMode).toBe(SHARED_DB_NET);
    expect(switchSpec.payload.HostConfig.Binds).toEqual([
      `${SITE_VOL}:/var/www/html`,
      `${STAGING_VOL}:/var/tmp`,
      ...DB_SECRET_BINDS,
    ]);
    expect(switchSpec.payload.Env).toContain("HP_STEP=switch");
    assertHardenedContainer(switchSpec);

    const finishSpec = buildRestoreFinishContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      sharedDbNetworkName: SHARED_DB_NET,
      secretBinds: DB_SECRET_BINDS,
      secretFileEnv: DB_SECRET_ENV,
    });
    expect(finishSpec.containerName).toBe(`hp_bk_${JOB_ID}_rs_finish`);
    expect(finishSpec.payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(finishSpec.payload.User).toBe("33:33");
    expect(finishSpec.payload.HostConfig.NetworkMode).toBe(SHARED_DB_NET);
    expect(finishSpec.payload.HostConfig.Binds).toEqual([
      `${SITE_VOL}:/var/www/html`,
      ...DB_SECRET_BINDS,
    ]);
    expect(finishSpec.payload.Env).toContain("HP_STEP=finish");
    assertHardenedContainer(finishSpec);

    const undoDbSpec = buildRestoreUndoDbContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      stagingVolumeName: STAGING_VOL,
      sharedDbNetworkName: SHARED_DB_NET,
      secretBinds: DB_SECRET_BINDS,
      secretFileEnv: DB_SECRET_ENV,
    });
    expect(undoDbSpec.containerName).toBe(`hp_bk_${JOB_ID}_rs_undo_db`);
    expect(undoDbSpec.payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(undoDbSpec.payload.User).toBe("33:33");
    expect(undoDbSpec.payload.HostConfig.NetworkMode).toBe(SHARED_DB_NET);
    expect(undoDbSpec.payload.HostConfig.Binds).toEqual([
      `${SITE_VOL}:/var/www/html`,
      `${STAGING_VOL}:/var/tmp`,
      ...DB_SECRET_BINDS,
    ]);
    expect(undoDbSpec.payload.Env).toContain("HP_STEP=undo");
    assertHardenedContainer(undoDbSpec);
  });

  it("builds hardened _rs_files and _rs_undo_files payloads with network none, no staging, no secrets", () => {
    const filesSpec = buildRestoreFilesContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
    });
    expect(filesSpec.containerName).toBe(`hp_bk_${JOB_ID}_rs_files`);
    expect(filesSpec.payload.Image).toBe(resolveWordpressImage(DEFAULT_PHP_VERSION));
    expect(filesSpec.payload.User).toBe("33:33");
    expect(filesSpec.payload.HostConfig.NetworkMode).toBe("none");
    expect(filesSpec.payload.HostConfig.Binds).toEqual([`${SITE_VOL}:/var/www/html`]);
    expect(filesSpec.payload.Env).toEqual(["HP_STEP=switch", `HP_H=${HEX_ID}`]);
    assertHardenedContainer(filesSpec);

    const undoFilesSpec = buildRestoreUndoFilesContainerPayload({
      siteType: WP,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
    });
    expect(undoFilesSpec.containerName).toBe(`hp_bk_${JOB_ID}_rs_undo_files`);
    expect(undoFilesSpec.payload.Image).toBe(resolveWordpressImage(DEFAULT_PHP_VERSION));
    expect(undoFilesSpec.payload.User).toBe("33:33");
    expect(undoFilesSpec.payload.HostConfig.NetworkMode).toBe("none");
    expect(undoFilesSpec.payload.HostConfig.Binds).toEqual([`${SITE_VOL}:/var/www/html`]);
    expect(undoFilesSpec.payload.Env).toEqual(["HP_STEP=undo", `HP_H=${HEX_ID}`]);
    assertHardenedContainer(undoFilesSpec);
  });

  it("builds hardened _zip payload with executorUser, archive dir bind ONLY, and no site or MariaDB secret", () => {
    const spec = buildArchiveContainerPayload({
      jobId: JOB_ID,
      siteId: SITE_ID,
      snapshotId: SNAPSHOT_ID,
      target: TARGET,
      executorUser: "1001:1001",
      archivesHostDir: "/var/lib/hosting-panel/backups/archives",
      backupNetworkName: BACKUP_NET,
      secretBinds: RESTIC_SECRET_BINDS,
      secretFileEnv: RESTIC_SECRET_ENV,
    });

    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_zip`);
    expect(spec.payload.Image).toBe(RESTIC_IMAGE);
    expect(spec.payload.User).toBe("1001:1001");
    expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", ARCHIVE_SCRIPT]);
    expect(spec.payload.HostConfig.NetworkMode).toBe(BACKUP_NET);
    expect(spec.payload.HostConfig.Binds).toEqual([
      "/var/lib/hosting-panel/backups/archives:/a",
      ...RESTIC_SECRET_BINDS,
    ]);
    expect(spec.payload.HostConfig.Binds.some((b) => b.includes("/var/www/html"))).toBe(false);
    expect(spec.payload.HostConfig.Binds.some((b) => b.includes("/var/tmp"))).toBe(false);
    expect(spec.payload.HostConfig.Binds.some((b) => b.includes("MARIADB"))).toBe(false);
    expect(spec.payload.Env.some((e) => e.includes("MARIADB"))).toBe(false);
    expect(spec.payload.Env).toContain(`HP_JOB=${JOB_ID}`);
    expect(spec.payload.Env).toContain(`HP_SNAP=${SNAPSHOT_ID}`);
    assertHardenedContainer(spec);
  });

  it("rejects -forget jobIds, docker.sock binds, bad secret mounts, and mismatched step secrets", () => {
    expect(() =>
      buildRestorePrepareContainerPayload({
        siteType: WP,
        jobId: `${JOB_ID}-forget`,
        siteId: SITE_ID,
        stagingVolumeName: STAGING_VOL,
        sharedDbNetworkName: SHARED_DB_NET,
        secretBinds: DB_SECRET_BINDS,
        secretFileEnv: DB_SECRET_ENV,
      }),
    ).toThrow(/jobId/i);

    expect(() =>
      buildArchiveContainerPayload({
        jobId: JOB_ID,
        siteId: SITE_ID,
        snapshotId: SNAPSHOT_ID,
        target: TARGET,
        executorUser: "1001:1001",
        archivesHostDir: "/var/run/docker.sock",
        backupNetworkName: BACKUP_NET,
        secretBinds: RESTIC_SECRET_BINDS,
        secretFileEnv: RESTIC_SECRET_ENV,
      }),
    ).toThrow(/docker\.sock|archivesHostDir/i);

    expect(() =>
      buildArchiveContainerPayload({
        jobId: JOB_ID,
        siteId: SITE_ID,
        snapshotId: SNAPSHOT_ID,
        target: TARGET,
        executorUser: "1001:1001",
        archivesHostDir: "/var/lib/hosting-panel/backups/archives",
        backupNetworkName: BACKUP_NET,
        secretBinds: [...RESTIC_SECRET_BINDS, ...DB_SECRET_BINDS],
        secretFileEnv: [...RESTIC_SECRET_ENV, ...DB_SECRET_ENV],
      }),
    ).toThrow(/secret/i);

    expect(() =>
      buildRestorePrepareContainerPayload({
        siteType: WP,
        jobId: JOB_ID,
        siteId: SITE_ID,
        stagingVolumeName: STAGING_VOL,
        sharedDbNetworkName: SHARED_DB_NET,
        secretBinds: RESTIC_SECRET_BINDS,
        secretFileEnv: RESTIC_SECRET_ENV,
      }),
    ).toThrow(/secret|MariaDB/i);
  });
});

describe("restore-jobs exit code maps and classifiers", () => {
  it("classifies _rs_fetch and _zip exits", () => {
    expect(RESTORE_FETCH_EXIT_CODES[RESTORE_EXIT_NO_SPACE]).toBe("no_space");
    expect(RESTORE_FETCH_EXIT_CODES[RESTORE_EXIT_INVALID_FILENAMES]).toBe("restore_prepare_failed");
    expect(classifyRestoreFetchExitCode(0)).toBeNull();
    expect(classifyRestoreFetchExitCode(75)).toBe("no_space");
    expect(classifyRestoreFetchExitCode(95)).toBe("restore_prepare_failed");
    expect(classifyRestoreFetchExitCode(124)).toBe("timeout");
    expect(classifyRestoreFetchExitCode(12)).toBe("wrong_key");
    expect(classifyRestoreFetchExitCode(11)).toBe("repository_locked");
    expect(classifyRestoreFetchExitCode(1, "SignatureDoesNotMatch")).toBe("auth_failed");
    expect(classifyRestoreFetchExitCode(2)).toBe("other");

    expect(ARCHIVE_EXIT_CODES[RESTORE_EXIT_NO_SPACE]).toBe("no_space");
    expect(classifyArchiveExitCode(0)).toBeNull();
    expect(classifyArchiveExitCode(75)).toBe("no_space");
    expect(classifyArchiveExitCode(124)).toBe("timeout");
    expect(classifyArchiveExitCode(12)).toBe("wrong_key");
    expect(classifyArchiveExitCode(1, "NoSuchBucket")).toBe("bucket_missing");
  });

  it("classifies _rs_prepare, _rs_switch, _rs_files, _rs_undo, and _rs_finish per R79", () => {
    expect(RESTORE_PREPARE_EXIT_CODES[RESTORE_EXIT_DEFINER_MISSING]).toBe("definer_missing");
    expect(classifyRestorePrepareExitCode(0)).toBeNull();
    expect(classifyRestorePrepareExitCode(83)).toBe("definer_missing");
    expect(classifyRestorePrepareExitCode(11)).toBe("restore_prepare_failed");
    expect(classifyRestorePrepareExitCode(80)).toBe("restore_prepare_failed");
    expect(classifyRestorePrepareExitCode(81)).toBe("restore_prepare_failed");
    expect(classifyRestorePrepareExitCode(82)).toBe("restore_prepare_failed");
    expect(classifyRestorePrepareExitCode(RESTORE_EXIT_INVALID_OBJECT_NAME)).toBe(
      "restore_prepare_failed",
    );
    expect(classifyRestorePrepareExitCode(124)).toBe("timeout");
    expect(classifyRestorePrepareExitCode(1)).toBe("restore_prepare_failed");

    expect(RESTORE_SWITCH_EXIT_CODES[RESTORE_EXIT_TIMEOUT]).toBe("timeout");
    expect(classifyRestoreSwitchExitCode(0)).toBeNull();
    expect(classifyRestoreSwitchExitCode(11)).toBe("switch_undone");
    expect(classifyRestoreSwitchExitCode(81)).toBe("switch_undone");
    expect(classifyRestoreSwitchExitCode(RESTORE_EXIT_INVALID_OBJECT_NAME)).toBe("switch_undone");
    expect(classifyRestoreSwitchExitCode(1)).toBe("switch_undone");
    expect(classifyRestoreSwitchExitCode(124)).toBe("timeout");

    expect(RESTORE_FILES_EXIT_CODES[RESTORE_EXIT_FILES_PLAN_EXISTS]).toBe("switch_undone");
    expect(classifyRestoreFilesExitCode(0)).toBeNull();
    expect(classifyRestoreFilesExitCode(93)).toBe("switch_undone");
    expect(classifyRestoreFilesExitCode(124)).toBe("timeout");

    expect(RESTORE_UNDO_EXIT_CODES[RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY]).toBe("undo_incomplete");
    expect(classifyRestoreUndoExitCode(0)).toBeNull();
    expect(classifyRestoreUndoExitCode(92)).toBe("undo_incomplete");
    expect(classifyRestoreUndoExitCode(RESTORE_EXIT_INVALID_OBJECT_NAME)).toBe("undo_incomplete");
    expect(classifyRestoreUndoExitCode(124)).toBe("undo_incomplete");
    expect(classifyRestoreUndoExitCode(1)).toBe("undo_incomplete");

    expect(RESTORE_FINISH_EXIT_CODES[RESTORE_EXIT_GATE_REMOVE_FAILED]).toBe("undo_incomplete");
    expect(classifyRestoreFinishExitCode(0)).toBeNull();
    expect(classifyRestoreFinishExitCode(RESTORE_EXIT_GATE_REMOVE_FAILED)).toBe("undo_incomplete");
    expect(classifyRestoreFinishExitCode(1)).toBe("undo_incomplete");
    expect(classifyRestoreFinishExitCode(2)).toBe("undo_incomplete");
    expect(classifyRestoreFinishExitCode(137)).toBe("undo_incomplete");
    expect(classifyRestoreFinishExitCode(RESTORE_EXIT_FINISH_CLEANUP_FAILED)).toBeNull();
    expect(classifyRestoreFinishExitCode(RESTORE_EXIT_DB_UNREACHABLE)).toBeNull();
    expect(classifyRestoreFinishExitCode(124)).toBeNull();
  });
});

describe("restore-jobs E5 crash notes", () => {
  it("writes atomically with 0700 dir / 0600 file and round-trips across all stages", async () => {
    const root = createTempDir();
    const restoresDir = path.join(root, "restores");

    const prepareNote: RestoreNote = {
      v: 1,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      stage: "prepare",
    };
    await writeRestoreNote(restoresDir, prepareNote);

    const dirStat = await lstat(restoresDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const notePath = path.join(restoresDir, `${JOB_ID}.json`);
    const fileStat = await lstat(notePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(await readdir(restoresDir)).toEqual([`${JOB_ID}.json`]);
    expect(await readRestoreNote(restoresDir, JOB_ID)).toEqual(prepareNote);

    const endedNote: RestoreNote = {
      v: 1,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_ID,
      stage: "ended",
      state: "failed",
      failure: "switch_undone",
      endedAt: "2026-11-15T06:00:00.000Z",
    };
    await writeRestoreNote(restoresDir, endedNote);
    expect(await readRestoreNote(restoresDir, JOB_ID)).toEqual(endedNote);
  });

  it("returns null on missing file, refuses truncated JSON, foreign jobId, invalid schema, and symlinks", async () => {
    const root = createTempDir();
    const restoresDir = path.join(root, "restores");
    await mkdir(restoresDir, { recursive: true, mode: 0o700 });

    expect(await readRestoreNote(restoresDir, JOB_ID)).toBeNull();

    const notePath = path.join(restoresDir, `${JOB_ID}.json`);
    await writeFile(notePath, '{"v":1,"jobId":"op_01234', "utf8");
    await expect(readRestoreNote(restoresDir, JOB_ID)).rejects.toThrow();

    await writeFile(
      notePath,
      JSON.stringify({
        v: 1,
        jobId: OTHER_JOB_ID,
        siteId: SITE_ID,
        serviceInstanceId: SERVICE_ID,
        stage: "switch",
      }),
      "utf8",
    );
    await expect(readRestoreNote(restoresDir, JOB_ID)).rejects.toThrow(/jobId/i);

    await writeFile(
      notePath,
      JSON.stringify({
        v: 1,
        jobId: JOB_ID,
        siteId: SITE_ID,
        serviceInstanceId: SERVICE_ID,
        stage: "ended",
        state: "failed",
      }),
      "utf8",
    );
    await expect(readRestoreNote(restoresDir, JOB_ID)).rejects.toThrow();

    const outside = path.join(root, "outside.json");
    await writeFile(
      outside,
      JSON.stringify({
        v: 1,
        jobId: JOB_ID,
        siteId: SITE_ID,
        serviceInstanceId: SERVICE_ID,
        stage: "prepare",
      }),
      "utf8",
    );
    const symlinkNote = path.join(restoresDir, `${OTHER_JOB_ID}.json`);
    await chmod(outside, 0o600);
    await symlink(outside, symlinkNote);
    await expect(readRestoreNote(restoresDir, OTHER_JOB_ID)).rejects.toThrow();
  });
});

describe("restore createVolume helpers", () => {
  const JOB = `op_${"4".repeat(32)}`;

  it("builds the _rs_own chown container: restic image, root, no network, only CHOWN and FOWNER", async () => {
    const { buildRestoreOwnContainerPayload } = await import("../src/restore-jobs.js");
    const spec = buildRestoreOwnContainerPayload({ siteType: WP, jobId: JOB, siteId: "site1", serviceInstanceId: "svc_site1" });
    expect(spec.containerName).toBe(`hp_bk_${JOB}_rs_own`);
    expect(spec.payload).toMatchObject({
      Image: RESTIC_IMAGE,
      User: "0:0",
      Entrypoint: ["/bin/sh", "-c", "chown 33:33 /v && chmod 0755 /v"],
      Env: [],
      Labels: {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.site_id": "site1",
        "io.hostingpanel.job_id": JOB,
      },
      HostConfig: {
        NetworkMode: "none",
        Binds: ["hp_vol_svc_site1_html:/v"],
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "FOWNER"],
        Privileged: false,
        ReadonlyRootfs: true,
      },
    });
    expect(() =>
      buildRestoreOwnContainerPayload({ siteType: WP, jobId: "op_bad", siteId: "site1", serviceInstanceId: "svc_site1" }),
    ).toThrow();
    expect(() =>
      buildRestoreOwnContainerPayload({ siteType: WP, jobId: JOB, siteId: "site1", serviceInstanceId: "../x" }),
    ).toThrow();
  });

  it("the restore note accepts createdVolume: true only", async () => {
    const { RestoreNoteSchema } = await import("../src/restore-jobs.js");
    const base = { v: 1, jobId: JOB, siteId: "site1", serviceInstanceId: "svc_site1", stage: "prepare" };
    expect(RestoreNoteSchema.safeParse({ ...base, createdVolume: true }).success).toBe(true);
    expect(RestoreNoteSchema.safeParse({ ...base, createdVolume: false }).success).toBe(false);
    expect(RestoreNoteSchema.safeParse(base).success).toBe(true);
  });
});
