import { RESTIC_IMAGE, SHARED_MARIADB_IMAGE, type BackupTarget } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BACKUP_DUMP_SIZE_FACTOR,
  BACKUP_HOSTNAME,
  BACKUP_JOB_MEMORY_BYTES,
  BACKUP_TMPFS,
  buildAwsSharedCredentials,
  buildBackupDumpContainerPayload,
  buildBackupForgetContainerPayload,
  buildBackupRepoContainerPayload,
  buildBackupStagingVolumePayload,
  buildBackupUploadContainerPayload,
  buildPartialSnapshotDropContainerPayload,
  buildResticRepositoryUrl,
  classifyDumpExitCode,
  classifyResticExitCode,
  classifyResticStderr,
  computeDumpNeedKb,
  parseBackupKeyFileContent,
  parseResticSummary,
  type BackupContainerCreatePayload,
} from "../src/backup-jobs.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "../src/site-types/index.js";

const SECRET_SENTINEL = "sentinel-s3-secret-999";
const ACCESS_KEY_SENTINEL = "AKIASENTINEL999";
const BACKUP_KEY_SENTINEL = "a".repeat(64);
const SNAPSHOT_ID = "b".repeat(64);
const SNAPSHOT_ID_2 = "c".repeat(64);
const JOB_ID = `op_${"d".repeat(32)}`;
const FORGET_JOB_ID = `${JOB_ID}-forget`;
const SITE_ID = "site_1";
const SERVICE_INSTANCE_ID = "svc_1";

const TARGET: BackupTarget = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod/cluster1",
  accessKeyId: ACCESS_KEY_SENTINEL,
  secretAccessKey: SECRET_SENTINEL,
};

const SECRET_BINDS = [
  "/run/secrets/job_bk_1/AWS_SHARED_CREDENTIALS:/run/secrets/AWS_SHARED_CREDENTIALS:ro",
  "/run/secrets/job_bk_1/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro",
] as const;

const SECRET_FILE_ENV = [
  "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/AWS_SHARED_CREDENTIALS",
  "RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD",
] as const;

function assertHardenedSpec(
  payload: BackupContainerCreatePayload,
  expectedUser: string,
  expectedNetwork: string,
): void {
  expect(payload.User).toBe(expectedUser);
  expect(payload.HostConfig.Privileged).toBe(false);
  expect(payload.HostConfig.ReadonlyRootfs).toBe(true);
  expect(payload.HostConfig.CapDrop).toEqual(["ALL"]);
  expect(payload.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
  expect(payload.HostConfig.Memory).toBe(BACKUP_JOB_MEMORY_BYTES);
  expect(payload.HostConfig.MemorySwap).toBe(BACKUP_JOB_MEMORY_BYTES);
  expect(payload.HostConfig.PidsLimit).toBe(128);
  expect(payload.HostConfig.NanoCpus).toBe(1_000_000_000);
  expect(payload.HostConfig.Tmpfs).toEqual({ "/tmp": BACKUP_TMPFS });
  expect(payload.HostConfig.RestartPolicy).toEqual({ Name: "no" });
  expect(payload.HostConfig.NetworkMode).toBe(expectedNetwork);
  expect(payload.HostConfig.LogConfig).toEqual({
    Type: "json-file",
    Config: { "max-size": "1m", "max-file": "1" },
  });
  expect(payload.Labels["io.hostingpanel.managed"]).toBe("true");
  expect(payload.Labels["io.hostingpanel.role"]).toBe("site_job");
}

function assertNoSecretsInPayload(payload: BackupContainerCreatePayload): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(SECRET_SENTINEL);
  expect(serialized).not.toContain(ACCESS_KEY_SENTINEL);
  expect(serialized).not.toContain(BACKUP_KEY_SENTINEL);
}

