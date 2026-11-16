import {
  CreateManagedSiteInputSchema,
  IMPORT_ORIGIN_PATTERN,
  SHARED_MARIADB_IMAGE,
  SITE_JOB_LIMIT_MS,
  SITE_DB_IDENTIFIER_PATTERN,
  SUPPORTED_PHP_VERSIONS,
  WORDPRESS_RESULT_MAX_BYTES,
  WORDPRESS_TABLE_PREFIX_PATTERN,
  WORDPRESS_UPDATE_TARGET_PATTERN,
  WORDPRESS_USER_ID_PATTERN,
  WordpressImportLoadResultSchema,
  WordpressStateResultSchema,
  WordpressUpdateResultSchema,
  isSiteOrigin,
  normalizeSiteDomain,
  redactSensitiveString,
  resolveWordpressCliImage,
  siteDatabasePrefix,
  type PhpVersion,
  type WordpressImportLoadResult,
  type WordpressStateResult,
  type WordpressUpdateResult,
} from "@hosting-panel/contracts";
import type { SiteJobKind, SiteJobRequest } from "@hosting-panel/executor-contracts";
import type { z } from "zod";
import { demuxDockerLogStream } from "./docker-logs.js";
import { SHARED_DB_NETWORK_NAME } from "./shared-database.js";
import {
  ExecutorCodedError,
  assertSafeIdentifier,
  getManagedVolumeName,
  getSiteInternalNetworkName,
} from "./traefik-config.js";

export const SITE_JOB_ROLE = "site_job" as const;
export const DEFAULT_SITE_JOB_TIMEOUT_MS = 240_000;
// Same 5 s as BACKUP_RESTORE_LOCK_WAIT_S; not imported because restore-jobs -> backup-jobs -> site-jobs is a load-time ring.
const IMPORT_LOCK_WAIT_S = 5;
export { WORDPRESS_RESULT_MAX_BYTES };
/** Max concurrent connections for a site's primary WordPress database user (R40). */
export const MARIADB_OWN_MAX_USER_CONNECTIONS = 40;
const JOB_MEMORY_BYTES = 536870912;

// The texts below are fixed: params reach them only as $HP_* env, secrets only as /run/secrets files.
const DB_PASSWORD_CHECK = `pw=$(cat /run/secrets/HP_DB_PASSWORD 2>/dev/null || true)
case "$pw" in *[!0-9a-f]*) exit 64;; esac
[ "\${#pw}" -eq 64 ] || exit 64`;

/** hp_mariadb "running" is not "ready" right after its first init: retry for up to ~60 s. */
const DB_CONNECT_PREAMBLE = `printf '[client]\\nuser=root\\nhost=hp-mariadb\\npassword=%s\\n' "$(cat /run/secrets/mariadb-root)" > /tmp/c.cnf
i=0; until mariadb --defaults-extra-file=/tmp/c.cnf -e 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && exit 11; sleep 2; done`;

export const DB_PROVISION_SCRIPT = `set -eu
${DB_PASSWORD_CHECK}
${DB_CONNECT_PREAMBLE}
mariadb --defaults-extra-file=/tmp/c.cnf <<SQL
CREATE DATABASE IF NOT EXISTS \\\`$HP_DB_NAME\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$HP_DB_USER'@'%' IDENTIFIED BY '$pw';
ALTER USER '$HP_DB_USER'@'%' IDENTIFIED BY '$pw' WITH MAX_USER_CONNECTIONS ${String(MARIADB_OWN_MAX_USER_CONNECTIONS)};
GRANT ALL PRIVILEGES ON \\\`$HP_DB_NAME_ESCAPED\\\`.* TO '$HP_DB_USER'@'%';
SQL
`;

export const DB_DROP_SCRIPT = `set -eu
${DB_CONNECT_PREAMBLE}
mariadb --defaults-extra-file=/tmp/c.cnf <<SQL
DROP DATABASE IF EXISTS \\\`$HP_DB_NAME\\\`;
DROP USER IF EXISTS '$HP_DB_USER'@'%';
SQL
`;

// No secret reaches argv or the output (W5); a retry after a half install still sets the admin password.
export const WORDPRESS_INSTALL_SCRIPT = `set -eu
i=0; until [ -f wp-includes/version.php ]; do i=$((i+1)); [ "$i" -ge 60 ] && exit 10; sleep 2; done
if [ -f wp-config.php ]; then
  wp config has HP_MANAGED --type=constant || exit 20
else
${DB_PASSWORD_CHECK}
  wp config create --dbname="$HP_DB_NAME" --dbuser="$HP_DB_USER" --dbhost=hp-mariadb --skip-check --dbpass=hp-pending-db-password
  php -r '$c = file_get_contents("wp-config.php"); $c = str_replace("hp-pending-db-password", file_get_contents("/run/secrets/HP_DB_PASSWORD"), $c, $n); if ($n !== 1 || file_put_contents("wp-config.php", $c) === false) exit(1);'
  wp config set HP_MANAGED true --raw --type=constant
fi
if ! wp core is-installed; then
  wp core install --url="$HP_SITE_URL" --title="$HP_TITLE" --admin_user="$HP_ADMIN_USER" --admin_email="$HP_ADMIN_EMAIL" \\
    --skip-email --admin_password="$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)"
fi
if [ -f /run/secrets/HP_ADMIN_PASSWORD ]; then
  wp eval --skip-plugins --skip-themes '$u = get_user_by("login", getenv("HP_ADMIN_USER")); $p = file_get_contents("/run/secrets/HP_ADMIN_PASSWORD"); if (!$u || !is_string($p) || $p === "") exit(1); wp_set_password(wp_slash($p), $u->ID);'
fi
wp rewrite structure '/%postname%/'
grep -q '^# BEGIN WordPress' .htaccess 2>/dev/null || printf '%s\\n' "$HP_HTACCESS_WORDPRESS" >> .htaccess
grep -q '^# BEGIN hosting-panel' .htaccess || { printf '%s\\n' "$HP_HTACCESS_PANEL" | cat - .htaccess > .htaccess.new && mv .htaccess.new .htaccess; }
`;

