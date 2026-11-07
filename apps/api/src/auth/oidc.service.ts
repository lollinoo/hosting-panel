import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

export interface IssueJwtInput {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly expiresInSeconds?: number;
  readonly jti?: string;
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

@Injectable()
export class OidcService implements OnModuleInit {
  #keyPairPromise: Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> | null = null;
  readonly #revokedJtis = new Map<string, number | null>();

  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
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
      this.#keyPairPromise = generateKeyPair("RS256");
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
    const expiresIn = Math.max(1, Math.min(86_400, input.expiresInSeconds ?? 3_600));
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

    return {
      accessToken,
      jti,
      expiresIn,
      expiresAt: new Date(expEpoch * 1_000).toISOString(),
      issuer: this.config.oidcIssuer,
      audience: this.config.oidcAudience,
    };
  }

  public revokeTokenJti(jti: string, expiresAtEpochSeconds?: number): void {
    const trimmed = jti.trim();
    if (trimmed.length > 0) {
      this.#revokedJtis.set(trimmed, expiresAtEpochSeconds ?? null);
    }
  }

  public isJtiRevoked(jti: string): boolean {
    return this.#revokedJtis.has(jti.trim());
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

    const { publicKey } = await this.#ensureKeys();

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(rawJwt, publicKey, {
        issuer: this.config.oidcIssuer,
        audience: this.config.oidcAudience,
        algorithms: ["RS256"],
      });
      payload = verified.payload;
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

    if (this.isJtiRevoked(jti)) {
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
