export { demuxDockerLogStream } from "./docker-logs.js";
export {
  CERTIFIED_SAFE_CAPABILITIES,
  DEFAULT_CPU_MILLI,
  DEFAULT_DOCKER_API_PREFIX,
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SECRETS_ROOT_DIR,
  DockerEngineSocketAdapter,
  FORBIDDEN_CAPABILITIES,
  MANAGED_DOCKER_LABELS,
  buildHardenedContainerCreatePayload,
  detectOutOfBandContainerModification,
  isServiceHttpExposed,
  mapContainerStateToObservedStatus,
  overwriteAndUnlinkSecretFile,
  purgeServiceSecrets,
  resolveDefaultSafeCapabilities,
  validateCertifiedCapabilities,
  validateExecutorServiceSpec,
  writeServiceSecrets,
  type BuildHardenedContainerOptions,
  type CertifiedSafeCapability,
  type DockerContainerInspectPayload,
  type DockerEngineSocketAdapterOptions,
  type ExecutorObservedServiceState,
  type ExpectedManagedServiceMetadata,
  type HardenedContainerCreatePayload,
} from "./docker-engine-adapter.js";

export {
  DEFAULT_SHARED_DB_ADMIN_SUBNET,
  DEFAULT_SHARED_DB_DATA_DIR,
  DEFAULT_SHARED_DB_ROOT_KEY_FILE,
  SHARED_DB_ALIAS,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  buildSharedDatabaseContainerPayload,
  subnetToMariadbHostPattern,
  type SharedDatabaseContainerInput,
  type SharedDatabaseCreatePayload,
} from "./shared-database.js";

export {
  DEFAULT_MAIL_RELAY_SECRET_DIR,
  MAIL_RELAY_NETWORK_NAME,
  MAIL_RELAY_SASL_FILE,
  MAIL_RELAY_SPOOL_VOLUME,
  buildMailRelayContainerPayload,
  buildMailRelaySaslLine,
  type MailRelayContainerInput,
} from "./mail-relay.js";

export {
  DB_DROP_SCRIPT,
  DB_PROVISION_SCRIPT,
  DEFAULT_SITE_JOB_TIMEOUT_MS,
  HTACCESS_PANEL,
  HTACCESS_WORDPRESS,
  MARIADB_OWN_MAX_USER_CONNECTIONS,
  SITE_JOB_ROLE,
  WORDPRESS_INSTALL_SCRIPT,
  WORDPRESS_SET_URL_SCRIPT,
  assertValidSiteJobRequest,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
  type SiteJobContext,
  type SiteJobCreatePayload,
} from "./site-jobs.js";

export {
  InMemoryDockerSimulatorAdapter,
  type InMemoryDockerSimulatorAdapterOptions,
  type OutOfBandMutationInput,
  type SimulatedMailDelivery,
  type SimulatedMailRelayState,
} from "./simulator-adapter.js";

export {
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_INGRESS_ROOT_DIR,
  DEFAULT_TRAEFIK_IMAGE,
  DEFAULT_INGRESS_HTTPS_PORT,
  ExecutorCodedError,
  INGRESS_BRIDGE_NETWORK_NAME,
  PANEL_DYNAMIC_FILE_NAME,
  INGRESS_PROXY_CONTAINER_NAME,
  TraefikIngressFileManager,
  acmeStorageFileName,
  assertContainedPath,
  assertSafeDomain,
  assertSafeIdentifier,
  buildIngressProxyContainerPayload,
  buildPanelDynamicYaml,
  buildSiteDynamicTraefikYaml,
  buildTraefikStaticYaml,
  getManagedVolumeName,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  sanitizeTraefikKey,
  siteRouteOptions,
  writeFileAtomically,
  writeFileIfChanged,
  type DockerIngressProxyCreatePayload,
  type IngressProxyContainerConfigInput,
  type PanelDnsLookup,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
  type SiteRouteOptions,
} from "./traefik-config.js";

export {
  DEFAULT_EXECUTOR_SOCKET_MODE,
  DEFAULT_EXECUTOR_SOCKET_PATH,
  DEFAULT_EXECUTOR_VERSION,
  DockerExecutorIpcServer,
  createDockerExecutorIpcServer,
  type BoundExecutorEndpoint,
  type DockerExecutorIpcServerOptions,
  type IngressCapableDockerExecutor,
  type IpcTransportMode,
} from "./server.js";

export {
  BACKUPS_TEST_TIMEOUT_MS,
  BACKUPS_TIMEOUT_MS,
  ExecutorIpcClientError,
  SFTP_APPLY_TIMEOUT_MS,
  SFTP_STATUS_TIMEOUT_MS,
  SITE_DATABASES_SIGNON_TIMEOUT_MS,
  SITE_DATABASES_TIMEOUT_MS,
  SITE_FILES_ARCHIVE_TIMEOUT_MS,
  SITE_FILES_DELETE_TIMEOUT_MS,
  SITE_FILES_TIMEOUT_MS,
  SignedDockerExecutorIpcClient,
  type SignedDockerExecutorIpcClientOptions,
} from "./client.js";

