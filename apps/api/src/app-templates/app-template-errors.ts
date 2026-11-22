import type { AppTemplateIssue, ErrorCode, ErrorDetail } from "@hosting-panel/contracts";
import { AppTemplateRepositoryError } from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const APP_NOT_FOUND = "Requested organization or resource was not found.";
const MAX_REFUSAL_DETAILS = 20;

export function appNotFound(): ControlPlaneError {
  return new ControlPlaneError("NOT_FOUND", APP_NOT_FOUND);
}

/** One detail, like site-templates.service.ts:62. */
export function appRefusal(code: ErrorCode, message: string, detail: ErrorDetail, retryable?: boolean): ControlPlaneError {
  return new ControlPlaneError(code, message, { details: [detail], ...(retryable === undefined ? {} : { retryable }) });
}

/** Admin: ≤ 20 positioned details (field = issue.path || "source"; message "line L, column C: CODE: message"). */
export function adminTemplateInvalid(issues: readonly AppTemplateIssue[], message = "The template is not valid."): ControlPlaneError {
  return new ControlPlaneError("VALIDATION_ERROR", message, {
    details: issues.slice(0, MAX_REFUSAL_DETAILS).map((issue) => ({
      field: issue.path === "" ? "source" : issue.path,
      message: `${issue.line === undefined ? "" : `line ${issue.line}, column ${issue.column ?? 1}: `}${issue.code}: ${issue.message}`,
      reason: issue.reason,
    })),
  });
}

/** Repository and domain errors → public errors; anything else is returned unchanged (caller rethrows). */
export function mapAppTemplateError(err: unknown): unknown {
  if (!(err instanceof AppTemplateRepositoryError)) return err;
  switch (err.code) {
    case "NOT_FOUND":
      return appNotFound();
    case "ARCHIVED": {
      const message = "This application template is archived and cannot be changed.";
      return appRefusal("RESOURCE_LOCKED", message, { message, reason: "template_archived" }, false);
    }
    case "BUILT_IN": {
      const message = "A built-in application template cannot be archived.";
      return appRefusal("RESOURCE_LOCKED", message, { message, reason: "built_in" }, false);
    }
    case "SLUG_TAKEN": {
      const message = "An application template with this slug already exists.";
      return appRefusal("ALREADY_EXISTS", message, { field: "slug", message, reason: "slug_taken" });
    }
    case "INVALID_DEFAULT": {
      const message = "The default version must be a version of this template.";
      return appRefusal("VALIDATION_ERROR", message, { field: "defaultVersionId", message, reason: "unknown_version" });
    }
  }
}

export async function guardedApp<T>(map: (err: unknown) => unknown, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw map(err);
  }
}
