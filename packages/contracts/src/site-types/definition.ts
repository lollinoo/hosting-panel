import type { OperationKind } from "../operations.js";

/** Constant facts of a site type, read by every layer. Code only: never from a request, a row or a file. */
export interface SiteTypeDefinition {
  /** Stored in sites.site_type and sent to the executor. */
  readonly key: string;
  /** The service template row behind the type's site container. */
  readonly templateId: string;
  /** The site's files: volume suffix, mount path in the container, owner as uid:gid. */
  readonly files: { readonly volumeSuffix: string; readonly mountPath: string; readonly owner: string };
  /** The type's database and its name prefix; null when the type has none. */
  readonly database: { readonly namePrefix: string } | null;
  /** The type's own operation kinds that count as heavy actions. */
  readonly heavyOperationKinds: readonly OperationKind[];
}
