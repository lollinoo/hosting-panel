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
}

const HTTP_CACHE_DESCRIPTION =
  "Un sito web leggero che risponde in HTTP, con accanto una cache in memoria raggiungibile soltanto dagli altri componenti con il nome cache:11211. La cache non conserva dati.";

const WORKER_STORAGE_DESCRIPTION =
  "Un lavoro in background che a intervalli regolari aggiorna un contatore in un archivio chiave-valore persistente. I dati sono conservati anche quando lo stack viene cancellato, salvo richiesta esplicita.";

const WORDPRESS_DESCRIPTION =
  "Un sito WordPress con il suo database. Le password del database sono generate dalla piattaforma: non c'è nulla da inserire. Dopo aver collegato il dominio, apri subito il sito e completa la configurazione iniziale di WordPress (titolo, utente e password dell'amministratore): finché non lo fai, chiunque raggiunga l'indirizzo può farlo al posto tuo. Sito e database sono conservati anche quando l'applicazione viene cancellata, salvo richiesta esplicita.";

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

/**
 * WordPress with its database, in the extended format (ADR-0036 §2.9), written for this repository. Both components run
 * with the "standard" profile: the official images start as root and drop to their own user. The two database
 * passwords are generated, reach the components only through the environment and are never shown. This is not the
 * managed WordPress site of the panel: no automatic install, no backup, no file or database tools.
 */
const wordpressMariadb: AppBuiltInTemplate = Object.freeze({
  templateId: "atpl_wordpress_mariadb",
  versionId: "atv_wordpress_mariadb_1",
  slug: "wordpress-mariadb",
  name: "WordPress in contenitore",
  category: "content",
  description: WORDPRESS_DESCRIPTION,
  descriptionEn:
    "A WordPress site with its own database. The platform generates the database passwords: there is nothing to type. After you connect the domain, open the site right away and complete the first-time setup of WordPress (title, administrator user and password): until you do, anyone who reaches the address can do it in your place. The site and the database are kept even when the application is deleted, unless deletion is explicitly requested.",
  source: [
    "x-hp-stack:",
    "  schemaVersion: 2",
    '  name: "WordPress in contenitore"',
    "  category: content",
    `  description: "${WORDPRESS_DESCRIPTION}"`,
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
    "    environment:",
    "      - name: WORDPRESS_DB_HOST",
    "        value: db",
    "      - name: WORDPRESS_DB_NAME",
    "        value: wordpress",
    "      - name: WORDPRESS_DB_USER",
    "        value: wordpress",
    "      - name: WORDPRESS_DB_PASSWORD",
    "        secret: db_password",
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
  ].join("\n"),
});

/** The two seeds of the first format (ADR-0035), then the WordPress one of the extended format (ADR-0036). */
export const APP_BUILT_IN_TEMPLATES: readonly AppBuiltInTemplate[] = Object.freeze([httpCache, workerStorage, wordpressMariadb]);
