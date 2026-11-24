/** A template the panel seeds at boot as a disabled draft (built_in = true). Never shown to customers until a server
 *  administrator enables it (spec §3.4); the owner confirms its images (BLOCKED.md #4). */
export interface AppBuiltInTemplate {
  readonly templateId: string;
  readonly versionId: string;
  readonly slug: string;
  /** = x-hp-stack.name of the source. */
  readonly name: string;
  /** = x-hp-stack.category; [a-z]+ only, so it fits both category patterns. */
  readonly category: string;
  /** Italian, = x-hp-stack.description; stored in app_templates.description. */
  readonly description: string;
  /** English twin, for ADR-0035 and the README; not stored. */
  readonly descriptionEn: string;
  /** HCP-STACK/v1 or HCP-STACK/v2, LF only, final newline. */
  readonly source: string;
  /**
   * The versions shipped before `versionId`, oldest first, each byte for byte as it shipped: a stored version is never
   * rewritten, so a change is a new version. The seed adds the missing ones; `versionId` is the newest and the default.
   */
  readonly previousVersions?: readonly AppBuiltInTemplateVersion[];
}

/** An earlier version of a built-in template. */
export interface AppBuiltInTemplateVersion {
  readonly versionId: string;
  readonly source: string;
}

const HTTP_CACHE_DESCRIPTION =
  "Un sito web leggero che risponde in HTTP, con accanto una cache in memoria raggiungibile soltanto dagli altri componenti con il nome cache:11211. La cache non conserva dati.";

const WORKER_STORAGE_DESCRIPTION =
  "Un lavoro in background che a intervalli regolari aggiorna un contatore in un archivio chiave-valore persistente. I dati sono conservati anche quando lo stack viene cancellato, salvo richiesta esplicita.";

const WORDPRESS_DESCRIPTION_1 =
  "Un sito WordPress con il suo database. Le password del database sono generate dalla piattaforma: non c'è nulla da inserire. Dopo aver collegato il dominio, apri subito il sito e completa la configurazione iniziale di WordPress (titolo, utente e password dell'amministratore): finché non lo fai, chiunque raggiunga l'indirizzo può farlo al posto tuo. Sito e database sono conservati anche quando l'applicazione viene cancellata, salvo richiesta esplicita.";

const WORDPRESS_DESCRIPTION = `${WORDPRESS_DESCRIPTION_1} Puoi caricare file fino a 64 MB.`;

const httpCache: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_http_cache",
  versionId: "atv_http_cache_1",
  slug: "http-cache",
  name: "Sito HTTP con cache",
  category: "web",
  description: HTTP_CACHE_DESCRIPTION,
  descriptionEn:
    "A lightweight website answering over HTTP, with an in-memory cache next to it that only the other components can reach, at cache:11211. The cache keeps no data.",
  source: [
    "x-hp-stack:",
    "  schemaVersion: 1",
    '  name: "Sito HTTP con cache"',
    "  category: web",
    `  description: "${HTTP_CACHE_DESCRIPTION}"`,
    "x-hp-parameters:",
    "  - key: cache_memory_mb",
    '    label: "Memoria della cache (MB)"',
    "    type: integer",
    "    min: 16",
    "    max: 96",
    "    default: 48",
    "    customer: true",
    "services:",
    "  web:",
    "    image: nginxinc/nginx-unprivileged:1.31.7-alpine3.24-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7",
    "    expose:",
    "      - 8080",
    "    depends_on:",
    "      - cache",
    "    healthcheck:",
    "      kind: http",
    "      port: 8080",
    "      path: /",
    "      intervalSeconds: 10",
    "      timeoutSeconds: 3",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "0.25"',
    "          memory: 64M",
    "  cache:",
    "    image: memcached:1.6.45-alpine3.24@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d",
    '    command: ["memcached", "-m", "${cache_memory_mb}", "-c", "256"]',
    "    expose:",
    "      - 11211",
    "    healthcheck:",
    "      kind: tcp",
    "      port: 11211",
    "      intervalSeconds: 10",
    "      timeoutSeconds: 3",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "0.25"',
    "          memory: 128M",
    "x-hp-ingress:",
    "  - service: web",
    "    port: 8080",
    "    protocol: http",
    "",
  ].join("\n"),
});

