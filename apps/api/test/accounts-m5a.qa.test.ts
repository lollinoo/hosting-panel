import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import { auditEvents, createDatabaseClient, eq, passwordResetTokens, sql, users, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { PanelMailRequest } from "@hosting-panel/executor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// index.js first: the reset service sits in the import cycle cli/accounts -> create-app -> app.module.
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { PasswordResetService } from "../src/auth/password-reset.service.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 9);
const PW = "sentinel-admin-pass";
const NEW_PW = "sentinel-new-pass-1";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const RELAY = { host: "smtp.example.test", port: 587, username: "relay", password: "sentinel-relay-pass", senderDomain: "mail.example.test" };
const ADMIN = "admin@example.test";
const CUSTOMER = "customer@example.test";
const RID = "req-qa-fixed";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const step = () => Math.floor(Date.now() / 30_000);

describe("M5a accounts QA", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let service: PasswordResetService;
  let adminId: string;
  let adminTotp: string;
  let adminToken: string;
  let customerId: string;
  let customerPassword: string;

  async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Request-Id": RID, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: (raw ? JSON.parse(raw) : {}) as Json, headers: res.headers };
  }
  const login = (email: string, password: string, totp?: string) =>
    call("POST", "/v1/auth/login", { email, password, ...(totp ? { totpCode: totpCodeAt(totp, step()) } : {}) });
  const request = (email: string) => call("POST", "/v1/auth/password-reset/request", { email });
  const confirm = (token: string, newPassword = NEW_PW) => call("POST", "/v1/auth/password-reset/confirm", { token, newPassword });
  const tokenOf = (m: PanelMailRequest) => m.link.split("#")[1]!;
  const me = async (token: string) => (await call("GET", "/v1/me", undefined, token)).status;
  const userRow = async (id: string) => (await dbClient.db.select().from(users).where(eq(users.id, id)))[0]!;
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  // Status, body and every header but date: the request id is pinned by the caller, so it is equal too.
  const shape = (r: { status: number; raw: string; headers: Headers }) => ({
    status: r.status,
    raw: r.raw,
    headers: Object.fromEntries([...r.headers].filter(([k]) => k !== "date")),
  });

  async function addUser(email: string, fields: Partial<typeof users.$inferInsert> = {}) {
    const id = `usr_${email.split("@")[0]!.replace(/\W/g, "")}`;
    await dbClient.db.insert(users).values({ id, email, name: "Sentinel", passwordHash: await hashPassword("sentinel-old-pass"), ...fields });
    return id;
  }

  async function configureRelay() {
    expect((await call("PATCH", "/v1/admin/mail-relay", RELAY, adminToken)).status).toBe(200);
    await app.mailRelay.ensureApplied();
  }

  async function requestMail(email = CUSTOMER): Promise<PanelMailRequest> {
    const before = sim.panelMails.length;
    expect((await request(email)).status).toBe(202);
    await service.idle();
    expect(sim.panelMails).toHaveLength(before + 1);
    return sim.panelMails.at(-1)!;
  }

  async function newAdmin(email: string) {
    const a = await createServerAdmin(dbClient.db, KEY, { email, name: "Sentinel Admin", password: PW });
    const token = (await login(email, PW, a.totpSecretBase32)).body.data.accessToken as string;
    expect(token).toEqual(expect.any(String));
    return { id: a.userId, token, totp: a.totpSecretBase32 };
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: ADMIN, name: "Admin", password: PW });
    adminId = admin.userId;
    adminTotp = admin.totpSecretBase32;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
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
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    service = app.nestApp.get(PasswordResetService);
    adminToken = (await login(ADMIN, PW, adminTotp)).body.data.accessToken as string;
    const created = await call("POST", "/v1/admin/customer-account", { organizationName: "Customer Org", ownerEmail: CUSTOMER, ownerName: "Customer" }, adminToken);
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, CUSTOMER);
    customerPassword = created.body.data.temporaryPassword as string;
    customerId = created.body.data.userId as string;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  describe("1. the answer of the request route never tells", () => {
    it("is the same while mail is off, an account's limit is used, the overall limit is used and the pending bound is full", async () => {
      const baseline = shape(await request("nobody@example.test"));
      expect(baseline).toMatchObject({ status: 202, raw: "" });
      const answers: Array<[string, ReturnType<typeof shape>]> = [];

      answers.push(["mail not configured", shape(await request(CUSTOMER))]);
      await service.idle();
      expect(sim.panelMails).toEqual([]);

      await configureRelay();
      await request(CUSTOMER);
      await request(CUSTOMER);
      await service.idle();
      answers.push(["account limit used", shape(await request(CUSTOMER))]);
      answers.push(["account limit used, other case", shape(await request(" CUSTOMER@Example.Test "))]);
      await service.idle();
      expect(sim.panelMails).toHaveLength(2);

      // 3 rows are the customer's; 17 more fill the overall budget of 20.
      const filler = await addUser("filler@example.test");
      for (let i = 0; i < 17; i++) {
        await dbClient.db.insert(passwordResetTokens).values({ id: `prt_fill${i}`, userId: filler, tokenHash: sha256(`fill-${i}`), expiresAt: new Date(Date.now() + 600_000) });
      }
      await addUser("fresh@example.test");
      answers.push(["overall limit used", shape(await request("fresh@example.test"))]);
      await service.idle();
      expect(sim.panelMails).toHaveLength(2);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const deliver = vi.spyOn(service, "deliver").mockImplementation(() => gate);
      for (let i = 0; i < 32; i++) await request(`held${i}@example.test`);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(32));
      answers.push(["pending bound full", shape(await request("fresh@example.test"))]);
      release();
      await service.idle();

      for (const [what, a] of answers) expect(a, what).toEqual(baseline);
    });
  });

  describe("2. a link works once and expires", () => {
    it("works just inside its 30 minutes and not just outside", async () => {
      await configureRelay();
      const inside = tokenOf(await requestMail());
      await dbClient.db.execute(
        sql`UPDATE password_reset_tokens SET created_at = now() - interval '29 minutes 55 seconds', expires_at = now() + interval '5 seconds' WHERE token_hash = ${sha256(inside)}`,
      );
      expect((await confirm(inside)).status).toBe(204);

      const outside = tokenOf(await requestMail());
      await dbClient.db.execute(
        sql`UPDATE password_reset_tokens SET created_at = now() - interval '30 minutes 1 second', expires_at = now() - interval '1 second' WHERE token_hash = ${sha256(outside)}`,
      );
      const res = await confirm(outside, "sentinel-new-pass-2");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PASSWORD_RESET_INVALID");
      expect((await login(CUSTOMER, NEW_PW)).status).toBe(200);
    });

    it("the row is written with a 30-minute lifetime", async () => {
      await configureRelay();
      const token = tokenOf(await requestMail());
      const [row] = await dbClient.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, sha256(token)));
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(30 * 60_000);
    });

    it("two confirms at once with one token: one 204, one PASSWORD_RESET_INVALID, the winner's password works", async () => {
      await configureRelay();
      const token = tokenOf(await requestMail());
      const pws = ["sentinel-race-pass-a", "sentinel-race-pass-b"];
      const res = await Promise.all(pws.map((p) => confirm(token, p)));
      expect(res.map((r) => r.status).sort()).toEqual([204, 400]);
      const loser = res.findIndex((r) => r.status === 400);
      expect(res[loser]!.body.error.code).toBe("PASSWORD_RESET_INVALID");
      expect((await login(CUSTOMER, pws[1 - loser]!)).status).toBe(200);
      expect((await login(CUSTOMER, pws[loser]!)).status).toBe(401);
      expect(await audits("auth.password_reset.completed")).toHaveLength(1);
    });

    it("a malformed token is a 400, never a 500, and the real token still works afterwards", async () => {
      await configureRelay();
      const token = tokenOf(await requestMail());
      const swapped = [...token].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
      expect(swapped).not.toBe(token);
      for (const bad of [token.slice(0, -1), `${token}A`, swapped, ` ${token}`, `${token} `, "", "x".repeat(10_000)]) {
        const res = await confirm(bad);
        expect(res.status, JSON.stringify(bad.slice(0, 50))).toBe(400);
        expect(["PASSWORD_RESET_INVALID", "VALIDATION_ERROR"]).toContain(res.body.error.code);
        // An error message never echoes the token or the password.
        expect(res.raw).not.toContain(token.slice(0, 20));
        expect(res.raw).not.toContain(NEW_PW);
      }
      const weak = await confirm(token, "qzxv");
      expect(weak.status).toBe(400);
      expect(weak.raw).not.toContain("qzxv");
      expect((await confirm(token)).status).toBe(204);
    });
  });

  describe("3. an administrator is never reset by mail", () => {
    it("a planted token for an administrator is refused; hash and sessions stay", async () => {
      const token = "sentinel-planted-token";
      await dbClient.db.insert(passwordResetTokens).values({ id: "prt_planted", userId: adminId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 600_000) });
      const before = (await userRow(adminId)).passwordHash;
      const res = await confirm(token);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PASSWORD_RESET_INVALID");
      expect((await userRow(adminId)).passwordHash).toBe(before);
      expect(await me(adminToken)).toBe(200);
      expect(await audits("auth.password_reset.completed")).toEqual([]);
    });
  });

  describe("4. the mail and its link", () => {
    it("the link's origin ignores forged Host, X-Forwarded-Host, Forwarded and Origin; the token is only in the fragment", async () => {
      await configureRelay();
      const body = JSON.stringify({ email: CUSTOMER });
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${app.baseUrl!}/v1/auth/password-reset/request`,
          {
            method: "POST",
            headers: {
              Host: "evil.example.test",
              "X-Forwarded-Host": "evil.example.test",
              "X-Forwarded-Proto": "http",
              Forwarded: "host=evil.example.test;proto=http",
              Origin: "https://evil.example.test",
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      expect(status).toBe(202);
      await service.idle();
      expect(sim.panelMails).toHaveLength(1);
      const url = new URL(sim.panelMails[0]!.link);
      expect(url.origin).toBe("https://panel.example.test");
      expect(url.pathname).toBe("/reset-password");
      expect(url.search).toBe("");
      const token = url.hash.slice(1);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sim.panelMails[0]!.link.indexOf(token)).toBe(sim.panelMails[0]!.link.indexOf("#") + 1);
    });

    it("an address carrying a line break, a second address or a header never reaches the mail with a line break", async () => {
      await configureRelay();
      await addUser("a@example.test");
      for (const email of ["a@example.test\r\nBcc: b@example.test", "a@example.test, b@example.test", "a@example.test\nb@example.test", "a@example.test;b@example.test"]) {
        expect([202, 400]).toContain((await request(email)).status);
      }
      await service.idle();
      for (const m of sim.panelMails) {
        expect(m.to).not.toMatch(/[\r\n,;]/);
        expect(m.to).not.toContain("b@example.test");
      }
      // Control: the plain address does get its mail, so the refusals above are not a dead pipeline.
      const before = sim.panelMails.length;
      expect((await requestMail("a@example.test")).to).toBe("a@example.test");
      expect(sim.panelMails).toHaveLength(before + 1);
    });
  });

  describe("5. no secret where it does not belong", () => {
    it("one scenario through everything leaves no secret in any table, console line or simulator record", async () => {
      const lines: unknown[] = [];
      for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args));
      }
      for (const s of [process.stdout, process.stderr]) {
        const orig = s.write.bind(s);
        vi.spyOn(s, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          lines.push(String(chunk));
          return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof s.write);
      }

      const created = await call("POST", "/v1/admin/administrators", { email: "second@example.test", name: "Second" }, adminToken);
      expect(created.status).toBe(201);
      const { temporaryPassword, totpSecretBase32, otpauthUri, userId } = created.body.data as Record<string, string>;
      expect((await login("second@example.test", temporaryPassword!)).body.data.status).toBe("totp_required");
      expect((await login("second@example.test", temporaryPassword!, totpSecretBase32)).status).toBe(200);

      await configureRelay();
      const first = tokenOf(await requestMail());
      const mail = await requestMail();
      const token = tokenOf(mail);
      expect(token).not.toBe(first);
      for (const t of [first, token]) expect(Buffer.from(t, "base64url")).toHaveLength(32);
      const refusedPw = "sentinel-refused-pass-9";
      expect((await confirm(`${token.slice(0, -2)}xx`, refusedPw)).status).toBe(400);
      expect((await confirm(token)).status).toBe(204);

      const [stored] = await dbClient.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, sha256(token)));
      expect(stored!.tokenHash).not.toBe(token);
      expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      const secrets = { temporaryPassword, totpSecretBase32, otpauthUri, token, first, link: mail.link, NEW_PW, refusedPw };
      const tables = (await dbClient.db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )).rows.map((r) => r.table_name);
      expect(tables).toContain("password_reset_tokens");
      expect(tables.length).toBeGreaterThan(10);
      for (const t of tables) {
        const dump = JSON.stringify((await dbClient.db.execute(sql.raw(`SELECT * FROM "${t}"`))).rows);
        for (const [name, s] of Object.entries(secrets)) expect(dump, `${t} holds ${name}`).not.toContain(s);
        if (t !== "password_reset_tokens") expect(dump, `${t} holds a token hash`).not.toContain(sha256(token));
      }
      const logged = JSON.stringify(lines);
      for (const [name, s] of Object.entries(secrets)) expect(logged, `console holds ${name}`).not.toContain(s);

      const seen = new WeakSet<object>();
      const records = JSON.stringify(
        Object.fromEntries(Object.entries(sim).filter(([k]) => k !== "panelMails")),
        (_k, v: unknown) => {
          if (v instanceof Map) return [...v.entries()];
          if (v instanceof Set) return [...v];
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return undefined;
            seen.add(v);
          }
          return v;
        },
      );
      for (const [name, s] of Object.entries(secrets)) expect(records, `simulator holds ${name}`).not.toContain(s);

      const listed = (await call("GET", "/v1/admin/users", undefined, adminToken)).raw;
      expect(listed).toContain(userId);
      for (const s of [temporaryPassword!, totpSecretBase32!, otpauthUri!]) expect(listed).not.toContain(s);
    });
  });

  describe("6. the last active administrator", () => {
    it("the router has no other route that takes an administrator's access away", () => {
      const routes: string[] = [];
      for (const mod of app.nestApp.get(ModulesContainer).values()) {
        for (const wrapper of mod.controllers.values()) {
          const ctl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
          if (!ctl) continue;
          const base = String(Reflect.getMetadata(PATH_METADATA, ctl) ?? "");
          for (const name of Object.getOwnPropertyNames(ctl.prototype)) {
            const fn = (ctl.prototype as Record<string, unknown>)[name];
            if (typeof fn !== "function" || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
            const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
            routes.push(`${method} ${[base, String(Reflect.getMetadata(PATH_METADATA, fn))].filter((p) => p && p !== "/").join("/")}`);
          }
        }
      }
      expect(routes.length).toBeGreaterThan(40);
      // Any non-GET route on a panel account (not a site's own SFTP, database or WordPress users) could take access away.
      const risky = routes.filter((r) => !r.startsWith("GET ") && !r.includes("managed-sites") && /users|administrators|members|:userId/.test(r));
      expect(risky.sort()).toEqual([
        "DELETE v1/organizations/:orgId/members/:memberId",
        "PATCH v1/admin/users/:userId",
        "POST v1/admin/administrators",
        "POST v1/admin/users/:userId/reset-password",
        "POST v1/admin/users/:userId/reset-totp",
      ]);
    });

    it("ten times over, two administrators disabling each other at once: one wins, at least one stays active", async () => {
      for (let i = 0; i < 10; i++) {
        await dbClient.db.update(users).set({ userStatus: "disabled" }).where(eq(users.platformRole, "infrastructure_admin"));
        const a = await newAdmin(`pair${i}a@example.test`);
        const b = await newAdmin(`pair${i}b@example.test`);
        const res = await Promise.all([
          call("PATCH", `/v1/admin/users/${b.id}`, { status: "disabled" }, a.token),
          call("PATCH", `/v1/admin/users/${a.id}`, { status: "disabled" }, b.token),
        ]);
        const statuses = res.map((r) => r.status).sort();
        expect(statuses.filter((s) => s === 200), `round ${i}: ${statuses}`).toHaveLength(1);
        const loser = res.find((r) => r.status !== 200)!;
        expect([401, 409], `round ${i}`).toContain(loser.status);
        if (loser.status === 409) expect(loser.body.error.code).toBe("LAST_ADMINISTRATOR_PROTECTED");
        const active = (await dbClient.db.select().from(users).where(eq(users.platformRole, "infrastructure_admin"))).filter((u) => u.userStatus === "active");
        expect(active, `round ${i}`).toHaveLength(1);
      }
    });

    it("a disabled administrator does not count as active; disabled, they cannot log in; enabled, they can", async () => {
      const b = await newAdmin("b@example.test");
      const c = await newAdmin("c@example.test");
      expect((await call("PATCH", `/v1/admin/users/${b.id}`, { status: "disabled" }, adminToken)).status).toBe(200);
      expect(await me(b.token)).toBe(401);
      expect((await login("b@example.test", PW, b.totp)).status).not.toBe(200);
      expect((await login("b@example.test", PW)).body.data?.accessToken).toBeUndefined();

      // The caller passes its own check, then is disabled: only the disabled b and the target c are left.
      const real = app.authz.authenticateRequest.bind(app.authz);
      vi.spyOn(app.authz, "authenticateRequest").mockImplementationOnce(async (req) => {
        const auth = await real(req);
        await dbClient.db.update(users).set({ userStatus: "disabled" }).where(eq(users.id, adminId));
        return auth;
      });
      const res = await call("PATCH", `/v1/admin/users/${c.id}`, { status: "disabled" }, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LAST_ADMINISTRATOR_PROTECTED");
      expect((await userRow(c.id)).userStatus).toBe("active");

      expect((await call("PATCH", `/v1/admin/users/${b.id}`, { status: "active" }, c.token)).status).toBe(200);
      expect((await login("b@example.test", PW)).body.data.status).toBe("totp_required");
    });
  });

  describe("7. a new administrator", () => {
    it("an address of a customer, in another case, is refused and the customer is unchanged", async () => {
      const before = await userRow(customerId);
      const res = await call("POST", "/v1/admin/administrators", { email: " Customer@EXAMPLE.test ", name: "Takeover" }, adminToken);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(await userRow(customerId)).toEqual(before);
      expect((await login(CUSTOMER, customerPassword)).status).toBe(200);
      expect(await audits("admin.administrator.create")).toEqual([]);
    });

    it("a name with markup is stored as text; an address with markup is refused", async () => {
      const name = "<script>alert(1)</script> & \"Admin\"";
      const ok = await call("POST", "/v1/admin/administrators", { email: "markup@example.test", name }, adminToken);
      expect(ok.status).toBe(201);
      expect((await userRow(ok.body.data.userId as string)).name).toBe(name);
      const listed = (await call("GET", "/v1/admin/users", undefined, adminToken)).body.data as Json[];
      expect(listed.find((u) => u.email === "markup@example.test")!.name).toBe(name);

      const bad = await call("POST", "/v1/admin/administrators", { email: "<script>@example.test", name: "X" }, adminToken);
      expect(bad.status).toBe(400);
      expect(await dbClient.db.select().from(users).where(eq(users.email, "<script>@example.test"))).toEqual([]);
    });
  });

  describe("8. after a reset", () => {
    it("a customer with the second factor still needs it, and the audit rows hold no address or secret", async () => {
      await configureRelay();
      const session = (await login(CUSTOMER, customerPassword)).body.data.accessToken as string;
      const setup = await call("POST", "/v1/me/totp/setup", {}, session);
      expect(setup.status).toBe(200);
      const secret = setup.body.data.secretBase32 as string;
      expect((await call("POST", "/v1/me/totp/enable", { code: totpCodeAt(secret, step()) }, session)).status).toBe(204);

      const token = tokenOf(await requestMail());
      expect((await confirm(token)).status).toBe(204);
      const after = await login(CUSTOMER, NEW_PW);
      expect(after.body.data.status).toBe("totp_required");
      expect(after.body.data.accessToken).toBeUndefined();

      const rows = [...(await audits("auth.password_reset.requested")), ...(await audits("auth.password_reset.completed"))];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actorType: "system", actorId: null, details: { delivery: "queued" } });
      expect(rows[1]).toMatchObject({ actorType: "user", actorId: customerId, details: {} });
      const dump = JSON.stringify(rows);
      for (const s of [CUSTOMER, token, sha256(token), NEW_PW, secret, "panel.example.test"]) expect(dump).not.toContain(s);
    });
  });

  describe("9. the limits at their edges", () => {
    it("a request just inside the hour still counts, one just outside does not", async () => {
      await configureRelay();
      for (let i = 0; i < 3; i++) await requestMail();
      await request(CUSTOMER);
      await service.idle();
      expect(sim.panelMails).toHaveLength(3);

      const oldest = sql`(SELECT id FROM password_reset_tokens WHERE user_id = ${customerId} ORDER BY created_at LIMIT 1)`;
      await dbClient.db.execute(sql`UPDATE password_reset_tokens SET created_at = now() - interval '59 minutes 50 seconds' WHERE id = ${oldest}`);
      await request(CUSTOMER);
      await service.idle();
      expect(sim.panelMails).toHaveLength(3);

      await dbClient.db.execute(sql`UPDATE password_reset_tokens SET created_at = now() - interval '60 minutes 1 second' WHERE id = ${oldest}`);
      await requestMail();
      expect(sim.panelMails).toHaveLength(4);
    });

    it("the overall limit: the 20th request sends, the 21st does not, and an hour-old one frees a place", async () => {
      await configureRelay();
      const filler = await addUser("filler@example.test");
      for (let i = 0; i < 19; i++) {
        await dbClient.db.insert(passwordResetTokens).values({ id: `prt_fill${i}`, userId: filler, tokenHash: sha256(`fill-${i}`), expiresAt: new Date(Date.now() + 600_000) });
      }
      await requestMail();
      await request(CUSTOMER);
      await service.idle();
      expect(sim.panelMails).toHaveLength(1);
      await dbClient.db.execute(sql`UPDATE password_reset_tokens SET created_at = now() - interval '61 minutes' WHERE id = 'prt_fill0'`);
      await requestMail();
    });

    it("a confirm, good or refused, gives no request back", async () => {
      await configureRelay();
      for (let i = 0; i < 2; i++) await requestMail();
      const last = tokenOf(await requestMail());
      expect((await confirm(`${last}x`)).status).toBe(400);
      expect((await confirm(last)).status).toBe(204);
      await request(CUSTOMER);
      await service.idle();
      expect(sim.panelMails).toHaveLength(3);
    });
  });
});
