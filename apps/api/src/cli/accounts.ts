import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import os from "node:os";
import { createInterface } from "node:readline";
import { redactSensitiveString } from "@hosting-panel/contracts";
import { isInvokedDirectly } from "@hosting-panel/contracts/invoked-directly";
import {
  appendAuditEvent,
  createDatabaseClient,
  encryptSecretAesGcm,
  ensurePresetRolesAndPermissions,
  ensureWordpressTemplate,
  eq,
  hosts,
  and,
  isNull,
  platformInstallations,
  userSessions,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { assertPasswordPolicy, generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { buildOtpauthUri, generateTotpSecret } from "../auth/totp.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { resolveSecretsMasterKey } from "../create-app.js";

const normEmail = (email: string): string => email.trim().toLowerCase();

const audit = (db: HostingPanelDatabase, action: string, targetType: string, targetId: string | null) =>
  appendAuditEvent(db, { actorId: null, actorType: "system", organizationId: null, action, targetType, targetId });

async function findUser(db: HostingPanelDatabase, rawEmail: string) {
  const [user] = await db.select().from(users).where(eq(users.email, normEmail(rawEmail))).limit(1);
  if (!user) throw new ControlPlaneError("NOT_FOUND", "User not found.");
  return user;
}

function encryptTotp(secret: string, userId: string, key: Buffer) {
  const env = encryptSecretAesGcm({
    plaintext: secret,
    masterKey: key,
    organizationId: "platform",
    siteId: null,
    secretKey: `totp:${userId}`,
  });
  return {
    totpCiphertextBase64: env.ciphertextBase64,
    totpIvBase64: env.ivBase64,
    totpAuthTagBase64: env.authTagBase64,
    totpEnabledAt: new Date(),
    totpLastStep: null,
    totpFailedCount: 0,
  };
}

// None of these can be the server's public IPv6.
const NOT_A_PUBLIC_IPV6 = new BlockList();
NOT_A_PUBLIC_IPV6.addAddress("::", "ipv6");
NOT_A_PUBLIC_IPV6.addAddress("::1", "ipv6");
NOT_A_PUBLIC_IPV6.addSubnet("fe80::", 10, "ipv6");
NOT_A_PUBLIC_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");

// The webhook check and the executor read these addresses back with Node and refuse what it does not parse.
function parseHostIpv4(value: string): string {
  if (isIP(value) !== 4) {
    throw new Error("Invalid --ipv4: give the server's public IPv4 as four numbers from 0 to 255, without leading zeros.");
  }
  return value;
}

function parseHostIpv6(value: string): string {
  // isIP accepts a zone (fe80::1%eth0), which no other host can reach.
  if (isIP(value) !== 6 || value.includes("%")) {
    throw new Error("Invalid --ipv6: give the server's public IPv6 without brackets, zone or prefix length, or none.");
  }
  if (NOT_A_PUBLIC_IPV6.check(value, "ipv6")) {
    throw new Error("Invalid --ipv6: a loopback, link-local, unspecified or IPv4-mapped address is not the server's public IPv6.");
  }
  // The WHATWG URL parser prints an IPv6 compressed and in lower case, so one address is stored one way.
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

/** `hostIpv6`: an address records it, null removes it, undefined leaves the recorded one as it is. */
export async function setupInstallation(
  db: HostingPanelDatabase,
  input: { installationName: string; hostHostname: string; hostIpv4: string; hostIpv6?: string | null },
): Promise<{ installationId: string; hostId: string }> {
  const ipv4 = parseHostIpv4(input.hostIpv4);
  const ipv6 = input.hostIpv6 === undefined || input.hostIpv6 === null ? input.hostIpv6 : parseHostIpv6(input.hostIpv6);
  await ensurePresetRolesAndPermissions(db);
  await ensureWordpressTemplate(db);
  const [inst] = await db.select().from(platformInstallations).limit(1);
  const [host] = await db.select().from(hosts).limit(1);
  if (inst && host) {
    const ipv6Changed = ipv6 !== undefined && host.ipv6Address !== ipv6;
    // A rerun with a new --ipv4/--ipv6/--hostname (for example behind NAT) must reach the row sites read.
    if (
      host.ipv4Address !== ipv4 ||
      ipv6Changed ||
      host.hostname !== input.hostHostname ||
      host.name !== input.hostHostname
    ) {
      await db
        .update(hosts)
        .set({
          ipv4Address: ipv4,
          ...(ipv6 === undefined ? {} : { ipv6Address: ipv6 }),
          hostname: input.hostHostname,
          name: input.hostHostname,
        })
        .where(eq(hosts.id, host.id));
      await appendAuditEvent(db, {
        actorId: null,
        actorType: "system",
        organizationId: null,
        action: "host.address.change",
        targetType: "host",
        targetId: host.id,
        details: {
          from: host.ipv4Address,
          to: ipv4,
          ...(ipv6Changed ? { ipv6From: host.ipv6Address, ipv6To: ipv6 } : {}),
        },
      });
    }
    return { installationId: inst.id, hostId: host.id };
  }

  const fs = await statfs("/");
  const installationId = inst?.id ?? `pin_${randomUUID()}`;
  const hostId = `hst_${randomUUID()}`;
  if (!inst) {
    await db.insert(platformInstallations).values({ id: installationId, name: input.installationName });
  }
  await db.insert(hosts).values({
    id: hostId,
    platformInstallationId: installationId,
    name: input.hostHostname,
    hostname: input.hostHostname,
    ipv4Address: ipv4,
    ipv6Address: ipv6 ?? null,
    hostingMode: "dedicated",
    totalCpuMilli: os.cpus().length * 1000,
    totalMemoryBytes: String(os.totalmem()),
    totalStorageBytes: String(fs.blocks * fs.bsize),
  });
  await audit(db, "accounts.setup", "platform_installation", installationId);
  return { installationId, hostId };
}

export async function createServerAdmin(
  db: HostingPanelDatabase,
  key: Buffer,
  input: { email: string; name: string; password: string },
): Promise<{ userId: string; totpSecretBase32: string; otpauthUri: string }> {
  const created = await insertServerAdmin(db, key, { ...input, mustChangePassword: false });
  await audit(db, "accounts.admin.created", "user", created.userId);
  return created;
}

/** Inserts a server admin with TOTP enrolled; the caller writes the audit row. */
export async function insertServerAdmin(
  db: HostingPanelDatabase,
  key: Buffer,
  input: { email: string; name: string; password: string; mustChangePassword: boolean },
): Promise<{ userId: string; totpSecretBase32: string; otpauthUri: string }> {
  assertPasswordPolicy(input.password);
  const email = normEmail(input.email);
  const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (dup) throw new ControlPlaneError("VALIDATION_ERROR", "A user with this email already exists.");

  const userId = `usr_${randomUUID()}`;
  const secret = generateTotpSecret();
  await db.insert(users).values({
    id: userId,
    email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    platformRole: "infrastructure_admin",
    mustChangePassword: input.mustChangePassword,
    ...encryptTotp(secret, userId, key),
  });
  return { userId, totpSecretBase32: secret, otpauthUri: buildOtpauthUri(secret, email, "Hosting Panel") };
}

const unlockFields = { lockedUntil: null, failedLoginCount: 0, totpFailedCount: 0 } as const;

export async function resetUserPassword(
  db: HostingPanelDatabase,
  input: { email: string },
): Promise<{ temporaryPassword: string }> {
  const user = await findUser(db, input.email);
  const temporaryPassword = generateTemporaryPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, ...unlockFields })
    .where(eq(users.id, user.id));
  // Same effect as OidcService.revokeAllSessionsForUser (CLI has no Nest app).
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
  await audit(db, "accounts.password.reset", "user", user.id);
  return { temporaryPassword };
}

export async function resetUserTotp(
  db: HostingPanelDatabase,
  key: Buffer,
  input: { email: string },
): Promise<{ totpSecretBase32: string; otpauthUri: string } | null> {
  const user = await findUser(db, input.email);
  if (user.platformRole === "infrastructure_admin") {
    const secret = generateTotpSecret();
    await db.update(users).set(encryptTotp(secret, user.id, key)).where(eq(users.id, user.id));
    await audit(db, "accounts.totp.reset", "user", user.id);
    return { totpSecretBase32: secret, otpauthUri: buildOtpauthUri(secret, user.email, "Hosting Panel") };
  }
  await db
    .update(users)
    .set({
      totpCiphertextBase64: null,
      totpIvBase64: null,
      totpAuthTagBase64: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpFailedCount: 0,
    })
    .where(eq(users.id, user.id));
  await audit(db, "accounts.totp.cleared", "user", user.id);
  return null;
}

export async function unlockUser(db: HostingPanelDatabase, input: { email: string }): Promise<void> {
  const user = await findUser(db, input.email);
  await db.update(users).set(unlockFields).where(eq(users.id, user.id));
  await audit(db, "accounts.unlock", "user", user.id);
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? undefined : args[i + 1];
}

function required(args: readonly string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`Missing required ${name}.`);
  return v;
}

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Mute echo while the password is typed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  process.stderr.write(question);
  return new Promise((resolve) =>
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    }),
  );
}