// R163: one regex pass rewrites the old origin (either scheme, plain or JSON-escaped slashes) unless the next byte continues the host,
// so http://hotel.it never matches inside http://hotel.italia-tours.com; one transaction, any failed query rolls it back (26).
// R165.1: only rows of the prefix's base tables whose text holds the old host are read, in key batches, through wp-cli's SearchReplacer.
// R166: a batch holds only keys and each row is read alone; a value over its column's limit stays as it was; the session is handed back.
const ADDRESS_REWRITE = `h=$(printf '%s' "\${HP_PREVIOUS_URL#*://}" | sed 's/[.]/\\\\./g')
HP_RW_FROM='https?:(\\\\?/)\\1'"$h"'(?![A-Za-z0-9\\x80-\\xff-]|\\.[A-Za-z0-9\\x80-\\xff-]|:[0-9]|@)' HP_RW_TO="\${HP_SITE_URL%%://*}"':\${1}\${1}'"\${HP_SITE_URL#*://}" wp eval --skip-plugins --skip-themes '
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
try {
  global $wpdb;
  $db = $wpdb->dbh;
  $db->autocommit(false);
  $u = getenv("HP_PREVIOUS_URL");
  $h = substr($u, strpos($u, "://") + 3);
  $r = new WP_CLI\\SearchReplacer(getenv("HP_RW_FROM"), getenv("HP_RW_TO"), true, true, "", chr(1));
  $n = fn($s) => chr(96) . str_replace(chr(96), chr(96) . chr(96), $s) . chr(96);
  foreach (WP_CLI\\Utils\\wp_get_table_names(array(), array("all-tables-with-prefix" => true, "base-tables-only" => true)) as $t) {
    $k = $c = $m = array();
    foreach ($db->query("DESCRIBE " . $n($t)) as $f) {
      if ($f["Key"] === "PRI") $k[] = $f["Field"];
      if (!preg_match("/text|varchar/i", $f["Type"]) || in_array($f["Field"], array("guid", "user_pass"), true)) continue;
      $c[] = $f["Field"];
      $m[$f["Field"]] = preg_match("/char[(]([0-9]+)[)]/", $f["Type"], $g) ? array(1, (int) $g[1]) : array(0, array("tinytext" => 255, "text" => 65535, "mediumtext" => 16777215)[$f["Type"]] ?? PHP_INT_MAX);
    }
    if (!$k || !$c) continue;
    $kw = implode(" AND ", array_map(fn($x) => $n($x) . " = ?", $k));
    $sel = "SELECT " . implode(", ", array_map($n, $k)) . " FROM " . $n($t) . " WHERE (" . implode(" OR ", array_map(fn($x) => $n($x) . " LIKE BINARY ?", $c)) . ")";
    $one = "SELECT " . implode(", ", array_map($n, $c)) . " FROM " . $n($t) . " WHERE " . $kw;
    $last = null;
    do {
      $w = "";
      $p = array_fill(0, count($c), "%" . addcslashes($h, "\\\\%_") . "%");
      if ($last) {
        $o = array();
        for ($i = count($k) - 1; $i >= 0; $i--) {
          $a = array();
          for ($j = 0; $j <= $i; $j++) { $a[] = $n($k[$j]) . ($j < $i ? " = ?" : " > ?"); $p[] = $last[$k[$j]]; }
          $o[] = implode(" AND ", $a);
        }
        $w = " AND ((" . implode(") OR (", $o) . "))";
      }
      $rows = $db->execute_query($sel . $w . " ORDER BY " . implode(", ", array_map($n, $k)) . " LIMIT 500", $p)->fetch_all(MYSQLI_ASSOC);
      foreach ($rows as $key) {
        $row = $db->execute_query($one, array_values($key))->fetch_assoc();
        $set = array();
        foreach ($c as $x) {
          $v = is_string($row[$x] ?? null) && strpos($row[$x], $h) !== false ? $r->run($row[$x]) : null;
          if (is_string($v) && $v !== $row[$x] && ($m[$x][0] ? mb_strlen($v, "UTF-8") : strlen($v)) <= $m[$x][1]) $set[$x] = $v;
        }
        if ($set) $db->execute_query("UPDATE " . $n($t) . " SET " . implode(", ", array_map(fn($x) => $n($x) . " = ?", array_keys($set))) . " WHERE " . $kw, array_merge(array_values($set), array_values($key)));
      }
      $last = end($rows);
    } while (count($rows) === 500);
  }
  $db->commit();
  mysqli_report(MYSQLI_REPORT_OFF);
  $db->autocommit(true);
} catch (Throwable $e) { exit(1); }' || exit 26`;

export const WORDPRESS_SET_URL_SCRIPT = `set -eu
wp config has HP_MANAGED --type=constant || exit 20
wp option update home "$HP_SITE_URL" --skip-plugins --skip-themes
wp option update siteurl "$HP_SITE_URL" --skip-plugins --skip-themes
[ "$HP_PREVIOUS_URL" = "$HP_SITE_URL" ] && exit 0
${ADDRESS_REWRITE}
`;

