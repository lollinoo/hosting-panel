import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { ErrorCode } from "./errors.js";

export const IPC_SIGNATURE_HEADERS = Object.freeze({
  keyId: "x-hp-key-id",
  timestamp: "x-hp-timestamp",
  nonce: "x-hp-nonce",
  bodySha256: "x-hp-body-sha256",
  signature: "x-hp-signature",
} as const);

export const DEFAULT_IPC_MAX_CLOCK_SKEW_MS = 30_000;
export const DEFAULT_IPC_NONCE_TTL_MS = 60_000;
export const DEFAULT_IPC_NONCE_MAX_ENTRIES = 10_000;

export type IpcSignatureAlgorithm = "hmac-sha256" | "ed25519";

export type IpcSigningKey =
  | {
      readonly keyId: string;
      readonly algorithm: "hmac-sha256";
      readonly secret: string | Buffer | Uint8Array;
    }
  | {
      readonly keyId: string;
      readonly algorithm: "ed25519";
      readonly privateKey: string | Buffer | KeyObject;
    };

export type IpcVerificationKey =
  | {
      readonly keyId: string;
      readonly algorithm: "hmac-sha256";
      readonly secret: string | Buffer | Uint8Array;
    }
  | {
      readonly keyId: string;
      readonly algorithm: "ed25519";
      readonly publicKey: string | Buffer | KeyObject;
    };

export type IpcVerificationKeyring =
  | Readonly<Record<string, IpcVerificationKey>>
  | ReadonlyMap<string, IpcVerificationKey>;

export type SignedIpcHeaders = {
  readonly "x-hp-key-id": string;
  readonly "x-hp-timestamp": string;
  readonly "x-hp-nonce": string;
  readonly "x-hp-body-sha256": string;
  readonly "x-hp-signature": string;
};

export interface SignIpcRequestInput {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly body?: string | Buffer | Uint8Array | null;
  readonly key: IpcSigningKey;
  readonly timestampMs?: number;
  readonly nonce?: string;
}

export interface CanonicalIpcPayloadInput {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly timestamp: string | number;
  readonly nonce: string;
  readonly bodySha256: string;
}

export interface IpcNonceReplayCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export class IpcNonceReplayCache {
  public readonly ttlMs: number;
  public readonly maxEntries: number;
  private readonly entries = new Map<string, number>();

  public constructor(options?: IpcNonceReplayCacheOptions) {
    const ttlMs = options?.ttlMs ?? DEFAULT_IPC_NONCE_TTL_MS;
    const maxEntries = options?.maxEntries ?? DEFAULT_IPC_NONCE_MAX_ENTRIES;

    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("IpcNonceReplayCache ttlMs must be a positive integer");
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("IpcNonceReplayCache maxEntries must be a positive integer");
    }

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  public get size(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }

  public pruneExpired(nowMs: number = Date.now()): void {
    for (const [nonce, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) {
        this.entries.delete(nonce);
      }
    }
  }

  public has(nonce: string, nowMs: number = Date.now()): boolean {
    const expiresAt = this.entries.get(nonce);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= nowMs) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  /**
   * Returns `true` if `nonce` is fresh and records it with `ttlMs`.
   * Returns `false` if `nonce` is already active in the cache (replay detected).
   */
  public checkAndRecord(nonce: string, nowMs: number = Date.now()): boolean {
    if (this.has(nonce, nowMs)) {
      return false;
    }

    if (this.entries.size >= this.maxEntries) {
      this.pruneExpired(nowMs);
    }

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }

    this.entries.set(nonce, nowMs + this.ttlMs);
    return true;
  }
}

export class IpcAuthError extends Error {
  public readonly statusCode: 401 | 409;
  public readonly code: ErrorCode;
  public readonly httpStatusText: "UNAUTHORIZED" | "CONFLICT";

  public constructor(
    statusCode: 401 | 409,
    code: "UNAUTHENTICATED" | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "IpcAuthError";
    this.statusCode = statusCode;
    this.code = code;
    this.httpStatusText = statusCode === 401 ? "UNAUTHORIZED" : "CONFLICT";
  }
}

export interface VerifiedIpcContext {
  readonly ok: true;
  readonly keyId: string;
  readonly algorithm: IpcSignatureAlgorithm;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly bodySha256: string;
}

export interface FailedIpcVerification {
  readonly ok: false;
  readonly statusCode: 401 | 409;
  readonly code: "UNAUTHENTICATED" | "IDEMPOTENCY_CONFLICT";
  readonly httpStatusText: "UNAUTHORIZED" | "CONFLICT";
  readonly reason: string;
}

export type VerifyIpcRequestResult = VerifiedIpcContext | FailedIpcVerification;

export interface VerifyIpcRequestInput {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: string | Buffer | Uint8Array | null;
  readonly keyring: IpcVerificationKeyring;
  readonly nonceCache: IpcNonceReplayCache;
  readonly nowMs?: number;
  readonly maxClockSkewMs?: number;
}

