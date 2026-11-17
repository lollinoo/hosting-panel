set -eu
W=/var/www/html; R=$W/.hp_rs_$HP_H; S=/var/tmp/c; D=$S/databases; U=hp_ru_$HP_H
case "$HP_H" in *[!0-9a-f]*) exit 81;; esac
[ "${#HP_H}" -eq 32 ] || exit 81
case "$HP_LOCK_S" in ""|*[!0-9]*) exit 81;; esac
wait_db() {
  printf '[client]\nuser=root\nhost=hp-mariadb\npassword=%s\n' "$(cat "$MARIADB_ROOT_FILE")" > /tmp/c.cnf
  n=0
  until mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B -e 'SELECT 1' >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -ge 30 ] && exit 11; sleep 2
  done
}
run_m() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B --sandbox "$@"; }
run_m_sql() { mariadb --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --init-command="SET SESSION lock_wait_timeout=$HP_LOCK_S" -N -B --sandbox --binary-mode "$@"; }
D0="mariadb-dump --defaults-extra-file=/tmp/c.cnf --default-character-set=utf8mb4 --skip-dump-date --no-data --skip-opt --skip-comments"
q() { run_m -e "$1"; }
check_prefix() { echo "$HP_PREFIX" | grep -Eqx 'wp_[0-9a-f]{12}' || exit 81; }
validate_dbs_file() {
  while IFS= read -r db || [ -n "$db" ]; do
    echo "$db" | grep -Eqx "${HP_PREFIX}(_[a-z0-9][a-z0-9_]{0,15})?" || exit 81
  done < "$S/dbs"
}
check_obj_names() {
  bad_kind=$({
    printf "SET @s='%s';\n" "$1"
    cat <<'SQL'
SELECT k FROM (
  SELECT 'TABLE' k, TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA=@s AND TABLE_TYPE='BASE TABLE'
  UNION ALL SELECT 'VIEW', TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=@s
  UNION ALL SELECT 'TRIGGER', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=@s
  UNION ALL SELECT 'ROUTINE', ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=@s
  UNION ALL SELECT 'EVENT', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=@s
) o WHERE (n REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), n) > 0 OR LOCATE(CHAR(92), n) > 0) LIMIT 1;
SQL
  } | run_m)
  if [ -n "$bad_kind" ]; then
    printf '%s\t%s\n' "$bad_kind" "$2" >&2
    exit 84
  fi
}
strip_db_qual() {
  LC_ALL=C awk -v db="$1" '
    function sp(  n) {
      match(b, /^[[:space:]]*/); n = RLENGTH
      if (!n && b !~ /^[`"]/ && o !~ /[`"[:space:]]$/) return 0
      o = o substr(b, 1, n); b = substr(b, n + 1); return 1
    }
    function ref(  n1) {
      if (!sp() || !match(b, ID)) return 0
      n1 = substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1)
      if (!match(b, /^[[:space:]]*\.[[:space:]]*/)) { o = o n1; return 1 }
      if (n1 != db && n1 != "`" db "`" && n1 != "\"" db "\"") return 0
      b = substr(b, RLENGTH + 1)
      if (!match(b, ID)) return 0
      o = o substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1); return 1
    }
    function kw(re) {
      if (!sp() || !match(toupper(b), "^(" re ")") || substr(b, RLENGTH + 1, 1) ~ W) return 0
      o = o substr(b, 1, RLENGTH); b = substr(b, RLENGTH + 1); return 1
    }
    BEGIN { W = "[A-Za-z0-9_$\200-\377]"; ID = "^(`([^`]|``)+`|\"([^\"]|\"\")+\"|" W "+)"; t = "/*!50003 TRIGGER" }
    inh { buf = buf "\n" $0; if ($0 != "*/;;") next }
    !inh && /^\/\*!50003 CREATE\*\/ / { inh = 1; buf = $0; if ($0 !~ /\*\/;;$/) next }
    inh {
      inh = 0; k = index(toupper(buf), t); if (!k) exit 3
      o = substr(buf, 1, k + length(t) - 1); b = substr(buf, k + length(t))
      if (kw("IF") && !(kw("NOT") && kw("EXISTS"))) exit 3
      if (!(ref() && kw("(BEFORE|AFTER)[[:space:]]+(INSERT|UPDATE|DELETE)([[:space:]]+OR[[:space:]]+(INSERT|UPDATE|DELETE))*") && kw("ON") && ref() && kw("FOR"))) exit 3
      print o b; next
    }
    { print }
    END { if (inh) exit 3 }
  '
}
dropobjs() {
  run_m -- "$1" <<'SQL'
DELIMITER ;;
BEGIN NOT ATOMIC
  DECLARE done INT DEFAULT 0;
  DECLARE s LONGTEXT;
  DECLARE cur CURSOR FOR
    SELECT CONCAT('DROP VIEW IF EXISTS `', REPLACE(TABLE_NAME,'`','``'), '`') FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()
    UNION ALL
    SELECT CONCAT('DROP TRIGGER IF EXISTS `', REPLACE(TRIGGER_NAME,'`','``'), '`') FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
    UNION ALL
    SELECT CONCAT('DROP ', ROUTINE_TYPE, ' IF EXISTS `', REPLACE(ROUTINE_NAME,'`','``'), '`') FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()
    UNION ALL
    SELECT CONCAT('DROP EVENT IF EXISTS `', REPLACE(EVENT_NAME,'`','``'), '`') FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE();
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN cur;
  lp: LOOP
    FETCH cur INTO s;
    IF done THEN LEAVE lp; END IF;
    EXECUTE IMMEDIATE s;
  END LOOP;
  CLOSE cur;
END;;
DELIMITER ;
SQL
}
saveobjs() {
  schema="$1"; out="$2"
  { printf "SET @s='%s';\n" "$schema"; cat <<'SQL'
SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=@s ORDER BY TABLE_NAME;
SQL
  } | run_m -r > "$out.views"
  : > "$out.tmp"
  $D0 --no-create-info --routines --events --triggers -- "$schema" >> "$out.tmp"
  set -- "$schema"
  while IFS= read -r v; do
    [ -z "$v" ] || set -- "$@" "$v"
  done < "$out.views"
  if [ "$#" -gt 1 ]; then
    $D0 -- "$@" >> "$out.tmp"
  fi
  rm -f "$out.views"
  sync "$out.tmp"; mv -Tf "$out.tmp" "$out"; sync "$S"
}
has_tables() {
  [ -n "$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='$1' AND TABLE_TYPE='BASE TABLE' LIMIT 1")" ]
}
append_renames() {
  {
    printf "SET @s='%s', @d='%s';\n" "$1" "$2"
    cat <<'SQL'
SELECT CONCAT('`', @s, '`.`', REPLACE(TABLE_NAME,'`','``'), '` TO `', @d, '`.`', REPLACE(TABLE_NAME,'`','``'), '`,')
FROM information_schema.TABLES
WHERE TABLE_SCHEMA=@s AND TABLE_TYPE='BASE TABLE'
ORDER BY TABLE_NAME;
SQL
  } | run_m -r >> "$3"
}
drop_temp_schemas() {
  {
    printf "SET @hp_h='%s';\n" "$HP_H"
    cat <<'SQL'
DELIMITER ;;
BEGIN NOT ATOMIC
  DECLARE done INT DEFAULT 0;
  DECLARE s TEXT;
  DECLARE cur CURSOR FOR
    SELECT CONCAT('DROP DATABASE IF EXISTS `', REPLACE(SCHEMA_NAME,'`','``'), '`')
    FROM information_schema.SCHEMATA
    WHERE SCHEMA_NAME LIKE CONCAT('hp|_rn|_', @hp_h, '|_%') ESCAPE '|'
       OR SCHEMA_NAME LIKE CONCAT('hp|_ro|_', @hp_h, '|_%') ESCAPE '|'
       OR SCHEMA_NAME = CONCAT('hp_ru_', @hp_h);
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN cur;
  lp: LOOP
    FETCH cur INTO s;
    IF done THEN LEAVE lp; END IF;
    EXECUTE IMMEDIATE s;
  END LOOP;
  CLOSE cur;
END;;
DELIMITER ;
SQL
  } | run_m
}
exists() { [ -n "$(q "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$1'")" ]; }
record_gate() {
  if [ ! -f "$S/gate_recorded" ]; then
    rm -rf "$S/gate_kept" "$S/gate_kept.tmp"
    if [ -e "$W/.maintenance" ] || [ -L "$W/.maintenance" ]; then
      cp -aP "$W/.maintenance" "$S/gate_kept.tmp"
      [ -L "$S/gate_kept.tmp" ] || sync "$S/gate_kept.tmp"
      mv -Tf "$S/gate_kept.tmp" "$S/gate_kept"
    fi
    : > "$S/gate_recorded.tmp"; sync "$S/gate_recorded.tmp"; mv -Tf "$S/gate_recorded.tmp" "$S/gate_recorded"; sync "$S"
  fi
}
gate_on() {
  tmp_gate="$W/.maintenance.hp.$$"
  rm -rf "$tmp_gate"
  (set -C; printf '<?php $upgrading = time(); ?>' > "$tmp_gate")
  sync "$tmp_gate"; rm -rf "$W/.maintenance"; mv -Tf "$tmp_gate" "$W/.maintenance"; sync "$W"
}
restore_gate() {
  if [ -e "$S/gate_kept" ] || [ -L "$S/gate_kept" ]; then
    tmp_gate="$W/.maintenance.hp.$$"
    rm -rf "$tmp_gate"
    cp -aP "$S/gate_kept" "$tmp_gate"
    [ -L "$tmp_gate" ] || sync "$tmp_gate"
    mv -Tf "$tmp_gate" "$W/.maintenance"
    sync "$W"
  else
    rm -rf "$W/.maintenance"; sync "$W"
  fi
}
gate_off() {
  rm -rf "$W/.maintenance" 2>/dev/null || true
  [ ! -e "$W/.maintenance" ] && [ ! -L "$W/.maintenance" ] || exit 96
  sync "$W" 2>/dev/null || true
}
case "$HP_STEP" in
prepare)
  check_prefix
  [ -f "$S/dbs" ] && [ ! -L "$S/dbs" ] || exit 81
  validate_dbs_file
  wait_db
  [ "$(q 'SELECT @@global.event_scheduler')" = OFF ] || exit 80
  i=0
  while IFS= read -r db || [ -n "$db" ]; do
    [ -z "$db" ] && continue
    [ -f "$D/$db.sql" ] && [ ! -L "$D/$db.sql" ] || exit 81
    if exists "$db"; then check_obj_names "$db" "$db"; fi
    p=hp_rn_${HP_H}_$i
    q "DROP DATABASE IF EXISTS \`$p\`; CREATE DATABASE \`$p\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    rm -f "$S/strip_bad"
    { strip_db_qual "$db" < "$D/$db.sql" || : > "$S/strip_bad"; } | run_m_sql -- "$p" || exit 82
    if [ -e "$S/strip_bad" ]; then printf 'TRIGGER\t%s\n' "$db" >&2; exit 84; fi
    check_obj_names "$p" "$db"
    saveobjs "$p" "$S/copy_$i.sql"
    i=$((i + 1))
  done < "$S/dbs"
  m=$(q "SELECT DISTINCT d FROM (SELECT DEFINER d,TABLE_SCHEMA s FROM information_schema.VIEWS UNION ALL SELECT DEFINER,ROUTINE_SCHEMA FROM information_schema.ROUTINES UNION ALL SELECT DEFINER,TRIGGER_SCHEMA FROM information_schema.TRIGGERS UNION ALL SELECT DEFINER,EVENT_SCHEMA FROM information_schema.EVENTS) x WHERE s LIKE 'hp\\_rn\\_${HP_H}\\_%' AND d NOT IN (SELECT CONCAT(User,'@',Host) FROM mysql.user)")
  [ -z "$m" ] || exit 83 ;;
switch)
  check_prefix
  [ -f "$S/dbs" ] && [ ! -L "$S/dbs" ] || exit 81
  validate_dbs_file
  wait_db
  i=0
  while IFS= read -r db || [ -n "$db" ]; do
    [ -z "$db" ] && continue
    if exists "$db"; then check_obj_names "$db" "$db"; fi
    check_obj_names "hp_rn_${HP_H}_$i" "$db"
    i=$((i + 1))
  done < "$S/dbs"
  if [ -e "$W/.maintenance" ] || [ -L "$W/.maintenance" ]; then
    [ -L "$W/.maintenance" ] || [ -f "$W/.maintenance" ] || exit 81
  fi
  record_gate
  gate_on
  q "CREATE DATABASE IF NOT EXISTS \`$U\`; CREATE TABLE IF NOT EXISTS \`$U\`.\`before\` (x INT)"
  printf 'RENAME TABLE\n' > "$S/rename.sql"
  i=0
  while IFS= read -r db || [ -n "$db" ]; do
    [ -z "$db" ] && continue
    p=hp_rn_${HP_H}_$i; o=hp_ro_${HP_H}_$i
    if ! exists "$db"; then
      grep -qx "$db" "$S/created" 2>/dev/null || { echo "$db" >> "$S/created"; sync "$S/created"; }
      q "CREATE DATABASE \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    fi
    q "CREATE DATABASE IF NOT EXISTS \`$o\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    saveobjs "$db" "$S/live_$i.sql"; dropobjs "$db"; dropobjs "$p"
    append_renames "$db" "$o" "$S/rename.sql"
    append_renames "$p" "$db" "$S/rename.sql"
    i=$((i + 1))
  done < "$S/dbs"
  printf '`%s`.`before` TO `%s`.`after`;\n' "$U" "$U" >> "$S/rename.sql"
  run_m_sql < "$S/rename.sql"
  i=0
  while IFS= read -r db || [ -n "$db" ]; do
    [ -z "$db" ] && continue
    run_m_sql -- "$db" < "$S/copy_$i.sql"
    i=$((i + 1))
  done < "$S/dbs" ;;
