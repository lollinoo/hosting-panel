import {
  CreateManagedSiteInputSchema,
  SHARED_MARIADB_IMAGE,
  SITE_DB_IDENTIFIER_PATTERN,
  SUPPORTED_PHP_VERSIONS,
  normalizeSiteDomain,
  redactSensitiveString,
  resolveWordpressCliImage,
  type PhpVersion,
} from "@hosting-panel/contracts";
import type { SiteJobKind, SiteJobRequest } from "@hosting-panel/executor-contracts";
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
ALTER USER '$HP_DB_USER'@'%' IDENTIFIED BY '$pw';
GRANT ALL PRIVILEGES ON \\\`$HP_DB_NAME\\\`.* TO '$HP_DB_USER'@'%';
SQL
`;

export const DB_DROP_SCRIPT = `set -eu
${DB_CONNECT_PREAMBLE}
mariadb --defaults-extra-file=/tmp/c.cnf <<SQL
DROP DATABASE IF EXISTS \\\`$HP_DB_NAME\\\`;
DROP USER IF EXISTS '$HP_DB_USER'@'%';
SQL
`;

// A retry after install already succeeded skips `wp core install`, so the admin password file may be absent.
export const WORDPRESS_INSTALL_SCRIPT = `set -eu
i=0; until [ -f wp-includes/version.php ]; do i=$((i+1)); [ "$i" -ge 60 ] && exit 10; sleep 2; done
if [ -f wp-config.php ]; then
  wp config has HP_MANAGED --type=constant || exit 20
else
  wp config create --dbname="$HP_DB_NAME" --dbuser="$HP_DB_USER" --dbhost=hp-mariadb --skip-check --prompt=dbpass < /run/secrets/HP_DB_PASSWORD
  wp config set HP_MANAGED true --raw --type=constant
fi
wp core is-installed || wp core install --url="$HP_SITE_URL" --title="$HP_TITLE" --admin_user="$HP_ADMIN_USER" \\
  --admin_email="$HP_ADMIN_EMAIL" --skip-email --prompt=admin_password < /run/secrets/HP_ADMIN_PASSWORD
wp rewrite structure '/%postname%/'
grep -q '^# BEGIN WordPress' .htaccess 2>/dev/null || printf '%s\\n' "$HP_HTACCESS_WORDPRESS" >> .htaccess
grep -q '^# BEGIN hosting-panel' .htaccess || { printf '%s\\n' "$HP_HTACCESS_PANEL" | cat - .htaccess > .htaccess.new && mv .htaccess.new .htaccess; }
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

const SITE_JOB_SPECS: Readonly<
  Record<
    SiteJobKind,
    {
      readonly params: Readonly<Record<string, Check>>;
      readonly requiredSecrets: readonly string[];
      readonly optionalSecrets: readonly string[];
    }
  >
> = {
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

  if (req.kind === "wordpress.install") {
    assertSafeIdentifier(req.serviceInstanceId ?? invalid("serviceInstanceId is required"), "serviceInstanceId");
  }
}

export interface SiteJobContext {
  readonly executorUser: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
  readonly rootKeyHostPath: string;
}

export interface SiteJobCreatePayload {
  readonly Image: string;
  readonly Cmd: readonly ["sh", "-c", string];
  readonly User: string;
  readonly WorkingDir?: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: "no" };
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
  const isWordpress = req.kind === "wordpress.install";
  if (isWordpress) {
    env.push(`HP_HTACCESS_WORDPRESS=${HTACCESS_WORDPRESS}`, `HP_HTACCESS_PANEL=${HTACCESS_PANEL}`);
  }
  env.push(...ctx.secretFileEnv);

  const script =
    req.kind === "db.provision" ? DB_PROVISION_SCRIPT : req.kind === "db.drop" ? DB_DROP_SCRIPT : WORDPRESS_INSTALL_SCRIPT;
  const binds = isWordpress
    ? [`${getManagedVolumeName(req.serviceInstanceId!, "html")}:/var/www/html`]
    : [`${ctx.rootKeyHostPath}:/run/secrets/mariadb-root:ro`];

  return {
    Image: isWordpress ? resolveWordpressCliImage(req.params.phpVersion as PhpVersion) : SHARED_MARIADB_IMAGE,
    Cmd: ["sh", "-c", script],
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
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      NanoCpus: 1_000_000_000,
      Memory: JOB_MEMORY_BYTES,
      MemorySwap: JOB_MEMORY_BYTES,
      RestartPolicy: { Name: "no" },
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
