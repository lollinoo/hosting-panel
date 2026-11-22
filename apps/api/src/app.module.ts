import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { DatabaseClient } from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import type { AppFeatureFlags } from "@hosting-panel/contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { Phase1DisabledHostAgent } from "@hosting-panel/host-agent-contracts";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { APP_FEATURE_GATE_TOKEN, resolveAppFeatureGate } from "./app-stacks/app-feature-gate.js";
import { AppStackDomainsService } from "./app-stacks/app-stack-domains.service.js";
import { AppStackObserverService } from "./app-stacks/app-stack-observer.service.js";
import { AppStackRuntime } from "./app-stacks/app-stack-runtime.js";
import { AppStacksService } from "./app-stacks/app-stacks.service.js";
import {
  APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN,
  resolveAppTemplateValidationOptions,
} from "./app-templates/app-template-validation-options.js";
import { AppTemplatesService } from "./app-templates/app-templates.service.js";
import { ComposeImportService } from "./app-templates/compose-import.service.js";
import { AuthzContextService } from "./auth/authz-context.service.js";
import { LoginService } from "./auth/login.service.js";
import { OidcService } from "./auth/oidc.service.js";
import { PasswordResetService } from "./auth/password-reset.service.js";
import { SupportAccessService } from "./auth/support-access.service.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { AccountController } from "./controllers/account.controller.js";
import { AdminSitesController } from "./controllers/admin-sites.controller.js";
import { AdminSiteTemplatesController } from "./controllers/admin-site-templates.controller.js";
import { AdminAppTemplatesController } from "./controllers/admin-app-templates.controller.js";
import { AdminAppStacksController } from "./controllers/admin-app-stacks.controller.js";
import { AppTemplatesController } from "./controllers/app-templates.controller.js";
import { AppStacksController } from "./controllers/app-stacks.controller.js";
import { AppStackDomainsController } from "./controllers/app-stack-domains.controller.js";
import { AdminUsersController } from "./controllers/admin-users.controller.js";
import { AdminAuditController } from "./controllers/admin-audit.controller.js";
import { AdminBackupPoliciesController } from "./controllers/admin-backup-policies.controller.js";
import { AdminBackupTargetsController } from "./controllers/admin-backup-targets.controller.js";
import { AdminBackupsController } from "./controllers/admin-backups.controller.js";
import { AdminMailRelayController } from "./controllers/admin-mail-relay.controller.js";
import { AdminDnsProviderController } from "./controllers/admin-dns-provider.controller.js";
import { AdminHealthController } from "./controllers/admin-health.controller.js";
import { AdminLogsController } from "./controllers/admin-logs.controller.js";
import { AdminSiteTlsCertificatesController } from "./controllers/admin-site-tls-certificates.controller.js";
import { AdminTlsCertificatesController } from "./controllers/admin-tls-certificates.controller.js";
import { SiteTlsCertificatesController } from "./controllers/site-tls-certificates.controller.js";
import { AdminTerminalController } from "./controllers/admin-terminal.controller.js";
import { AdminFirewallController } from "./controllers/admin-firewall.controller.js";
import { AdminHostController } from "./controllers/admin-host.controller.js";
import { AdminUpdatesController } from "./controllers/admin-updates.controller.js";
import { FirewallService } from "./firewall/firewall.service.js";
import { UpdatesService } from "./updates/updates.service.js";
import { AdminHealthService } from "./health/admin-health.service.js";
import { AuthController } from "./controllers/auth.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { HostsController } from "./controllers/hosts.controller.js";
import { ManagedSitesController } from "./controllers/managed-sites.controller.js";
import { MeController } from "./controllers/me.controller.js";
import { OrganizationsController } from "./controllers/organizations.controller.js";
import { PasswordResetController } from "./controllers/password-reset.controller.js";
import { ServiceTemplatesController } from "./controllers/service-templates.controller.js";
import { SiteDomainsController } from "./controllers/site-domains.controller.js";
import { SiteDatabasesController } from "./controllers/site-databases.controller.js";
import { SiteBackupsController } from "./controllers/site-backups.controller.js";
import { SiteFilesController } from "./controllers/site-files.controller.js";
import { SiteSftpController } from "./controllers/site-sftp.controller.js";
import { SiteTypesController } from "./controllers/site-types.controller.js";
import { SiteWordpressController } from "./controllers/site-wordpress.controller.js";
import { SiteWordpressImportController } from "./controllers/site-wordpress-import.controller.js";
import { SupportAccessController } from "./controllers/support-access.controller.js";
import { DriftReconcilerService } from "./runtime/drift-reconciler.service.js";
import { AdminTerminalService } from "./terminal/admin-terminal.service.js";
import { OutboxWorkerService } from "./runtime/outbox-worker.service.js";
import { SiteProvisioner } from "./runtime/site-provisioner.js";
import { BackupPoliciesService } from "./backups/backup-policies.service.js";
import { BackupSchedulerService } from "./backups/backup-scheduler.service.js";
import { BackupSettingsService } from "./backups/backup-settings.service.js";
import { BackupTargetsService } from "./backups/backup-targets.service.js";
import { SiteBackupsApplier } from "./backups/site-backups-applier.js";
import { SiteBackupsService } from "./backups/site-backups.service.js";
import { SiteRestoreService } from "./backups/site-restore.service.js";
import { SiteTemplatesService } from "./site-templates/site-templates.service.js";
import { ManagedSitesService } from "./sites/managed-sites.service.js";
import { LogReadGate } from "./sites/log-read-gate.js";
import { SiteDomainsApplier } from "./sites/site-domains-applier.js";
import { SiteFilesApplier } from "./sites/site-files-applier.js";
import { SiteDatabasesService } from "./sites/site-databases.service.js";
import { SiteFilesService } from "./sites/site-files.service.js";
import { SiteSftpService } from "./sites/site-sftp.service.js";
import { SiteWordpressService } from "./sites/site-wordpress.service.js";
import { SiteWordpressImportService } from "./sites/site-wordpress-import.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  DNS_LOOKUP_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "./tokens.js";
import { createNodeDnsLookup, parseDnsResolvers, type DnsLookup } from "./sites/dns-check.js";
import { DomainReconcilerService } from "./sites/domain-reconciler.service.js";
import { SiteDomainsService } from "./sites/site-domains.service.js";
import { MailRelayService } from "./mail/mail-relay.service.js";
import { DnsProviderService } from "./certificates/dns-provider.service.js";
import { TlsCertificatesService } from "./certificates/tls-certificates.service.js";
import { SiteTlsApplier } from "./certificates/site-tls-applier.js";
import { TlsPublishService } from "./certificates/tls-publish.service.js";
import {
  TLS_VALIDATOR_OPTIONS,
  TlsCertificateValidator,
  TlsValidationGate,
  type TlsValidatorOptions,
} from "./certificates/tls-certificate-validator.js";

