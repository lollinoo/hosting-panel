import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  BACKUP_FAILURE_CLASSES,
  BACKUP_JOB_STATES,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  siteDatabasePrefix,
  type BackupFailureClass,
  type BackupTarget,
} from "@hosting-panel/contracts";
import {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  assertRegion,
  assertSafeBindPath,
  assertSafeSecretBinds,
  assertSafeSecretFileEnv,
  buildBackupHostConfig,
  buildJobLabels,
  buildResticBasePayload,
  classifyResticExitCode,
  type BackupContainerSpec,
} from "./backup-jobs.js";
import {
  ExecutorCodedError,
  assertContainedPath,
  assertSafeIdentifier,
  getManagedVolumeName,
} from "./traefik-config.js";
import type { ExecutorSiteType } from "./site-types/types.js";

export type { BackupContainerSpec };

export const BACKUP_RESTORE_FETCH_TIMEOUT_MS = 7_200_000 as const;
export const BACKUP_RESTORE_PREPARE_TIMEOUT_MS = 3_600_000 as const;
export const BACKUP_RESTORE_SWITCH_TIMEOUT_MS = 120_000 as const;
export const BACKUP_RESTORE_FILES_TIMEOUT_MS = 60_000 as const;
export const BACKUP_RESTORE_UNDO_TIMEOUT_MS = 300_000 as const;
export const BACKUP_RESTORE_FINISH_TIMEOUT_MS = 1_800_000 as const;
export const BACKUP_RESTORE_LOCK_WAIT_S = 5 as const;
export const BACKUP_RESTORE_SETTLE_START_MS = 150_000 as const;
export const BACKUP_ARCHIVE_TIMEOUT_MS = 7_200_000 as const;
export const BACKUP_ARCHIVE_TTL_MS = 3_600_000 as const;

export const RESTORE_JOB_ID_PATTERN = /^op_[0-9a-f]{32}$/;
export const RESTORE_SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;
export const RESTORE_STAGES = ["prepare", "switch", "switched", "ended"] as const;
export type RestoreStage = (typeof RESTORE_STAGES)[number];

export const RESTORE_EXIT_DB_UNREACHABLE = 11 as const;
export const RESTORE_EXIT_NO_SPACE = 75 as const;
export const RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF = 80 as const;
export const RESTORE_EXIT_INVALID_DB_NAME = 81 as const;
export const RESTORE_EXIT_DB_IMPORT_FAILED = 82 as const;
export const RESTORE_EXIT_DEFINER_MISSING = 83 as const;
export const RESTORE_EXIT_INVALID_OBJECT_NAME = 84 as const;
export const RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY = 92 as const;
export const RESTORE_EXIT_FILES_PLAN_EXISTS = 93 as const;
export const RESTORE_EXIT_INVALID_FILENAMES = 95 as const;
export const RESTORE_EXIT_GATE_REMOVE_FAILED = 96 as const;
export const RESTORE_EXIT_FINISH_CLEANUP_FAILED = 97 as const;
export const RESTORE_EXIT_TIMEOUT = 124 as const;

export const RESTORE_FETCH_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_NO_SPACE]: "no_space",
  [RESTORE_EXIT_INVALID_FILENAMES]: "restore_prepare_failed",
  [RESTORE_EXIT_TIMEOUT]: "timeout",
};

export const RESTORE_PREPARE_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_DB_UNREACHABLE]: "restore_prepare_failed",
  [RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF]: "restore_prepare_failed",
  [RESTORE_EXIT_INVALID_DB_NAME]: "restore_prepare_failed",
  [RESTORE_EXIT_DB_IMPORT_FAILED]: "restore_prepare_failed",
  [RESTORE_EXIT_DEFINER_MISSING]: "definer_missing",
  [RESTORE_EXIT_INVALID_OBJECT_NAME]: "restore_prepare_failed",
  [RESTORE_EXIT_TIMEOUT]: "timeout",
};

export const RESTORE_SWITCH_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_DB_UNREACHABLE]: "switch_undone",
  [RESTORE_EXIT_INVALID_DB_NAME]: "switch_undone",
  [RESTORE_EXIT_INVALID_OBJECT_NAME]: "switch_undone",
  [RESTORE_EXIT_TIMEOUT]: "timeout",
};

export const RESTORE_FILES_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_FILES_PLAN_EXISTS]: "switch_undone",
  [RESTORE_EXIT_TIMEOUT]: "timeout",
};

export const RESTORE_UNDO_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_DB_UNREACHABLE]: "undo_incomplete",
  [RESTORE_EXIT_INVALID_DB_NAME]: "undo_incomplete",
  [RESTORE_EXIT_INVALID_OBJECT_NAME]: "undo_incomplete",
  [RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY]: "undo_incomplete",
  [RESTORE_EXIT_TIMEOUT]: "undo_incomplete",
};

// Only exit 0, 97, 11, and 124 prove the maintenance gate was removed; exit 96 and unknown exits return undo_incomplete.
export const RESTORE_FINISH_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_GATE_REMOVE_FAILED]: "undo_incomplete",
};

const RESTORE_FINISH_POST_GATE_EXIT_CODES: ReadonlySet<number> = new Set([
  0,
  RESTORE_EXIT_FINISH_CLEANUP_FAILED,
  RESTORE_EXIT_DB_UNREACHABLE,
  RESTORE_EXIT_TIMEOUT,
]);

export const ARCHIVE_EXIT_CODES: Readonly<Record<number, BackupFailureClass>> = {
  [RESTORE_EXIT_NO_SPACE]: "no_space",
  [RESTORE_EXIT_TIMEOUT]: "timeout",
};

// C2: a container of a restore never mounts the site's files volume and the staging volume together.