// R153: the job with the root key checks every name it renames itself (84 staging, 85 live, 92 at undo).
export const DB_IMPORT_SCRIPT = `set -eu
case "$HP_IMPORT_ID" in *[!0-9a-f]*) exit 64;; esac
[ "\${#HP_IMPORT_ID}" -eq 32 ] || exit 64
printf '%s' "$HP_PREFIX" | grep -Eqx 'wp_[0-9a-f]{12}' || exit 64
I=$HP_IMPORT_ID; D=$HP_PREFIX; S=hp_is_$I; A=hp_ia_$I; M=hp_im_$I; U=hp_iu_$I
${DB_CONNECT_PREAMBLE}
q() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B -r --sandbox -e "$1"; }
objs() { q "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$1' AND (TABLE_TYPE<>'BASE TABLE' OR TABLE_NAME REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), TABLE_NAME) > 0 OR LOCATE(CHAR(92), TABLE_NAME) > 0)) + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$1') + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$1') + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='$1')"; }
live_ok() { o=$(objs "$D"); [ "$o" = 0 ] || exit 85; }
renames() { q "SELECT CONCAT('\\\`$1\\\`.\\\`', REPLACE(TABLE_NAME, '\\\`', '\\\`\\\`'), '\\\` TO \\\`$2\\\`.\\\`', REPLACE(TABLE_NAME, '\\\`', '\\\`\\\`'), '\\\`,') FROM information_schema.TABLES WHERE TABLE_SCHEMA='$1' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"; }
tables() { q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$1'"; }
marker() { q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$M'"; }
swap() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" --sandbox --binary-mode < /tmp/r.sql; }
drop_account() {
  q "DROP USER IF EXISTS '$U'@'%'"
  ids=$(q "SELECT ID FROM information_schema.PROCESSLIST WHERE USER='$U'")
  for c in $ids; do q "KILL CONNECTION $c" 2>/dev/null || :; done
}
case "$HP_STEP" in
prepare)
  pw=$(cat /run/secrets/HP_IMPORT_DB_PASSWORD 2>/dev/null || true)
  case "$pw" in *[!0-9a-f]*) exit 64;; esac
  [ "\${#pw}" -eq 64 ] || exit 64
  x=$(q "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('$A', '$M')")
  [ -z "$x" ] || exit 86
  live_ok
  drop_account
  q "DROP DATABASE IF EXISTS \\\`$S\\\`; CREATE DATABASE \\\`$S\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER '$U'@'%' IDENTIFIED BY '$pw' WITH MAX_USER_CONNECTIONS 2; GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, LOCK TABLES, REFERENCES ON \\\`hp\\\\_is\\\\_$I\\\`.* TO '$U'@'%'" ;;
switch)
  mk=$(marker); [ "$mk" != after ] || exit 0
  t=$(tables "$S"); [ "$t" -gt 0 ] || exit 86
  live_ok
  drop_account
  o=$(objs "$S"); [ "$o" = 0 ] || exit 84
  q "CREATE DATABASE IF NOT EXISTS \\\`$A\\\`; CREATE DATABASE IF NOT EXISTS \\\`$M\\\`; CREATE TABLE IF NOT EXISTS \\\`$M\\\`.\\\`before\\\` (x INT)"
  { echo 'RENAME TABLE'; renames "$D" "$A"; renames "$S" "$D"; echo "\\\`$M\\\`.\\\`before\\\` TO \\\`$M\\\`.\\\`after\\\`;"; } > /tmp/r.sql
  swap ;;
undo)
  drop_account
  mk=$(marker)
  if [ "$mk" = after ]; then
    d=$(objs "$D"); a=$(objs "$A"); [ "$d" = 0 ] && [ "$a" = 0 ] || exit 92
    q "CREATE DATABASE IF NOT EXISTS \\\`$S\\\`"
    { echo 'RENAME TABLE'; renames "$D" "$S"; renames "$A" "$D"; echo "\\\`$M\\\`.\\\`after\\\` TO \\\`$M\\\`.\\\`before\\\`;"; } > /tmp/r.sql
    swap
  fi
  a=$(tables "$A"); [ "$a" = 0 ] || exit 92
  q "DROP DATABASE IF EXISTS \\\`$S\\\`; DROP DATABASE IF EXISTS \\\`$A\\\`; DROP DATABASE IF EXISTS \\\`$M\\\`" ;;
finish)
  drop_account
  mk=$(marker); a=$(tables "$A"); [ "$mk" = after ] || [ "$a" = 0 ] || exit 97
  q "DROP DATABASE IF EXISTS \\\`$S\\\`; DROP DATABASE IF EXISTS \\\`$A\\\`; DROP DATABASE IF EXISTS \\\`$M\\\`" ;;
*) exit 64 ;;
esac
`;

