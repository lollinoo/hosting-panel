import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AES_256_GCM_IV_BYTES = 12;
export const AES_256_GCM_AUTH_TAG_BYTES = 16;
export const AES_256_GCM_KEY_BYTES = 32;

const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_32_BYTES_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export function generateSecretsMasterKeyHex(): string {
  return randomBytes(AES_256_GCM_KEY_BYTES).toString("hex");
}

export function parseSecretsMasterKey(masterKey: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(masterKey) || masterKey instanceof Uint8Array) {
    const buf = Buffer.from(masterKey);
    if (buf.length !== AES_256_GCM_KEY_BYTES) {
      throw new Error(
        `AES-256-GCM master key must be exactly ${String(AES_256_GCM_KEY_BYTES)} bytes`,
      );
    }
    return buf;
  }

  const trimmed = masterKey.trim();
  if (HEX_64_PATTERN.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  if (BASE64_32_BYTES_PATTERN.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === AES_256_GCM_KEY_BYTES) {
      return decoded;
    }
  }

  const utf8Buf = Buffer.from(masterKey, "utf8");
  if (utf8Buf.length === AES_256_GCM_KEY_BYTES) {
    return utf8Buf;
  }

  throw new Error(
    `AES-256-GCM master key must be ${String(AES_256_GCM_KEY_BYTES)} bytes (64 hex chars, 44-char base64, or 32-byte Buffer)`,
  );
}

export interface SecretAesGcmAadContext {
  readonly organizationId: string;
  readonly siteId?: string | null;
  readonly secretKey: string;
}

export function buildSecretAesGcmAad(ctx: SecretAesGcmAadContext): Buffer {
  if (!ctx.organizationId || ctx.organizationId.trim().length === 0) {
    throw new Error("Secret AAD organizationId must not be empty");
  }
  if (!ctx.secretKey || ctx.secretKey.trim().length === 0) {
    throw new Error("Secret AAD secretKey must not be empty");
  }
  const siteScope = ctx.siteId && ctx.siteId.trim().length > 0 ? ctx.siteId : "*";
  return Buffer.from(`${ctx.organizationId}:${siteScope}:${ctx.secretKey}`, "utf8");
}

export interface EncryptSecretAesGcmInput extends SecretAesGcmAadContext {
  readonly plaintext: string;
  readonly masterKey: string | Buffer | Uint8Array;
  readonly keyVersion?: string;
}

export interface EncryptedSecretEnvelope {
  readonly ciphertextBase64: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly keyVersion: string;
}

export function encryptSecretAesGcm(input: EncryptSecretAesGcmInput): EncryptedSecretEnvelope {
  if (typeof input.plaintext !== "string" || input.plaintext.length === 0) {
    throw new Error("Secret plaintext must be a non-empty string");
  }

  const key = parseSecretsMasterKey(input.masterKey);
  const aad = buildSecretAesGcmAad({
    organizationId: input.organizationId,
    siteId: input.siteId,
    secretKey: input.secretKey,
  });
  const iv = randomBytes(AES_256_GCM_IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AES_256_GCM_AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Object.freeze({
    ciphertextBase64: ciphertext.toString("base64"),
    ivBase64: iv.toString("base64"),
    authTagBase64: authTag.toString("base64"),
    keyVersion: input.keyVersion ?? "v1",
  });
}

export interface DecryptSecretAesGcmInput extends SecretAesGcmAadContext {
  readonly ciphertextBase64: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly masterKey: string | Buffer | Uint8Array;
}

export function decryptSecretAesGcm(input: DecryptSecretAesGcmInput): string {
  const key = parseSecretsMasterKey(input.masterKey);
  const aad = buildSecretAesGcmAad({
    organizationId: input.organizationId,
    siteId: input.siteId,
    secretKey: input.secretKey,
  });

  if (!input.ciphertextBase64 || !input.ivBase64 || !input.authTagBase64) {
    throw new Error("Encrypted secret envelope fields must not be empty");
  }

  const iv = Buffer.from(input.ivBase64, "base64");
  if (iv.length !== AES_256_GCM_IV_BYTES) {
    throw new Error("Invalid AES-256-GCM IV byte length");
  }

  const authTag = Buffer.from(input.authTagBase64, "base64");
  if (authTag.length !== AES_256_GCM_AUTH_TAG_BYTES) {
    throw new Error("Invalid AES-256-GCM authentication tag byte length");
  }

  const ciphertext = Buffer.from(input.ciphertextBase64, "base64");
  if (ciphertext.length === 0) {
    throw new Error("Invalid AES-256-GCM empty ciphertext");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AES_256_GCM_AUTH_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