/** The dumps fetch: the snapshot's database dumps into staging, checked and listed there (no site volume). */
export function buildRestoreFetchScript(): string {
  return [
  "set -eu",
  "S=/var/tmp/c",
  'RO="-o s3.bucket-lookup=path"',
  'db_ls=$(restic $RO -o "s3.region=$HP_REGION" ls --json "$HP_SNAP" /backup/databases)',
  'dumps_need=$(printf \'%s\\n\' "$db_ls" | awk -F\'"size":\' \'/"type":"file"/{split($2,a,/[,}]/); sum+=a[1]} END{printf "%.0f\\n", sum+0}\')',
  'db_count=$(printf \'%s\\n\' "$db_ls" | awk \'/"type":"file"/{n++} END{print n+0}\')',
  'free_s=$(df -Pk /var/tmp | awk \'NR==2{print $4}\')',
  `[ $((free_s * 1024)) -ge $((dumps_need + HP_FLOOR)) ] || exit ${RESTORE_EXIT_NO_SPACE}`,
  'rm -rf "$S"',
  'mkdir -m 0700 "$S" "$S/databases"',
  'if [ "$db_count" -gt 0 ]; then',
  '  restic $RO -o "s3.region=$HP_REGION" restore "$HP_SNAP:/backup/databases" --target "$S/databases"',
  "fi",
  `bad_db=$(find "$S/databases" -mindepth 1 \\( ! -type f -o ! -name '*.sql' \\) | head -n 1)`,
  `[ -z "$bad_db" ] || exit ${RESTORE_EXIT_INVALID_FILENAMES}`,
  ': > "$S/dbs.tmp"',
  'for f in "$S/databases"/*.sql; do',
  '  [ -e "$f" ] || [ -L "$f" ] || continue',
  "  db=${f##*/}",
  "  db=${db%.sql}",
  '  printf \'%s\\n\' "$db" >> "$S/dbs.tmp"',
  "done",
  'sort -u "$S/dbs.tmp" -o "$S/dbs.tmp"',
  'sync "$S/dbs.tmp"; mv -Tf "$S/dbs.tmp" "$S/dbs"; sync "$S"',
  'du -sk "$S/databases" | cut -f1',
  ].join("\n");
}

/** The files fetch: the snapshot's files into the type's restore dir (no staging volume); runs after the dumps fetch. */
export function buildRestoreFetchFilesScript(t: ExecutorSiteType): string {
  const w = t.def.files.mountPath;
  return [
  "set -eu",
  `W=${w}; R=${w}/.hp_rs_$HP_H`,
  'RO="-o s3.bucket-lookup=path"',
  'stats_out=$(restic $RO -o "s3.region=$HP_REGION" stats --json --mode restore-size "$HP_SNAP")',
  "total_need=$(printf '%s\\n' \"$stats_out\" | sed -n 's/.*\"total_size\":\\([0-9]*\\).*/\\1/p')",
  '[ -n "$total_need" ]',
  'db_ls=$(restic $RO -o "s3.region=$HP_REGION" ls --json "$HP_SNAP" /backup/databases)',
  'dumps_need=$(printf \'%s\\n\' "$db_ls" | awk -F\'"size":\' \'/"type":"file"/{split($2,a,/[,}]/); sum+=a[1]} END{printf "%.0f\\n", sum+0}\')',
  'files_need=$((total_need - dumps_need)); [ "$files_need" -ge 0 ] || files_need=$total_need',
  // The dumps are already in staging: on one disk its free space counts them, on two it need not.
  'free_w=$(df -Pk "$W" | awk \'NR==2{print $4}\')',
  `[ $((free_w * 1024)) -ge $((files_need + HP_FLOOR)) ] || exit ${RESTORE_EXIT_NO_SPACE}`,
  'rm -rf "$R"',
  'mkdir -m 0700 "$R"',
  "(set -C; printf 'Require all denied\\n' > \"$R/.htaccess\")",
  'mkdir -m 0755 "$R/c" "$R/c/files"',
  'restic $RO -o "s3.region=$HP_REGION" restore "$HP_SNAP:/backup/files" --target "$R/c/files"',
  '! find "$W" "$R/c/files" -mindepth 1 -maxdepth 3 -name \'*',
  `*' | grep -q . || exit ${RESTORE_EXIT_INVALID_FILENAMES}`,
  ].join("\n");
}

/** The gate script: the type's maintenance gate with the site volume only; its record lives in the restore dir. */
export function buildRestoreGateScript(t: ExecutorSiteType): string {
  const gate = t.restore.dbGate;
  if (gate === null) throw new ExecutorCodedError("Site type has no database", "VALIDATION_ERROR");
  return [
  "set -eu",
  // S is the restore dir: the record is the site's own maintenance file, so the site may write it.
  `W=${t.def.files.mountPath}; R=$W/.hp_rs_$HP_H; S=$R`,
  'case "$HP_H" in *[!0-9a-f]*) exit 1;; esac',
  '[ "${#HP_H}" -eq 32 ] || exit 1',
  gate.functions({ gateRemoveFailed: RESTORE_EXIT_GATE_REMOVE_FAILED }),
  'case "$HP_STEP" in',
  "on)",
  gate.prepareCheck({ invalidDbName: RESTORE_EXIT_INVALID_DB_NAME }),
  "  record_gate",
  "  gate_on ;;",
  "undo)",
  '  [ ! -f "$S/gate_recorded" ] || gate_on ;;',
  "end)",
  '  [ ! -f "$S/gate_recorded" ] || restore_gate',
  '  rm -rf "$R"; sync "$W" ;;',
  "*) exit 1 ;;",
  "esac",
  ].join("\n");
}

