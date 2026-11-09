import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SITE_MAIL_DIR = "/var/lib/hosting-panel/site-mail" as const;

const HP_MAIL_PHP = String.raw`<?php
/* Plugin Name: Hosting panel email. Managed by the hosting panel; read-only. */
add_action('phpmailer_init', static function ($m) {
    $m->isSMTP();
    $m->Host = 'hp-mail';
    $m->Port = 587;
    $m->SMTPAuth = false;
    $m->SMTPSecure = '';
    $m->SMTPAutoTLS = false;
    $m->Timeout = 10;
    if ($m->FromName === 'WordPress') {
        $m->FromName = wp_specialchars_decode(get_option('blogname'), ENT_QUOTES);
    }
    if (!$m->getReplyToAddresses() && stripos($m->From, 'wordpress@') !== 0) {
        $m->addReplyTo($m->From, $m->FromName);
    }
}, PHP_INT_MIN);
`;

const HP_MAIL_INI =
  'sendmail_path = "/usr/local/bin/php -n /usr/local/lib/hp-mail/hp-sendmail.php"\n';

// Runs under `php -n` (no extensions, any PHP the sites use): no return types, only core functions.
const HP_SENDMAIL_PHP = String.raw`<?php
/* Managed by the hosting panel; read-only. Hands a message from stdin to the mail server. */
function hp_fail($why) {
    fwrite(STDERR, 'hp-sendmail: ' . trim($why) . "\n");
    exit(1);
}
function hp_expect($fp, $codes) {
    do {
        $line = fgets($fp, 1024);
        if ($line === false) {
            hp_fail('connection lost');
        }
    } while (isset($line[3]) && $line[3] === '-');
    if (!in_array(substr($line, 0, 3), $codes, true)) {
        hp_fail('server replied ' . $line);
    }
}
function hp_addr($a) {
    if (preg_match('/[\r\n]/', $a)) {
        hp_fail('invalid address');
    }
    return $a;
}

$raw = str_replace("\r\n", "\n", stream_get_contents(STDIN));
$parts = explode("\n\n", $raw, 2);
$head = preg_replace('/\n[ \t]+/', ' ', $parts[0]);
$body = isset($parts[1]) ? $parts[1] : '';

$rcpt = array();
$from = '';
$headers = array();
foreach (explode("\n", $head) as $line) {
    if (preg_match('/^(to|cc|bcc):(.*)$/i', $line, $h)) {
        preg_match_all('/[^\s<>,;:"]+@[^\s<>,;:"]+/', $h[2], $found);
        $rcpt = array_merge($rcpt, $found[0]);
        if (strtolower($h[1]) === 'bcc') {
            continue;
        }
    } elseif (preg_match('/^from:(.*)$/i', $line, $h) && preg_match('/[^\s<>,;:"]+@[^\s<>,;:"]+/', $h[1], $f)) {
        $from = $f[0];
    }
    $headers[] = $line;
}

$sender = '';
for ($i = 1; $i < $argc; $i++) {
    if ($argv[$i] === '-f' && isset($argv[$i + 1])) {
        $sender = $argv[$i + 1];
    } elseif (substr($argv[$i], 0, 2) === '-f' && strlen($argv[$i]) > 2) {
        $sender = substr($argv[$i], 2);
    }
}
$sender = trim($sender, " <>");
if ($sender === '') {
    $sender = $from !== '' ? $from : 'wordpress@localhost';
}
$sender = hp_addr($sender);
$rcpt = array_unique($rcpt);
if (!$rcpt) {
    hp_fail('no recipients');
}

$host = getenv('HP_MAIL_HOST') ?: 'hp-mail';
$port = getenv('HP_MAIL_PORT') ?: 587;
$fp = @stream_socket_client('tcp://' . $host . ':' . $port, $errno, $errstr, 10);
if (!$fp) {
    hp_fail('cannot connect: ' . $errstr);
}
stream_set_timeout($fp, 10);

hp_expect($fp, array('220'));
fwrite($fp, "EHLO hp-site\r\n");
hp_expect($fp, array('250'));
fwrite($fp, 'MAIL FROM:<' . $sender . ">\r\n");
hp_expect($fp, array('250'));
foreach ($rcpt as $r) {
    fwrite($fp, 'RCPT TO:<' . hp_addr($r) . ">\r\n");
    hp_expect($fp, array('250', '251'));
}
fwrite($fp, "DATA\r\n");
hp_expect($fp, array('354'));

$lines = array_merge($headers, array(''), explode("\n", $body));
if (end($lines) === '') {
    array_pop($lines);
}
foreach ($lines as $i => $l) {
    if (isset($l[0]) && $l[0] === '.') {
        $lines[$i] = '.' . $l;
    }
}
fwrite($fp, implode("\r\n", $lines) . "\r\n.\r\n");
hp_expect($fp, array('250'));
fwrite($fp, "QUIT\r\n");
fclose($fp);
exit(0);
`;

export const SITE_MAIL_FILES: Readonly<
  Record<"hp-mail.php" | "hp-mail.ini" | "hp-sendmail.php", string>
> = Object.freeze({
  "hp-mail.php": HP_MAIL_PHP,
  "hp-mail.ini": HP_MAIL_INI,
  "hp-sendmail.php": HP_SENDMAIL_PHP,
});

export function siteMailBinds(dir: string): readonly string[] {
  return [
    `${dir}/hp-mail.php:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro`,
    `${dir}/hp-mail.ini:/usr/local/etc/php/conf.d/zz-hp-mail.ini:ro`,
    `${dir}/hp-sendmail.php:/usr/local/lib/hp-mail/hp-sendmail.php:ro`,
  ];
}

/**
 * Written in place (same inode: a single-file bind pins it) and chmod-ed explicitly, because the
 * executor runs with UMask=0007 and the site's PHP user must be able to read these.
 */
export async function ensureSiteMailFiles(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  for (const [name, content] of Object.entries(SITE_MAIL_FILES)) {
    const file = path.join(dir, name);
    const current = await readFile(file, "utf8").catch(() => null);
    if (current !== content) {
      await writeFile(file, content, { flag: "w" });
    }
    await chmod(file, 0o644);
  }
}