const workerStorage: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_worker_storage",
  versionId: "atv_worker_storage_1",
  slug: "worker-storage",
  name: "Lavoro periodico con archivio",
  category: "jobs",
  description: WORKER_STORAGE_DESCRIPTION,
  descriptionEn:
    "A background job that updates a counter in a persistent key-value store at a regular interval. The data is kept even when the stack is deleted, unless deletion is explicitly requested.",
  source: [
    "x-hp-stack:",
    "  schemaVersion: 1",
    '  name: "Lavoro periodico con archivio"',
    "  category: jobs",
    `  description: "${WORKER_STORAGE_DESCRIPTION}"`,
    "x-hp-parameters:",
    "  - key: worker_interval_seconds",
    '    label: "Intervallo del lavoro (secondi)"',
    "    type: integer",
    "    min: 5",
    "    max: 3600",
    "    default: 30",
    "    customer: true",
    "services:",
    "  storage:",
    "    image: valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882",
    '    command: ["valkey-server", "--appendonly", "yes", "--dir", "/data", "--maxmemory", "48mb", "--maxmemory-policy", "noeviction", "--protected-mode", "no"]',
    "    volumes:",
    "      - data:/data",
    "    expose:",
    "      - 6379",
    "    healthcheck:",
    "      kind: tcp",
    "      port: 6379",
    "      intervalSeconds: 10",
    "      timeoutSeconds: 3",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "0.5"',
    "          memory: 128M",
    "  worker:",
    "    image: valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882",
    '    command: ["valkey-cli", "-h", "storage", "-p", "6379", "-r", "-1", "-i", "${worker_interval_seconds}", "INCR", "worker:ticks"]',
    "    depends_on:",
    "      - storage",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "0.1"',
    "          memory: 32M",
    "volumes:",
    "  data: {}",
    "",
  ].join("\n"),
});

/** The WordPress source; `command` and `environment` are lines added to the wordpress component (version 2). */
function wordpressSource(description: string, extra: { readonly command: readonly string[]; readonly environment: readonly string[] }): string {
  return [
    "x-hp-stack:",
    "  schemaVersion: 2",
    '  name: "WordPress in contenitore"',
    "  category: content",
    `  description: "${description}"`,
    "x-hp-parameters:",
    "  - key: db_password",
    '    label: "Password del database"',
    "    type: secret",
    "    required: true",
    "    customer: false",
    "    generate:",
    "      kind: password",
    "      length: 32",
    "  - key: db_root_password",
    '    label: "Password di amministrazione del database"',
    "    type: secret",
    "    required: true",
    "    customer: false",
    "    generate:",
    "      kind: password",
    "      length: 32",
    "services:",
    "  wordpress:",
    "    image: wordpress:7.1.4-php8.4-apache@sha256:4bf2c44f19a5eba28de4e5cbe50e1c5dc55ae3f8b894f681f4d7676a7e2512e5",
    "    x-hp-profile: standard",
    ...extra.command,
    "    environment:",
    "      - name: WORDPRESS_DB_HOST",
    "        value: db",
    "      - name: WORDPRESS_DB_NAME",
    "        value: wordpress",
    "      - name: WORDPRESS_DB_USER",
    "        value: wordpress",
    "      - name: WORDPRESS_DB_PASSWORD",
    "        secret: db_password",
    ...extra.environment,
    "    volumes:",
    "      - site:/var/www/html",
    "    expose:",
    "      - 80",
    "    depends_on:",
    "      - db",
    "    healthcheck:",
    "      kind: tcp",
    "      port: 80",
    "      intervalSeconds: 15",
    "      timeoutSeconds: 3",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "1.0"',
    "          memory: 512M",
    "  db:",
    "    image: mariadb:12.3.3@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3",
    "    x-hp-profile: standard",
    "    environment:",
    "      - name: MARIADB_DATABASE",
    "        value: wordpress",
    "      - name: MARIADB_USER",
    "        value: wordpress",
    "      - name: MARIADB_PASSWORD",
    "        secret: db_password",
    "      - name: MARIADB_ROOT_PASSWORD",
    "        secret: db_root_password",
    "    volumes:",
    "      - database:/var/lib/mysql",
    "    expose:",
    "      - 3306",
    "    healthcheck:",
    "      kind: tcp",
    "      port: 3306",
    "      intervalSeconds: 15",
    "      timeoutSeconds: 3",
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "1.0"',
    "          memory: 512M",
    "volumes:",
    "  site: {}",
    "  database: {}",
    "x-hp-ingress:",
    "  - service: wordpress",
    "    port: 80",
    "    protocol: http",
    "",
  ].join("\n");
}

