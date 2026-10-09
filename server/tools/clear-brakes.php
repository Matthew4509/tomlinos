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
auth_throttle_clear($dataDir, $name);
echo "The brakes on \"$name\" are lifted, from every address. Sign in again now.\n";
