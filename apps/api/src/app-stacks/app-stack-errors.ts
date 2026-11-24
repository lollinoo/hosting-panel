import { MAX_APP_STACK_DOMAINS, type AppTemplateIssue, type ErrorDetail } from "@hosting-panel/contracts";
import {
  AppStackBackupRepositoryError,
  AppStackDomainError,
  AppStackRepositoryError,
  AppStackSecretError,
  TlsCoverageError,
} from "@hosting-panel/database";
import { appNotFound, appRefusal } from "../app-templates/app-template-errors.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { coverageError } from "../sites/site-domains.service.js";
import { appStackQuotaError } from "./app-stack-limit.js";

/** Same text as site-domains.service.ts (asserted by site tests; keep identical). */
export const APP_DOMAIN_CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const HOSTNAME_CONSTRAINTS = ["uq_app_stack_domains_hostname", "uq_panel_hostname_claim"];

/** H11: parameters.* issues one by one (no position), any other issue → one STACK_TEMPLATE_INVALID detail. */
export function customerIssuesError(issues: readonly AppTemplateIssue[]): ControlPlaneError {
  const parameterIssues = issues.filter((issue) => issue.path.startsWith("parameters."));
  const details: ErrorDetail[] = parameterIssues.map((issue) => ({
    field: issue.path,
    reason: issue.reason,
    message: `${issue.code}: ${issue.message}`,
  }));
  if (parameterIssues.length < issues.length) {
    details.unshift({
      field: "templateVersionId",
      reason: "STACK_TEMPLATE_INVALID",
      message: "This version no longer passes the current checks and cannot be installed.",
    });
  }
  return new ControlPlaneError("VALIDATION_ERROR", "The application settings are not valid.", { details });
}

function isHostnameClaimViolation(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const names = (name: string) => e.constraint === name || (typeof e.message === "string" && e.message.includes(name));
    if (e.code === "23505" && HOSTNAME_CONSTRAINTS.some(names)) return true;
    current = e.cause;
  }
  return false;
}

function mapRepositoryError(err: AppStackRepositoryError): ControlPlaneError {
  switch (err.code) {
    case "NOT_FOUND":
      return appNotFound();
    case "NAME_TAKEN": {
      const message = "An application with this name already exists.";
      return appRefusal("ALREADY_EXISTS", message, { field: "name", message, reason: "name_taken" });
    }
    case "TEMPLATE_UNPUBLISHED": {
      const message = "This version can no longer be installed. Choose the current version.";
      return appRefusal("VALIDATION_ERROR", message, { field: "templateVersionId", message, reason: "STACK_TEMPLATE_UNPUBLISHED" });
    }
    case "TEMPLATE_MISMATCH":
    case "NO_REVISION": {
      const message = "The application cannot use this version.";
      return appRefusal("VALIDATION_ERROR", message, { field: "templateVersionId", message, reason: "STACK_TEMPLATE_INVALID" });
    }
    case "INVALID_TRANSITION": {
      const status = err.status ?? "unknown";
      const message = `This action is not possible while the application is ${status}.`;
      return appRefusal("RESOURCE_LOCKED", message, { field: "status", message, reason: status }, false);
    }
    case "COMPONENT_IN_USE": {
      const message = "A web address still points at a part this version removes. Remove the address first.";
      return appRefusal("VALIDATION_ERROR", message, { field: "domains", message, reason: "domain_target_removed" });
    }
    case "PATH_IN_USE": {
      const message = "A path of a web address still points at a part this version removes. Remove the path first.";
      return appRefusal("VALIDATION_ERROR", message, { field: "domains", message, reason: "path_target_removed" });
    }
  }
}