/** The database steps script of a type with a database; refused for a type without one. */
export function buildRestoreDbScript(t: ExecutorSiteType): string {
  const database = t.def.database;
  const gate = t.restore.dbGate;
  if (database === null || gate === null) {
    throw new ExecutorCodedError("Site type has no database", "VALIDATION_ERROR");
  }
  return [
  "set -eu",
  `W=${t.def.files.mountPath}; R=$W/.hp_rs_$HP_H; S=/var/tmp/c; D=$S/databases; U=hp_ru_$HP_H`,
  `case "$HP_H" in *[!0-9a-f]*) exit ${RESTORE_EXIT_INVALID_DB_NAME};; esac`,
  `[ "\${#HP_H}" -eq 32 ] || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  `case "$HP_LOCK_S" in ""|*[!0-9]*) exit ${RESTORE_EXIT_INVALID_DB_NAME};; esac`,
  "wait_db() {",
  '  printf \'[client]\\nuser=root\\nhost=hp-mariadb\\npassword=%s\\n\' "$(cat "$MARIADB_ROOT_FILE")" > /tmp/c.cnf',
  "  n=0",
  '  until mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B -e \'SELECT 1\' >/dev/null 2>&1; do',
  `    n=$((n+1)); [ "$n" -ge 30 ] && exit ${RESTORE_EXIT_DB_UNREACHABLE}; sleep 2`,
  "  done",
  "}",
  'run_m() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B --sandbox "$@"; }',
  'run_m_sql() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B --sandbox --binary-mode "$@"; }',
  'D0="mariadb-dump --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --skip-dump-date --no-data --skip-opt --skip-comments"',
  'q() { run_m -e "$1"; }',
  `check_prefix() { echo "$HP_PREFIX" | grep -Eqx '${database.namePrefix}_[0-9a-f]{12}' || exit ${RESTORE_EXIT_INVALID_DB_NAME}; }`,
  "validate_dbs_file() {",
  '  while IFS= read -r db || [ -n "$db" ]; do',
  `    echo "$db" | grep -Eqx "\${HP_PREFIX}(_[a-z0-9][a-z0-9_]{0,15})?" || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  '  done < "$S/dbs"',
  "}",
  "check_obj_names() {",
  '  bad_kind=$({',
  '    printf "SET @s=\'%s\';\\n" "$1"',
  "    cat <<'SQL'",
  "SELECT k FROM (",
  "  SELECT 'TABLE' k, TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA=@s AND TABLE_TYPE='BASE TABLE'",
  "  UNION ALL SELECT 'VIEW', TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=@s",
  "  UNION ALL SELECT 'TRIGGER', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=@s",
  "  UNION ALL SELECT 'ROUTINE', ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=@s",
  "  UNION ALL SELECT 'EVENT', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=@s",
  ") o WHERE (n REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), n) > 0 OR LOCATE(CHAR(92), n) > 0) LIMIT 1;",
  "SQL",
  "  } | run_m)",
  '  if [ -n "$bad_kind" ]; then',
  "    printf '%s\\t%s\\n' \"$bad_kind\" \"$2\" >&2",
  `    exit ${RESTORE_EXIT_INVALID_OBJECT_NAME}`,
  "  fi",
  "}",
  // Drops only the own-database qualifier from parsed trigger headers; any other header fails (exit 3).
  "strip_db_qual() {",
  '  LC_ALL=C awk -v db="$1" \'',
  "    function sp(  n) {",
  "      match(b, /^[[:space:]]*/); n = RLENGTH",
  "      if (!n && b !~ /^[`\"]/ && o !~ /[`\"[:space:]]$/) return 0",
  "      o = o substr(b, 1, n); b = substr(b, n + 1); return 1",
  "    }",
  "    function ref(  n1) {",
  "      if (!sp() || !match(b, ID)) return 0",
  "      n1 = substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1)",
  "      if (!match(b, /^[[:space:]]*\\.[[:space:]]*/)) { o = o n1; return 1 }",
  '      if (n1 != db && n1 != "`" db "`" && n1 != "\\"" db "\\"") return 0',
  "      b = substr(b, RLENGTH + 1)",
  "      if (!match(b, ID)) return 0",
  "      o = o substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1); return 1",
  "    }",
  "    function kw(re) {",
  '      if (!sp() || !match(toupper(b), "^(" re ")") || substr(b, RLENGTH + 1, 1) ~ W) return 0',
  "      o = o substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1); return 1",
  "    }",
  '    BEGIN { W = "[A-Za-z0-9_$\\200-\\377]"; ID = "^(`([^`]|``)+`|\\"([^\\"]|\\"\\")+\\"|" W "+)"; t = "/*!50003 TRIGGER" }',
  '    inh { buf = buf "\\n" $0; if ($0 != "*/;;") next }',
  "    !inh && /^\\/\\*!50003 CREATE\\*\\/ / { inh = 1; buf = $0; if ($0 !~ /\\*\\/;;$/) next }",
  "    inh {",
  "      inh = 0; k = index(toupper(buf), t); if (!k) exit 3",
  "      o = substr(buf, 1, k + length(t) - 1); b = substr(buf, k + length(t))",
  '      if (kw("IF") && !(kw("NOT") && kw("EXISTS"))) exit 3',
  '      if (!(ref() && kw("(BEFORE|AFTER)[[:space:]]+(INSERT|UPDATE|DELETE)([[:space:]]+OR[[:space:]]+(INSERT|UPDATE|DELETE))*") && kw("ON") && ref() && kw("FOR"))) exit 3',
  "      print o b; next",
  "    }",
  "    { print }",
  "    END { if (inh) exit 3 }",
  "  '",
  "}",
  "dropobjs() {",
  '  run_m -- "$1" <<\'SQL\'',
  "DELIMITER ;;",
  "BEGIN NOT ATOMIC",
  "  DECLARE done INT DEFAULT 0;",
  "  DECLARE s LONGTEXT;",
  "  DECLARE cur CURSOR FOR",
  "    SELECT CONCAT('DROP VIEW IF EXISTS `', REPLACE(TABLE_NAME,'`','``'), '`') FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()",
  "    UNION ALL",
  "    SELECT CONCAT('DROP TRIGGER IF EXISTS `', REPLACE(TRIGGER_NAME,'`','``'), '`') FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
  "    UNION ALL",
  "    SELECT CONCAT('DROP ', ROUTINE_TYPE, ' IF EXISTS `', REPLACE(ROUTINE_NAME,'`','``'), '`') FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
  "    UNION ALL",
  "    SELECT CONCAT('DROP EVENT IF EXISTS `', REPLACE(EVENT_NAME,'`','``'), '`') FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE();",
  "  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;",
  "  OPEN cur;",
  "  lp: LOOP",
  "    FETCH cur INTO s;",
  "    IF done THEN LEAVE lp; END IF;",
  "    EXECUTE IMMEDIATE s;",
  "  END LOOP;",
  "  CLOSE cur;",
  "END;;",
  "DELIMITER ;",
  "SQL",
  "}",
  "saveobjs() {",
  '  schema="$1"; out="$2"',
  '  { printf "SET @s=\'%s\';\\n" "$schema"; cat <<\'SQL\'',
  "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=@s ORDER BY TABLE_NAME;",
  "SQL",
  '  } | run_m -r > "$out.views"',
  '  : > "$out.tmp"',
  '  $D0 --no-create-info --routines --events --triggers -- "$schema" >> "$out.tmp"',
  '  set -- "$schema"',
  '  while IFS= read -r v; do',
  '    [ -z "$v" ] || set -- "$@" "$v"',
  '  done < "$out.views"',
  '  if [ "$#" -gt 1 ]; then',
  '    $D0 -- "$@" >> "$out.tmp"',
  "  fi",
  '  rm -f "$out.views"',
  '  sync "$out.tmp"; mv -Tf "$out.tmp" "$out"; sync "$S"',
  "}",
  "has_tables() {",
  '  [ -n "$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=\'$1\' AND TABLE_TYPE=\'BASE TABLE\' LIMIT 1")" ]',
  "}",
  "append_renames() {",
  "  {",
  '    printf "SET @s=\'%s\', @d=\'%s\';\\n" "$1" "$2"',
  "    cat <<'SQL'",
  "SELECT CONCAT('`', @s, '`.`', REPLACE(TABLE_NAME,'`','``'), '` TO `', @d, '`.`', REPLACE(TABLE_NAME,'`','``'), '`,')",
  "FROM information_schema.TABLES",
  "WHERE TABLE_SCHEMA=@s AND TABLE_TYPE='BASE TABLE'",
  "ORDER BY TABLE_NAME;",
  "SQL",
  '  } | run_m -r >> "$3"',
  "}",
  "drop_temp_schemas() {",
  "  {",
  '    printf "SET @hp_h=\'%s\';\\n" "$HP_H"',
  "    cat <<'SQL'",
  "DELIMITER ;;",
  "BEGIN NOT ATOMIC",
  "  DECLARE done INT DEFAULT 0;",
  "  DECLARE s TEXT;",
  "  DECLARE cur CURSOR FOR",
  "    SELECT CONCAT('DROP DATABASE IF EXISTS `', REPLACE(SCHEMA_NAME,'`','``'), '`')",
  "    FROM information_schema.SCHEMATA",
  "    WHERE SCHEMA_NAME LIKE CONCAT('hp|_rn|_', @hp_h, '|_%') ESCAPE '|'",
  "       OR SCHEMA_NAME LIKE CONCAT('hp|_ro|_', @hp_h, '|_%') ESCAPE '|'",
  "       OR SCHEMA_NAME = CONCAT('hp_ru_', @hp_h);",
  "  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;",
  "  OPEN cur;",
  "  lp: LOOP",
  "    FETCH cur INTO s;",
  "    IF done THEN LEAVE lp; END IF;",
  "    EXECUTE IMMEDIATE s;",
  "  END LOOP;",
  "  CLOSE cur;",
  "END;;",
  "DELIMITER ;",
  "SQL",
  "  } | run_m",
  "}",
  'exists() { [ -n "$(q "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=\'$1\'")" ]; }',
  gate.functions({ gateRemoveFailed: RESTORE_EXIT_GATE_REMOVE_FAILED }),
  'case "$HP_STEP" in',
  "prepare)",
  "  check_prefix",
  `  [ -f "$S/dbs" ] && [ ! -L "$S/dbs" ] || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  "  validate_dbs_file",
  "  wait_db",
  `  [ "$(q 'SELECT @@global.event_scheduler')" = OFF ] || exit ${RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF}`,
  "  i=0",
  '  while IFS= read -r db || [ -n "$db" ]; do',
  '    [ -z "$db" ] && continue',
  `    [ -f "$D/$db.sql" ] && [ ! -L "$D/$db.sql" ] || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  '    if exists "$db"; then check_obj_names "$db" "$db"; fi',
  "    p=hp_rn_${HP_H}_$i",
  '    q "DROP DATABASE IF EXISTS \\`$p\\`; CREATE DATABASE \\`$p\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"',
  '    rm -f "$S/strip_bad"',
  `    { strip_db_qual "$db" < "$D/$db.sql" || : > "$S/strip_bad"; } | run_m_sql -- "$p" || exit ${RESTORE_EXIT_DB_IMPORT_FAILED}`,
  `    if [ -e "$S/strip_bad" ]; then printf 'TRIGGER\\t%s\\n' "$db" >&2; exit ${RESTORE_EXIT_INVALID_OBJECT_NAME}; fi`,
  '    check_obj_names "$p" "$db"',
  '    saveobjs "$p" "$S/copy_$i.sql"',
  "    i=$((i + 1))",
  '  done < "$S/dbs"',
  "  m=$(q \"SELECT DISTINCT d FROM (SELECT DEFINER d,TABLE_SCHEMA s FROM information_schema.VIEWS UNION ALL SELECT DEFINER,ROUTINE_SCHEMA FROM information_schema.ROUTINES UNION ALL SELECT DEFINER,TRIGGER_SCHEMA FROM information_schema.TRIGGERS UNION ALL SELECT DEFINER,EVENT_SCHEMA FROM information_schema.EVENTS) x WHERE s LIKE 'hp\\\\_rn\\\\_${HP_H}\\\\_%' AND d NOT IN (SELECT CONCAT(User,'@',Host) FROM mysql.user)\")",
  `  [ -z "$m" ] || exit ${RESTORE_EXIT_DEFINER_MISSING} ;;`,
  "switch)",
  "  check_prefix",
  `  [ -f "$S/dbs" ] && [ ! -L "$S/dbs" ] || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  "  validate_dbs_file",
  "  wait_db",
  "  i=0",
  '  while IFS= read -r db || [ -n "$db" ]; do',
  '    [ -z "$db" ] && continue',
  '    if exists "$db"; then check_obj_names "$db" "$db"; fi',
  '    check_obj_names "hp_rn_${HP_H}_$i" "$db"',
  "    i=$((i + 1))",
  '  done < "$S/dbs"',
  '  q "CREATE DATABASE IF NOT EXISTS \\`$U\\`; CREATE TABLE IF NOT EXISTS \\`$U\\`.\\`before\\` (x INT)"',
  "  printf 'RENAME TABLE\\n' > \"$S/rename.sql\"",
  "  i=0",
  '  while IFS= read -r db || [ -n "$db" ]; do',
  '    [ -z "$db" ] && continue',
  "    p=hp_rn_${HP_H}_$i; o=hp_ro_${HP_H}_$i",
  '    if ! exists "$db"; then',
  '      grep -qx "$db" "$S/created" 2>/dev/null || { echo "$db" >> "$S/created"; sync "$S/created"; }',
  '      q "CREATE DATABASE \\`$db\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"',
  "    fi",
  '    q "CREATE DATABASE IF NOT EXISTS \\`$o\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"',
  '    saveobjs "$db" "$S/live_$i.sql"; dropobjs "$db"; dropobjs "$p"',
  '    append_renames "$db" "$o" "$S/rename.sql"',
  '    append_renames "$p" "$db" "$S/rename.sql"',
  "    i=$((i + 1))",
  '  done < "$S/dbs"',
  '  printf \'`%s`.`before` TO `%s`.`after`;\\n\' "$U" "$U" >> "$S/rename.sql"',
  '  run_m_sql < "$S/rename.sql"',
  "  i=0",
  '  while IFS= read -r db || [ -n "$db" ]; do',
  '    [ -z "$db" ] && continue',
  '    run_m_sql -- "$db" < "$S/copy_$i.sql"',
  "    i=$((i + 1))",
  '  done < "$S/dbs" ;;',
  "undo)",
  "  check_prefix",
  `  [ ! -L "$S/dbs" ] || exit ${RESTORE_EXIT_INVALID_DB_NAME}`,
  '  if [ -f "$S/dbs" ]; then validate_dbs_file; fi',
  "  wait_db",
  '  if [ ! -e "$S/dbs" ]; then',
  `    [ ! -e "$S/created" ] || exit ${RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY}`,
  '    u_exists=$(q "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=\'$U\'")',
  `    [ -z "$u_exists" ] || exit ${RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY}`,
  "  fi",
  '  mkdir -p -m 0700 "$S"',
  '  done_=$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=\'$U\' AND TABLE_NAME=\'after\'")',
  '  if [ -f "$S/dbs" ]; then',
  '    if [ -n "$done_" ]; then',
  "      i=0",
  '      while IFS= read -r db || [ -n "$db" ]; do',
  '        [ -z "$db" ] && continue',
  '        if exists "$db"; then check_obj_names "$db" "$db"; fi',
  '        if exists "hp_ro_${HP_H}_$i"; then check_obj_names "hp_ro_${HP_H}_$i" "$db"; fi',
  "        i=$((i + 1))",
  '      done < "$S/dbs"',
  "      printf 'RENAME TABLE\\n' > \"$S/rename.sql\"",
  "      i=0",
  '      while IFS= read -r db || [ -n "$db" ]; do',
  '        [ -z "$db" ] && continue',
  "        p=hp_rn_${HP_H}_$i; o=hp_ro_${HP_H}_$i",
  '        dropobjs "$db"',
  '        append_renames "$db" "$p" "$S/rename.sql"',
  '        append_renames "$o" "$db" "$S/rename.sql"',
  "        i=$((i + 1))",
  '      done < "$S/dbs"',
  '      printf \'`%s`.`after` TO `%s`.`before`;\\n\' "$U" "$U" >> "$S/rename.sql"',
  '      run_m_sql < "$S/rename.sql"',
  "    fi",
  "    i=0",
  '    while IFS= read -r db || [ -n "$db" ]; do',
  '      [ -z "$db" ] && continue',
  '      if [ -f "$S/live_$i.sql" ] && exists "$db"; then',
  '        dropobjs "$db"; run_m_sql -- "$db" < "$S/live_$i.sql"',
  "      fi",
  '      if [ -f "$S/created" ] && grep -qx "$db" "$S/created" 2>/dev/null; then',
  `        ! has_tables "$db" || exit ${RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY}`,
  '        q "DROP DATABASE IF EXISTS \\`$db\\`"',
  "      fi",
  "      i=$((i + 1))",
  '    done < "$S/dbs"',
  "  fi",
  `  [ -z "$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA LIKE 'hp|_ro|_\${HP_H}|_%' ESCAPE '|' AND TABLE_TYPE='BASE TABLE' LIMIT 1")" ] || exit ${RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY}`,
  "  drop_temp_schemas ;;",
  "finish)",
  "  gate_off",
  "  wait_db",
  `  drop_temp_schemas || exit ${RESTORE_EXIT_FINISH_CLEANUP_FAILED}`,
  '  rm -rf "$R" || exit ' + String(RESTORE_EXIT_FINISH_CLEANUP_FAILED),
  '  sync "$W" || exit ' + String(RESTORE_EXIT_FINISH_CLEANUP_FAILED) + " ;;",
  "*) exit 1 ;;",
  "esac",
  ].join("\n");
}

