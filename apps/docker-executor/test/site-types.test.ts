import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SITE_TYPE_KEYS, WORDPRESS_SITE_TYPE, type SiteTypeKey } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import { EXECUTOR_SITE_TYPES, resolveExecutorSiteType } from "../src/site-types/index.js";
import { TEST_EXECUTOR_SITE_TYPE } from "./support/test-site-type.js";
import type { ExecutorSiteType } from "../src/site-types/types.js";

const wordpress = EXECUTOR_SITE_TYPES.wordpress;
const DEFAULT_WORDPRESS_IMAGE = "wordpress:7.1.4-php8.4-apache";

// Each set follows what the builders do with the value (restore-jobs.ts, site-files-program.ts, sftp-platform.ts, site-files-helper.ts).
const SEG = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const SAFE: ReadonlyArray<readonly [string, RegExp, (t: ExecutorSiteType) => readonly string[]]> = [
  // Unquoted in `W=...` of sh, a PHP single-quoted literal, a bind `volume:path:rw`: no space, quote, `$`, `\`, `:`.
  ["mountPath", new RegExp(`^(/${SEG})+$`), (t) => [t.def.files.mountPath]],
  // Unquoted in `chown ... /v`, a field of the SFTP passwd line.
  ["owner", /^\d+:\d+$/, (t) => [t.def.files.owner]],
  // A volume name, also unchecked in the SFTP volume name.
  ["volumeSuffix", /^[a-z0-9]+$/, (t) => [t.def.files.volumeSuffix]],
  // Inside sh double quotes and unquoted in `for d in`: no quote, `$`, backtick, `\`, space or glob.
  ["keptDirs", new RegExp(`^${SEG}(/${SEG})*$`), (t) => t.restore.keptDirs],
  // Unquoted `case` patterns joined by `|`: `*` only, no space, `|`, `)`, quote or `$`.
  ["leftInPlace", /^[A-Za-z0-9._*-]+(\/[A-Za-z0-9._*-]+)*$/, (t) => t.restore.leftInPlace],
  // PHP single-quoted literals: no `'` or `\`.
  ["protectedPaths", new RegExp(`^${SEG}(/${SEG})*$`), (t) => t.files.protectedPaths],
  // Inside a single-quoted `grep -Eqx` expression: no regex sign, no quote.
  ["namePrefix", /^[a-z][a-z0-9]*$/, (t) => (t.def.database ? [t.def.database.namePrefix] : [])],
  // One file name joined to the program folder: no `/`, never `..`.
  ["programFile", new RegExp(`^${SEG}\\.php$`), (t) => [t.files.programFile]],
];

/** The fields of a type whose value holds a character unsafe where a builder puts it. */
const unsafeValues = (t: ExecutorSiteType): string[] =>
  SAFE.flatMap(([field, re, values]) =>
    values(t).filter((v) => !re.test(v) || v.split("/").includes("..")).map((v) => `${field}: ${v}`),
  );

