<?php
// Checks a host can run TOMLIN OS, before or after uploading. Run it from a terminal on the server (cPanel Terminal or SSH):
//   php tomlinos/tools/server-check.php
// A blank "500" page on cPanel usually means a PHP extension is switched off (the PHP Selector resets ticks after a PHP
// version change); this names the one. Each line says OK, or what is wrong and what to do.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$ok = true;
function line(bool $good, string $what, string $fix = ''): void
{
    global $ok;
    $ok = $ok && $good;
    echo ($good ? '  OK    ' : '  FIX   ') . $what . ($good || $fix === '' ? '' : "\n        -> $fix") . "\n";
}
function bytes(string $v): int
{
    $n = (int) $v;
    return match (strtolower(substr(trim($v), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
}

echo "TOMLIN OS server check (PHP " . PHP_VERSION . ")\n";
echo "This checks the PHP the Terminal runs. The website's PHP is set in the same place on most hosts (cPanel > Select PHP\nVersion), but can differ: if the site still fails after all is OK here, check its settings there.\n";
line(PHP_VERSION_ID >= 80200, 'PHP 8.2 or newer', 'In cPanel > Select PHP Version, choose 8.2 or newer.');
// The first release in each branch that fixes two critical bugs in PHP itself (CVE-2026-109618 and CVE-2026-109619: a
// crafted request can run code on the server). A newer branch than these already has the fixes.
$patched = ['8.2' => '8.2.35', '8.3' => '8.3.36', '8.4' => '8.4.27', '8.5' => '8.5.12'][PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION] ?? null;
if (PHP_VERSION_ID >= 80200) {
    line($patched === null || version_compare(PHP_VERSION, $patched, '>='), 'PHP has the latest security fixes' . ($patched ? " ($patched or newer)" : ''), "This PHP misses two critical security fixes. Ask your host to update PHP " . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . " to $patched or newer (the host installs these; cPanel > Select PHP Version shows the version in use).");
}
foreach (['json', 'hash'] as $ext) {
    line(extension_loaded($ext), "PHP extension: $ext", "Tick \"$ext\" in cPanel > Select PHP Version > Extensions.");
}
line(defined('PASSWORD_ARGON2ID'), 'Argon2id password hashing', 'Passwords still work (bcrypt is used instead), but ask the host for PHP built with Argon2 for stronger hashing.');
line(function_exists('random_bytes'), 'Secure random numbers');
// Mail and the Reader's library connect to other servers; both need secure connections, and Mail folder names need mbstring.
line(extension_loaded('openssl'), 'PHP extension: openssl (Mail, Reader books, Claude)', 'Tick "openssl" in cPanel > Select PHP Version > Extensions. Without it Mail and Reader books cannot connect; the rest of the desktop works.');
line(extension_loaded('curl'), 'PHP extension: curl (your own Claude or OpenRouter key; saving AI models to this TOMLIN OS)', 'Tick "curl" in cPanel > Select PHP Version > Extensions. Without it Claude answers can arrive all at once at the end instead of as they are written, and the owner cannot save AI models here (browsers then fetch them from Hugging Face).');
line(is_file(dirname(__DIR__) . '/vendor/autoload.php'), 'Claude library present (tomlinos/vendor)', 'Extract the whole TOMLIN OS zip again: tomlinos/vendor/ is missing.');
line(extension_loaded('mbstring'), 'PHP extension: mbstring (Mail folder names in other languages)', 'Tick "mbstring" in cPanel > Select PHP Version > Extensions. Without it, folder names with accents may look odd in Mail.');
// System update and the app store check signatures (sodium) and open zips (zip).
line(extension_loaded('sodium'), 'PHP extension: sodium (System update and the app store check signatures)', 'Tick "sodium" in cPanel > Select PHP Version > Extensions. Without it, update by unzipping a new release in cPanel, and no store apps can be downloaded.');
line(extension_loaded('zip'), 'PHP extension: zip (System update and the app store open zips)', 'Tick "zip" in cPanel > Select PHP Version > Extensions. Without it, update by unzipping a new release in cPanel, and no store apps can be downloaded.');
$memory = (string) ini_get('memory_limit');
line($memory === '-1' || bytes($memory) >= 128 << 20, "memory_limit is $memory (128M or more recommended)", 'Raise memory_limit in cPanel > Select PHP Version > Options: big saves and System update need room.');

$post = bytes((string) ini_get('post_max_size'));
$upload = bytes((string) ini_get('upload_max_filesize'));
line($post >= 64 << 20, 'post_max_size is ' . ini_get('post_max_size') . ' (64M or more recommended)', 'Raise post_max_size in cPanel > Select PHP Version > Options (uploads bigger than this fail).');
line($upload >= 64 << 20, 'upload_max_filesize is ' . ini_get('upload_max_filesize'), 'Raise upload_max_filesize to match post_max_size.');

$root = dirname(__DIR__);
$config = require (is_file("$root/config.php") ? "$root/config.php" : "$root/config.example.php");
$data = rtrim((string) $config['data_dir'], '/\\');
line(is_dir($data) || @mkdir($data, 0700, true), "Data folder exists: $data", 'Create it, or fix data_dir in tomlinos/config.php.');
line(is_writable($data), 'Data folder is writable', 'Give the folder write permission for your cPanel user (755 or 700).');
$web = realpath("$root/../public_html");
$real = realpath($data);
line($web === false || $real === false || !str_starts_with($real . DIRECTORY_SEPARATOR, $web . DIRECTORY_SEPARATOR), 'Data folder is outside public_html', 'Move data_dir outside public_html: files there could be downloaded directly.');
// The AI models: in tomlinos/models unless config says otherwise; anywhere inside public_html they would be open to all.
$models = realpath(rtrim((string) ($config['models_dir'] ?? ''), '/\\') ?: "$root/models");
line($web === false || $models === false || !str_starts_with($models . DIRECTORY_SEPARATOR, $web . DIRECTORY_SEPARATOR), 'AI models folder is outside public_html', 'Set models_dir in tomlinos/config.php to a folder outside public_html (or leave it empty for tomlinos/models).');
line($web === false || !is_dir("$web/models"), 'No AI model files left in public_html/models', 'Move public_html/models into tomlinos/ (or delete it): anyone can download files there without signing in.');
// System update writes both folders (and keeps its backup in tomlinos/update/).
line($web === false || (is_writable($web) && is_writable($root)), 'PHP may write to public_html and tomlinos (System update)', 'Give both folders write permission for your cPanel user, or update by unzipping a new release in cPanel.');
line(!empty($config['allow_remote']), 'allow_remote is on (the desktop answers visitors)', 'Leave it off until the security pass is done; then set it in tomlinos/config.php, HTTPS only.');

echo $ok ? "\nAll good.\n" : "\nFix the lines marked FIX, then run this again.\n";
exit($ok ? 0 : 1);
