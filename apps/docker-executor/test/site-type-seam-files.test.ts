// Seam: files, SFTP and terminal driven by the test-only type carry its values and none of WordPress's.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SftpAccessUser } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  MANAGED_DOCKER_LABELS,
  SiteFilesHelpers,
  buildSiteFilesHelperPayload,
  buildSiteFilesProgram,
  reapTerminalShells,
  renderSftpUserFiles,
  startDockerTerminal,
  type DockerExecTarget,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_EXECUTOR_SITE_TYPE } from "./support/test-site-type.js";

const T = TEST_EXECUTOR_SITE_TYPE;
const WORDPRESS_VALUES = /wordpress|wp-|wp_|\/var\/www\/html|33:33|_html\b|mu-plugins|\.maintenance|hp-files\.php|import\./i;
const HASH = `$6$sentinelsalt$${"sentinelhashone".repeat(6).slice(0, 86)}`;
const USERS: SftpAccessUser[] = [
  { username: "seama_web", passwordHash: HASH, siteId: "site_seam_a", serviceInstanceId: "svc_seam_a" },
];

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** Records every Docker call and answers from a table. */
function fakeTarget(answer: (method: string, urlPath: string) => { statusCode: number; body?: unknown }) {
  const calls: Call[] = [];
  const target: DockerExecTarget = {
    socketPath: "/nonexistent/seam-docker.sock",
    apiPrefix: "/v1.45",
    request: (method, urlPath, jsonBody) => {
      calls.push({ method, path: urlPath, body: jsonBody });
      const { statusCode, body } = answer(method, urlPath);
      return Promise.resolve({ statusCode, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
    },
  };
  return { target, calls };
}

describe("site type seam: files, SFTP and terminal of the test type", () => {
  it("the files program roots at the type's mount path and holds no WordPress text", () => {
    const program = buildSiteFilesProgram(T);
    expect(program).toContain("'/srv/public'");
    expect(program).toContain("$protected = array();");
    expect(program).not.toMatch(WORDPRESS_VALUES);
  });

  it("the helper's create body mounts the type's volume at its path as its owner", () => {
    const payload = buildSiteFilesHelperPayload({
      image: "hp-test-static-helper:1",
      serviceInstanceId: "svc_seam_a",
      siteId: "site_seam_a",
      programDir: "/srv/hp-files",
      siteType: T,
    }) as { User: string; WorkingDir: string; HostConfig: { Binds: string[] } };
    expect(payload.User).toBe("1000:1000");
    expect(payload.WorkingDir).toBe("/srv/public");
    expect(payload.HostConfig.Binds[0]).toBe("hp_vol_svc_seam_a_public:/srv/public:rw,nocopy");
    expect(JSON.stringify(payload)).not.toMatch(WORDPRESS_VALUES);
  });

  it("the helper picks the type's image and execs the type's program as its owner", async () => {
    const { target, calls } = fakeTarget((method, urlPath) => {
      if (method === "GET" && urlPath.startsWith("/containers/hp_files_")) return { statusCode: 404 };
      if (method === "GET" && urlPath.startsWith("/volumes/")) return { statusCode: 200, body: { Labels: { "io.hostingpanel.site_id": "site_seam_a" } } };
      if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [{ Image: "wordpress:latest" }] };
      if (method === "GET" && urlPath.startsWith("/images/")) return { statusCode: 200, body: {} };
      if (method === "POST" && urlPath.startsWith("/containers/create")) return { statusCode: 201, body: { Id: "ctr_seam_helper" } };
      if (method === "POST" && urlPath.endsWith("/start")) return { statusCode: 204 };
      return { statusCode: 500 };
    });
    const helpers = new SiteFilesHelpers({ target, programDir: "/srv/hp-files", resolveSiteType: () => T });
    try {
      await helpers.run({ serviceInstanceId: "svc_seam_a", op: "list", path: "" }).catch(() => undefined);
      await expect(
        helpers.run({ serviceInstanceId: "svc_seam_a", op: "import.stat", importId: "imp_seam" } as never),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      helpers.stop();
    }
    expect(calls.map((c) => c.path)).toContain("/volumes/hp_vol_svc_seam_a_public");
    expect(calls.map((c) => c.path)).toContain("/images/hp-test-static-helper%3A1/json");
    const exec = calls.find((c) => c.path.endsWith("/exec"))?.body as { User: string; WorkingDir: string; Cmd: string[] };
    expect(exec.User).toBe("1000:1000");
    expect(exec.WorkingDir).toBe("/srv/public");
    expect(exec.Cmd.at(-1)).toBe("/usr/local/lib/hp-files/hp-files-teststatic.php");
    expect(JSON.stringify(calls.filter((c) => !c.path.startsWith("/containers/json")))).not.toMatch(WORDPRESS_VALUES);
  });

  it("the SFTP passwd line carries the type's owner and the adapter looks up the type's volume", async () => {
    const files = renderSftpUserFiles(USERS, () => T);
    expect(files.passwd).toContain("seama_web:x:1000:1000::/srv/sftp/site_seam_a:/bin/false");
    expect(JSON.stringify(files)).not.toMatch(WORDPRESS_VALUES);

    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-seam-sftp-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const daemon = await startMockDockerDaemon();
    cleanup.push(() => daemon.close());
    await mkdir(path.join(tmp, "sftp"), { mode: 0o700 });
    await chmod(path.join(tmp, "sftp"), 0o700);
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: daemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      sftpStateDir: path.join(tmp, "sftp"),
      resolveSiteType: () => T,
    });
    await adapter.applySftpAccess({ users: USERS }).catch(() => undefined);
    const lookups = daemon.requestedPaths.filter((p) => p.includes("/volumes/"));
    expect(lookups.some((p) => p.endsWith("/volumes/hp_vol_svc_seam_a_public"))).toBe(true);
    expect(lookups.join("\n")).not.toMatch(WORDPRESS_VALUES);
  });

  it("the terminal opens and ends its shell as the type's owner in the type's directory", async () => {
    const running = { statusCode: 200, body: { Name: "/hp_site_seam_a", State: { Running: true, StartedAt: "2026-11-17T08:00:00Z" }, ExecIDs: ["exec_seam"] } };
    const { target, calls } = fakeTarget((method, urlPath) => {
      if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [{ Id: "ctr_seam_site" }] };
      return method === "GET" ? running : { statusCode: 500 };
    });
    const sink = { data: () => undefined, exit: () => undefined };
    await startDockerTerminal(target, "ctr_seam_site", `term_${"5e".repeat(16)}`, sink, T).catch(() => undefined);
    await reapTerminalShells(target, T).catch(() => undefined);
    const execs = calls.filter((c) => c.path.endsWith("/exec")).map((c) => c.body as { User: string; WorkingDir?: string });
    expect(execs).toHaveLength(2);
    expect(execs[0]).toMatchObject({ User: "1000:1000", WorkingDir: "/srv/public" });
    expect(execs[1]?.User).toBe("1000:1000");
    expect(JSON.stringify(execs)).not.toMatch(WORDPRESS_VALUES);
  });

  it("the adapter's terminal resolves the type through its option", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-seam-term-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const daemon = await startMockDockerDaemon({ execUpgrade: true });
    cleanup.push(() => daemon.close());
    daemon.containers.set("hp_site_seam_a_id", {
      id: "hp_site_seam_a_id", name: "hp_site_seam_a", image: "hp-test-static:1", env: [], running: true, status: "running",
      restartCount: 0, startedAt: "2026-11-17T08:00:00.000000001Z", hostConfig: {}, networks: {},
      labels: { [MANAGED_DOCKER_LABELS.siteId]: "site_seam_a", [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_seam_a" },
    });
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: daemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      terminalLimits: { readWaitMs: 2_000 },
      resolveSiteType: () => T,
    });
    const sessionId = `term_${"b2".repeat(16)}`;
    cleanup.push(() => adapter.closeTerminal({ sessionId }).catch(() => undefined));
    await adapter.openTerminal({ sessionId, siteId: "site_seam_a", serviceInstanceId: "svc_seam_a" });
    expect(daemon.execBodies[0]).toMatchObject({ User: "1000:1000", WorkingDir: "/srv/public" });
  });
});
