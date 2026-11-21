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
  WORDPRESS_INSPECT_SCRIPT,
  WORDPRESS_INSTALL_SCRIPT,
  WORDPRESS_RESET_PASSWORD_SCRIPT,
  WORDPRESS_SET_URL_SCRIPT,
  WORDPRESS_SETTLE_SCRIPT,
  WORDPRESS_UPDATE_SCRIPT,
  assertValidSiteJobRequest,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
  parseWordpressJobResult,
  siteJobTimeoutMs,
  type SiteJobContext,
  type SiteJobCreatePayload,
  type SiteJobSpec,
} from "./site-jobs.js";

export {
  InMemoryDockerSimulatorAdapter,
  SIMULATED_WORDPRESS_STATE,
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
  DEFAULT_MANUAL_CERT_MOUNT_DIR,
  getManagedVolumeName,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  sanitizeTraefikKey,
  siteRouteOptions,
  writeFileAtomically,
  writeFileIfChanged,
  MANUAL_CERTIFICATES_FILE_NAME,
  MANUAL_CERTS_DIR_NAME,
  MANUAL_TLS_STATE_FILE,
  type DockerIngressProxyCreatePayload,
  type IngressProxyContainerConfigInput,
  type PanelDnsLookup,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
  type SiteRouteOptions,
} from "./traefik-config.js";

export {
  ACME_DNS_SECRET_MOUNT,
  DEFAULT_ACME_DNS_SECRET_DIR,
  DNS_PROVIDER_STATE_FILE,
  DNS_RESOLVER_NAME,
  assertDnsProviderApplyRequest,
  dnsProviderFileEnv,
  dnsProviderState,
  parseDnsProviderState,
  type DnsProviderState,
} from "./dns-provider.js";

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
  MANUAL_TLS_PROBE_TIMEOUT_MS,
  MANUAL_TLS_PUBLISH_EVICT_TIMEOUT_MS,
  MANUAL_TLS_PUBLISH_TIMEOUT_MS,
  MANUAL_TLS_PUT_TIMEOUT_MS,
  MANUAL_TLS_QUICK_TIMEOUT_MS,
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
  buildSiteFilesProgram,
  writeSiteFilesProgram,
} from "./site-files-program.js";
export {
  EXECUTOR_SITE_TYPES,
  SITE_FILES_PROGRAM,
  WORDPRESS_EXECUTOR_SITE_TYPE,
  ensureSiteFilesProgram,
  resolveExecutorSiteType,
  type ExecutorSiteType,
} from "./site-types/index.js";

export { SimulatedSiteFiles, makeDir, type SimSeedEntry } from "./simulator-files.js";
export { resolveSimulatorSiteType, type SimulatorSiteType, type SimulatorSiteOps } from "./simulator-site-types.js";

export type { TerminalLimits } from "./terminal-sessions.js";

export {
  TERMINAL_CONSOLE_SIZE,
  TERMINAL_END_SETTLE_MS,
  TERMINAL_KILL_SCRIPT,
  TERMINAL_KILL_TIMEOUT_MS,
  reapTerminalShells,
  startDockerTerminal,
} from "./terminal-docker.js";

export {
  PANEL_RESTART_ENGINE_TIMEOUT_MS,
  PANEL_RESTART_STOP_SECONDS,
  restartContainerByName,
} from "./panel-restart.js";

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
  DEFAULT_BACKUP_WORK_DIR,
  DEFAULT_PANEL_DUMP_DIR,
  type BackupRunnerDeps,
  type DockerRequest,
  type PanelFetchProblem,
  type PanelFetchResult,
} from "./backup-runner.js";

