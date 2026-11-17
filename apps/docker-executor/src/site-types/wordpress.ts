import {
  DEFAULT_PHP_VERSION,
  SUPPORTED_PHP_VERSIONS,
  WORDPRESS_SITE_TYPE,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import type { ExecutorSiteType } from "./types.js";
import { WORDPRESS_FILES_PROGRAM_DISPATCH, WORDPRESS_FILES_PROGRAM_FUNCTIONS } from "./wordpress-files-program.js";
import {
  WORDPRESS_RESTORE_DB_GATE,
  WORDPRESS_RESTORE_KEPT_DIRS,
  WORDPRESS_RESTORE_LEFT_IN_PLACE,
} from "./wordpress-restore.js";

const ALLOWED_WORDPRESS_IMAGES: ReadonlySet<string> = new Set(SUPPORTED_PHP_VERSIONS.map(resolveWordpressImage));

/** The WordPress site type as the executor ships it today. */
export const WORDPRESS_EXECUTOR_SITE_TYPE: ExecutorSiteType = {
  def: WORDPRESS_SITE_TYPE,
  files: {
    programFile: "hp-files.php",
    programFunctions: WORDPRESS_FILES_PROGRAM_FUNCTIONS,
    programDispatch: WORDPRESS_FILES_PROGRAM_DISPATCH,
    ops: [
      "import.put",
      "import.take",
      "import.stat",
      "import.discard",
      "import.unpack",
      "import.switch",
      "import.undo",
      "import.finish",
    ],
    slowOps: ["import.unpack", "import.discard", "import.undo", "import.finish"],
    protectedPaths: ["wp-content/mu-plugins/hp-mail.php"],
    helperImage: (siteImage) =>
      siteImage !== undefined && ALLOWED_WORDPRESS_IMAGES.has(siteImage)
        ? siteImage
        : resolveWordpressImage(DEFAULT_PHP_VERSION),
  },
  backup: { excludes: [".htpanel-import"] },
  restore: {
    filesImage: resolveWordpressImage(DEFAULT_PHP_VERSION),
    keptDirs: WORDPRESS_RESTORE_KEPT_DIRS,
    leftInPlace: WORDPRESS_RESTORE_LEFT_IN_PLACE,
    dbGate: WORDPRESS_RESTORE_DB_GATE,
  },
};
