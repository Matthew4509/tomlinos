<?php
// The owner's way back in when the password is forgotten (there is no emailed reset yet). Run it on the server itself,
// from a terminal (cPanel Terminal or SSH), never through the web:
//   php server/tools/reset-password.php <user name> [--two-step-off]
// It prints a new random password, signs that person out everywhere, and with --two-step-off also turns off two-step
// sign-in (for a lost phone with no recovery codes left). Their files are not touched.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';

$name = strtolower(trim((string) ($argv[1] ?? '')));
$twoStepOff = in_array('--two-step-off', $argv, true);
if ($name === '' || str_starts_with($name, '--')) {
    fwrite(STDERR, "Usage: php server/tools/reset-password.php <user name> [--two-step-off]\n");
    exit(2);
}
$dataDir = rtrim((string) api_config()['data_dir'], '/\\');
$user = auth_find_user(auth_users($dataDir), $name);
if ($user === null) {
    fwrite(STDERR, "There is nobody called \"$name\" on this desktop (data folder: $dataDir).\n");
    exit(1);
}
$words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbour', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nutmeg', 'orchard', 'pebble', 'quartz', 'river', 'saffron', 'timber', 'umber', 'velvet', 'willow', 'yarrow', 'zephyr'];
$password = implode('-', array_map(static fn () => $words[random_int(0, count($words) - 1)], range(1, 4))) . '-' . random_int(10, 99);
auth_locked($dataDir, static function () use ($dataDir, $user, $password, $twoStepOff): void {
    $users = auth_users($dataDir);
    $users[$user['id']]['hash'] = auth_hash_password($password);
    if (($users[$user['id']]['vault']['state'] ?? 'off') !== 'off') {
        // Encrypted files: the new password cannot open them; the recovery key re-opens them at the next sign-in.
        $users[$user['id']]['vault']['stale'] = true;
    }
    if ($twoStepOff) {
        $users[$user['id']]['totp'] = null;
        $users[$user['id']]['recovery'] = [];
    }
    auth_save_users($dataDir, $users);
});
$ended = auth_sessions_end_all($dataDir, $user['id']);
$_SERVER['REMOTE_ADDR'] = 'server terminal';
auth_history_add($dataDir, $user['id'], 'Password reset on the server' . ($twoStepOff ? ', two-step sign-in turned off' : ''));
echo "New password for {$user['name']}: $password\n";
echo "Signed out of $ended session(s)." . ($twoStepOff ? ' Two-step sign-in is off.' : '') . " Change the password in My account after signing in.\n";
if (($user['vault']['state'] ?? 'off') !== 'off') {
    echo "Their files are encrypted: when they sign in they will be asked for their recovery key once, to open them.\n";
}
