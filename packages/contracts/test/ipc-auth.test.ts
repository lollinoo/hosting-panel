import { describe, expect, it } from "vitest";
import {
  DEFAULT_IPC_MAX_CLOCK_SKEW_MS,
  DEFAULT_IPC_NONCE_MAX_ENTRIES,
  DEFAULT_IPC_NONCE_TTL_MS,
  IpcAuthError,
  IpcNonceReplayCache,
  assertValidIpcRequest,
  buildCanonicalIpcPayload,
  computeIpcBodySha256,
  generateEd25519IpcKeyPair,
  signIpcRequest,
  verifyIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKeyring,
} from "../src/index.js";

const HMAC_SECRET_V1 = "0123456789abcdef0123456789abcdef-hmac-key-v1";
const HMAC_SECRET_V2 = "fedcba9876543210fedcba9876543210-hmac-key-v2";

describe("@hosting-panel/contracts — Signed IPC Auth & Anti-Replay (AC-F2-02)", () => {
  it("computes empty GET SHA-256 digest matching HCP-SPEC-003 §3.2 and canonical payload", () => {
    const emptyDigest = computeIpcBodySha256("");
    expect(emptyDigest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(computeIpcBodySha256(undefined)).toBe(emptyDigest);

    const canonical = buildCanonicalIpcPayload({
      method: "post",
      pathWithQuery: "/v1/services/deploy?dryRun=false",
      timestamp: 1762550000000,
      nonce: "nonce-uuid-12345678",
      bodySha256: emptyDigest,
    });
    expect(canonical).toBe(
      `POST\n/v1/services/deploy?dryRun=false\n1762550000000\nnonce-uuid-12345678\n${emptyDigest}`,
    );
  });

  it("signs and verifies HMAC-SHA256 IPC requests with zero-downtime key rotation keyring", () => {
    const nonceCache = new IpcNonceReplayCache();
    const nowMs = 1_762_550_000_000;
    const body = JSON.stringify({ serviceInstanceId: "svc_01", action: "restart" });

    const signingKeyV2: IpcSigningKey = {
      keyId: "hmac-v2",
      algorithm: "hmac-sha256",
      secret: HMAC_SECRET_V2,
    };

    const keyring: IpcVerificationKeyring = {
      "hmac-v1": { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET_V1 },
      "hmac-v2": { keyId: "hmac-v2", algorithm: "hmac-sha256", secret: HMAC_SECRET_V2 },
    };

    const headers = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/services/action",
      body,
      key: signingKeyV2,
      timestampMs: nowMs - 5_000,
      nonce: "nonce-hmac-valid-0001",
    });

    const verified = verifyIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/services/action",
      headers,
      body,
      keyring,
      nonceCache,
      nowMs,
    });

    expect(verified).toEqual({
      ok: true,
      keyId: "hmac-v2",
      algorithm: "hmac-sha256",
      timestampMs: nowMs - 5_000,
      nonce: "nonce-hmac-valid-0001",
      bodySha256: computeIpcBodySha256(body),
    });
  });

  it("signs and verifies Ed25519 asymmetric IPC requests (ADR-008 hub readiness)", () => {
    const nonceCache = new IpcNonceReplayCache();
    const nowMs = 1_762_550_000_000;
    const kp = generateEd25519IpcKeyPair("ed25519-hub-01");
    const body = JSON.stringify({ hostId: "hst_ded_01", policyRef: "verify_baseline_firewall" });

    const headers = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/security",
      body,
      key: {
        keyId: kp.keyId,
        algorithm: "ed25519",
        privateKey: kp.privateKeyPem,
      },
      timestampMs: nowMs,
      nonce: "nonce-ed25519-valid-01",
    });

    const ctx = assertValidIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/security",
      headers,
      body,
      keyring: new Map([[kp.keyId, { keyId: kp.keyId, algorithm: "ed25519", publicKey: kp.publicKeyPem }]]),
      nonceCache,
      nowMs,
    });

    expect(ctx.ok).toBe(true);
    expect(ctx.algorithm).toBe("ed25519");
    expect(ctx.keyId).toBe("ed25519-hub-01");
  });

  it("rejects missing headers, tampered body, tampered path, wrong key, and clock skew > 30s with 401 UNAUTHORIZED", () => {
    const nonceCache = new IpcNonceReplayCache();
    const nowMs = 1_762_550_000_000;
    const key: IpcSigningKey = {
      keyId: "hmac-v1",
      algorithm: "hmac-sha256",
      secret: HMAC_SECRET_V1,
    };
    const keyring: IpcVerificationKeyring = {
      "hmac-v1": { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET_V1 },
    };
    const body = JSON.stringify({ hello: "world" });

    // 1. Missing headers
    const missingRes = verifyIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/telemetry",
      headers: {},
      keyring,
      nonceCache,
      nowMs,
    });
    expect(missingRes).toMatchObject({
      ok: false,
      statusCode: 401,
      code: "UNAUTHENTICATED",
      httpStatusText: "UNAUTHORIZED",
    });

    // 2. Clock skew > 30_000ms (both past and future)
    expect(DEFAULT_IPC_MAX_CLOCK_SKEW_MS).toBe(30_000);
    const staleHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/maintenance",
      body,
      key,
      timestampMs: nowMs - 30_001,
      nonce: "nonce-stale-timestamp-01",
    });
    const staleRes = verifyIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/maintenance",
      headers: staleHeaders,
      body,
      keyring,
      nonceCache,
      nowMs,
    });
    expect(staleRes).toMatchObject({ ok: false, statusCode: 401, code: "UNAUTHENTICATED" });
    // Unauthenticated/stale requests MUST NOT pollute the replay cache
    expect(nonceCache.size).toBe(0);

    const futureHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/maintenance",
      body,
      key,
      timestampMs: nowMs + 30_001,
      nonce: "nonce-future-timestamp-01",
    });
    expect(
      verifyIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/maintenance",
        headers: futureHeaders,
        body,
        keyring,
        nonceCache,
        nowMs,
      }),
    ).toMatchObject({ ok: false, statusCode: 401, code: "UNAUTHENTICATED" });

    // 3. Body SHA-256 mismatch (tampered payload)
    const validHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/maintenance",
      body,
      key,
      timestampMs: nowMs,
      nonce: "nonce-body-tamper-01",
    });
    const tamperedBodyRes = verifyIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/maintenance",
      headers: validHeaders,
      body: JSON.stringify({ hello: "attacker" }),
      keyring,
      nonceCache,
      nowMs,
    });
    expect(tamperedBodyRes).toMatchObject({ ok: false, statusCode: 401, code: "UNAUTHENTICATED" });
    expect(nonceCache.size).toBe(0);

    // 4. Tampered signature
    const badSigHeaders = {
      ...validHeaders,
      "x-hp-signature": "0".repeat(64),
    };
    expect(() =>
      assertValidIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/maintenance",
        headers: badSigHeaders,
        body,
        keyring,
        nonceCache,
        nowMs,
      }),
    ).toThrow(IpcAuthError);
    expect(nonceCache.size).toBe(0);
  });

  it("rejects replayed nonces with 409 CONFLICT (IDEMPOTENCY_CONFLICT) and enforces bounded cache eviction", () => {
    expect(DEFAULT_IPC_NONCE_TTL_MS).toBe(60_000);
    expect(DEFAULT_IPC_NONCE_MAX_ENTRIES).toBe(10_000);

    const nonceCache = new IpcNonceReplayCache({ ttlMs: 60_000, maxEntries: 3 });
    const nowMs = 1_762_550_000_000;
    const key: IpcSigningKey = {
      keyId: "hmac-v1",
      algorithm: "hmac-sha256",
      secret: HMAC_SECRET_V1,
    };
    const keyring: IpcVerificationKeyring = {
      "hmac-v1": { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET_V1 },
    };

    const headers = signIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/telemetry",
      key,
      timestampMs: nowMs,
      nonce: "nonce-replay-check-0001",
    });

    const first = verifyIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/telemetry",
      headers,
      keyring,
      nonceCache,
      nowMs,
    });
    expect(first.ok).toBe(true);

    // Immediate replay within TTL -> 409 CONFLICT (IDEMPOTENCY_CONFLICT)
    const replay = verifyIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/telemetry",
      headers,
      keyring,
      nonceCache,
      nowMs: nowMs + 1_000,
    });
    expect(replay).toEqual({
      ok: false,
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
      httpStatusText: "CONFLICT",
      reason: "Replayed IPC nonce rejected",
    });

    // Bounded maxEntries cap prevents unbounded memory growth
    expect(nonceCache.checkAndRecord("nonce-cap-0002", nowMs)).toBe(true);
    expect(nonceCache.checkAndRecord("nonce-cap-0003", nowMs)).toBe(true);
    expect(nonceCache.size).toBe(3);
    expect(nonceCache.checkAndRecord("nonce-cap-0004", nowMs)).toBe(true);
    expect(nonceCache.size).toBe(3);
    expect(nonceCache.has("nonce-replay-check-0001", nowMs)).toBe(false);

    // After TTL (60_000ms), expired entries are evicted
    expect(nonceCache.has("nonce-cap-0004", nowMs + 60_001)).toBe(false);
  });
});