/** The files script: plans and exchanges the type's files; a type without a gate also gets a finish step. */
export function buildRestoreFilesScript(t: ExecutorSiteType): string {
  const kept = t.restore.keptDirs;
  const leaves = kept.filter((d) => !kept.some((o) => o.startsWith(`${d}/`)));
  const both = (dirs: readonly string[]) => [...dirs.map((d) => `"$W/${d}"`), ...dirs.map((d) => `"$F/${d}"`)].join(" ");
  const leftInPlace = t.restore.leftInPlace.includes(".hp_rs_*") ? t.restore.leftInPlace : [...t.restore.leftInPlace, ".hp_rs_*"];
  return [
  "set -eu",
  `W=${t.def.files.mountPath}; R=$W/.hp_rs_$HP_H; F=$R/c/files; P=$R/c/plan`,
  'case "$HP_H" in *[!0-9a-f]*) exit 1;; esac',
  '[ "${#HP_H}" -eq 32 ] || exit 1',
  'case "$HP_STEP" in',
  "switch)",
  `  [ ! -f "$P" ] || exit ${RESTORE_EXIT_FILES_PLAN_EXISTS}`,
  ...(kept.length === 0
    ? []
    : [`  for p in ${both(kept)}; do`, '    [ ! -L "$p" ] || exit 1', "  done", `  mkdir -p ${both(leaves)}`]),
  '  : > "$P.tmp"',
  `  for d in ${['""', ...kept.map((d) => `${d}/`)].join(" ")}; do`,
  '    l1=$(ls -A "$W/$d")',
  '    l2=$(ls -A "$F/$d")',
  '    { [ -z "$l1" ] || printf \'%s\\n\' "$l1"; [ -z "$l2" ] || printf \'%s\\n\' "$l2"; } | sort -u | while IFS= read -r e; do',
  '      [ -n "$e" ] || continue',
  '      case "$d$e" in',
  `        ${leftInPlace.join("|")}) continue ;;`,
  "      esac",
  '      if [ -e "$W/$d$e" ] || [ -L "$W/$d$e" ]; then',
  '        if [ -e "$F/$d$e" ] || [ -L "$F/$d$e" ]; then',
  '          printf \'X\\t%s\\t%s\\n\' "$(stat -c %i "$W/$d$e")" "$d$e"',
  "        else",
  '          printf \'O\\t-\\t%s\\n\' "$d$e"',
  "        fi",
  "      else",
  '        printf \'I\\t-\\t%s\\n\' "$d$e"',
  "      fi",
  '    done >> "$P.tmp"',
  "  done",
  '  sync "$P.tmp"; mv -Tf "$P.tmp" "$P"; sync "$R/c"',
  '  while IFS="$(printf \'\\t\')" read -r k i e; do',
  '    case "$k" in',
  '      X) mv --exchange -T "$F/$e" "$W/$e" ;;',
  '      I) mv -T "$F/$e" "$W/$e" ;;',
  '      O) mv -T "$W/$e" "$F/$e" ;;',
  "    esac",
  '  done < "$P"',
  '  sync "$W" ;;',
  "undo)",
  '  [ -f "$P" ] || exit 0',
  '  tac "$P" | while IFS="$(printf \'\\t\')" read -r k i e; do',
  '    case "$k" in',
  '      X) [ "$(stat -c %i "$W/$e")" = "$i" ] || mv --exchange -T "$F/$e" "$W/$e" ;;',
  '      I) if [ -e "$W/$e" ] || [ -L "$W/$e" ]; then [ -e "$F/$e" ] || [ -L "$F/$e" ] || mv -T "$W/$e" "$F/$e"; fi ;;',
  '      O) if [ -e "$F/$e" ] || [ -L "$F/$e" ]; then [ -e "$W/$e" ] || [ -L "$W/$e" ] || mv -T "$F/$e" "$W/$e"; fi ;;',
  "    esac",
  "  done",
  '  rm -f "$P"; sync "$W" ;;',
  // Without database steps nothing else removes the restore dir.
  ...(t.restore.dbGate === null
    ? ["finish)", `  rm -rf "$R" || exit ${RESTORE_EXIT_FINISH_CLEANUP_FAILED}`, `  sync "$W" || exit ${RESTORE_EXIT_FINISH_CLEANUP_FAILED} ;;`]
    : []),
  "*) exit 1 ;;",
  "esac",
  ].join("\n");
}