export {
  PANEL_DUMP_MAGIC,
  PANEL_FETCH_EXIT_NO_COPY,
  PANEL_FETCH_EXIT_NO_SPACE,
  PANEL_FETCH_ID_PATTERN,
  PANEL_FETCH_SCRIPT,
  PANEL_KEEP_LAST,
  PANEL_KEY_FILE_PATTERN,
  PANEL_LANE,
  PANEL_MASTER_KEY_SECRET,
  PANEL_REPO_DUMP_PATH,
  PANEL_REPO_KEY_PATH,
  PANEL_RESTORE_DUMP_NAME,
  PANEL_RESTORE_KEY_NAME,
  buildPanelDropContainerPayload,
  buildPanelFetchContainerPayload,
  buildPanelJobLabels,
  buildPanelKeepContainerPayload,
  buildPanelRepoContainerPayload,
  buildPanelUploadContainerPayload,
  type PanelBindMount,
  type PanelContainerCreatePayload,
  type PanelContainerSpec,
} from "./panel-jobs.js";

export {
  ARCHIVE_EXIT_CODES,
  BACKUP_ARCHIVE_TIMEOUT_MS,
  BACKUP_ARCHIVE_TTL_MS,
  BACKUP_RESTORE_FETCH_TIMEOUT_MS,
  BACKUP_RESTORE_FILES_TIMEOUT_MS,
  BACKUP_RESTORE_FINISH_TIMEOUT_MS,
  BACKUP_RESTORE_LOCK_WAIT_S,
  BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
  BACKUP_RESTORE_SETTLE_START_MS,
  BACKUP_RESTORE_SWITCH_TIMEOUT_MS,
  BACKUP_RESTORE_UNDO_TIMEOUT_MS,
  RESTORE_EXIT_DB_IMPORT_FAILED,
  RESTORE_EXIT_DB_UNREACHABLE,
  RESTORE_EXIT_DEFINER_MISSING,
  RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF,
  RESTORE_EXIT_FILES_PLAN_EXISTS,
  RESTORE_EXIT_FINISH_CLEANUP_FAILED,
  RESTORE_EXIT_GATE_REMOVE_FAILED,
  RESTORE_EXIT_INVALID_DB_NAME,
  RESTORE_EXIT_INVALID_FILENAMES,
  RESTORE_EXIT_NO_SPACE,
  RESTORE_EXIT_TIMEOUT,
  RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY,
  RESTORE_FETCH_EXIT_CODES,
  RESTORE_FILES_EXIT_CODES,
  RESTORE_FINISH_EXIT_CODES,
  RESTORE_JOB_ID_PATTERN,
  RESTORE_PREPARE_EXIT_CODES,
  RESTORE_SNAPSHOT_ID_PATTERN,
  RESTORE_STAGES,
  RESTORE_SWITCH_EXIT_CODES,
  RESTORE_UNDO_EXIT_CODES,
  RestoreNoteSchema,
  buildRestoreOwnContainerPayload,
  readRestoreNote,
  type RestoreNote,
  type RestoreStage,
} from "./restore-jobs.js";
export { RESTORE_MAINTENANCE_FILE_CONTENT } from "./site-types/wordpress-restore.js";

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

export {
  MANUAL_TLS_FULLCHAIN_FILE,
  MANUAL_TLS_KEY_FILE,
  MANUAL_TLS_MANIFEST_HEADER,
  ManualTlsStore,
  ManualTlsStoreError,
  normaliseEntries,
  type ManualTlsEntry,
  type ManualTlsState,
  type ManualTlsStoreDeps,
  type ManualTlsStoreErrorReason,
  type ManualTlsVersionInfo,
} from "./manual-tls-store.js";

export {
  PROBE_CONNECT_TIMEOUT_MS,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  probeServedFingerprint,
  waitForServed,
  type ProbeEndpoint,
  type ServedExpectation,
  type ServedReport,
  type WaitForServedOptions,
} from "./manual-tls-probe.js";

export {
  AcmeStoreError,
  evictAcmeEntries,
  readAcmeStoreEntries,
  type AcmeEviction,
  type AcmeStoreEntries,
  type AcmeStoreEntry,
} from "./acme-status.js";