undo)
  check_prefix
  [ ! -L "$S/dbs" ] || exit 81
  if [ -f "$S/dbs" ]; then validate_dbs_file; fi
  wait_db
  if [ ! -e "$S/dbs" ]; then
    [ ! -e "$S/created" ] || exit 92
    u_exists=$(q "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$U'")
    [ -z "$u_exists" ] || exit 92
  fi
  mkdir -p -m 0700 "$S"
  [ ! -f "$S/gate_recorded" ] || gate_on
  done_=$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='$U' AND TABLE_NAME='after'")
  if [ -f "$S/dbs" ]; then
    if [ -n "$done_" ]; then
      i=0
      while IFS= read -r db || [ -n "$db" ]; do
        [ -z "$db" ] && continue
        if exists "$db"; then check_obj_names "$db" "$db"; fi
        if exists "hp_ro_${HP_H}_$i"; then check_obj_names "hp_ro_${HP_H}_$i" "$db"; fi
        i=$((i + 1))
      done < "$S/dbs"
      printf 'RENAME TABLE\n' > "$S/rename.sql"
      i=0
      while IFS= read -r db || [ -n "$db" ]; do
        [ -z "$db" ] && continue
        p=hp_rn_${HP_H}_$i; o=hp_ro_${HP_H}_$i
        dropobjs "$db"
        append_renames "$db" "$p" "$S/rename.sql"
        append_renames "$o" "$db" "$S/rename.sql"
        i=$((i + 1))
      done < "$S/dbs"
      printf '`%s`.`after` TO `%s`.`before`;\n' "$U" "$U" >> "$S/rename.sql"
      run_m_sql < "$S/rename.sql"
    fi
    i=0
    while IFS= read -r db || [ -n "$db" ]; do
      [ -z "$db" ] && continue
      if [ -f "$S/live_$i.sql" ] && exists "$db"; then
        dropobjs "$db"; run_m_sql -- "$db" < "$S/live_$i.sql"
      fi
      if [ -f "$S/created" ] && grep -qx "$db" "$S/created" 2>/dev/null; then
        ! has_tables "$db" || exit 92
        q "DROP DATABASE IF EXISTS \`$db\`"
      fi
      i=$((i + 1))
    done < "$S/dbs"
  fi
  [ -z "$(q "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA LIKE 'hp|_ro|_${HP_H}|_%' ESCAPE '|' AND TABLE_TYPE='BASE TABLE' LIMIT 1")" ] || exit 92
  drop_temp_schemas
  [ ! -f "$S/gate_recorded" ] || restore_gate
  rm -rf "$R"; sync "$W" ;;
finish)
  gate_off
  wait_db
  drop_temp_schemas || exit 97
  rm -rf "$R" || exit 97
  sync "$W" || exit 97 ;;
*) exit 1 ;;
esac