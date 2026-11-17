import type { ExecutorSiteType } from "../../src/site-types/index.js";

/** A static site type with no database, mirroring the control plane's test type. */
export const TEST_EXECUTOR_SITE_TYPE: ExecutorSiteType = {
  def: {
    key: "teststatic",
    templateId: "tpl_site_teststatic",
    files: { volumeSuffix: "public", mountPath: "/srv/public", owner: "1000:1000" },
    database: null,
    heavyOperationKinds: [],
  },
  files: {
    programFile: "hp-files-teststatic.php",
    programFunctions: "",
    programDispatch: "",
    ops: [],
    slowOps: [],
    protectedPaths: [],
    helperImage: () => "hp-test-static-helper:1",
  },
  backup: { excludes: [] },
  restore: {
    filesImage: "hp-test-static-files:1",
    keptDirs: [],
    leftInPlace: [],
    dbGate: null,
  },
};
