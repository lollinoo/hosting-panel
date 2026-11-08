import { EncryptJWT, jwtDecrypt } from "jose";
import { createHash, randomBytes } from "node:crypto";
import type {
  MeMembershipDto,
  PlatformCapabilitiesDto,
  PresetRoleName,
} from "@hosting-panel/contracts";

export const SESSION_COOKIE_NAME = "hp_session";

export type ConsoleContext = "admin" | "customer";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  globalRoles: PresetRoleName[];
  hostingAdminOrgIds: string[];
  locale: "it" | "en";
  isServerAdmin: boolean;
  mustChangePassword: boolean;
}

export interface SessionData {
  accessToken: string;
  csrfToken: string;
  activeConsole: ConsoleContext;
  activeOrgSlug: string | null;
  user: SessionUser;
}

export interface PublicSessionDto {
  authenticated: boolean;
  csrfToken?: string;
  activeConsole?: ConsoleContext;
  activeOrgSlug?: string | null;
  user?: SessionUser;
  memberships?: MeMembershipDto[];
  platformCapabilities?: PlatformCapabilitiesDto;
}

const DEFAULT_SECRET = "hosting-panel-secure-session-key-32-chars-minimum-prod-grade!";

function getSessionSecretKey(): Uint8Array {
  const configured = process.env.BFF_SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!configured || configured.length < 32)) {
    throw new Error("BFF_SESSION_SECRET must be set to at least 32 characters in production");
  }
  return createHash("sha256").update(configured || DEFAULT_SECRET).digest();
}

export async function encryptSession(data: SessionData): Promise<string> {
  const key = getSessionSecretKey();
  return await new EncryptJWT(data as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .encrypt(key);
}

export async function decryptSession(token: string): Promise<SessionData | null> {
  // Outside the try: a misconfigured secret must fail loudly, not look like "logged out".
  const key = getSessionSecretKey();
  try {
    const { payload } = await jwtDecrypt(token, key, {
      contentEncryptionAlgorithms: ["A256GCM"],
      keyManagementAlgorithms: ["dir"],
    });

    if (
      !payload ||
      typeof payload.accessToken !== "string" ||
      typeof payload.csrfToken !== "string" ||
      typeof payload.activeConsole !== "string" ||
      !payload.user ||
      typeof (payload.user as Record<string, unknown>).id !== "string"
    ) {
      return null;
    }

    return {
      accessToken: payload.accessToken,
      csrfToken: payload.csrfToken,
      activeConsole: payload.activeConsole as ConsoleContext,
      activeOrgSlug: (payload.activeOrgSlug as string | null) ?? null,
      user: payload.user as SessionUser,
    };
  } catch {
    return null;
  }
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}
