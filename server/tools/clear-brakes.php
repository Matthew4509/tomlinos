<?php
// Lifts the sign-in brakes when you have held yourself out. Run it on the server itself, from a terminal (cPanel
// Terminal or SSH), never through the web:
//   php tomlinos/tools/clear-brakes.php            every brake, for every name and address
//   php tomlinos/tools/clear-brakes.php <name>     only that user name's brakes
// Passwords and files are not touched. (The same can be done in cPanel File Manager by deleting
// tomlinos/data/accounts/throttle.json.)
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';

$name = strtolower(trim((string) ($argv[1] ?? '')));
$dataDir = rtrim((string) api_config()['data_dir'], '/\\');
if ($name === '') {
    auth_locked($dataDir, static function () use ($dataDir): void {
        @unlink(auth_dir($dataDir) . '/throttle.json');
    });
    echo "Every sign-in brake is lifted.\n";
    exit(0);
}
if (auth_find_user(auth_users($dataDir), $name) === null) {
    fwrite(STDERR, "There is nobody called \"$name\" on this desktop (data folder: $dataDir).\n");
    exit(1);
}
// The name's own counts, and the address brake of every address its wrong tries came from (else 20 wrong tries in a
// quarter of an hour would still hold that address, or ask it for the picture).
auth_locked($dataDir, static function () use ($dataDir, $name): void {
    $path = auth_dir($dataDir) . '/throttle.json';
    $t = auth_read_json($path, []);
    foreach (array_keys($t['name'] ?? []) as $k) {
        if (str_starts_with((string) $k, $name . '|')) {
            unset($t['ip'][substr((string) $k, strlen($name) + 1)], $t['name'][$k]);
        }
    }
    auth_write_json($path, $t);
});
echo "The brakes on \"$name\" are lifted, from every address. Sign in again now.\n";
