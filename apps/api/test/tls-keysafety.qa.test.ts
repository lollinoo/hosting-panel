import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  desc,
  domains,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  readTlsVersionKey,
  sql,
  tlsCertificateVersions,
  tlsCertificates,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter, ManualTlsStoreError } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki, type IssuedCert } from "./fixtures/tls-certgen.js";

// HCP-SPEC-004 TLS-01 / TLS-13 (API part), QA: a private-key canary through every import / version / assign variant on
// the customer and the administrator routes, plus executor errors that carry the key. The canary must never reach a
// response, an audit row, an outbox event, an operation, an operation step, any other table, or a log line; the
// stored version holds ciphertext only; audit details have exact key sets. One scenario runs once (beforeAll); the
// tests read what it recorded.
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const DAY = 86_400_000;
const PKI = issuePki();
const MARK = "QA-KEY-CANARY-5c1e8a07";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const bodyOf = (pem: string): string => pem.replace(/-----[^-]+-----|\s+/g, "");
const junkKey = (label = "PRIVATE KEY"): string => `-----BEGIN ${label}-----\n${MARK}\n-----END ${label}-----\n`;

describe("TLS private-key safety (QA)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let tokenA: string;
  let orgA: string;
  let siteA: string;
  const logs: string[] = [];
  const canaries = new Set<string>([MARK]);
  const seen = new Map<string, { status: number; raw: string; body: Json }>();
  const spies: Array<{ mockRestore: () => void }> = [];

  /** Every key the scenario generates: two slices of the private scalar (first and second PEM line) and the whole body. */
  function leaf(dns: string[], over: Partial<Parameters<typeof issueCert>[0]> = {}): IssuedCert {
    const issued = issueCert({ dns, issuer: PKI.intermediate, ...over });
    const body = bodyOf(issued.keyPem);
    for (const c of [body.slice(50, 64), body.slice(64, 100), body.slice(-24), body]) canaries.add(c);
    canaries.add(Buffer.from(body).toString("base64").slice(70, 110));
    return issued;
  }
  const upload = (l: IssuedCert, extra: object = {}) => ({
    name: "Hotel certificate",
    format: "pem",
    leafPem: l.pem,
    chainPem: PKI.intermediate.pem,
    privateKeyPem: l.keyPem,
    ...extra,
  });
  const version = (l: IssuedCert, extra: object = {}) => (({ name: _n, ...rest }) => rest)(upload(l, extra));

  /** Which canaries (or any key-shaped text) a text contains. */
  const leaksIn = (text: string): string[] => [
    ...[...canaries].filter((c) => text.includes(c)),
    ...(/PRIVATE KEY|BEGIN [A-Z ]*KEY/.test(text) ? ["PEM key header"] : []),
  ];

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(
    label: string,
    method: string,
    path: string,
    opts: { body?: unknown; raw?: string; token?: string | null; key?: string | null; contentType?: string } = {},
  ) {
    const key = opts.key === undefined ? randomUUID() : opts.key;
    const token = opts.token === undefined ? tokenA : opts.token;
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": opts.contentType ?? "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const raw = await res.text();
    let body: Json = {};
    try {
      body = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      /* not JSON: the raw text is still scanned */
    }
    const out = { status: res.status, raw, body };
    seen.set(label, out);
    return out;
  }

  const certsOf = (family: "customer" | "admin") =>
    family === "customer" ? `/v1/organizations/${orgA}/managed-sites/${siteA}/tls-certificates` : `/v1/admin/sites/${siteA}/tls-certificates`;
  const domainsOf = (family: "customer" | "admin") =>
    family === "customer" ? `/v1/organizations/${orgA}/managed-sites/${siteA}/domains` : `/v1/admin/sites/${siteA}/domains`;
  const tokenOf = (family: "customer" | "admin") => (family === "customer" ? tokenA : adminToken);
  const drain = () => app.outboxWorker.processPendingOnce();
  const domainRow = async (hostname: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0]!;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply")).orderBy(desc(operations.submittedAt));
  const failOnce = (action: string, make: (req: { keyPem?: string }) => Error) => {
    const original = sim.manualTls.bind(sim);
    let armed = true;
    sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
      if (armed && req.action === action) {
        armed = false;
        throw make(req as { keyPem?: string });
      }
      return original(req);
    }) as typeof sim.manualTls;
    return () => {
      sim.manualTls = original;
    };
  };
  const dataOf = (label: string) => seen.get(label)!;

  async function runFamily(family: "customer" | "admin"): Promise<{ certificateId: string; versionId: string }> {
    const certs = certsOf(family);
    const token = tokenOf(family);
    const p = (label: string) => `${family}:${label}`;
    const opts = (extra: Parameters<typeof call>[3] = {}) => ({ token, ...extra });
    const good = leaf(["hotel.it", "www.hotel.it"]);

    // --- import: happy, then every refusal ---------------------------------------------------------------------
    const happy = await call(p("import:happy"), "POST", certs, opts({ body: upload(good), key: `${family}-k1` }));
    const certificateId = happy.body.data.id as string;
    const versionId = happy.body.data.versions[0].id as string;

    const other = leaf(["hotel.it"]);
    const expired = leaf(["hotel.it"], { notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) });
    const fresh = leaf(["www.hotel.it"]);
    const second = leaf(["www.hotel.it"]);
    await call(p("import:malformed-pem"), "POST", certs, opts({ body: upload(fresh, { leafPem: "not a certificate", privateKeyPem: junkKey() }) }));
    await call(p("import:junk-key-only"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: junkKey() }) }));
    await call(p("import:junk-leaf"), "POST", certs, opts({ body: upload(fresh, { leafPem: "-----BEGIN CERTIFICATE-----\nA-B\n-----END CERTIFICATE-----\n" }) }));
    await call(p("import:encrypted-key"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: junkKey("ENCRYPTED PRIVATE KEY") }) }));
    await call(p("import:mismatch"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: other.keyPem }) }));
    await call(p("import:two-keys"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: `${fresh.keyPem}${second.keyPem}` }) }));
    await call(p("import:expired"), "POST", certs, opts({ body: upload(expired) }));
    await call(p("import:extra-field"), "POST", certs, opts({ body: upload(fresh, { password: MARK, passphrase: fresh.keyPem }) }));
    await call(p("import:extra-field-nested"), "POST", certs, opts({ body: upload(fresh, { meta: { privateKeyPem: fresh.keyPem } }) }));
    await call(p("import:key-as-array"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: [fresh.keyPem] }) }));
    await call(p("import:key-as-object"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: { pem: fresh.keyPem } }) }));
    await call(p("import:key-as-number"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: 42, name: fresh.keyPem.slice(0, 120) }) }));
    await call(p("import:key-in-name"), "POST", certs, opts({ body: upload(fresh, { name: fresh.keyPem }) }));
    await call(p("import:pfx"), "POST", certs, opts({ body: upload(fresh, { format: "pfx", password: MARK }) }));
    await call(p("import:content-type-text"), "POST", certs, opts({ raw: JSON.stringify(upload(fresh)), contentType: "text/plain" }));
    await call(p("import:content-type-form"), "POST", certs, opts({ raw: `privateKeyPem=${encodeURIComponent(fresh.keyPem)}`, contentType: "application/x-www-form-urlencoded" }));
    await call(p("import:content-type-xml"), "POST", certs, opts({ raw: `<k>${fresh.keyPem}</k>`, contentType: "application/xml" }));
    await call(p("import:json-truncated"), "POST", certs, opts({ raw: JSON.stringify(upload(fresh)).slice(0, -9) }));
    await call(p("import:json-unquoted"), "POST", certs, opts({ raw: JSON.stringify(upload(fresh)).replace('"privateKeyPem":', "privateKeyPem:") }));
    await call(p("import:json-key-first"), "POST", certs, opts({ raw: `${fresh.keyPem} ${JSON.stringify(upload(fresh))}` }));
    await call(p("import:json-array"), "POST", certs, opts({ raw: JSON.stringify([upload(fresh)]) }));
    await call(p("import:json-null"), "POST", certs, opts({ raw: "null" }));
    await call(p("import:total-too-large"), "POST", certs, opts({ body: upload(fresh, { chainPem: "A".repeat(300_000), leafPem: "B".repeat(300_000) }) }));
    await call(p("import:body-too-large"), "POST", certs, opts({ body: upload(fresh, { chainPem: "A".repeat(1_200_000) }) }));
    await call(p("import:key-too-large"), "POST", certs, opts({ body: upload(fresh, { privateKeyPem: `${fresh.keyPem}${"C".repeat(200_000)}` }) }));
    await call(p("import:no-idempotency-key"), "POST", certs, opts({ body: upload(fresh), key: null }));
    await call(p("import:idempotency-conflict"), "POST", certs, opts({ body: upload(fresh), key: `${family}-k1` }));
    await call(p("import:replay"), "POST", certs, opts({ body: upload(good), key: `${family}-k1` }));
    await call(p("import:duplicate"), "POST", certs, opts({ body: upload(good, { name: "Again" }) }));
    await call(p("import:unauthenticated"), "POST", certs, { body: upload(fresh), token: null });
    await call(p("import:bad-token"), "POST", certs, { body: upload(fresh), token: "not-a-token" });
    await call(p("import:unknown-site"), "POST", certs.replace(siteA, "ste_unknown"), opts({ body: upload(fresh) }));

    // --- versions ------------------------------------------------------------------------------------------------
    const v2 = leaf(["hotel.it", "www.hotel.it"]);
    const versions = `${certs}/${certificateId}/versions`;
    await call(p("version:happy"), "POST", versions, opts({ body: version(v2) }));
    await call(p("version:mismatch"), "POST", versions, opts({ body: version(fresh, { privateKeyPem: v2.keyPem }) }));
    await call(p("version:expired"), "POST", versions, opts({ body: version(expired) }));
    await call(p("version:malformed"), "POST", versions, opts({ body: version(fresh, { leafPem: "x", privateKeyPem: junkKey() }) }));
    await call(p("version:junk-key-only"), "POST", versions, opts({ body: version(fresh, { privateKeyPem: junkKey() }) }));
    await call(p("version:extra-field"), "POST", versions, opts({ body: version(fresh, { password: fresh.keyPem }) }));
    await call(p("version:with-name"), "POST", versions, opts({ body: upload(fresh) }));
    await call(p("version:key-as-array"), "POST", versions, opts({ body: version(fresh, { privateKeyPem: [fresh.keyPem] }) }));
    await call(p("version:content-type-text"), "POST", versions, opts({ raw: JSON.stringify(version(fresh)), contentType: "text/plain" }));
    await call(p("version:json-truncated"), "POST", versions, opts({ raw: JSON.stringify(version(fresh)).slice(0, -9) }));
    await call(p("version:body-too-large"), "POST", versions, opts({ body: version(fresh, { chainPem: "A".repeat(1_200_000) }) }));
    await call(p("version:total-too-large"), "POST", versions, opts({ body: version(fresh, { chainPem: "A".repeat(300_000), leafPem: "B".repeat(300_000) }) }));
    await call(p("version:unknown-certificate"), "POST", `${certs}/cti_unknown/versions`, opts({ body: version(fresh) }));
    await call(p("version:unauthenticated"), "POST", versions, { body: version(fresh), token: null });
    await call(p("version:no-idempotency-key"), "POST", versions, opts({ body: version(fresh), key: null }));

    // --- assign / activate (bodies that echo-bait) ---------------------------------------------------------------
    const activate = `${certs}/${certificateId}/versions/${versionId}/activate`;
    await call(p("activate:bad-domain-ids"), "POST", activate, opts({ body: { domainIds: [`${MARK}-${good.keyPem}`] } }));
    await call(p("activate:extra-field"), "POST", activate, opts({ body: { domainIds: [], privateKeyPem: good.keyPem, note: MARK } }));
    await call(p("activate:evict-confirm"), "POST", activate, opts({ body: { evictAcme: true, confirmHostname: MARK } }));
    await call(p("activate:unknown-version"), "POST", `${certs}/${certificateId}/versions/ctv_${MARK}/activate`, opts({ body: {} }));
    const hotelId = (await domainRow("hotel.it")).id;
    await call(p("assign:bad-mode"), "POST", `${domainsOf(family)}/${hotelId}/tls`, opts({ body: { mode: MARK, versionId, extra: good.keyPem } }));
    await call(p("assign:unknown-domain"), "POST", `${domainsOf(family)}/dom_${MARK}/tls`, opts({ body: { mode: "manual", versionId } }));
    return { certificateId, versionId };
  }

  beforeAll(async () => {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    }
    for (const stream of [process.stdout, process.stderr]) {
      spies.push(
        vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
          logs.push(String(chunk));
          return true;
        }) as never),
      );
    }
    process.stderr.write("capture-sentinel\n");
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      dnsLookup: { lookup: async () => ({ a: [], aaaa: [] }) },
      domainReconcileIntervalMs: null,
      tlsConvergeIntervalMs: null,
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
      tlsValidatorOptions: { trustAnchors: [PKI.root.pem] },
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call("setup:customer", "POST", "/v1/admin/customer-account", {
      body: { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      token: adminToken,
    });
    orgA = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    tokenA = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    const site = await call("setup:site", "POST", `/v1/organizations/${orgA}/managed-sites`, {
      body: {
        name: "Hotel Bella",
        domain: "hotel.it",
        title: "Hotel Bella title",
        adminUser: "admin",
        adminEmail: "admin@hotel.it",
        adminPassword: "canary-Pass-123456",
        includeWww: true,
      },
    });
    siteA = site.body.data.siteId as string;
    await drain();
    await dbClient.db.update(domains).set({ status: "active" });
    // The setup responses are not part of the canary check (they carry no key), but they must not break it either.

    const customer = await runFamily("customer");
    // The administrator imports the same site's certificate again under another leaf: the families do not share keys.
    const adminRun = await runFamily("admin");
    expect(adminRun.certificateId).not.toBe(customer.certificateId);

    // --- executor failures that carry the key ------------------------------------------------------------------
    const { certificateId, versionId } = customer;
    const activateUrl = `${certsOf("customer")}/${certificateId}/versions/${versionId}/activate`;
    const hotelId = (await domainRow("hotel.it")).id;
    const wwwId = (await domainRow("www.hotel.it")).id;
    // A PEM carried by an error text: whole, and cut off before its END line (both must be redacted wherever they land).
    const carrier = leaf(["hotel.it"]);
    const pemText = `${carrier.keyPem} and ${carrier.keyPem.slice(0, 120)}`;
    const failures: Array<[string, string, (req: { keyPem?: string }) => Error]> = [
      ["putVersion", "put-plain", (req) => new Error(`engine refused ${req.keyPem}`)],
      ["putVersion", "put-store-error", (req) => new ManualTlsStoreError("TLS_MATERIAL_INVALID", `bad material ${req.keyPem} ${MARK}`)],
      ["publish", "publish-coded", () => Object.assign(new Error(`publish failed ${[...canaries].join(" ")}`), { code: "DOCKER_ENGINE_UNAVAILABLE", cause: new Error(MARK) })],
      ["publish", "publish-plain", () => new Error([...canaries].join("\n"))],
    ];
    for (const [action, label, make] of failures) {
      const restore = failOnce(action, make);
      const res = await call(`exec:${label}:activate`, "POST", activateUrl, { body: { domainIds: [hotelId, wwwId] } });
      expect(res.status, `${label} ${res.raw}`).toBe(202);
      await drain();
      restore();
      expect((await tlsOps())[0], label).toMatchObject({ status: "failed" });
    }
    // An ambiguous outcome parks the operation instead of failing it; the error text is the carrier here.
    {
      const restore = failOnce("publish", () => Object.assign(new Error(`socket reset ${pemText}`), { ambiguousOutcome: true }));
      const res = await call("exec:ambiguous:activate", "POST", activateUrl, { body: { domainIds: [hotelId, wwwId] } });
      expect(res.status).toBe(202);
      await drain();
      restore();
      // The converge tick against a still-failing executor must not log the error text either.
      const failing = failOnce("inventory", () => new Error(`inventory down ${pemText}`));
      await app.tlsPublish.converge({ boot: false }).catch(() => undefined);
      await app.tlsPublish.tick().catch(() => undefined);
      failing();
      expect((await tlsOps())[0]).toMatchObject({ status: "unknown" });
      await app.outboxWorker.recoverUnknownOperations();
      await app.tlsPublish.converge({ boot: true }).catch(() => undefined);
      await drain();
    }
    // A clean activation, then both families read everything back.
    for (const family of ["customer", "admin"] as const) {
      await call(`read:${family}:list`, "GET", certsOf(family), { token: tokenOf(family) });
      await call(`read:${family}:get`, "GET", `${certsOf(family)}/${certificateId}`, { token: tokenOf(family) });
      await call(`read:${family}:domains`, "GET", domainsOf(family), { token: tokenOf(family) });
    }
    await call("read:admin:inventory", "GET", "/v1/admin/tls-certificates", { token: adminToken });
    await call("read:admin:alerts", "GET", "/v1/admin/tls-certificates/alerts", { token: adminToken });
    await call("read:admin:health", "GET", "/v1/admin/health", { token: adminToken });
    const ok = await call("exec:ok:activate", "POST", activateUrl, { body: { domainIds: [hotelId, wwwId] } });
    expect(ok.status, `${ok.raw} ${JSON.stringify((await tlsOps()).map((o) => [o.status, o.errorCode]))}`).toBe(202);
    await drain();
    await call("read:customer:after-ok", "GET", certsOf("customer"));
  }, 240_000);

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  /** Every row of every table, except the key ciphertext columns of tls_certificate_versions. */
  async function dumpAllTables(): Promise<Record<string, string>> {
    const rowsOf = (result: unknown): Json[] => (Array.isArray(result) ? result : ((result as { rows?: Json[] }).rows ?? [])) as Json[];
    const names = rowsOf(
      await dbClient.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`),
    ).map((r) => String(r["table_name"]));
    const out: Record<string, string> = {};
    for (const name of names) {
      const rows = rowsOf(await dbClient.db.execute(sql.raw(`select row_to_json(t)::text as j from "${name}" t`)));
      out[name] = rows
        .map((r) => {
          const row = JSON.parse(String(r["j"])) as Json;
          if (name === "tls_certificate_versions") for (const k of Object.keys(row)) if (k.startsWith("key_")) delete row[k];
          return JSON.stringify(row);
        })
        .join("\n");
    }
    return out;
  }

  describe("responses", () => {

    it("the scenario ran: import 201, the refusals are 4xx with a stable code, nothing is a 5xx", () => {
      expect(dataOf("customer:import:happy").status).toBe(201);
      expect(dataOf("admin:import:happy").status).toBe(201);
      for (const [label, res] of seen) {
        expect(res.status, `${label} ${res.raw.slice(0, 200)}`).toBeLessThan(500);
        if (label.startsWith("setup:") || label.startsWith("read:") || res.status < 400) continue;
        // Every refusal is a JSON envelope with a code, never a framework stack, an HTML page or an empty body.
        expect(res.body.error?.code, `${label} ${res.raw.slice(0, 200)}`).toEqual(expect.any(String));
      }
    });

    it("pins the refusal statuses the key-bearing variants must produce", () => {
      for (const family of ["customer", "admin"]) {
        const expectStatus = (name: string, statuses: number[], code?: string) => {
          const res = dataOf(`${family}:${name}`);
          expect(statuses, `${family}:${name} -> ${res.status} ${res.raw.slice(0, 160)}`).toContain(res.status);
          if (code) expect(res.body.error?.code, `${family}:${name}`).toBe(code);
        };
        expectStatus("import:mismatch", [422], "CERTIFICATE_KEY_MISMATCH");
        expectStatus("import:expired", [422], "CERTIFICATE_EXPIRED");
        expectStatus("import:malformed-pem", [422], "CERTIFICATE_FORMAT_UNSUPPORTED");
        expectStatus("import:extra-field", [400], "VALIDATION_ERROR");
        expectStatus("import:key-as-array", [400], "VALIDATION_ERROR");
        expectStatus("import:content-type-text", [400, 415]);
        expectStatus("import:json-truncated", [400]);
        expectStatus("import:json-key-first", [400]);
        expectStatus("import:total-too-large", [413], "CERTIFICATE_UPLOAD_TOO_LARGE");
        expectStatus("import:body-too-large", [413], "CERTIFICATE_UPLOAD_TOO_LARGE");
        expectStatus("import:no-idempotency-key", [400], "VALIDATION_ERROR");
        expectStatus("import:idempotency-conflict", [409], "IDEMPOTENCY_CONFLICT");
        expectStatus("import:replay", [201]);
        expectStatus("import:duplicate", [409], "ALREADY_EXISTS");
        expectStatus("import:unauthenticated", [401]);
        expectStatus("import:unknown-site", [403, 404]);
        expectStatus("version:happy", [201]);
        expectStatus("version:mismatch", [422], "CERTIFICATE_KEY_MISMATCH");
        expectStatus("version:with-name", [400], "VALIDATION_ERROR");
        expectStatus("version:unknown-certificate", [404], "NOT_FOUND");
        expectStatus("version:total-too-large", [413], "CERTIFICATE_UPLOAD_TOO_LARGE");
        expectStatus("version:body-too-large", [413], "CERTIFICATE_UPLOAD_TOO_LARGE");
        expectStatus("activate:bad-domain-ids", [400], "VALIDATION_ERROR");
        expectStatus("assign:bad-mode", [400], "VALIDATION_ERROR");
      }
    });

    // Former defect 1 (fixed): a PEM block whose body holds a character outside base64 (here "-") passes checkPemShape but is not
    // matched by pemBlocks()'s `[^-]*` body, so `pemBlocks(...)[0]!.der` throws a TypeError -> 500 INTERNAL_ERROR
    // instead of 422 (tls-certificate-validator.ts:287-292, leaf and key alike; also on the version route).
    it("a PEM block with a non-base64 body is a 4xx, never a 500", () => {
      for (const family of ["customer", "admin"]) {
        for (const name of ["import:junk-key-only", "import:junk-leaf", "version:junk-key-only"]) {
          const res = dataOf(`${family}:${name}`);
          expect([400, 422], `${family}:${name} -> ${res.status}`).toContain(res.status);
        }
      }
    });

    // Former defect 2 (fixed, pre-existing, every route): Fastify's 415 for a content type with no parser is not mapped by
    // ApiExceptionFilter (HttpException status 415 -> the `else` branch) and answers 500 INTERNAL_ERROR.
    it("an unsupported content type (form, xml) is a 400 VALIDATION_ERROR, never a 500", () => {
      for (const family of ["customer", "admin"]) {
        for (const name of ["import:content-type-form", "import:content-type-xml"]) {
          const res = dataOf(`${family}:${name}`);
          expect(res.status, `${family}:${name}`).toBe(400);
          expect(res.body.error?.code, `${family}:${name}`).toBe("VALIDATION_ERROR");
        }
      }
    });

    it("no response of any variant, on customer or administrator routes, contains a canary or a key-shaped PEM", () => {
      const leaks = [...seen]
        .filter(([label]) => !label.startsWith("setup:"))
        .map(([label, res]) => [label, leaksIn(res.raw)] as const)
        .filter(([, found]) => found.length > 0);
      expect(leaks).toEqual([]);
      // The oversize answers must not echo the body they refused.
      for (const label of [...seen.keys()].filter((l) => l.includes("too-large"))) {
        expect(dataOf(label).raw.length, label).toBeLessThan(2_000);
      }
    });
  });

  describe("storage", () => {
    it("refused imports leave nothing behind: one certificate per family, nothing for any refused variant", async () => {
      const certs = await dbClient.db.select().from(tlsCertificates);
      expect(certs).toHaveLength(2);
      const versions = await dbClient.db.select().from(tlsCertificateVersions);
      // import + the one happy version per family
      expect(versions).toHaveLength(4);
      const imports = (await dbClient.db.select().from(auditEvents)).filter((a) => a.action === "site.tls_certificate.import");
      expect(imports).toHaveLength(2);
    });

    it("the stored version holds ciphertext only: no PEM, no key bytes, readable only with the master key and its own context", async () => {
      const versions = await dbClient.db.select().from(tlsCertificateVersions);
      for (const row of versions) {
        const { leafPem, chainPem, keyCiphertextBase64, keyIvBase64, keyAuthTagBase64, ...rest } = row;
        expect(leafPem).toContain("BEGIN CERTIFICATE");
        expect(leafPem).not.toMatch(/PRIVATE KEY/);
        expect(chainPem).not.toMatch(/PRIVATE KEY/);
        expect(leaksIn(JSON.stringify(rest))).toEqual([]);
        for (const cell of [keyCiphertextBase64, keyIvBase64, keyAuthTagBase64]) {
          expect(cell).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
          const decoded = Buffer.from(cell, "base64");
          expect(decoded.toString("latin1")).not.toMatch(/PRIVATE|BEGIN|END/);
          expect(leaksIn(cell)).toEqual([]);
          expect(leaksIn(decoded.toString("latin1"))).toEqual([]);
        }
        // AES-GCM: 96-bit IV, 128-bit tag; the ciphertext is at least as long as the key.
        expect(Buffer.from(keyIvBase64, "base64")).toHaveLength(12);
        expect(Buffer.from(keyAuthTagBase64, "base64")).toHaveLength(16);
        expect(Buffer.from(keyCiphertextBase64, "base64").length).toBeGreaterThan(100);
        const key = await readTlsVersionKey(dbClient.db, { versionId: row.id, masterKey: KEY });
        expect(key.privateKeyPem).toContain("PRIVATE KEY");
        // A wrong master key must fail, and the failure must not carry the material.
        const wrong = await readTlsVersionKey(dbClient.db, { versionId: row.id, masterKey: Buffer.alloc(32, 9) }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(wrong).not.toBeNull();
        expect(leaksIn(String((wrong as Error).message) + String((wrong as Error).stack))).toEqual([]);
      }
    });

    it("two versions never share an IV, and the ciphertext of the same key differs from its plaintext", async () => {
      const versions = await dbClient.db.select().from(tlsCertificateVersions);
      expect(new Set(versions.map((v) => v.keyIvBase64)).size).toBe(versions.length);
      expect(new Set(versions.map((v) => v.keyCiphertextBase64)).size).toBe(versions.length);
    });

    it("the certificate DTOs expose metadata only: exact key sets, no key or PEM field", () => {
      const dto = dataOf("customer:import:happy").body.data as Json;
      expect(Object.keys(dto).sort()).toEqual(
        ["activeVersionId", "assignedDomains", "coveredDomains", "createdForSiteId", "expiry", "id", "name", "source", "updatedAt", "versions", "warnings"].sort(),
      );
      expect(Object.keys(dto.versions[0]).sort()).toEqual(
        ["activatedAt", "createdAt", "fingerprintSha256", "id", "issuer", "keyBits", "keyType", "notAfter", "notBefore", "problem", "sanDns", "serialNumber", "status", "subject", "versionNumber", "wildcard"].sort(),
      );
      for (const label of ["read:customer:list", "read:admin:list", "read:customer:after-ok"]) {
        for (const c of dataOf(label).body.data as Json[]) {
          for (const v of c.versions as Json[]) expect(Object.keys(v).some((k) => /pem|key(?!Type|Bits)|cipher|secret/i.test(k)), `${label} ${Object.keys(v)}`).toBe(false);
        }
      }
    });
  });

  describe("audit, outbox, operations", () => {
    it("audit details have exact key sets and carry ids, fingerprints and dates only", async () => {
      const rows = await dbClient.db.select().from(auditEvents);
      const sets = new Map<string, Set<string>>();
      for (const row of rows.filter((r) => r.action.startsWith("site.tls_certificate."))) {
        const keys = Object.keys((row.details ?? {}) as Json).sort().join(",");
        const bucket = sets.get(row.action) ?? new Set<string>();
        bucket.add(keys);
        sets.set(row.action, bucket);
      }
      const asSet = (...keys: string[]) => keys.sort().join(",");
      const expected: Record<string, string[]> = {
        "site.tls_certificate.import": [asSet("certificateId", "fingerprintSha256", "notAfter", "outcome", "requestId", "sanCount", "siteId", "versionId", "wildcard")],
        "site.tls_certificate.replace": [
          asSet("certificateId", "fingerprintSha256", "notAfter", "outcome", "previousVersionId", "requestId", "sanCount", "siteId", "versionId", "versionNumber", "wildcard"),
        ],
      };
      for (const [action, keys] of Object.entries(expected)) expect([...(sets.get(action) ?? [])], action).toEqual(keys);
      // Assignment and apply audits: ids only, whatever optional parts appear.
      const allowed: Record<string, string[]> = {
        "site.tls_certificate.assign": ["operationId", "siteId", "domainIds", "versionId", "fromVersionIds", "confirmHostname", "outcome", "requestId"],
        "site.tls_certificate.unassign": ["operationId", "siteId", "domainIds", "versionId", "challenge", "outcome", "requestId"],
        "site.tls_certificate.applied": ["operationId", "domainIds", "versionIds", "inactivatedVersionIds", "removedVersionIds", "evicted", "collateralHosts"],
        "site.tls_certificate.apply_failed": ["operationId", "siteId", "versionId", "step", "code"],
      };
      for (const [action, allowedKeys] of Object.entries(allowed)) {
        for (const keySet of sets.get(action) ?? []) {
          for (const key of keySet.split(",")) expect(allowedKeys, `${action} has unexpected key ${key}`).toContain(key);
        }
      }
      expect(sets.has("site.tls_certificate.import")).toBe(true);
      expect(sets.has("site.tls_certificate.apply_failed")).toBe(true);
      expect(sets.has("site.tls_certificate.applied")).toBe(true);
      const failed = rows.filter((r) => r.action === "site.tls_certificate.apply_failed");
      expect(failed.map((r) => Object.keys(r.details as Json).sort().join(","))).toEqual(failed.map(() => asSet("code", "operationId", "siteId", "step", "versionId")));
      expect(new Set(failed.map((r) => (r.details as Json)["code"])).size).toBeGreaterThan(0);
      for (const r of failed) expect(r.details as Json).toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/), step: expect.stringMatching(/^(stage|publish|routes)$/) });
    });

    it("no audit row, outbox event, operation or operation step contains a canary", async () => {
      for (const [name, table] of [
        ["audit_events", auditEvents],
        ["outbox_events", outboxEvents],
        ["operations", operations],
        ["operation_steps", operationSteps],
      ] as const) {
        const rows = JSON.stringify(await dbClient.db.select().from(table));
        expect(leaksIn(rows), name).toEqual([]);
      }
    });

    it("the failed and parked operations carry a fixed text, not the executor message", async () => {
      const ops = await tlsOps();
      const failed = ops.filter((o) => o.status === "failed");
      expect(failed.length).toBeGreaterThanOrEqual(4);
      for (const op of failed) {
        expect(op.errorCode).toEqual(expect.any(String));
        expect(op.errorMessage ?? "").not.toMatch(/engine refused|bad material|publish failed|inventory down|socket reset/);
        expect(leaksIn(JSON.stringify(op))).toEqual([]);
      }
      const events = await dbClient.db.select().from(outboxEvents);
      for (const e of events.filter((x) => JSON.stringify(x).includes("site.tls.apply"))) {
        expect(leaksIn(JSON.stringify(e))).toEqual([]);
      }
    });

    it("the site.tls.apply outbox payload names versions and domains, never material", async () => {
      const events = (await dbClient.db.select().from(outboxEvents)).filter((e) => JSON.stringify(e).includes("site.tls.apply"));
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        const payload = e.payload as Json;
        expect(Object.keys(payload).every((k) => ["kind", "siteId", "changes", "evictAcme", "challenge", "resourceId", "resourceType", "operationId", "organizationId"].includes(k)), JSON.stringify(Object.keys(payload))).toBe(true);
      }
    });

    it("every other table is canary free too, and the simulator saw the key only on putVersion", async () => {
      const dump = await dumpAllTables();
      const leaky = Object.entries(dump).filter(([, text]) => leaksIn(text).length > 0).map(([name]) => name);
      expect(leaky).toEqual([]);
      expect(JSON.stringify(sim.manualTlsCalls)).not.toMatch(/PRIVATE KEY|keyPem/);
    });
  });

  describe("logs", () => {
    it("console, stdout and stderr never saw a canary or a key-shaped PEM, whatever the executor error said", () => {
      const text = logs.join("\n");
      expect(leaksIn(text)).toEqual([]);
      expect(text).not.toMatch(/engine refused|bad material|publish failed|inventory down|socket reset/);
    });

    it("the scenario really failed through the executor and the capture works (the log check is not vacuous)", async () => {
      const failed = (await tlsOps()).filter((o) => o.status === "failed").length;
      expect(failed).toBeGreaterThanOrEqual(4);
      expect(canaries.size).toBeGreaterThan(20);
      expect(logs).toContain("capture-sentinel\n");
      expect(logs.join("\n")).toContain("capture-sentinel");
    });
  });
});