// Runs as the throw-away account of the staging schema only; the stderr of the client is never echoed.
export const DB_IMPORT_LOAD_SCRIPT = `set -eu
case "$HP_IMPORT_ID" in *[!0-9a-f]*) exit 64;; esac
[ "\${#HP_IMPORT_ID}" -eq 32 ] || exit 64
pw=$(cat /run/secrets/HP_IMPORT_DB_PASSWORD 2>/dev/null || true)
case "$pw" in *[!0-9a-f]*) exit 64;; esac
[ "\${#pw}" -eq 64 ] || exit 64
F=/var/www/html/.htpanel-import/dump; T=$(mktemp -d)
printf '[client]\\nuser=hp_iu_%s\\nhost=hp-mariadb\\npassword=%s\\n' "$HP_IMPORT_ID" "$pw" > "$T/c.cnf"
m() { mariadb --defaults-extra-file="$T/c.cnf" --default-character-set=utf8mb4 -N -B --sandbox --local-infile=0 "$@" -- "hp_is_$HP_IMPORT_ID"; }
i=0; until m -e 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && exit 11; sleep 2; done
[ -f "$F" ] && [ ! -L "$F" ] || exit 50
exec 3< "$F"
v=$(readlink /proc/$$/fd/3 || :); [ "$v" = "$F" ] && [ -f /proc/$$/fd/3 ] || exit 50
v=$(od -An -tx1 -N2 /proc/$$/fd/3 | tr -d ' \\n'); if [ "$v" = 1f8b ]; then z="gzip -dc"; else z=cat; fi
{ $z < /proc/$$/fd/3 2>/dev/null || :; } | head -c 1024 > "$T/head"
[ -s "$T/head" ] || exit 51; v=$(tr -d '\\000' < "$T/head" | wc -c); w=$(wc -c < "$T/head"); [ "$v" -eq "$w" ] || exit 51
mkfifo "$T/a" "$T/b"
tail -c 4096 < "$T/a" > "$T/tail" &
wc -c < "$T/b" > "$T/n" &
rc=0
{ $z <&3 2>/dev/null || echo "$?" > "$T/zrc"; } | head -c 4294967297 | tee "$T/a" "$T/b" | m --binary-mode > /dev/null 2> "$T/err" || rc=$?
wait
exec 3<&-
v=$(cat "$T/n"); [ "$v" -le 4294967296 ] || exit 52
v=$(cat "$T/zrc" 2>/dev/null || echo 0); [ "$v" != 1 ] || exit 51
if [ "$rc" -ne 0 ]; then
  e=$(sed -n 's/^ERROR \\([0-9]\\{1,5\\}\\) ([0-9A-Z]\\{5\\}) at line \\([0-9]\\{1,10\\}\\):.*/\\1 \\2/p' "$T/err" | head -n 1)
  [ -n "$e" ] || e=$(sed -n 's/^ERROR at line \\([0-9]\\{1,10\\}\\):.*/null \\1/p' "$T/err" | head -n 1)
  set -- \${e:-none 0}
  [ "$1" != none ] || { printf '{"line":0,"errorNumber":null}\\n'; exit 60; }
  printf '{"line":%s,"errorNumber":%s}\\n' "$2" "$1"
  case "$1" in null|1044|1045|1142|1143|1193|1227|1370|4166) exit 61;; *) exit 60;; esac
fi
if grep -Eq '^-- (MySQL|MariaDB) dump' "$T/head"; then
  v=$(grep -v '^[[:space:]]*$' "$T/tail" | tail -n 1 | cut -c 1-17); [ "$v" = "-- Dump completed" ] || exit 53
fi
q() { m -e "$1"; }
c=$(q "SELECT COUNT(*), SUM(TABLE_TYPE<>'BASE TABLE' OR COALESCE(ENGINE,'') NOT IN ('InnoDB','MyISAM','Aria') OR CREATE_OPTIONS LIKE '%DIRECTORY%' OR CREATE_OPTIONS LIKE '%partitioned%'), SUM(TABLE_NAME REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), TABLE_NAME) > 0 OR LOCATE(CHAR(92), TABLE_NAME) > 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()")
t=$(q "SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE())")
set -- $c $t
n=$1
[ "$n" -le 1000 ] || exit 62
[ "$n" -gt 0 ] && [ "$2" = 0 ] && [ "$4" = 0 ] || { [ "$n" -gt 0 ] || exit 54; exit 57; }
[ "$3" = 0 ] || exit 58
p=$(q "SELECT LEFT(TABLE_NAME, CHAR_LENGTH(TABLE_NAME) - 7) p FROM information_schema.TABLES c WHERE TABLE_SCHEMA=DATABASE() AND RIGHT(TABLE_NAME, 7)=BINARY 'options' AND (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=DATABASE() AND BINARY t.TABLE_NAME IN (CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'options'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'posts'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'postmeta'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'users'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'usermeta'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'terms'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'term_taxonomy'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'term_relationships'), CONCAT(LEFT(c.TABLE_NAME, CHAR_LENGTH(c.TABLE_NAME) - 7), 'comments'))) = 9 LIMIT 2")
[ -n "$p" ] || exit 54
v=$(printf '%s\\n' "$p" | wc -l); [ "$v" -eq 1 ] || exit 55
printf '%s' "$p" | grep -Eqx '[A-Za-z0-9_]{1,32}' || exit 58
b=$(q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME IN ('\${p}blogs', '\${p}site', '\${p}sitemeta')")
[ "$b" = 0 ] || exit 56
o='https?://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?'
u=$(q "SELECT EXISTS(SELECT 1 FROM \\\`\${p}users\\\`)")
[ "$u" = 1 ] || exit 59
h=$(q "SELECT option_value FROM \\\`\${p}options\\\` WHERE option_name = 'home'")
s=$(q "SELECT option_value FROM \\\`\${p}options\\\` WHERE option_name = 'siteurl'")
printf '%s' "$h" | grep -Eqx "$o" && printf '%s' "$s" | grep -Eqx "$o" || exit 59
case "$h$s" in *"
"*) exit 59;; esac
[ "\${h#*://}" = "\${s#*://}" ] || exit 59
printf '{"prefix":"%s","oldUrl":"%s","tables":%s}\\n' "$p" "$h" "$n"
`;

// `wp config set` edits wp-config.php without running it, also behind the import gate.
export const WORDPRESS_IMPORT_FINALIZE_SCRIPT = `set -eu
wp config has HP_MANAGED --type=constant || exit 20
printf '%s' "$HP_TABLE_PREFIX" | grep -Eqx '[A-Za-z0-9_]{1,32}' || exit 64
wp config set table_prefix "$HP_TABLE_PREFIX" --type=variable
wp core is-installed --skip-plugins --skip-themes || exit 25
wp option update home "$HP_SITE_URL" --skip-plugins --skip-themes || exit 25
wp option update siteurl "$HP_SITE_URL" --skip-plugins --skip-themes || exit 25
if [ "$HP_PREVIOUS_URL" != "$HP_SITE_URL" ]; then
${ADDRESS_REWRITE.replace(/^/gm, "  ")}
fi
[ "$(wp option get home --skip-plugins --skip-themes)" = "$HP_SITE_URL" ] || exit 25
`;