function databaseClientFromEnv(): DatabaseClient {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required for accounts CLI.");
  return createDatabaseClient({ mode: "postgres", connectionString: databaseUrl });
}

/** Closes `dbClient` when done. */
export async function runCli(argv: readonly string[], dbClient = databaseClientFromEnv()): Promise<void> {
  const command = argv[0];
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    // Idempotent: `accounts setup` is the first thing run on a new server, before the API ever migrated.
    await dbClient.migrate();
    const db = dbClient.db;
    const key = () => resolveSecretsMasterKey("linux-systemd");
    if (command === "setup") {
      const ipv6 = argv.includes("--ipv6") ? required(argv, "--ipv6") : undefined;
      out(
        await setupInstallation(db, {
          installationName: required(argv, "--name"),
          hostHostname: required(argv, "--hostname"),
          hostIpv4: required(argv, "--ipv4"),
          hostIpv6: ipv6 === "none" ? null : ipv6,
        }),
      );
    } else if (command === "create-admin") {
      const password = process.env["HP_NEW_PASSWORD"] ?? (await promptHidden("Password: "));
      out(
        await createServerAdmin(db, await key(), {
          email: required(argv, "--email"),
          name: required(argv, "--name"),
          password,
        }),
      );
    } else if (command === "reset-password") {
      out(await resetUserPassword(db, { email: required(argv, "--email") }));
    } else if (command === "reset-totp") {
      out(await resetUserTotp(db, await key(), { email: required(argv, "--email") }));
    } else if (command === "unlock") {
      await unlockUser(db, { email: required(argv, "--email") });
      out({ ok: true });
    } else {
      throw new Error(
        "Usage: accounts <setup --name N --hostname H --ipv4 IP [--ipv6 IP|none] | create-admin --email E --name N | reset-password --email E | reset-totp --email E | unlock --email E>",
      );
    }
  } finally {
    await dbClient.close();
  }
}

if (isInvokedDirectly(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${redactSensitiveString(err instanceof Error ? err.message : String(err))}\n`);
    process.exitCode = 1;
  });
}
