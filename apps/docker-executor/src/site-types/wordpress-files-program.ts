// The WordPress import part of the files program, moved verbatim out of site-files-program.ts.
export const WORDPRESS_FILES_PROGRAM_FUNCTIONS: string = String.raw`const HP_IMPORT_DIR = '.htpanel-import';
const HP_IMPORT_STAGING_HTACCESS = "# hosting-panel import staging: never served\nRequire all denied\n<Files \"*\">\nRequire all denied\n</Files>\n<If \"true\">\nRequire all denied\n</If>\n";
const HP_IMPORT_GATE_HTACCESS = "\n# BEGIN hosting-panel import gate\n<If \"true\">\nRequire all denied\n</If>\n# END hosting-panel import gate\n";
const HP_IMPORT_GATE_CONFIG = "<?php if (PHP_SAPI !== \"cli\") { header(\"Retry-After: 60\", true, 503); exit; } /* hosting-panel import gate */ ?>\n";
const HP_IMPORT_GATE_MARK = 'hosting-panel import gate';
const HP_IMPORT_STUB = "<?php header(\"Retry-After: 60\", true, 503); exit;\n";
const HP_IMPORT_LEFT_OUT = array(
    'wp-config.php', '.htaccess', '.maintenance', 'wp-content/mu-plugins',
    'wp-content/advanced-cache.php', 'wp-content/object-cache.php', 'wp-content/db.php',
    'wp-content/db-error.php', 'wp-content/install.php', 'wp-content/maintenance.php',
    'wp-content/php-error.php', 'wp-content/fatal-error-handler.php', 'wp-content/sunrise.php',
    'wp-content/blog-deleted.php', 'wp-content/blog-inactive.php', 'wp-content/blog-suspended.php',
);
const HP_IMPORT_ID_RE = '/^[0-9a-f]{32}$/D';
const HP_IMPORT_UPLOAD_RE = '/^[A-Za-z0-9_-]{16,64}$/D';
const HP_T_DIR = 0040000;
const HP_T_FILE = 0100000;

// File type bits of a path without following links; 0 when absent.
function hp_import_type(string $p): int {
    clearstatcache(true, $p);
    $st = @lstat($p);
    return $st === false ? 0 : ($st['mode'] & 0170000);
}

// Removes a path when present; a link is unlinked, never followed.
function hp_import_rm(string $p): void {
    if (hp_import_type($p) !== 0) {
        hp_rm_tree($p);
    }
}

function hp_import_mkdir(string $p): void {
    error_clear_last();
    if (!@mkdir($p, 0755)) {
        hp_map_fs_error();
    }
}

function hp_import_read(string $p): string {
    error_clear_last();
    $data = @file_get_contents($p);
    if ($data === false) {
        hp_map_fs_error();
    }
    return $data;
}

function hp_import_mode(string $p): int {
    clearstatcache(true, $p);
    $st = @lstat($p);
    return $st === false ? 0644 : ($st['mode'] & 0777);
}

// Writes a file durably through a temp name in the same folder, then renames it over the target.
function hp_import_write(string $dir, string $name, string $data, int $mode): void {
    $tmp = hp_join($dir, '.htpanel-next');
    hp_import_rm($tmp);
    $dst = hp_join($dir, $name);
    $t = hp_import_type($dst);
    if ($t !== 0 && $t !== HP_T_FILE) {
        hp_rm_tree($dst);
    }
    error_clear_last();
    $fp = @fopen($tmp, 'xb');
    if ($fp === false) {
        hp_map_fs_error();
    }
    $ok = @fwrite($fp, $data) === strlen($data) && @fflush($fp) && @fsync($fp);
    $err = error_get_last();
    @fclose($fp);
    if (!$ok) {
        @unlink($tmp);
        hp_map_fs_error_from($err);
    }
    @chmod($tmp, $mode);
    error_clear_last();
    if (!@rename($tmp, $dst)) {
        $err = error_get_last();
        @unlink($tmp);
        hp_map_fs_error_from($err);
    }
}

// The staging folder with its deny-all .htaccess rewritten first; null when absent and not created.
function hp_import_staging(string $root, bool $create): ?string {
    $s = hp_join($root, HP_IMPORT_DIR);
    $t = hp_import_type($s);
    if ($t !== 0 && $t !== HP_T_DIR) {
        hp_rm_tree($s);
        $t = 0;
    }
    if ($t === 0) {
        if (!$create) {
            return null;
        }
        hp_import_mkdir($s);
    }
    hp_import_write($s, '.htaccess', HP_IMPORT_STAGING_HTACCESS, 0644);
    return $s;
}

function hp_import_slot(array $req): string {
    $slot = $req['slot'] ?? null;
    if ($slot !== 'archive' && $slot !== 'dump') {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    return $slot;
}

function hp_import_id(array $req): string {
    $id = $req['importId'] ?? null;
    if (!is_string($id) || preg_match(HP_IMPORT_ID_RE, $id) !== 1) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    return $id;
}

// Refuses a file whose first bytes are not a zip (archive) or are binary and not gzip (dump).
function hp_import_check_head(string $slot, string $head): void {
    if ($slot === 'archive') {
        $sig = substr($head, 0, 4);
        if ($sig !== "PK\x03\x04" && $sig !== "PK\x05\x06") {
            hp_fail('VALIDATION_ERROR', 'not_a_zip');
        }
    } elseif (substr($head, 0, 2) !== "\x1f\x8b" && str_contains(substr($head, 0, 4096), "\0")) {
        hp_fail('VALIDATION_ERROR', 'dump_not_sql');
    }
}

function hp_import_part(string $s, string $uploadId): string {
    return hp_join($s, '.htpanel-upload-' . $uploadId . '.part');
}

// The uploadId of the slot's unfinished upload, or null.
function hp_import_marker(string $s, string $slot): ?string {
    $m = hp_join($s, $slot . '.upload');
    if (hp_import_type($m) !== HP_T_FILE) {
        return null;
    }
    $id = @file_get_contents($m, false, null, 0, 128);
    return (is_string($id) && preg_match(HP_IMPORT_UPLOAD_RE, $id) === 1) ? $id : null;
}

function hp_import_clear_slot(string $s, string $slot): void {
    $old = hp_import_marker($s, $slot);
    if ($old !== null) {
        hp_import_rm(hp_import_part($s, $old));
    }
    hp_import_rm(hp_join($s, $slot . '.upload'));
    hp_import_rm(hp_join($s, $slot));
}

function hp_import_slot_state(string $s, string $slot): array {
    $up = hp_import_marker($s, $slot);
    if ($up !== null && hp_import_type(hp_import_part($s, $up)) === HP_T_FILE) {
        return array('state' => 'partial', 'size' => (int)filesize(hp_import_part($s, $up)), 'uploadId' => $up);
    }
    if (hp_import_type(hp_join($s, $slot)) === HP_T_FILE) {
        return array('state' => 'complete', 'size' => (int)filesize(hp_join($s, $slot)), 'uploadId' => null);
    }
    return array('state' => 'empty', 'size' => 0, 'uploadId' => null);
}

function hp_import_names(string $dir): array {
    $names = @scandir($dir);
    return $names === false ? array() : array_values(array_diff($names, array('.', '..')));
}

// Work folders by name, each mapped to whether it holds a plan.
function hp_import_work_dirs(string $s): array {
    $out = array();
    foreach (hp_import_names($s) as $name) {
        $name = (string)$name;
        if (preg_match(HP_IMPORT_ID_RE, $name) === 1 && hp_import_type(hp_join($s, $name)) === HP_T_DIR) {
            $out[$name] = hp_import_type(hp_join(hp_join($s, $name), 'plan')) === HP_T_FILE;
        }
    }
    return $out;
}

// Removes everything staged except work folders holding a plan; the folder goes when nothing is kept.
function hp_import_sweep(string $s): void {
    $plans = array_filter(hp_import_work_dirs($s));
    foreach (hp_import_names($s) as $name) {
        $name = (string)$name;
        if ($name !== '.htaccess' && !isset($plans[$name])) {
            hp_rm_tree(hp_join($s, $name));
        }
    }
    if (count($plans) === 0) {
        hp_rm_tree($s);
    }
}

// Entries the swap never moves: the gate files, wp-content itself, mu-plugins and panel leftovers.
function hp_import_skip(string $rel): bool {
    if (in_array($rel, array('.htaccess', 'wp-config.php', 'wp-content', '.maintenance', 'wp-content/mu-plugins'), true)) {
        return true;
    }
    $base = basename($rel);
    return str_starts_with($base, '.hp_rs_') || str_starts_with($base, '.htpanel-');
}

function hp_import_plan_rel_ok($rel): bool {
    return is_string($rel) && preg_match('#^(wp-content/)?[^/]+$#D', $rel) === 1 && hp_rel_ok($rel) && !hp_import_skip($rel);
}

// True when every parent folder of $rel under $base is a real folder (no link).
function hp_import_parents_ok(string $base, string $rel): bool {
    $parts = explode('/', $rel);
    array_pop($parts);
    $cur = $base;
    if (hp_import_type($cur) !== HP_T_DIR) {
        return false;
    }
    foreach ($parts as $seg) {
        $cur = hp_join($cur, $seg);
        if (hp_import_type($cur) !== HP_T_DIR) {
            return false;
        }
    }
    return true;
}

function hp_import_is_wp(string $d): bool {
    return hp_import_type(hp_join($d, 'wp-includes')) === HP_T_DIR
        && hp_import_type(hp_join($d, 'wp-includes/version.php')) === HP_T_FILE
        && hp_import_type(hp_join($d, 'wp-load.php')) === HP_T_FILE
        && hp_import_type(hp_join($d, 'wp-content')) === HP_T_DIR;
}

function hp_import_read_plan(string $w): array {
    $p = hp_join($w, 'plan');
    if (hp_import_type($p) !== HP_T_FILE) {
        return array();
    }
    $out = array();
    foreach (explode("\n", hp_import_read($p)) as $line) {
        $e = json_decode($line, true);
        if (is_array($e) && count($e) === 2 && array_is_list($e) && ($e[0] === 'O' || $e[0] === 'I') && hp_import_plan_rel_ok($e[1])) {
            $out[] = $e;
        }
    }
    return $out;
}

function hp_import_op_put(array $req, string $root): array {
    $slot = hp_import_slot($req);
    $up = $req['uploadId'] ?? null;
    if (!is_string($up) || preg_match(HP_IMPORT_UPLOAD_RE, $up) !== 1) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $offset = $req['offset'] ?? null;
    if (!is_int($offset) || $offset < 0) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    $s = hp_import_staging($root, true);
    $mine = hp_import_marker($s, $slot);
    // Both slots stage under .htpanel-upload-<uploadId>.part, so one uploadId cannot feed both.
    if (hp_import_marker($s, $slot === 'archive' ? 'dump' : 'archive') === $up) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    if ($offset === 0) {
        $data = is_string($req['dataBase64'] ?? null) ? base64_decode($req['dataBase64'], true) : false;
        if ($data === false) {
            hp_fail('VALIDATION_ERROR', 'invalid_path');
        }
        // A1 order (the simulator does the same): a new upload empties the slot, then its first bytes are checked.
        if ($mine !== $up) {
            hp_import_clear_slot($s, $slot);
        }
        hp_import_check_head($slot, $data);
        if ($mine !== $up) {
            hp_import_write($s, $slot . '.upload', $up, 0644);
        }
    } elseif ($mine !== $up) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    $res = hp_op_write(array(
        'path' => $slot,
        'uploadId' => $up,
        'offset' => $offset,
        'dataBase64' => $req['dataBase64'] ?? null,
        'final' => $req['final'] ?? null,
        'overwrite' => true,
    ), $s);
    if (($req['final'] ?? null) === true) {
        hp_import_rm(hp_join($s, $slot . '.upload'));
    }
    return $res;
}

function hp_import_op_take(array $req, string $root): array {
    $slot = hp_import_slot($req);
    if (!isset($req['path']) || !hp_rel_ok($req['path'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $s = hp_import_staging($root, true);
    $res = hp_resolve_parent($req['path'], $root);
    $realRel = $res[2];
    if (hp_is_protected($realRel) || $realRel === 'wp-config.php') {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    if (!hp_rel_ok($realRel, false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $src = hp_join($res[0], $res[1]);
    $t = hp_import_type($src);
    if ($t === 0) {
        hp_fail('NOT_FOUND', 'not_found');
    }
    if ($t !== HP_T_FILE) {
        hp_fail('VALIDATION_ERROR', 'is_a_directory');
    }
    $size = (int)filesize($src);
    if ($size > HP_MAX_FILE_BYTES) {
        hp_fail('QUOTA_EXCEEDED', 'too_large');
    }
    error_clear_last();
    $head = @file_get_contents($src, false, null, 0, 4096);
    if ($head === false) {
        hp_map_fs_error();
    }
    hp_import_check_head($slot, $head);
    hp_import_clear_slot($s, $slot);
    error_clear_last();
    if (!@rename($src, hp_join($s, $slot))) {
        hp_map_fs_error();
    }
    return array('size' => $size);
}

function hp_import_op_stat(string $root): array {
    $s = hp_import_staging($root, false);
    if ($s === null) {
        $empty = array('state' => 'empty', 'size' => 0, 'uploadId' => null);
        return array('archive' => $empty, 'dump' => $empty, 'remains' => false);
    }
    return array(
        'archive' => hp_import_slot_state($s, 'archive'),
        'dump' => hp_import_slot_state($s, 'dump'),
        'remains' => in_array(true, hp_import_work_dirs($s), true),
    );
}

function hp_import_op_discard(string $root): object {
    $s = hp_import_staging($root, false);
    if ($s !== null) {
        hp_import_sweep($s);
    }
    return (object)array();
}

function hp_import_op_unpack(array $req, string $root): array {
    $id = hp_import_id($req);
    $s = hp_import_staging($root, true);
    $w = hp_join($s, $id);
    if (hp_import_type($w) === HP_T_DIR && hp_import_type(hp_join($w, 'plan')) !== 0) {
        hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
    }
    hp_import_rm($w);
    if (hp_import_type(hp_join($s, 'archive')) !== HP_T_FILE) {
        hp_fail('NOT_FOUND', 'files_missing');
    }
    hp_import_mkdir($w);
    $ex = hp_op_extract(array('path' => 'archive', 'to' => $id . '/x'), $s, true);
    $x = hp_join($w, 'x');
    hp_import_rm(hp_join($x, '__MACOSX'));
    hp_import_rm(hp_join($x, '.DS_Store'));

    $top = $x;
    $prefix = '';
    if (!hp_import_is_wp($x)) {
        $names = hp_import_names($x);
        $only = count($names) === 1 ? hp_join($x, (string)$names[0]) : null;
        if ($only === null || hp_import_type($only) !== HP_T_DIR || !hp_import_is_wp($only)) {
            hp_rm_tree($w);
            hp_fail('VALIDATION_ERROR', 'archive_not_wordpress');
        }
        $top = $only;
        $prefix = $names[0] . '/';
    }
    $site = hp_join($w, 'site');
    error_clear_last();
    if (!@rename($top, $site)) {
        hp_map_fs_error();
    }
    hp_import_rm($x);

    $leftOut = array();
    foreach (HP_IMPORT_LEFT_OUT as $rel) {
        if ($rel === '.htaccess') {
            $src = hp_join($site, '.htaccess.hpimport');
            if (hp_import_type($src) === 0) {
                continue;
            }
            hp_import_rm(hp_join($site, '.htaccess.imported'));
            error_clear_last();
            if (!@rename($src, hp_join($site, '.htaccess.imported'))) {
                hp_map_fs_error();
            }
        } else {
            $p = hp_join($site, $rel);
            if (hp_import_type($p) === 0) {
                continue;
            }
            hp_rm_tree($p);
        }
        $leftOut[] = $rel;
    }

    $list = '';
    foreach ($ex['htaccess'] as $rel) {
        if (!str_starts_with($rel, $prefix)) {
            continue;
        }
        $rel = substr($rel, strlen($prefix));
        if ($rel !== '.htaccess' && hp_import_type(hp_join($site, $rel . '.hpimport')) === HP_T_FILE) {
            $list .= $rel . "\n";
        }
    }
    hp_import_write($w, 'htaccess.list', $list, 0644);
    hp_import_write($w, 'wp-config.php', HP_IMPORT_STUB, 0644);
    return array('entries' => $ex['entries'], 'leftOut' => $leftOut);
}

function hp_import_op_switch(array $req, string $root): array {
    $id = hp_import_id($req);
    $s = hp_import_staging($root, true);
    $w = hp_join($s, $id);
    $site = hp_join($w, 'site');
    if (hp_import_type($w) !== HP_T_DIR || hp_import_type($site) !== HP_T_DIR || hp_import_type(hp_join($site, 'wp-content')) !== HP_T_DIR) {
        hp_fail('NOT_FOUND', 'files_missing');
    }
    $cfg = hp_join($root, 'wp-config.php');
    $hta = hp_join($root, '.htaccess');
    $hType = hp_import_type($hta);
    if (
        hp_import_type(hp_join($w, 'plan')) !== 0 || hp_import_type(hp_join($w, 'wp-config.live')) !== 0
        || hp_import_type($cfg) !== HP_T_FILE || hp_import_type(hp_join($root, 'wp-content')) !== HP_T_DIR
        || ($hType !== 0 && $hType !== HP_T_FILE)
    ) {
        hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
    }
    $config = hp_import_read($cfg);
    if (str_contains($config, HP_IMPORT_GATE_MARK)) {
        hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
    }
    $cMode = hp_import_mode($cfg);
    $htaccess = '';
    $hMode = 0644;
    if ($hType === HP_T_FILE) {
        $htaccess = hp_import_read($hta);
        $hMode = hp_import_mode($hta);
        hp_import_write($w, 'htaccess.live', $htaccess, $hMode);
    } else {
        hp_import_write($w, 'htaccess.absent', '', 0644);
    }
    hp_import_write($w, 'wp-config.live', $config, $cMode);
    hp_import_write($root, '.htaccess', $htaccess . HP_IMPORT_GATE_HTACCESS, $hMode);
    hp_import_write($root, 'wp-config.php', HP_IMPORT_GATE_CONFIG . $config, $cMode);

    $aside = hp_join($w, 'aside');
    hp_import_rm($aside);
    hp_import_mkdir($aside);
    hp_import_mkdir(hp_join($aside, 'wp-content'));
    $plan = array();
    foreach (array(array('O', $root), array('I', $site)) as [$kind, $base]) {
        foreach (array('', 'wp-content/') as $dir) {
            foreach (hp_import_names($dir === '' ? $base : hp_join($base, 'wp-content')) as $name) {
                $rel = $dir . $name;
                if (hp_import_plan_rel_ok($rel)) {
                    $plan[] = array($kind, $rel);
                }
            }
        }
    }
    $text = '';
    foreach ($plan as $step) {
        $text .= json_encode($step, HP_JSON_FLAGS) . "\n";
    }
    hp_import_write($w, 'plan', $text, 0644);

    foreach ($plan as [$kind, $rel]) {
        $from = $kind === 'O' ? hp_join($root, $rel) : hp_join($site, $rel);
        $to = $kind === 'O' ? hp_join($aside, $rel) : hp_join($root, $rel);
        if (hp_import_type($to) !== 0) {
            hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
        }
        error_clear_last();
        if (!@rename($from, $to)) {
            hp_map_fs_error();
        }
    }
    clearstatcache();
    return array('moved' => count($plan));
}

function hp_import_op_undo(array $req, string $root): array {
    $id = hp_import_id($req);
    $s = hp_import_staging($root, false);
    $w = $s === null ? null : hp_join($s, $id);
    $t = $w === null ? 0 : hp_import_type($w);
    $cfg = hp_join($root, 'wp-config.php');
    $hta = hp_join($root, '.htaccess');
    $gated = fn() => (hp_import_type($cfg) === HP_T_FILE && str_starts_with(hp_import_read($cfg), HP_IMPORT_GATE_CONFIG))
        || (hp_import_type($hta) === HP_T_FILE && str_contains(hp_import_read($hta), HP_IMPORT_GATE_HTACCESS));
    if ($t === 0) {
        // Without the work folder the undo is done only once both gates are off (R164.5.4).
        return array('complete' => !$gated());
    }
    if ($t !== HP_T_DIR) {
        return array('complete' => false);
    }
    $site = hp_join($w, 'site');
    $aside = hp_join($w, 'aside');
    $plan = hp_import_read_plan($w);
    $outs = array();
    foreach ($plan as [$kind, $rel]) {
        if ($kind === 'O') {
            $outs[$rel] = true;
        }
    }
    // A name in both trees with neither copy in the work folder: the live one may be the imported one (R164.5.4),
    // unless both gates are off: only an undo past its last check does that, and the open site's entries stay put (R165.2, R166.4).
    foreach ($plan as [$kind, $rel]) {
        if ($kind === 'I' && isset($outs[$rel]) && hp_import_type(hp_join($aside, $rel)) === 0 && hp_import_type(hp_join($site, $rel)) === 0) {
            if ($gated()) {
                return array('complete' => false);
            }
            hp_rm_tree($w);
            clearstatcache();
            return array('complete' => true);
        }
    }
    // Walk back; an imported entry over a moved-out name only returns once the moved-out one is aside.
    foreach (array_reverse($plan) as [$kind, $rel]) {
        if ($kind === 'I') {
            $from = hp_join($root, $rel);
            $to = hp_join($site, $rel);
            if (isset($outs[$rel]) && hp_import_type(hp_join($aside, $rel)) === 0) {
                continue;
            }
            $ok = hp_import_parents_ok($root, $rel) && hp_import_parents_ok($site, $rel);
        } else {
            $from = hp_join($aside, $rel);
            $to = hp_join($root, $rel);
            $ok = hp_import_parents_ok($root, $rel) && hp_import_parents_ok($aside, $rel);
        }
        if ($ok && hp_import_type($from) !== 0 && hp_import_type($to) === 0) {
            @rename($from, $to);
        }
    }
    foreach ($plan as [$kind, $rel]) {
        $live = hp_import_type(hp_join($root, $rel));
        if ($kind === 'O' ? ($live === 0 || hp_import_type(hp_join($aside, $rel)) !== 0) : (!isset($outs[$rel]) && $live !== 0)) {
            return array('complete' => false);
        }
    }
    $cfgLive = hp_join($w, 'wp-config.live');
    $htaLive = hp_join($w, 'htaccess.live');
    $ct = hp_import_type($cfgLive);
    $ht = hp_import_type($htaLive);
    if (($ct !== 0 && $ct !== HP_T_FILE) || ($ht !== 0 && $ht !== HP_T_FILE)) {
        return array('complete' => false);
    }
    if ($ct === HP_T_FILE) {
        hp_import_write($root, 'wp-config.php', hp_import_read($cfgLive), hp_import_mode($cfgLive));
    }
    if ($ht === HP_T_FILE) {
        hp_import_write($root, '.htaccess', hp_import_read($htaLive), hp_import_mode($htaLive));
    } elseif (hp_import_type(hp_join($w, 'htaccess.absent')) !== 0) {
        hp_import_rm(hp_join($root, '.htaccess'));
    }
    hp_rm_tree($w);
    clearstatcache();
    return array('complete' => true);
}

function hp_import_op_finish(array $req, string $root): object {
    $id = hp_import_id($req);
    $s = hp_import_staging($root, false);
    if ($s === null) {
        return (object)array();
    }
    $w = hp_join($s, $id);
    if (hp_import_type($w) !== 0) {
        $cfg = hp_join($root, 'wp-config.php');
        $htaLive = hp_join($w, 'htaccess.live');
        $ht = hp_import_type($htaLive);
        if (
            hp_import_type($w) !== HP_T_DIR || hp_import_type(hp_join($w, 'plan')) !== HP_T_FILE
            || hp_import_type($cfg) !== HP_T_FILE
            || !($ht === HP_T_FILE || ($ht === 0 && hp_import_type(hp_join($w, 'htaccess.absent')) !== 0))
        ) {
            hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
        }
        // Strip exactly the gate line; a gate changed in place is left for a person to look at.
        $config = hp_import_read($cfg);
        $newConfig = null;
        if (str_starts_with($config, HP_IMPORT_GATE_CONFIG)) {
            $newConfig = substr($config, strlen(HP_IMPORT_GATE_CONFIG));
        }
        if (str_contains($newConfig ?? $config, HP_IMPORT_GATE_MARK)) {
            hp_fail('RESOURCE_LOCKED', 'staging_unsafe');
        }
        $listPath = hp_join($w, 'htaccess.list');
        $list = hp_import_type($listPath) === HP_T_FILE ? hp_import_read($listPath) : '';
        foreach (explode("\n", $list) as $rel) {
            if (
                !hp_rel_ok($rel, false) || $rel === '.htaccess' || basename($rel) !== '.htaccess'
                || str_starts_with($rel, 'wp-content/mu-plugins/') || !hp_import_parents_ok($root, $rel)
            ) {
                continue;
            }
            $src = hp_join($root, $rel . '.hpimport');
            $dst = hp_join($root, $rel);
            if (hp_import_type($src) === HP_T_FILE && hp_import_type($dst) === 0) {
                @rename($src, $dst);
            }
        }
        if ($newConfig !== null) {
            hp_import_write($root, 'wp-config.php', $newConfig, hp_import_mode($cfg));
        }
        if ($ht === HP_T_FILE) {
            hp_import_write($root, '.htaccess', hp_import_read($htaLive), hp_import_mode($htaLive));
        } else {
            hp_import_rm(hp_join($root, '.htaccess'));
        }
        $done = hp_join($s, $id . '.finished');
        hp_import_rm($done);
        error_clear_last();
        if (!@rename($w, $done)) {
            hp_map_fs_error();
        }
    }
    hp_import_sweep($s);
    clearstatcache();
    return (object)array();
}`;

export const WORDPRESS_FILES_PROGRAM_DISPATCH: string = String.raw`} elseif (str_starts_with($op, 'import.')) {
    umask(022);
    if ($op === 'import.put') {
        hp_ok(hp_import_op_put($req, $root));
    } elseif ($op === 'import.take') {
        hp_ok(hp_import_op_take($req, $root));
    } elseif ($op === 'import.stat') {
        hp_ok(hp_import_op_stat($root));
    } elseif ($op === 'import.discard') {
        hp_ok(hp_import_op_discard($root));
    } elseif ($op === 'import.unpack') {
        hp_ok(hp_import_op_unpack($req, $root));
    } elseif ($op === 'import.switch') {
        hp_ok(hp_import_op_switch($req, $root));
    } elseif ($op === 'import.undo') {
        hp_ok(hp_import_op_undo($req, $root));
    } elseif ($op === 'import.finish') {
        hp_ok(hp_import_op_finish($req, $root));
    }
    fwrite(STDERR, "unknown op\n");
    exit(1);`;
