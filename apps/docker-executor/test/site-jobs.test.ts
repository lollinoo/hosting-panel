import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SHARED_MARIADB_IMAGE, resolveWordpressCliImage } from "@hosting-panel/contracts";
import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJobStdout } from "../src/docker-logs.js";
import {
  DB_PROVISION_SCRIPT,
  DockerEngineSocketAdapter,
  MARIADB_OWN_MAX_USER_CONNECTIONS,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  WORDPRESS_SET_URL_SCRIPT,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
} from "../src/index.js";
import {
  DB_DROP_SCRIPT,
  DEFAULT_SITE_JOB_TIMEOUT_MS,
  SITE_JOB_SPECS,
  WORDPRESS_INSPECT_SCRIPT,
  WORDPRESS_INSTALL_SCRIPT,
  WORDPRESS_RESET_PASSWORD_SCRIPT,
  WORDPRESS_RESULT_MAX_BYTES,
  WORDPRESS_SETTLE_SCRIPT,
  WORDPRESS_UPDATE_SCRIPT,
  parseWordpressJobResult,
  siteJobTimeoutMs,
} from "../src/site-jobs.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const logFrame = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const DB_PW = "a".repeat(64);
const ADMIN_PW = "canary-Pass-123456";
const ctx = {
  executorUser: "990:990",
  secretBinds: [] as readonly string[],
  secretFileEnv: [] as readonly string[],
  rootKeyHostPath: "/etc/hosting-panel/mariadb-root.key",
};

function wpInstall(overrides?: Partial<SiteJobRequest>): SiteJobRequest {
  return {
    jobId: "job_wp_1",
    kind: "wordpress.install",
    siteId: "site_a",
    organizationId: "org_a",
    serviceInstanceId: "svc_a",
    params: {
      phpVersion: "8.4",
      dbName: "wp_site_a",
      dbUser: "wp_site_a",
      siteUrl: "http://example.com",
      title: "My site",
      adminUser: "admin",
      adminEmail: "admin@example.com",
    },
    resolvedSecrets: { HP_DB_PASSWORD: DB_PW, HP_ADMIN_PASSWORD: ADMIN_PW },
    ...overrides,
  };
}

function setUrl(overrides?: Partial<SiteJobRequest>): SiteJobRequest {
  return {
    jobId: "job_seturl_1",
    kind: "wordpress.set-url",
    siteId: "site_a",
    organizationId: "org_a",
    serviceInstanceId: "svc_a",
    params: { phpVersion: "8.4", siteUrl: "https://hotel.it", previousUrl: "http://hotel.it" },
    ...overrides,
  };
}

function dbJob(kind: "db.provision" | "db.drop", overrides?: Partial<SiteJobRequest>): SiteJobRequest {
  return {
    jobId: `job_${kind.replace(".", "_")}_1`,
    kind,
    siteId: "site_a",
    organizationId: "org_a",
    params: { dbName: "wp_site_a", dbUser: "wp_site_a" },
    ...(kind === "db.provision" ? { resolvedSecrets: { HP_DB_PASSWORD: DB_PW } } : {}),
    ...overrides,
  };
}