// Exit 21 not WordPress, 22 broken wp-config (wp-cli 255), 23 database unreachable or not installed.
const WORDPRESS_PREFLIGHT = `[ -f wp-includes/version.php ] && [ -f wp-config.php ] || exit 21
rc=0; wp core is-installed --skip-plugins --skip-themes || rc=$?
[ "$rc" -eq 255 ] && exit 22
[ "$rc" -eq 0 ] || exit 23`;

// The body writes to stderr only, so site code cannot forge the one stdout line the converter prints.
// R140/R147.1: a failed lookup leaves only last_checked; an answered one always writes `response` (`checked` needs a plugin).
export const WORDPRESS_INSPECT_SCRIPT = `set -eu
{
${WORDPRESS_PREFLIGHT}
mkdir /tmp/hp
if curl -fsS -o /dev/null --max-time 15 https://api.wordpress.org/core/version-check/1.7/; then
  wp core check-update --format=json --skip-plugins --skip-themes > /tmp/hp/core.json
  wp plugin list --fields=name,title,status,version,update,update_version --format=json --skip-plugins --skip-themes > /tmp/hp/plugins.json
  wp theme list --fields=name,title,status,version,update,update_version --format=json --skip-plugins --skip-themes > /tmp/hp/themes.json
  wp eval --skip-plugins --skip-themes 'foreach (["update_plugins", "update_themes"] as $t) { $v = get_site_transient($t); if (!is_object($v) || !isset($v->response)) exit(1); }' && : > /tmp/hp/answered || true
else
  wp plugin list --fields=name,title,status,version --skip-update-check --format=json --skip-plugins --skip-themes > /tmp/hp/plugins.json
  wp theme list --fields=name,title,status,version --skip-update-check --format=json --skip-plugins --skip-themes > /tmp/hp/themes.json
fi
wp core version > /tmp/hp/version
wp user list --role=administrator --fields=ID,user_login --format=json --skip-plugins --skip-themes > /tmp/hp/admins.json
} >&2
php -r '$read = function ($f) { $s = is_file("/tmp/hp/$f") && filesize("/tmp/hp/$f") <= 4194304 ? file_get_contents("/tmp/hp/$f") : false; if ($s === false) exit(70); $v = json_decode(trim($s) === "" ? "[]" : trim(strrchr("\\n" . trim($s), "\\n")), true); if (!is_array($v)) exit(70); return $v; };
$s = fn ($v, $n) => is_scalar($v) ? mb_substr(preg_replace("/[\\\\p{Cc}\\\\p{Cf}]+/u", "", (string) $v) ?? "", 0, $n) : null;
$opt = fn ($v) => is_string($v) && $v !== "" ? $v : null;
$known = is_file("/tmp/hp/core.json") && is_file("/tmp/hp/answered"); $cu = null;
$items = fn ($rows) => array_map(fn ($p) => ["name" => $p["name"] ?? null, "title" => $s($p["title"] ?? "", 200), "status" => $p["status"] ?? null, "version" => $opt($s($p["version"] ?? "", 40)), "updateVersion" => $known && ($p["update"] ?? "") === "available" ? $opt($s($p["update_version"] ?? "", 40)) : null], array_filter($rows, "is_array"));
foreach ($known ? $read("core.json") : [] as $c) { $v = $c["version"] ?? null; if (is_string($v) && ($cu === null || version_compare($v, $cu, ">"))) $cu = $v; }
echo json_encode(["coreVersion" => $s(file_get_contents("/tmp/hp/version"), 40), "coreUpdate" => $cu, "updatesKnown" => $known, "plugins" => array_values($items($read("plugins.json"))), "themes" => array_values($items($read("themes.json"))), "administrators" => array_values(array_map(fn ($a) => ["id" => $a["ID"] ?? null, "login" => $s($a["user_login"] ?? null, 60)], array_filter($read("admins.json"), "is_array")))], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), "\\n";'
`;

