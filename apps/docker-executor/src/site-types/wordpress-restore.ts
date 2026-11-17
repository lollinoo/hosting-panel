import type { ExecutorSiteType } from "./types.js";

// The WordPress maintenance gate of the restore, moved out of restore-jobs.ts.
export const RESTORE_MAINTENANCE_FILE_CONTENT = "<?php $upgrading = time(); ?>" as const;

export const WORDPRESS_RESTORE_DB_GATE: NonNullable<ExecutorSiteType["restore"]["dbGate"]> = {
  functions: (c) =>
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
      `  (set -C; printf '${RESTORE_MAINTENANCE_FILE_CONTENT}' > "$tmp_gate")`,
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
      `  [ ! -e "$W/.maintenance" ] && [ ! -L "$W/.maintenance" ] || exit ${c.gateRemoveFailed}`,
      '  sync "$W" 2>/dev/null || true',
      "}",
    ].join("\n"),
  prepareCheck: (c) =>
    [
      '  if [ -e "$W/.maintenance" ] || [ -L "$W/.maintenance" ]; then',
      `    [ -L "$W/.maintenance" ] || [ -f "$W/.maintenance" ] || exit ${c.invalidDbName}`,
      "  fi",
    ].join("\n"),
};

export const WORDPRESS_RESTORE_KEPT_DIRS: readonly string[] = ["wp-content", "wp-content/mu-plugins"];

export const WORDPRESS_RESTORE_LEFT_IN_PLACE: readonly string[] = [
  ".maintenance",
  ".maintenance.hp*",
  ".hp_rs_*",
  "wp-content",
  "wp-content/mu-plugins",
  "wp-content/mu-plugins/hp-mail.php",
];