/**
 * WordPress with its database, in the extended format (ADR-0036 §2.9), written for this repository. Both components run
 * with the "standard" profile: the official images start as root and drop to their own user. The two database
 * passwords are generated, reach the components only through the environment and are never shown. This is not the
 * managed WordPress site of the panel: no automatic install, no backup, no file or database tools.
 */
const wordpressMariadb: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_wordpress_mariadb",
  versionId: "atv_wordpress_mariadb_2",
  slug: "wordpress-mariadb",
  name: "WordPress in contenitore",
  category: "content",
  description: WORDPRESS_DESCRIPTION,
  descriptionEn:
    "A WordPress site with its own database. The platform generates the database passwords: there is nothing to type. After you connect the domain, open the site right away and complete the first-time setup of WordPress (title, administrator user and password): until you do, anyone who reaches the address can do it in your place. The site and the database are kept even when the application is deleted, unless deletion is explicitly requested. You can upload files of up to 64 MB.",
  source: wordpressSource(WORDPRESS_DESCRIPTION, {
    // The image's own start program, with the PHP limits for uploads on its command line (ADR-0036): the image's
    // default is 2 MB, too small for the themes and plugins WordPress uploads. No shell, no file written.
    command: ['    command: ["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"]'],
    // The image runs this one line of PHP in wp-config.php, at every request: the site's address is the host name it
    // is asked by, lower-cased, when that begins and ends with a letter or digit, with an optional port (the proxy's
    // ports are configurable, so the browser may send one); otherwise WordPress keeps its stored address. So it answers
    // on every address of the application instead of sending visitors back to the first one. The proxy forwards only
    // the application's own addresses. Neither WordPress nor the image's wp-config.php uses $hcp_host, and it is no
    // hp_ name, which the real-Docker acceptance gate refuses in a request. The line runs in the global scope of the
    // request, so it unsets its variable at the end. A "$$" is one "$" for PHP.
    environment: [
      "      - name: WORDPRESS_CONFIG_EXTRA",
      `        value: "$$hcp_host = isset($$_SERVER['HTTP_HOST']) ? strtolower($$_SERVER['HTTP_HOST']) : ''; if (preg_match('/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$$/D', $$hcp_host)) { define('WP_HOME', ((isset($$_SERVER['HTTPS']) && $$_SERVER['HTTPS'] === 'on') ? 'https' : 'http') . '://' . $$hcp_host); define('WP_SITEURL', WP_HOME); } unset($$hcp_host);"`,
    ],
  }),
  // Version 1 as it shipped: the stacks installed on it are offered version 2.
  previousVersions: Object.freeze([
    Object.freeze({ versionId: "atv_wordpress_mariadb_1", source: wordpressSource(WORDPRESS_DESCRIPTION_1, { command: [], environment: [] }) }),
  ]),
});

// ---- databases (ADR-0039): one component, one port, no address; reachable only by the applications linked to it ----

