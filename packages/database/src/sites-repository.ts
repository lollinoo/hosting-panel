import {
  DEFAULT_PHP_VERSION,
  resolveWordpressImage,
  type ErrorCode,
  type OperationKind,
} from "@hosting-panel/contracts";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { encryptedSecrets, operations, resourceGrants, serviceInstances, serviceTemplates, siteDatabases, sites } from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

export const WORDPRESS_TEMPLATE_ID = "tpl_site_wordpress";

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "NOT_FOUND" satisfies ErrorCode });
}

export async function ensureWordpressTemplate(db: DatabaseExecutor): Promise<void> {
  const defaultImage = resolveWordpressImage(DEFAULT_PHP_VERSION);
  await db
    .insert(serviceTemplates)
    .values({
      id: WORDPRESS_TEMPLATE_ID,
      name: "WordPress",
      slug: "site-wordpress",
      category: "site",
      defaultImage,
      defaultPort: 80,
      approvedForDedicated: true,
    })
    .onConflictDoUpdate({ target: serviceTemplates.id, set: { defaultImage, updatedAt: new Date() } });
}

export type SiteDatabaseRow = typeof siteDatabases.$inferInsert;

export async function insertSiteDatabase(tx: DatabaseExecutor, row: SiteDatabaseRow) {
  const [inserted] = await tx.insert(siteDatabases).values(row).returning();
  return inserted!;
}

export function listSiteDatabases(
  db: DatabaseExecutor,
  input: { organizationId: string; siteId: string },
) {
  return db
    .select()
    .from(siteDatabases)
    .where(and(eq(siteDatabases.organizationId, input.organizationId), eq(siteDatabases.siteId, input.siteId)));
}

/** By resource id only, so it still works right after an ownership move. */
export async function latestSiteOperation(
  db: DatabaseExecutor,
  input: { siteId: string; kind: OperationKind },
) {
  const [row] = await db
    .select()
    .from(operations)
    .where(and(eq(operations.resourceId, input.siteId), eq(operations.kind, input.kind)))
    .orderBy(desc(operations.submittedAt), desc(operations.id))
    .limit(1);
  return row ?? null;
}

export interface MoveSiteInput {
  readonly siteId: string;
  readonly fromOrganizationId: string;
  readonly toOrganizationId: string;
  readonly toHostAllocationId: string;
  readonly masterKey: string;
}

/**
 * Moves a site and everything it owns (children via ON UPDATE CASCADE, secrets re-encrypted
 * under the new AAD, all its operations including a running one) in one transaction.
 */
export async function moveSiteToOrganizationTransactional(
  db: HostingPanelDatabase,
  input: MoveSiteInput,
): Promise<void> {
  const { siteId, fromOrganizationId: from, toOrganizationId: to, masterKey } = input;
  await db.transaction(async (tx) => {
    const [site] = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, from)))
      .for("update");
    if (!site) throw notFound(`Site '${siteId}' not found in organization '${from}'`);

    const secrets = await tx.select().from(encryptedSecrets).where(eq(encryptedSecrets.siteId, siteId));
    const plain = secrets.map((row) => ({
      id: row.id,
      secretKey: row.secretKey,
      value: decryptSecretAesGcm({
        ciphertextBase64: row.ciphertextBase64,
        ivBase64: row.ivBase64,
        authTagBase64: row.authTagBase64,
        masterKey,
        organizationId: from,
        siteId,
        secretKey: row.secretKey,
      }),
    }));

    await tx
      .update(sites)
      .set({ organizationId: to, hostAllocationId: input.toHostAllocationId, updatedAt: new Date() })
      .where(eq(sites.id, siteId));

    for (const secret of plain) {
      const env = encryptSecretAesGcm({
        plaintext: secret.value,
        masterKey,
        organizationId: to,
        siteId,
        secretKey: secret.secretKey,
      });
      await tx
        .update(encryptedSecrets)
        .set({
          ciphertextBase64: env.ciphertextBase64,
          ivBase64: env.ivBase64,
          authTagBase64: env.authTagBase64,
          keyVersion: env.keyVersion,
          updatedAt: new Date(),
        })
        .where(eq(encryptedSecrets.id, secret.id));
    }

    const serviceIds = (
      await tx.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId))
    ).map((s) => s.id);
    // Grants belong to the old organization's users: drop them, do not move them.
    await tx.delete(resourceGrants).where(inArray(resourceGrants.resourceId, [siteId, ...serviceIds]));
    await tx
      .update(operations)
      .set({ organizationId: to })
      .where(
        serviceIds.length > 0
          ? or(eq(operations.resourceId, siteId), inArray(operations.resourceId, serviceIds))
          : eq(operations.resourceId, siteId),
      );
  });
}

