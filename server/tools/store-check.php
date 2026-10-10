<?php
// Checks every person's files on the server against themselves, read-only. Run it on the server itself, from a terminal
// (cPanel Terminal or SSH), never through the web:
//   php tomlinos/tools/store-check.php            report only; nothing is changed
//   php tomlinos/tools/store-check.php --repair   also finish a save cut off part-way, write the totals again, and
//                                                 remove temporary files over an hour old (files are never deleted)
// Before restoring a backup of the data folder, and after one, this says whether the files hang together.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/store.php';

$repair = in_array('--repair', $argv, true);
$dataDir = rtrim((string) api_config()['data_dir'], '/\\');
$users = auth_users($dataDir);
$faults = 0;
foreach ($users as $id => $u) {
    $store = auth_user_store($dataDir, (string) $id);
    if (!is_dir($store)) {
        continue;
    }
    $r = store_check($store, $repair);
    $lines = [];
    if ($r['journal']) {
        $lines[] = $repair ? 'a save cut off part-way was finished' : 'a save cut off part-way is waiting to be finished (the next save or read finishes it, or run with --repair)';
    }
    foreach (['usage' => 'space used', 'count' => 'number of files'] as $k => $what) {
        // No total kept yet is not a fault: the store works it out from the files when it next needs it.
        [$kept, $actual] = $r[$k];
        if ($kept >= 0 && $kept !== $actual) {
            $lines[] = sprintf('the %s on record (%s) differs from the files (%s)%s', $what, number_format($kept), number_format($actual), $repair ? '; written again' : '');
        }
    }
    if ($r['temps']) {
        $lines[] = "{$r['temps']} temporary file(s) from saves cut off part-way" . ($repair ? ' (those over an hour old removed)' : '');
    }
    if ($r['damaged']) {
        $lines[] = count($r['damaged']) . ' damaged record(s): ' . implode(', ', array_slice($r['damaged'], 0, 5));
    }
    if ($r['missing']) {
        $lines[] = count($r['missing']) . ' folder entr(ies) whose file is missing: ' . implode(', ', array_slice($r['missing'], 0, 5));
    }
    if ($r['unreached']) {
        $lines[] = count($r['unreached']) . ' record(s) no folder reaches (kept; nothing is deleted)';
    }
    $faults += count($lines);
    $name = (string) ($u['name'] ?? $id);
    echo $name . ':' . ($lines ? implode("\n  ", array_merge([''], $lines)) : ' all in order') . ($r['encrypted'] ? "\n  (files encrypted: their folders can only be checked in the browser)" : '') . "\n";
}
exit($faults && !$repair ? 1 : 0);
