import type { SiteFileErrorReason, SiteImportOp, SiteTypeDefinition, SiteTypeKey } from "@hosting-panel/contracts";
import type { SiteFilesRequest } from "@hosting-panel/executor-contracts";
import type { SimDir, SimRoot } from "./simulator-files.js";
import { WORDPRESS_SIMULATOR_SITE_TYPE } from "./simulator-wordpress-files.js";
import { ExecutorCodedError } from "./traefik-config.js";

/** What `failNextImport` makes the next call of an `import.*` operation do. */
export type SimImportOutcome = SiteFileErrorReason | "undo_incomplete" | "timeout";

/** One simulator's state of a type's own file operations, with its test hooks. */
export interface SimulatorSiteOps {
  handle(root: SimRoot, req: SiteFilesRequest): unknown;
  drop(svc: string): void;
  readonly importFailures: Map<SiteImportOp, SimImportOutcome>; // pending one-shot failures, cleared by tests
  failNextImport(op: SiteImportOp, outcome: SimImportOutcome): void;
  importState(svc: string): { gate: boolean; plans: string[] };
}

/** What the simulator needs of a site type. */
export interface SimulatorSiteType {
  readonly def: SiteTypeDefinition;
  readonly protectedPaths: readonly string[];
  readonly shellId: string; // what `id` prints in the terminal
  seed(): SimDir;
  readonly ops: readonly string[]; // ops beyond the core; anything else is refused
  readonly createOps: (() => SimulatorSiteOps) | null;
}

const SIMULATOR_SITE_TYPES: Readonly<Record<SiteTypeKey, SimulatorSiteType>> = {
  wordpress: WORDPRESS_SIMULATOR_SITE_TYPE,
};

/** The simulator's type for a key; an unknown key is refused as the real executor does. */
export function resolveSimulatorSiteType(key: SiteTypeKey): SimulatorSiteType {
  if (!Object.hasOwn(SIMULATOR_SITE_TYPES, key)) {
    throw new ExecutorCodedError("Unknown site type", "VALIDATION_ERROR");
  }
  return SIMULATOR_SITE_TYPES[key];
}