describe("executor site types", () => {
  it("holds exactly the keys of SITE_TYPE_KEYS, each under its own key", () => {
    expect(Object.keys(EXECUTOR_SITE_TYPES).sort()).toEqual([...SITE_TYPE_KEYS].sort());
    for (const key of SITE_TYPE_KEYS) {
      expect(resolveExecutorSiteType(key)).toBe(EXECUTOR_SITE_TYPES[key]);
      expect(EXECUTOR_SITE_TYPES[key].def.key).toBe(key);
    }
  });

  it("has a database gate exactly when the definition has a database", () => {
    for (const t of [...Object.values(EXECUTOR_SITE_TYPES), TEST_EXECUTOR_SITE_TYPE]) {
      expect(t.restore.dbGate === null).toBe(t.def.database === null);
    }
  });

  it("refuses an unknown key with VALIDATION_ERROR", () => {
    for (const key of ["teststatic", "", "WordPress", "__proto__", "constructor"]) {
      expect(() => resolveExecutorSiteType(key as SiteTypeKey)).toThrow(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("gives WordPress the values the shipped code uses", () => {
    expect(wordpress.def).toBe(WORDPRESS_SITE_TYPE);
    expect(wordpress.def.files).toEqual({ volumeSuffix: "html", mountPath: "/var/www/html", owner: "33:33" });
    expect(wordpress.def.database).toEqual({ namePrefix: "wp" });
    expect(wordpress.files.programFile).toBe("hp-files.php");
    expect(wordpress.files.ops).toEqual([
      "import.put",
      "import.take",
      "import.stat",
      "import.discard",
      "import.unpack",
      "import.switch",
      "import.undo",
      "import.finish",
    ]);
    expect(wordpress.files.slowOps).toEqual(["import.unpack", "import.discard", "import.undo", "import.finish"]);
    expect(wordpress.files.protectedPaths).toEqual(["wp-content/mu-plugins/hp-mail.php"]);
    expect(wordpress.files.helperImage(undefined)).toBe(DEFAULT_WORDPRESS_IMAGE);
    expect(wordpress.files.helperImage("wordpress:7.1.4-php8.3-apache")).toBe("wordpress:7.1.4-php8.3-apache");
    expect(wordpress.files.helperImage("wordpress:7.1.4-php8.5-apache")).toBe("wordpress:7.1.4-php8.5-apache");
    expect(wordpress.files.helperImage("wordpress:latest")).toBe(DEFAULT_WORDPRESS_IMAGE);
    expect(wordpress.files.helperImage("busybox:1")).toBe(DEFAULT_WORDPRESS_IMAGE);
    expect(wordpress.backup.excludes).toEqual([".htpanel-import"]);
    expect(wordpress.restore.filesImage).toBe(DEFAULT_WORDPRESS_IMAGE);
    expect(wordpress.restore.keptDirs).toEqual(["wp-content", "wp-content/mu-plugins"]);
    expect(wordpress.restore.leftInPlace).toEqual([
      ".maintenance",
      ".maintenance.hp*",
      ".hp_rs_*",
      "wp-content",
      "wp-content/mu-plugins",
      "wp-content/mu-plugins/hp-mail.php",
    ]);
  });

  it("carries the import part of the files program", () => {
    const fns = wordpress.files.programFunctions;
    expect(fns.startsWith("const HP_IMPORT_DIR = '.htpanel-import';\n")).toBe(true);
    expect(fns.endsWith("    hp_import_sweep($s);\n    clearstatcache();\n    return (object)array();\n}")).toBe(true);
    expect(fns.split("\n")).toHaveLength(641);
    for (const op of ["put", "take", "stat", "discard", "unpack", "switch", "undo", "finish"]) {
      expect(fns).toContain(`function hp_import_op_${op}(`);
    }
    expect(wordpress.files.programDispatch).toBe(
      [
        "} elseif (str_starts_with($op, 'import.')) {",
        "    umask(022);",
        "    if ($op === 'import.put') {",
        "        hp_ok(hp_import_op_put($req, $root));",
        "    } elseif ($op === 'import.take') {",
        "        hp_ok(hp_import_op_take($req, $root));",
        "    } elseif ($op === 'import.stat') {",
        "        hp_ok(hp_import_op_stat($root));",
        "    } elseif ($op === 'import.discard') {",
        "        hp_ok(hp_import_op_discard($root));",
        "    } elseif ($op === 'import.unpack') {",
        "        hp_ok(hp_import_op_unpack($req, $root));",
        "    } elseif ($op === 'import.switch') {",
        "        hp_ok(hp_import_op_switch($req, $root));",
        "    } elseif ($op === 'import.undo') {",
        "        hp_ok(hp_import_op_undo($req, $root));",
        "    } elseif ($op === 'import.finish') {",
        "        hp_ok(hp_import_op_finish($req, $root));",
        "    }",
        '    fwrite(STDERR, "unknown op\\n");',
        "    exit(1);",
      ].join("\n"),
    );
  });

  it("carries the maintenance gate of the restore with the exit codes passed in", () => {
    const gate = wordpress.restore.dbGate;
    expect(gate?.functions({ gateRemoveFailed: 7 })).toBe(
      [
        "record_gate() {",
        '  if [ ! -f "$S/gate_recorded" ]; then',
        '    rm -rf "$S/gate_kept" "$S/gate_kept.tmp"',
        '    if [ -e "$W/.maintenance" ] || [ -L "$W/.maintenance" ]; then',
        '      cp -aP "$W/.maintenance" "$S/gate_kept.tmp"',
        '      [ -L "$S/gate_kept.tmp" ] || sync "$S/gate_kept.tmp"',
        '      mv -Tf "$S/gate_kept.tmp" "$S/gate_kept"',
        "    fi",
        '    : > "$S/gate_recorded.tmp"; sync "$S/gate_recorded.tmp"; mv -Tf "$S/gate_recorded.tmp" "$S/gate_recorded"; sync "$S"',
        "  fi",
        "}",
        "gate_on() {",
        '  tmp_gate="$W/.maintenance.hp.$$"',
        '  rm -rf "$tmp_gate"',
        `  (set -C; printf '<?php $upgrading = time(); ?>' > "$tmp_gate")`,
        '  sync "$tmp_gate"; rm -rf "$W/.maintenance"; mv -Tf "$tmp_gate" "$W/.maintenance"; sync "$W"',
        "}",
        "restore_gate() {",
        '  if [ -e "$S/gate_kept" ] || [ -L "$S/gate_kept" ]; then',
        '    tmp_gate="$W/.maintenance.hp.$$"',
        '    rm -rf "$tmp_gate"',
        '    cp -aP "$S/gate_kept" "$tmp_gate"',
        '    [ -L "$tmp_gate" ] || sync "$tmp_gate"',
        '    mv -Tf "$tmp_gate" "$W/.maintenance"',
        '    sync "$W"',
        "  else",
        '    rm -rf "$W/.maintenance"; sync "$W"',
        "  fi",
        "}",
        "gate_off() {",
        '  rm -rf "$W/.maintenance" 2>/dev/null || true',
        '  [ ! -e "$W/.maintenance" ] && [ ! -L "$W/.maintenance" ] || exit 7',
        '  sync "$W" 2>/dev/null || true',
        "}",
      ].join("\n"),
    );
    expect(gate?.prepareCheck({ invalidDbName: 8 })).toBe(
      [
        '  if [ -e "$W/.maintenance" ] || [ -L "$W/.maintenance" ]; then',
        '    [ -L "$W/.maintenance" ] || [ -f "$W/.maintenance" ] || exit 8',
        "  fi",
      ].join("\n"),
    );
  });

  it("keeps the WordPress files free of imports from the general files", async () => {
    for (const file of ["wordpress.ts", "wordpress-files-program.ts", "wordpress-restore.ts"]) {
      const text = await readFile(fileURLToPath(new URL(`../src/site-types/${file}`, import.meta.url)), "utf8");
      const sources = [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect(text).not.toMatch(/\bimport\s*\(/);
      for (const source of sources) {
        expect(["@hosting-panel/contracts", "./types.js", "./wordpress-files-program.js", "./wordpress-restore.js"]).toContain(source);
      }
    }
  });

  it("holds only characters safe where the builders put them, for every type and the test type", () => {
    for (const t of [...Object.values(EXECUTOR_SITE_TYPES), TEST_EXECUTOR_SITE_TYPE]) {
      expect(unsafeValues(t), t.def.key).toEqual([]);
    }
    // The check itself: a space in a mount path, a double quote in a kept folder.
    const T = TEST_EXECUTOR_SITE_TYPE;
    const forged: ExecutorSiteType = {
      ...T,
      def: { ...T.def, files: { ...T.def.files, mountPath: "/srv/my site" } },
      restore: { ...T.restore, keptDirs: ['up"loads'] },
    };
    expect(unsafeValues(forged)).toEqual(["mountPath: /srv/my site", 'keptDirs: up"loads']);
  });

  it("gives the test type no value of WordPress", () => {
    const t = TEST_EXECUTOR_SITE_TYPE;
    expect(t.def.key).toBe("teststatic");
    expect(t.def.files).toEqual({ volumeSuffix: "public", mountPath: "/srv/public", owner: "1000:1000" });
    expect(t.def.database).toBeNull();
    expect(t.restore.dbGate).toBeNull();
    const text = JSON.stringify(t) + t.files.helperImage(undefined) + t.files.helperImage("wordpress:7.1.4-php8.4-apache");
    expect(text).not.toMatch(/wordpress|wp-|wp_|\/var\/www\/html|33:33|"html"|\.maintenance|mu-plugins|wp-config|htpanel/i);
  });
});
