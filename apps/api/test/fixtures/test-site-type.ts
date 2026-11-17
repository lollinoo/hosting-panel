import type { ApiSiteType } from "../../src/site-types/index.js";

/** A static site type with no database, mirroring the executor's test type. */
export const TEST_API_SITE_TYPE: ApiSiteType = {
  definition: {
    key: "teststatic",
    templateId: "tpl_site_teststatic",
    files: { volumeSuffix: "public", mountPath: "/srv/public", owner: "1000:1000" },
    database: null,
    heavyOperationKinds: [],
  },
  image: () => "hp-test-static:1",
  install: null,
  addressJob: () => null,
  fileReasonMessages: {},
};
