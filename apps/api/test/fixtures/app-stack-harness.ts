import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppFeatureFlags, AppImageAllowlistEntry } from "@hosting-panel/contracts";
import {
  appStackBackupCopies,
  appStackBackups,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStackSecrets,
  appStackVolumes,
  appStacks,
  appTemplateVersions,
  appTemplates,
  auditEvents,
  createDatabaseClient,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { hashPassword } from "../../src/auth/password.js";
import { totpCodeAt } from "../../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../../src/index.js";
import { skipPasswordChange } from "./password-change.js";

const FIXTURE = "../../../../packages/contracts/test/fixtures/app-stack-notes-demo/";
export const NOTES_DEMO_SOURCE: string = readFileSync(new URL(`${FIXTURE}source.yaml`, import.meta.url), "utf8");
export const APP_TEST_ALLOWLIST: readonly AppImageAllowlistEntry[] = JSON.parse(
  readFileSync(new URL(`${FIXTURE}allowlist.json`, import.meta.url), "utf8"),
) as AppImageAllowlistEntry[];

const KEY = Buffer.alloc(32, 7);
/** The master key of the harness: a test reads a stored secret back with it. */
export const APP_TEST_MASTER_KEY: Buffer = KEY;
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const TABLES = {
  app_templates: appTemplates,
  app_template_versions: appTemplateVersions,
  app_stacks: appStacks,
  app_stack_parameters: appStackParameters,
  app_stack_secrets: appStackSecrets,
  app_stack_revisions: appStackRevisions,
  app_stack_components: appStackComponents,
  app_stack_volumes: appStackVolumes,
  app_stack_domains: appStackDomains,
  app_stack_deployments: appStackDeployments,
  app_stack_backups: appStackBackups,
  app_stack_backup_copies: appStackBackupCopies,
  operations,
  outbox_events: outboxEvents,
  audit_events: auditEvents,
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface HarnessCustomer {
  readonly orgId: string;
  readonly userId: string;
  readonly token: string;
}

export interface AppStackHarness {
  readonly app: ControlPlaneAppHandle;
  readonly dbClient: DatabaseClient;
  /** The executor behind the API: its `backupState` scripts the backup jobs. */
  readonly sim: InMemoryDockerSimulatorAdapter;
  readonly adminToken: string;
  /** Two owners, each with an active Dedicated allocation. */
  readonly a: HarnessCustomer;
  readonly b: HarnessCustomer;
  /** A string body is sent raw ("{not json"). */
  call(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Json; raw: string }>;
  /** Admin creates the template from `source`, enables it; returns ids. */
  publish(source?: string, slug?: string): Promise<{ templateId: string; versionId: string }>;
  addMember(orgId: string, role: "role_customer_collaborator" | "role_customer_owner"): Promise<HarnessCustomer>;
  /** Row counts of the twelve app_* tables + operations + outbox_events + audit_events. */
  counts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

export async function startAppStackHarness(options?: {
  readonly appFeatures?: Partial<AppFeatureFlags>;
  readonly allowlist?: readonly AppImageAllowlistEntry[];
  /** `linux-systemd` is the backend where backups exist (ADR-0038); the default has none. */
  readonly runtimeBackend?: "local-simulator" | "linux-systemd";
}): Promise<AppStackHarness> {
  const dbClient = createDatabaseClient({ mode: "pglite" });
  await dbClient.migrate();
  await setupInstallation(dbClient.db, SETUP);
  const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
  const sim = new InMemoryDockerSimulatorAdapter();
  const installed = options?.runtimeBackend === "linux-systemd";
  const app = await createControlPlaneApp({
    listen: true,
    host: "127.0.0.1",
    port: 0,
    databaseClient: dbClient,
    secretsMasterKey: KEY,
    ...(installed
      ? {
          runtimeBackend: "linux-systemd" as const,
          hostAgent: new InMemoryHostSimulatorAdapter(),
          jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
          domainReconcileIntervalMs: null,
          mailRelayRetryIntervalMs: null,
          sftpRetryIntervalMs: null,
          backupScheduleIntervalMs: null,
        }
      : { runtimeBackend: "local-simulator" as const }),
    dockerExecutor: sim,
    autoProcessOutbox: false,
    outboxPollIntervalMs: null,
    driftReconcileIntervalMs: null,
    recoverUnknownOnStart: false,
    appFeatures: options?.appFeatures ?? { applicationTemplatesAvailable: true, applicationStacksAvailable: true },
    appTemplateValidation: { allowlist: options?.allowlist ?? APP_TEST_ALLOWLIST },
  });

  const call: AppStackHarness["call"] = async (token, method, path, body, headers = {}) => {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  };

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await call(null, "POST", "/v1/auth/login", {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    });
    if (res.status !== 200) throw new Error(`login of ${email} failed: ${res.raw}`);
    return res.body.data.accessToken as string;
  }

  async function addUser(orgId: string, role: string, name: string): Promise<HarnessCustomer> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    const email = `${userId}@example.test`;
    await dbClient.db.insert(users).values({ id: userId, email, name, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: role });
    return { orgId, userId, token: await login(email, PW) };
  }

  const adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);

  const created = await call(adminToken, "POST", "/v1/admin/customer-account", {
    organizationName: "Hotel Mario",
    ownerEmail: "mario@hotel.it",
    ownerName: "Mario",
  });
  if (created.status !== 201) throw new Error(`customer A: ${created.raw}`);
  await skipPasswordChange(dbClient.db, "mario@hotel.it");
  const a: HarnessCustomer = {
    orgId: created.body.data.organizationId as string,
    userId: created.body.data.userId as string,
    token: await login("mario@hotel.it", created.body.data.temporaryPassword as string),
  };

  // A dedicated host takes one customer, so customer B gets a host of its own.
  const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
  const hostId = `hst_${randomUUID()}`;
  await dbClient.db.insert(hosts).values({
    id: hostId,
    platformInstallationId: inst!.id,
    name: "host-b.test",
    hostname: "host-b.test",
    ipv4Address: "10.0.0.32",
    hostingMode: "dedicated",
    totalCpuMilli: 4000,
    totalMemoryBytes: "8589934592",
    totalStorageBytes: "107374182400",
  });
  const orgB = `org_${randomUUID()}`;
  await dbClient.db.insert(organizations).values({ id: orgB, platformInstallationId: inst!.id, name: "Bar Luigi", slug: "bar-luigi" });
  await dbClient.db.insert(hostAllocations).values({
    id: `alloc_${randomUUID()}`,
    hostId,
    organizationId: orgB,
    status: "active",
    hostingMode: "dedicated",
    dedicatedScope: true,
  });
  const b = await addUser(orgB, "role_customer_owner", "Luigi");

  return {
    app,
    dbClient,
    sim,
    adminToken,
    a,
    b,
    call,
    async publish(source = NOTES_DEMO_SOURCE, slug = `t-${randomUUID().slice(0, 8)}`) {
      const res = await call(adminToken, "POST", "/v1/admin/app-templates", { slug, source });
      if (res.status !== 201) throw new Error(`publish: ${res.raw}`);
      const templateId = res.body.data.id as string;
      const enabled = await call(adminToken, "PATCH", `/v1/admin/app-templates/${templateId}`, { enabled: true });
      if (enabled.status !== 200) throw new Error(`publish: ${enabled.raw}`);
      return { templateId, versionId: res.body.data.defaultVersionId as string };
    },
    addMember: (orgId, role) => addUser(orgId, role, role),
    async counts() {
      const entries = await Promise.all(
        Object.entries(TABLES).map(async ([name, table]) => {
          const [row] = await dbClient.db.select({ n: sql<number>`count(*)::int` }).from(table);
          return [name, row!.n] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
    async close() {
      await app.close();
      await dbClient.close();
    },
  };
}
