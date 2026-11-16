import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomically } from "./traefik-config.js";

export const DEFAULT_SITE_FILES_DIR = "/var/lib/hosting-panel/site-files";

const SITE_FILES_PROGRAM_FILENAME = "hp-files.php";

// Runs inside the hardened helper container (php 8.1+, zip+json extensions only, no shell-outs).
export const SITE_FILES_PROGRAM: string = String.raw`<?php
declare(strict_types=1);

const HP_CHUNK_BYTES = 524288;
const HP_PATH_MAX_CHARS = 1024;
const HP_PATH_MAX_BYTES = 4096;
const HP_SEGMENT_MAX_BYTES = 255;
const HP_LIST_MAX = 5000;
const HP_LIST_MAX_BYTES = 900000;
const HP_MTIME_MIN = -62167219200; // 0000-01-01T00:00:00Z
const HP_MTIME_MAX = 253402300799; // 9999-12-31T23:59:59Z
const HP_JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;
const HP_BATCH_MAX = 100;
const HP_MAX_FILE_BYTES = 2147483648;
const HP_DISK_FREE_FLOOR = 1073741824;
const HP_ZIP_MAX_ENTRIES = 20000;
const HP_ZIP_MAX_UNCOMPRESSED = 1073741824;
const HP_ZIP_RATIO_THRESHOLD = 1048576;
const HP_ZIP_MAX_RATIO = 200;
const HP_ZIP_MAX_DEPTH = 32;
const HP_IMPORT_MAX_ENTRIES = 200000;
const HP_IMPORT_MAX_UNCOMPRESSED = 4294967296;
const HP_SWEEP_MAX_ENTRIES = 200000;
const HP_SWEEP_MAX_DEPTH = 32;
const HP_SWEEP_BUDGET_SECS = 30;
const HP_SWEEP_STALE_SECS = 86400;
const HP_SYMLOOP_MAX = 40;

function hp_ok($result): void {
    echo json_encode(array('ok' => true, 'result' => $result), HP_JSON_FLAGS);
    exit(0);
}

function hp_fail(string $code, string $reason): void {
    echo json_encode(
        array('ok' => false, 'code' => $code, 'reason' => $reason),
        HP_JSON_FLAGS
    );
    exit(0);
}

function hp_map_fs_error_from(?array $err): void {
    $msg = $err !== null && isset($err['message']) ? (string)$err['message'] : '';
    if (
        stripos($msg, 'Permission denied') !== false ||
        stripos($msg, 'Operation not permitted') !== false ||
        stripos($msg, 'Read-only') !== false
    ) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    if (stripos($msg, 'No such file') !== false) {
        hp_fail('NOT_FOUND', 'not_found');
    }
    if (stripos($msg, 'File exists') !== false || stripos($msg, 'Directory not empty') !== false) {
        hp_fail('ALREADY_EXISTS', 'exists');
    }
    if (stripos($msg, 'No space left') !== false || stripos($msg, 'quota exceeded') !== false) {
        hp_fail('QUOTA_EXCEEDED', 'disk_full');
    }
    if (stripos($msg, 'Not a directory') !== false) {
        hp_fail('VALIDATION_ERROR', 'not_a_directory');
    }
    if (stripos($msg, 'Is a directory') !== false) {
        hp_fail('VALIDATION_ERROR', 'is_a_directory');
    }
    hp_fail('INTERNAL_ERROR', 'internal_error');
}

function hp_map_fs_error(): void {
    hp_map_fs_error_from(error_get_last());
}

function hp_lstat_fail(): void {
    $err = error_get_last();
    $msg = $err !== null && isset($err['message']) ? (string)$err['message'] : '';
    if (
        stripos($msg, 'Permission denied') !== false ||
        stripos($msg, 'Operation not permitted') !== false
    ) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    hp_fail('NOT_FOUND', 'not_found');
}

function hp_rel_ok($p, bool $allowEmpty = false): bool {
    if (!is_string($p)) {
        return false;
    }
    if ($p === '') {
        return $allowEmpty;
    }
    if (strlen($p) > HP_PATH_MAX_BYTES) {
        return false;
    }
    if (preg_match('//u', $p) !== 1) {
        return false;
    }
    if (preg_match('/[\x00-\x1f\x7f]/', $p) === 1) {
        return false;
    }
    $charCount = strlen((string)preg_replace('/[\x80-\xbf]/', '', $p));
    if ($charCount > HP_PATH_MAX_CHARS) {
        return false;
    }
    if ($p[0] === '/' || $p[strlen($p) - 1] === '/') {
        return false;
    }
    foreach (explode('/', $p) as $seg) {
        if ($seg === '' || $seg === '.' || $seg === '..') {
            return false;
        }
        if (strncmp($seg, '.htpanel-', 9) === 0) {
            return false;
        }
        if (strlen($seg) > HP_SEGMENT_MAX_BYTES) {
            return false;
        }
    }
    return true;
}

function hp_inside(string $real, string $root): bool {
    if ($root === '/') {
        return str_starts_with($real, '/');
    }
    return $real === $root || str_starts_with($real, $root . '/');
}

function hp_normalize_abs(string $absPath): string {
    $parts = array();
    foreach (explode('/', $absPath) as $seg) {
        if ($seg === '' || $seg === '.') {
            continue;
        }
        if ($seg === '..') {
            array_pop($parts);
        } else {
            $parts[] = $seg;
        }
    }
    return '/' . implode('/', $parts);
}

function hp_is_protected(string $realRel): bool {
    $protected = array('wp-content/mu-plugins/hp-mail.php');
    foreach ($protected as $p) {
        if ($realRel === $p || str_starts_with($p, $realRel . '/')) {
            return true;
        }
    }
    return false;
}

function hp_join(string $dir, string $name): string {
    return $dir === '/' ? ('/' . $name) : ($dir . '/' . $name);
}

function hp_follow_link_node(string $linkDir, string $linkFullPath, string $root): string {
    error_clear_last();
    $real = @realpath($linkFullPath);
    if ($real !== false) {
        if (!hp_inside($real, $root)) {
            hp_fail('PERMISSION_DENIED', 'protected');
        }
        return $real;
    }

    $curDir = $linkDir;
    $curFile = $linkFullPath;
    for ($hop = 0; $hop < HP_SYMLOOP_MAX; $hop++) {
        $target = @readlink($curFile);
        if ($target === false) {
            break;
        }
        $cand = ($target !== '' && $target[0] === '/')
            ? $target
            : hp_join($curDir, $target);
        $norm = hp_normalize_abs($cand);
        if (!hp_inside($norm, $root)) {
            hp_fail('PERMISSION_DENIED', 'protected');
        }
        $st = @lstat($norm);
        if ($st === false) {
            $relFromRoot = ($norm === $root) ? '' : substr($norm, strlen($root) + 1);
            if ($relFromRoot !== '') {
                $walk = $root;
                foreach (explode('/', $relFromRoot) as $seg) {
                    $walk = hp_join($walk, $seg);
                    $wst = @lstat($walk);
                    if ($wst === false) {
                        break;
                    }
                    if (($wst['mode'] & 0170000) === 0120000) {
                        $wreal = @realpath($walk);
                        if ($wreal !== false) {
                            if (!hp_inside($wreal, $root)) {
                                hp_fail('PERMISSION_DENIED', 'protected');
                            }
                            $walk = $wreal;
                        } else {
                            $wt = @readlink($walk);
                            if ($wt !== false) {
                                $wcand = ($wt !== '' && $wt[0] === '/')
                                    ? $wt
                                    : hp_join(dirname($walk), $wt);
                                if (!hp_inside(hp_normalize_abs($wcand), $root)) {
                                    hp_fail('PERMISSION_DENIED', 'protected');
                                }
                            }
                            break;
                        }
                    }
                }
            }
            hp_fail('NOT_FOUND', 'not_found');
        }
        if (($st['mode'] & 0170000) === 0120000) {
            $curDir = dirname($norm);
            $curFile = $norm;
            continue;
        }
        break;
    }
    hp_fail('NOT_FOUND', 'not_found');
}

function hp_resolve_parent(string $rel, string $root): array {
    $parts = explode('/', $rel);
    $base = (string)array_pop($parts);
    $cur = $root;
    $count = count($parts);
    for ($i = 0; $i < $count; $i++) {
        $seg = $parts[$i];
        $next = hp_join($cur, $seg);
        error_clear_last();
        $st = @lstat($next);
        if ($st === false) {
            $err = error_get_last();
            if ($err !== null && isset($err['message'])) {
                $msg = (string)$err['message'];
                if (stripos($msg, 'Permission denied') !== false || stripos($msg, 'Operation not permitted') !== false) {
                    hp_fail('PERMISSION_DENIED', 'protected');
                }
            }
            hp_fail('NOT_FOUND', 'not_found');
        }
        $ftype = $st['mode'] & 0170000;
        if ($ftype === 0120000) {
            $resolved = hp_follow_link_node($cur, $next, $root);
            $tst = @lstat($resolved);
            if ($tst === false) {
                hp_fail('NOT_FOUND', 'not_found');
            }
            if (($tst['mode'] & 0170000) !== 0040000) {
                if ($i === $count - 1) {
                    hp_fail('VALIDATION_ERROR', 'not_a_directory');
                }
                hp_fail('NOT_FOUND', 'not_found');
            }
            $cur = $resolved;
        } elseif ($ftype === 0040000) {
            $cur = $next;
        } else {
            if ($i === $count - 1) {
                hp_fail('VALIDATION_ERROR', 'not_a_directory');
            }
            hp_fail('NOT_FOUND', 'not_found');
        }
    }
    $parentRel = ($cur === $root) ? '' : substr($cur, strlen($root) + 1);
    $realRel = ($parentRel === '') ? $base : ($parentRel . '/' . $base);
    return array($cur, $base, $realRel);
}

function hp_follow(string $rel, string $root): string {
    if ($rel === '') {
        return $root;
    }
    $res = hp_resolve_parent($rel, $root);
    $realParent = $res[0];
    $base = $res[1];
    $target = hp_join($realParent, $base);
    error_clear_last();
    $st = @lstat($target);
    if ($st === false) {
        $err = error_get_last();
        if ($err !== null && isset($err['message'])) {
            $msg = (string)$err['message'];
            if (stripos($msg, 'Permission denied') !== false || stripos($msg, 'Operation not permitted') !== false) {
                hp_fail('PERMISSION_DENIED', 'protected');
            }
        }
        hp_fail('NOT_FOUND', 'not_found');
    }
    if (($st['mode'] & 0170000) === 0120000) {
        return hp_follow_link_node($realParent, $target, $root);
    }
    return $target;
}

function hp_format_mtime(int $mtime): string {
    $clamped = max(HP_MTIME_MIN, min(HP_MTIME_MAX, $mtime));
    return gmdate('Y-m-d\TH:i:s\Z', $clamped);
}

function hp_entry_from_lstat(string $name, string $fullPath, array $st, bool $parentWritable): array {
    $ftype = $st['mode'] & 0170000;
    if ($ftype === 0120000) {
        $kind = 'link';
    } elseif ($ftype === 0040000) {
        $kind = 'dir';
    } elseif ($ftype === 0100000) {
        $kind = 'file';
    } else {
        $kind = 'other';
    }
    $size = ($kind === 'dir') ? 0 : max(0, (int)$st['size']);
    $writable = ($kind === 'link') ? $parentWritable : @is_writable($fullPath);
    return array(
        'name' => $name,
        'kind' => $kind,
        'size' => $size,
        'modifiedAt' => hp_format_mtime((int)$st['mtime']),
        'writable' => $writable,
    );
}

function hp_op_list(array $req, string $root): array {
    if (!isset($req['path']) || !hp_rel_ok($req['path'], true)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $d = hp_follow($req['path'], $root);
    if (!@is_dir($d)) {
        hp_fail('VALIDATION_ERROR', 'not_a_directory');
    }
    error_clear_last();
    $dh = @opendir($d);
    if ($dh === false) {
        hp_map_fs_error();
    }
    $dirWritable = @is_writable($d);
    $entries = array();
    $totalBytes = 64;
    $truncated = false;
    while (($name = readdir($dh)) !== false) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        if (strncmp($name, '.htpanel-', 9) === 0) {
            continue;
        }
        if (preg_match('//u', $name) !== 1 || strlen($name) > HP_SEGMENT_MAX_BYTES) {
            continue;
        }
        $full = hp_join($d, $name);
        $st = @lstat($full);
        if ($st === false) {
            continue;
        }
        if (count($entries) >= HP_LIST_MAX) {
            $truncated = true;
            break;
        }
        $entry = hp_entry_from_lstat($name, $full, $st, $dirWritable);
        $entryBytes = strlen(json_encode($entry, HP_JSON_FLAGS)) + 1;
        if ($entries !== array() && ($totalBytes + $entryBytes) > HP_LIST_MAX_BYTES) {
            $truncated = true;
            break;
        }
        $totalBytes += $entryBytes;
        $entries[] = $entry;
    }
    closedir($dh);
    usort($entries, static function (array $a, array $b): int {
        $aDir = ($a['kind'] === 'dir') ? 0 : 1;
        $bDir = ($b['kind'] === 'dir') ? 0 : 1;
        if ($aDir !== $bDir) {
            return $aDir <=> $bDir;
        }
        return strcmp($a['name'], $b['name']);
    });
    return array('entries' => $entries, 'truncated' => $truncated);
}

function hp_op_stat(array $req, string $root): array {
    if (!isset($req['path']) || !hp_rel_ok($req['path'], true)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $path = $req['path'];
    if ($path === '') {
        error_clear_last();
        $st = @lstat($root);
        if ($st === false) {
            hp_lstat_fail();
        }
        return array(
            'entry' => array(
                'name' => '',
                'kind' => 'dir',
                'size' => 0,
                'modifiedAt' => hp_format_mtime((int)$st['mtime']),
                'writable' => @is_writable($root),
            ),
        );
    }
    $res = hp_resolve_parent($path, $root);
    $realParent = $res[0];
    $base = $res[1];
    $target = hp_join($realParent, $base);
    error_clear_last();
    $st = @lstat($target);
    if ($st === false) {
        hp_lstat_fail();
    }
    return array('entry' => hp_entry_from_lstat($base, $target, $st, @is_writable($realParent)));
}

function hp_op_read(array $req, string $root): array {
    if (!isset($req['path']) || !hp_rel_ok($req['path'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['offset']) || !is_int($req['offset']) || $req['offset'] < 0) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    if ($req['offset'] > HP_MAX_FILE_BYTES) {
        hp_fail('QUOTA_EXCEEDED', 'too_large');
    }
    if (!isset($req['length']) || !is_int($req['length']) || $req['length'] < 1 || $req['length'] > HP_CHUNK_BYTES) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $offset = $req['offset'];
    $length = $req['length'];
    $t = hp_follow($req['path'], $root);
    error_clear_last();
    $st = @lstat($t);
    if ($st === false) {
        hp_lstat_fail();
    }
    if (($st['mode'] & 0170000) !== 0100000) {
        hp_fail('VALIDATION_ERROR', 'is_a_directory');
    }
    $size = (int)$st['size'];
    if ($offset > $size) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    error_clear_last();
    $fp = @fopen($t, 'rb');
    if ($fp === false) {
        hp_map_fs_error();
    }
    if ($offset > 0 && @fseek($fp, $offset, SEEK_SET) !== 0) {
        @fclose($fp);
        hp_fail('INTERNAL_ERROR', 'internal_error');
    }
    $buf = '';
    $rem = $length;
    while ($rem > 0 && !feof($fp)) {
        error_clear_last();
        $chunk = @fread($fp, $rem);
        if ($chunk === false) {
            $err = error_get_last();
            @fclose($fp);
            hp_map_fs_error_from($err);
        }
        if ($chunk === '') {
            break;
        }
        $buf .= $chunk;
        $rem -= strlen($chunk);
    }
    @fclose($fp);
    $n = strlen($buf);
    return array(
        'dataBase64' => base64_encode($buf),
        'size' => $size,
        'eof' => ($offset + $n) >= $size,
    );
}

function hp_check_write_target(string $targetPath, string $realRel, bool $overwrite): ?array {
    if (hp_is_protected($realRel)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    $tst = @lstat($targetPath);
    if ($tst !== false) {
        if (($tst['mode'] & 0170000) !== 0100000) {
            hp_fail('ALREADY_EXISTS', 'exists');
        }
        if (!$overwrite) {
            hp_fail('ALREADY_EXISTS', 'exists');
        }
        return $tst;
    }
    return null;
}

function hp_op_write(array $req, string $root): array {
    if (!isset($req['path']) || !hp_rel_ok($req['path'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['uploadId']) || !is_string($req['uploadId']) || preg_match('/^[A-Za-z0-9_-]{16,64}$/', $req['uploadId']) !== 1) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['offset']) || !is_int($req['offset']) || $req['offset'] < 0) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }
    if ($req['offset'] > HP_MAX_FILE_BYTES) {
        hp_fail('QUOTA_EXCEEDED', 'too_large');
    }
    if (!isset($req['dataBase64']) || !is_string($req['dataBase64'])) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['final']) || !is_bool($req['final']) || !isset($req['overwrite']) || !is_bool($req['overwrite'])) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $b64 = $req['dataBase64'];
    $b64Len = strlen($b64);
    if (($b64Len % 4) !== 0 || preg_match('/[^A-Za-z0-9+\/=]/', $b64) === 1) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $eqPos = strpos($b64, '=');
    if ($eqPos !== false && ($eqPos < $b64Len - 2 || ($eqPos === $b64Len - 2 && $b64[$b64Len - 1] !== '='))) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $data = base64_decode($b64, true);
    if ($data === false) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $len = strlen($data);
    if ($len > HP_CHUNK_BYTES) {
        hp_fail('QUOTA_EXCEEDED', 'too_large');
    }
    $offset = $req['offset'];
    if ($offset + $len > HP_MAX_FILE_BYTES) {
        hp_fail('QUOTA_EXCEEDED', 'too_large');
    }
    $final = $req['final'];
    $overwrite = $req['overwrite'];

    $res = hp_resolve_parent($req['path'], $root);
    $realParent = $res[0];
    $base = $res[1];
    $realRel = $res[2];
    $targetPath = hp_join($realParent, $base);

    hp_check_write_target($targetPath, $realRel, $overwrite);

    if (!@is_writable($realParent)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }

    $stagePath = hp_join($realParent, '.htpanel-upload-' . $req['uploadId'] . '.part');
    $sst = @lstat($stagePath);
    if ($sst !== false) {
        $stype = $sst['mode'] & 0170000;
        if ($stype === 0120000) {
            if ($offset === 0) {
                error_clear_last();
                if (!@unlink($stagePath)) {
                    hp_map_fs_error();
                }
                $sst = false;
            } else {
                hp_fail('VALIDATION_ERROR', 'upload_mismatch');
            }
        } elseif ($stype !== 0100000) {
            hp_fail('VALIDATION_ERROR', 'upload_mismatch');
        } elseif (!@is_writable($stagePath)) {
            hp_fail('PERMISSION_DENIED', 'protected');
        }
    }

    $curSize = ($sst !== false) ? (int)$sst['size'] : 0;
    if ($offset > $curSize) {
        hp_fail('VALIDATION_ERROR', 'upload_mismatch');
    }

    $free = @disk_free_space($realParent);
    if ($free !== false && ($free - $len) < HP_DISK_FREE_FLOOR) {
        hp_fail('QUOTA_EXCEEDED', 'disk_full');
    }

    error_clear_last();
    $fp = @fopen($stagePath, 'cb');
    if ($fp === false) {
        hp_map_fs_error();
    }
    if (@fseek($fp, $offset, SEEK_SET) !== 0) {
        @fclose($fp);
        hp_fail('INTERNAL_ERROR', 'internal_error');
    }
    $written = 0;
    while ($written < $len) {
        error_clear_last();
        $n = @fwrite($fp, substr($data, $written));
        if ($n === false || $n === 0) {
            $err = error_get_last();
            @fclose($fp);
            hp_map_fs_error_from($err);
        }
        $written += $n;
    }
    if ($final && @ftruncate($fp, $offset + $len) === false) {
        $err = error_get_last();
        @fclose($fp);
        hp_map_fs_error_from($err);
    }
    @fflush($fp);
    @fclose($fp);
    clearstatcache(true, $stagePath);

    if ($final) {
        clearstatcache(true, $targetPath);
        $existingStat = hp_check_write_target($targetPath, $realRel, $overwrite);
        if ($existingStat !== null) {
            @chmod($stagePath, $existingStat['mode'] & 0777);
        }
        error_clear_last();
        if (!@rename($stagePath, $targetPath)) {
            hp_map_fs_error();
        }
        clearstatcache();
        return array('received' => $offset + $len);
    }

    $afterStat = @lstat($stagePath);
    $received = ($afterStat !== false) ? (int)$afterStat['size'] : ($offset + $len);
    clearstatcache();
    return array('received' => $received);
}

function hp_op_mkdir(array $req, string $root): object {
    if (!isset($req['path']) || !hp_rel_ok($req['path'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $res = hp_resolve_parent($req['path'], $root);
    $realParent = $res[0];
    $base = $res[1];
    $realRel = $res[2];
    if (hp_is_protected($realRel)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    $t = hp_join($realParent, $base);
    if (@lstat($t) !== false) {
        hp_fail('ALREADY_EXISTS', 'exists');
    }
    if (!@is_writable($realParent)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    error_clear_last();
    if (!@mkdir($t, 0755, false)) {
        hp_map_fs_error();
    }
    clearstatcache();
    return (object)array();
}

function hp_op_move(array $req, string $root): object {
    if (!isset($req['from']) || !hp_rel_ok($req['from'], false) || !isset($req['to']) || !hp_rel_ok($req['to'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $fromRes = hp_resolve_parent($req['from'], $root);
    $fromPath = hp_join($fromRes[0], $fromRes[1]);
    $fromRealRel = $fromRes[2];
    error_clear_last();
    $fromStat = @lstat($fromPath);
    if ($fromStat === false) {
        hp_lstat_fail();
    }
    if (hp_is_protected($fromRealRel)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }

    $toRes = hp_resolve_parent($req['to'], $root);
    $toPath = hp_join($toRes[0], $toRes[1]);
    $toRealRel = $toRes[2];
    if (hp_is_protected($toRealRel)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }

    if ($fromRealRel === $toRealRel) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (($fromStat['mode'] & 0170000) === 0040000 && str_starts_with($toRealRel, $fromRealRel . '/')) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (@lstat($toPath) !== false) {
        hp_fail('ALREADY_EXISTS', 'exists');
    }

    error_clear_last();
    if (!@rename($fromPath, $toPath)) {
        hp_map_fs_error();
    }
    clearstatcache();
    return (object)array();
}

function hp_rm_tree(string $path): void {
    error_clear_last();
    $st = @lstat($path);
    if ($st === false) {
        hp_lstat_fail();
    }
    if (($st['mode'] & 0170000) !== 0040000) {
        error_clear_last();
        if (!@unlink($path)) {
            hp_map_fs_error();
        }
        return;
    }
    error_clear_last();
    $dh = @opendir($path);
    if ($dh === false) {
        hp_map_fs_error();
    }
    while (($name = readdir($dh)) !== false) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        hp_rm_tree(hp_join($path, $name));
    }
    closedir($dh);
    error_clear_last();
    if (!@rmdir($path)) {
        hp_map_fs_error();
    }
}

function hp_op_delete(array $req, string $root): object {
    if (!isset($req['paths']) || !is_array($req['paths']) || count($req['paths']) < 1 || count($req['paths']) > HP_BATCH_MAX) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    $targets = array();
    foreach ($req['paths'] as $p) {
        if (!hp_rel_ok($p, false)) {
            hp_fail('VALIDATION_ERROR', 'invalid_path');
        }
        $res = hp_resolve_parent($p, $root);
        $full = hp_join($res[0], $res[1]);
        $realRel = $res[2];
        error_clear_last();
        if (@lstat($full) === false) {
            hp_lstat_fail();
        }
        if (hp_is_protected($realRel)) {
            hp_fail('PERMISSION_DENIED', 'protected');
        }
        $targets[$realRel] = $full;
    }
    foreach ($targets as $full) {
        if (@lstat($full) !== false) {
            hp_rm_tree($full);
        }
    }
    clearstatcache();
    return (object)array();
}

function hp_archive_walk(
    ZipArchive $zip,
    string $fsPath,
    string $zipName,
    int $depth,
    int &$entryCount,
    int &$totalBytes,
    string $stagePath
): void {
    $st = @lstat($fsPath);
    if ($st === false) {
        return;
    }
    $ftype = $st['mode'] & 0170000;
    if ($ftype === 0120000 || ($ftype !== 0040000 && $ftype !== 0100000)) {
        return;
    }
    if ($depth > HP_ZIP_MAX_DEPTH) {
        @$zip->close();
        @unlink($stagePath);
        hp_fail('QUOTA_EXCEEDED', 'archive_limit');
    }
    if ($entryCount + 1 > HP_ZIP_MAX_ENTRIES) {
        @$zip->close();
        @unlink($stagePath);
        hp_fail('QUOTA_EXCEEDED', 'archive_limit');
    }
    if ($ftype === 0040000) {
        error_clear_last();
        $dh = @opendir($fsPath);
        if ($dh === false) {
            $err = error_get_last();
            @$zip->close();
            @unlink($stagePath);
            hp_map_fs_error_from($err);
        }
        $children = array();
        while (($name = readdir($dh)) !== false) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            if (strncmp($name, '.htpanel-', 9) === 0) {
                continue;
            }
            if (preg_match('//u', $name) !== 1 || strlen($name) > HP_SEGMENT_MAX_BYTES) {
                continue;
            }
            $children[] = $name;
        }
        closedir($dh);
        sort($children, SORT_STRING);
        if (!$zip->addEmptyDir($zipName)) {
            @$zip->close();
            @unlink($stagePath);
            hp_fail('INTERNAL_ERROR', 'internal_error');
        }
        $entryCount++;
        foreach ($children as $child) {
            hp_archive_walk(
                $zip,
                hp_join($fsPath, $child),
                $zipName . '/' . $child,
                $depth + 1,
                $entryCount,
                $totalBytes,
                $stagePath
            );
        }
        return;
    }

    $size = max(0, (int)$st['size']);
    if ($totalBytes + $size > HP_ZIP_MAX_UNCOMPRESSED) {
        @$zip->close();
        @unlink($stagePath);
        hp_fail('QUOTA_EXCEEDED', 'archive_limit');
    }
    error_clear_last();
    $probe = @fopen($fsPath, 'rb');
    if ($probe === false) {
        $err = error_get_last();
        @$zip->close();
        @unlink($stagePath);
        hp_map_fs_error_from($err);
    }
    @fclose($probe);
    if (!$zip->addFile($fsPath, $zipName)) {
        @$zip->close();
        @unlink($stagePath);
        hp_fail('INTERNAL_ERROR', 'internal_error');
    }
    $entryCount++;
    $totalBytes += $size;
}

function hp_op_archive(array $req, string $root): array {
    if (!class_exists('ZipArchive')) {
        hp_fail('NOT_SUPPORTED', 'zip_unavailable');
    }
    if (!isset($req['paths']) || !is_array($req['paths']) || count($req['paths']) < 1 || count($req['paths']) > HP_BATCH_MAX) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['to']) || !hp_rel_ok($req['to'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }

    $toRes = hp_resolve_parent($req['to'], $root);
    $toParent = $toRes[0];
    $toBase = $toRes[1];
    $toRealRel = $toRes[2];
    if (hp_is_protected($toRealRel)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }
    $toPath = hp_join($toParent, $toBase);
    if (@lstat($toPath) !== false) {
        hp_fail('ALREADY_EXISTS', 'exists');
    }
    if (!@is_writable($toParent)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }

    $commonParent = null;
    $sources = array();
    foreach ($req['paths'] as $p) {
        if (!hp_rel_ok($p, false)) {
            hp_fail('VALIDATION_ERROR', 'invalid_path');
        }
        $res = hp_resolve_parent($p, $root);
        if ($commonParent === null) {
            $commonParent = $res[0];
        } elseif ($res[0] !== $commonParent) {
            hp_fail('VALIDATION_ERROR', 'invalid_path');
        }
        $srcPath = hp_join($res[0], $res[1]);
        error_clear_last();
        if (@lstat($srcPath) === false) {
            hp_lstat_fail();
        }
        $sources[$res[1]] = $srcPath;
    }

    $free = @disk_free_space($toParent);
    if ($free !== false && $free < HP_DISK_FREE_FLOOR) {
        hp_fail('QUOTA_EXCEEDED', 'disk_full');
    }

    $stagePath = hp_join($toParent, '.htpanel-archive-' . bin2hex(random_bytes(8)) . '.part');
    $zip = new ZipArchive();
    if ($zip->open($stagePath, ZipArchive::CREATE | ZipArchive::EXCL) !== true) {
        @unlink($stagePath);
        hp_fail('INTERNAL_ERROR', 'internal_error');
    }

    $entryCount = 0;
    $totalBytes = 0;
    foreach ($sources as $baseName => $srcPath) {
        hp_archive_walk($zip, $srcPath, $baseName, 1, $entryCount, $totalBytes, $stagePath);
    }

    error_clear_last();
    $closed = @$zip->close();
    if ($entryCount === 0 && @lstat($stagePath) === false) {
        error_clear_last();
        if (@file_put_contents($stagePath, "PK\x05\x06" . str_repeat("\0", 18)) === false) {
            $err = error_get_last();
            @unlink($stagePath);
            hp_map_fs_error_from($err);
        }
    } elseif (!$closed) {
        $err = error_get_last();
        @unlink($stagePath);
        hp_map_fs_error_from($err);
    }

    if (@lstat($toPath) !== false) {
        @unlink($stagePath);
        hp_fail('ALREADY_EXISTS', 'exists');
    }
    error_clear_last();
    if (!@rename($stagePath, $toPath)) {
        $err = error_get_last();
        @unlink($stagePath);
        hp_map_fs_error_from($err);
    }
    clearstatcache();
    return array('entries' => $entryCount);
}

function hp_rollback_created(array $created): void {
    for ($i = count($created) - 1; $i >= 0; $i--) {
        $item = $created[$i];
        if ($item['type'] === 'file') {
            @unlink($item['path']);
        } else {
            @rmdir($item['path']);
        }
    }
}

function hp_ensure_dir_components(
    string $baseFsPrefix,
    array $dirParts,
    array &$created,
    ZipArchive $zip
): void {
    $cur = $baseFsPrefix;
    foreach ($dirParts as $part) {
        $cur = hp_join($cur, $part);
        clearstatcache(true, $cur);
        $st = @lstat($cur);
        if ($st !== false) {
            if (($st['mode'] & 0170000) !== 0040000) {
                hp_rollback_created($created);
                $zip->close();
                hp_fail('ALREADY_EXISTS', 'exists');
            }
            continue;
        }
        error_clear_last();
        if (!@mkdir($cur, 0755, false)) {
            $err = error_get_last();
            hp_rollback_created($created);
            $zip->close();
            hp_map_fs_error_from($err);
        }
        $created[] = array('type' => 'dir', 'path' => $cur);
    }
}

function hp_op_extract(array $req, string $root, bool $import = false): array {
    if (!class_exists('ZipArchive')) {
        hp_fail('NOT_SUPPORTED', 'zip_unavailable');
    }
    if (!isset($req['path']) || !hp_rel_ok($req['path'], false)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }
    if (!isset($req['to']) || !hp_rel_ok($req['to'], true)) {
        hp_fail('VALIDATION_ERROR', 'invalid_path');
    }

    $src = hp_follow($req['path'], $root);
    error_clear_last();
    $srcStat = @lstat($src);
    if ($srcStat === false) {
        hp_lstat_fail();
    }
    if (($srcStat['mode'] & 0170000) !== 0100000) {
        hp_fail('VALIDATION_ERROR', 'is_a_directory');
    }

    $to = $req['to'];
    if ($to === '') {
        $toDir = $root;
        $toRealRel = '';
        $toExists = true;
        $spaceDir = $root;
    } else {
        $toRes = hp_resolve_parent($to, $root);
        $toParent = $toRes[0];
        $toBase = $toRes[1];
        $toRealRel = $toRes[2];
        if (hp_is_protected($toRealRel)) {
            hp_fail('PERMISSION_DENIED', 'protected');
        }
        $toDir = hp_join($toParent, $toBase);
        $toStat = @lstat($toDir);
        if ($toStat !== false) {
            if (($toStat['mode'] & 0170000) !== 0040000) {
                hp_fail('ALREADY_EXISTS', 'exists');
            }
            $toExists = true;
            $spaceDir = $toDir;
        } else {
            $toExists = false;
            $spaceDir = $toParent;
        }
    }

    if (!@is_writable($spaceDir)) {
        hp_fail('PERMISSION_DENIED', 'protected');
    }

    $zip = new ZipArchive();
    if ($zip->open($src, ZipArchive::RDONLY) !== true) {
        hp_fail('VALIDATION_ERROR', 'not_a_zip');
    }

    $maxEntries = $import ? HP_IMPORT_MAX_ENTRIES : HP_ZIP_MAX_ENTRIES;
    $maxUncompressed = $import ? HP_IMPORT_MAX_UNCOMPRESSED : HP_ZIP_MAX_UNCOMPRESSED;
    $numFiles = $zip->numFiles;
    if ($numFiles > $maxEntries) {
        $zip->close();
        hp_fail('QUOTA_EXCEEDED', 'archive_limit');
    }

    $seen = array();
    $fileNames = array();
    $entries = array();
    $htaccess = array();
    $totalDeclared = 0;

    for ($i = 0; $i < $numFiles; $i++) {
        $stat = $zip->statIndex($i);
        if ($stat === false || !isset($stat['name']) || !is_string($stat['name'])) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'not_a_zip');
        }
        $rawName = $stat['name'];
        if ($rawName === '' || preg_match('//u', $rawName) !== 1 || preg_match('/[\x00-\x1f\x7f]/', $rawName) === 1) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'archive_unsafe');
        }
        if (str_contains($rawName, '\\') || $rawName[0] === '/' || preg_match('/^[A-Za-z]:/', $rawName) === 1) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'archive_unsafe');
        }
        $isDir = str_ends_with($rawName, '/');
        $cleanName = $isDir ? substr($rawName, 0, -1) : $rawName;
        if (!hp_rel_ok($cleanName, false)) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'archive_unsafe');
        }
        if (isset($seen[$cleanName])) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'archive_unsafe');
        }
        $seen[$cleanName] = true;

        $parts = explode('/', $cleanName);
        if (count($parts) > HP_ZIP_MAX_DEPTH) {
            $zip->close();
            hp_fail('QUOTA_EXCEEDED', 'archive_limit');
        }

        $opsys = 0;
        $attr = 0;
        if ($zip->getExternalAttributesIndex($i, $opsys, $attr) && $opsys === ZipArchive::OPSYS_UNIX) {
            $ftype = ($attr >> 16) & 0170000;
            if ($ftype === 0120000) {
                $zip->close();
                hp_fail('VALIDATION_ERROR', 'archive_unsafe');
            }
            if ($ftype !== 0 && $ftype !== 0100000 && $ftype !== 0040000) {
                $zip->close();
                hp_fail('VALIDATION_ERROR', 'archive_unsafe');
            }
            if ($isDir && $ftype === 0100000) {
                $zip->close();
                hp_fail('VALIDATION_ERROR', 'archive_unsafe');
            }
            if (!$isDir && $ftype === 0040000) {
                $isDir = true;
            }
        }

        $uncomp = (int)$stat['size'];
        $comp = (int)$stat['comp_size'];
        if ($uncomp < 0) {
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'not_a_zip');
        }
        $totalDeclared += $uncomp;
        if ($totalDeclared > $maxUncompressed) {
            $zip->close();
            hp_fail('QUOTA_EXCEEDED', 'archive_limit');
        }
        if ($uncomp > HP_ZIP_RATIO_THRESHOLD && $uncomp > HP_ZIP_MAX_RATIO * max(1, $comp)) {
            $zip->close();
            hp_fail('QUOTA_EXCEEDED', 'archive_limit');
        }

        if ($import) {
            // An imported .htaccess is written as .htaccess.hpimport so it is never served before finish.
            $last = count($parts) - 1;
            foreach ($parts as $k => $seg) {
                if ($seg === '.htaccess.hpimport' || ($seg === '.htaccess' && ($isDir || $k < $last))) {
                    $zip->close();
                    hp_fail('VALIDATION_ERROR', 'archive_unsafe');
                }
            }
            if (!$isDir && $parts[$last] === '.htaccess') {
                $htaccess[] = $cleanName;
                $cleanName .= '.hpimport';
            }
        }

        if (!$isDir) {
            $fileNames[$cleanName] = true;
        }
        $entries[] = array($i, $cleanName, $isDir, $uncomp);
    }

    $baseRelPrefix = ($toRealRel === '') ? '' : ($toRealRel . '/');
    foreach ($entries as [$eIdx, $eName, $eDir, $eSize]) {
        $targetRel = $baseRelPrefix . $eName;
        if ($eDir) {
            if ($targetRel === 'wp-content/mu-plugins/hp-mail.php') {
                $zip->close();
                hp_fail('PERMISSION_DENIED', 'protected');
            }
        } elseif (hp_is_protected($targetRel)) {
            $zip->close();
            hp_fail('PERMISSION_DENIED', 'protected');
        }

        $parts = explode('/', $eName);
        $prefix = '';
        $parentCount = count($parts) - 1;
        for ($j = 0; $j < $parentCount; $j++) {
            $prefix = ($prefix === '') ? $parts[$j] : ($prefix . '/' . $parts[$j]);
            if (isset($fileNames[$prefix])) {
                $zip->close();
                hp_fail('ALREADY_EXISTS', 'exists');
            }
        }

        if ($toExists) {
            $cur = $toDir;
            $lastWritableCheck = $toDir;
            for ($j = 0; $j < $parentCount; $j++) {
                $cur = hp_join($cur, $parts[$j]);
                $pst = @lstat($cur);
                if ($pst === false) {
                    break;
                }
                if (($pst['mode'] & 0170000) !== 0040000) {
                    $zip->close();
                    hp_fail('ALREADY_EXISTS', 'exists');
                }
                $lastWritableCheck = $cur;
            }
            if (!@is_writable($lastWritableCheck)) {
                $zip->close();
                hp_fail('PERMISSION_DENIED', 'protected');
            }
            $fullTarget = hp_join($toDir, $eName);
            $tst = @lstat($fullTarget);
            if ($tst !== false) {
                if ($eDir) {
                    if (($tst['mode'] & 0170000) !== 0040000) {
                        $zip->close();
                        hp_fail('ALREADY_EXISTS', 'exists');
                    }
                    if (!@is_writable($fullTarget)) {
                        $zip->close();
                        hp_fail('PERMISSION_DENIED', 'protected');
                    }
                } else {
                    $zip->close();
                    hp_fail('ALREADY_EXISTS', 'exists');
                }
            }
        }
    }

    $free = @disk_free_space($spaceDir);
    if ($free !== false && ($free - $totalDeclared) < HP_DISK_FREE_FLOOR) {
        $zip->close();
        hp_fail('QUOTA_EXCEEDED', 'disk_full');
    }

    $created = array();
    if (!$toExists) {
        error_clear_last();
        if (!@mkdir($toDir, 0755, false)) {
            $err = error_get_last();
            $zip->close();
            hp_map_fs_error_from($err);
        }
        $created[] = array('type' => 'dir', 'path' => $toDir);
    }

    $totalWritten = 0;
    $extractedCount = 0;
    foreach ($entries as [$eIdx, $eName, $eDir, $eSize]) {
        $parts = explode('/', $eName);
        if ($eDir) {
            hp_ensure_dir_components($toDir, $parts, $created, $zip);
            $extractedCount++;
            continue;
        }
        $parentParts = array_slice($parts, 0, -1);
        if (count($parentParts) > 0) {
            hp_ensure_dir_components($toDir, $parentParts, $created, $zip);
        }
        $destFile = hp_join($toDir, $eName);
        error_clear_last();
        $out = @fopen($destFile, 'xb');
        if ($out === false) {
            $err = error_get_last();
            hp_rollback_created($created);
            $zip->close();
            hp_map_fs_error_from($err);
        }
        $created[] = array('type' => 'file', 'path' => $destFile);

        $in = @$zip->getStreamIndex($eIdx);
        if ($in === false) {
            @fclose($out);
            hp_rollback_created($created);
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'not_a_zip');
        }
        $entryWritten = 0;
        while (!feof($in)) {
            $chunk = @fread($in, 65536);
            if ($chunk === false) {
                @fclose($in);
                @fclose($out);
                hp_rollback_created($created);
                $zip->close();
                hp_fail('VALIDATION_ERROR', 'not_a_zip');
            }
            if ($chunk === '') {
                break;
            }
            $chunkLen = strlen($chunk);
            $entryWritten += $chunkLen;
            $totalWritten += $chunkLen;
            if ($entryWritten > $eSize || $totalWritten > $maxUncompressed) {
                @fclose($in);
                @fclose($out);
                hp_rollback_created($created);
                $zip->close();
                hp_fail('QUOTA_EXCEEDED', 'archive_limit');
            }
            $w = 0;
            while ($w < $chunkLen) {
                error_clear_last();
                $n = @fwrite($out, substr($chunk, $w));
                if ($n === false || $n === 0) {
                    $err = error_get_last();
                    @fclose($in);
                    @fclose($out);
                    hp_rollback_created($created);
                    $zip->close();
                    hp_map_fs_error_from($err);
                }
                $w += $n;
            }
        }
        @fclose($in);
        @fclose($out);
        if ($entryWritten !== $eSize) {
            hp_rollback_created($created);
            $zip->close();
            hp_fail('VALIDATION_ERROR', 'not_a_zip');
        }
        $extractedCount++;
    }

    $zip->close();
    clearstatcache();
    return $import ? array('entries' => $extractedCount, 'htaccess' => $htaccess) : array('entries' => $extractedCount);
}

function hp_op_sweep(string $root): array {
    $now = time();
    $deadline = $now + HP_SWEEP_BUDGET_SECS;
    $visited = 0;
    $removed = 0;
    $stack = array(array($root, 0));

    while (count($stack) > 0) {
        if ($visited >= HP_SWEEP_MAX_ENTRIES || time() >= $deadline) {
            break;
        }
        $item = array_pop($stack);
        $dir = $item[0];
        $depth = $item[1];
        $dh = @opendir($dir);
        if ($dh === false) {
            continue;
        }
        while (($name = readdir($dh)) !== false) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $visited++;
            if ($visited > HP_SWEEP_MAX_ENTRIES || time() >= $deadline) {
                break;
            }
            $full = hp_join($dir, $name);
            $st = @lstat($full);
            if ($st === false) {
                continue;
            }
            $ftype = $st['mode'] & 0170000;
            if ($ftype === 0120000) {
                continue;
            }
            if ($ftype === 0040000) {
                if ($depth + 1 <= HP_SWEEP_MAX_DEPTH) {
                    $stack[] = array($full, $depth + 1);
                }
            } elseif ($ftype === 0100000) {
                if (strncmp($name, '.htpanel-', 9) === 0 && ($now - (int)$st['mtime']) > HP_SWEEP_STALE_SECS) {
                    if (@unlink($full)) {
                        $removed++;
                    }
                }
            }
        }
        closedir($dh);
    }

    clearstatcache();
    return array('removed' => $removed);
}

const HP_IMPORT_DIR = '.htpanel-import';
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
}

$rawStdin = stream_get_contents(STDIN);
if ($rawStdin === false) {
    fwrite(STDERR, "failed to read stdin\n");
    exit(1);
}
$req = json_decode($rawStdin, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($req) || !isset($req['op']) || !is_string($req['op'])) {
    fwrite(STDERR, "invalid json request\n");
    exit(1);
}

$envRoot = getenv('HP_FILES_ROOT');
$rawRoot = ($envRoot !== false && $envRoot !== '') ? $envRoot : '/var/www/html';
$root = @realpath($rawRoot);
if ($root === false || !@is_dir($root)) {
    hp_fail('NOT_FOUND', 'not_found');
}
$root = rtrim($root, '/');
if ($root === '') {
    $root = '/';
}

$op = $req['op'];
if ($op === 'list') {
    hp_ok(hp_op_list($req, $root));
} elseif ($op === 'stat') {
    hp_ok(hp_op_stat($req, $root));
} elseif ($op === 'read') {
    hp_ok(hp_op_read($req, $root));
} elseif ($op === 'write') {
    hp_ok(hp_op_write($req, $root));
} elseif ($op === 'mkdir') {
    hp_ok(hp_op_mkdir($req, $root));
} elseif ($op === 'move') {
    hp_ok(hp_op_move($req, $root));
} elseif ($op === 'delete') {
    hp_ok(hp_op_delete($req, $root));
} elseif ($op === 'archive') {
    hp_ok(hp_op_archive($req, $root));
} elseif ($op === 'extract') {
    hp_ok(hp_op_extract($req, $root));
} elseif ($op === 'sweep') {
    hp_ok(hp_op_sweep($root));
} elseif (str_starts_with($op, 'import.')) {
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
    exit(1);
} else {
    fwrite(STDERR, "unknown op\n");
    exit(1);
}
`;

/**
 * Ensures the confined files helper program exists in `dir` with mode 0755/0644 (executor runs
 * under UMask=0007, so modes must be applied explicitly) and rewrites atomically only on change.
 */
export async function ensureSiteFilesProgram(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const file = path.join(dir, SITE_FILES_PROGRAM_FILENAME);
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== SITE_FILES_PROGRAM) {
    await writeFileAtomically(file, SITE_FILES_PROGRAM, 0o644, 0o755);
  } else {
    await chmod(file, 0o644);
  }
}