export const ARCHIVE_SCRIPT = [
  "set -eu",
  'RO="-o s3.bucket-lookup=path"',
  'stats=$(restic $RO -o "s3.region=$HP_REGION" stats --json --mode restore-size "$HP_SNAP")',
  "need=$(printf '%s\\n' \"$stats\" | sed -n 's/.*\"total_size\":\\([0-9]*\\).*/\\1/p')",
  '[ -n "$need" ]',
  'free=$(df -Pk /a | awk \'NR==2{print $4}\')',
  `[ $((free * 1024)) -ge $((need + HP_FLOOR)) ] || exit ${RESTORE_EXIT_NO_SPACE}`,
  'rm -f "/a/$HP_JOB.part"',
  'restic $RO -o "s3.region=$HP_REGION" dump --archive zip "$HP_SNAP:/backup" / > "/a/$HP_JOB.part"',
  'sync "/a/$HP_JOB.part"',
  'mv -Tf "/a/$HP_JOB.part" "/a/$HP_JOB.zip"',
  "sync /a",
].join("\n");

export const RestoreNoteSchema = z
  .object({
    v: z.literal(1),
    jobId: z.string().regex(RESTORE_JOB_ID_PATTERN),
    siteId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    serviceInstanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    // Absent for the legacy type; a key the release does not know is refused when the note is acted on.
    siteType: z.string().regex(/^[a-z][a-z0-9]{0,31}$/).optional(),
    stage: z.enum(RESTORE_STAGES),
    state: z.enum(BACKUP_JOB_STATES).optional(),
    failure: z.enum(BACKUP_FAILURE_CLASSES).nullable().optional(),
    endedAt: z.string().datetime().optional(),
    // Set before this job creates the site files volume; it is removed again only while this flag is on.
    createdVolume: z.literal(true).optional(),
  })
  .strict()
  .superRefine((note, ctx) => {
    if (note.stage === "ended") {
      if (note.state !== "succeeded" && note.state !== "failed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ended restore note requires succeeded or failed state",
          path: ["state"],
        });
      }
      if (note.endedAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ended restore note requires endedAt timestamp",
          path: ["endedAt"],
        });
      }
      if (note.state === "failed" && (note.failure === undefined || note.failure === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Failed restore note requires a failure class",
          path: ["failure"],
        });
      }
    }
  });

