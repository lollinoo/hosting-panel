import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { DatabaseClient } from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { Phase1DisabledHostAgent } from "@hosting-panel/host-agent-contracts";
import { AuthzContextService } from "./auth/authz-context.service.js";
import { LoginService } from "./auth/login.service.js";
import { OidcService } from "./auth/oidc.service.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { AccountController } from "./controllers/account.controller.js";
import { AdminSitesController } from "./controllers/admin-sites.controller.js";
import { AdminUsersController } from "./controllers/admin-users.controller.js";
import { AdminAuditController } from "./controllers/admin-audit.controller.js";
import { AdminBackupsController } from "./controllers/admin-backups.controller.js";
import { AdminMailRelayController } from "./controllers/admin-mail-relay.controller.js";
import { AuthController } from "./controllers/auth.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { HostsController } from "./controllers/hosts.controller.js";
import { ManagedSitesController } from "./controllers/managed-sites.controller.js";
import { MeController } from "./controllers/me.controller.js";
import { OrganizationsController } from "./controllers/organizations.controller.js";
import { ServiceTemplatesController } from "./controllers/service-templates.controller.js";
import { SiteDomainsController } from "./controllers/site-domains.controller.js";
import { SiteDatabasesController } from "./controllers/site-databases.controller.js";
import { SiteBackupsController } from "./controllers/site-backups.controller.js";
import { SiteFilesController } from "./controllers/site-files.controller.js";
import { SiteSftpController } from "./controllers/site-sftp.controller.js";
import { DriftReconcilerService } from "./runtime/drift-reconciler.service.js";
import { OutboxWorkerService } from "./runtime/outbox-worker.service.js";
import { SiteProvisioner } from "./runtime/site-provisioner.js";
import { BackupSchedulerService } from "./backups/backup-scheduler.service.js";
import { BackupSettingsService } from "./backups/backup-settings.service.js";
import { SiteBackupsApplier } from "./backups/site-backups-applier.js";
import { SiteBackupsService } from "./backups/site-backups.service.js";
import { ManagedSitesService } from "./sites/managed-sites.service.js";
import { SiteDomainsApplier } from "./sites/site-domains-applier.js";
import { SiteFilesApplier } from "./sites/site-files-applier.js";
import { SiteDatabasesService } from "./sites/site-databases.service.js";
import { SiteFilesService } from "./sites/site-files.service.js";
import { SiteSftpService } from "./sites/site-sftp.service.js";
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

export interface AppModuleOptions {
  readonly config: ControlPlaneRuntimeConfig;
  readonly dbClient: DatabaseClient;
  readonly dockerExecutor?: DockerExecutorPort;
  readonly hostAgent?: HostAgentPort;
  readonly dnsLookup?: DnsLookup;
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
        OrganizationsController,
        ManagedSitesController,
        SiteDomainsController,
        SiteFilesController,
        SiteSftpController,
        SiteDatabasesController,
        SiteBackupsController,
        AdminMailRelayController,
        AdminBackupsController,
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
        OidcService,
        AuthzContextService,
        LoginService,
        OutboxWorkerService,
        SiteProvisioner,
        SiteDomainsApplier,
        SiteFilesApplier,
        SiteBackupsApplier,
        ManagedSitesService,
        SiteDomainsService,
        SiteFilesService,
        SiteSftpService,
        SiteDatabasesService,
        SiteBackupsService,
        BackupSettingsService,
        BackupSchedulerService,
        DriftReconcilerService,
        DomainReconcilerService,
        MailRelayService,
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
        BackupSchedulerService,
      ],
    };
  }
}
