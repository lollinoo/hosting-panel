import { and, asc, eq, ne } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { organizations, serviceInstances, siteSftpUsers } from "./schema.js";

export interface SiteSftpUserRow {
  id: string;
  organizationId: string;
  siteId: string;
  username: string;
  createdAt: Date;
  passwordChangedAt: Date;
}

export interface SiteSftpUserSecretRow extends SiteSftpUserRow {
  passwordHash: string;
}

export interface SftpDesiredUser {
  username: string;
  passwordHash: string;
  siteId: string;
  serviceInstanceId: string;
}

type SiteKey = {
  organizationId: string;
  siteId: string;
};

const publicUserColumns = {
  id: siteSftpUsers.id,
  organizationId: siteSftpUsers.organizationId,
  siteId: siteSftpUsers.siteId,
  username: siteSftpUsers.username,
  createdAt: siteSftpUsers.createdAt,
  passwordChangedAt: siteSftpUsers.passwordChangedAt,
};

function siteScopeWhere(k: SiteKey) {
  return and(eq(siteSftpUsers.organizationId, k.organizationId), eq(siteSftpUsers.siteId, k.siteId));
}

function userScopeWhere(k: SiteKey & { userId: string }) {
  return and(siteScopeWhere(k), eq(siteSftpUsers.id, k.userId));
}

export async function listSiteSftpUsers(db: DatabaseExecutor, k: SiteKey): Promise<SiteSftpUserRow[]> {
  return db
    .select(publicUserColumns)
    .from(siteSftpUsers)
    .where(siteScopeWhere(k))
    .orderBy(asc(siteSftpUsers.username));
}

export async function getSiteSftpUser(
  db: DatabaseExecutor,
  k: SiteKey & { userId: string },
): Promise<SiteSftpUserSecretRow | null> {
  const rows = await db
    .select({
      ...publicUserColumns,
      passwordHash: siteSftpUsers.passwordHash,
    })
    .from(siteSftpUsers)
    .where(userScopeWhere(k))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSiteSftpUser(
  db: DatabaseExecutor,
  row: SiteKey & {
    id: string;
    username: string;
    passwordHash: string;
    createdAt?: Date;
    passwordChangedAt?: Date;
  },
): Promise<SiteSftpUserRow> {
  const [inserted] = await db
    .insert(siteSftpUsers)
    .values({
      id: row.id,
      organizationId: row.organizationId,
      siteId: row.siteId,
      username: row.username,
      passwordHash: row.passwordHash,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      ...(row.passwordChangedAt ? { passwordChangedAt: row.passwordChangedAt } : {}),
    })
    .returning(publicUserColumns);
  if (!inserted) {
    throw new Error(`Failed to insert site SFTP user ${row.id}`);
  }
  return inserted;
}

export async function updateSiteSftpUserPassword(
  db: DatabaseExecutor,
  k: SiteKey & { userId: string; passwordHash: string; passwordChangedAt: Date },
): Promise<boolean> {
  const updated = await db
    .update(siteSftpUsers)
    .set({
      passwordHash: k.passwordHash,
      passwordChangedAt: k.passwordChangedAt,
    })
    .where(userScopeWhere(k))
    .returning({ id: siteSftpUsers.id });
  return updated.length > 0;
}

export async function deleteSiteSftpUser(db: DatabaseExecutor, k: SiteKey & { userId: string }): Promise<boolean> {
  const deleted = await db
    .delete(siteSftpUsers)
    .where(userScopeWhere(k))
    .returning({ id: siteSftpUsers.id });
  return deleted.length > 0;
}

export async function deleteSiteSftpUsersForSite(db: DatabaseExecutor, k: SiteKey): Promise<number> {
  const deleted = await db
    .delete(siteSftpUsers)
    .where(siteScopeWhere(k))
    .returning({ id: siteSftpUsers.id });
  return deleted.length;
}

/**
 * Resolves desired SFTP OS accounts for active organizations joined to each site's earliest
 * service instance `(created_at ASC, id ASC)`, skipping sites without service instances.
 */
export async function listSftpDesiredState(
  db: DatabaseExecutor,
  opts?: { excludeSiteId?: string },
): Promise<SftpDesiredUser[]> {
  const firstServiceSq = db
    .selectDistinctOn([serviceInstances.siteId], {
      siteId: serviceInstances.siteId,
      serviceInstanceId: serviceInstances.id,
    })
    .from(serviceInstances)
    .orderBy(asc(serviceInstances.siteId), asc(serviceInstances.createdAt), asc(serviceInstances.id))
    .as("first_service");

  return db
    .select({
      username: siteSftpUsers.username,
      passwordHash: siteSftpUsers.passwordHash,
      siteId: siteSftpUsers.siteId,
      serviceInstanceId: firstServiceSq.serviceInstanceId,
    })
    .from(siteSftpUsers)
    .innerJoin(firstServiceSq, eq(siteSftpUsers.siteId, firstServiceSq.siteId))
    .innerJoin(organizations, eq(siteSftpUsers.organizationId, organizations.id))
    .where(
      opts?.excludeSiteId
        ? and(eq(organizations.status, "active"), ne(siteSftpUsers.siteId, opts.excludeSiteId))
        : eq(organizations.status, "active"),
    )
    .orderBy(asc(siteSftpUsers.username));
}