export type RestoreNote = z.infer<typeof RestoreNoteSchema>;

function assertRestoreJobId(jobId: string): { readonly jobId: string; readonly hexId: string } {
  if (!RESTORE_JOB_ID_PATTERN.test(jobId)) {
    throw new ExecutorCodedError("Invalid restore jobId", "VALIDATION_ERROR");
  }
  return { jobId, hexId: jobId.slice(3) };
}

function assertSnapshotId(snapshotId: string): string {
  if (!RESTORE_SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ExecutorCodedError("Invalid snapshot id", "VALIDATION_ERROR");
  }
  return snapshotId;
}

function assertResticOnlySecrets(
  secretBinds: readonly string[],
  secretFileEnv: readonly string[],
): void {
  assertSafeSecretBinds(secretBinds);
  assertSafeSecretFileEnv(secretFileEnv);
  if (
    secretBinds.some((b) => /mariadb/i.test(b)) ||
    secretFileEnv.some((e) => /^MARIADB_/i.test(e))
  ) {
    throw new ExecutorCodedError(
      "Restic container must not receive MariaDB secrets",
      "HOST_POLICY_DENIED",
    );
  }
}

function assertDbOnlySecrets(
  secretBinds: readonly string[],
  secretFileEnv: readonly string[],
): void {
  assertSafeSecretBinds(secretBinds);
  assertSafeSecretFileEnv(secretFileEnv);
  if (
    !secretFileEnv.some((e) => e.startsWith("MARIADB_ROOT_FILE=")) ||
    secretBinds.some((b) => /AWS_SHARED_CREDENTIALS|RESTIC_PASSWORD/i.test(b)) ||
    secretFileEnv.some((e) => /^(?:AWS_SHARED_CREDENTIALS|RESTIC_PASSWORD)/i.test(e))
  ) {
    throw new ExecutorCodedError(
      "Database container requires MariaDB secret file only",
      "HOST_POLICY_DENIED",
    );
  }
}

function assertExecutorUser(executorUser: string): string {
  if (typeof executorUser !== "string" || !/^\d+:\d+$/.test(executorUser)) {
    throw new ExecutorCodedError("Invalid executor user uid:gid", "VALIDATION_ERROR");
  }
  return executorUser;
}

function buildRestoreDbStepPayload(input: {
  readonly step: "prepare" | "switch" | "undo" | "finish";
  readonly suffix: string;
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly sharedDbNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
} & ({ readonly stagingVolumeName: string } | { readonly serviceInstanceId: string })): BackupContainerSpec {
  const t = input.siteType;
  const script = buildRestoreDbScript(t);
  const { jobId, hexId } = assertRestoreJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  assertDbOnlySecrets(input.secretBinds, input.secretFileEnv);

  // C2: the staging volume, or the site volume (finish), never both.
  const volume =
    "stagingVolumeName" in input
      ? `${assertSafeIdentifier(input.stagingVolumeName, "stagingVolumeName")}:/var/tmp`
      : `${getManagedVolumeName(assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId"), t.def.files.volumeSuffix)}:${t.def.files.mountPath}`;
  const binds = [volume, ...input.secretBinds];

  const env = [
    `HP_STEP=${input.step}`,
    `HP_H=${hexId}`,
    ...(input.step !== "finish" ? [`HP_PREFIX=${siteDatabasePrefix(siteId, t.def.database!.namePrefix)}`] : []),
    `HP_LOCK_S=${String(BACKUP_RESTORE_LOCK_WAIT_S)}`,
    ...input.secretFileEnv,
  ];

  return {
    containerName: `hp_bk_${jobId}_${input.suffix}`,
    payload: {
      Image: SHARED_MARIADB_IMAGE,
      Cmd: ["sh", "-c", script],
      User: t.def.files.owner,
      Env: env,
      Labels: buildJobLabels(siteId, jobId),
      HostConfig: buildBackupHostConfig(input.sharedDbNetworkName, binds),
    },
  };
}

