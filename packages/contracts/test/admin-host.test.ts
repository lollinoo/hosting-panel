import { describe, expect, it } from "vitest";
import {
  ComponentApplyAcceptedDtoSchema,
  HOST_JOURNAL_SOURCES,
  HOST_SERVICES,
  HOST_SERVICE_UNIT,
  HostJobAcceptedDtoSchema,
  HostServiceRestartAcceptedDtoSchema,
  HostServiceStatusDtoSchema,
  IPC_HOST_JOURNAL_UNITS,
  LogSourceSchema,
  OsPackagesDtoSchema,
  PANEL_CONTAINERS,
  SiteImageUpdateAcceptedDtoSchema,
  UpdatesDtoSchema,
} from "../src/index.js";

const AT = "2026-11-17T10:00:00.000Z";
const component = (c: (typeof PANEL_CONTAINERS)[number]) => ({ component: c, expected: true, imageCurrent: true, runningOperationId: null });
const UPDATES = {
  panel: { installedVersion: "1.2.3", check: { state: "up_to_date", latestVersion: "1.2.3", checkedAt: AT }, running: null, last: null },
  components: PANEL_CONTAINERS.map(component),
  sites: [{ siteId: "site_a", siteName: "wp-a", organizationName: null, phpVersion: "8.3", stopped: false }],
  sitesTotal: 1,
};
const PACKAGES = {
  packages: [{ name: "examplelib", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" }],
  rebootRequired: false,
  canUpgrade: true,
  listsReadAt: AT,
  running: null,
};

describe("admin host contract", () => {
  it("takes the journal sources from the wire list, not a copy", () => {
    expect(HOST_JOURNAL_SOURCES).toBe(IPC_HOST_JOURNAL_UNITS);
  });

  it("takes the five containers and the seven units as log sources and nothing else", () => {
    for (const s of [...PANEL_CONTAINERS, ...HOST_JOURNAL_SOURCES]) expect(LogSourceSchema.safeParse(s).success).toBe(true);
    expect(PANEL_CONTAINERS.length + HOST_JOURNAL_SOURCES.length).toBe(12);
    for (const s of ["api", "hp-other", "hp-api.service", "", "sshd"]) expect(LogSourceSchema.safeParse(s).success).toBe(false);
  });

  it("gives every service a unit among the journal sources", () => {
    expect(Object.keys(HOST_SERVICE_UNIT)).toEqual([...HOST_SERVICES]);
    for (const s of HOST_SERVICES) expect(HOST_JOURNAL_SOURCES).toContain(HOST_SERVICE_UNIT[s]);
  });

  it("parses an updates body with exactly five component rows", () => {
    expect(UpdatesDtoSchema.safeParse(UPDATES).success).toBe(true);
    expect(UpdatesDtoSchema.safeParse({ ...UPDATES, components: UPDATES.components.slice(1) }).success).toBe(false);
    expect(UpdatesDtoSchema.safeParse({ ...UPDATES, components: [...UPDATES.components, component("sftp")] }).success).toBe(false);
  });

  it("wants canUpgrade in the packages body", () => {
    expect(OsPackagesDtoSchema.safeParse(PACKAGES).success).toBe(true);
    const { canUpgrade: _dropped, ...without } = PACKAGES;
    expect(OsPackagesDtoSchema.safeParse(without).success).toBe(false);
  });

  it("refuses an extra key in every DTO", () => {
    const cases: readonly [{ safeParse(v: unknown): { success: boolean } }, Record<string, unknown>][] = [
      [UpdatesDtoSchema, UPDATES],
      [OsPackagesDtoSchema, PACKAGES],
      [HostJobAcceptedDtoSchema, { operationId: "op_1" }],
      [HostServiceRestartAcceptedDtoSchema, { service: "api", operationId: "op_1" }],
      [ComponentApplyAcceptedDtoSchema, { component: "mail_relay", operationId: null }],
      [SiteImageUpdateAcceptedDtoSchema, { siteId: "site_a", operationId: "op_1" }],
      [HostServiceStatusDtoSchema, { service: "web", active: true, activeState: "active", since: AT, restarts: 0 }],
    ];
    for (const [schema, body] of cases) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    }
  });
});
