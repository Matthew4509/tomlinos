<?php
// Puts back the TOMLIN OS version from before the last System update. For the cPanel Terminal, when an update broke the
// desktop so badly that the Application manager's Go back cannot be reached:   php tomlinos/tools/rollback-update.php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit("Run this from the cPanel Terminal, not the web.\n");
}
require __DIR__ . '/../lib/updater.php';
try {
    $v = update_rollback();
} catch (RuntimeException $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
echo $v === null ? "There is no earlier version kept to go back to.\n" : "Put back TOMLIN OS $v.\n";
