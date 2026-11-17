// Frozen pins (M6a): what the executor generates today for a WordPress site; the lead holds the fixture hashes. Rewrite only with UPDATE_SITE_TYPE_PINS=1.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PHPMYADMIN_PORT,
  siteDatabasePrefix,
  type BackupsIpcRequest,
  type BackupTarget,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBackupDumpContainerPayload,
  buildBackupRepoContainerPayload,
  buildBackupStagingVolumePayload,
  buildBackupUploadContainerPayload,
} from "../src/backup-jobs.js";
import { BackupRunner, DEFAULT_BACKUP_NETWORK_NAME, DEFAULT_BACKUP_WORK_DIR, type DockerRequest } from "../src/backup-runner.js";
import {
  DEFAULT_PHPMYADMIN_CONFIG_DIR,
  PHPMYADMIN_CONTAINER_NAME,
  PHPMYADMIN_NETWORK_NAME,
  buildPhpMyAdminContainerPayload,
  renderPhpMyAdminConfig,
} from "../src/phpmyadmin-platform.js";
import {
  buildArchiveContainerPayload,
  buildRestoreDbScript,
  buildRestoreFetchScript,
  buildRestoreFilesScript,
  buildRestoreFetchContainerPayload,
  buildRestoreFilesContainerPayload,
  buildRestoreFinishContainerPayload,
  buildRestoreOwnContainerPayload,
  buildRestorePrepareContainerPayload,
  buildRestoreSwitchContainerPayload,
  buildRestoreUndoDbContainerPayload,
  buildRestoreUndoFilesContainerPayload,
  writeRestoreNote,
} from "../src/restore-jobs.js";
import {
  DEFAULT_SHARED_DB_ADMIN_SUBNET,
  DEFAULT_SHARED_DB_DATA_DIR,
  DEFAULT_SHARED_DB_ROOT_KEY_FILE,
  SHARED_DB_ALIAS,
  SHARED_DB_NETWORK_NAME,
  buildSharedDatabaseContainerPayload,
} from "../src/shared-database.js";
import { buildSiteDatabasesBatch, buildStateQuery, type SiteDatabasesState } from "../src/site-databases.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "../src/site-types/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/site-type-pins/", import.meta.url));
const UPDATE = process.env.UPDATE_SITE_TYPE_PINS === "1";

const SITE_A = "site_pin_a";
const SVC_A = "svc_pin_a";
const BACKUP_JOB = `op_${"b0".repeat(16)}`;
const RESTORE_JOB = `op_${"c0".repeat(16)}`;
const ARCHIVE_JOB = `op_${"a0".repeat(16)}`;
const SNAPSHOT_ID = "5a".repeat(32);
const EXECUTOR_USER = "990:990";
const SHARED_DB_USER = "998:998";
const DB_PREFIX = siteDatabasePrefix(SITE_A);

const TARGET: BackupTarget = {
  endpoint: "https://s3.example.test:9000",
  region: "eu-central-1",
  bucket: "pin-backups",
  prefix: "pins/site-a",
  accessKeyId: "sentinel-access-key",
  secretAccessKey: "sentinel-secret-key",
};

