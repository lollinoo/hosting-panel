// Private links between a database and an application of the same customer (ADR-0039): the rows only. What Docker
// holds is made equal to them by the executor's syncAppStackLinks, and its answer comes back through settleAppStackLinks.
// A link write locks two app_stacks rows, in id order, and nothing else: no other writer holds two of them, and none
// takes a lock that comes before an app_stacks row while it holds one.

import {
  APP_STACK_BUSY_STATUSES,
  MAX_APP_STACK_LINKS_PER_APPLICATION,
  MAX_APP_STACK_LINKS_PER_DATABASE,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { and, asc, eq, inArray, isNotNull, isNull, min, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { newAppEntityId } from "./app-stacks-repository.js";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appStackLinks, appStacks } from "./schema.js";

export type AppStackLinkRow = typeof appStackLinks.$inferSelect;
export type AppStackLinkErrorCode = "NOT_FOUND" | "STACK_BUSY" | "LINK_EXISTS" | "LINK_LIMIT_APPLICATION" | "LINK_LIMIT_DATABASE";

export class AppStackLinkError extends Error {
  constructor(
    readonly code: AppStackLinkErrorCode,
    message: string,
    /** STACK_BUSY: the status that refuses. */
    readonly status?: AppStackStatus,
  ) {
    super(message);
    this.name = "AppStackLinkError";
  }
}

const BUSY: readonly AppStackStatus[] = APP_STACK_BUSY_STATUSES;
/** No new link while a change is queued or running, nor on an application whose deletion stopped half way. */
const NO_NEW_LINK: readonly AppStackStatus[] = [...APP_STACK_BUSY_STATUSES, "delete_failed"];

/**
 * Own transaction (a savepoint inside the caller's). Both applications are locked FOR UPDATE in id order, so a delete
 * of either and this insert never interleave: a database that is being deleted takes no new link, and the delete of a
 * database counts its links under the same lock. Refuses NOT_FOUND (either application missing, deleted or of another
 * customer), STACK_BUSY (a change of either is queued or running, or its deletion stopped half way), LINK_EXISTS and
 * the two caps (a link being disconnected still counts: it may still be there on the server). A pair the customer
 * disconnected and the server has not confirmed yet is taken back (same row, pending again). The caller has checked
 * which of the two is the database.
 */
export async function createAppStackLinkTransactional(
  db: HostingPanelDatabase,
  input: {
    readonly organizationId: string;
    readonly consumerStackId: string;
    readonly providerStackId: string;
    readonly createdBy: string | null;
  },
): Promise<AppStackLinkRow> {
  return db.transaction(async (tx) => {
    for (const stackId of [input.consumerStackId, input.providerStackId].sort()) {
      const [stack] = await tx
        .select({ status: appStacks.status })
        .from(appStacks)
        .where(and(eq(appStacks.id, stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
        .for("update");
      if (!stack) throw new AppStackLinkError("NOT_FOUND", "The application was not found.");
      if (NO_NEW_LINK.includes(stack.status)) {
        throw new AppStackLinkError("STACK_BUSY", "One of the two applications cannot be connected in the state it is in.", stack.status);
      }
    }
    const rows = await tx
      .select()
      .from(appStackLinks)
      .where(or(eq(appStackLinks.consumerStackId, input.consumerStackId), eq(appStackLinks.providerStackId, input.providerStackId)));
    const same = rows.find((row) => row.consumerStackId === input.consumerStackId && row.providerStackId === input.providerStackId);
    if (same) {
      if (same.state !== "removing") throw new AppStackLinkError("LINK_EXISTS", "This application already uses that database.");
      const [back] = await tx
        .update(appStackLinks)
        .set({ state: "pending", updatedAt: new Date() })
        .where(eq(appStackLinks.id, same.id))
        .returning();
      return back!;
    }
    if (rows.filter((row) => row.consumerStackId === input.consumerStackId).length >= MAX_APP_STACK_LINKS_PER_APPLICATION) {
      throw new AppStackLinkError(
        "LINK_LIMIT_APPLICATION",
        `An application can use at most ${String(MAX_APP_STACK_LINKS_PER_APPLICATION)} databases.`,
      );
    }
    if (rows.filter((row) => row.providerStackId === input.providerStackId).length >= MAX_APP_STACK_LINKS_PER_DATABASE) {
      throw new AppStackLinkError(
        "LINK_LIMIT_DATABASE",
        `A database can be used by at most ${String(MAX_APP_STACK_LINKS_PER_DATABASE)} applications.`,
      );
    }
    const [created] = await tx
      .insert(appStackLinks)
      .values({
        id: newAppEntityId("slnk"),
        organizationId: input.organizationId,
        consumerStackId: input.consumerStackId,
        providerStackId: input.providerStackId,
        createdBy: input.createdBy,
      })
      .returning();
    return created!;
  });
}

/**
 * The customer disconnects: the row is kept as `removing` until the server confirms the database is detached
 * (settleAppStackLinks deletes it). `stackId` is either side of the link. null: no such link of this customer.
 */
export async function markAppStackLinkRemoving(
  db: DatabaseExecutor,
  input: { readonly organizationId: string; readonly stackId: string; readonly linkId: string },
): Promise<AppStackLinkRow | null> {
  const [row] = await db
    .update(appStackLinks)
    .set({ state: "removing", updatedAt: new Date() })
    .where(
      and(
        eq(appStackLinks.id, input.linkId),
        eq(appStackLinks.organizationId, input.organizationId),
        or(eq(appStackLinks.consumerStackId, input.stackId), eq(appStackLinks.providerStackId, input.stackId)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Every link the application is a side of, oldest first. */
export function listAppStackLinks(db: DatabaseExecutor, input: { organizationId: string; stackId: string }): Promise<AppStackLinkRow[]> {
  return db
    .select()
    .from(appStackLinks)
    .where(
      and(
        eq(appStackLinks.organizationId, input.organizationId),
        or(eq(appStackLinks.consumerStackId, input.stackId), eq(appStackLinks.providerStackId, input.stackId)),
      ),
    )
    .orderBy(asc(appStackLinks.createdAt), asc(appStackLinks.id));
}

/** The links of one database, in a stable order: the input of the executor call. */
export function listAppStackLinksOfProvider(db: DatabaseExecutor, providerStackId: string): Promise<AppStackLinkRow[]> {
  return db
    .select()
    .from(appStackLinks)
    .where(eq(appStackLinks.providerStackId, providerStackId))
    .orderBy(asc(appStackLinks.consumerStackId));
}

/**
 * A link whose application is deleted is one to disconnect. The delete of an application removes its links itself; this
 * is for the one a previous release deleted while it ran on this schema after a rollback. Returns how many it marked.
 */
export async function releaseAppStackLinksOfDeletedApplications(db: DatabaseExecutor, providerStackId: string): Promise<number> {
  const rows = await db
    .update(appStackLinks)
    .set({ state: "removing", updatedAt: new Date() })
    .where(
      and(
        eq(appStackLinks.providerStackId, providerStackId),
        ne(appStackLinks.state, "removing"),
        inArray(appStackLinks.consumerStackId, db.select({ id: appStacks.id }).from(appStacks).where(isNotNull(appStacks.deletedAt))),
      ),
    )
    .returning({ id: appStackLinks.id });
  return rows.length;
}

/** The databases an application is linked to (any state), each once. */
export async function listAppStackLinkProviderIds(db: DatabaseExecutor, consumerStackId: string): Promise<string[]> {
  const rows = await db
    .select({ id: appStackLinks.providerStackId })
    .from(appStackLinks)
    .where(eq(appStackLinks.consumerStackId, consumerStackId))
    .orderBy(asc(appStackLinks.providerStackId));
  return rows.map((row) => row.id);
}

/**
 * What the server answered for one database. `active` and `pending` are link ids as they were read before the call;
 * `removed` are the ones that were `removing` then. Each update holds only for a row still in the state it was read in,
 * so a link the customer changed meanwhile is left for the next pass. `touch` moves every remaining row of the
 * database to the end of the retry order.
 */
export async function settleAppStackLinks(
  db: HostingPanelDatabase,
  input: {
    readonly providerStackId: string;
    readonly active: readonly string[];
    readonly pending: readonly string[];
    readonly removed: readonly string[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    const own = eq(appStackLinks.providerStackId, input.providerStackId);
    if (input.removed.length > 0) {
      await tx.delete(appStackLinks).where(and(own, inArray(appStackLinks.id, [...input.removed]), eq(appStackLinks.state, "removing")));
    }
    if (input.active.length > 0) {
      await tx
        .update(appStackLinks)
        .set({ state: "active" })
        .where(and(own, inArray(appStackLinks.id, [...input.active]), eq(appStackLinks.state, "pending")));
    }
    if (input.pending.length > 0) {
      await tx
        .update(appStackLinks)
        .set({ state: "pending" })
        .where(and(own, inArray(appStackLinks.id, [...input.pending]), eq(appStackLinks.state, "active")));
    }
    await tx.update(appStackLinks).set({ updatedAt: now }).where(own);
  });
}

/** The server could not be asked, or refused: nothing is known, so every link that was shown as applied is pending again. */
export async function unsettleAppStackLinks(db: DatabaseExecutor, providerStackId: string): Promise<void> {
  await db
    .update(appStackLinks)
    .set({ state: sql`CASE WHEN ${appStackLinks.state} = 'active' THEN 'pending' ELSE ${appStackLinks.state} END`, updatedAt: new Date() })
    .where(eq(appStackLinks.providerStackId, providerStackId));
}

/**
 * Databases with something left to apply, the one that waited longest first: no change of theirs queued or running,
 * and either a link to detach (asked by the customer, or of an application that is deleted) or a link to attach
 * between two applications that are both installed, the application not changing either.
 */
export async function listAppStackLinkProvidersDue(
  db: DatabaseExecutor,
  input: { readonly limit: number },
): Promise<{ readonly stackId: string; readonly organizationId: string }[]> {
  const provider = alias(appStacks, "provider");
  const consumer = alias(appStacks, "consumer");
  const waited = min(appStackLinks.updatedAt);
  const rows = await db
    .select({ stackId: provider.id, organizationId: provider.organizationId, waited })
    .from(appStackLinks)
    .innerJoin(provider, eq(provider.id, appStackLinks.providerStackId))
    .innerJoin(consumer, eq(consumer.id, appStackLinks.consumerStackId))
    .where(
      and(
        isNull(provider.deletedAt),
        notInArray(provider.status, [...BUSY]),
        or(
          eq(appStackLinks.state, "removing"),
          isNotNull(consumer.deletedAt),
          and(
            eq(appStackLinks.state, "pending"),
            isNotNull(provider.desiredRevisionId),
            isNotNull(consumer.desiredRevisionId),
            notInArray(consumer.status, [...BUSY]),
          ),
        ),
      ),
    )
    .groupBy(provider.id, provider.organizationId)
    .orderBy(asc(waited), asc(provider.id))
    .limit(input.limit);
  return rows.map((row) => ({ stackId: row.stackId, organizationId: row.organizationId }));
}
