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
import { AuthController } from "./controllers/auth.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { HostsController } from "./controllers/hosts.controller.js";
import { ManagedSitesController } from "./controllers/managed-sites.controller.js";
import { MeController } from "./controllers/me.controller.js";
import { OrganizationsController } from "./controllers/organizations.controller.js";
import { ServiceTemplatesController } from "./controllers/service-templates.controller.js";
import { SiteDomainsController } from "./controllers/site-domains.controller.js";
import { DriftReconcilerService } from "./runtime/drift-reconciler.service.js";
import { OutboxWorkerService } from "./runtime/outbox-worker.service.js";
import { SiteProvisioner } from "./runtime/site-provisioner.js";
import { ManagedSitesService } from "./sites/managed-sites.service.js";
import { SiteDomainsApplier } from "./sites/site-domains-applier.js";
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
        ManagedSitesService,
        SiteDomainsService,
        DriftReconcilerService,
        DomainReconcilerService,
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
      ],
    };
  }
}
