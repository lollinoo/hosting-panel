import { Inject, Injectable } from "@nestjs/common";
import type { AuthorizedProviderContext } from "@hosting-panel/coolify-adapter";
import {
  and,
  eq,
  providerConnections,
  providerInstances,
  type DatabaseClient,
  type ProviderConnectionRow,
  type ProviderInstanceRow,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { SecretVaultService } from "../vault/secret-vault.service.js";

export interface ResolvedProviderConnectionBundle {
  readonly connection: ProviderConnectionRow;
  readonly instance: ProviderInstanceRow;
  readonly context: AuthorizedProviderContext;
}

@Injectable()
export class ProviderContextService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(SecretVaultService) private readonly secretVault: SecretVaultService,
  ) {}

  public async resolveForConnection(
    organizationId: string,
    connectionId: string,
    requestId: string,
  ): Promise<ResolvedProviderConnectionBundle> {
    const [row] = await this.dbClient.db
      .select({
        connection: providerConnections,
        instance: providerInstances,
      })
      .from(providerConnections)
      .innerJoin(
        providerInstances,
        eq(providerConnections.providerInstanceId, providerInstances.id),
      )
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new ControlPlaneError(
        "COOLIFY_UNAVAILABLE",
        "Organization provider connection is not configured.",
      );
    }

    const tokens = this.secretVault.resolveProviderTokenSet({
      secretRefRead: row.connection.secretRefRead,
      secretRefWrite: row.connection.secretRefWrite,
      secretRefDeploy: row.connection.secretRefDeploy,
    });

    return {
      connection: row.connection,
      instance: row.instance,
      context: {
        connectionId: row.connection.id,
        baseUrl: row.instance.baseUrl,
        teamId: row.connection.teamId,
        tokens,
        requestId,
      },
    };
  }

  public async resolvePrimaryForOrganization(
    organizationId: string,
    requestId: string,
  ): Promise<ResolvedProviderConnectionBundle | null> {
    const [row] = await this.dbClient.db
      .select({
        connection: providerConnections,
        instance: providerInstances,
      })
      .from(providerConnections)
      .innerJoin(
        providerInstances,
        eq(providerConnections.providerInstanceId, providerInstances.id),
      )
      .where(eq(providerConnections.organizationId, organizationId))
      .limit(1);

    if (!row) {
      return null;
    }

    const tokens = this.secretVault.resolveProviderTokenSet({
      secretRefRead: row.connection.secretRefRead,
      secretRefWrite: row.connection.secretRefWrite,
      secretRefDeploy: row.connection.secretRefDeploy,
    });

    return {
      connection: row.connection,
      instance: row.instance,
      context: {
        connectionId: row.connection.id,
        baseUrl: row.instance.baseUrl,
        teamId: row.connection.teamId,
        tokens,
        requestId,
      },
    };
  }

  public async resolveForAdminTarget(
    idOrInstanceId: string,
    requestId: string,
  ): Promise<ResolvedProviderConnectionBundle> {
    const [byInstance] = await this.dbClient.db
      .select()
      .from(providerInstances)
      .where(eq(providerInstances.id, idOrInstanceId))
      .limit(1);

    if (byInstance) {
      const [boundConn] = await this.dbClient.db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.providerInstanceId, byInstance.id))
        .limit(1);

      if (!boundConn) {
        throw new ControlPlaneError(
          "COOLIFY_UNAVAILABLE",
          "Provider instance has no bound organization connection for testing.",
        );
      }

      const tokens = this.secretVault.resolveProviderTokenSet({
        secretRefRead: boundConn.secretRefRead,
        secretRefWrite: boundConn.secretRefWrite,
        secretRefDeploy: boundConn.secretRefDeploy,
      });

      return {
        connection: boundConn,
        instance: byInstance,
        context: {
          connectionId: boundConn.id,
          baseUrl: byInstance.baseUrl,
          teamId: boundConn.teamId,
          tokens,
          requestId,
        },
      };
    }

    const [byConn] = await this.dbClient.db
      .select({
        connection: providerConnections,
        instance: providerInstances,
      })
      .from(providerConnections)
      .innerJoin(
        providerInstances,
        eq(providerConnections.providerInstanceId, providerInstances.id),
      )
      .where(eq(providerConnections.id, idOrInstanceId))
      .limit(1);

    if (!byConn) {
      throw new ControlPlaneError("NOT_FOUND", "Provider connection was not found.");
    }

    const tokens = this.secretVault.resolveProviderTokenSet({
      secretRefRead: byConn.connection.secretRefRead,
      secretRefWrite: byConn.connection.secretRefWrite,
      secretRefDeploy: byConn.connection.secretRefDeploy,
    });

    return {
      connection: byConn.connection,
      instance: byConn.instance,
      context: {
        connectionId: byConn.connection.id,
        baseUrl: byConn.instance.baseUrl,
        teamId: byConn.connection.teamId,
        tokens,
        requestId,
      },
    };
  }
}