export {
  bootstrapDockerExecutorDaemon,
  loadExecutorVerificationKeyringFromEnv,
  parsePanelIngressConfigFromEnv,
  parsePhpMyAdminPortFromEnv,
  parseSftpPortFromEnv,
} from "./main.js";

export {
  DEFAULT_SITE_MAIL_DIR,
  SITE_MAIL_FILES,
  ensureSiteMailFiles,
  siteMailBinds,
} from "./site-mail.js";

export {
  runDockerExec,
  startDockerExec,
  type DockerExecResult,
  type DockerExecSpec,
  type DockerExecTarget,
  type DockerJsonRequest,
} from "./docker-exec.js";

export {
  SITE_FILES_ROLE,
  SiteFilesHelpers,
  buildSiteFilesHelperPayload,
  parseSiteFilesRequest,
  siteFilesHelperName,
} from "./site-files-helper.js";

export {
  DEFAULT_SITE_FILES_DIR,
  SITE_FILES_PROGRAM,
  ensureSiteFilesProgram,
} from "./site-files-program.js";

export { SimulatedSiteFiles, type SimSeedEntry } from "./simulator-files.js";

export {
  DEFAULT_SFTP_STATE_DIR,
  SFTP_CONFIG_SHA256_LABEL,
  SFTP_CONTAINER_NAME,
  SFTP_INTERNAL_PORT,
  SFTP_NETWORK_NAME,
  SFTP_VOLUME_PREFIX,
  assertSftpStateDir,
  buildSftpContainerPayload,
  ensureSftpStateFiles,
  generateEd25519HostKey,
  hasSftpHostKey,
  readSftpHostKeyFingerprint,
  readSftpState,
  renderSftpSshdConfig,
  renderSftpUserFiles,
  sshFingerprint,
  writeSftpState,
  type EnsureSftpStateFilesOptions,
  type SftpContainerCreatePayload,
  type SftpContainerInput,
  type SftpContainerSiteMount,
  type SftpRenderedUserFiles,
  type SftpStateFilesResult,
} from "./sftp-platform.js";

export {
  MARIADB_EXTRA_MAX_USER_CONNECTIONS,
  MARIADB_SIGNON_MAX_USER_CONNECTIONS,
  SiteDatabasesRunner,
  buildSiteDatabasesBatch,
  buildStateQuery,
  checkSiteDatabasesOp,
  mapMariadbError,
  mariadbRootExec,
  parseSiteDatabasesRequest,
  parseSiteDatabasesState,
  toListResult,
  type ExecResult,
  type SiteDatabasesDeps,
  type SiteDatabasesState,
} from "./site-databases.js";

export { SimulatedSiteDatabases } from "./simulator-databases.js";

export { SimulatedBackups } from "./simulator-backups.js";

export {
  BackupRunner,
  DEFAULT_BACKUP_KEY_FILE,
  DEFAULT_BACKUP_NETWORK_NAME,
  type BackupRunnerDeps,
  type DockerRequest,
} from "./backup-runner.js";

export {
  S3RequestError,
  S3_PROBE_BUDGET_MS,
  S3_PROBE_REQUEST_TIMEOUT_MS,
  probeS3,
  s3Request,
  signV4,
} from "./s3-probe.js";

export {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BACKUP_DUMP_SCRIPT,
  BACKUP_DUMP_TIMEOUT_MS,
  BACKUP_FORGET_TIMEOUT_MS,
  BACKUP_HOSTNAME,
  BACKUP_JOB_MEMORY_BYTES,
  BACKUP_MAX_RUNNING_JOBS,
  BACKUP_REPO_JOB_SCRIPT,
  BACKUP_REPO_STEP_TIMEOUT_MS,
  BACKUP_REPO_TEST_SCRIPT,
  BACKUP_RESTIC_CACHE_DIR,
  BACKUP_RESTIC_USER,
  BACKUP_STAGING_VOLUME_ROLE,
  BACKUP_STATUS_MAX,
  BACKUP_STATUS_TTL_MS,
  BACKUP_TEST_BUDGET_MS,
  BACKUP_TMPFS,
  BACKUP_UPLOAD_TIMEOUT_MS,
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
  type BackupContainerSpec,
  type BackupResticRepoKind,
  type BackupSnapshotSummary,
} from "./backup-jobs.js";

export {
  DEFAULT_PHPMYADMIN_CONFIG_DIR,
  PHPMYADMIN_CONFIG_SHA256_LABEL,
  PHPMYADMIN_CONTAINER_NAME,
  PHPMYADMIN_NETWORK_NAME,
  buildPhpMyAdminContainerPayload,
  ensurePhpMyAdminContainer,
  renderPhpMyAdminConfig,
  type PhpMyAdminDeps,
} from "./phpmyadmin-platform.js";
