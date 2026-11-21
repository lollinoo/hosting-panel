import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_IDS,
  appendAuditEvent,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  outboxEvents,
  seedPhase1Dataset,
  type DatabaseClient,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";

describe("operations request hash (HCP-SPEC-004 D9) and PEM guards (D15)", () => {
  let client: DatabaseClient;
  let n = 0;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await seedPhase1Dataset(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  const tlsApply = (extra: Record<string, unknown> = {}) => {
    n += 1;
    return {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.tls.apply" as const,
      resourceType: "site" as const,
      resourceId: `site_hash_${String(n)}`,
      ...extra,
    };
  };

  it("stores the request hash on the operation", async () => {
    const { operation } = await enqueueOperationTransactional(
      client.db,
      tlsApply({ idempotencyKey: "idem-store", requestHash: HASH_A }),
    );
    const [row] = await client.db.select().from(operations).where(eq(operations.id, operation.id));
    expect(row?.requestHash).toBe(HASH_A);
  });

  it("replays the same key with the same hash", async () => {
    const input = tlsApply({ idempotencyKey: "idem-same", requestHash: HASH_A });
    const first = await enqueueOperationTransactional(client.db, input);
    const second = await enqueueOperationTransactional(client.db, input);
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
  });

  it("refuses the same key with another hash as IDEMPOTENCY_CONFLICT", async () => {
    const input = tlsApply({ idempotencyKey: "idem-other", requestHash: HASH_A });
    await enqueueOperationTransactional(client.db, input);
    await expect(enqueueOperationTransactional(client.db, { ...input, requestHash: HASH_B })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("refuses a replay that brings a hash against an operation stored without one", async () => {
    const input = tlsApply({ idempotencyKey: "idem-late-hash" });
    await enqueueOperationTransactional(client.db, input);
    await expect(enqueueOperationTransactional(client.db, { ...input, requestHash: HASH_A })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("leaves callers without a hash unchanged", async () => {
    const input = tlsApply({ idempotencyKey: "idem-nohash" });
    const first = await enqueueOperationTransactional(client.db, input);
    const second = await enqueueOperationTransactional(client.db, input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    const [row] = await client.db.select().from(operations).where(eq(operations.id, first.operation.id));
    expect(row?.requestHash).toBeNull();
    // a stored hash does not block a caller that sends none
    const stored = tlsApply({ idempotencyKey: "idem-nohash-2" });
    await enqueueOperationTransactional(client.db, { ...stored, requestHash: HASH_A });
    await expect(enqueueOperationTransactional(client.db, stored)).resolves.toMatchObject({ idempotentReplay: true });
  });

  it("refuses a PEM value in the outbox payload without echoing it", async () => {
    const before = (await client.db.select().from(outboxEvents)).length;
    const err = await enqueueOperationTransactional(
      client.db,
      tlsApply({ outboxPayload: { note: { chain: [PEM] } } }),
    ).catch((e: unknown) => e as Error & { code?: string });
    expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((err as Error).message).toContain("note.chain[0]");
    expect((err as Error).message).not.toContain("BEGIN CERTIFICATE");
    expect(await client.db.select().from(outboxEvents)).toHaveLength(before);
  });

  it("refuses a privateKeyPem key in the outbox payload even with a harmless value", async () => {
    await expect(
      enqueueOperationTransactional(client.db, tlsApply({ outboxPayload: { privateKeyPem: "x" } })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("redacts a PEM value in appendAuditEvent instead of throwing, and still writes the row", async () => {
    const before = (await client.db.select().from(auditEvents)).length;
    const event = await appendAuditEvent(client.db, {
      action: "tls.test.pem",
      targetType: "tls_certificate",
      actorType: "system",
      details: { nested: { leaf: PEM }, other: KEY_PEM, requestId: "-----BEGIN", fine: "kept" },
    });
    expect(event?.details).toEqual({
      nested: { leaf: "[REDACTED_PEM]" },
      other: "[REDACTED_PEM]",
      requestId: "[REDACTED_PEM]",
      fine: "kept",
    });
    const rows = await client.db.select().from(auditEvents).where(eq(auditEvents.id, String(event?.id)));
    expect(JSON.stringify(rows)).not.toMatch(/BEGIN|PRIVATE KEY|MIIB/);
    expect(await client.db.select().from(auditEvents)).toHaveLength(before + 1);
  });

  describe("appendAuditEvent redacts what is STORED (the JSON round trip), values and keys, and never throws", () => {
    const BODY = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "ZmFrZWtleWJvZHk"];
    const KEY_LINES = ["-----BEGIN PRIVATE KEY-----", ...BODY, "-----END PRIVATE KEY-----"];
    const audit = (details: unknown) =>
      appendAuditEvent(client.db, { action: "adv.redact", targetType: "tls_certificate", actorType: "system", details: details as Record<string, unknown> });
    const storedOf = async (id: string | undefined) => JSON.stringify((await client.db.select().from(auditEvents).where(eq(auditEvents.id, String(id))))[0]?.details);
    const clean = (stored: string) => {
      expect(stored).not.toMatch(/BEGIN|MIIE|ZmFrZW|-----/);
    };

    it("redacts the fields of a class instance", async () => {
      class Holder {
        readonly cert: string;
        readonly name = "holder";
        constructor(cert: string) {
          this.cert = cert;
        }
      }
      const event = await audit({ holder: new Holder(PEM), list: [new Holder(KEY_PEM)] });
      expect(event?.details).toEqual({ holder: { cert: "[REDACTED_PEM]", name: "holder" }, list: [{ cert: "[REDACTED_PEM]", name: "holder" }] });
      clean(await storedOf(event?.id));
    });

    it("redacts what a toJSON method returns, an object or a string", async () => {
      const event = await audit({ asObject: { toJSON: () => ({ pem: PEM, keep: 1 }) }, asString: { toJSON: () => KEY_PEM }, when: new Date("2026-11-20T10:00:00.000Z") });
      expect(event?.details).toEqual({ asObject: { pem: "[REDACTED_PEM]", keep: 1 }, asString: "[REDACTED_PEM]", when: "2026-11-20T10:00:00.000Z" });
      clean(await storedOf(event?.id));
    });

    it("redacts an object key that carries a PEM marker (the value stays when it is harmless)", async () => {
      const event = await audit({ [PEM]: "harmless", nested: { [`x ${KEY_PEM}`]: { deeper: "ok" } }, fine: 1 });
      expect(event?.details).toEqual({ "[REDACTED_PEM]": "harmless", nested: { "[REDACTED_PEM]": { deeper: "ok" } }, fine: 1 });
      clean(await storedOf(event?.id));
      // two such keys never throw, whatever one of them keeps
      await expect(audit({ [`${PEM}1`]: 1, [`${PEM}2`]: 2 })).resolves.toBeTruthy();
    });

    it("redacts a PEM split over array elements: the BEGIN line, the body lines and the END line, and keeps the rest", async () => {
      const event = await audit({ lines: ["before", ...KEY_LINES, "after", { k: "v" }], nested: [[...KEY_LINES], ["x"]] });
      expect(event?.details).toEqual({
        lines: ["before", "[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]", "after", { k: "v" }],
        nested: [["[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]"], ["x"]],
      });
      clean(await storedOf(event?.id));
    });

    it("redacts every line after a BEGIN line that is never closed, and lines of one string joined by line breaks", async () => {
      const open = await audit({ lines: ["-----BEGIN CERTIFICATE-----", ...BODY, "tail"], single: KEY_LINES.join("\n"), crlf: KEY_LINES.join("\r\n") });
      expect(open?.details).toEqual({ lines: ["[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]", "[REDACTED_PEM]"], single: "[REDACTED_PEM]", crlf: "[REDACTED_PEM]" });
    });

    it("keeps a lone END line, a four-dash marker and plain lines of text", async () => {
      const harmless = { lines: ["-----END CERTIFICATE-----", "----BEGIN CERTIFICATE----", "MIIE is only text here"], n: [1, 2, null] };
      const event = await audit(harmless);
      expect(event?.details).toEqual(harmless);
    });

    it("writes the row even when the details cannot be serialised (circular, BigInt, a throwing toJSON, absurd depth) and never keeps them", async () => {
      const circular: Record<string, unknown> = { pem: PEM };
      circular.self = circular;
      let deep: Record<string, unknown> = { pem: KEY_PEM };
      for (let i = 0; i < 100_000; i += 1) deep = { d: deep };
      const before = (await client.db.select().from(auditEvents)).length;
      for (const details of [circular, { n: 10n, pem: PEM }, { bad: { toJSON: () => { throw new Error(PEM); } } }, deep]) {
        const event = await audit(details);
        expect(event?.id).toBeTruthy();
        clean(JSON.stringify(event?.details));
      }
      expect(await client.db.select().from(auditEvents)).toHaveLength(before + 4);
    });

    it("writes the row when the details carry U+0000 or a lone UTF-16 surrogate (jsonb refuses both), in values and keys, as U+FFFD", async () => {
      const event = await audit({
        reason: "a\u0000b",
        [`k\u0000ey`]: { [`n\ud800`]: ["x\udc00y", "tail\ud83d", "\ude00head", "ok"] },
        pair: "emoji \ud83d\ude00 kept",
        reversed: "\ude00\ud83d",
        doubleHigh: "\ud83d\ud83d\ude00",
        nul: "\u0000",
      });
      expect(event?.details).toEqual({
        reason: "a\ufffdb",
        "k\ufffdey": { "n\ufffd": ["x\ufffdy", "tail\ufffd", "\ufffdhead", "ok"] },
        pair: "emoji \ud83d\ude00 kept",
        reversed: "\ufffd\ufffd",
        doubleHigh: "\ufffd\ud83d\ude00",
        nul: "\ufffd",
      });
      expect(await storedOf(event?.id)).not.toContain("\\u0000");
    });

    it("writes the row when the text columns carry U+0000 too (a decoded route parameter, a header)", async () => {
      const event = await appendAuditEvent(client.db, {
        action: "adv.nul\u0000",
        targetType: "site\u0000",
        targetId: "id\u0000x",
        ipAddress: "10.0.0.1\u0000",
        userAgent: "ua\u0000/1",
        actorType: "system",
        details: { reason: "a\u0000b" },
      });
      expect(event).toMatchObject({ action: "adv.nul\ufffd", targetType: "site\ufffd", targetId: "id\ufffdx", ipAddress: "10.0.0.1\ufffd", userAgent: "ua\ufffd/1", details: { reason: "a\ufffdb" } });
    });

    it("stores no details key for missing details and keeps ordinary values (numbers, booleans, null, dates, nested arrays) as they were", async () => {
      expect((await audit(undefined))?.details).toEqual({});
      const ordinary = { n: 3, ok: true, none: null, list: [1, [2, { a: "b" }]], nested: { when: new Date("2026-11-20T10:00:00.000Z") } };
      expect((await audit(ordinary))?.details).toEqual(JSON.parse(JSON.stringify(ordinary)));
    });
  });

  it("still writes an audit event without PEM", async () => {
    const event = await appendAuditEvent(client.db, {
      action: "tls.test.ok",
      targetType: "tls_certificate",
      actorType: "system",
      details: { fingerprintSha256: "f".repeat(64), versionId: "ctv_1" },
    });
    expect(event?.details).toMatchObject({ versionId: "ctv_1" });
  });
});
