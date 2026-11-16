import { PANEL_CONTAINERS, type PanelContainer } from "@hosting-panel/contracts";

// Same as PATH_SEGMENT_REGEX in bff-guard.ts, which is server-only (node:crypto) and this file is not.
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const LOG_TAIL_CHOICES = [100, 200, 500] as const;
export type LogSource = { kind: "panel"; component: PanelContainer } | { kind: "site"; siteId: string };

/** `?source=`: one of the five panel containers or `site:<id>`, else null. */
export function parseLogSource(v: string | undefined): LogSource | null {
  if (!v) return null;
  if (v.startsWith("site:")) {
    const id = v.slice(5);
    return ID.test(id) ? { kind: "site", siteId: id } : null;
  }
  return (PANEL_CONTAINERS as readonly string[]).includes(v) ? { kind: "panel", component: v as PanelContainer } : null;
}

export const parseTail = (v: string | undefined) => ((LOG_TAIL_CHOICES as readonly number[]).includes(Number(v)) ? Number(v) : 200);

export const logUrl = (s: LogSource, tail: number) =>
  s.kind === "site" ? `/api/admin/sites/${s.siteId}/logs?tail=${tail}` : `/api/admin/logs/${s.component}?tail=${tail}`;

/** The BFF's clamp of `?tail=`, as the customer log route does. */
export function clampTail(req: Request): number {
  const raw = Number(new URL(req.url).searchParams.get("tail") ?? 200);
  return Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 200;
}

/** Audit pages forward at most this many pages; the trail holds the cursors before the current one. */
export const AUDIT_TRAIL_MAX = 100;

/** `?trail=`: comma-joined audit ids already walked; anything else is dropped whole. */
export function parseTrail(v: string | undefined): string[] {
  const parts = v ? v.split(",") : [];
  return parts.length < AUDIT_TRAIL_MAX && parts.every((p) => ID.test(p)) ? parts : [];
}

export type AuditFilters = { organizationId?: string; action?: string; from?: string; to?: string };

export function auditHref(f: AuditFilters, trail: readonly string[]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  if (trail.length) qs.set("trail", trail.join(","));
  const s = qs.toString();
  return s ? `/admin/audit?${s}` : "/admin/audit";
}

/** ISO → value of an `<input type="datetime-local">` in the browser's zone; "" if invalid. */
export function isoToLocalInput(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