describe("backup-jobs pure builders", () => {
  it("builds repository URLs with and without prefix", () => {
    expect(buildResticRepositoryUrl(TARGET, { kind: "site", siteId: SITE_ID })).toBe(
      "s3:https://s3.example.com:9000/panel-backups/prod/cluster1/sites/site_1",
    );
    expect(
      buildResticRepositoryUrl({ ...TARGET, prefix: "" }, { kind: "site", siteId: SITE_ID }),
    ).toBe("s3:https://s3.example.com:9000/panel-backups/sites/site_1");
    expect(buildResticRepositoryUrl(TARGET, { kind: "panel" })).toBe(
      "s3:https://s3.example.com:9000/panel-backups/prod/cluster1/panel",
    );
    expect(buildResticRepositoryUrl({ ...TARGET, prefix: "" }, { kind: "panel" })).toBe(
      "s3:https://s3.example.com:9000/panel-backups/panel",
    );
  });

  it("builds exact command lines and hardened specs for repo test, repo job, dump, upload, drop, and forget", () => {
    const testRepo = buildBackupRepoContainerPayload({
      mode: "test",
      testId: "0123456789abcdef",
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
    });
    expect(testRepo.containerName).toBe("hp_bk_test_0123456789abcdef");
    expect(testRepo.payload.Image).toBe(RESTIC_IMAGE);
    expect(testRepo.payload.Hostname).toBe(BACKUP_HOSTNAME);
    expect(testRepo.payload.Cmd).toBeUndefined();
    expect(testRepo.payload.Entrypoint).toEqual([
      "/bin/sh",
      "-c",
      'restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" cat config --no-lock; rc=$?; if [ "$rc" -eq 10 ] && [ "$HP_INIT" = 1 ]; then restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" init; rc=$?; fi; exit $rc',
    ]);
    expect(testRepo.payload.Env).toEqual([
      "GOMAXPROCS=1",
      "NICE=19",
      "RESTIC_CACHE_DIR=/tmp/cache",
      "RESTIC_REPOSITORY=s3:https://s3.example.com:9000/panel-backups/prod/cluster1/panel",
      "HP_REGION=eu-central-1",
      "HP_INIT=1",
      ...SECRET_FILE_ENV,
    ]);
    assertHardenedSpec(testRepo.payload, "33:33", "hp_backup_net");
    assertNoSecretsInPayload(testRepo.payload);

    const jobRepo = buildBackupRepoContainerPayload({
      mode: "job",
      jobId: JOB_ID,
      siteId: SITE_ID,
      init: true,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
    });
    expect(jobRepo.containerName).toBe(`hp_bk_${JOB_ID}_repo`);
    expect(jobRepo.payload.Entrypoint).toEqual([
      "/bin/sh",
      "-c",
      'restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" unlock --remove-all; rc=$?; if [ "$rc" -eq 10 ] && [ "$HP_INIT" = 1 ]; then restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" init; rc=$?; fi; exit $rc',
    ]);
    expect(jobRepo.payload.Labels["io.hostingpanel.site_id"]).toBe(SITE_ID);
    expect(jobRepo.payload.Labels["io.hostingpanel.job_id"]).toBe(JOB_ID);
    assertHardenedSpec(jobRepo.payload, "33:33", "hp_backup_net");
    assertNoSecretsInPayload(jobRepo.payload);

    const forgetRepo = buildBackupRepoContainerPayload({
      mode: "job",
      jobId: FORGET_JOB_ID,
      siteId: SITE_ID,
      init: false,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
    });
    expect(forgetRepo.containerName).toBe(`hp_bk_${FORGET_JOB_ID}_repo`);
    expect(forgetRepo.payload.Env).toContain("HP_INIT=0");

    const stagingVol = buildBackupStagingVolumePayload({ jobId: JOB_ID, siteId: SITE_ID });
    expect(stagingVol).toEqual({
      Name: `hp_bk_${JOB_ID}`,
      Labels: {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.role": "backup_staging",
        "io.hostingpanel.site_id": SITE_ID,
        "io.hostingpanel.job_id": JOB_ID,
      },
    });

    const dump = buildBackupDumpContainerPayload({
      jobId: JOB_ID,
      siteId: SITE_ID,
      databases: [
        { name: "wp_0123456789ab", sizeBytes: 1024 },
        { name: "wp_0123456789ab_extra", sizeBytes: 2048 },
      ],
      executorUser: "1001:1001",
      sharedDbRootKeyFile: "/etc/hosting-panel/mariadb-root.key",
      sharedDbNetworkName: "hp_mariadb_net",
      stagingVolumeName: stagingVol.Name,
    });
    expect(dump.containerName).toBe(`hp_bk_${JOB_ID}_dump`);
    expect(dump.payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(dump.payload.Cmd?.[0]).toBe("sh");
    expect(dump.payload.Cmd?.[1]).toBe("-c");
    expect(dump.payload.Cmd?.[2]).toContain("mariadb-dump -h hp-mariadb -u root");
    expect(dump.payload.Cmd?.[2]).toContain("--single-transaction");
    expect(dump.payload.Cmd?.[2]).toContain("errno 28");
    expect(dump.payload.Cmd?.[2]).toContain("exit 75");
    expect(dump.payload.Cmd?.[2]).toContain("exit 76");
    expect(dump.payload.Env).toEqual([
      "HP_DBS=wp_0123456789ab wp_0123456789ab_extra",
      `HP_NEED_KB=${String(Math.ceil((1024 * BACKUP_DUMP_SIZE_FACTOR + 2048 * BACKUP_DUMP_SIZE_FACTOR + BACKUP_DISK_FREE_FLOOR_BYTES) / 1024))}`,
    ]);
    expect(dump.payload.HostConfig.Binds).toEqual([
      "/etc/hosting-panel/mariadb-root.key:/run/secrets/mariadb-root:ro",
      `hp_bk_${JOB_ID}:/run/mysqld`,
    ]);
    assertHardenedSpec(dump.payload, "1001:1001", "hp_mariadb_net");
    assertNoSecretsInPayload(dump.payload);

    const uploadWithDb = buildBackupUploadContainerPayload({
      siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_INSTANCE_ID,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
      stagingVolumeName: stagingVol.Name,
    });
    expect(uploadWithDb.containerName).toBe(`hp_bk_${JOB_ID}_up`);
    expect(uploadWithDb.payload.Image).toBe(RESTIC_IMAGE);
    expect(uploadWithDb.payload.Hostname).toBe(BACKUP_HOSTNAME);
    expect(uploadWithDb.payload.Entrypoint).toBeUndefined();
    expect(uploadWithDb.payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "backup",
      "-q",
      "--json",
      "--host",
      BACKUP_HOSTNAME,
      "--tag",
      JOB_ID,
      "--exclude",
      "/backup/files/.hp_rs_*",
      "--exclude",
      "/backup/files/.htpanel-import",
      "/backup/files",
      "/backup/databases",
    ]);
    expect(uploadWithDb.payload.HostConfig.Binds).toEqual([
      `hp_vol_${SERVICE_INSTANCE_ID}_html:/backup/files:ro`,
      `hp_bk_${JOB_ID}:/backup/databases:ro`,
      ...SECRET_BINDS,
    ]);
    assertHardenedSpec(uploadWithDb.payload, "33:33", "hp_backup_net");
    assertNoSecretsInPayload(uploadWithDb.payload);

    const uploadNoDb = buildBackupUploadContainerPayload({
      siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: SERVICE_INSTANCE_ID,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
      stagingVolumeName: null,
    });
    expect(uploadNoDb.payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "backup",
      "-q",
      "--json",
      "--host",
      BACKUP_HOSTNAME,
      "--tag",
      JOB_ID,
      "--exclude",
      "/backup/files/.hp_rs_*",
      "--exclude",
      "/backup/files/.htpanel-import",
      "/backup/files",
    ]);
    expect(uploadNoDb.payload.HostConfig.Binds).toEqual([
      `hp_vol_${SERVICE_INSTANCE_ID}_html:/backup/files:ro`,
      ...SECRET_BINDS,
    ]);

    const drop = buildPartialSnapshotDropContainerPayload({
      jobId: JOB_ID,
      siteId: SITE_ID,
      snapshotId: SNAPSHOT_ID,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
    });
    expect(drop.containerName).toBe(`hp_bk_${JOB_ID}_drop`);
    expect(drop.payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "forget",
      SNAPSHOT_ID,
    ]);
    assertHardenedSpec(drop.payload, "33:33", "hp_backup_net");
    assertNoSecretsInPayload(drop.payload);

    const forget = buildBackupForgetContainerPayload({
      jobId: FORGET_JOB_ID,
      siteId: SITE_ID,
      snapshotIds: [SNAPSHOT_ID, SNAPSHOT_ID_2],
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      secretBinds: SECRET_BINDS,
      secretFileEnv: SECRET_FILE_ENV,
    });
    expect(forget.containerName).toBe(`hp_bk_${FORGET_JOB_ID}_forget`);
    expect(forget.payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "forget",
      "--prune",
      SNAPSHOT_ID,
      SNAPSHOT_ID_2,
    ]);
    assertHardenedSpec(forget.payload, "33:33", "hp_backup_net");
    assertNoSecretsInPayload(forget.payload);
  });

  it("maps the full dump and restic exit-code tables", () => {
    expect(classifyDumpExitCode(0)).toBeNull();
    expect(classifyDumpExitCode(75)).toBe("no_space");
    expect(classifyDumpExitCode(76)).toBe("database_dump_failed");
    expect(classifyDumpExitCode(1)).toBe("database_dump_failed");
    expect(classifyDumpExitCode(124)).toBe("timeout");
    expect(classifyDumpExitCode(137)).toBe("other");

    expect(classifyResticExitCode(0)).toBeNull();
    expect(classifyResticExitCode(3)).toBe("files_unreadable");
    expect(classifyResticExitCode(10)).toBe("other");
    expect(classifyResticExitCode(11)).toBe("repository_locked");
    expect(classifyResticExitCode(12)).toBe("wrong_key");
    expect(classifyResticExitCode(124)).toBe("timeout");
    expect(classifyResticExitCode(137)).toBe("other");
    expect(classifyResticExitCode(1, "Fatal: wrong password")).toBe("other");
    expect(classifyResticExitCode(1, "SignatureDoesNotMatch")).toBe("auth_failed");
    expect(classifyResticExitCode(2)).toBe("other");
  });

  it("classifies restic stderr patterns in priority order", () => {
    expect(classifyResticStderr("s3: SignatureDoesNotMatch: bad sig")).toBe("auth_failed");
    expect(classifyResticStderr("s3: InvalidAccessKeyId: unknown")).toBe("auth_failed");
    expect(classifyResticStderr("Stat: AccessDenied")).toBe("write_denied");
    expect(classifyResticStderr("Save: Access Denied")).toBe("write_denied");
    expect(classifyResticStderr("NoSuchBucket: missing")).toBe("bucket_missing");
    expect(classifyResticStderr("The specified Bucket Does Not Exist")).toBe("bucket_missing");
    expect(classifyResticStderr("x509: certificate signed by unknown authority")).toBe("tls_failed");
    expect(classifyResticStderr("tls: first record does not look like a TLS handshake")).toBe(
      "tls_failed",
    );
    expect(classifyResticStderr("dial tcp: lookup bad.host: no such host")).toBe("unreachable");
    expect(classifyResticStderr("dial tcp 10.0.0.1:9000: connect: connection refused")).toBe(
      "unreachable",
    );
    expect(classifyResticStderr("Get ...: i/o timeout")).toBe("unreachable");
    expect(classifyResticStderr("connect: network is unreachable")).toBe("unreachable");
    expect(classifyResticStderr("write /tmp/pack: no space left on device")).toBe("no_space");
    expect(classifyResticStderr("unexpected error")).toBe("other");
  });

  it("parses restic JSON summary lines and rejects missing, malformed, bad id, or NaN fields", () => {
    const validOutput = [
      '{"message_type":"status","percent_done":0.5}',
      JSON.stringify({
        message_type: "summary",
        snapshot_id: SNAPSHOT_ID,
        data_added: 12345,
        total_bytes_processed: 987654,
        files_new: 10,
        files_changed: 3,
        files_unmodified: 100,
        total_duration: 1.2345,
      }),
    ].join("\n");

    expect(parseResticSummary(validOutput)).toEqual({
      snapshotId: SNAPSHOT_ID,
      bytesAdded: 12345,
      totalBytes: 987654,
      fileCount: 113,
      durationMs: 1235,
    });

    expect(parseResticSummary("")).toBeNull();
    expect(parseResticSummary('{"message_type":"status","percent_done":1}')).toBeNull();
    expect(
      parseResticSummary(
        JSON.stringify({
          message_type: "summary",
          snapshot_id: "not-64-hex",
          data_added: 1,
          total_bytes_processed: 1,
          files_new: 1,
          files_changed: 0,
          files_unmodified: 0,
          total_duration: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseResticSummary(
        JSON.stringify({
          message_type: "summary",
          snapshot_id: SNAPSHOT_ID,
          data_added: null,
          total_bytes_processed: 1,
          files_new: 1,
          files_changed: 0,
          files_unmodified: 0,
          total_duration: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseResticSummary(
        '{"message_type":"summary","snapshot_id":"' +
          SNAPSHOT_ID +
          '","data_added":10,"total_bytes_processed":10,"files_new":1,"files_changed":0,"files_unmodified":0,"total_duration":NaN}',
      ),
    ).toBeNull();
    expect(
      parseResticSummary(
        JSON.stringify({
          message_type: "summary",
          snapshot_id: SNAPSHOT_ID,
          data_added: -1,
          total_bytes_processed: 10,
          files_new: 1,
          files_changed: 0,
          files_unmodified: 0,
          total_duration: 1,
        }),
      ),
    ).toBeNull();
  });

  it("computes HP_NEED_KB with E12 size factor and ceiling rounding", () => {
    expect(BACKUP_DUMP_SIZE_FACTOR).toBe(2);
    expect(computeDumpNeedKb([], 1024)).toBe(1);
    expect(computeDumpNeedKb([{ sizeBytes: 1_048_576 }], 0)).toBe(2048);
    expect(computeDumpNeedKb([{ sizeBytes: 1 }], 1024)).toBe(2);
    expect(computeDumpNeedKb([{ sizeBytes: 512 }, { sizeBytes: 512 }], 1024)).toBe(3);
    expect(computeDumpNeedKb([{ sizeBytes: 513 }, { sizeBytes: 512 }], 1024)).toBe(4);
    expect(computeDumpNeedKb([])).toBe(1_048_576);
  });

  it("builds AWS credentials file with backtick-quoted values and rejects unsafe characters", () => {
    expect(buildAwsSharedCredentials(ACCESS_KEY_SENTINEL, SECRET_SENTINEL)).toBe(
      `[default]\naws_access_key_id = \`${ACCESS_KEY_SENTINEL}\`\naws_secret_access_key = \`${SECRET_SENTINEL}\`\n`,
    );
    expect(buildAwsSharedCredentials("ak_#;'\"test", "hpSw#rm;T3st'\"+/=1")).toBe(
      "[default]\naws_access_key_id = `ak_#;'\"test`\naws_secret_access_key = `hpSw#rm;T3st'\"+/=1`\n",
    );

    expect(() => buildAwsSharedCredentials("AKIA\nBAD", SECRET_SENTINEL)).toThrow();
    expect(() => buildAwsSharedCredentials("AKIA`BAD", SECRET_SENTINEL)).toThrow();
    expect(() => buildAwsSharedCredentials(ACCESS_KEY_SENTINEL, "sec\nret")).toThrow();
    expect(() => buildAwsSharedCredentials(ACCESS_KEY_SENTINEL, "sec ret")).toThrow();
    expect(() => buildAwsSharedCredentials(ACCESS_KEY_SENTINEL, "sec\rret")).toThrow();
    expect(() => buildAwsSharedCredentials(ACCESS_KEY_SENTINEL, "sec`ret")).toThrow();
    expect(() => buildAwsSharedCredentials("", SECRET_SENTINEL)).toThrow();
  });

  it("validates and trims backup encryption key contents", () => {
    expect(parseBackupKeyFileContent(`${BACKUP_KEY_SENTINEL}\n`)).toBe(BACKUP_KEY_SENTINEL);
    expect(parseBackupKeyFileContent(`  ${BACKUP_KEY_SENTINEL}  `)).toBe(BACKUP_KEY_SENTINEL);
    expect(parseBackupKeyFileContent("short")).toBeNull();
    expect(parseBackupKeyFileContent("A".repeat(64))).toBeNull();
    expect(parseBackupKeyFileContent("g".repeat(64))).toBeNull();
  });
});
