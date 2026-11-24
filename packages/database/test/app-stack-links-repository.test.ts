import {
  APP_STACK_BUSY_STATUSES,
  MAX_APP_STACK_LINKS_PER_APPLICATION,
  MAX_APP_STACK_LINKS_PER_DATABASE,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppStackLinkError,
  appStackLinks,
  appStackRevisions,
  appStacks,
  appTemplates,
  appTemplateVersions,
  createAppStackLinkTransactional,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  listAppStackLinkProviderIds,
  listAppStackLinkProvidersDue,
  listAppStackLinks,
  listAppStackLinksOfProvider,
  markAppStackLinkRemoving,
  organizations,
  releaseAppStackLinksOfDeletedApplications,
  platformInstallations,
  settleAppStackLinks,
  unsettleAppStackLinks,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "../src/index.js";

// Private links (ADR-0039): the rows only. A link joins two applications of one customer, is taken while neither is
// changing, is capped on both sides, and is removed in two moves: marked by the customer, deleted on the server's answer.
const orgA = "org_ln_a";
const orgB = "org_ln_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_ln_a", [orgB]: "alloc_ln_b" };

describe("@hosting-panel/database — app stack links repository", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;

  /** A stack row as a finished deploy leaves it: running, with a desired revision. */
  async function stack(org = orgA, options: { status?: AppStackStatus; installed?: boolean } = {}): Promise<string> {
    counter += 1;
    const id = `stk_ln_${String(counter).padStart(4, "0")}`;
    await db().insert(appStacks).values({
      id,
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      templateId: "atpl_ln",
      templateVersionId: "atv_ln1",
      name: `Stack ${String(counter)}`,
      status: options.status ?? "running",
    });
    if (options.installed !== false) {
      const revisionId = `srev_ln_${String(counter)}`;
      await db().insert(appStackRevisions).values({
        id: revisionId,
        stackId: id,
        organizationId: org,
        revisionNumber: 1,
        templateVersionId: "atv_ln1",
        plan: {},
        planHash: "b".repeat(64),
        componentCount: 1,
        cpuMilli: 250,
        memoryBytes: 134217728,
      });
      await db().update(appStacks).set({ desiredRevisionId: revisionId }).where(eq(appStacks.id, id));
    }
    return id;
  }

  const link = (consumerStackId: string, providerStackId: string, org = orgA) =>
    createAppStackLinkTransactional(db(), { organizationId: org, consumerStackId, providerStackId, createdBy: null });
  const code = async (work: Promise<unknown>) => {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppStackLinkError);
    return (err as AppStackLinkError).code;
  };
  const states = async (providerStackId: string) =>
    Object.fromEntries((await listAppStackLinksOfProvider(db(), providerStackId)).map((row) => [row.consumerStackId, row.state]));
  const due = async () => (await listAppStackLinkProvidersDue(db(), { limit: 50 })).map((row) => row.stackId);

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_ln", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_ln",
      platformInstallationId: "pin_ln",
      name: "ln-host",
      hostname: "panel.ln.example",
      ipv4Address: "10.0.0.42",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_ln", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_ln", organizationId: org, status: "active" });
    }
    await db().insert(appTemplates).values({ id: "atpl_ln", slug: "ln-alpha", name: "Alpha", category: "database" });
    await db().insert(appTemplateVersions).values({
      id: "atv_ln1",
      templateId: "atpl_ln",
      versionNumber: 1,
      source: "x",
      specVersion: 1,
      compiledSchema: {},
      specHash: "a".repeat(64),
    });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("records a link as pending and lists it from both sides", async () => {
    const [app, database] = [await stack(), await stack()];
    const row = await link(app, database);
    expect(row).toMatchObject({ organizationId: orgA, consumerStackId: app, providerStackId: database, state: "pending", createdBy: null });
    expect(row.id).toMatch(/^slnk_[0-9a-f]{24}$/);
    for (const stackId of [app, database]) {
      expect((await listAppStackLinks(db(), { organizationId: orgA, stackId })).map((r) => r.id)).toEqual([row.id]);
      expect(await listAppStackLinks(db(), { organizationId: orgB, stackId })).toEqual([]);
    }
    expect((await listAppStackLinksOfProvider(db(), database)).map((r) => r.id)).toEqual([row.id]);
    expect(await listAppStackLinksOfProvider(db(), app)).toEqual([]);
    expect(await listAppStackLinkProviderIds(db(), app)).toEqual([database]);
    expect(await listAppStackLinkProviderIds(db(), database)).toEqual([]);
  });

  it("refuses the same pair twice, and lets the opposite direction be a different link", async () => {
    const [app, database] = [await stack(), await stack()];
    await link(app, database);
    expect(await code(link(app, database))).toBe("LINK_EXISTS");
    expect((await link(database, app)).state).toBe("pending");
  });

  it("refuses an application of another customer on either side, whoever asks", async () => {
    const [mine, theirs] = [await stack(orgA), await stack(orgB)];
    expect(await code(link(mine, theirs, orgA))).toBe("NOT_FOUND");
    expect(await code(link(theirs, mine, orgA))).toBe("NOT_FOUND");
    expect(await code(link(mine, theirs, orgB))).toBe("NOT_FOUND");
    expect(await code(link(mine, "stk_ln_missing", orgA))).toBe("NOT_FOUND");
    expect(await db().select().from(appStackLinks).where(eq(appStackLinks.consumerStackId, mine))).toEqual([]);
  });

  it("cannot store a link across customers or of an application with itself, even past the repository", async () => {
    const [mine, theirs] = [await stack(orgA), await stack(orgB)];
    const raw = (consumerStackId: string, providerStackId: string, organizationId: string) =>
      db().insert(appStackLinks).values({ id: `slnk_raw_${String((counter += 1))}`, organizationId, consumerStackId, providerStackId });
    await expect(raw(mine, theirs, orgA)).rejects.toThrow();
    await expect(raw(mine, theirs, orgB)).rejects.toThrow();
    await expect(raw(mine, mine, orgA)).rejects.toThrow();
    await expect(
      db().execute(`insert into app_stack_links (id, organization_id, consumer_stack_id, provider_stack_id, state)
        values ('slnk_raw_state', '${orgA}', '${mine}', '${await stack(orgA)}', 'gone')`),
    ).rejects.toThrow();
  });

  it("refuses a deleted application and one that is changing or half deleted, on either side", async () => {
    const steady = await stack();
    const gone = await stack();
    await db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, gone));
    expect(await code(link(steady, gone))).toBe("NOT_FOUND");
    expect(await code(link(gone, steady))).toBe("NOT_FOUND");
    for (const status of [...APP_STACK_BUSY_STATUSES, "delete_failed"] as const) {
      const busy = await stack(orgA, { status });
      for (const work of [link(steady, busy), link(busy, steady)]) {
        const err = await work.then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toMatchObject({ name: "AppStackLinkError", code: "STACK_BUSY", status });
      }
    }
    expect(await listAppStackLinks(db(), { organizationId: orgA, stackId: steady })).toEqual([]);
  });

  it("takes a link on a draft and on a stopped or failed application", async () => {
    const database = await stack(orgA, { status: "draft", installed: false });
    for (const status of ["draft", "stopped", "failed", "degraded", "running"] as const) {
      const app = await stack(orgA, { status, installed: status !== "draft" });
      expect((await link(app, database)).state).toBe("pending");
    }
  });

  it("caps the databases of one application and the applications of one database", async () => {
    const app = await stack();
    for (let i = 0; i < MAX_APP_STACK_LINKS_PER_APPLICATION; i += 1) await link(app, await stack());
    expect(await code(link(app, await stack()))).toBe("LINK_LIMIT_APPLICATION");

    const database = await stack();
    const apps: string[] = [];
    for (let i = 0; i < MAX_APP_STACK_LINKS_PER_DATABASE; i += 1) apps.push(await stack());
    for (const id of apps) await link(id, database);
    expect(await code(link(await stack(), database))).toBe("LINK_LIMIT_DATABASE");
    // A link being disconnected may still be there on the server: it keeps its place until the server confirms.
    const [first] = await listAppStackLinksOfProvider(db(), database);
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: database, linkId: first!.id });
    expect(await code(link(await stack(), database))).toBe("LINK_LIMIT_DATABASE");
    await settleAppStackLinks(db(), { providerStackId: database, active: [], pending: [], removed: [first!.id] });
    expect((await link(await stack(), database)).state).toBe("pending");
  });

  it("marks a link as being disconnected from either side, never for another customer or a third application", async () => {
    const [app, database, other] = [await stack(), await stack(), await stack()];
    const row = await link(app, database);
    expect(await markAppStackLinkRemoving(db(), { organizationId: orgB, stackId: app, linkId: row.id })).toBeNull();
    expect(await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: other, linkId: row.id })).toBeNull();
    expect(await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: app, linkId: "slnk_missing" })).toBeNull();
    expect(await states(database)).toEqual({ [app]: "pending" });
    expect((await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: database, linkId: row.id }))?.state).toBe("removing");
    expect((await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: app, linkId: row.id }))?.state).toBe("removing");
    expect(await states(database)).toEqual({ [app]: "removing" });
  });

  it("takes back a link that is being disconnected: same row, pending again", async () => {
    const [app, database] = [await stack(), await stack()];
    const row = await link(app, database);
    await settleAppStackLinks(db(), { providerStackId: database, active: [row.id], pending: [], removed: [] });
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: app, linkId: row.id });
    const back = await link(app, database);
    expect(back).toMatchObject({ id: row.id, state: "pending" });
    expect(await states(database)).toEqual({ [app]: "pending" });
  });

  it("settles what the server answered only on rows still in the state they were read in", async () => {
    const database = await stack();
    const [a, b, c, d] = [await stack(), await stack(), await stack(), await stack()];
    const rows = Object.fromEntries(await Promise.all([a, b, c, d].map(async (id) => [id, (await link(id, database)).id] as const)));
    await settleAppStackLinks(db(), { providerStackId: database, active: [rows[a]!, rows[b]!], pending: [rows[c]!], removed: [rows[d]!] });
    // d was pending, not removing: a removal the customer never asked for does not delete it.
    expect(await states(database)).toEqual({ [a]: "active", [b]: "active", [c]: "pending", [d]: "pending" });

    // Read: a active, b active, c pending, d removing. Meanwhile the customer disconnects a and takes d back.
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: database, linkId: rows[d]! });
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: database, linkId: rows[a]! });
    await link(d, database);
    await settleAppStackLinks(db(), { providerStackId: database, active: [rows[a]!, rows[c]!], pending: [rows[b]!], removed: [rows[d]!] });
    expect(await states(database)).toEqual({ [a]: "removing", [b]: "pending", [c]: "active", [d]: "pending" });

    // An answer for another database touches nothing here.
    const elsewhere = await stack();
    await settleAppStackLinks(db(), { providerStackId: elsewhere, active: [rows[b]!, rows[d]!], pending: [rows[c]!], removed: [rows[a]!] });
    expect(await states(database)).toEqual({ [a]: "removing", [b]: "pending", [c]: "active", [d]: "pending" });

    await settleAppStackLinks(db(), { providerStackId: database, active: [], pending: [], removed: [rows[a]!] });
    expect(await states(database)).toEqual({ [b]: "pending", [c]: "active", [d]: "pending" });
  });

  it("with no answer from the server, a link shown as applied is pending again and a disconnection stays asked", async () => {
    const database = await stack();
    const [a, b, c] = [await stack(), await stack(), await stack()];
    const ids = [(await link(a, database)).id, (await link(b, database)).id, (await link(c, database)).id];
    await settleAppStackLinks(db(), { providerStackId: database, active: [ids[0]!, ids[1]!], pending: [], removed: [] });
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: database, linkId: ids[1]! });
    await unsettleAppStackLinks(db(), database);
    expect(await states(database)).toEqual({ [a]: "pending", [b]: "removing", [c]: "pending" });
  });

  it("lists the databases with something left to apply, the one that waited longest first", async () => {
    const before = await due();
    const applied = await stack();
    const appliedRow = await link(await stack(), applied);
    await settleAppStackLinks(db(), { providerStackId: applied, active: [appliedRow.id], pending: [], removed: [] });

    const waiting = await stack();
    await link(await stack(), waiting);
    const detaching = await stack();
    const detachingRow = await link(await stack(orgA, { status: "draft", installed: false }), detaching);
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: detaching, linkId: detachingRow.id });

    const notInstalled = await stack(orgA, { status: "draft", installed: false });
    await link(await stack(), notInstalled);
    const applicationNotInstalled = await stack();
    await link(await stack(orgA, { status: "draft", installed: false }), applicationNotInstalled);
    const busy = await stack();
    await link(await stack(), busy);
    await db().update(appStacks).set({ status: "updating" }).where(eq(appStacks.id, busy));
    const applicationBusy = await stack();
    const changing = await stack();
    await link(changing, applicationBusy);
    await db().update(appStacks).set({ status: "starting" }).where(eq(appStacks.id, changing));

    const added = (await due()).filter((id) => !before.includes(id));
    expect(added.sort()).toEqual([detaching, waiting].sort());

    // The one touched last goes to the end; a limit cuts from the end.
    await db().update(appStackLinks).set({ updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(appStackLinks.providerStackId, detaching));
    await db().update(appStackLinks).set({ updatedAt: new Date(Date.now() - 7_200_000) }).where(eq(appStackLinks.providerStackId, waiting));
    const ordered = (await due()).filter((id) => id === detaching || id === waiting);
    expect(ordered).toEqual([waiting, detaching]);
    await unsettleAppStackLinks(db(), waiting);
    expect((await due()).filter((id) => id === detaching || id === waiting)).toEqual([detaching, waiting]);
    expect(await listAppStackLinkProvidersDue(db(), { limit: 1 })).toHaveLength(1);

    // Once its application is installed and still, the database that was held back is due too.
    await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, changing));
    expect(await due()).toContain(applicationBusy);
    expect((await listAppStackLinkProvidersDue(db(), { limit: 50 })).find((row) => row.stackId === waiting)).toEqual({
      stackId: waiting,
      organizationId: orgA,
    });
  });

  it("a link of an application a previous release deleted is one to disconnect, and its database is due", async () => {
    const database = await stack();
    const [left, stays] = [await stack(), await stack()];
    const [leftRow, staysRow] = [await link(left, database), await link(stays, database)];
    await settleAppStackLinks(db(), { providerStackId: database, active: [leftRow.id, staysRow.id], pending: [], removed: [] });
    expect(await due()).not.toContain(database);
    expect(await releaseAppStackLinksOfDeletedApplications(db(), database)).toBe(0);

    await db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, left));
    expect(await due()).toContain(database);
    expect(await releaseAppStackLinksOfDeletedApplications(db(), database)).toBe(1);
    expect(await releaseAppStackLinksOfDeletedApplications(db(), database)).toBe(0);
    expect(await states(database)).toEqual({ [left]: "removing", [stays]: "active" });
    await settleAppStackLinks(db(), { providerStackId: database, active: [], pending: [], removed: [leftRow.id] });
    expect(await states(database)).toEqual({ [stays]: "active" });
    expect(await due()).not.toContain(database);
  });

  it("a disconnection waits for its database whatever it is, as long as no change of it is running", async () => {
    const draft = await stack(orgA, { status: "draft", installed: false });
    const row = await link(await stack(), draft);
    expect(await due()).not.toContain(draft);
    await markAppStackLinkRemoving(db(), { organizationId: orgA, stackId: draft, linkId: row.id });
    expect(await due()).toContain(draft);
    await db().update(appStacks).set({ status: "queued" }).where(eq(appStacks.id, draft));
    expect(await due()).not.toContain(draft);
  });

  it("goes with either application when its row is removed", async () => {
    const [app, database] = [await stack(orgA, { status: "draft", installed: false }), await stack()];
    await link(app, database);
    await db().delete(appStacks).where(eq(appStacks.id, app));
    expect(await listAppStackLinksOfProvider(db(), database)).toEqual([]);
  });
});
