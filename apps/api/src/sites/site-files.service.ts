import { Inject, Injectable } from "@nestjs/common";
import {
  ERROR_CODES,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  type ErrorCode,
  type SiteFileArchiveRequest,
  type SiteFileChunkDto,
  type SiteFileErrorReason,
  type SiteFileExtractRequest,
  type SiteFileListDto,
  type SiteFileWriteResultDto,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  enqueueOperationTransactional,
  eq,
  serviceInstances,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type {
  DockerExecutorPort,
  SiteFilesRequest,
  SiteFilesResult,
} from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import type { ManagedSiteAccepted } from "./managed-sites.service.js";

const AUDIT_PATH_MAX_CHARS = 256;
const AUDIT_BATCH_PATHS_MAX = 20;

export interface SiteFilesStepDef {
  readonly key: string;
  readonly label: string;
}

export const SITE_FILES_ARCHIVE_STEPS: readonly SiteFilesStepDef[] = [
  { key: "archive_files", label: "Create the archive" },
];

export const SITE_FILES_EXTRACT_STEPS: readonly SiteFilesStepDef[] = [
  { key: "extract_files", label: "Extract the archive" },
];

export interface SiteFilesSiteRef {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

export interface SiteFilesActor {
  readonly id: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly actionPrefix?: "site.files" | "admin.site.files";
}

export interface SiteFileWriteInput {
  readonly path: string;
  readonly uploadId: string;
  readonly offset: number;
  readonly dataBase64: string;
  readonly final: boolean;
  readonly overwrite: boolean;
}

const SITE_FILE_REASON_SET: ReadonlySet<string> = new Set(SITE_FILE_ERROR_REASONS);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

const SAFE_REASON_MESSAGES: Readonly<Record<SiteFileErrorReason, string>> = {
  invalid_path: "The file path is invalid.",
  not_a_directory: "The target path is not a folder.",
  is_a_directory: "The target path is a folder, not a file.",
  upload_mismatch: "The upload chunk does not match the active transfer.",
  not_a_zip: "The selected file is not a valid zip archive.",
  archive_unsafe: "The archive contains unsafe file entries.",
  not_found: "The requested file or folder was not found.",
  exists: "A file or folder already exists at the destination.",
  protected: "This file or folder is protected and cannot be modified.",
  too_large: "The file exceeds the maximum allowed size.",
  archive_limit: "The archive exceeds the maximum allowed size or entry count.",
  disk_full: "There is not enough storage space left for this site.",
  zip_unavailable: "Archive operations are temporarily unavailable.",
  not_ready: "Site files are not available until the site finishes updating.",
};

const SAFE_CODE_MESSAGES: Partial<Readonly<Record<ErrorCode, string>>> = {
  VALIDATION_ERROR: "The file request is invalid.",
  NOT_FOUND: "The requested file or folder was not found.",
  ALREADY_EXISTS: "A file or folder already exists at the destination.",
  PERMISSION_DENIED: "This file action was refused.",
  QUOTA_EXCEEDED: "The site storage limit has been reached.",
  RESOURCE_LOCKED: "Another operation is currently in progress for this site.",
  NOT_SUPPORTED: "This file action is not supported.",
  HOST_POLICY_DENIED: "This file action was blocked by safety policy.",
  OPERATION_AMBIGUOUS: "The file operation outcome could not be confirmed.",
  OPERATION_INTERRUPTED: "This file operation was interrupted before it finished.",
  DOCKER_ENGINE_UNAVAILABLE: "File operations are temporarily unavailable.",
};

function safeMessageForCode(code: ErrorCode): string {
  return SAFE_CODE_MESSAGES[code] ?? "The file operation failed.";
}

/** Builds a ControlPlaneError for a known R2 file error reason without leaking raw messages. */
export function siteFileReasonError(reason: SiteFileErrorReason): ControlPlaneError {
  const message = SAFE_REASON_MESSAGES[reason];
  return new ControlPlaneError(SITE_FILE_REASON_CODES[reason], message, {
    details: [{ message, reason }],
  });
}

/**
 * Maps any executor/IPC failure onto a customer-safe ControlPlaneError per ruling R2.
 * Exposes a `reason` detail ONLY when the error message matches `SITE_FILE_ERROR_REASONS`.
 */
export function mapSiteFileExecutorError(err: unknown): ControlPlaneError {
  if (err instanceof ControlPlaneError) {
    return err;
  }

  const rawMessage = err instanceof Error ? err.message : "";
  if (SITE_FILE_REASON_SET.has(rawMessage)) {
    return siteFileReasonError(rawMessage as SiteFileErrorReason);
  }

  const ambiguous =
    typeof err === "object" &&
    err !== null &&
    (err as { ambiguousOutcome?: unknown }).ambiguousOutcome === true;
  if (ambiguous) {
    return new ControlPlaneError(
      "OPERATION_AMBIGUOUS",
      safeMessageForCode("OPERATION_AMBIGUOUS"),
    );
  }

  const rawCode =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const code: ErrorCode =
    typeof rawCode === "string" && ERROR_CODE_SET.has(rawCode)
      ? (rawCode as ErrorCode)
      : "DOCKER_ENGINE_UNAVAILABLE";

  return new ControlPlaneError(code, safeMessageForCode(code));
}

function truncateAuditPath(path: string): string {
  return path.length <= AUDIT_PATH_MAX_CHARS ? path : path.slice(0, AUDIT_PATH_MAX_CHARS);
}

function truncateAuditPaths(paths: readonly string[]): readonly string[] {
  return paths.slice(0, AUDIT_BATCH_PATHS_MAX).map(truncateAuditPath);
}

/**
 * Verifies site readiness and runtime availability, returning the web service instance ID.
 * Shared by both sync controller operations and the async archive/extract applier.
 */
export async function resolveSiteFilesServiceId(
  db: HostingPanelDatabase,
  executor: DockerExecutorPort,
  config: ControlPlaneRuntimeConfig,
  site: SiteFilesSiteRef,
): Promise<string> {
  if (site.status === "deploying" || site.status === "maintenance") {
    throw siteFileReasonError("not_ready");
  }
  if (config.runtimeBackend === "disabled" || !executor.isRuntimeAvailable) {
    throw new ControlPlaneError(
      "NOT_SUPPORTED",
      "Site file management is not available when the runtime backend is disabled.",
    );
  }

  const [service] = await db
    .select({ id: serviceInstances.id })
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.siteId, site.id),
        eq(serviceInstances.organizationId, site.organizationId),
      ),
    )
    .orderBy(asc(serviceInstances.createdAt), asc(serviceInstances.id))
    .limit(1);

  if (!service) {
    throw siteFileReasonError("not_ready");
  }
  return service.id;
}