const SINGLE_LINE_TOKEN_PATTERN = /^[^\r\n\0]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const HMAC_SIG_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const ED25519_SIG_HEX_PATTERN = /^[0-9a-f]{128}$/i;
const TIMESTAMP_DIGITS_PATTERN = /^\d{1,16}$/;
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeHmacSecret(secret: string | Buffer | Uint8Array): Buffer {
  const buf =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.from(secret);
  if (buf.length < 16) {
    throw new Error("IPC HMAC-SHA256 secret must be at least 16 bytes");
  }
  return buf;
}

function resolveKeyFromKeyring(
  keyring: IpcVerificationKeyring,
  keyId: string,
): IpcVerificationKey | undefined {
  if (keyring instanceof Map) {
    return keyring.get(keyId);
  }
  const record = keyring as Readonly<Record<string, IpcVerificationKey>>;
  return Object.prototype.hasOwnProperty.call(record, keyId) ? record[keyId] : undefined;
}

function readSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  targetLowerName: string,
): string | null {
  const direct = headers[targetLowerName];
  if (typeof direct === "string") {
    return direct.trim();
  }
  if (Array.isArray(direct)) {
    return direct.length === 1 && typeof direct[0] === "string" ? direct[0].trim() : null;
  }

  for (const [rawName, rawVal] of Object.entries(headers)) {
    if (rawName.toLowerCase() === targetLowerName) {
      if (typeof rawVal === "string") {
        return rawVal.trim();
      }
      if (Array.isArray(rawVal)) {
        return rawVal.length === 1 && typeof rawVal[0] === "string" ? rawVal[0].trim() : null;
      }
      return null;
    }
  }

  return null;
}

export function computeIpcBodySha256(body?: string | Buffer | Uint8Array | null): string {
  const hash = createHash("sha256");
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      hash.update(body, "utf8");
    } else {
      hash.update(body);
    }
  }
  return hash.digest("hex");
}

export function buildCanonicalIpcPayload(input: CanonicalIpcPayloadInput): string {
  const normalizedMethod = input.method.trim().toUpperCase();
  const timestampStr = String(input.timestamp).trim();
  const normalizedHash = input.bodySha256.trim().toLowerCase();

  if (
    !normalizedMethod ||
    !SINGLE_LINE_TOKEN_PATTERN.test(normalizedMethod) ||
    !input.pathWithQuery.startsWith("/") ||
    !SINGLE_LINE_TOKEN_PATTERN.test(input.pathWithQuery) ||
    !TIMESTAMP_DIGITS_PATTERN.test(timestampStr) ||
    !NONCE_PATTERN.test(input.nonce) ||
    !SHA256_HEX_PATTERN.test(normalizedHash)
  ) {
    throw new Error("Invalid canonical IPC payload component");
  }

  return `${normalizedMethod}\n${input.pathWithQuery}\n${timestampStr}\n${input.nonce}\n${normalizedHash}`;
}

export function generateEd25519IpcKeyPair(keyId: string = "ed25519-v1"): {
  readonly keyId: string;
  readonly signingKey: Extract<IpcSigningKey, { algorithm: "ed25519" }>;
  readonly verificationKey: Extract<IpcVerificationKey, { algorithm: "ed25519" }>;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  return Object.freeze({
    keyId,
    signingKey: Object.freeze({
      keyId,
      algorithm: "ed25519" as const,
      privateKey,
    }),
    verificationKey: Object.freeze({
      keyId,
      algorithm: "ed25519" as const,
      publicKey,
    }),
    privateKeyPem,
    publicKeyPem,
  });
}

export function signIpcRequest(input: SignIpcRequestInput): SignedIpcHeaders {
  if (!input.key.keyId || !SINGLE_LINE_TOKEN_PATTERN.test(input.key.keyId)) {
    throw new Error("IPC signing keyId must be a non-empty single-line string");
  }

  const timestampMs = input.timestampMs ?? Date.now();
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error("IPC timestampMs must be a non-negative finite number");
  }
  const timestampStr = String(Math.trunc(timestampMs));
  const nonce = input.nonce ?? randomUUID();
  const bodySha256 = computeIpcBodySha256(input.body);

  const canonical = buildCanonicalIpcPayload({
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    timestamp: timestampStr,
    nonce,
    bodySha256,
  });

  let signatureHex: string;
  if (input.key.algorithm === "hmac-sha256") {
    const secretBuf = normalizeHmacSecret(input.key.secret);
    signatureHex = createHmac("sha256", secretBuf).update(canonical, "utf8").digest("hex");
  } else {
    const privKey =
      typeof input.key.privateKey === "string" || Buffer.isBuffer(input.key.privateKey)
        ? createPrivateKey(input.key.privateKey)
        : input.key.privateKey;
    signatureHex = cryptoSign(null, Buffer.from(canonical, "utf8"), privKey).toString("hex");
  }

  return Object.freeze({
    "x-hp-key-id": input.key.keyId,
    "x-hp-timestamp": timestampStr,
    "x-hp-nonce": nonce,
    "x-hp-body-sha256": bodySha256,
    "x-hp-signature": signatureHex,
  });
}

function unauthorizedResult(reason: string): FailedIpcVerification {
  return Object.freeze({
    ok: false as const,
    statusCode: 401 as const,
    code: "UNAUTHENTICATED" as const,
    httpStatusText: "UNAUTHORIZED" as const,
    reason,
  });
}

