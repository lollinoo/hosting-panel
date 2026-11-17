import type { SiteTypeDefinition } from "@hosting-panel/contracts";

/** What the executor needs of a site type beyond the shared definition. */
export interface ExecutorSiteType {
  readonly def: SiteTypeDefinition;
  readonly files: {
    readonly programFile: string; // wordpress: "hp-files.php" (exec Cmd unchanged)
    readonly programFunctions: string; // top-level PHP appended to the core
    readonly programDispatch: string; // "} elseif (...) {" branches before the final else
    readonly ops: readonly string[]; // ops beyond the core; anything else is refused
    readonly slowOps: readonly string[]; // get the 570 s budget
    readonly protectedPaths: readonly string[];
    helperImage(siteImage: string | undefined): string; // never pulled
  };
  readonly backup: { readonly excludes: readonly string[] };
  readonly restore: {
    readonly filesImage: string; // needs GNU mv --exchange
    readonly keptDirs: readonly string[]; // recreated, planned entry by entry
    readonly leftInPlace: readonly string[]; // case patterns left by a restore, ".hp_rs_*" among them
    // Shell text with the exit codes passed in; null exactly when def.database is null.
    readonly dbGate: {
      functions(c: { readonly gateRemoveFailed: number }): string;
      prepareCheck(c: { readonly invalidDbName: number }): string;
    } | null;
  };
}
