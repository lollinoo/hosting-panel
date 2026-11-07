import type { MeDto, MeMembershipDto } from "@hosting-panel/contracts";
import { notFound, redirect } from "next/navigation";
import { fetchMe } from "./bff-client";
import { readServerSession } from "./server-session";
import type { BffSessionPayload } from "./session";

export interface ResolvedOrgServerContext {
  readonly session: BffSessionPayload;
  readonly me: MeDto;
  readonly membership: MeMembershipDto;
}

export async function resolveOrgServerContext(
  orgSlug: string,
): Promise<ResolvedOrgServerContext> {
  const session = await readServerSession();
  if (!session) {
    redirect("/login");
  }

  const meRes = await fetchMe(session.accessToken);
  if (!meRes.ok) {
    if (meRes.status === 401) {
      redirect("/login");
    }
    throw new Error(meRes.error.error.message);
  }

  const membership = meRes.data.data.memberships.find(
    (item) => item.organizationSlug === orgSlug,
  );
  if (!membership) {
    notFound();
  }

  return {
    session,
    me: meRes.data.data,
    membership,
  };
}

export interface ResolvedAdminServerContext {
  readonly session: BffSessionPayload;
  readonly me: MeDto;
}

export async function resolveAdminServerContext(): Promise<ResolvedAdminServerContext> {
  const session = await readServerSession();
  if (!session) {
    redirect("/login");
  }

  const meRes = await fetchMe(session.accessToken);
  if (!meRes.ok) {
    if (meRes.status === 401) {
      redirect("/login");
    }
    throw new Error(meRes.error.error.message);
  }

  if (!meRes.data.data.user.isPlatformAdmin) {
    notFound();
  }

  return {
    session,
    me: meRes.data.data,
  };
}