// Exit 30 wordpress.org unreachable (nothing changed), 31 item not installed, 32 an item failed, 64 bad target.
export const WORDPRESS_UPDATE_SCRIPT = `set -eu
{
${WORDPRESS_PREFLIGHT}
mkdir /tmp/hp
curl -fsS -o /dev/null --max-time 15 https://api.wordpress.org/core/version-check/1.7/ || exit 30
case "$HP_TARGET" in
  plugin:*) n="\${HP_TARGET#plugin:}"; wp plugin is-installed "$n" --skip-plugins --skip-themes || exit 31 ;;
  theme:*) n="\${HP_TARGET#theme:}"; wp theme is-installed "$n" --skip-plugins --skip-themes || exit 31 ;;
  core|all) ;;
  *) exit 64 ;;
esac
rc=0
if [ "$HP_TARGET" = core ] || [ "$HP_TARGET" = all ]; then
  wp core version > /tmp/hp/core-old
  c=0; { wp core update --skip-plugins --skip-themes && wp core update-db --skip-plugins --skip-themes; } || c=1
  echo "$c" > /tmp/hp/core-rc; [ "$c" -eq 0 ] || rc=1
  wp core version > /tmp/hp/core-new
fi
case "$HP_TARGET" in
  plugin:*) wp plugin update "$n" --format=json --skip-plugins --skip-themes > /tmp/hp/plugins.json || rc=1 ;;
  theme:*) wp theme update "$n" --format=json --skip-plugins --skip-themes > /tmp/hp/themes.json || rc=1 ;;
  all) wp plugin update --all --format=json --skip-plugins --skip-themes > /tmp/hp/plugins.json || rc=1
    wp theme update --all --format=json --skip-plugins --skip-themes > /tmp/hp/themes.json || rc=1 ;;
esac
echo "$rc" > /tmp/hp/rc
} >&2
php -r '$read = function ($f) { $s = filesize("/tmp/hp/$f") <= 4194304 ? file_get_contents("/tmp/hp/$f") : false; if ($s === false) exit(70); $v = json_decode(trim($s) === "" ? "[]" : trim(strrchr("\\n" . trim($s), "\\n")), true); if (!is_array($v)) exit(70); return $v; };
$out = []; $rc = trim((string) file_get_contents("/tmp/hp/rc"));
if (is_file("/tmp/hp/core-old")) { $o = trim(file_get_contents("/tmp/hp/core-old")); $n = trim((string) file_get_contents("/tmp/hp/core-new")); $ok = trim((string) file_get_contents("/tmp/hp/core-rc")) === "0"; if ($o !== $n || !$ok) $out[] = ["type" => "core", "name" => "wordpress", "oldVersion" => $o, "newVersion" => $o !== $n && $n !== "" ? $n : null, "status" => $ok && $o !== $n ? "updated" : "failed"]; }
foreach (["plugin", "theme"] as $t) { if (is_file("/tmp/hp/{$t}s.json")) { foreach ($read("{$t}s.json") as $i) { $u = is_array($i) && ($i["status"] ?? "") === "Updated"; $out[] = ["type" => $t, "name" => $i["name"] ?? null, "oldVersion" => $i["old_version"] ?? null, "newVersion" => $u ? ($i["new_version"] ?? null) : null, "status" => $u ? "updated" : "failed"]; } } }
echo json_encode(["items" => $out], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), "\\n";
exit($rc === "0" && !in_array("failed", array_column($out, "status"), true) ? 0 : 32);'
`;

// Loads no site code: only removes the marker a killed update leaves behind.
export const WORDPRESS_SETTLE_SCRIPT = `set -eu
rm -f /var/www/html/.maintenance
`;

// The secret is read from its file inside PHP, never from argv; WordPress checks the slashed password at login.
export const WORDPRESS_RESET_PASSWORD_SCRIPT = `set -eu
${WORDPRESS_PREFLIGHT}
wp eval --skip-plugins --skip-themes '$u = get_userdata((int) getenv("HP_USER_ID")); if (!$u || !in_array("administrator", (array) $u->roles, true)) exit(40); $p = file_get_contents("/run/secrets/HP_ADMIN_PASSWORD"); if (!is_string($p) || $p === "") exit(64); wp_set_password(wp_slash($p), $u->ID); WP_Session_Tokens::get_instance($u->ID)->destroy_all();'
`;

// `wp rewrite --hard` writes no .htaccess under the CLI without an apache_modules config.
export const HTACCESS_WORDPRESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress`;

export const HTACCESS_PANEL = `# BEGIN hosting-panel
SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on
# END hosting-panel`;

type Check = (value: string) => boolean;
const dbIdentifier: Check = (v) => SITE_DB_IDENTIFIER_PATTERN.test(v);
const matches =
  (schema: { safeParse(v: unknown): { success: boolean } }): Check =>
  (v) =>
    schema.safeParse(v).success;
const siteInput = CreateManagedSiteInputSchema.shape;
const isPhpVersion = (v: string): v is PhpVersion => (SUPPORTED_PHP_VERSIONS as readonly string[]).includes(v);

const SECRET_CHECKS: Readonly<Record<string, Check>> = {
  // Spliced into root SQL by db.provision: never trust the caller on its shape.
  HP_DB_PASSWORD: (v) => /^[0-9a-f]{64}$/.test(v),
  HP_ADMIN_PASSWORD: matches(siteInput.adminPassword),
  // Spliced into root SQL by db.import prepare, like HP_DB_PASSWORD.
  HP_IMPORT_DB_PASSWORD: (v) => /^[0-9a-f]{64}$/.test(v),
};

const importId: Check = (v) => /^[0-9a-f]{32}$/.test(v);

export interface SiteJobSpec {
  readonly params: Readonly<Record<string, Check>>;
  readonly requiredSecrets: readonly string[];
  readonly optionalSecrets: readonly string[];
  /** Own limit; the job also kills itself 5 s after it. Absent: DEFAULT_SITE_JOB_TIMEOUT_MS, no self-kill. */
  readonly timeoutMs?: number;
  /** The adapter connects the site's edge network (internet) between create and start. */
  readonly edgeNetwork?: true;
  /** The job prints one JSON line on stdout, checked by this schema. */
  readonly result?: z.ZodType<WordpressStateResult | WordpressUpdateResult | WordpressImportLoadResult>;
}