const MARIADB_DESCRIPTION =
  "Un database MariaDB con i dati conservati su disco. Lo raggiungono soltanto le tue applicazioni che gli colleghi, con il nome e la porta indicati nella sua pagina; da fuori del server non è raggiungibile. Database e utente si chiamano app.";

const POSTGRESQL_DESCRIPTION =
  "Un database PostgreSQL con i dati conservati su disco. Lo raggiungono soltanto le tue applicazioni che gli colleghi, con il nome e la porta indicati nella sua pagina; da fuori del server non è raggiungibile. Database e utente si chiamano app.";

/** The description of version 1, as it shipped: it says nothing of how much the store holds. */
const VALKEY_DESCRIPTION_1 =
  "Un archivio chiave-valore Valkey, compatibile con Redis, con i dati conservati su disco. Lo raggiungono soltanto le tue applicazioni che gli colleghi, con il nome e la porta indicati nella sua pagina; da fuori del server non è raggiungibile. Non ha password.";

const VALKEY_DESCRIPTION =
  "Un archivio chiave-valore Valkey, compatibile con Redis, con i dati conservati su disco. Può tenere fino a 256 MB di dati: quando è pieno rifiuta le nuove scritture e tiene quello che ha. Lo raggiungono soltanto le tue applicazioni che gli colleghi, con il nome e la porta indicati nella sua pagina; da fuori del server non è raggiungibile. Non ha password.";

const DATABASE_LIMITS = ["    deploy:", "      resources:", "        limits:", '          cpus: "1.0"', "          memory: 512M"];
const tcpHealth = (port: number) => ["    healthcheck:", "      kind: tcp", `      port: ${port}`, "      intervalSeconds: 10", "      timeoutSeconds: 3"];
const databasePassword = ["  - key: database_password", '    label: "Password del database"', "    type: secret", "    required: true", "    customer: true"];

/** The MariaDB source; `command` is the line that starts the server (version 2 adds the temporary directory). */
function mariadbSource(command: string): string {
  return [
    "x-hp-stack:",
    "  schemaVersion: 1",
    '  name: "Database MariaDB"',
    "  category: database",
    `  description: "${MARIADB_DESCRIPTION}"`,
    "x-hp-parameters:",
    ...databasePassword,
    "  - key: admin_password",
    '    label: "Password di amministrazione"',
    "    type: secret",
    "    required: true",
    "    customer: true",
    "services:",
    "  db:",
    "    image: docker.io/library/mariadb:12.3.3@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3",
    command,
    "    environment:",
    "      - name: MARIADB_DATABASE",
    "        value: app",
    "      - name: MARIADB_USER",
    "        value: app",
    // The administrator account logs in from inside the component only.
    "      - name: MARIADB_ROOT_HOST",
    "        value: localhost",
    "      - name: MARIADB_PASSWORD_FILE",
    "        secret: database_password",
    "      - name: MARIADB_ROOT_PASSWORD_FILE",
    "        secret: admin_password",
    "    volumes:",
    "      - data:/var/lib/mysql",
    "    expose:",
    "      - 3306",
    ...tcpHealth(3306),
    ...DATABASE_LIMITS,
    "volumes:",
    "  data: {}",
    "",
  ].join("\n");
}

const mariadb: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_mariadb",
  versionId: "atv_mariadb_2",
  slug: "mariadb",
  name: "Database MariaDB",
  category: "database",
  description: MARIADB_DESCRIPTION,
  descriptionEn:
    "A MariaDB database that keeps its data on disk. Only your applications that you connect to it reach it, at the name and port its page shows; it cannot be reached from outside the server. The database and its user are both named app.",
  source: mariadbSource(
    // Socket and pid file under /tmp: the root file system is read-only. The temporary files of a sort or of an index
    // build go to the data area: the 64 MB /tmp of the strict profile is memory, and a statement that needed more
    // than that failed there.
    '    command: ["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid", "--tmpdir=/var/lib/mysql"]',
  ),
  // Version 1 as it shipped: the databases installed on it are offered version 2.
  previousVersions: Object.freeze([
    Object.freeze({ versionId: "atv_mariadb_1", source: mariadbSource('    command: ["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid"]') }),
  ]),
});

