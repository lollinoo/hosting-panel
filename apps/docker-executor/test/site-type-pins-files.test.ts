// Frozen pins (M6a): what the executor generates today for a WordPress site; the lead holds the fixture hashes. Rewrite only with UPDATE_SITE_TYPE_PINS=1.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PHP_VERSION, resolveWordpressImage, type SftpAccessUser } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SFTP_STATE_DIR,
  DEFAULT_SITE_FILES_DIR,
  DockerEngineSocketAdapter,
  SITE_FILES_PROGRAM,
  SiteFilesHelpers,
  WORDPRESS_EXECUTOR_SITE_TYPE,
  buildSftpContainerPayload,
  buildSiteFilesHelperPayload,
  getManagedVolumeName,
  reapTerminalShells,
  renderSftpSshdConfig,
  renderSftpUserFiles,
  startDockerTerminal,
  type DockerExecTarget,
} from "../src/index.js";
import { hashSftpContainerConfig } from "../src/sftp-platform.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/site-type-pins/", import.meta.url));
const UPDATE = process.env.UPDATE_SITE_TYPE_PINS === "1";

const SITE_A = "site_pin_a";
const SVC_A = "svc_pin_a";
const SITE_B = "site_pin_b";
const SVC_B = "svc_pin_b";
const SITE_CONTAINER_ID = "ctr_pin_site_a";
const TERMINAL_SESSION = `term_${"5e".repeat(16)}`;
const STARTED_AT = "2026-11-17T08:00:00.000000001Z";
// sha512-crypt shaped sentinels, not hashes of any password.
const SENTINEL_HASH_1 = `$6$sentinelsalt$${"sentinelhashone".repeat(6).slice(0, 86)}`;
const SENTINEL_HASH_2 = `$6$rounds=5000$sentinelsalt$${"sentinelhashtwo".repeat(6).slice(0, 86)}`;

const SFTP_USERS: SftpAccessUser[] = [
  { username: "spina_web", passwordHash: SENTINEL_HASH_1, siteId: SITE_A, serviceInstanceId: SVC_A },
  { username: "spina_ci", passwordHash: SENTINEL_HASH_2, siteId: SITE_A, serviceInstanceId: SVC_A },
  { username: "spinb_admin", passwordHash: SENTINEL_HASH_1, siteId: SITE_B, serviceInstanceId: SVC_B },
];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

type Answer = (method: string, urlPath: string) => { readonly statusCode: number; readonly body?: unknown };

/** A Docker client that records every call and answers from a table; no socket is opened. */
function fakeTarget(answer: Answer): { readonly target: DockerExecTarget; readonly calls: Call[] } {
  const calls: Call[] = [];
  const target: DockerExecTarget = {
    socketPath: "/nonexistent/pins-docker.sock",
    apiPrefix: "/v1.45",
    request: (method, urlPath, jsonBody) => {
      calls.push(jsonBody === undefined ? { method, path: urlPath } : { method, path: urlPath, body: jsonBody });
      const { statusCode, body } = answer(method, urlPath);
      return Promise.resolve({ statusCode, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
    },
  };
  return { target, calls };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

// --- One small function per fixture: every call to shipped code lives here. ---

/** files-program.php */
function filesProgram(): string {
  return SITE_FILES_PROGRAM;
}

/** files-helper-create.json */
function filesHelperCreate(): unknown {
  return buildSiteFilesHelperPayload({
    image: resolveWordpressImage(DEFAULT_PHP_VERSION),
    serviceInstanceId: SVC_A,
    siteId: SITE_A,
    programDir: DEFAULT_SITE_FILES_DIR,
    siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
  });
}

/** files-helper-exec-list.json: every Docker call of one `list`, up to the refused exec. */
async function filesHelperExecList(): Promise<unknown> {
  const { target, calls } = fakeTarget((method, urlPath) => {
    if (method === "GET" && urlPath.startsWith("/containers/hp_files_")) return { statusCode: 404 };
    if (method === "GET" && urlPath.startsWith("/volumes/")) {
      return { statusCode: 200, body: { Labels: { "io.hostingpanel.site_id": SITE_A } } };
    }
    if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [] };
    if (method === "GET" && urlPath.startsWith("/images/")) return { statusCode: 200, body: {} };
    if (method === "POST" && urlPath.startsWith("/containers/create")) return { statusCode: 201, body: { Id: "ctr_pin_helper" } };
    if (method === "POST" && urlPath.endsWith("/start")) return { statusCode: 204 };
    return { statusCode: 500 };
  });
  const helpers = new SiteFilesHelpers({ target, programDir: DEFAULT_SITE_FILES_DIR });
  try {
    await helpers.run({ serviceInstanceId: SVC_A, op: "list", path: "" }).catch(() => undefined);
  } finally {
    helpers.stop();
  }
  return calls;
}

/** sftp-user-files.json */
function sftpUserFiles(): unknown {
  return renderSftpUserFiles(SFTP_USERS, () => WORDPRESS_EXECUTOR_SITE_TYPE);
}

/** Input of the SFTP container: one mount per site, named the way the adapter names it. */
function sftpContainerInput() {
  const sites = [...new Map(SFTP_USERS.map((u) => [u.siteId, getManagedVolumeName(u.serviceInstanceId, "html")]))];
  return { stateDir: DEFAULT_SFTP_STATE_DIR, sites: sites.map(([siteId, volume]) => ({ siteId, volume })) };
}

/** sftp-container.json: the builder's output plus the volumes the adapter inspects for the same users. */
async function sftpContainer(): Promise<unknown> {
  const built = buildSftpContainerPayload(sftpContainerInput());
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-pins-sftp-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const daemon = await startMockDockerDaemon();
  cleanup.push(() => daemon.close());
  const sftpStateDir = path.join(tmp, "sftp");
  await mkdir(sftpStateDir, { mode: 0o700 });
  await chmod(sftpStateDir, 0o700);
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: daemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    pullMissingImages: false,
    sftpStateDir,
  });
  await adapter.applySftpAccess({ users: SFTP_USERS }).catch(() => undefined);
  const adapterVolumeLookups = daemon.requestedPaths.filter((p) => p.includes("/volumes/"));
  return { ...built, adapterVolumeLookups };
}