function buildRestoreFilesStepPayload(input: {
  readonly step: "switch" | "undo" | "finish" | "on" | "end";
  readonly suffix: string;
  readonly script?: string;
  readonly jobId: string;
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly siteType: ExecutorSiteType;
}): BackupContainerSpec {
  const t = input.siteType;
  const { jobId, hexId } = assertRestoreJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const serviceInstanceId = assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  const siteVolume = getManagedVolumeName(serviceInstanceId, t.def.files.volumeSuffix);

  return {
    containerName: `hp_bk_${jobId}_${input.suffix}`,
    payload: {
      Image: t.restore.filesImage,
      Cmd: ["sh", "-c", input.script ?? buildRestoreFilesScript(t)],
      User: t.def.files.owner,
      Env: [`HP_STEP=${input.step}`, `HP_H=${hexId}`],
      Labels: buildJobLabels(siteId, jobId),
      HostConfig: buildBackupHostConfig("none", [`${siteVolume}:${t.def.files.mountPath}`]),
    },
  };
}

/** Builds a hardened restic fetch spec: `_rs_fetch` (dumps, staging only) or `_rs_fetch_files` (files, site volume only). */
function buildRestoreFetchPayload(
  input: {
    readonly jobId: string;
    readonly siteId: string;
    readonly siteType: ExecutorSiteType;
    readonly snapshotId: string;
    readonly target: BackupTarget;
    readonly backupNetworkName: string;
    readonly secretBinds: readonly string[];
    readonly secretFileEnv: readonly string[];
  },
  suffix: string,
  bind: string,
  script: string,
): BackupContainerSpec {
  const { jobId, hexId } = assertRestoreJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const snapshotId = assertSnapshotId(input.snapshotId);
  const region = assertRegion(input.target.region);
  assertResticOnlySecrets(input.secretBinds, input.secretFileEnv);

  return {
    containerName: `hp_bk_${jobId}_${suffix}`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      user: input.siteType.def.files.owner,
      binds: [bind],
      extraEnv: [
        `HP_REGION=${region}`,
        `HP_SNAP=${snapshotId}`,
        `HP_H=${hexId}`,
        `HP_FLOOR=${String(BACKUP_DISK_FREE_FLOOR_BYTES)}`,
      ],
      entrypoint: ["/bin/sh", "-c", script],
    }),
  };
}

/** Builds the restic `_rs_fetch` spec restoring the dumps into staging; it never mounts the site volume. */
export function buildRestoreFetchContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly snapshotId: string;
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
  readonly stagingVolumeName: string;
}): BackupContainerSpec {
  const stagingVolume = assertSafeIdentifier(input.stagingVolumeName, "stagingVolumeName");
  return buildRestoreFetchPayload(input, "rs_fetch", `${stagingVolume}:/var/tmp`, buildRestoreFetchScript());
}

/** Builds the restic `_rs_fetch_files` spec restoring the files into the site volume; it never mounts staging. */
export function buildRestoreFetchFilesContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly siteType: ExecutorSiteType;
  readonly snapshotId: string;
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  const t = input.siteType;
  const serviceInstanceId = assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  const siteVolume = getManagedVolumeName(serviceInstanceId, t.def.files.volumeSuffix);
  return buildRestoreFetchPayload(input, "rs_fetch_files", `${siteVolume}:${t.def.files.mountPath}`, buildRestoreFetchFilesScript(t));
}

/** Builds an offline `_rs_gate_<step>` spec running the type's maintenance gate with the site volume only. */
export function buildRestoreGateContainerPayload(input: {
  readonly step: "on" | "undo" | "end";
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
}): BackupContainerSpec {
  return buildRestoreFilesStepPayload({ ...input, suffix: `rs_gate_${input.step}`, script: buildRestoreGateScript(input.siteType) });
}

/** Builds the MariaDB `_rs_prepare` container spec importing dumps into isolated staging schemas (no site volume). */
export function buildRestorePrepareContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly stagingVolumeName: string;
  readonly sharedDbNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  return buildRestoreDbStepPayload({
    step: "prepare",
    suffix: "rs_prepare",
    ...input,
  });
}

/** Builds the MariaDB `_rs_switch` container spec swapping prepared databases live (the gate is `_rs_gate_on`). */
export function buildRestoreSwitchContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly stagingVolumeName: string;
  readonly sharedDbNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  return buildRestoreDbStepPayload({
    step: "switch",
    suffix: "rs_switch",
    ...input,
  });
}

/** Builds the offline `_rs_files` container spec planning and atomically exchanging site files. */
export function buildRestoreFilesContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
}): BackupContainerSpec {
  return buildRestoreFilesStepPayload({
    step: "switch",
    suffix: "rs_files",
    ...input,
  });
}

/** Builds the MariaDB `_rs_finish` container spec removing the gate first and dropping leftover job schemas/dir. */
export function buildRestoreFinishContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
  readonly sharedDbNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  return buildRestoreDbStepPayload({
    step: "finish",
    suffix: "rs_finish",
    ...input,
  });
}

/** Builds the offline `_rs_undo_files` container spec reversing file exchanges idempotently. */
export function buildRestoreUndoFilesContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
}): BackupContainerSpec {
  return buildRestoreFilesStepPayload({
    step: "undo",
    suffix: "rs_undo_files",
    ...input,
  });
}

/** Builds the offline `_rs_finish` container spec of a type without a database gate: removes the restore dir. */
export function buildRestoreFilesFinishContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
}): BackupContainerSpec {
  if (input.siteType.restore.dbGate !== null) {
    throw new ExecutorCodedError("Site type finishes in its database step", "VALIDATION_ERROR");
  }
  return buildRestoreFilesStepPayload({
    step: "finish",
    suffix: "rs_finish",
    ...input,
  });
}

