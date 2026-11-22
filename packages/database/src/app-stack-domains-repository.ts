// Web addresses of a stack (ACME only): add, remove, DNS/certificate state, routing options (0026, ADR-0037). Hostname
// uniqueness across sites, stacks and the panel host comes from the 0025 triggers.
// Lock order of every stack writer: organizations row FOR NO KEY UPDATE → app_templates row FOR SHARE → app_stacks row
// FOR UPDATE → resource_quotas row FOR UPDATE → tls_publish_state → hostname advisory lock (0025 triggers).

import { randomUUID } from "node:crypto";
import { MAX_APP_STACK_DOMAINS, type AppStackDomainPathRoute, type CertStatus, type DomainStatus } from "@hosting-panel/contracts";
import { and, asc, eq, getTableColumns, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appStackDomains, appStacks, domains, hosts } from "./schema.js";
import { assertNoManualCapture } from "./tls-coverage.js";

export type AppStackDomainRow = typeof appStackDomains.$inferSelect;
export type AppStackDomainErrorCode =
  | "NOT_FOUND"
  | "DOMAIN_CONFLICT"
  | "DOMAIN_LIMIT"
  | "VALIDATION_ERROR"
  /** The redirect target is this address or not an address of the stack. */
  | "REDIRECT_TARGET"
  /** The target redirects itself, or another address already redirects to this one. */
  | "REDIRECT_CHAIN"
  /** Protection asked while keeping a password that was never set. */
  | "PASSWORD_REQUIRED";

export class AppStackDomainError extends Error {
  constructor(
    readonly code: AppStackDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppStackDomainError";
  }
}

export interface NewAppStackDomain {
  readonly hostname: string;
  readonly componentKey: string;
  readonly internalPort: number;
}

/** Same text as a site domain add that collides: it never names the other owner. */
const CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** A refused insert (the transaction or its savepoint is already rolled back) as the repository error. */
function mapInsertError(err: unknown): unknown {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const names = (name: string) => e.constraint === name || (typeof e.message === "string" && e.message.includes(name));
    if (e.code === "23505" && (names("uq_app_stack_domains_hostname") || names("uq_panel_hostname_claim"))) {
      return new AppStackDomainError("DOMAIN_CONFLICT", CONFLICT);
    }
    if (e.code === "23503" && names("fk_app_stack_domains_component")) {
      return new AppStackDomainError("VALIDATION_ERROR", "This web address cannot point at that part of the application.");
    }
    current = e.cause;
  }
  return err;
}

async function lockLiveStack(tx: DatabaseExecutor, organizationId: string, stackId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: appStacks.id })
    .from(appStacks)
    .where(and(eq(appStacks.id, stackId), eq(appStacks.organizationId, organizationId), isNull(appStacks.deletedAt)))
    .for("update");
  return row !== undefined;
}

/**
 * Own transaction (a savepoint inside the create transaction). Skips hostnames already on this stack, then refuses
 * DOMAIN_LIMIT, DOMAIN_CONFLICT (a site, the panel host or another stack holds the name) and a manual-certificate
 * capture (`TlsCoverageError` passes through); the triggers close the race with a concurrent writer. Hostnames arrive
 * normalised; the caller has checked componentKey and internalPort against the plan's ingress.
 */
