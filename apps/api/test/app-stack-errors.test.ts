import { ERROR_CODE_HTTP_STATUS, type AppTemplateIssue } from "@hosting-panel/contracts";
import {
  AppStackDomainError,
  AppStackLinkError,
  AppStackQuotaError,
  AppStackRepositoryError,
  AppStackSecretError,
  TlsCoverageError,
} from "@hosting-panel/database";
import { describe, expect, it } from "vitest";
import { APP_NOT_FOUND } from "../src/app-templates/app-template-errors.js";
import { APP_DOMAIN_CONFLICT, customerIssuesError, mapAppStackError } from "../src/app-stacks/app-stack-errors.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";

const mapped = (err: unknown) => {
  const out = mapAppStackError(err);
  expect(out).toBeInstanceOf(ControlPlaneError);
  const e = out as ControlPlaneError;
  return { status: ERROR_CODE_HTTP_STATUS[e.code], code: e.code, message: e.message, details: e.details, retryable: e.retryable };
};
const one = (status: number, code: string, message: string, detail: Record<string, unknown>) => ({
  status,
  code,
  message,
  details: [{ message, ...detail }],
});
const pgUnique = (constraint: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: "23505", constraint });

describe("mapAppStackError", () => {
  it.each([
    ["NOT_FOUND", { status: 404, code: "NOT_FOUND", message: APP_NOT_FOUND, details: [] }],
    [
      "NAME_TAKEN",
      one(409, "ALREADY_EXISTS", "An application with this name already exists.", { field: "name", reason: "name_taken" }),
    ],
    [
      "TEMPLATE_UNPUBLISHED",
      one(400, "VALIDATION_ERROR", "This version can no longer be installed. Choose the current version.", {
        field: "templateVersionId",
        reason: "STACK_TEMPLATE_UNPUBLISHED",
      }),
    ],
    [
      "TEMPLATE_MISMATCH",
      one(400, "VALIDATION_ERROR", "The application cannot use this version.", { field: "templateVersionId", reason: "STACK_TEMPLATE_INVALID" }),
    ],
    [
      "NO_REVISION",
      one(400, "VALIDATION_ERROR", "The application cannot use this version.", { field: "templateVersionId", reason: "STACK_TEMPLATE_INVALID" }),
    ],
    [
      "COMPONENT_IN_USE",
      one(400, "VALIDATION_ERROR", "A web address still points at a part this version removes. Remove the address first.", {
        field: "domains",
        reason: "domain_target_removed",
      }),
    ],
    [
      "PATH_IN_USE",
      one(400, "VALIDATION_ERROR", "A path of a web address still points at a part this version removes. Remove the path first.", {
        field: "domains",
        reason: "path_target_removed",
      }),
    ],
    [
      "DATABASE_IN_USE",
      one(400, "VALIDATION_ERROR", "Applications still use this database. Disconnect them first.", { field: "links", reason: "database_in_use" }),
    ],
  ] as const)("AppStackRepositoryError %s", (code, expected) => {
    expect(mapped(new AppStackRepositoryError(code, "repository text"))).toMatchObject(expected);
  });

  it("INVALID_TRANSITION carries the status literal and is not retryable", () => {
    expect(mapped(new AppStackRepositoryError("INVALID_TRANSITION", "repository text", "stopping"))).toEqual({
      ...one(409, "RESOURCE_LOCKED", "This action is not possible while the application is stopping.", { field: "status", reason: "stopping" }),
      retryable: false,
    });
  });

  it("maps the link errors (ADR-0039)", () => {
    expect(mapped(new AppStackLinkError("NOT_FOUND", "repository text"))).toMatchObject({ status: 404, code: "NOT_FOUND", message: APP_NOT_FOUND, details: [] });
    expect(mapped(new AppStackLinkError("STACK_BUSY", "repository text", "updating"))).toEqual({
      ...one(409, "RESOURCE_LOCKED", "This action is not possible while the application is updating.", { field: "status", reason: "updating" }),
      retryable: false,
    });
    expect(mapped(new AppStackLinkError("LINK_EXISTS", "repository text"))).toMatchObject(
      one(409, "ALREADY_EXISTS", "The application is already connected to this database.", { field: "databaseStackId", reason: "link_exists" }),
    );
    expect(mapped(new AppStackLinkError("LINK_LIMIT_APPLICATION", "repository text"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "An application can be connected to at most 4 databases.", { field: "links", reason: "STACK_QUOTA_EXCEEDED" }),
    );
    expect(mapped(new AppStackLinkError("LINK_LIMIT_DATABASE", "repository text"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "A database can be connected to at most 8 applications.", { field: "links", reason: "STACK_QUOTA_EXCEEDED" }),
    );
  });

  it("a quota refusal is the one-detail QUOTA_EXCEEDED of the limit helper", () => {
    expect(mapped(new AppStackQuotaError("cpuMilli", 3000, 2000))).toMatchObject({
      status: 409,
      code: "QUOTA_EXCEEDED",
      details: [{ field: "cpuMilli", reason: "STACK_QUOTA_EXCEEDED", message: "3000 of 2000 in use." }],
    });
  });

  it.each([
    ["the repository error", new AppStackDomainError("DOMAIN_CONFLICT", "repository text")],
    ["a raw stack hostname violation", pgUnique("uq_app_stack_domains_hostname")],
    ["a raw panel hostname claim violation", pgUnique("uq_panel_hostname_claim")],
    ["a wrapped violation", Object.assign(new Error("query failed"), { cause: pgUnique("uq_panel_hostname_claim") })],
  ])("DOMAIN_CONFLICT from %s never names the other owner", (_, err) => {
    expect(mapped(err)).toMatchObject({ status: 409, code: "DOMAIN_CONFLICT", message: APP_DOMAIN_CONFLICT, details: [] });
  });

  it("maps the other domain errors", () => {
    expect(mapped(new AppStackDomainError("DOMAIN_LIMIT", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "An application can have at most 8 web addresses.", { field: "domains", reason: "STACK_QUOTA_EXCEEDED" }),
    );
    expect(mapped(new AppStackDomainError("VALIDATION_ERROR", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "This web address cannot point at that part of the application.", {
        field: "componentKey",
        reason: "unknown_ingress",
      }),
    );
    expect(mapped(new AppStackDomainError("NOT_FOUND", "x"))).toMatchObject({ status: 404, message: APP_NOT_FOUND });
  });

  it("maps the refusals of the routing options (ADR-0037), each with the field it is about", () => {
    expect(mapped(new AppStackDomainError("REDIRECT_TARGET", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "Choose another web address of this application.", { field: "redirectToDomainId", reason: "redirect_target" }),
    );
    expect(mapped(new AppStackDomainError("REDIRECT_CHAIN", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "A web address that redirects cannot be the destination of another one.", {
        field: "redirectToDomainId",
        reason: "redirect_chain",
      }),
    );
    expect(mapped(new AppStackDomainError("PASSWORD_REQUIRED", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "Choose a password for this web address.", { field: "protection.password", reason: "password_required" }),
    );
  });

  it("an address being removed is neither changed nor removed again (issue #112)", () => {
    expect(mapped(new AppStackDomainError("REMOVING", "x"))).toMatchObject({
      ...one(409, "RESOURCE_LOCKED", "This web address is being removed.", { field: "domainId", reason: "address_removing" }),
      retryable: false,
    });
    // Nor does a new version drop what only such an address still points at: the same refusal, on the field of the version.
    // A failed application, or one whose stop failed, never withdraws the route by itself: the message says what does.
    const message =
      "A web address this version no longer serves is still being removed. Try again in a few minutes. If it is still not possible, restart the application (or stop it, if it does not start), then try again.";
    expect(mapped(new AppStackRepositoryError("ADDRESS_REMOVING", "x"))).toMatchObject({
      ...one(409, "RESOURCE_LOCKED", message, { field: "domains", reason: "address_removing" }),
      retryable: false,
    });
  });

  it("maps a TLS coverage refusal like a site domain add", () => {
    expect(mapped(new TlsCoverageError("DOMAIN_CONFLICT", "foreign_coverage", "x"))).toMatchObject({
      code: "DOMAIN_CONFLICT",
      message: APP_DOMAIN_CONFLICT,
    });
    expect(mapped(new TlsCoverageError("CERTIFICATE_IN_USE", "captures_host", "covered", "app.example.test"))).toMatchObject({
      code: "CERTIFICATE_IN_USE",
      details: [{ field: "hostname", reason: "captures_host", message: "app.example.test" }],
    });
  });

  it("maps the secret errors with fixed sentences", () => {
    expect(mapped(new AppStackSecretError("NOT_FOUND", "x"))).toMatchObject({ status: 404, message: APP_NOT_FOUND });
    expect(mapped(new AppStackSecretError("VALIDATION_ERROR", "x"))).toMatchObject(
      one(400, "VALIDATION_ERROR", "The value is empty or too long.", { field: "value", reason: "STACK_PARAMETER_INVALID" }),
    );
    const missing = mapped(new AppStackSecretError("SECRET_MISSING", "Secret 'app_secret' version 2 is missing."));
    expect(missing).toMatchObject({ status: 400, code: "VALIDATION_ERROR", details: [{ reason: "STACK_SECRET_MISSING" }] });
    expect(JSON.stringify(missing)).not.toContain("app_secret");
    const limited = mapAppStackError(new AppStackSecretError("RATE_LIMITED", "Secret 'app_secret' x", 90_000)) as ControlPlaneError;
    expect(mapped(limited)).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many secret values were set on this application in the last hour. Try again later.",
      details: [],
      retryable: true,
    });
    expect(limited.retryAfterMs).toBe(90_000);
    expect(JSON.stringify(limited)).not.toContain("app_secret");
  });

  it("rewrites the plain lock and idempotency errors of the repository without echoing them", () => {
    const lock = Object.assign(new Error("Resource lock 'stack:stk_1' is currently held by active operation 'op_1'"), {
      code: "RESOURCE_LOCKED",
    });
    expect(mapped(lock)).toEqual({
      status: 409,
      code: "RESOURCE_LOCKED",
      message: "Another action is still running on this application. Try again when it ends.",
      details: [],
      retryable: true,
    });
    const conflict = Object.assign(new Error("Idempotency key 'k-1' was already used for a different request"), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(mapped(conflict)).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "The idempotency key was already used for a different request.",
      details: [],
    });
  });

  it("returns anything else unchanged", () => {
    const plainValidation = Object.assign(new Error("secret material"), { code: "VALIDATION_ERROR" });
    const own = new ControlPlaneError("RESOURCE_LOCKED", "Already mapped.");
    const otherUnique = pgUnique("uq_app_stacks_name");
    for (const err of [plainValidation, own, otherUnique, new Error("boom"), "text", null]) {
      expect(mapAppStackError(err)).toBe(err);
    }
  });
});

describe("customerIssuesError", () => {
  const issue = (path: string, code: AppTemplateIssue["code"], reason: AppTemplateIssue["reason"], line?: number): AppTemplateIssue => ({
    path,
    code,
    reason,
    message: "Fixed text.",
    ...(line === undefined ? {} : { line, column: 3 }),
  });

  it("lists parameter issues one by one and collapses every other issue into one template detail without positions", () => {
    const err = customerIssuesError([
      issue("services.app.image", "IMAGE_NOT_ALLOWLISTED", "STACK_IMAGE_NOT_ALLOWED", 12),
      issue("services.cache", "KEY_UNKNOWN", "STACK_TEMPLATE_INVALID", 30),
      issue("parameters.worker_count", "PARAM_VALUE_OUT_OF_RANGE", "STACK_PARAMETER_INVALID"),
      issue("parameters.app_secret", "SECRET_MISSING", "STACK_SECRET_MISSING"),
    ]);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toEqual([
      expect.objectContaining({ field: "templateVersionId", reason: "STACK_TEMPLATE_INVALID" }),
      { field: "parameters.worker_count", reason: "STACK_PARAMETER_INVALID", message: "PARAM_VALUE_OUT_OF_RANGE: Fixed text." },
      { field: "parameters.app_secret", reason: "STACK_SECRET_MISSING", message: "SECRET_MISSING: Fixed text." },
    ]);
    const text = JSON.stringify(err.details);
    expect(text).not.toMatch(/line|column|services\.|IMAGE_NOT_ALLOWLISTED/);
  });

  it("has no template detail when only parameters are wrong", () => {
    const err = customerIssuesError([issue("parameters.worker_count", "PARAM_VALUE_NOT_CUSTOMER", "STACK_PARAMETER_INVALID")]);
    expect(err.details.map((d) => d.field)).toEqual(["parameters.worker_count"]);
  });
});
