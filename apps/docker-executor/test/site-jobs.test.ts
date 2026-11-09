import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHARED_MARIADB_IMAGE, resolveWordpressCliImage } from "@hosting-panel/contracts";
import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  WORDPRESS_SET_URL_SCRIPT,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

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
    expect(payload.Cmd[2]).toBe(WORDPRESS_SET_URL_SCRIPT);
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
  it("wordpress.install passes customer values only as env and never inside Cmd", () => {
    const title = `L'Hôtel "Bella" $(id)`;
    const req = wpInstall({ params: { ...wpInstall().params, title } });
    const payload = buildSiteJobContainerPayload(req, {
      ...ctx,
      secretFileEnv: [
        "HP_ADMIN_PASSWORD_FILE=/run/secrets/HP_ADMIN_PASSWORD",
        "HP_DB_PASSWORD_FILE=/run/secrets/HP_DB_PASSWORD",
      ],
    });
    expect(payload.Cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(payload.Cmd[2]).not.toContain("Bella");
    expect(payload.Cmd[2]).not.toContain("$(id)");
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
  });

  it("db.provision script re-checks the password is 64 hex", () => {
    const payload = buildSiteJobContainerPayload(dbJob("db.provision"), ctx);
    expect(payload.Cmd[2]).toContain("*[!0-9a-f]*) exit 64");
    expect(payload.Cmd[2]).toContain("-eq 64");
    expect(payload.Cmd[2]).not.toContain("wp_site_a");
    expect(payload.Env).toEqual(expect.arrayContaining(["HP_DB_NAME=wp_site_a", "HP_DB_USER=wp_site_a"]));
  });

  it("wordpress.install script is idempotent and refuses a foreign wp-config.php", () => {
    const payload = buildSiteJobContainerPayload(wpInstall(), ctx);
    const script = payload.Cmd[2];
    expect(script).toContain("wp config has HP_MANAGED");
    expect(script).toContain("exit 20");
    expect(script).toContain("wp core is-installed ||");
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
});