export const SITE_JOB_SPECS: Readonly<Record<SiteJobKind, SiteJobSpec>> = {
  "db.provision": {
    params: { dbName: dbIdentifier, dbUser: dbIdentifier },
    requiredSecrets: ["HP_DB_PASSWORD"],
    optionalSecrets: [],
  },
  "db.drop": {
    params: { dbName: dbIdentifier, dbUser: dbIdentifier },
    requiredSecrets: [],
    optionalSecrets: [],
  },
  "wordpress.install": {
    params: {
      phpVersion: isPhpVersion,
      dbName: dbIdentifier,
      dbUser: dbIdentifier,
      siteUrl: (v) => v.startsWith("http://") && normalizeSiteDomain(v.slice(7)) === v.slice(7),
      title: matches(siteInput.title),
      adminUser: matches(siteInput.adminUser),
      adminEmail: matches(siteInput.adminEmail),
    },
    requiredSecrets: ["HP_DB_PASSWORD"],
    // Deleted by the API once install succeeds; a retry finds WordPress installed and never reads it.
    optionalSecrets: ["HP_ADMIN_PASSWORD"],
  },
  "wordpress.set-url": {
    params: { phpVersion: isPhpVersion, siteUrl: isSiteOrigin, previousUrl: isSiteOrigin },
    requiredSecrets: [],
    optionalSecrets: [],
    timeoutMs: SITE_JOB_LIMIT_MS["wordpress.set-url"],
  },
  "wordpress.inspect": {
    params: { phpVersion: isPhpVersion },
    requiredSecrets: [],
    optionalSecrets: [],
    timeoutMs: 240_000,
    edgeNetwork: true,
    result: WordpressStateResultSchema,
  },
  "wordpress.update": {
    params: { phpVersion: isPhpVersion, target: (v) => WORDPRESS_UPDATE_TARGET_PATTERN.test(v) },
    requiredSecrets: [],
    optionalSecrets: [],
    timeoutMs: 240_000,
    edgeNetwork: true,
    result: WordpressUpdateResultSchema,
  },
  "wordpress.settle": {
    params: { phpVersion: isPhpVersion },
    requiredSecrets: [],
    optionalSecrets: [],
    timeoutMs: 60_000,
  },
  "wordpress.reset-password": {
    params: { phpVersion: isPhpVersion, userId: (v) => WORDPRESS_USER_ID_PATTERN.test(v) },
    requiredSecrets: ["HP_ADMIN_PASSWORD"],
    optionalSecrets: [],
    timeoutMs: 60_000,
  },
  "db.import": {
    params: { step: (v) => ["prepare", "switch", "undo", "finish"].includes(v), importId },
    requiredSecrets: [],
    // Read only by prepare.
    optionalSecrets: ["HP_IMPORT_DB_PASSWORD"],
    timeoutMs: SITE_JOB_LIMIT_MS["db.import"],
  },
  "db.import-load": {
    params: { importId },
    requiredSecrets: ["HP_IMPORT_DB_PASSWORD"],
    optionalSecrets: [],
    timeoutMs: SITE_JOB_LIMIT_MS["db.import-load"],
    result: WordpressImportLoadResultSchema,
  },
  "wordpress.import-finalize": {
    params: {
      phpVersion: isPhpVersion,
      tablePrefix: (v) => WORDPRESS_TABLE_PREFIX_PATTERN.test(v),
      siteUrl: isSiteOrigin,
      previousUrl: (v) => v.length <= 300 && IMPORT_ORIGIN_PATTERN.test(v),
    },
    requiredSecrets: [],
    optionalSecrets: [],
    timeoutMs: SITE_JOB_LIMIT_MS["wordpress.import-finalize"],
  },
};

/** The executor's limit for one job of this kind. */
export const siteJobTimeoutMs = (kind: SiteJobKind): number =>
  SITE_JOB_SPECS[kind].timeoutMs ?? DEFAULT_SITE_JOB_TIMEOUT_MS;

/** The checked result of an inspect, update or import-load job; undefined for anything else, never throws. */
export function parseWordpressJobResult(
  kind: SiteJobKind,
  stdout: string,
): WordpressStateResult | WordpressUpdateResult | WordpressImportLoadResult | undefined {
  const schema = Object.hasOwn(SITE_JOB_SPECS, kind) ? SITE_JOB_SPECS[kind].result : undefined;
  if (schema === undefined || Buffer.byteLength(stdout, "utf8") > WORDPRESS_RESULT_MAX_BYTES) return undefined;
  const text = stdout.trim();
  if (text === "" || text.includes("\n")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const SITE_JOB_SCRIPTS: Readonly<Record<SiteJobKind, string>> = {
  "db.provision": DB_PROVISION_SCRIPT,
  "db.drop": DB_DROP_SCRIPT,
  "wordpress.install": WORDPRESS_INSTALL_SCRIPT,
  "wordpress.set-url": WORDPRESS_SET_URL_SCRIPT,
  "wordpress.inspect": WORDPRESS_INSPECT_SCRIPT,
  "wordpress.update": WORDPRESS_UPDATE_SCRIPT,
  "wordpress.settle": WORDPRESS_SETTLE_SCRIPT,
  "wordpress.reset-password": WORDPRESS_RESET_PASSWORD_SCRIPT,
  "db.import": DB_IMPORT_SCRIPT,
  "db.import-load": DB_IMPORT_LOAD_SCRIPT,
  "wordpress.import-finalize": WORDPRESS_IMPORT_FINALIZE_SCRIPT,
};

const invalid = (message: string): never => {
  throw new ExecutorCodedError(message, "VALIDATION_ERROR");
};

/** Throws VALIDATION_ERROR unless kind, params and secrets match the kind's allowlist exactly. */
export function assertValidSiteJobRequest(req: SiteJobRequest): void {
  if (!/^job_/.test(req.jobId)) {
    invalid("jobId must start with job_");
  }
  assertSafeIdentifier(req.jobId, "jobId");
  assertSafeIdentifier(req.siteId, "siteId");
  assertSafeIdentifier(req.organizationId, "organizationId");
  const spec = Object.hasOwn(SITE_JOB_SPECS, req.kind) ? SITE_JOB_SPECS[req.kind] : invalid("Unknown site job kind");

  const params = req.params ?? {};
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(spec.params, key)) {
      invalid(`Unexpected site job parameter '${key.slice(0, 32)}'`);
    }
  }
  for (const [key, check] of Object.entries(spec.params)) {
    const value: unknown = params[key];
    if (typeof value !== "string" || !check(value)) {
      invalid(`Invalid site job parameter '${key}'`);
    }
  }

  const secrets = req.resolvedSecrets ?? {};
  const allowedSecrets = [...spec.requiredSecrets, ...spec.optionalSecrets];
  for (const [name, value] of Object.entries(secrets)) {
    if (!allowedSecrets.includes(name)) {
      invalid(`Unexpected site job secret '${name.slice(0, 32)}'`);
    }
    if (typeof value !== "string" || !SECRET_CHECKS[name]!(value)) {
      invalid(`Invalid site job secret '${name}'`);
    }
  }
  for (const name of spec.requiredSecrets) {
    if (!Object.hasOwn(secrets, name)) {
      invalid(`Missing site job secret '${name}'`);
    }
  }

  if (req.kind.startsWith("wordpress.") || req.kind === "db.import-load") {
    assertSafeIdentifier(req.serviceInstanceId ?? invalid("serviceInstanceId is required"), "serviceInstanceId");
  }
}