export async function addAppStackDomainsTransactional(
  db: HostingPanelDatabase,
  input: { readonly organizationId: string; readonly stackId: string; readonly entries: readonly NewAppStackDomain[] },
): Promise<AppStackDomainRow[]> {
  try {
    return await db.transaction(async (tx) => {
      if (!(await lockLiveStack(tx, input.organizationId, input.stackId))) {
        throw new AppStackDomainError("NOT_FOUND", "The application was not found.");
      }
      const existing = await tx
        .select({ hostname: appStackDomains.hostname })
        .from(appStackDomains)
        .where(eq(appStackDomains.stackId, input.stackId));
      const fresh = input.entries
        .filter((entry) => !existing.some((row) => row.hostname === entry.hostname))
        .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
      if (fresh.length === 0) return [];
      if (existing.length + fresh.length > MAX_APP_STACK_DOMAINS) {
        throw new AppStackDomainError("DOMAIN_LIMIT", `An application can have at most ${String(MAX_APP_STACK_DOMAINS)} web addresses.`);
      }
      const names = fresh.map((entry) => entry.hostname);
      const [site] = await tx.select({ id: domains.id }).from(domains).where(inArray(sql`lower(${domains.hostname})`, names)).limit(1);
      const [panel] = await tx.select({ id: hosts.id }).from(hosts).where(inArray(sql`lower(${hosts.hostname})`, names)).limit(1);
      const [stack] = await tx
        .select({ id: appStackDomains.id })
        .from(appStackDomains)
        .where(inArray(appStackDomains.hostname, names))
        .limit(1);
      if (site || panel || stack) throw new AppStackDomainError("DOMAIN_CONFLICT", CONFLICT);
      await assertNoManualCapture(tx, input.organizationId, names);
      return tx
        .insert(appStackDomains)
        .values(
          fresh.map((entry) => ({
            id: newId("sdom"),
            stackId: input.stackId,
            organizationId: input.organizationId,
            componentKey: entry.componentKey,
            internalPort: entry.internalPort,
            hostname: entry.hostname,
          })),
        )
        .returning();
    });
  } catch (err) {
    throw mapInsertError(err);
  }
}

/** Stack row FOR UPDATE; false when the stack or the row does not exist. */
export function removeAppStackDomainTransactional(
  db: HostingPanelDatabase,
  input: { readonly organizationId: string; readonly stackId: string; readonly domainId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockLiveStack(tx, input.organizationId, input.stackId))) return false;
    const removed = await tx
      .delete(appStackDomains)
      .where(
        and(
          eq(appStackDomains.id, input.domainId),
          eq(appStackDomains.stackId, input.stackId),
          eq(appStackDomains.organizationId, input.organizationId),
        ),
      )
      .returning({ id: appStackDomains.id });
    return removed.length > 0;
  });
}

/** Every option of one address. A redirecting address takes no protection and no path rule (the contract refuses it). */
export interface AppStackDomainRouting {
  readonly redirectToDomainId: string | null;
  readonly compression: boolean;
  /** `passwordHash` left out keeps the verifier already stored. */
  readonly protection: { readonly username: string; readonly passwordHash?: string } | null;
  readonly pathRoutes: readonly AppStackDomainPathRoute[];
}

/**
 * Replaces the routing options of one address. The stack row is FOR UPDATE, so the redirect rules are checked against
 * every address of the stack as committed: the target is another address of the same stack, it does not redirect, and
 * no address redirects to the one that starts redirecting. The caller has checked the path targets against the plan.
 */
export function updateAppStackDomainRoutingTransactional(
  db: HostingPanelDatabase,
  input: { readonly organizationId: string; readonly stackId: string; readonly domainId: string; readonly routing: AppStackDomainRouting },
): Promise<{ readonly before: AppStackDomainRow; readonly after: AppStackDomainRow }> {
  return db.transaction(async (tx) => {
    if (!(await lockLiveStack(tx, input.organizationId, input.stackId))) {
      throw new AppStackDomainError("NOT_FOUND", "The application was not found.");
    }
    const rows = await listAppStackDomains(tx, { organizationId: input.organizationId, stackId: input.stackId });
    const before = rows.find((row) => row.id === input.domainId);
    if (!before) throw new AppStackDomainError("NOT_FOUND", "The web address was not found.");
    const { redirectToDomainId, compression, protection, pathRoutes } = input.routing;
    if (redirectToDomainId !== null) {
      const target = rows.find((row) => row.id === redirectToDomainId);
      if (!target || target.id === before.id) {
        throw new AppStackDomainError("REDIRECT_TARGET", "Choose another web address of this application.");
      }
      if (target.redirectToDomainId !== null || rows.some((row) => row.redirectToDomainId === before.id)) {
        throw new AppStackDomainError("REDIRECT_CHAIN", "A web address that redirects cannot be the destination of another one.");
      }
    }
    const accessPasswordHash = protection === null ? null : (protection.passwordHash ?? before.accessPasswordHash);
    if (protection !== null && accessPasswordHash === null) {
      throw new AppStackDomainError("PASSWORD_REQUIRED", "Choose a password for this web address.");
    }
    const [after] = await tx
      .update(appStackDomains)
      .set({
        redirectToDomainId,
        compression,
        accessUsername: protection?.username ?? null,
        accessPasswordHash,
        pathRoutes: pathRoutes.map((rule) => ({
          pathPrefix: rule.pathPrefix,
          componentKey: rule.componentKey,
          port: rule.port,
          stripPrefix: rule.stripPrefix,
        })),
        updatedAt: new Date(),
      })
      .where(and(eq(appStackDomains.id, before.id), eq(appStackDomains.stackId, input.stackId)))
      .returning();
    if (!after) throw new AppStackDomainError("NOT_FOUND", "The web address was not found.");
    return { before, after };
  });
}