describe("wordpress.set-url", () => {
  it("set-url passes URLs only as env", () => {
    const payload = buildSiteJobContainerPayload(setUrl(), ctx);
    expect(payload.Entrypoint?.[2]).toBe(WORDPRESS_SET_URL_SCRIPT);
    expect(payload.Env).toContain("HP_SITE_URL=https://hotel.it");
    expect(payload.Env).toContain("HP_PREVIOUS_URL=http://hotel.it");
  });

  it("set-url rejects a URL with a path, a quote or a $()", () => {
    for (const bad of ["https://hotel.it/$(id)", "https://hotel.it/x", "https://hotel.it'", 'https://hotel.it"']) {
      expect(() =>
        buildSiteJobContainerPayload(setUrl({ params: { ...setUrl().params, siteUrl: bad } }), ctx),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("set-url runs as 33:33 on the site network with the html volume and no secrets", () => {
    const payload = buildSiteJobContainerPayload(setUrl(), ctx);
    expect(payload.User).toBe("33:33");
    expect(payload.Image).toBe(resolveWordpressCliImage("8.4"));
    expect(payload.WorkingDir).toBe("/var/www/html");
    expect(payload.HostConfig.NetworkMode).toBe("hp_site_site_a_net");
    expect(payload.HostConfig.Binds).toEqual(["hp_vol_svc_a_html:/var/www/html"]);
    expect(payload.Env.some((e) => e.startsWith("HP_HTACCESS"))).toBe(false);
    expect(() =>
      buildSiteJobContainerPayload(setUrl({ resolvedSecrets: { HP_DB_PASSWORD: DB_PW } }), ctx),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => buildSiteJobContainerPayload(setUrl({ serviceInstanceId: undefined }), ctx)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("set-url script, run with a recording wp shim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-wp-shim-"));
    cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
    const log = path.join(dir, "calls.log");
    await writeFile(
      path.join(dir, "wp"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n[ "$1 $2" = "config has" ] && exit "${"$"}{WP_SHIM_EXIT:-0}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const run = async (site: string, prev: string, shimExit = "0") => {
      await writeFile(log, "");
      let code = 0;
      try {
        execFileSync("sh", ["-c", WORDPRESS_SET_URL_SCRIPT], {
          env: { PATH: `${dir}:/usr/bin:/bin`, HP_SITE_URL: site, HP_PREVIOUS_URL: prev, WP_SHIM_EXIT: shimExit },
          stdio: "pipe",
        });
      } catch (e) {
        code = (e as { status: number }).status;
      }
      const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
      return { code, calls };
    };

    const refused = await run("https://hotel.it", "http://hotel.it", "1");
    expect(refused.code).toBe(20);
    expect(refused.calls).toHaveLength(1);

    const same = await run("https://hotel.it", "https://hotel.it");
    expect(same.code).toBe(0);
    expect(same.calls.filter((c) => c.startsWith("option update"))).toHaveLength(2);
    expect(same.calls.some((c) => c.startsWith("search-replace"))).toBe(false);

    const moved = await run("https://hotel.it", "http://hotel.it");
    expect(moved.code).toBe(0);
    const pairs = moved.calls.filter((c) => c.startsWith("search-replace")).map((c) => c.split(" ").slice(1, 3));
    expect(moved.calls.filter((c) => c.startsWith("search-replace")).every((c) => c.includes(" --precise"))).toBe(
      true,
    );
    expect(pairs).toEqual([
      ["http://hotel.it/", "https://hotel.it/"],
      ['http://hotel.it"', 'https://hotel.it"'],
      ["http://hotel.it'", "https://hotel.it'"],
      ["http:\\/\\/hotel.it\\/", "https:\\/\\/hotel.it\\/"],
      ['http:\\/\\/hotel.it"', 'https:\\/\\/hotel.it"'],
    ]);
  });
});

describe("buildSiteJobContainerPayload", () => {
  it("wordpress.install passes customer values only as env and never inside its command", () => {
    const title = `L'Hôtel "Bella" $(id)`;
    const req = wpInstall({ params: { ...wpInstall().params, title } });
    const payload = buildSiteJobContainerPayload(req, {
      ...ctx,
      secretFileEnv: [
        "HP_ADMIN_PASSWORD_FILE=/run/secrets/HP_ADMIN_PASSWORD",
        "HP_DB_PASSWORD_FILE=/run/secrets/HP_DB_PASSWORD",
      ],
    });
    expect(payload.Entrypoint?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(payload.Entrypoint?.[2]).not.toContain("Bella");
    expect(payload.Entrypoint?.[2]).not.toContain("$(id)");
    expect(payload.Env).toContain(`HP_TITLE=${title}`);
    expect(payload.Env.some((e) => e.includes(ADMIN_PW))).toBe(false);
    expect(payload.Env).toContain("HP_ADMIN_PASSWORD_FILE=/run/secrets/HP_ADMIN_PASSWORD");
    expect(payload.Image).toBe(resolveWordpressCliImage("8.4"));
    expect(payload.User).toBe("33:33");
    expect(payload.WorkingDir).toBe("/var/www/html");
    expect(payload.HostConfig.NetworkMode).toBe("hp_site_site_a_net");
    expect(payload.HostConfig.Binds).toEqual(["hp_vol_svc_a_html:/var/www/html"]);
    expect(payload.Labels).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "site_job",
      "io.hostingpanel.site_id": "site_a",
      "io.hostingpanel.job_id": "job_wp_1",
    });
  });

  it("rejects a db identifier outside the pattern", () => {
    expect(() =>
      buildSiteJobContainerPayload(dbJob("db.drop", { params: { dbName: "x; DROP", dbUser: "wp_a" } }), ctx),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects a non-hex database password", async () => {
    for (const bad of ["x'; GRANT ALL ON *.* TO 'a'@'%'; --", "A".repeat(64)]) {
      expect(() =>
        buildSiteJobContainerPayload(dbJob("db.provision", { resolvedSecrets: { HP_DB_PASSWORD: bad } }), ctx),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
    const { adapter, mockDaemon } = await setup();
    await expect(
      adapter.runSiteJob(
        dbJob("db.provision", { resolvedSecrets: { HP_DB_PASSWORD: "x'; GRANT ALL ON *.* TO 'a'@'%'; --" } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
  });

  it("db.provision password never reaches the job Env or Cmd", () => {
    const payload = buildSiteJobContainerPayload(dbJob("db.provision"), ctx);
    expect(JSON.stringify(payload.Env)).not.toContain(DB_PW);
    expect(JSON.stringify(payload.Cmd)).not.toContain(DB_PW);
    expect(payload.Cmd?.[2]).toBe(DB_PROVISION_SCRIPT);
  });

  it("db.provision script re-checks the password is 64 hex", () => {
    const payload = buildSiteJobContainerPayload(dbJob("db.provision"), ctx);
    expect(payload.Cmd?.[2]).toContain("*[!0-9a-f]*) exit 64");
    expect(payload.Cmd?.[2]).toContain("-eq 64");
    expect(payload.Cmd?.[2]).not.toContain("wp_site_a");
    expect(payload.Env).toEqual(
      expect.arrayContaining([
        "HP_DB_NAME=wp_site_a",
        "HP_DB_NAME_ESCAPED=wp\\_site\\_a",
        "HP_DB_USER=wp_site_a",
      ]),
    );
  });

  it("db.provision caps the primary user at MARIADB_OWN_MAX_USER_CONNECTIONS (40) inside DB_PROVISION_SCRIPT (R40)", () => {
    expect(MARIADB_OWN_MAX_USER_CONNECTIONS).toBe(40);
    expect(DB_PROVISION_SCRIPT).toContain(
      `ALTER USER '$HP_DB_USER'@'%' IDENTIFIED BY '$pw' WITH MAX_USER_CONNECTIONS ${String(MARIADB_OWN_MAX_USER_CONNECTIONS)};`,
    );
  });

  it("db.provision escapes underscores in HP_DB_NAME_ESCAPED and pins the rendered SQL grant (R30)", async () => {
    const req = dbJob("db.provision", {
      params: { dbName: "wp_0123456789ab", dbUser: "wp_0123456789ab" },
    });
    const payload = buildSiteJobContainerPayload(req, ctx);
    expect(payload.Cmd?.[2]).toBe(DB_PROVISION_SCRIPT);
    expect(DB_PROVISION_SCRIPT).toBe(
      [
        "set -eu",
        "pw=$(cat /run/secrets/HP_DB_PASSWORD 2>/dev/null || true)",
        'case "$pw" in *[!0-9a-f]*) exit 64;; esac',
        '[ "${#pw}" -eq 64 ] || exit 64',
        "printf '[client]\\nuser=root\\nhost=hp-mariadb\\npassword=%s\\n' \"$(cat /run/secrets/mariadb-root)\" > /tmp/c.cnf",
        "i=0; until mariadb --defaults-extra-file=/tmp/c.cnf -e 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ \"$i\" -ge 30 ] && exit 11; sleep 2; done",
        "mariadb --defaults-extra-file=/tmp/c.cnf <<SQL",
        "CREATE DATABASE IF NOT EXISTS \\`$HP_DB_NAME\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
        "CREATE USER IF NOT EXISTS '$HP_DB_USER'@'%' IDENTIFIED BY '$pw';",
        `ALTER USER '$HP_DB_USER'@'%' IDENTIFIED BY '$pw' WITH MAX_USER_CONNECTIONS ${String(MARIADB_OWN_MAX_USER_CONNECTIONS)};`,
        "GRANT ALL PRIVILEGES ON \\`$HP_DB_NAME_ESCAPED\\`.* TO '$HP_DB_USER'@'%';",
        "SQL",
        "",
      ].join("\n"),
    );
    expect(payload.Env).toContain("HP_DB_NAME=wp_0123456789ab");
    expect(payload.Env).toContain("HP_DB_NAME_ESCAPED=wp\\_0123456789ab");
    expect(payload.Env).toContain("HP_DB_USER=wp_0123456789ab");

    // Verify db.drop and wordpress.install do not inject HP_DB_NAME_ESCAPED
    const dropPayload = buildSiteJobContainerPayload(dbJob("db.drop"), ctx);
    expect(dropPayload.Env.some((e) => e.startsWith("HP_DB_NAME_ESCAPED="))).toBe(false);
    const wpPayload = buildSiteJobContainerPayload(wpInstall(), ctx);
    expect(wpPayload.Env.some((e) => e.startsWith("HP_DB_NAME_ESCAPED="))).toBe(false);

    // Execute the heredoc in /bin/sh with a recording mariadb shim to verify exact SQL bytes on stdin.
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-dbprov-shim-"));
    cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
    const sqlOut = path.join(dir, "rendered.sql");
    await writeFile(path.join(dir, "mariadb"), `#!/bin/sh\ncat > "${sqlOut}"\nexit 0\n`, {
      mode: 0o755,
    });
    const heredocStart = DB_PROVISION_SCRIPT.indexOf("mariadb --defaults-extra-file=/tmp/c.cnf <<SQL");
    const heredocScript = `set -eu\npw="${DB_PW}"\n${DB_PROVISION_SCRIPT.slice(heredocStart)}`;
    execFileSync("sh", ["-c", heredocScript], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HP_DB_NAME: "wp_0123456789ab",
        HP_DB_NAME_ESCAPED: "wp\\_0123456789ab",
        HP_DB_USER: "wp_0123456789ab",
      },
      stdio: "pipe",
    });
    const renderedSql = await readFile(sqlOut, "utf8");
    expect(renderedSql).toBe(
      [
        "CREATE DATABASE IF NOT EXISTS `wp_0123456789ab` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
        `CREATE USER IF NOT EXISTS 'wp_0123456789ab'@'%' IDENTIFIED BY '${DB_PW}';`,
        `ALTER USER 'wp_0123456789ab'@'%' IDENTIFIED BY '${DB_PW}' WITH MAX_USER_CONNECTIONS 40;`,
        "GRANT ALL PRIVILEGES ON `wp\\_0123456789ab`.* TO 'wp_0123456789ab'@'%';",
        "",
      ].join("\n"),
    );
  });

  it("wordpress.install script is idempotent and refuses a foreign wp-config.php", () => {
    const payload = buildSiteJobContainerPayload(wpInstall(), ctx);
    const script = payload.Entrypoint?.[2] ?? "";
    expect(script).toContain("wp config has HP_MANAGED");
    expect(script).toContain("exit 20");
    expect(script).toContain("if ! wp core is-installed; then");
    expect(script).not.toContain("--hard");
    const htaccess = payload.Env.find((e) => e.startsWith("HP_HTACCESS_WORDPRESS="));
    expect(htaccess).toContain("# BEGIN WordPress");
    expect(htaccess).toContain("RewriteRule . /index.php [L]");
    expect(payload.Env.find((e) => e.startsWith("HP_HTACCESS_PANEL="))).toContain(
      'SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on',
    );
  });

  it("wordpress.install accepts a retry without the admin password", () => {
    expect(() =>
      buildSiteJobContainerPayload(wpInstall({ resolvedSecrets: { HP_DB_PASSWORD: DB_PW } }), ctx),
    ).not.toThrow();
  });

  it("rejects unknown kinds and unexpected params", () => {
    const expectInvalid = (req: SiteJobRequest) =>
      expect(() => buildSiteJobContainerPayload(req, ctx)).toThrow(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    expectInvalid({ ...dbJob("db.drop"), kind: "site.placeholder" as SiteJobRequest["kind"] });
    expectInvalid(dbJob("db.drop", { params: { dbName: "wp_a", dbUser: "wp_a", image: "evil" } }));
    expectInvalid(dbJob("db.drop", { params: { dbName: "wp_a" } }));
    expectInvalid(dbJob("db.drop", { resolvedSecrets: { HP_DB_PASSWORD: DB_PW } }));
    expectInvalid(wpInstall({ serviceInstanceId: undefined }));
    expectInvalid(wpInstall({ params: { ...wpInstall().params, siteUrl: "https://example.com" } }));
    expectInvalid(wpInstall({ params: { ...wpInstall().params, siteUrl: "http://Example.com/x" } }));
    expectInvalid(wpInstall({ params: { ...wpInstall().params, title: "t".repeat(121) } }));
    expectInvalid(wpInstall({ params: { ...wpInstall().params, phpVersion: "7.4" } }));
    expectInvalid(wpInstall({ resolvedSecrets: { HP_DB_PASSWORD: DB_PW, HP_ADMIN_PASSWORD: "a\nb-long-enough" } }));
  });

  it("db jobs run on hp_mariadb_net as the executor user with the root key read-only", () => {
    for (const kind of ["db.provision", "db.drop"] as const) {
      const payload = buildSiteJobContainerPayload(dbJob(kind), ctx);
      expect(payload.Image).toBe(SHARED_MARIADB_IMAGE);
      expect(payload.User).toBe("990:990");
      expect(payload.HostConfig.NetworkMode).toBe(SHARED_DB_NETWORK_NAME);
      expect(payload.HostConfig.Binds).toEqual([
        "/etc/hosting-panel/mariadb-root.key:/run/secrets/mariadb-root:ro",
      ]);
    }
  });

  it("job payloads are hardened", () => {
    for (const req of [wpInstall(), dbJob("db.provision"), dbJob("db.drop")]) {
      const payload = buildSiteJobContainerPayload(req, ctx);
      expect(payload.HostConfig).toMatchObject({
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        RestartPolicy: { Name: "no" },
        Memory: 536870912,
        MemorySwap: 536870912,
        NanoCpus: 1e9,
        PidsLimit: 128,
      });
      expect("PortBindings" in payload.HostConfig).toBe(false);
      expect("CapAdd" in payload.HostConfig).toBe(false);
      expect("ExposedPorts" in payload).toBe(false);
    }
  });
});

const NEW_KINDS = ["wordpress.inspect", "wordpress.update", "wordpress.settle", "wordpress.reset-password"] as const;
type NewKind = (typeof NEW_KINDS)[number];

function wpJob(kind: NewKind, overrides?: Partial<SiteJobRequest>): SiteJobRequest {
  const extra: Record<NewKind, Record<string, string>> = {
    "wordpress.inspect": {},
    "wordpress.update": { target: "plugin:classic-editor" },
    "wordpress.settle": {},
    "wordpress.reset-password": { userId: "1" },
  };
  return {
    jobId: "job_wpt_1",
    kind,
    siteId: "site_a",
    organizationId: "org_a",
    serviceInstanceId: "svc_a",
    params: { phpVersion: "8.4", ...extra[kind] },
    ...(kind === "wordpress.reset-password" ? { resolvedSecrets: { HP_ADMIN_PASSWORD: ADMIN_PW } } : {}),
    ...overrides,
  };
}

const SCRIPTS: Record<SiteJobRequest["kind"], string> = {
  "db.provision": DB_PROVISION_SCRIPT,
  "db.drop": DB_DROP_SCRIPT,
  "wordpress.install": WORDPRESS_INSTALL_SCRIPT,
  "wordpress.set-url": WORDPRESS_SET_URL_SCRIPT,
  "wordpress.inspect": WORDPRESS_INSPECT_SCRIPT,
  "wordpress.update": WORDPRESS_UPDATE_SCRIPT,
  "wordpress.settle": WORDPRESS_SETTLE_SCRIPT,
  "wordpress.reset-password": WORDPRESS_RESET_PASSWORD_SCRIPT,
};

/** Positions of $HP_ / ${HP_ outside double quotes (single quotes and escapes respected). */
function unquotedHpReads(script: string): string[] {
  const found: string[] = [];
  let state: "none" | "single" | "double" = "none";
  for (let i = 0; i < script.length; i += 1) {
    const c = script[i]!;
    if (state === "single") {
      if (c === "'") state = "none";
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (state === "none" && c === "'") state = "single";
    else if (c === '"') state = state === "double" ? "none" : "double";
    else if (state === "none" && c === "$" && /^\{?HP_/.test(script.slice(i + 1, i + 5))) {
      found.push(script.slice(i, i + 24));
    }
  }
  return found;
}

describe("WordPress tools kinds", () => {
  const expectInvalid = (req: SiteJobRequest) =>
    expect(() => buildSiteJobContainerPayload(req, ctx)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );

  it("accepts the four kinds with their closed params", () => {
    for (const kind of NEW_KINDS) {
      expect(() => buildSiteJobContainerPayload(wpJob(kind), ctx)).not.toThrow();
    }
    for (const target of ["all", "core", "plugin:classic-editor", "theme:twentytwentyfive"]) {
      expect(() =>
        buildSiteJobContainerPayload(wpJob("wordpress.update", { params: { phpVersion: "8.4", target } }), ctx),
      ).not.toThrow();
    }
  });

  it("refuses unknown params, secrets, bad targets, bad user ids and a bad phpVersion", () => {
    for (const kind of NEW_KINDS) {
      const base = wpJob(kind);
      expectInvalid({ ...base, params: { ...base.params, image: "evil" } });
      expectInvalid({ ...base, params: { ...base.params, phpVersion: "7.4" } });
      expectInvalid({ ...base, serviceInstanceId: undefined });
      expectInvalid({ ...base, resolvedSecrets: { ...base.resolvedSecrets, HP_DB_PASSWORD: DB_PW } });
    }
    for (const kind of ["wordpress.inspect", "wordpress.update", "wordpress.settle"] as const) {
      expectInvalid(wpJob(kind, { resolvedSecrets: { HP_ADMIN_PASSWORD: ADMIN_PW } }));
    }
    for (const target of ["plugin:-x", "plugin:a b", "core;id", "plugin:", "plugin:../x", "$(id)", ""]) {
      expectInvalid(wpJob("wordpress.update", { params: { phpVersion: "8.4", target } }));
    }
    expectInvalid(wpJob("wordpress.update", { params: { phpVersion: "8.4" } }));
    for (const userId of ["0", "01", "-1", "1 OR 1", "12345678901"]) {
      expectInvalid(wpJob("wordpress.reset-password", { params: { phpVersion: "8.4", userId } }));
    }
    expectInvalid(wpJob("wordpress.reset-password", { resolvedSecrets: {} }));
    expectInvalid(wpJob("wordpress.reset-password", { resolvedSecrets: { HP_ADMIN_PASSWORD: "short" } }));
    expectInvalid(wpJob("wordpress.reset-password", { resolvedSecrets: { HP_ADMIN_PASSWORD: "a\nb-long-enough" } }));
    expectInvalid({ ...wpJob("wordpress.inspect"), kind: "wordpress.eval" as SiteJobRequest["kind"] });
  });

  // R139: a wp-cli job replaces the image's entry point (no start-up script, no Cmd) and runs under an init.
  it("puts values only in Env and the constant script last in the command, for every kind", () => {
    const hostile = "Hôtel $(id) `x` \"q\" 'q' ; rm -rf /";
    const reqs: SiteJobRequest[] = [
      dbJob("db.provision"),
      dbJob("db.drop"),
      wpInstall({ params: { ...wpInstall().params, title: hostile } }),
      setUrl(),
      ...NEW_KINDS.map((k) => wpJob(k)),
      wpJob("wordpress.update", { params: { phpVersion: "8.4", target: "plugin:a.b_c-d" } }),
      wpJob("wordpress.reset-password", { params: { phpVersion: "8.4", userId: "9999999999" } }),
    ];
    for (const req of reqs) {
      const payload = buildSiteJobContainerPayload(req, {
        ...ctx,
        secretFileEnv: Object.keys(req.resolvedSecrets ?? {}).map((n) => `${n}_FILE=/run/secrets/${n}`),
      });
      const isDb = req.kind.startsWith("db.");
      const command = isDb ? payload.Cmd : payload.Entrypoint;
      if (isDb) {
        expect(payload, req.kind).not.toHaveProperty("Entrypoint");
        expect(payload.HostConfig, req.kind).not.toHaveProperty("Init");
      } else {
        expect(payload, req.kind).not.toHaveProperty("Cmd");
        expect(payload.HostConfig.Init, req.kind).toBe(true);
      }
      if ((NEW_KINDS as readonly string[]).includes(req.kind)) {
        expect(command).toEqual([
          "timeout",
          "-s",
          "KILL",
          String(siteJobTimeoutMs(req.kind) / 1000 + 5),
          "sh",
          "-c",
          SCRIPTS[req.kind],
        ]);
      } else {
        expect(command, req.kind).toEqual(["sh", "-c", SCRIPTS[req.kind]]);
      }
      // The prefix and the constant are fixed above, so a value can only travel in Env.
      for (const [key, value] of Object.entries(req.params)) {
        expect(payload.Env).toContain(`HP_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}=${value}`);
      }
      const cmd = JSON.stringify(command);
      for (const value of Object.values(req.resolvedSecrets ?? {})) {
        expect(cmd).not.toContain(value);
        expect(payload.Env.some((e) => e.includes(value))).toBe(false);
      }
    }
    const update = buildSiteJobContainerPayload(
      wpJob("wordpress.update", { params: { phpVersion: "8.4", target: "theme:twentytwentyfive" } }),
      ctx,
    );
    expect(update.Env).toContain("HP_TARGET=theme:twentytwentyfive");
    const reset = buildSiteJobContainerPayload(wpJob("wordpress.reset-password"), ctx);
    expect(reset.Env).toContain("HP_USER_ID=1");
  });

  it("every script passes the static check", () => {
    for (const [kind, script] of Object.entries(SCRIPTS)) {
      expect(script, kind).not.toMatch(/(^|[;&|(]\s*)eval\b/m);
      expect(script, kind).not.toContain("--prompt");
      // The db scripts splice pattern-checked identifiers into a SQL heredoc, where quotes and backticks are SQL.
      if (kind.startsWith("db.")) continue;
      expect(script, kind).not.toContain("`");
      expect(unquotedHpReads(script), kind).toEqual([]);
    }
    const reads = unquotedHpReads('a=$HP_X; b="$HP_Y"; c=\'$HP_Z\'; d="\\"$HP_W"');
    expect(reads.map((r) => r.slice(0, 5))).toEqual(["$HP_X"]);
    expect("x; eval y").toMatch(/(^|[;&|(]\s*)eval\b/m);
    expect("wp eval 'x'").not.toMatch(/(^|[;&|(]\s*)eval\b/m);
    expect(WORDPRESS_INSTALL_SCRIPT).toContain("wp_slash");
    expect(WORDPRESS_RESET_PASSWORD_SCRIPT).toContain("wp_set_password(wp_slash($p), $u->ID)");
    expect(WORDPRESS_RESET_PASSWORD_SCRIPT).toContain("destroy_all()");
    for (const script of [WORDPRESS_INSPECT_SCRIPT, WORDPRESS_UPDATE_SCRIPT]) {
      expect(script).toMatch(/\n\{\n[\s\S]*\n\} >&2\nphp -r '/);
    }
    expect(WORDPRESS_SETTLE_SCRIPT).not.toContain("wp ");
    // R140/R147.1: "known" needs `response`, which only an answered lookup writes (also with no plugin); a failed read is "not known".
    expect(WORDPRESS_INSPECT_SCRIPT).toMatch(/get_site_transient\(\$t\); if \(!is_object\(\$v\) \|\| !isset\(\$v->response\)\) exit\(1\);[^\n]*\|\| true\n/);
    expect(WORDPRESS_INSPECT_SCRIPT).not.toContain("$v->checked");
    expect(WORDPRESS_INSPECT_SCRIPT).toContain('$known = is_file("/tmp/hp/core.json") && is_file("/tmp/hp/answered");');
  });

  it("image, user, volume, network reach, limits and result per kind", () => {
    for (const kind of NEW_KINDS) {
      const payload = buildSiteJobContainerPayload(wpJob(kind, { params: { ...wpJob(kind).params, phpVersion: "8.3" } }), ctx);
      expect(payload.Image).toBe(resolveWordpressCliImage("8.3"));
      expect(payload.User).toBe("33:33");
      expect(payload.WorkingDir).toBe("/var/www/html");
      expect(payload.HostConfig.NetworkMode).toBe("hp_site_site_a_net");
      expect(payload.HostConfig.Binds).toEqual(["hp_vol_svc_a_html:/var/www/html"]);
    }
    expect(Object.keys(SITE_JOB_SPECS).filter((k) => SITE_JOB_SPECS[k as NewKind].edgeNetwork === true).sort()).toEqual([
      "wordpress.inspect",
      "wordpress.update",
    ]);
    expect(Object.keys(SITE_JOB_SPECS).filter((k) => SITE_JOB_SPECS[k as NewKind].result !== undefined).sort()).toEqual([
      "wordpress.inspect",
      "wordpress.update",
    ]);
    expect(siteJobTimeoutMs("wordpress.inspect")).toBe(240_000);
    expect(siteJobTimeoutMs("wordpress.update")).toBe(240_000);
    expect(siteJobTimeoutMs("wordpress.settle")).toBe(60_000);
    expect(siteJobTimeoutMs("wordpress.reset-password")).toBe(60_000);
    for (const kind of ["db.provision", "db.drop", "wordpress.install", "wordpress.set-url"] as const) {
      expect(siteJobTimeoutMs(kind)).toBe(DEFAULT_SITE_JOB_TIMEOUT_MS);
    }
  });

  it("bounds the log of every site job", () => {
    for (const req of [dbJob("db.provision"), dbJob("db.drop"), wpInstall(), setUrl(), ...NEW_KINDS.map((k) => wpJob(k))]) {
      expect(buildSiteJobContainerPayload(req, ctx).HostConfig.LogConfig).toEqual({
        Type: "json-file",
        Config: { "max-size": "1m", "max-file": "1" },
      });
    }
  });
});

describe("parseWordpressJobResult", () => {
  const plugin = (i: number) => ({
    name: `plugin-${String(i)}`,
    title: `Plugin ${String(i)}`,
    status: "active",
    version: "1.0",
    updateVersion: null,
  });
  const state = (over: Record<string, unknown> = {}) => ({
    coreVersion: "7.1.4",
    coreUpdate: null,
    updatesKnown: true,
    plugins: Array.from({ length: 66 }, (_, i) => plugin(i)),
    themes: [],
    administrators: [{ id: 1, login: "admin" }],
    ...over,
  });
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;

  it("passes a valid state with 66 plugins whole, and an update result", () => {
    expect(parseWordpressJobResult("wordpress.inspect", line(state()))).toEqual(state());
    const items = { items: [{ type: "core", name: "wordpress", oldVersion: "7.1.3", newVersion: "7.1.4", status: "updated" }] };
    expect(parseWordpressJobResult("wordpress.update", line(items))).toEqual(items);
  });

  it("answers undefined for anything else, never throws", () => {
    const bad: Array<[SiteJobRequest["kind"], string]> = [
      ["wordpress.inspect", line(state({ plugins: [{ ...plugin(1), title: "x".repeat(WORDPRESS_RESULT_MAX_BYTES) }] }))],
      ["wordpress.inspect", `${"{".padEnd(WORDPRESS_RESULT_MAX_BYTES + 1, " ")}`],
      ["wordpress.inspect", line(state()) + line(state())],
      ["wordpress.inspect", "not json\n"],
      ["wordpress.inspect", ""],
      ["wordpress.inspect", "null\n"],
      ["wordpress.inspect", line({ items: [] })],
      ["wordpress.update", line(state())],
      ["wordpress.inspect", line(state({ plugins: [{ ...plugin(1), status: "gone" }] }))],
      ["wordpress.inspect", line(state({ extra: true }))],
      ["wordpress.inspect", line(state({ plugins: Array.from({ length: 501 }, (_, i) => plugin(i)) }))],
      ["wordpress.inspect", line(state({ administrators: Array.from({ length: 201 }, (_, i) => ({ id: i + 1, login: "a" })) }))],
      ["wordpress.inspect", line(state({ plugins: [{ ...plugin(1), name: "a\u0001b" }] }))],
      ["wordpress.inspect", line(state({ plugins: [{ ...plugin(1), name: "a‮b" }] }))],
    ];
    for (const [kind, stdout] of bad) {
      expect(parseWordpressJobResult(kind, stdout)).toBeUndefined();
    }
    for (const kind of ["db.provision", "db.drop", "wordpress.install", "wordpress.set-url", "wordpress.settle", "wordpress.reset-password"] as const) {
      expect(parseWordpressJobResult(kind, line(state()))).toBeUndefined();
      expect(parseWordpressJobResult(kind, line({ items: [] }))).toBeUndefined();
    }
    expect(parseWordpressJobResult("rm.rf" as SiteJobRequest["kind"], line(state()))).toBeUndefined();
  });
});

describe("formatSiteJobOutputTail", () => {
  it("keeps the last 50 lines, at most 4 KiB, without secret values", () => {
    const frame = (text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const lines = Array.from({ length: 80 }, (_, i) => `line ${String(i)}`);
    lines.push(`ERROR near 'IDENTIFIED BY '${DB_PW}''`);
    const tail = formatSiteJobOutputTail(frame(`${lines.join("\n")}\n`), { HP_DB_PASSWORD: DB_PW });
    expect(tail.split("\n")).toHaveLength(50);
    expect(tail).not.toContain(DB_PW);
    expect(tail).toContain("[REDACTED]");
    const big = formatSiteJobOutputTail(frame(`${"x".repeat(1900)}\n`.repeat(10)), undefined);
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(4096);
  });
});

async function setup(options?: Parameters<typeof startMockDockerDaemon>[0] & { jobTimeoutMs?: number }) {
  const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-jobs-"));
  cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon(options);
  cleanupTasks.push(() => mockDaemon.close());
  const secretsRootDir = path.join(tmpBaseDir, "secrets");
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir,
    ingressRootDir: path.join(tmpBaseDir, "ingress"),
    pullMissingImages: false,
    sharedDbRootKeyFile: path.join(tmpBaseDir, "mariadb-root.key"),
    ...(options?.jobTimeoutMs !== undefined ? { jobTimeoutMs: options.jobTimeoutMs } : {}),
  });
  const addRunningMariadb = () =>
    mockDaemon.containers.set("mariadb-id", {
      id: "mariadb-id",
      name: SHARED_DB_CONTAINER_NAME,
      image: SHARED_MARIADB_IMAGE,
      env: [],
      labels: {},
      running: true,
      status: "running",
      restartCount: 0,
      hostConfig: {},
      networks: {},
    });
  const jobContainers = () =>
    [...mockDaemon.containers.values()].filter((c) => c.labels["io.hostingpanel.role"] === "site_job");
  return { adapter, mockDaemon, secretsRootDir, addRunningMariadb, jobContainers };
}

describe("DockerEngineSocketAdapter.runSiteJob", () => {
  it("a second job of the same kind for a site is refused", async () => {
    const { adapter, addRunningMariadb } = await setup({ waitStatusCode: "hang", jobTimeoutMs: 300 });
    addRunningMariadb();
    const first = adapter.runSiteJob(wpInstall());
    await expect(adapter.runSiteJob(wpInstall({ jobId: "job_wp_2" }))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    const others = [
      adapter.runSiteJob(dbJob("db.provision")),
      adapter.runSiteJob(wpInstall({ jobId: "job_wp_3", siteId: "site_b", serviceInstanceId: "svc_b" })),
    ];
    const results = await Promise.all([first, ...others]);
    expect(results.map((r) => r.exitCode)).toEqual([124, 124, 124]);
    // Released after the run.
    await expect(adapter.runSiteJob(wpInstall({ jobId: "job_wp_4" }))).resolves.toMatchObject({
      exitCode: 124,
    });
  });

  it("runSiteJob purges secrets even when the job fails", async () => {
    const { adapter, mockDaemon, secretsRootDir, jobContainers } = await setup({ waitStatusCode: 3 });
    const result = await adapter.runSiteJob(wpInstall());
    expect(result).toMatchObject({ jobId: "job_wp_1", exitCode: 3 });
    expect(await readdir(secretsRootDir)).not.toContain("job_wp_1");
    expect(jobContainers()).toEqual([]);
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create?name=job_wp_1"))).toBe(
      true,
    );
    // Anonymous volumes (mariadb's VOLUME /var/lib/mysql) go with the job container (O3).
    const removals = mockDaemon.requestedPaths.filter((p) => p.includes("?force=true"));
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((p) => p.includes("v=true"))).toBe(true);
    expect(mockDaemon.createdVolumes).toContain("hp_vol_svc_a_html");
  });

  it("set-url pulls the wp-cli image and never creates the html volume", async () => {
    const { adapter, mockDaemon } = await setup({ waitStatusCode: 0 });
    await expect(adapter.runSiteJob(setUrl())).resolves.toMatchObject({ exitCode: 0 });
    expect(mockDaemon.requestedPaths.some((p) => p.includes(encodeURIComponent(resolveWordpressCliImage("8.4"))) || p.includes(resolveWordpressCliImage("8.4")))).toBe(true);
    expect(mockDaemon.createdVolumes).toEqual([]);
  });

  it("runSiteJob times out and reports exit 124", async () => {
    const { adapter, mockDaemon, addRunningMariadb } = await setup({
      waitStatusCode: "hang",
      jobTimeoutMs: 50,
    });
    addRunningMariadb();
    await expect(adapter.runSiteJob(dbJob("db.drop"))).resolves.toMatchObject({ exitCode: 124 });
    expect(mockDaemon.requestedPaths.some((p) => /\/containers\/[^/]+\/kill/.test(p))).toBe(true);
  });

  it("db jobs fail fast when the shared database is not running", async () => {
    const { adapter, mockDaemon } = await setup();
    await expect(adapter.runSiteJob(dbJob("db.provision"))).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/images/"))).toBe(false);
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
  });

  it("rejects job ids outside the job_ namespace", async () => {
    const { adapter } = await setup();
    await expect(adapter.runSiteJob(wpInstall({ jobId: "svc_a" }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("cleanupOrphanJobs removes job containers and job secret dirs only", async () => {
    const { adapter, mockDaemon, secretsRootDir, jobContainers, addRunningMariadb } = await setup();
    addRunningMariadb();
    const { writeServiceSecrets } = await import("../src/index.js");
    await writeServiceSecrets(secretsRootDir, "job_old", { HP_DB_PASSWORD: DB_PW });
    await writeServiceSecrets(secretsRootDir, "svc_keep", { DB_PASSWORD: "x" });
    mockDaemon.containers.set("orphan", {
      ...mockDaemon.containers.get("mariadb-id")!,
      id: "orphan",
      name: "job_old",
      labels: { "io.hostingpanel.role": "site_job" },
    });
    await adapter.cleanupOrphanJobs();
    expect(jobContainers()).toEqual([]);
    expect(mockDaemon.containers.has("mariadb-id")).toBe(true);
    expect((await readdir(secretsRootDir)).sort()).toEqual(["svc_keep"]);
  });

  describe("WordPress tools kinds", () => {
    const stateLine = JSON.stringify({
      coreVersion: "6.8.1",
      coreUpdate: null,
      updatesKnown: true,
      plugins: [],
      themes: [],
      administrators: [{ id: 1, login: "admin" }],
    });
    // Logs by stream: the adapter's query decides which frames come back.
    async function wpSetup(stdout: string, stderr = "wp said hello\n", options?: Parameters<typeof setup>[0]) {
      const box: { paths: string[] } = { paths: [] };
      const s = await setup({
        waitStatusCode: 0,
        ...options,
        logsBodyFn: () => {
          const q = new URL(box.paths.at(-1) ?? "/", "http://docker").searchParams;
          return Buffer.concat([
            ...(q.get("stdout") === "1" ? [logFrame(1, stdout)] : []),
            ...(q.get("stderr") === "1" ? [logFrame(2, stderr)] : []),
          ]);
        },
      });
      box.paths = s.mockDaemon.requestedPaths;
      return s;
    }
    const order = (paths: string[], re: RegExp) => paths.findIndex((p) => re.test(p));
    // The mock knows a network once it is created through its API.
    const createNetwork = (socketPath: string, Name: string) =>
      new Promise<void>((resolve, reject) => {
        const req = http.request({ socketPath, path: "/networks/create", method: "POST" }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end(JSON.stringify({ Name }));
      });

    it("connects the edge network after create and before start, for inspect and update only", async () => {
      for (const kind of NEW_KINDS) {
        const { adapter, mockDaemon } = await wpSetup(`${stateLine}\n`);
        await createNetwork(mockDaemon.socketPath, "hp_edge_site_a_net");
        await adapter.runSiteJob(wpJob(kind));
        const edge = mockDaemon.networkConnectCalls.filter((c) => c.network === "hp_edge_site_a_net");
        const paths = mockDaemon.requestedPaths;
        if (SITE_JOB_SPECS[kind].edgeNetwork) {
          expect(edge, kind).toHaveLength(1);
          const connect = order(paths, /\/networks\/hp_edge_site_a_net\/connect/);
          expect(order(paths, /\/containers\/create/)).toBeLessThan(connect);
          expect(connect).toBeLessThan(order(paths, /\/containers\/[^/]+\/start/));
        } else {
          expect(mockDaemon.networkConnectCalls, kind).toEqual([]);
        }
      }
    });

    // The real engine accepts a connect of a created container to a missing network, then fails the start.
    it("a missing edge network is not an error: the job runs on the site network only", async () => {
      const { adapter, mockDaemon } = await wpSetup(`${stateLine}\n`);
      const result = await adapter.runSiteJob(wpJob("wordpress.inspect"));
      expect(result).toMatchObject({ exitCode: 0, result: { updatesKnown: true } });
      expect(mockDaemon.networkConnectCalls).toEqual([]);
      expect(mockDaemon.requestedPaths.some((p) => /\/containers\/[^/]+\/start/.test(p))).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/hp_|mockcontainer|\/tmp\//);
    });

    // K3: a broken connect or look-up of the edge network ends the job with one fixed sentence.
    it("a failed connect or look-up of the edge network gives the fixed sentence and removes the container", async () => {
      for (const broken of ["connect", "lookup"] as const) {
        const { adapter, mockDaemon, jobContainers } = await wpSetup(`${stateLine}\n`);
        await createNetwork(mockDaemon.socketPath, "hp_edge_site_a_net");
        mockDaemon.brokenNetworks[broken].add("hp_edge_site_a_net");
        const err = await adapter.runSiteJob(wpJob("wordpress.inspect")).catch((e: unknown) => e);
        expect(err, broken).toMatchObject({
          code: "DOCKER_ENGINE_UNAVAILABLE",
          message: "Could not connect the site tools to the internet",
        });
        expect(String((err as Error).message)).not.toMatch(/hp_|_net|job_|engine broke/);
        expect(mockDaemon.networkConnectCalls, broken).toHaveLength(broken === "connect" ? 1 : 0);
        expect(mockDaemon.requestedPaths.some((p) => /\/containers\/[^/]+\/start/.test(p)), broken).toBe(false);
        expect(jobContainers(), broken).toEqual([]);
      }
    });

    it("reads the result from stdout only and the tail from stderr only", async () => {
      const { adapter, mockDaemon } = await wpSetup(`${stateLine}\n`, "loading site\n");
      const result = await adapter.runSiteJob(wpJob("wordpress.inspect"));
      expect(result.result).toEqual(JSON.parse(stateLine));
      expect(result.outputTail).toBe("loading site");
      const logs = mockDaemon.requestedPaths.filter((p) => p.includes("/logs?"));
      expect(logs.some((p) => p.includes("stdout=1&stderr=0"))).toBe(true);
      expect(logs.filter((p) => !p.includes("stdout=1&stderr=0")).every((p) => p.includes("stdout=0&stderr=1"))).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/hp_|mockcontainer|\/tmp\//);
    });

    it("a result over the ceiling or one that does not parse gives no result and no exception", async () => {
      const over = `${JSON.stringify({ ...JSON.parse(stateLine), pad: "x".repeat(WORDPRESS_RESULT_MAX_BYTES) })}\n`;
      for (const stdout of [over, "not json\n", `${stateLine}\n${stateLine}\n`]) {
        const { adapter } = await wpSetup(stdout);
        const result = await adapter.runSiteJob(wpJob("wordpress.inspect"));
        expect(result.exitCode).toBe(0);
        expect(result).not.toHaveProperty("result");
      }
    });

    it("a kind without a result never carries one and keeps its full tail", async () => {
      for (const kind of ["wordpress.settle", "wordpress.reset-password"] as const) {
        const { adapter, mockDaemon } = await wpSetup(`${stateLine}\n`);
        const result = await adapter.runSiteJob(wpJob(kind));
        expect(result, kind).not.toHaveProperty("result");
        expect(mockDaemon.requestedPaths.some((p) => p.includes("stderr=0")), kind).toBe(false);
      }
    });

    it("a reset that does not end answers 124 after its own limit, not the adapter's", async () => {
      const real = globalThis.setTimeout;
      const delays: number[] = [];
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return real(fn, ms === siteJobTimeoutMs("wordpress.reset-password") ? 20 : ms);
      }) as typeof setTimeout);
      cleanupTasks.push(async () => vi.restoreAllMocks());
      const { adapter, mockDaemon } = await wpSetup("", "", { waitStatusCode: "hang" });
      const result = await adapter.runSiteJob(wpJob("wordpress.reset-password"));
      expect(result.exitCode).toBe(124);
      expect(delays).toContain(60_000);
      expect(delays).not.toContain(DEFAULT_SITE_JOB_TIMEOUT_MS);
      expect(mockDaemon.requestedPaths.some((p) => /\/containers\/[^/]+\/kill/.test(p))).toBe(true);
    });

    it("a reset with the image missing answers DOCKER_ENGINE_UNAVAILABLE and pulls nothing", async () => {
      const { adapter, mockDaemon } = await wpSetup("", "", { pullBody: "{}" });
      const err = await adapter.runSiteJob(wpJob("wordpress.reset-password")).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
      expect(String((err as Error).message)).not.toMatch(/hp_|wordpress:|\/tmp\/|job_/);
      expect(mockDaemon.requestedPaths.some((p) => p.includes("/images/create"))).toBe(false);
      expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
    });
  });
});

describe("readJobStdout", () => {
  it("joins stdout frames only and keeps whole lines", () => {
    const body = Buffer.concat([logFrame(1, '{"a":'), logFrame(2, "noise\n"), logFrame(1, "1}\n")]);
    expect(readJobStdout(body, 100)).toBe('{"a":1}\n');
  });

  it("refuses a body over the ceiling without copying the rest", () => {
    const body = Buffer.concat(Array.from({ length: 64 }, () => logFrame(1, "y".repeat(65_536))));
    const concat = vi.spyOn(Buffer, "concat");
    cleanupTasks.push(async () => vi.restoreAllMocks());
    expect(readJobStdout(body, WORDPRESS_RESULT_MAX_BYTES)).toBeNull();
    expect(concat).not.toHaveBeenCalled();
  });
});