function mapDomainError(err: AppStackDomainError): ControlPlaneError {
  switch (err.code) {
    case "NOT_FOUND":
      return appNotFound();
    case "DOMAIN_CONFLICT":
      return new ControlPlaneError("DOMAIN_CONFLICT", APP_DOMAIN_CONFLICT);
    case "DOMAIN_LIMIT": {
      const message = `An application can have at most ${String(MAX_APP_STACK_DOMAINS)} web addresses.`;
      return appRefusal("VALIDATION_ERROR", message, { field: "domains", message, reason: "STACK_QUOTA_EXCEEDED" });
    }
    case "VALIDATION_ERROR": {
      const message = "This web address cannot point at that part of the application.";
      return appRefusal("VALIDATION_ERROR", message, { field: "componentKey", message, reason: "unknown_ingress" });
    }
    case "REDIRECT_TARGET": {
      const message = "Choose another web address of this application.";
      return appRefusal("VALIDATION_ERROR", message, { field: "redirectToDomainId", message, reason: "redirect_target" });
    }
    case "REDIRECT_CHAIN": {
      const message = "A web address that redirects cannot be the destination of another one.";
      return appRefusal("VALIDATION_ERROR", message, { field: "redirectToDomainId", message, reason: "redirect_chain" });
    }
    case "PASSWORD_REQUIRED": {
      const message = "Choose a password for this web address.";
      return appRefusal("VALIDATION_ERROR", message, { field: "protection.password", message, reason: "password_required" });
    }
  }
}

function mapSecretError(err: AppStackSecretError): ControlPlaneError {
  switch (err.code) {
    case "NOT_FOUND":
      return appNotFound();
    case "VALIDATION_ERROR": {
      const message = "The value is empty or too long.";
      return appRefusal("VALIDATION_ERROR", message, { field: "value", message, reason: "STACK_PARAMETER_INVALID" });
    }
    case "SECRET_MISSING": {
      const message = "Set every required secret before the application is deployed.";
      return appRefusal("VALIDATION_ERROR", message, { message, reason: "STACK_SECRET_MISSING" });
    }
    case "RATE_LIMITED":
      return new ControlPlaneError("RATE_LIMITED", "Too many secret values were set on this application in the last hour. Try again later.", {
        retryable: true,
        retryAfterMs: err.retryAfterMs,
      });
  }
}

/** Backups (ADR-0038): one detail each, because the web reads `details[0].reason`. */
function mapBackupError(err: AppStackBackupRepositoryError): ControlPlaneError {
  switch (err.code) {
    case "BACKUP_NOT_FOUND":
      return appNotFound();
    case "NO_DATA": {
      const message = "This application has no data to save.";
      return appRefusal("VALIDATION_ERROR", message, { field: "backup", message, reason: "no_data" });
    }
    case "NO_DESTINATION": {
      const message = "No backup destination is set up on this server. Ask your administrator.";
      return appRefusal("VALIDATION_ERROR", message, { field: "backup", message, reason: "no_destination" });
    }
    case "NOT_RESTORABLE": {
      const message = "This backup cannot be restored.";
      return appRefusal("VALIDATION_ERROR", message, { field: "backupId", message, reason: "not_restorable" });
    }
    case "TOO_MANY": {
      const retryAt = err.retryAt ?? new Date();
      const iso = retryAt.toISOString();
      return new ControlPlaneError("QUOTA_EXCEEDED", `Too many backup actions on this application; try again at ${iso}`, {
        details: [{ field: "retryAt", reason: "too_many_requests", message: iso }],
        retryAfterMs: Math.max(1_000, retryAt.getTime() - Date.now()),
      });
    }
  }
}

/** Repository and domain errors → public errors; anything else is returned unchanged (caller rethrows). */
export function mapAppStackError(err: unknown): unknown {
  if (err instanceof ControlPlaneError) return err;
  if (err instanceof AppStackRepositoryError) return mapRepositoryError(err);
  if (err instanceof AppStackBackupRepositoryError) return mapBackupError(err);
  if (err instanceof AppStackDomainError) return mapDomainError(err);
  if (err instanceof AppStackSecretError) return mapSecretError(err);
  if (err instanceof TlsCoverageError) return coverageError(err);
  if (isHostnameClaimViolation(err)) return new ControlPlaneError("DOMAIN_CONFLICT", APP_DOMAIN_CONFLICT);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "RESOURCE_LOCKED") {
    return new ControlPlaneError("RESOURCE_LOCKED", "Another action is still running on this application. Try again when it ends.", {
      retryable: true,
    });
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return new ControlPlaneError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
  }
  return appStackQuotaError(err);
}