export function listAppStackDomains(
  db: DatabaseExecutor,
  input: { organizationId: string; stackId: string },
): Promise<AppStackDomainRow[]> {
  return db
    .select()
    .from(appStackDomains)
    .where(and(eq(appStackDomains.stackId, input.stackId), eq(appStackDomains.organizationId, input.organizationId)))
    .orderBy(asc(appStackDomains.hostname));
}

/** For the stack DNS/ACME reconciler: due rows of non-deleted stacks, earliest check first. */
export function listAppStackDomainsDue(db: DatabaseExecutor, input: { now: Date; limit: number }): Promise<AppStackDomainRow[]> {
  return db
    .select(getTableColumns(appStackDomains))
    .from(appStackDomains)
    .innerJoin(appStacks, eq(appStacks.id, appStackDomains.stackId))
    .where(and(isNull(appStacks.deletedAt), lte(appStackDomains.dnsNextCheckAt, input.now)))
    .orderBy(asc(appStackDomains.dnsNextCheckAt))
    .limit(input.limit);
}

/** Compare-and-set of the DNS/cert state (`expect.certStatus` guards a concurrent transition); false when it missed. */
export async function updateAppStackDomainState(
  db: DatabaseExecutor,
  input: {
    readonly domainId: string;
    readonly expect?: { readonly certStatus?: CertStatus };
    readonly set: Partial<
      Pick<
        AppStackDomainRow,
        | "status"
        | "dnsStatus"
        | "dnsObserved"
        | "dnsCheckedAt"
        | "dnsNextCheckAt"
        | "dnsAttempts"
        | "certStatus"
        | "certProblem"
        | "certRequestedAt"
        | "certRetryAt"
        | "certAttempts"
        | "certExpiresAt"
        | "certTrusted"
      >
    >;
  },
): Promise<boolean> {
  const expected = input.expect?.certStatus;
  const updated = await db
    .update(appStackDomains)
    .set({ ...input.set, updatedAt: new Date() })
    .where(and(eq(appStackDomains.id, input.domainId), expected === undefined ? undefined : eq(appStackDomains.certStatus, expected)))
    .returning({ id: appStackDomains.id });
  return updated.length > 0;
}

/** Every stack hostname with its owner, for the manual-TLS coverage checks that must learn stack hosts. */
export function listAppStackHostnames(db: DatabaseExecutor): Promise<
  readonly {
    readonly hostname: string;
    readonly organizationId: string;
    readonly status: DomainStatus;
    readonly certStatus: CertStatus;
  }[]
> {
  return db
    .select({
      hostname: appStackDomains.hostname,
      organizationId: appStackDomains.organizationId,
      status: appStackDomains.status,
      certStatus: appStackDomains.certStatus,
    })
    .from(appStackDomains)
    .orderBy(asc(appStackDomains.hostname));
}