/** Builds the MariaDB `_rs_undo_db` container spec reversing database changes (the gate is `_rs_gate_undo`/`_rs_gate_end`). */
export function buildRestoreUndoDbContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly stagingVolumeName: string;
  readonly sharedDbNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  return buildRestoreDbStepPayload({
    step: "undo",
    suffix: "rs_undo_db",
    ...input,
  });
}

/** Builds the `_rs_own` container giving a newly created site files volume to the type's owner. */
export function buildRestoreOwnContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly siteType: ExecutorSiteType;
  readonly serviceInstanceId: string;
}): BackupContainerSpec & {
  readonly payload: { readonly HostConfig: { readonly CapAdd: readonly string[] } };
} {
  const { jobId } = assertRestoreJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const serviceInstanceId = assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  const siteVolume = getManagedVolumeName(serviceInstanceId, input.siteType.def.files.volumeSuffix);
  return {
    containerName: `hp_bk_${jobId}_rs_own`,
    payload: {
      Image: RESTIC_IMAGE,
      Entrypoint: ["/bin/sh", "-c", `chown ${input.siteType.def.files.owner} /v && chmod 0755 /v`],
      User: "0:0",
      Env: [],
      Labels: buildJobLabels(siteId, jobId),
      HostConfig: {
        ...buildBackupHostConfig("none", [`${siteVolume}:/v`]),
        CapAdd: ["CHOWN", "FOWNER"],
      },
    },
  };
}

/** Builds the restic `_zip` archive container spec streaming a backup snapshot into a zip on the host archive dir. */
export function buildArchiveContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly snapshotId: string;
  readonly target: BackupTarget;
  readonly executorUser: string;
  readonly archivesHostDir: string;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  const { jobId } = assertRestoreJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const snapshotId = assertSnapshotId(input.snapshotId);
  const region = assertRegion(input.target.region);
  const executorUser = assertExecutorUser(input.executorUser);
  const archivesDir = assertSafeBindPath(input.archivesHostDir, "archivesHostDir");
  assertResticOnlySecrets(input.secretBinds, input.secretFileEnv);

  return {
    containerName: `hp_bk_${jobId}_zip`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      user: executorUser,
      binds: [`${archivesDir}:/a`],
      extraEnv: [
        `HP_REGION=${region}`,
        `HP_SNAP=${snapshotId}`,
        `HP_JOB=${jobId}`,
        `HP_FLOOR=${String(BACKUP_DISK_FREE_FLOOR_BYTES)}`,
      ],
      entrypoint: ["/bin/sh", "-c", ARCHIVE_SCRIPT],
    }),
  };
}

/** Maps a `_rs_fetch` container exit code and stderr tail to a failure class or null on success. */
export function classifyRestoreFetchExitCode(
  exitCode: number,
  stderrText = "",
): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return RESTORE_FETCH_EXIT_CODES[exitCode] ?? classifyResticExitCode(exitCode, stderrText);
}

/** Maps a `_rs_prepare` container exit code to a failure class or null on success. */
export function classifyRestorePrepareExitCode(exitCode: number): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return RESTORE_PREPARE_EXIT_CODES[exitCode] ?? "restore_prepare_failed";
}

/** Maps a `_rs_switch` container exit code to a failure class or null on success. */
export function classifyRestoreSwitchExitCode(exitCode: number): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return RESTORE_SWITCH_EXIT_CODES[exitCode] ?? "switch_undone";
}

/** Maps a `_rs_files` container exit code to a failure class or null on success. */
export function classifyRestoreFilesExitCode(exitCode: number): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return RESTORE_FILES_EXIT_CODES[exitCode] ?? "switch_undone";
}

/** Maps an undo container (`_rs_undo_files` or `_rs_undo_db`) exit code to a failure class or null. */
export function classifyRestoreUndoExitCode(exitCode: number): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return RESTORE_UNDO_EXIT_CODES[exitCode] ?? "undo_incomplete";
}

/** Maps a `_rs_finish` exit code: post-gate cleanup exits (0, 97, 11, 124) return null; gate/unknown exits return `undo_incomplete`. */
export function classifyRestoreFinishExitCode(exitCode: number): BackupFailureClass | null {
  return RESTORE_FINISH_POST_GATE_EXIT_CODES.has(exitCode) ? null : "undo_incomplete";
}

/** Maps a `_zip` archive container exit code and stderr tail to a failure class or null on success. */
export function classifyArchiveExitCode(
  exitCode: number,
  stderrText = "",
): BackupFailureClass | null {
  if (exitCode === 0) return null;
  return ARCHIVE_EXIT_CODES[exitCode] ?? classifyResticExitCode(exitCode, stderrText);
}

/** Atomically persists a validated E5 restore crash note using temp file, fsync, rename, and folder fsync. */
export async function writeRestoreNote(restoresDir: string, note: RestoreNote): Promise<void> {
  const parsed = RestoreNoteSchema.safeParse(note);
  if (!parsed.success) {
    throw new ExecutorCodedError("Invalid restore note payload", "VALIDATION_ERROR");
  }
  const normalized = parsed.data;
  await mkdir(restoresDir, { recursive: true, mode: 0o700 });
  await chmod(restoresDir, 0o700);

  const notePath = assertContainedPath(restoresDir, path.join(restoresDir, `${normalized.jobId}.json`));
  const tmpName = `${normalized.jobId}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = assertContainedPath(restoresDir, path.join(restoresDir, tmpName));

  const fh = await open(tmpPath, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify(normalized), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }

  await rename(tmpPath, notePath);
  const dirHandle = await open(restoresDir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/** Reads and validates a restore crash note, refusing broken, symlinked, or foreign files. */
export async function readRestoreNote(
  restoresDir: string,
  expectedJobId: string,
): Promise<RestoreNote | null> {
  const { jobId } = assertRestoreJobId(expectedJobId);
  const notePath = assertContainedPath(restoresDir, path.join(restoresDir, `${jobId}.json`));

  let stat;
  try {
    stat = await lstat(notePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ExecutorCodedError("Restore note must be a regular file", "HOST_POLICY_DENIED");
  }

  let raw: string;
  const fh = await open(
    notePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    raw = await fh.readFile("utf8");
  } finally {
    await fh.close();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new ExecutorCodedError("Corrupt restore note JSON", "VALIDATION_ERROR");
  }

  const parsed = RestoreNoteSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ExecutorCodedError("Invalid restore note format", "VALIDATION_ERROR");
  }
  if (parsed.data.jobId !== jobId) {
    throw new ExecutorCodedError("Restore note jobId mismatch", "HOST_POLICY_DENIED");
  }
  return parsed.data;
}
