import "reflect-metadata";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { HostingProvider } from "@hosting-panel/coolify-adapter";
import type { DatabaseClient } from "@hosting-panel/database";
import { AuthzContextService } from "./auth/authz-context.service.js";
import { OidcService } from "./auth/oidc.service.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { AdminController } from "./controllers/admin.controller.js";
import { ApplicationsController } from "./controllers/applications.controller.js";
import { AuthController } from "./controllers/auth.controller.js";
import { DatabasesController } from "./controllers/databases.controller.js";
import { DomainsController } from "./controllers/domains.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { MeController } from "./controllers/me.controller.js";
import { OperationsController } from "./controllers/operations.controller.js";
import { OrganizationsController } from "./controllers/organizations.controller.js";
import { ServersController } from "./controllers/servers.controller.js";
import { EventsBusService } from "./operations/events-bus.service.js";
import { HealthProbeService } from "./operations/health-probe.service.js";
import { OutboxWorkerService } from "./operations/outbox-worker.service.js";
import { ProviderContextService } from "./providers/provider-context.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  COOLIFY_ADAPTER_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "./tokens.js";
import { SecretVaultService } from "./vault/secret-vault.service.js";

export interface AppModuleRegisterOptions {
  readonly config: ControlPlaneRuntimeConfig;
  readonly dbClient: DatabaseClient;
  readonly coolifyAdapter: HostingProvider;
  readonly secretVault: SecretVaultService;
  readonly healthProbeService: HealthProbeService;
}

@Module({})
export class AppModule {
  public static register(options: AppModuleRegisterOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        MeController,
        OrganizationsController,
        ServersController,
        ApplicationsController,
        DatabasesController,
        DomainsController,
        OperationsController,
        AdminController,
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
          provide: COOLIFY_ADAPTER_TOKEN,
          useValue: options.coolifyAdapter,
        },
        {
          provide: SecretVaultService,
          useValue: options.secretVault,
        },
        {
          provide: HealthProbeService,
          useValue: options.healthProbeService,
        },
        OidcService,
        AuthzContextService,
        ProviderContextService,
        EventsBusService,
        OutboxWorkerService,
        {
          provide: APP_FILTER,
          useClass: ApiExceptionFilter,
        },
      ],
      exports: [
        OidcService,
        AuthzContextService,
        ProviderContextService,
        EventsBusService,
        OutboxWorkerService,
        SecretVaultService,
        HealthProbeService,
      ],
    };
  }
}
