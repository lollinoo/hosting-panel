<?php
// Managed by hp-docker-executor. No secrets.
$cfg['blowfish_secret'] = '';
$cfg['Servers'][1]['host'] = 'hp-mariadb';
$cfg['Servers'][1]['port'] = 3306;
$cfg['Servers'][1]['auth_type'] = 'http';
$cfg['Servers'][1]['AllowRoot'] = false;
$cfg['Servers'][1]['AllowNoPassword'] = false;
$cfg['Servers'][1]['hide_db'] = '^(information_schema|mysql|performance_schema|sys)$';
$cfg['AllowArbitraryServer'] = false;
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['PmaNoRelation_DisableWarning'] = true;
$cfg['ShowChgPassword'] = false;
$cfg['ShowServerInfo'] = false;
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
$cfg['TempDir'] = '/var/www/html/tmp';
$cfg['MemoryLimit'] = '0';
$p = $_SERVER['HTTP_X_FORWARDED_PREFIX'] ?? '';
if (preg_match('#^/phpmyadmin/[A-Za-z0-9_-]{1,128}/$#', $p) === 1) {
    $cfg['PmaAbsoluteUri'] = $p;
}