export function verifyIpcRequest(input: VerifyIpcRequestInput): VerifyIpcRequestResult {
  const keyId = readSingleHeader(input.headers, IPC_SIGNATURE_HEADERS.keyId);
  const timestampRaw = readSingleHeader(input.headers, IPC_SIGNATURE_HEADERS.timestamp);
  const nonce = readSingleHeader(input.headers, IPC_SIGNATURE_HEADERS.nonce);
  const claimedBodySha256 = readSingleHeader(input.headers, IPC_SIGNATURE_HEADERS.bodySha256);
  const claimedSignature = readSingleHeader(input.headers, IPC_SIGNATURE_HEADERS.signature);

  if (!keyId || !timestampRaw || !nonce || !claimedBodySha256 || !claimedSignature) {
    return unauthorizedResult("Missing required IPC authentication headers");
  }

  if (
    !SINGLE_LINE_TOKEN_PATTERN.test(keyId) ||
    !TIMESTAMP_DIGITS_PATTERN.test(timestampRaw) ||
    !NONCE_PATTERN.test(nonce) ||
    !SHA256_HEX_PATTERN.test(claimedBodySha256)
  ) {
    return unauthorizedResult("Malformed IPC authentication header format");
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampMs)) {
    return unauthorizedResult("Invalid IPC timestamp");
  }

  const nowMs = input.nowMs ?? Date.now();
  const maxClockSkewMs = input.maxClockSkewMs ?? DEFAULT_IPC_MAX_CLOCK_SKEW_MS;
  if (Math.abs(nowMs - timestampMs) > maxClockSkewMs) {
    return unauthorizedResult("IPC timestamp outside allowed clock skew window");
  }

  const verificationKey = resolveKeyFromKeyring(input.keyring, keyId);
  if (!verificationKey || verificationKey.keyId !== keyId) {
    return unauthorizedResult("Unknown IPC key identifier");
  }

  const actualBodySha256 = computeIpcBodySha256(input.body);
  const actualBodyBuf = Buffer.from(actualBodySha256, "hex");
  const claimedBodyBuf = Buffer.from(claimedBodySha256.toLowerCase(), "hex");
  if (actualBodyBuf.length !== claimedBodyBuf.length || !timingSafeEqual(actualBodyBuf, claimedBodyBuf)) {
    return unauthorizedResult("IPC request body SHA-256 integrity mismatch");
  }

  let canonical: string;
  try {
    canonical = buildCanonicalIpcPayload({
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      timestamp: timestampRaw,
      nonce,
      bodySha256: actualBodySha256,
    });
  } catch {
    return unauthorizedResult("Invalid canonical IPC request line");
  }

  if (verificationKey.algorithm === "hmac-sha256") {
    if (!HMAC_SIG_HEX_PATTERN.test(claimedSignature)) {
      return unauthorizedResult("Malformed HMAC-SHA256 IPC signature");
    }
    const secretBuf = normalizeHmacSecret(verificationKey.secret);
    const expectedSigBuf = createHmac("sha256", secretBuf).update(canonical, "utf8").digest();
    const actualSigBuf = Buffer.from(claimedSignature, "hex");
    if (
      actualSigBuf.length !== expectedSigBuf.length ||
      !timingSafeEqual(actualSigBuf, expectedSigBuf)
    ) {
      return unauthorizedResult("Invalid HMAC-SHA256 IPC signature");
    }
  } else {
    if (!ED25519_SIG_HEX_PATTERN.test(claimedSignature)) {
      return unauthorizedResult("Malformed Ed25519 IPC signature");
    }
    try {
      const pubKey =
        typeof verificationKey.publicKey === "string" || Buffer.isBuffer(verificationKey.publicKey)
          ? createPublicKey(verificationKey.publicKey)
          : verificationKey.publicKey;
      const sigBuf = Buffer.from(claimedSignature, "hex");
      const valid = cryptoVerify(null, Buffer.from(canonical, "utf8"), pubKey, sigBuf);
      if (!valid) {
        return unauthorizedResult("Invalid Ed25519 IPC signature");
      }
    } catch {
      return unauthorizedResult("Failed Ed25519 IPC signature verification");
    }
  }

  // Record nonce strictly AFTER cryptographic authenticity & freshness are proven
  if (!input.nonceCache.checkAndRecord(nonce, nowMs)) {
    return Object.freeze({
      ok: false as const,
      statusCode: 409 as const,
      code: "IDEMPOTENCY_CONFLICT" as const,
      httpStatusText: "CONFLICT" as const,
      reason: "Replayed IPC nonce rejected",
    });
  }

  return Object.freeze({
    ok: true as const,
    keyId,
    algorithm: verificationKey.algorithm,
    timestampMs,
    nonce,
    bodySha256: actualBodySha256,
  });
}

export function assertValidIpcRequest(input: VerifyIpcRequestInput): VerifiedIpcContext {
  const result = verifyIpcRequest(input);
  if (!result.ok) {
    throw new IpcAuthError(result.statusCode, result.code, result.reason);
  }
  return result;
}
