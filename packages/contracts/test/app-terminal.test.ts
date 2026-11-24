import { describe, expect, it } from "vitest";
import {
  AdminAppStackDtoSchema,
  AppStackTerminalOpenIpcRequestSchema,
  AppStackTerminalSessionRecordWireSchema,
  AppTerminalSessionDtoSchema,
  TerminalOpenIpcRequestSchema,
  TerminalSessionDtoSchema,
  TerminalSessionRecordWireSchema,
  TerminalSessionsEnvelopeSchema,
} from "../src/index.js";

// ADR-0041: a terminal in a component of an application. The site shapes do not change.

const SESSION_ID = `term_${"ab12".repeat(8)}`;
const AT = "2026-11-23T10:00:00.000Z";
const STACK = "stk_0123456789abcdef01234567";
const ORG = "org_1";

describe("application terminal contract", () => {
  it("the open request names the application, its customer and the component, and nothing else", () => {
    const req = { sessionId: SESSION_ID, stackId: STACK, organizationId: ORG, componentKey: "web" };
    expect(AppStackTerminalOpenIpcRequestSchema.safeParse(req).success).toBe(true);
    for (const extra of ["containerName", "user", "cmd", "workingDir", "siteId", "serviceInstanceId", "env"]) {
      expect(AppStackTerminalOpenIpcRequestSchema.safeParse({ ...req, [extra]: "x" }).success, extra).toBe(false);
    }
    for (const key of ["sessionId", "stackId", "organizationId", "componentKey"] as const) {
      const { [key]: _gone, ...rest } = req;
      expect(AppStackTerminalOpenIpcRequestSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("refuses an identifier that could leave the derived container name", () => {
    const req = { sessionId: SESSION_ID, stackId: STACK, organizationId: ORG, componentKey: "web" };
    for (const stackId of ["", "Stk_1", "stk-1", "stk_1/../x", "stk_1 x", `s${"a".repeat(64)}`]) {
      expect(AppStackTerminalOpenIpcRequestSchema.safeParse({ ...req, stackId }).success, stackId).toBe(false);
    }
    for (const componentKey of ["", "Web", "web_1", "-web", "web-", "we b", "web/..", `w${"a".repeat(32)}`]) {
      expect(AppStackTerminalOpenIpcRequestSchema.safeParse({ ...req, componentKey }).success, componentKey).toBe(false);
    }
    expect(AppStackTerminalOpenIpcRequestSchema.safeParse({ ...req, sessionId: "term_x" }).success).toBe(false);
  });

  it("the session DTO is strict and names the component, never a site", () => {
    const dto = { sessionId: SESSION_ID, stackId: STACK, componentKey: "web", containerName: `hp_app_${STACK}_web`, openedAt: AT, expiresAt: AT };
    expect(AppTerminalSessionDtoSchema.safeParse(dto).success).toBe(true);
    expect(AppTerminalSessionDtoSchema.safeParse({ ...dto, siteId: "site_1" }).success).toBe(false);
    expect(AppTerminalSessionDtoSchema.safeParse({ ...dto, containerId: "0123456789ab" }).success).toBe(false);
    // The site DTO is the one of ADR-0027, key for key.
    expect(Object.keys(TerminalSessionDtoSchema.shape)).toEqual(["sessionId", "siteId", "containerName", "openedAt", "expiresAt"]);
    expect(TerminalSessionDtoSchema.safeParse(dto).success).toBe(false);
  });

  it("the executor's list holds both kinds of session, each strict", () => {
    const site = { sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1", containerName: "hp_svc_svc_1", openedAt: AT, ended: null };
    const app = {
      sessionId: SESSION_ID, stackId: STACK, organizationId: ORG, componentKey: "web",
      containerName: `hp_app_${STACK}_web`, openedAt: AT, ended: { reason: "container_gone", at: AT },
    };
    expect(TerminalSessionsEnvelopeSchema.parse({ data: [site, app] }).data).toEqual([site, app]);
    expect(AppStackTerminalSessionRecordWireSchema.safeParse(app).success).toBe(true);
    // Neither a mix of the two nor an unknown key passes.
    expect(TerminalSessionsEnvelopeSchema.safeParse({ data: [{ ...site, stackId: STACK }] }).success).toBe(false);
    expect(TerminalSessionsEnvelopeSchema.safeParse({ data: [{ ...app, siteId: "site_1" }] }).success).toBe(false);
    expect(TerminalSessionsEnvelopeSchema.safeParse({ data: [{ ...app, extra: 1 }] }).success).toBe(false);
    // An end reason only the API writes never comes from the executor.
    expect(TerminalSessionsEnvelopeSchema.safeParse({ data: [{ ...app, ended: { reason: "executor_gone", at: AT } }] }).success).toBe(false);
    // The site record and the site request keep their keys.
    expect(Object.keys(TerminalSessionRecordWireSchema.shape)).toEqual(["sessionId", "siteId", "serviceInstanceId", "containerName", "openedAt", "ended"]);
    expect(Object.keys(TerminalOpenIpcRequestSchema.shape)).toEqual(["sessionId", "siteId", "serviceInstanceId", "siteType"]);
  });

  it("the administrator's page of one application carries components and no secret, parameter or plan", () => {
    const dto = {
      id: STACK, name: "Shop cache", organizationId: ORG, organizationName: "Rossi", templateId: "atpl_0123456789abcdef01234567",
      templateName: "HTTP cache", versionNumber: 2, status: "running", primaryHostname: null,
      components: [{ key: "web", health: "healthy" }, { key: "cache", health: "unknown" }],
    };
    expect(AdminAppStackDtoSchema.parse(dto)).toEqual(dto);
    expect(Object.keys(AdminAppStackDtoSchema.shape).sort()).toEqual(
      ["components", "id", "name", "organizationId", "organizationName", "primaryHostname", "status", "templateId", "templateName", "versionNumber"],
    );
    expect(Object.keys(AdminAppStackDtoSchema.shape.components.element.shape)).toEqual(["key", "health"]);
    expect(AdminAppStackDtoSchema.safeParse({ ...dto, components: [{ key: "web", health: "running" }] }).success).toBe(false);
    expect(AdminAppStackDtoSchema.safeParse({ ...dto, status: "paused" }).success).toBe(false);
  });
});