const postgresql: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_postgresql",
  versionId: "atv_postgresql_1",
  slug: "postgresql",
  name: "Database PostgreSQL",
  category: "database",
  description: POSTGRESQL_DESCRIPTION,
  descriptionEn:
    "A PostgreSQL database that keeps its data on disk. Only your applications that you connect to it reach it, at the name and port its page shows; it cannot be reached from outside the server. The database and its user are both named app.",
  source: [
    "x-hp-stack:",
    "  schemaVersion: 1",
    '  name: "Database PostgreSQL"',
    "  category: database",
    `  description: "${POSTGRESQL_DESCRIPTION}"`,
    "x-hp-parameters:",
    ...databasePassword,
    "services:",
    "  db:",
    "    image: docker.io/library/postgres:18-bookworm@sha256:194e55feb2597b1465dbee81cc9fd8d204566cd2eb42c8d22fd6c931a38781b1",
    '    command: ["postgres"]',
    "    environment:",
    "      - name: POSTGRES_DB",
    "        value: app",
    "      - name: POSTGRES_USER",
    "        value: app",
    "      - name: POSTGRES_PASSWORD_FILE",
    "        secret: database_password",
    "    volumes:",
    "      - data:/var/lib/postgresql",
    "    expose:",
    "      - 5432",
    ...tcpHealth(5432),
    ...DATABASE_LIMITS,
    "volumes:",
    "  data: {}",
    "",
  ].join("\n"),
});

/** The Valkey source; `description` is the one the version shipped with and `memory` its limit (version 2 raises it). */
function valkeySource(description: string, memory: string): string {
  return [
    "x-hp-stack:",
    "  schemaVersion: 1",
    '  name: "Archivio Valkey"',
    "  category: database",
    `  description: "${description}"`,
    "services:",
    "  db:",
    "    image: valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882",
    '    command: ["valkey-server", "--appendonly", "yes", "--dir", "/data", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--protected-mode", "no"]',
    "    volumes:",
    "      - data:/data",
    "    expose:",
    "      - 6379",
    ...tcpHealth(6379),
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "0.5"',
    `          memory: ${memory}`,
    "volumes:",
    "  data: {}",
    "",
  ].join("\n");
}

const valkey: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_valkey",
  versionId: "atv_valkey_2",
  slug: "valkey",
  name: "Archivio Valkey",
  category: "database",
  description: VALKEY_DESCRIPTION,
  descriptionEn:
    "A Valkey key-value store, compatible with Redis, that keeps its data on disk. It holds up to 256 MB: when it is full it refuses new writes and keeps what it holds. Only your applications that you connect to it reach it, at the name and port its page shows; it cannot be reached from outside the server. It has no password.",
  // The ceiling (256 MB) is unchanged and now told to the customer; the limit is twice it, so the process, its buffers and
  // the copy of a snapshot or of an append-only rewrite fit above what the store may hold (swap is off: memory is all).
  source: valkeySource(VALKEY_DESCRIPTION, "512M"),
  // Version 1 as it shipped: the stores installed on it are offered version 2.
  previousVersions: Object.freeze([Object.freeze({ versionId: "atv_valkey_1", source: valkeySource(VALKEY_DESCRIPTION_1, "384M") })]),
});

/** The two seeds of the first format (ADR-0035), the WordPress one of the extended format (ADR-0036), then the three
 *  databases (ADR-0039). */
export const APP_BUILT_IN_TEMPLATES: readonly AppBuiltInTemplate[] = Object.freeze([
  httpCache,
  workerStorage,
  wordpressMariadb,
  mariadb,
  postgresql,
  valkey,
]);