export interface SiteJobContext {
  readonly executorUser: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
  readonly rootKeyHostPath: string;
}

type SiteJobCommand = readonly ["sh", "-c", string] | readonly ["timeout", "-s", "KILL", string, "sh", "-c", string];

export interface SiteJobCreatePayload {
  readonly Image: string;
  readonly Entrypoint?: SiteJobCommand;
  readonly Cmd?: SiteJobCommand;
  readonly User: string;
  readonly WorkingDir?: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly Init?: true;
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: "no" };
    readonly LogConfig: { readonly Type: "json-file"; readonly Config: { readonly "max-size": "1m"; readonly "max-file": "1" } };
    readonly NetworkMode: string;
    readonly Binds: readonly string[];
  };
}

/** dbName -> HP_DB_NAME */
const paramEnvName = (param: string): string => `HP_${param.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

export function buildSiteJobContainerPayload(req: SiteJobRequest, ctx: SiteJobContext): SiteJobCreatePayload {
  assertValidSiteJobRequest(req);
  if (ctx.secretBinds.some((b) => !b.endsWith(":ro") || b.includes("docker.sock"))) {
    throw new ExecutorCodedError("Job secret binds must be read-only tmpfs files", "HOST_POLICY_DENIED");
  }

  const env = Object.entries(req.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${paramEnvName(key)}=${value}`);
  if (req.kind === "db.provision" && req.params.dbName !== undefined) {
    // Underscores are single-character wildcards in MariaDB database-level GRANT patterns (R30).
    env.push(`HP_DB_NAME_ESCAPED=${req.params.dbName.replaceAll("_", "\\_")}`);
  }
  if (req.kind === "db.import") {
    // The API never sends the site's database name; the executor derives it, as the restore does.
    env.push(`HP_PREFIX=${siteDatabasePrefix(req.siteId)}`, `HP_LOCK_S=${String(IMPORT_LOCK_WAIT_S)}`);
  }
  const isWordpress = req.kind.startsWith("wordpress.");
  const isLoad = req.kind === "db.import-load";
  if (req.kind === "wordpress.install") {
    env.push(`HP_HTACCESS_WORDPRESS=${HTACCESS_WORDPRESS}`, `HP_HTACCESS_PANEL=${HTACCESS_PANEL}`);
  }
  env.push(...ctx.secretFileEnv);

  const script = SITE_JOB_SCRIPTS[req.kind];
  const ownLimitMs = SITE_JOB_SPECS[req.kind].timeoutMs;
  // I7: the job that reads the export mounts it read-only and never holds the root key.
  const binds = isWordpress
    ? [`${getManagedVolumeName(req.serviceInstanceId!, "html")}:/var/www/html`]
    : isLoad
      ? [`${getManagedVolumeName(req.serviceInstanceId!, "html")}:/var/www/html:ro`]
      : [`${ctx.rootKeyHostPath}:/run/secrets/mariadb-root:ro`];

  // A job with its own limit ends itself even when the executor is down.
  const command: SiteJobCommand =
    ownLimitMs === undefined
      ? ["sh", "-c", script]
      : ["timeout", "-s", "KILL", String(ownLimitMs / 1000 + 5), "sh", "-c", script];

  return {
    Image: isWordpress ? resolveWordpressCliImage(req.params.phpVersion as PhpVersion) : SHARED_MARIADB_IMAGE,
    // R139: the wp-cli image's start-up script would load site code first; the init lets the KILL reach the script.
    ...(isWordpress ? { Entrypoint: command } : { Cmd: command }),
    User: isWordpress || isLoad ? "33:33" : ctx.executorUser,
    ...(isWordpress ? { WorkingDir: "/var/www/html" } : {}),
    Env: env,
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": SITE_JOB_ROLE,
      "io.hostingpanel.site_id": req.siteId,
      "io.hostingpanel.job_id": req.jobId,
    },
    HostConfig: {
      ...(isWordpress ? { Init: true as const } : {}),
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      NanoCpus: 1_000_000_000,
      Memory: JOB_MEMORY_BYTES,
      MemorySwap: JOB_MEMORY_BYTES,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
      NetworkMode: isWordpress ? getSiteInternalNetworkName(req.siteId) : SHARED_DB_NETWORK_NAME,
      Binds: [...binds, ...ctx.secretBinds],
    },
  };
}

/** Last 50 lines, at most 4 KiB; secret values (MariaDB errors quote the SQL) are blanked first. */
export function formatSiteJobOutputTail(
  logs: Buffer,
  secrets: Readonly<Record<string, string>> | undefined,
): string {
  let text = demuxDockerLogStream(logs)
    .slice(-50)
    .map((l) => l.text)
    .join("\n");
  for (const value of Object.values(secrets ?? {})) {
    text = text.replaceAll(value, "[REDACTED]");
  }
  text = redactSensitiveString(text);
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= 4096 ? text : bytes.subarray(bytes.length - 4096).toString("utf8");
}