export interface AppModuleOptions {
  readonly config: ControlPlaneRuntimeConfig;
  readonly dbClient: DatabaseClient;
  readonly dockerExecutor?: DockerExecutorPort;
  readonly hostAgent?: HostAgentPort;
  readonly dnsLookup?: DnsLookup;
  /** Test seam of the certificate validator (clock, trust anchors); production registers `{}`. */
  readonly tlsValidatorOptions?: TlsValidatorOptions;
  /** Tests only: HCP-SPEC-005 feature switches over those of the runtime backend; production registers the backend's own. */
  readonly appFeatures?: Partial<AppFeatureFlags>;
  /** Tests only: image allowlist rows for HCP-STACK/v1 validation; production registers `{}` (the code allowlist). */
  readonly appTemplateValidation?: AppTemplateValidationOptions;
}

@Module({})
export class AppModule {
  public static register(options: AppModuleOptions): DynamicModule {
    const dockerExecutor = options.dockerExecutor ?? new Phase1DisabledDockerExecutor();
    const hostAgent = options.hostAgent ?? new Phase1DisabledHostAgent();

    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        MeController,
        AccountController,
        HostsController,
        ServiceTemplatesController,
        AdminAuditController,
        AdminUsersController,
        AdminSitesController,
        AdminSiteTemplatesController,
        SiteTypesController,
        OrganizationsController,
        ManagedSitesController,
        SiteDomainsController,
        SiteTlsCertificatesController,
        AdminSiteTlsCertificatesController,
        AdminTlsCertificatesController,
        SiteFilesController,
        SiteSftpController,
        SiteDatabasesController,
        SiteBackupsController,
        SiteWordpressController,
        SiteWordpressImportController,
        AdminMailRelayController,
        AdminDnsProviderController,
        AdminBackupsController,
        AdminBackupTargetsController,
        AdminBackupPoliciesController,
        PasswordResetController,
        SupportAccessController,
        AdminHealthController,
        AdminLogsController,
        AdminTerminalController,
        AdminFirewallController,
        AdminHostController,
        AdminUpdatesController,
        AdminAppTemplatesController,
        AdminAppStacksController,
        AppTemplatesController,
        AppStacksController,
        AppStackDomainsController,
      ],
      providers: [
        {
          provide: CONTROL_PLANE_CONFIG_TOKEN,
          useValue: options.config,
        },
        {
          provide: DATABASE_CLIENT_TOKEN,
          useValue: options.dbClient,
        },
        {
          provide: DOCKER_EXECUTOR_TOKEN,
          useValue: dockerExecutor,
        },
        {
          provide: HOST_AGENT_TOKEN,
          useValue: hostAgent,
        },
        {
          provide: DNS_LOOKUP_TOKEN,
          useValue: options.dnsLookup ?? createNodeDnsLookup(parseDnsResolvers(process.env["HP_DNS_RESOLVERS"])),
        },
        {
          provide: TLS_VALIDATOR_OPTIONS,
          useValue: options.tlsValidatorOptions ?? {},
        },
        {
          provide: APP_FEATURE_GATE_TOKEN,
          useValue: resolveAppFeatureGate(options.config.runtimeBackend, options.appFeatures),
        },
        {
          provide: APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN,
          useValue: resolveAppTemplateValidationOptions(options.appTemplateValidation),
        },
        OidcService,
        AuthzContextService,
        LoginService,
        OutboxWorkerService,
        SiteProvisioner,
        SiteDomainsApplier,
        SiteTlsApplier,
        SiteFilesApplier,
        SiteBackupsApplier,
        ManagedSitesService,
        SiteTemplatesService,
        SiteDomainsService,
        SiteFilesService,
        SiteSftpService,
        SiteDatabasesService,
        SiteBackupsService,
        SiteRestoreService,
        SiteWordpressService,
        SiteWordpressImportService,
        BackupSettingsService,
        BackupTargetsService,
        BackupPoliciesService,
        BackupSchedulerService,
        DriftReconcilerService,
        DomainReconcilerService,
        MailRelayService,
        DnsProviderService,
        TlsCertificateValidator,
        TlsValidationGate,
        TlsCertificatesService,
        TlsPublishService,
        PasswordResetService,
        SupportAccessService,
        AdminHealthService,
        AdminTerminalService,
        FirewallService,
        UpdatesService,
        AppTemplatesService,
        ComposeImportService,
        AppStacksService,
        AppStackDomainsService,
        AppStackRuntime,
        AppStackObserverService,
        // One per app: site and stack log reads share the panel-wide caps (ADR 0026 limit 27).
        { provide: LogReadGate, useValue: new LogReadGate() },
        {
          provide: APP_FILTER,
          useClass: ApiExceptionFilter,
        },
      ],
      exports: [
        CONTROL_PLANE_CONFIG_TOKEN,
        DATABASE_CLIENT_TOKEN,
        DOCKER_EXECUTOR_TOKEN,
        HOST_AGENT_TOKEN,
        OidcService,
        AuthzContextService,
        OutboxWorkerService,
        DriftReconcilerService,
        DomainReconcilerService,
        MailRelayService,
        SiteSftpService,
        SiteDatabasesService,
        SiteBackupsService,
        SiteRestoreService,
        SiteWordpressService,
        BackupSchedulerService,
        AppStackRuntime,
        AppStackObserverService,
        LogReadGate,
      ],
    };
  }
}