/** sftp-config-hash.txt */
function sftpConfigHash(): string {
  return hashSftpContainerConfig(buildSftpContainerPayload(sftpContainerInput()).payload, renderSftpSshdConfig());
}

/** terminal-exec.json: the exec call that opens the shell (the fake refuses it). */
async function terminalExec(): Promise<unknown> {
  const { target, calls } = fakeTarget((method) =>
    method === "GET"
      ? { statusCode: 200, body: { Name: "/hp_site_pin_a", State: { Running: true, StartedAt: STARTED_AT } } }
      : { statusCode: 500 },
  );
  const sink = { data: () => undefined, exit: () => undefined };
  await startDockerTerminal(target, SITE_CONTAINER_ID, TERMINAL_SESSION, sink, WORDPRESS_EXECUTOR_SITE_TYPE).catch(() => undefined);
  return calls.find((c) => c.path.endsWith("/exec"));
}

/** terminal-kill-exec.json: the exec call that ends every marked shell at executor start. */
async function terminalKillExec(): Promise<unknown> {
  const { target, calls } = fakeTarget((method, urlPath) => {
    if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [{ Id: SITE_CONTAINER_ID }] };
    if (method === "GET") {
      return { statusCode: 200, body: { Name: "/hp_site_pin_a", State: { Running: true, StartedAt: STARTED_AT }, ExecIDs: ["exec_pin_1"] } };
    }
    return { statusCode: 500 };
  });
  await reapTerminalShells(target, WORDPRESS_EXECUTOR_SITE_TYPE).catch(() => undefined);
  return calls.find((c) => c.path.endsWith("/exec"));
}

// --- Expectations ---

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Compares the generated text with the frozen fixture (writes it only under UPDATE_SITE_TYPE_PINS=1). */
async function pin(name: string, text: string): Promise<void> {
  const file = path.join(FIXTURES, name);
  if (UPDATE) {
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(file, text, "utf8");
  }
  expect(text, name).toBe(await readFile(file, "utf8"));
}

describe("site type pins: files, SFTP and terminal of a WordPress site", () => {
  it("files-program.php is the whole helper program", async () => {
    await pin("files-program.php", filesProgram());
  });

  it("files-helper-create.json is the helper container body", async () => {
    await pin("files-helper-create.json", json(filesHelperCreate()));
  });

  it("files-helper-exec-list.json is every Docker call of a list, the exec last", async () => {
    await pin("files-helper-exec-list.json", json(await filesHelperExecList()));
  });

  it("sftp-user-files.json is passwd, group and shadow for three users of two sites", async () => {
    await pin("sftp-user-files.json", json(sftpUserFiles()));
  });

  it("sftp-container.json is the SFTP container body and the volumes the adapter looks up", async () => {
    await pin("sftp-container.json", json(await sftpContainer()));
  });

  it("sftp-config-hash.txt is the config hash of the same input", async () => {
    await pin("sftp-config-hash.txt", sftpConfigHash());
  });

  it("terminal-exec.json is the exec that opens the shell", async () => {
    await pin("terminal-exec.json", json(await terminalExec()));
  });

  it("terminal-kill-exec.json is the exec that ends the shells", async () => {
    await pin("terminal-kill-exec.json", json(await terminalKillExec()));
  });
});