/**
 * Domain service for site webroot file operations and async archive/extract queueing.
 * Methods accept `(site, actor, input)` with no HTTP/controller coupling so future admin endpoints can reuse them directly.
 */
@Injectable()
export class SiteFilesService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Lists directory entries within a managed site's webroot. */
  public async list(
    site: SiteFilesSiteRef,
    _actor: SiteFilesActor,
    input: { readonly path: string },
  ): Promise<SiteFileListDto> {
    return await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "list",
      path: input.path,
    }));
  }

  /** Reads a bounded byte chunk from a managed site file. */
  public async read(
    site: SiteFilesSiteRef,
    _actor: SiteFilesActor,
    input: { readonly path: string; readonly offset: number; readonly length: number },
  ): Promise<SiteFileChunkDto> {
    return await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "read",
      path: input.path,
      offset: input.offset,
      length: input.length,
    }));
  }

  /** Writes a chunk of an upload and records one audit row when `final` is true. */
  public async write(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: SiteFileWriteInput,
  ): Promise<SiteFileWriteResultDto> {
    const result = await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "write",
      path: input.path,
      uploadId: input.uploadId,
      offset: input.offset,
      dataBase64: input.dataBase64,
      final: input.final,
      overwrite: input.overwrite,
    }));

    if (input.final) {
      await this.#recordFileAudit(site, actor, "upload", {
        path: truncateAuditPath(input.path),
        size: result.received,
      });
    }
    return result;
  }

  /** Creates a folder inside the site's webroot and audits the mutation. */
  public async mkdir(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: { readonly path: string },
  ): Promise<void> {
    await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "mkdir",
      path: input.path,
    }));
    await this.#recordFileAudit(site, actor, "folder.create", {
      path: truncateAuditPath(input.path),
    });
  }

  /** Moves or renames a file/folder inside the site's webroot and audits the mutation. */
  public async move(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: { readonly from: string; readonly to: string },
  ): Promise<void> {
    await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "move",
      from: input.from,
      to: input.to,
    }));
    await this.#recordFileAudit(site, actor, "move", {
      from: truncateAuditPath(input.from),
      to: truncateAuditPath(input.to),
    });
  }

  /** Deletes one or more relative paths from the site's webroot and audits once with capped paths. */
  public async remove(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: { readonly paths: readonly string[] },
  ): Promise<void> {
    await this.#callExecutor(site, (serviceInstanceId) => ({
      serviceInstanceId,
      op: "delete",
      paths: [...input.paths],
    }));
    await this.#recordFileAudit(site, actor, "delete", {
      paths: truncateAuditPaths(input.paths),
      count: input.paths.length,
    });
  }

  /** Enqueues an asynchronous zip creation operation under the site's operation lock. */
  public async enqueueArchive(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: { readonly body: SiteFileArchiveRequest; readonly idempotencyKey: string },
  ): Promise<ManagedSiteAccepted> {
    return await this.#enqueueFileOp(site, actor, {
      kind: "site.files.archive",
      idempotencyKey: input.idempotencyKey,
      steps: SITE_FILES_ARCHIVE_STEPS,
      outboxPayload: { op: "archive", paths: input.body.paths, to: input.body.to },
      auditSuffix: "archive",
      auditDetails: {
        paths: truncateAuditPaths(input.body.paths),
        count: input.body.paths.length,
        to: truncateAuditPath(input.body.to),
      },
    });
  }

  /** Enqueues an asynchronous zip extraction operation under the site's operation lock. */
  public async enqueueExtract(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    input: { readonly body: SiteFileExtractRequest; readonly idempotencyKey: string },
  ): Promise<ManagedSiteAccepted> {
    return await this.#enqueueFileOp(site, actor, {
      kind: "site.files.extract",
      idempotencyKey: input.idempotencyKey,
      steps: SITE_FILES_EXTRACT_STEPS,
      outboxPayload: { op: "extract", path: input.body.path, to: input.body.to },
      auditSuffix: "extract",
      auditDetails: {
        path: truncateAuditPath(input.body.path),
        to: truncateAuditPath(input.body.to),
      },
    });
  }

  async #enqueueFileOp(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    spec: {
      readonly kind: "site.files.archive" | "site.files.extract";
      readonly idempotencyKey: string;
      readonly steps: readonly SiteFilesStepDef[];
      readonly outboxPayload: Record<string, unknown>;
      readonly auditSuffix: "archive" | "extract";
      readonly auditDetails: Record<string, unknown>;
    },
  ): Promise<ManagedSiteAccepted> {
    await resolveSiteFilesServiceId(
      this.dbClient.db,
      this.dockerExecutor,
      this.config,
      site,
    );

    const enqueued = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId: site.organizationId,
      kind: spec.kind,
      resourceType: "site",
      resourceId: site.id,
      requestedByUserId: actor.id,
      idempotencyKey: spec.idempotencyKey,
      lockKey: `site:${site.id}`,
      steps: [...spec.steps],
      outboxPayload: spec.outboxPayload,
    });

    if (!enqueued.idempotentReplay) {
      await this.#recordFileAudit(site, actor, spec.auditSuffix, {
        ...spec.auditDetails,
        operationId: enqueued.operation.id,
      });
    }

    return { siteId: site.id, operationId: enqueued.operation.id };
  }

  async #callExecutor<R extends SiteFilesRequest>(
    site: SiteFilesSiteRef,
    buildReq: (serviceInstanceId: string) => R,
  ): Promise<SiteFilesResult<R["op"]>> {
    const serviceInstanceId = await resolveSiteFilesServiceId(
      this.dbClient.db,
      this.dockerExecutor,
      this.config,
      site,
    );
    try {
      return await this.dockerExecutor.siteFiles(buildReq(serviceInstanceId));
    } catch (err) {
      throw mapSiteFileExecutorError(err);
    }
  }

  async #recordFileAudit(
    site: SiteFilesSiteRef,
    actor: SiteFilesActor,
    actionSuffix: "upload" | "folder.create" | "move" | "delete" | "archive" | "extract",
    details: Record<string, unknown>,
  ): Promise<void> {
    const prefix = actor.actionPrefix ?? "site.files";
    await appendAuditEvent(this.dbClient.db, {
      actorId: actor.id,
      actorType: "user",
      organizationId: site.organizationId,
      action: `${prefix}.${actionSuffix}`,
      targetType: "site",
      targetId: site.id,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      details: {
        outcome: "succeeded",
        ...(actor.requestId ? { requestId: actor.requestId } : {}),
        ...details,
      },
    });
  }
}
