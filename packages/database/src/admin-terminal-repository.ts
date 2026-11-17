import { TERMINAL_SESSIONS_MAX, type TerminalEndReason } from "@hosting-panel/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appendAuditEvent } from "./operations-repository.js";
import { adminTerminalSessions } from "./schema.js";

type AdminTerminalSessionRow = typeof adminTerminalSessions.$inferSelect;

/** Inserts the session row and its open audit row unless the site or the server is full. */
export async function openTerminalSession(db: HostingPanelDatabase, input: {
  id: string; userId: string; siteId: string; organizationId: string; containerName: string;
  ipAddress: string | null; userAgent: string | null; requestId: string;
}): Promise<"opened" | "site_busy" | "server_full"> {
  return db.transaction(async (tx) => {
    // Serialises two opens so the per-site and server limits hold.
    await tx.execute(sql`LOCK TABLE admin_terminal_sessions IN SHARE ROW EXCLUSIVE MODE`);
    const open = await tx
      .select({ siteId: adminTerminalSessions.siteId })
      .from(adminTerminalSessions)
      .where(isNull(adminTerminalSessions.closedAt));
    if (open.some((row) => row.siteId === input.siteId)) return "site_busy";
    if (open.length >= TERMINAL_SESSIONS_MAX) return "server_full";
    await tx.insert(adminTerminalSessions).values({
      id: input.id,
      userId: input.userId,
      siteId: input.siteId,
      organizationId: input.organizationId,
      containerName: input.containerName,
    });
    await appendAuditEvent(tx, {
      actorId: input.userId,
      actorType: "user",
      organizationId: input.organizationId,
      action: "admin.terminal.open",
      targetType: "site",
      targetId: input.siteId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      details: { outcome: "succeeded", requestId: input.requestId, sessionId: input.id, containerName: input.containerName },
    });
    return "opened";
  });
}

/** Closes an open session and writes its one close audit row; false when it was already closed. */
export async function closeTerminalSession(db: HostingPanelDatabase, input: {
  id: string; reason: TerminalEndReason; endedAt: Date | null; actorType: "user" | "system"; requestId?: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const endedAt = input.endedAt?.toISOString() ?? null;
    // The subqueries give NULL for a user or organization deleted since the open, never an FK error.
    const closed = await tx.execute(sql`
      UPDATE admin_terminal_sessions
      SET closed_at = COALESCE(${endedAt}::timestamptz, now()), close_reason = ${input.reason}
      WHERE id = ${input.id} AND closed_at IS NULL
      RETURNING site_id, container_name,
        GREATEST(0, ROUND(EXTRACT(EPOCH FROM (closed_at - opened_at))))::int AS duration_seconds,
        (SELECT u.id FROM users u WHERE u.id = user_id) AS actor_id,
        (SELECT o.id FROM organizations o WHERE o.id = organization_id) AS organization_id`);
    const row = closed.rows[0] as {
      site_id: string; container_name: string; duration_seconds: number; actor_id: string | null; organization_id: string | null;
    } | undefined;
    if (!row) return false;
    await appendAuditEvent(tx, {
      actorId: row.actor_id,
      actorType: input.actorType,
      organizationId: row.organization_id,
      action: "admin.terminal.close",
      targetType: "site",
      targetId: row.site_id,
      details: {
        outcome: "succeeded",
        sessionId: input.id,
        containerName: row.container_name,
        reason: input.reason,
        durationSeconds: Number(row.duration_seconds),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      },
    });
    return true;
  });
}

/** The caller's own session, open or closed. */
export async function findTerminalSession(db: DatabaseExecutor, id: string, userId: string): Promise<AdminTerminalSessionRow | null> {
  const [row] = await db
    .select()
    .from(adminTerminalSessions)
    .where(and(eq(adminTerminalSessions.id, id), eq(adminTerminalSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Every session without a close row, oldest first. */
export async function listOpenTerminalSessions(db: DatabaseExecutor): Promise<AdminTerminalSessionRow[]> {
  return db.select().from(adminTerminalSessions).where(isNull(adminTerminalSessions.closedAt)).orderBy(asc(adminTerminalSessions.openedAt));
}
