<?php
// The desktop's file store API. Two operations, for the signed-in person's own files only:
//   GET  store.php?key=<key>   one record: its blob as the body, its version in X-Store-Version; 404 if absent
//   POST store.php?op=commit   a batch of puts and deletes, applied all-or-nothing (see lib/store.php)
//   GET  store.php?op=keys     every key (for rewriting each record when encryption is turned on or off)
// Nobody signed in: 401. Screen locked: 423 (the lock is held by the server, so reloading the page does not open it).
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/store.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$dataDir = auth_user_store($root, $user['id']);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if ($method === 'GET' && ($_GET['op'] ?? '') === 'keys') {
        api_json(['keys' => store_reading($dataDir, static fn (): array => store_list_keys($dataDir))]);
    }
    if ($method === 'GET') {
        $key = (string) ($_GET['key'] ?? '');
        if (!store_valid_key($key)) {
            api_fail(400, 'That is not a file-store key.');
        }
        $record = store_reading($dataDir, static fn (): ?array => store_get($dataDir, $key));
        if ($record === null) {
            http_response_code(404);
            exit;
        }
        header('Content-Type: application/octet-stream');
        header('X-Store-Version: ' . $record[0]);
        header('Content-Length: ' . strlen($record[1]));
        echo $record[1];
        exit;
    }

    if ($method === 'POST' && ($_GET['op'] ?? '') === 'commit') {
        // The smaller of our own limit and PHP's: above post_max_size PHP throws the body away without a word, which
        // would otherwise reach the person as "could not read the request".
        // A config.php without the line (an older one, say) gets the example's 256 MB, not 0 (which refused every save).
        $max = min((int) ($config['max_commit_bytes'] ?? 256 * 1024 * 1024) ?: 256 * 1024 * 1024, store_ini_bytes((string) ini_get('post_max_size')) ?: PHP_INT_MAX);
        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length > $max) {
            api_fail(413, sprintf('That save is %.1f MB; this server takes up to %.1f MB at once. Split it into smaller files, or the owner can raise post_max_size in the host PHP settings (see tomlinos/tools/server-check.php).', $length / 1048576, $max / 1048576));
        }
        $quota = (int) ($config['quota_mb'] ?? 0) * 1048576;
        // Read at most one byte over the limit: a body sent in chunks has no Content-Length to check above.
        $raw = (string) file_get_contents('php://input', false, null, 0, $max + 1);
        if (strlen($raw) > $max) {
            api_fail(413, sprintf('That save is over %.1f MB, the most this server takes at once. Split it into smaller files.', $max / 1048576));
        }
        $ops = store_parse_commit($raw);
        unset($raw); // the body and its parsed copy must not both be held while writing (a 50 MB file would need 150 MB)
        // The page says whether it sealed what it sends (X-Store-Sealed). Checked under the store lock against the account's
        // encryption as it is now: a page left behind by a switch made elsewhere is refused, and while encryption is on (or
        // turning on) nothing plain is taken at all, so no file can be left readable on the server.
        $claim = $_SERVER['HTTP_X_STORE_SEALED'] ?? null;
        $userId = $user['id'];
        $check = static function (array $final) use ($root, $userId, $claim): void {
            $state = (string) (auth_users($root)[$userId]['vault']['state'] ?? 'off');
            $sealing = store_sealing($state);
            if ($claim !== null && ($claim === '1') !== $sealing) {
                throw new StoreVaultChanged();
            }
            if ($sealing) {
                foreach ($final as $o) {
                    if ($o['op'] === STORE_OP_PUT && !store_is_sealed($o['data'])) {
                        throw new StoreVaultChanged();
                    }
                }
            }
        };
        $versions = store_commit($dataDir, $ops, $quota, (int) ($config['max_files'] ?? 50000), $check);
        api_json(['versions' => (object) $versions]);
    }

    api_fail(405, 'The file store only reads records and commits changes.');
} catch (StoreConflict $conflict) {
    api_fail(409, 'Another window or device changed these files first.', ['keys' => $conflict->keys]);
} catch (StoreVaultChanged) {
    api_fail(409, 'Encryption of your files was switched on or off in another window or on another device, so this was not saved. This page is catching up now: save again in a moment.', ['vault' => true]);
} catch (StoreFileLimit $many) {
    api_fail(507, sprintf('You have %s files and folders, the most this desktop keeps for one person (%s). Empty the Recycle Bin or delete files you no longer need, then try again.', number_format($many->count), number_format($many->max)), ['quota' => true]);
} catch (StoreQuota $full) {
    api_fail(507, sprintf('Your storage is full: you are using %.0f MB of %.0f MB, and this needs %.1f MB more. Empty the Recycle Bin or delete files you no longer need, then try again.', $full->used / 1048576, $full->quota / 1048576, $full->adding / 1048576), ['quota' => true]);
} catch (InvalidArgumentException $bad) {
    api_fail(400, 'The desktop sent a request the store could not read: ' . $bad->getMessage() . '.');
} catch (Throwable $error) {
    error_log('store.php: ' . $error->getMessage());
    api_fail(500, 'The file store could not finish (the reason is in the server error log). Nothing was lost; try again.');
}