// Secrets reach the containers as files: binds and *_FILE paths only, as the runner writes them.
const SECRETS_DIR = "/run/hosting-panel/secrets";
const resticSecrets = (instance: string) => ({
  secretBinds: [
    `${SECRETS_DIR}/${instance}/AWS_SHARED_CREDENTIALS:/run/secrets/AWS_SHARED_CREDENTIALS:ro`,
    `${SECRETS_DIR}/${instance}/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro`,
  ],
  secretFileEnv: [
    "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/AWS_SHARED_CREDENTIALS",
    "RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD",
  ],
});
const dbSecrets = (instance: string) => ({
  secretBinds: [`${SECRETS_DIR}/${instance}/MARIADB_ROOT:/run/secrets/MARIADB_ROOT:ro`],
  secretFileEnv: ["MARIADB_ROOT_FILE=/run/secrets/MARIADB_ROOT"],
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-pins-backups-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs one BackupRunner request over a fake Docker client and returns the calls that name the
 * site files volume (hp_vol_) plus the images the runner ensured. Unknown calls answer 500.
 */
async function runRunner(
  request: BackupsIpcRequest,
  siteVolumeExists: boolean,
): Promise<{ readonly result: unknown; readonly ensuredImages: string[]; readonly siteVolumeCalls: Call[] }> {
  const tmp = await tempDir();
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${"5e".repeat(32)}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "mariadb-root.key");
  await writeFile(sharedDbRootKeyFile, "sentinel-root-password\n", { mode: 0o400 });
  const sharedDbDataDir = path.join(tmp, "mariadb-data");
  await mkdir(sharedDbDataDir, { mode: 0o700 });

  const calls: Call[] = [];
  const dockerRequest: DockerRequest = (method, urlPath, body) => {
    calls.push(body === undefined ? { method, path: urlPath } : { method, path: urlPath, body });
    const answer = (statusCode: number, json?: unknown) =>
      Promise.resolve({ statusCode, body: Buffer.from(json === undefined ? "" : JSON.stringify(json)) });
    if (method === "POST" && urlPath === "/volumes/create") return answer(201, {});
    if (method === "GET" && urlPath.startsWith("/volumes/hp_vol_")) return answer(siteVolumeExists ? 200 : 404, {});
    if (method === "GET" && urlPath.startsWith("/containers/json")) return answer(200, []);
    if (method === "DELETE") return answer(204);
    return answer(500, { message: "refused by the pin fake" });
  };
  const ensuredImages: string[] = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response("<ListBucketResult/>", { status: 200 });
    return new Response(null, { status: method === "DELETE" ? 204 : 200 });
  }) as typeof globalThis.fetch;

  const runner = new BackupRunner({
    request: dockerRequest,
    ensureImage: async (image) => {
      ensuredImages.push(image);
    },
    ensureBackupNetwork: async () => undefined,
    listSiteDatabases: async () => [{ name: DB_PREFIX, sizeBytes: 2048 }],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: SHARED_DB_NETWORK_NAME,
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    executorUser: EXECUTOR_USER,
    backupWorkDir: path.join(tmp, "backup-work"),
    sharedDbDataDir,
    statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
    fetch: fakeFetch,
  });

  let result: unknown = await runner.run(request);
  if ("jobId" in request) {
    const until = performance.now() + 5_000;
    for (;;) {
      result = await runner.run({ action: "status", jobId: request.jobId });
      if ((result as { state?: string } | null)?.state !== "running") break;
      if (performance.now() > until) throw new Error(`job ${request.jobId} did not settle`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const siteVolumeCalls = calls.filter((c) => `${c.path}${JSON.stringify(c.body ?? "")}`.includes("hp_vol_"));
  return { result, ensuredImages, siteVolumeCalls };
}

// --- One small function per fixture: every call to shipped code lives here. ---

/** db-shared-container.json */
function dbSharedContainer(): unknown {
  return buildSharedDatabaseContainerPayload({
    user: SHARED_DB_USER,
    dataDirHostPath: DEFAULT_SHARED_DB_DATA_DIR,
    rootKeyHostPath: DEFAULT_SHARED_DB_ROOT_KEY_FILE,
    adminSubnet: DEFAULT_SHARED_DB_ADMIN_SUBNET,
  });
}

/** db-batch-state.sql: the state query, then the batch that adds one database to a site with one extra user. */
function dbBatchState(): string {
  const shop = `${DB_PREFIX}_shop`;
  const state: SiteDatabasesState = {
    databases: [{ name: DB_PREFIX, primary: true, sizeBytes: 2048 }],
    users: [
      { name: DB_PREFIX, primary: true, databases: [DB_PREFIX] },
      { name: `${DB_PREFIX}_app`, primary: false, databases: [shop] },
    ],
    signOnDatabases: [DB_PREFIX],
  };
  const batch = buildSiteDatabasesBatch(SITE_A, state, { siteId: SITE_A, op: "createDatabase", database: shop });
  return `${buildStateQuery(SITE_A)}\n-- buildSiteDatabasesBatch createDatabase ${shop}\n${String(batch)}\n`;
}

/** pma-config.php */
function pmaConfig(): string {
  return renderPhpMyAdminConfig(SHARED_DB_ALIAS);
}

/** pma-container.json */
function pmaContainer(): unknown {
  return buildPhpMyAdminContainerPayload({
    containerName: PHPMYADMIN_CONTAINER_NAME,
    network: PHPMYADMIN_NETWORK_NAME,
    configFile: `${DEFAULT_PHPMYADMIN_CONFIG_DIR}/config.inc.php`,
    port: DEFAULT_PHPMYADMIN_PORT,
  });
}

/** backup-repo.json */
function backupRepo(): unknown {
  return buildBackupRepoContainerPayload({
    mode: "job",
    jobId: BACKUP_JOB,
    siteId: SITE_A,
    init: true,
    target: TARGET,
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    ...resticSecrets(`job_bk_${BACKUP_JOB}`),
  });
}

const backupStagingVolume = (): string => buildBackupStagingVolumePayload({ jobId: BACKUP_JOB, siteId: SITE_A }).Name;

/** backup-dump.json */
function backupDump(): unknown {
  return buildBackupDumpContainerPayload({
    jobId: BACKUP_JOB,
    siteId: SITE_A,
    databases: [
      { name: DB_PREFIX, sizeBytes: 2048 },
      { name: `${DB_PREFIX}_shop`, sizeBytes: 4096 },
    ],
    executorUser: EXECUTOR_USER,
    sharedDbRootKeyFile: DEFAULT_SHARED_DB_ROOT_KEY_FILE,
    sharedDbNetworkName: SHARED_DB_NETWORK_NAME,
    stagingVolumeName: backupStagingVolume(),
  });
}

/** backup-upload.json: the upload spec, and the runner's site volume calls for a backup and a siteState. */
async function backupUpload(): Promise<unknown> {
  const spec = buildBackupUploadContainerPayload({
    jobId: BACKUP_JOB,
    siteId: SITE_A,
    serviceInstanceId: SVC_A,
    siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
    target: TARGET,
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    ...resticSecrets(`job_bk_${BACKUP_JOB}`),
    stagingVolumeName: backupStagingVolume(),
  });
  const runnerStart = await runRunner(
    { action: "start", jobId: BACKUP_JOB, siteId: SITE_A, serviceInstanceId: SVC_A, target: TARGET },
    false,
  );
  const runnerSiteState = await runRunner({ action: "siteState", siteId: SITE_A, serviceInstanceId: SVC_A }, true);
  return { spec, runnerStart, runnerSiteState };
}

/** restore-fetch.sh */
function restoreFetchScript(): string {
  return buildRestoreFetchScript(WORDPRESS_EXECUTOR_SITE_TYPE);
}

/** restore-db.sh */
function restoreDbScript(): string {
  return buildRestoreDbScript(WORDPRESS_EXECUTOR_SITE_TYPE);
}

/** restore-files.sh */
function restoreFilesScript(): string {
  return buildRestoreFilesScript(WORDPRESS_EXECUTOR_SITE_TYPE);
}

const restoreStagingVolume = (): string => buildBackupStagingVolumePayload({ jobId: RESTORE_JOB, siteId: SITE_A }).Name;

/** restore-steps.json: every step's container spec, and the runner's site volume calls for a restore that creates the volume. */
async function restoreSteps(): Promise<unknown> {
  const ids = { jobId: RESTORE_JOB, siteId: SITE_A, serviceInstanceId: SVC_A };
  const t = { siteType: WORDPRESS_EXECUTOR_SITE_TYPE };
  const db = { sharedDbNetworkName: SHARED_DB_NETWORK_NAME, ...dbSecrets(`job_bk_db_${RESTORE_JOB}`) };
  const stagingVolumeName = restoreStagingVolume();
  const runner = await runRunner(
    { action: "restore", ...ids, target: TARGET, snapshotId: SNAPSHOT_ID, createVolume: true },
    false,
  );
  return {
    fetch: buildRestoreFetchContainerPayload({
      ...ids,
      ...t,
      snapshotId: SNAPSHOT_ID,
      target: TARGET,
      backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
      ...resticSecrets(`job_bk_rs_${RESTORE_JOB}`),
      stagingVolumeName,
    }),
    prepare: buildRestorePrepareContainerPayload({ jobId: RESTORE_JOB, siteId: SITE_A, ...t, stagingVolumeName, ...db }),
    switch: buildRestoreSwitchContainerPayload({ ...ids, ...t, stagingVolumeName, ...db }),
    files: buildRestoreFilesContainerPayload({ ...ids, ...t }),
    finish: buildRestoreFinishContainerPayload({ ...ids, ...t, ...db }),
    undoFiles: buildRestoreUndoFilesContainerPayload({ ...ids, ...t }),
    undoDb: buildRestoreUndoDbContainerPayload({ ...ids, ...t, stagingVolumeName, ...db }),
    runner,
  };
}

/** restore-own.json */
function restoreOwn(): unknown {
  return buildRestoreOwnContainerPayload({
    jobId: RESTORE_JOB,
    siteId: SITE_A,
    serviceInstanceId: SVC_A,
    siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
  });
}

/** restore-note.json: the exact bytes written for a note with every field set. */
async function restoreNote(): Promise<string> {
  const dir = path.join(await tempDir(), "restores");
  await writeRestoreNote(dir, {
    v: 1,
    jobId: RESTORE_JOB,
    siteId: SITE_A,
    serviceInstanceId: SVC_A,
    stage: "ended",
    state: "failed",
    failure: "restore_prepare_failed",
    endedAt: "2026-11-17T08:00:00.000Z",
    createdVolume: true,
  });
  return readFile(path.join(dir, `${RESTORE_JOB}.json`), "utf8");
}

/** archive.json */
function archive(): unknown {
  return buildArchiveContainerPayload({
    jobId: ARCHIVE_JOB,
    siteId: SITE_A,
    snapshotId: SNAPSHOT_ID,
    target: TARGET,
    executorUser: EXECUTOR_USER,
    archivesHostDir: `${DEFAULT_BACKUP_WORK_DIR}/archives`,
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    ...resticSecrets(`job_bk_zip_${ARCHIVE_JOB}`),
  });
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

describe("site type pins: databases, phpMyAdmin, backups and restore of a WordPress site", () => {
  it("db-shared-container.json is the shared MariaDB container body", async () => {
    await pin("db-shared-container.json", json(dbSharedContainer()));
  });

  it("db-batch-state.sql is the state query and a createDatabase batch", async () => {
    await pin("db-batch-state.sql", dbBatchState());
  });

  it("pma-config.php is the phpMyAdmin config", async () => {
    await pin("pma-config.php", pmaConfig());
  });

  it("pma-container.json is the phpMyAdmin container body", async () => {
    await pin("pma-container.json", json(pmaContainer()));
  });

  it("backup-repo.json is the repository step of a backup job", async () => {
    await pin("backup-repo.json", json(backupRepo()));
  });

  it("backup-dump.json is the dump step of a backup job", async () => {
    await pin("backup-dump.json", json(backupDump()));
  });

  it("backup-upload.json is the upload step and the runner's site volume calls", async () => {
    await pin("backup-upload.json", json(await backupUpload()));
  });

  it("restore-fetch.sh, restore-db.sh and restore-files.sh are the whole restore scripts", async () => {
    await pin("restore-fetch.sh", restoreFetchScript());
    await pin("restore-db.sh", restoreDbScript());
    await pin("restore-files.sh", restoreFilesScript());
  });

  it("restore-steps.json is every restore step and the runner's site volume calls", async () => {
    await pin("restore-steps.json", json(await restoreSteps()));
  });

  it("restore-own.json is the step that gives a new site volume to www-data", async () => {
    await pin("restore-own.json", json(restoreOwn()));
  });

  it("restore-note.json is the exact bytes of a restore note", async () => {
    await pin("restore-note.json", await restoreNote());
  });

  it("archive.json is the archive step", async () => {
    await pin("archive.json", json(archive()));
  });
});
