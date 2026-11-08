import { createPublicKey, randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import {
  and,
  eq,
  gt,
  isNull,
  not,
  userSessions,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

export interface IssueJwtInput {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly expiresInSeconds?: number;
  readonly jti?: string;
  readonly ip?: string | null;
}

export interface IssueSessionTokenInput {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly ip: string | null;
}

export interface IssuedJwtResult {
  readonly accessToken: string;
  readonly jti: string;
  readonly expiresIn: number;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface VerifiedJwtClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly jti: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly exp?: number;
  readonly rawPayload: JWTPayload;
}

const KEY_ID = "dev-oidc-rs256-1";
export const BREAKGLASS_KEY_ID = "breakglass-hs256-v1";
const MAX_BREAKGLASS_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 43_200;

@Injectable()
export class OidcService implements OnModuleInit {
  #keyPairPromise: Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> | null = null;

  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.#ensureKeys();
  }

  public get issuer(): string {
    return this.config.oidcIssuer;
  }

  public get audience(): string {
    return this.config.oidcAudience;
  }

  public isDevOidcEnabled(): boolean {
    return this.config.enableDevOidc;
  }

  async #ensureKeys(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
    if (!this.#keyPairPromise) {
      const pem = this.config.jwtSigningKeyPem;
      this.#keyPairPromise = pem
        ? Promise.all([
            importPKCS8(pem, "RS256"),
            importSPKI(
              createPublicKey(pem).export({ type: "spki", format: "pem" }).toString(),
              "RS256",
              { extractable: true },
            ),
          ]).then(([privateKey, publicKey]) => ({ privateKey, publicKey }))
        : generateKeyPair("RS256");
    }
    return this.#keyPairPromise;
  }

  public async getJwks(): Promise<JSONWebKeySet> {
    const { publicKey } = await this.#ensureKeys();
    const publicJwk = await exportJWK(publicKey);
    return {
      keys: [
        {
          ...publicJwk,
          kid: KEY_ID,
          alg: "RS256",
          use: "sig",
        },
      ],
    };
  }

  public async issueToken(input: IssueJwtInput): Promise<IssuedJwtResult> {
    const { privateKey } = await this.#ensureKeys();
    const expiresIn = Math.max(
      1,
      Math.min(SESSION_TTL_SECONDS, input.expiresInSeconds ?? SESSION_TTL_SECONDS),
    );
    const nowEpoch = Math.floor(Date.now() / 1_000);
    const expEpoch = nowEpoch + expiresIn;
    const jti = input.jti ?? `jti_${randomUUID().replace(/-/g, "")}`;

    const accessToken = await new SignJWT({
      email: input.email,
      name: input.displayName,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: KEY_ID })
      .setIssuer(this.config.oidcIssuer)
      .setSubject(input.subject)
      .setAudience(this.config.oidcAudience)
      .setJti(jti)
      .setIssuedAt(nowEpoch)
      .setExpirationTime(expEpoch)
      .sign(privateKey);

    await this.dbClient.db.insert(userSessions).values({
      id: jti,
      userId: input.subject,
      expiresAt: new Date(expEpoch * 1_000),
      ip: input.ip ?? null,
    });

    return {
      accessToken,
      jti,
      expiresIn,
      expiresAt: new Date(expEpoch * 1_000).toISOString(),
      issuer: this.config.oidcIssuer,
      audience: this.config.oidcAudience,
    };
  }

  public async issueBreakGlassToken(input: IssueJwtInput): Promise<IssuedJwtResult> {
    const expiresIn = Math.max(
      1,
      Math.min(
        MAX_BREAKGLASS_TTL_SECONDS,
        Math.floor(input.expiresInSeconds ?? MAX_BREAKGLASS_TTL_SECONDS),
      ),
    );
    const jti = input.jti ?? `jti_bg_${randomUUID().replace(/-/g, "")}`;

    if (
      this.config.breakglassSigningKey &&
      this.config.breakglassSigningKey.byteLength >= 32
    ) {
      const nowEpoch = Math.floor(Date.now() / 1_000);
      const expEpoch = nowEpoch + expiresIn;
      const accessToken = await new SignJWT({
        email: input.email,
        name: input.displayName,
        amr: ["breakglass"],
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: BREAKGLASS_KEY_ID })
        .setIssuer(this.config.oidcIssuer)
        .setSubject(input.subject)
        .setAudience(this.config.oidcAudience)
        .setJti(jti)
        .setIssuedAt(nowEpoch)
        .setExpirationTime(expEpoch)
        .sign(this.config.breakglassSigningKey);

      return {
        accessToken,
        jti,
        expiresIn,
        expiresAt: new Date(expEpoch * 1_000).toISOString(),
        issuer: this.config.oidcIssuer,
        audience: this.config.oidcAudience,
      };
    }

    return this.issueToken({
      ...input,
      expiresInSeconds: expiresIn,
      jti,
    });
  }

  public issueSessionToken(input: IssueSessionTokenInput): Promise<IssuedJwtResult> {
    return this.issueToken({
      subject: input.userId,
      email: input.email,
      displayName: input.displayName,
      ip: input.ip,
    });
  }

  public async revokeSession(jti: string): Promise<void> {
    await this.dbClient.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, jti), isNull(userSessions.revokedAt)));
  }

  public async revokeAllSessionsForUser(userId: string, exceptJti?: string): Promise<void> {
    await this.dbClient.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          exceptJti === undefined ? undefined : not(eq(userSessions.id, exceptJti)),
        ),
      );
  }

  async #isSessionActive(jti: string): Promise<boolean> {
    const [row] = await this.dbClient.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.id, jti),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async verifyAuthorizationHeader(
    authorizationHeader: string | undefined,
  ): Promise<VerifiedJwtClaims> {
    if (typeof authorizationHeader !== "string" || authorizationHeader.trim().length === 0) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Missing Authorization Bearer token.",
      );
    }

    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    const rawJwt = match?.[1];
    if (!rawJwt) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Malformed Authorization header; expected 'Bearer <jwt>'.",
      );
    }

    let headerKid: string | undefined;
    let headerAlg: string | undefined;
    try {
      const protectedHeader = decodeProtectedHeader(rawJwt);
      headerKid = protectedHeader.kid;
      headerAlg = protectedHeader.alg;
    } catch {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authentication token is invalid or expired.",
      );
    }

    let payload: JWTPayload;
    const isBreakGlass = headerKid === BREAKGLASS_KEY_ID || headerAlg === "HS256";
    try {
      if (isBreakGlass) {
        if (
          headerKid !== BREAKGLASS_KEY_ID ||
          headerAlg !== "HS256" ||
          !this.config.breakglassSigningKey ||
          this.config.breakglassSigningKey.byteLength < 32
        ) {
          throw new Error("Break-glass signing key is unavailable or header mismatched");
        }
        const verified = await jwtVerify(rawJwt, this.config.breakglassSigningKey, {
          issuer: this.config.oidcIssuer,
          audience: this.config.oidcAudience,
          algorithms: ["HS256"],
          maxTokenAge: `${String(MAX_BREAKGLASS_TTL_SECONDS)}s`,
        });
        payload = verified.payload;
      } else {
        const { publicKey } = await this.#ensureKeys();
        const verified = await jwtVerify(rawJwt, publicKey, {
          issuer: this.config.oidcIssuer,
          audience: this.config.oidcAudience,
          algorithms: ["RS256"],
        });
        payload = verified.payload;
      }
    } catch {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authentication token is invalid or expired.",
      );
    }

    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
    const issuer = typeof payload.iss === "string" ? payload.iss.trim() : "";

    if (subject.length === 0 || jti.length === 0 || issuer.length === 0) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authentication token is missing required claims (sub, iss, jti).",
      );
    }

    // RS256 tokens are only valid while their user_sessions row is live; break-glass is stateless.
    if (!isBreakGlass && !(await this.#isSessionActive(jti))) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authentication token has been revoked.",
      );
    }

    return {
      issuer,
      subject,
      audience: this.config.oidcAudience,
      jti,
      email: typeof payload["email"] === "string" ? payload["email"] : undefined,
      displayName: typeof payload["name"] === "string" ? payload["name"] : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
      rawPayload: payload,
    };
  }
}
