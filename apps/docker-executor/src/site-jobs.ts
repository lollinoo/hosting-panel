import {
  CreateManagedSiteInputSchema,
  SHARED_MARIADB_IMAGE,
  SITE_DB_IDENTIFIER_PATTERN,
  SUPPORTED_PHP_VERSIONS,
  WORDPRESS_RESULT_MAX_BYTES,
  WORDPRESS_UPDATE_TARGET_PATTERN,
  WORDPRESS_USER_ID_PATTERN,
  WordpressStateResultSchema,
  WordpressUpdateResultSchema,
  isSiteOrigin,
  normalizeSiteDomain,
  redactSensitiveString,
  resolveWordpressCliImage,
  type PhpVersion,
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

// Rewrites only origin+delimiter, so http://hotel.it never matches inside http://hotel.italia-tours.com.
export const WORDPRESS_SET_URL_SCRIPT = `set -eu
wp config has HP_MANAGED --type=constant || exit 20
wp option update home "$HP_SITE_URL" --skip-plugins --skip-themes
wp option update siteurl "$HP_SITE_URL" --skip-plugins --skip-themes
[ "$HP_PREVIOUS_URL" = "$HP_SITE_URL" ] && exit 0
p="$HP_PREVIOUS_URL"; n="$HP_SITE_URL"
pe=$(printf '%s' "$p" | sed 's#/#\\\\/#g'); ne=$(printf '%s' "$n" | sed 's#/#\\\\/#g')
for pair in "$p/|$n/" "$p\\"|$n\\"" "$p'|$n'" "$pe\\\\/|$ne\\\\/" "$pe\\"|$ne\\""; do
  wp search-replace "\${pair%%|*}" "\${pair#*|}" --all-tables-with-prefix --skip-columns=guid --precise \\
    --skip-plugins --skip-themes --report-changed-only
done
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
};

export interface SiteJobSpec {
  readonly params: Readonly<Record<string, Check>>;
  readonly requiredSecrets: readonly string[];
  readonly optionalSecrets: readonly string[];
  /** Own limit; the job also kills itself 5 s after it. Absent: DEFAULT_SITE_JOB_TIMEOUT_MS, no self-kill. */
  readonly timeoutMs?: number;
  /** The adapter connects the site's edge network (internet) between create and start. */
  readonly edgeNetwork?: true;
  /** The job prints one JSON line on stdout, checked by this schema. */
  readonly result?: z.ZodType<WordpressStateResult | WordpressUpdateResult>;
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
};

/** The executor's limit for one job of this kind. */
export const siteJobTimeoutMs = (kind: SiteJobKind): number =>
  SITE_JOB_SPECS[kind].timeoutMs ?? DEFAULT_SITE_JOB_TIMEOUT_MS;

/** The checked result of an inspect or update job; undefined for anything else, never throws. */
export function parseWordpressJobResult(
  kind: SiteJobKind,
  stdout: string,
): WordpressStateResult | WordpressUpdateResult | undefined {
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

  if (req.kind.startsWith("wordpress.")) {
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
  const isWordpress = req.kind.startsWith("wordpress.");
  if (req.kind === "wordpress.install") {
    env.push(`HP_HTACCESS_WORDPRESS=${HTACCESS_WORDPRESS}`, `HP_HTACCESS_PANEL=${HTACCESS_PANEL}`);
  }
  env.push(...ctx.secretFileEnv);

  const script = SITE_JOB_SCRIPTS[req.kind];
  const ownLimitMs = SITE_JOB_SPECS[req.kind].timeoutMs;
  const binds = isWordpress
    ? [`${getManagedVolumeName(req.serviceInstanceId!, "html")}:/var/www/html`]
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
    User: isWordpress ? "33:33" : ctx.executorUser,
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
