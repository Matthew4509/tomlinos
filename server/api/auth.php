<?php
// The desktop's accounts API. One address, the operation in ?op=. Reads are GET, changes are POST with a JSON body.
//   status                        who is signed in (or that nobody is set up yet)
//   setup  login  code  logout    the first owner; password; two-step code or recovery code; signing out
//   lock  unlock                  the screen lock, held here so a reload cannot skip it
//   password  pin  totp-begin  totp-enable  totp-disable  recovery-new    the account manager
//   sessions  revoke  history     signed-in devices and sign-in history
//   users  user-create  user-password  user-disable  user-2fa-off        the owner's list of people
//   recovery-key  vault  vault-rewrap  vault-abandon  recover-start  recover-finish   recovery key, encryption, forgotten password
//   captcha  unlock-mail  unlock-link  unlock-email   the picture check; the emailed unlock link, and its address
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/captcha.php';
require __DIR__ . '/../lib/store.php';

api_headers();
api_guard();

$config = api_config();
$dataDir = rtrim((string) $config['data_dir'], '/\\');
$op = (string) ($_GET['op'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$reads = ['status', 'sessions', 'history', 'users', 'captcha'];
if (in_array($op, $reads, true) ? $method !== 'GET' : $method !== 'POST') {
    api_fail(405, 'That is not how this address is used.');
}

/** "12 seconds", "5 minutes", "3 hours": how long a brake has left. */
function wait_words(int $wait): string
{
    return $wait >= 5400 ? ceil($wait / 3600) . ' hours' : ($wait >= 90 ? ceil($wait / 60) . ' minutes' : $wait . ' seconds');
}

/** Uses one try of this name's unlock link (the token from the emailed link). False when it is not a live link for it. */
function auth_link_use(string $dataDir, string $name, string $token): bool
{
    if (!preg_match('/^[A-Za-z0-9_-]{43}$/D', $token)) {
        return false;
    }
    $user = auth_find_user(auth_users($dataDir), $name);
    $link = $user['unlock'] ?? null;
    if (!$user || !is_array($link) || ($link['until'] ?? 0) <= time() || ($link['tries'] ?? 0) < 1 || !hash_equals((string) $link['hash'], hash('sha256', $token))) {
        return false;
    }
    // Checked again and used under the lock, so sign-ins sent at the same moment cannot share the last try.
    $taken = false;
    update_user($dataDir, $user['id'], static function (array $u) use ($token, &$taken): array {
        $link = $u['unlock'] ?? null;
        if (is_array($link) && ($link['until'] ?? 0) > time() && ($link['tries'] ?? 0) >= 1 && hash_equals((string) ($link['hash'] ?? ''), hash('sha256', $token))) {
            $u['unlock']['tries'] = (int) $link['tries'] - 1;
            $taken = true;
        }

        return $u;
    });

    return $taken;
}

/** After a sign-in that got all the way in: the unlock email may be sent again, and an old link stops working. */
function auth_link_reset(string $dataDir, array $user): void
{
    if (!empty($user['unlockSent']) || !empty($user['unlock'])) {
        update_user($dataDir, $user['id'], static function (array $u): array {
            unset($u['unlockSent'], $u['unlock']);

            return $u;
        });
    }
}

/** Checks the password (and the two-step code, when it is on) before a change to the account. */
function confirm_identity(string $dataDir, array $user, array $body): void
{
    // The same brake as signing in: someone at an unlocked, unattended desktop cannot try passwords at full speed.
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $wait = auth_throttle_take($dataDir, $ip, $user['name']);
    if ($wait > 0) {
        api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again.', $wait >= 90 ? ceil($wait / 60) . ' minutes' : $wait . ' seconds'), ['wait' => $wait]);
    }
    if (!password_verify(body_str($body, 'password'), $user['hash'])) {
        api_fail(403, 'That password is not right, so nothing was changed. Type your current password.');
    }
    if (!empty($user['totp']['enabled'])) {
        $step = auth_totp_check($user['totp']['secret'], body_str($body, 'code'), (int) ($user['totp']['last'] ?? 0));
        if ($step === null || !auth_totp_use($dataDir, $user['id'], $step)) {
            api_fail(403, 'That two-step code is not right (or was already used), so nothing was changed. Type the code your authenticator shows now.');
        }
    }
    auth_throttle_clear($dataDir, $user['name']);
    auth_throttle_refund($dataDir, $ip);
}

/** Changes one person's record under the lock. $fn gets the record and returns it changed. */
function update_user(string $dataDir, string $id, callable $fn): array
{
    return auth_locked($dataDir, static function () use ($dataDir, $id, $fn): array {
        $users = auth_users($dataDir);
        if (!isset($users[$id])) {
            api_fail(404, 'That person is not on this desktop any more.');
        }
        $users[$id] = $fn($users[$id]);
        auth_save_users($dataDir, $users);

        return $users[$id];
    });
}

function signed_in_answer(array $user, array $session): array
{
    global $dataDir;

    return ['signedIn' => true, 'locked' => !empty($session['locked']), 'user' => auth_public_user($user), 'vaultKeys' => auth_vault_for_owner($user), 'front' => auth_front($dataDir)];
}

$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$days = (int) ($config['session_days'] ?? 30);

try {
    switch ($op) {
        case 'status': {
            if (!auth_users($dataDir)) {
                if (!auth_is_local()) {
                    auth_setup_code($dataDir); // made now, so it is there to be read before the form is sent
                }
                api_json(['setup' => true, 'setupCode' => !auth_is_local(), 'signedIn' => false]);
            }
            $current = current_session($dataDir);
            if ($current === null) {
                api_json(['signedIn' => false, 'front' => auth_front($dataDir)]);
            }
            [, $session, $user] = $current;
            if ($session['stage'] !== 'full') {
                api_json($session['stage'] === '2fa' ? ['signedIn' => false, 'stage' => '2fa', 'front' => auth_front($dataDir)] : ['signedIn' => false, 'front' => auth_front($dataDir)]);
            }
            api_json(signed_in_answer($user, $session));
        }

        case 'setup': {
            $body = api_body();
            $name = strtolower(trim(body_str($body, 'name')));
            $display = trim(body_str($body, 'display'));
            $password = body_str($body, 'password');
            if ($problem = auth_name_problem($name)) {
                api_fail(400, $problem);
            }
            if ($problem = auth_password_problem($password, $name)) {
                api_fail(400, $problem);
            }
            if (!auth_is_local()) {
                $wait = auth_throttle_take($dataDir, $ip, 'setup');
                if ($wait > 0) {
                    api_fail(429, sprintf('Too many wrong set-up codes. Wait %d minutes, then try again.', (int) ceil($wait / 60)), ['wait' => $wait]);
                }
                if (!auth_users($dataDir) && !hash_equals(auth_setup_code($dataDir), strtolower(trim(body_str($body, 'setupCode'))))) {
                    api_fail(403, 'That set-up code is not right. It is in the file tomlinos/data/accounts/SETUP-CODE.txt on your server (open it with cPanel File Manager), and looks like abcd-efgh-ijkl.');
                }
            }
            $user = auth_locked($dataDir, static function () use ($dataDir, $name, $display, $password): array {
                $users = auth_users($dataDir);
                if ($users) {
                    api_fail(409, 'This desktop already has an owner. Sign in instead.');
                }
                $id = auth_new_user_id();
                $user = ['id' => $id, 'name' => $name, 'display' => auth_cut($display !== '' ? $display : $name, 60), 'hash' => auth_hash_password($password), 'admin' => true, 'created' => time(), 'totp' => null, 'recovery' => [], 'pin' => null];
                $users[$id] = $user;
                auth_save_users($dataDir, $users);

                return $user;
            });
            @unlink(auth_dir($dataDir) . '/SETUP-CODE.txt');
            auth_throttle_clear($dataDir, 'setup');
            auth_throttle_refund($dataDir, $ip);
            $moved = auth_adopt_old_store($dataDir, $user['id']);
            $token = auth_session_create($dataDir, $user['id'], 'full');
            set_session_cookie($token, $days);
            auth_history_add($dataDir, $user['id'], 'Account created (owner)');
            api_json(['signedIn' => true, 'locked' => false, 'user' => auth_public_user($user), 'adopted' => $moved]);
        }

        case 'login': {
            $body = api_body();
            $name = strtolower(trim(body_str($body, 'name')));
            $password = body_str($body, 'password');
            // A try from an emailed unlock link skips the hold and the picture (the link proves the account's email).
            $linked = auth_link_use($dataDir, $name, body_str($body, 'unlock'));
            if (!$linked) {
                $held = auth_throttle_wait($dataDir, $ip, $name);
                if ($held > 0) {
                    api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again, or use "Email me an unlock link".', wait_words($held)), ['wait' => $held, 'held' => true]);
                }
                // After a wrong try, the picture check comes first (it is used up either way).
                if (auth_captcha_needed($dataDir, $ip, $name)) {
                    $given = body_str($body, 'captchaId');
                    if ($given === '' || !captcha_check($dataDir, $given, body_str($body, 'captcha'))) {
                        api_fail(428, $given === '' ? 'Type the numbers in the picture too, then try again.' : 'Those are not the numbers in the picture. Here is a new one.', ['captcha' => true]);
                    }
                }
                // Checked and charged in one step (a right password gives the try back), so parallel guesses cannot slip past.
                $wait = auth_throttle_take($dataDir, $ip, $name, $charged);
                if ($wait > 0) {
                    api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again, or use "Email me an unlock link".', wait_words($wait)), ['wait' => $wait, 'held' => true]);
                }
            }
            $user = auth_find_user(auth_users($dataDir), $name);
            // The same slow check runs for a name that does not exist, so the time taken does not tell which half was wrong.
            $ok = $user ? password_verify($password, $user['hash']) : (auth_hash_password($password) === '');
            if (!$user || !$ok) {
                if ($linked) {
                    // Not charged above: counted now.
                    auth_throttle_fail($dataDir, $ip, $name);
                }
                if ($user) {
                    auth_history_add($dataDir, $user['id'], $linked ? 'Wrong password (unlock link)' : 'Wrong password');
                }
                api_fail(401, 'That user name and password do not match. Check both and try again.');
            }
            if (!empty($user['disabled'])) {
                api_fail(403, 'This account is switched off. Ask the owner of this desktop to switch it back on.');
            }
            $two = !empty($user['totp']['enabled']);
            // Only a try that was charged is given back: a sign-in by unlock link was never charged, and refunding it
            // would take a real wrong try off this address's count.
            if (!$linked) {
                auth_throttle_refund($dataDir, $ip, $charged);
            }
            // With two-step on, the name's count is only cleared once the code is right too: a known password must not
            // reset the brake on guessing codes. An unlock link proves the account's email as well, so its hold ends
            // (or the two-step code that follows would be refused by the very hold the link was sent to lift).
            if (!$two || $linked) {
                auth_throttle_clear($dataDir, $name);
            }
            if (password_needs_rehash($user['hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
                update_user($dataDir, $user['id'], static fn (array $u): array => ['hash' => auth_hash_password($password)] + $u);
            }
            $token = auth_session_create($dataDir, $user['id'], $two ? '2fa' : 'full');
            set_session_cookie($token, $days);
            auth_sessions_of($dataDir, ''); // sweeps expired session files, so the folder stays small
            if ($two) {
                api_json(['signedIn' => false, 'stage' => '2fa']);
            }
            auth_history_add($dataDir, $user['id'], $linked ? 'Signed in (unlock link)' : 'Signed in');
            auth_link_reset($dataDir, $user);
            api_json(signed_in_answer($user, ['locked' => false]));
        }

        case 'code': {
            $body = api_body();
            $current = current_session($dataDir);
            if ($current === null || $current[1]['stage'] !== '2fa') {
                api_fail(401, 'The sign-in ran out before the code arrived. Sign in again.', ['auth' => 'signin']);
            }
            [$token, $session, $user] = $current;
            // Two-step was turned off (on another device) while this sign-in waited for its code: start again.
            if (empty($user['totp']['enabled']) || !isset($user['totp']['secret'])) {
                auth_session_end($dataDir, $token);
                set_session_cookie('', $days);
                api_fail(401, 'Two-step sign-in was turned off for this account while you were signing in. Sign in again with your password.', ['auth' => 'signin']);
            }
            // The name held by the brakes (wrong codes count as wrong tries): no code is even looked at until the hold ends.
            $held = auth_throttle_wait($dataDir, $ip, (string) $user['name']);
            if ($held > 0) {
                api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again, or use "Email me an unlock link".', wait_words($held)), ['wait' => $held, 'held' => true]);
            }
            // One try is used up BEFORE the code is checked, under the lock, so parallel guesses each take one.
            $used = auth_session_take_try($dataDir, $token);
            if ($used === null || $used > AUTH_CODE_TRIES) {
                auth_session_end($dataDir, $token);
                set_session_cookie('', $days);
                api_fail(401, 'Too many codes were tried, so the sign-in was stopped. Sign in again with your password.', ['auth' => 'signin']);
            }
            $session['fails'] = $used;
            $code = strtolower(trim(body_str($body, 'code')));
            $step = auth_totp_check($user['totp']['secret'], $code, (int) ($user['totp']['last'] ?? 0));
            $how = 'Signed in (two-step code)';
            if ($step !== null && auth_totp_use($dataDir, $user['id'], $step)) {
                // Right, and not used before.
            } else {
                $hashed = hash_hmac('sha256', auth_recovery_form($code), auth_pepper($dataDir));
                $left = null;
                update_user($dataDir, $user['id'], static function (array $u) use ($hashed, &$left): array {
                    $at = array_search($hashed, $u['recovery'] ?? [], true);
                    if ($at !== false) {
                        array_splice($u['recovery'], (int) $at, 1);
                        $left = count($u['recovery']);
                    }

                    return $u;
                });
                if ($left === null) {
                    auth_throttle_fail($dataDir, $ip, $user['name']);
                    if ($session['fails'] >= AUTH_CODE_TRIES) {
                        auth_session_end($dataDir, $token);
                        set_session_cookie('', $days);
                        auth_history_add($dataDir, $user['id'], 'Sign-in stopped after ' . AUTH_CODE_TRIES . ' wrong codes');
                        api_fail(401, 'That was the ' . AUTH_CODE_TRIES . 'th wrong code, so the sign-in was stopped. Sign in again with your password.', ['auth' => 'signin']);
                    }
                    api_fail(401, sprintf('That code is not right. Type the 6 numbers your authenticator shows now, or one of your recovery codes. %d tries left.', AUTH_CODE_TRIES - $session['fails']), ['triesLeft' => AUTH_CODE_TRIES - $session['fails']]);
                }
                $how = "Signed in (recovery code; $left left)";
            }
            $session = auth_session_update($dataDir, $token, static fn (array $s): array => ['stage' => 'full', 'fails' => 0] + $s) ?? $session;
            auth_throttle_clear($dataDir, $user['name']);
            auth_link_reset($dataDir, $user);
            auth_history_add($dataDir, $user['id'], $how);
            api_json(signed_in_answer(auth_users($dataDir)[$user['id']], $session));
        }

        case 'logout': {
            $token = (string) ($_COOKIE[cookie_name()] ?? '');
            $current = current_session($dataDir);
            if ($current) {
                auth_history_add($dataDir, $current[2]['id'], 'Signed out');
            }
            if ($token !== '') {
                auth_session_end($dataDir, $token);
            }
            set_session_cookie('', $days);
            api_json(['signedIn' => false]);
        }

        case 'lock': {
            $current = current_session($dataDir);
            if ($current === null || $current[1]['stage'] !== 'full') {
                api_fail(401, 'You are signed out. Sign in again to carry on.', ['auth' => 'signin']);
            }
            [$token, $session, $user] = $current;
            // Locking an already locked screen keeps its count of wrong tries, or re-locking would allow endless PIN guesses.
            $session = auth_session_update($dataDir, $token, static fn (array $s): array => empty($s['locked']) ? ['locked' => true, 'fails' => 0] + $s : $s) ?? ['locked' => true] + $session;
            api_json(signed_in_answer($user, $session));
        }

        case 'unlock': {
            $body = api_body();
            $current = current_session($dataDir);
            if ($current === null || $current[1]['stage'] !== 'full') {
                api_fail(401, 'You are signed out. Sign in again to carry on.', ['auth' => 'signin']);
            }
            [$token, $session, $user] = $current;
            if (empty($session['locked'])) {
                api_json(signed_in_answer($user, $session));
            }
            // One guess is used up BEFORE it is checked, under the lock: a burst of parallel PIN guesses (4 numbers is only
            // 10,000) each takes one, so the sign-out after AUTH_UNLOCK_TRIES cannot be raced past.
            $used = auth_session_take_try($dataDir, $token);
            if ($used === null || $used > AUTH_UNLOCK_TRIES) {
                auth_session_end($dataDir, $token);
                set_session_cookie('', $days);
                api_fail(401, 'Too many unlock tries, so you have been signed out to keep the desktop safe. Sign in with your password.', ['auth' => 'signin', 'signedOut' => true]);
            }
            $pin = body_str($body, 'pin');
            if ($pin !== '') {
                $ok = !empty($user['pin']) && preg_match(AUTH_PIN_RE, $pin) && auth_check_pin($dataDir, $pin, $user['pin']);
            } else {
                $ok = password_verify(body_str($body, 'password'), $user['hash']);
                if ($ok && !empty($user['totp']['enabled'])) {
                    $step = auth_totp_check($user['totp']['secret'], body_str($body, 'code'), (int) ($user['totp']['last'] ?? 0));
                    $ok = $step !== null && auth_totp_use($dataDir, $user['id'], $step);
                }
            }
            if (!$ok) {
                $session['fails'] = $used;
                if ($session['fails'] >= AUTH_UNLOCK_TRIES) {
                    auth_session_end($dataDir, $token);
                    set_session_cookie('', $days);
                    auth_history_add($dataDir, $user['id'], 'Signed out after ' . AUTH_UNLOCK_TRIES . ' wrong unlock tries');
                    api_fail(401, 'That was the ' . AUTH_UNLOCK_TRIES . 'th wrong try, so you have been signed out to keep the desktop safe. Sign in with your password' . (!empty($user['totp']['enabled']) ? ' and two-step code.' : '.'), ['auth' => 'signin', 'signedOut' => true]);
                }
                $left = AUTH_UNLOCK_TRIES - $session['fails'];
                api_fail(403, ($pin !== '' ? 'That PIN is not right.' : 'That password' . (!empty($user['totp']['enabled']) ? ' or code' : '') . ' is not right.') . " $left " . ($left === 1 ? 'try' : 'tries') . ' left before you are signed out.', ['triesLeft' => $left]);
            }
            $session = auth_session_update($dataDir, $token, static fn (array $s): array => ['locked' => false, 'fails' => 0] + $s);
            if ($session === null) {
                api_fail(401, 'You are signed out. Sign in again to carry on.', ['auth' => 'signin']);
            }
            api_json(signed_in_answer($user, $session));
        }

        case 'password': {
            $body = api_body();
            [$token, , $user] = require_full($dataDir);
            confirm_identity($dataDir, $user, $body);
            $next = body_str($body, 'next');
            if ($problem = auth_password_problem($next, $user['name'])) {
                api_fail(400, $problem);
            }
            $keys = auth_vault_for_owner($user) ? auth_vault_keys($body) : null;
            update_user($dataDir, $user['id'], static function (array $u) use ($next, $keys): array {
                $u['hash'] = auth_hash_password($next);
                if ($keys) {
                    $u['vault'] = array_merge($u['vault'], $keys, ['stale' => false]);
                }

                return $u;
            });
            $ended = auth_sessions_end_all($dataDir, $user['id'], hash('sha256', $token));
            auth_history_add($dataDir, $user['id'], 'Password changed' . ($ended ? " (signed out of $ended other " . ($ended === 1 ? 'device)' : 'devices)') : ''));
            api_json(['ok' => true, 'endedOthers' => $ended]);
        }

        case 'pin': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            confirm_identity($dataDir, $user, $body);
            $pin = $body['pin'] ?? null;
            if ($pin !== null && (!is_string($pin) || !preg_match(AUTH_PIN_RE, $pin))) {
                api_fail(400, 'A PIN is exactly 4 numbers.');
            }
            $hash = $pin === null ? null : auth_hash_pin($dataDir, (string) $pin);
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($hash): array {
                $u['pin'] = $hash;

                return $u;
            });
            auth_history_add($dataDir, $user['id'], $hash ? 'Screen PIN set' : 'Screen PIN removed');
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }

        case 'totp-begin': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (!empty($user['totp']['enabled'])) {
                api_fail(409, 'Two-step sign-in is already on. Turn it off first to move it to another authenticator.');
            }
            confirm_identity($dataDir, $user, $body);
            $secret = auth_base32_encode(random_bytes(20));
            update_user($dataDir, $user['id'], static function (array $u) use ($secret): array {
                $u['totp'] = ['enabled' => false, 'secret' => $secret, 'last' => 0];

                return $u;
            });
            api_json(['secret' => $secret, 'uri' => auth_totp_uri($secret, $user['name'], (string) ($config['site_name'] ?? 'TOMLIN OS'))]);
        }

        case 'totp-enable': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (empty($user['totp']['secret']) || !empty($user['totp']['enabled'])) {
                api_fail(409, 'Start again from "Turn on two-step sign-in"; the setup was not waiting for a code.');
            }
            $step = auth_totp_check($user['totp']['secret'], body_str($body, 'code'), 0);
            if ($step === null) {
                api_fail(403, 'That code does not match. Check the authenticator is showing "' . ($config['site_name'] ?? 'TOMLIN OS') . '", then type the 6 numbers it shows now (they change every 30 seconds).');
            }
            [$plain, $stored] = auth_recovery_codes($dataDir);
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($step, $stored): array {
                $u['totp']['enabled'] = true;
                $u['totp']['last'] = $step;
                $u['recovery'] = $stored;

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'Two-step sign-in turned on');
            api_json(['ok' => true, 'recovery' => $plain, 'user' => auth_public_user($user)]);
        }

        case 'totp-disable': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (empty($user['totp']['enabled'])) {
                api_fail(409, 'Two-step sign-in is already off.');
            }
            confirm_identity($dataDir, $user, $body);
            $user = update_user($dataDir, $user['id'], static function (array $u): array {
                $u['totp'] = null;
                $u['recovery'] = [];

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'Two-step sign-in turned off');
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }

        case 'recovery-new': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (empty($user['totp']['enabled'])) {
                api_fail(409, 'Recovery codes come with two-step sign-in. Turn that on first.');
            }
            confirm_identity($dataDir, $user, $body);
            [$plain, $stored] = auth_recovery_codes($dataDir);
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($stored): array {
                $u['recovery'] = $stored;

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'New recovery codes made (the old ones stopped working)');
            api_json(['ok' => true, 'recovery' => $plain, 'user' => auth_public_user($user)]);
        }

        case 'recovery-key': {
            // A new recovery key (the old one stops working). With encryption on, the browser also re-wraps the file key with it.
            $body = api_body();
            [, , $user] = require_full($dataDir);
            confirm_identity($dataDir, $user, $body);
            $hash = auth_rkey_hash($dataDir, body_str($body, 'rkAuth'));
            $wrapRk = auth_vault_for_owner($user) ? auth_wrap_rk($body) : null;
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($hash, $wrapRk): array {
                $u['rkey'] = $hash;
                $u['rkeyMade'] = time();
                if ($wrapRk !== null) {
                    $u['vault']['wrapRk'] = $wrapRk;
                }

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'New recovery key made (the old one stopped working)');
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }

        case 'vault': {
            // Encryption on or off. Either way starts a move ("migrating-..."): the browser rewrites every record, then says
            // it has finished. Starting a move asks for the password (and code); finishing one does not.
            $body = api_body();
            [, , $user] = require_full($dataDir);
            $from = (string) ($user['vault']['state'] ?? 'off');
            $to = body_str($body, 'state');
            if (!in_array($to, AUTH_VAULT_STATES, true)) {
                api_fail(400, 'That is not an encryption state.');
            }
            $allowed = ['off' => ['migrating-on'], 'migrating-on' => ['on', 'migrating-off'], 'on' => ['migrating-off'], 'migrating-off' => ['off', 'migrating-on']];
            if (!in_array($to, $allowed[$from], true)) {
                api_fail(409, "Encryption is \"$from\" here, so it cannot go to \"$to\". Reload My account and try again.");
            }
            if ($to === 'migrating-on' || $to === 'migrating-off') {
                confirm_identity($dataDir, $user, $body);
            }
            $vault = $user['vault'] ?? null;
            $rkey = null;
            if ($from === 'off') {
                $vault = auth_vault_keys($body) + ['wrapRk' => auth_wrap_rk($body), 'stale' => false];
                $rkey = auth_rkey_hash($dataDir, body_str($body, 'rkAuth'));
            }
            // Under the store's lock: no save is part-way through while the state changes, so every later save is checked
            // against the new state (store.php). Finishing is refused while any file is still the old kind (one saved by
            // another page during the change), and the key is kept until then.
            $id = $user['id'];
            [$wrong, $user] = store_locked(auth_user_store($dataDir, $id), static function () use ($dataDir, $id, $to, $vault, $rkey): array {
                if ($to === 'on' || $to === 'off') {
                    $wrong = store_count_unconverted(auth_user_store($dataDir, $id), $to === 'on');
                    if ($wrong > 0) {
                        return [$wrong, null];
                    }
                }

                return [0, update_user($dataDir, $id, static function (array $u) use ($to, $vault, $rkey): array {
                    $u['vault'] = $to === 'off' ? null : ['state' => $to] + $vault;
                    if ($rkey !== null) {
                        $u['rkey'] = $rkey;
                        $u['rkeyMade'] = time();
                    }

                    return $u;
                })];
            });
            if ($user === null) {
                api_fail(409, sprintf('%s still %s (saved in another window or on another device while this ran). They are being converted again.', $wrong === 1 ? 'One file is' : "$wrong files are", $to === 'on' ? 'not encrypted' : 'encrypted'), ['redo' => $wrong]);
            }
            $words = ['migrating-on' => 'Encrypting files started', 'on' => 'Files encrypted', 'migrating-off' => 'Decrypting files started', 'off' => 'Files decrypted (encryption off)'];
            auth_history_add($dataDir, $user['id'], $words[$to]);
            api_json(['ok' => true, 'user' => auth_public_user($user), 'vaultKeys' => auth_vault_for_owner($user)]);
        }

        case 'vault-rewrap': {
            // After the owner (or the server tool) set a new password, the old wrap no longer opens: the person proves the
            // recovery key and sends the file key wrapped with the password they now have.
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (!auth_vault_for_owner($user)) {
                api_fail(409, 'Your files are not encrypted, so there is nothing to re-open.');
            }
            // The same brake as signing in, taken first: guesses from a signed-in session cannot run at full speed.
            $wait = auth_throttle_take($dataDir, $ip, $user['name']);
            if ($wait > 0) {
                api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again.', $wait >= 90 ? ceil($wait / 60) . ' minutes' : $wait . ' seconds'), ['wait' => $wait]);
            }
            $proof = body_str($body, 'rkAuth');
            if (empty($user['rkey']) || !preg_match('/^[0-9a-f]{64}$/', $proof) || !hash_equals($user['rkey'], auth_rkey_hash($dataDir, $proof))) {
                // Already charged by auth_throttle_take above: counting it again would double every wrong key.
                api_fail(403, 'That recovery key does not match. Check it letter by letter (dashes and capitals do not matter).');
            }
            // The right key proves the person, as a right password does: the try is given back and the name's count cleared,
            // so their next sign-in is not asked for the picture.
            auth_throttle_refund($dataDir, $ip);
            auth_throttle_clear($dataDir, $user['name']);
            $keys = auth_vault_keys($body);
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($keys): array {
                $u['vault'] = array_merge($u['vault'], $keys, ['stale' => false]);

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'Encrypted files re-opened with the recovery key');
            api_json(['ok' => true, 'user' => auth_public_user($user), 'vaultKeys' => auth_vault_for_owner($user)]);
        }

        case 'vault-abandon': {
            // No password and no recovery key: the encrypted files cannot be opened. They are MOVED aside (never deleted), and
            // the person starts again with empty files and encryption off.
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (!auth_vault_for_owner($user)) {
                api_fail(409, 'Your files are not encrypted.');
            }
            if (($body['confirm'] ?? '') !== 'start again') {
                api_fail(400, 'Type "start again" to confirm.');
            }
            confirm_identity($dataDir, $user, $body);
            // Files set aside earlier are kept (never deleted), so a cap stops this being a way round the space allowed.
            if (count(glob(auth_user_store($dataDir, $user['id']) . '/locked-*', GLOB_ONLYDIR) ?: []) >= 3) {
                api_fail(409, 'Three sets of locked files are already kept aside. Ask the owner to clear old ones from the server first.');
            }
            $store = auth_user_store($dataDir, $user['id']);
            $aside = $store . '/locked-' . date('Ymd-His');
            // Under the store's lock, so a save part-way through finishes before (and never lands half in) the files set aside.
            if (!store_locked($store, static fn (): bool => !is_dir($store . '/objects') || @rename($store . '/objects', $aside))) {
                api_fail(500, 'The encrypted files could not be moved aside, so nothing was changed. Try again.');
            }
            // Both totals describe the files just set aside: the empty store starts from nothing (worked out again).
            @unlink($store . '/.usage');
            @unlink($store . '/.count');
            $user = update_user($dataDir, $user['id'], static function (array $u): array {
                $u['vault'] = null;

                return $u;
            });
            auth_history_add($dataDir, $user['id'], 'Started again with empty files; the encrypted ones were kept aside on the server (' . basename($aside) . ')');
            api_json(['ok' => true, 'user' => auth_public_user($user), 'vaultKeys' => null]);
        }

        case 'recover-start': {
            // "Forgot your password?": user name + recovery key (+ two-step code when on). Braked like signing in, and the
            // same answer whichever part was wrong.
            $body = api_body();
            $name = strtolower(trim(body_str($body, 'name')));
            $wait = auth_throttle_take($dataDir, $ip, $name);
            if ($wait > 0) {
                api_fail(429, sprintf('Too many wrong tries. Wait %s, then try again.', $wait >= 90 ? ceil($wait / 60) . ' minutes' : $wait . ' seconds'), ['wait' => $wait]);
            }
            $user = auth_find_user(auth_users($dataDir), $name);
            $proof = body_str($body, 'rkAuth');
            $ok = $user && !empty($user['rkey']) && preg_match('/^[0-9a-f]{64}$/', $proof) && hash_equals($user['rkey'], auth_rkey_hash($dataDir, $proof));
            $step = null;
            $usedCode = null;
            if ($ok && !empty($user['totp']['enabled'])) {
                $code = strtolower(trim(body_str($body, 'code')));
                $step = auth_totp_check($user['totp']['secret'], $code, (int) ($user['totp']['last'] ?? 0));
                if ($step === null) {
                    $hashed = hash_hmac('sha256', auth_recovery_form($code), auth_pepper($dataDir));
                    $usedCode = in_array($hashed, $user['recovery'] ?? [], true) ? $hashed : null;
                    $ok = $usedCode !== null;
                }
            }
            if (!$ok) {
                if ($user) {
                    auth_history_add($dataDir, $user['id'], 'Wrong recovery key or code at "Forgot your password?"');
                }
                api_fail(401, 'Those do not match. Check the user name and the recovery key (and, if you use two-step sign-in, the code). If you have lost the recovery key, ask the owner of this desktop to set you a new password.');
            }
            if (!empty($user['disabled'])) {
                api_fail(403, 'This account is switched off. Ask the owner of this desktop to switch it back on.');
            }
            auth_throttle_clear($dataDir, $name);
            update_user($dataDir, $user['id'], static function (array $u) use ($step, $usedCode): array {
                if ($step !== null) {
                    $u['totp']['last'] = $step;
                }
                if ($usedCode !== null) {
                    $u['recovery'] = array_values(array_filter($u['recovery'], static fn ($c) => $c !== $usedCode));
                }

                return $u;
            });
            $token = auth_session_create($dataDir, $user['id'], 'reset');
            set_session_cookie($token, $days);
            api_json(['ok' => true, 'vaultKeys' => auth_vault_for_owner($user)]);
        }

        case 'recover-finish': {
            $body = api_body();
            $token = (string) ($_COOKIE[cookie_name()] ?? '');
            $session = $token === '' ? null : auth_session_load($dataDir, $token);
            if ($session === null || $session['stage'] !== 'reset') {
                api_fail(401, 'The reset ran out (it lasts 10 minutes). Start "Forgot your password?" again.', ['auth' => 'signin']);
            }
            $user = auth_users($dataDir)[$session['user']] ?? null;
            if ($user === null) {
                api_fail(401, 'That account is not here any more.', ['auth' => 'signin']);
            }
            $next = body_str($body, 'password');
            if ($problem = auth_password_problem($next, $user['name'])) {
                api_fail(400, $problem);
            }
            $keys = auth_vault_for_owner($user) ? auth_vault_keys($body) : null;
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($next, $keys): array {
                $u['hash'] = auth_hash_password($next);
                if ($keys) {
                    $u['vault'] = array_merge($u['vault'], $keys, ['stale' => false]);
                }

                return $u;
            });
            $ended = auth_sessions_end_all($dataDir, $user['id'], hash('sha256', $token));
            $session['stage'] = 'full';
            $session['fails'] = 0;
            auth_session_save($dataDir, $token, $session);
            auth_history_add($dataDir, $user['id'], 'Password reset with the recovery key' . ($ended ? " (signed out of $ended other " . ($ended === 1 ? 'device)' : 'devices)') : ''));
            api_json(signed_in_answer($user, $session));
        }

        case 'sessions': {
            [$token, , $user] = require_full($dataDir);
            $mine = hash('sha256', $token);
            $list = [];
            foreach (auth_sessions_of($dataDir, $user['id']) as $id => $s) {
                if (($s['stage'] ?? '') !== 'full') {
                    continue;
                }
                $list[] = ['id' => substr($id, 0, 12), 'current' => $id === $mine, 'created' => $s['created'], 'seen' => $s['seen'], 'ip' => $s['ip'], 'agent' => $s['agent'], 'locked' => !empty($s['locked'])];
            }
            usort($list, static fn ($a, $b) => $b['seen'] <=> $a['seen']);
            api_json(['sessions' => $list]);
        }

        case 'revoke': {
            $body = api_body();
            [$token, , $user] = require_full($dataDir);
            $mine = hash('sha256', $token);
            $which = body_str($body, 'id');
            if ($which === 'others') {
                $n = auth_sessions_end_all($dataDir, $user['id'], $mine);
            } else {
                $n = 0;
                foreach (array_keys(auth_sessions_of($dataDir, $user['id'])) as $id) {
                    if (strlen($which) === 12 && str_starts_with($id, $which) && $id !== $mine && @unlink(auth_dir($dataDir) . '/sessions/' . $id . '.json')) {
                        $n++;
                    }
                }
            }
            auth_history_add($dataDir, $user['id'], $n === 1 ? 'Signed out 1 other device' : "Signed out $n other devices");
            api_json(['ok' => true, 'ended' => $n]);
        }

        case 'history': {
            [, , $user] = require_full($dataDir);
            api_json(['history' => auth_history($dataDir, $user['id'])]);
        }

        case 'captcha': {
            api_json(captcha_new($dataDir, auth_throttle_ip($ip)));
        }

        case 'unlock-mail': {
            // "Email me an unlock link": sent only when this name is held from this address, the account has an unlock
            // email, and none was sent since its last sign-in (so a thousand guessers cannot flood the inbox). The
            // answer is the same whatever happened, so it tells nobody whether the name or the email exists.
            $body = api_body();
            $name = strtolower(trim(body_str($body, 'name')));
            $same = ['ok' => true, 'message' => 'If this account has an unlock email and is held, a link is on its way. One is sent until the next sign-in; it works for an hour and gives 3 tries.'];
            $user = auth_name_problem($name) === null ? auth_find_user(auth_users($dataDir), $name) : null;
            $to = (string) ($user['unlockEmail'] ?? '');
            if (!$user || $to === '' || !empty($user['unlockSent']) || !empty($user['disabled']) || auth_throttle_wait($dataDir, $ip, $name) === 0) {
                api_json($same);
            }
            $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
            update_user($dataDir, $user['id'], static function (array $u) use ($token): array {
                $u['unlock'] = ['hash' => hash('sha256', $token), 'until' => time() + AUTH_LINK_TTL, 'tries' => AUTH_LINK_TRIES];
                $u['unlockSent'] = time();

                return $u;
            });
            // The address the person used when they set the email, never the Host of this request (anyone can send any Host).
            $link = ($user['unlockBase'] ?? '') . '/#unlock=' . $token;
            auth_send_mail($to, 'Your unlock link', "Someone (you, we hope) was held after wrong passwords for the account \"{$user['name']}\".\n\nThis link gives 3 more tries, for one hour. It does not change the password:\n\n$link\n\nNot you? Do nothing: the brakes stay on, and no other link is sent until you next sign in.\n");
            auth_history_add($dataDir, $user['id'], 'Unlock link emailed');
            api_json($same);
        }

        case 'unlock-link': {
            $body = api_body();
            $token = body_str($body, 'token');
            if (preg_match('/^[A-Za-z0-9_-]{43}$/D', $token)) {
                $hash = hash('sha256', $token);
                foreach (auth_users($dataDir) as $u) {
                    $l = $u['unlock'] ?? null;
                    if (is_array($l) && hash_equals((string) $l['hash'], $hash) && ($l['until'] ?? 0) > time() && ($l['tries'] ?? 0) > 0) {
                        api_json(['ok' => true, 'name' => $u['name'], 'tries' => (int) $l['tries']]);
                    }
                }
            }
            api_fail(400, 'This unlock link has run out (it works for an hour, for 3 tries) or was already used.');
        }

        case 'unlock-email': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            confirm_identity($dataDir, $user, $body);
            $email = trim(body_str($body, 'email'));
            if ($email !== '' && (strlen($email) > 254 || preg_match('/[\r\n,;]/', $email) || !filter_var($email, FILTER_VALIDATE_EMAIL))) {
                api_fail(400, 'That does not look like an email address. Check it and try again.');
            }
            // Where the link in the email will point: this desktop's own address, as the signed-in person reached it.
            $base = (api_https() ? 'https://' : 'http://') . (string) ($_SERVER['HTTP_HOST'] ?? '');
            $user = update_user($dataDir, $user['id'], static function (array $u) use ($email, $base): array {
                if ($email === '') {
                    unset($u['unlockEmail'], $u['unlockBase']);
                } else {
                    $u['unlockEmail'] = $email;
                    $u['unlockBase'] = $base;
                }

                return $u;
            });
            auth_history_add($dataDir, $user['id'], $email === '' ? 'Unlock email removed' : 'Unlock email set');
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }

        case 'site-front': {
            $body = api_body();
            [, , $user] = require_full($dataDir);
            if (empty($user['admin'])) {
                api_fail(403, 'Only the owner of this desktop can choose what the site shows before sign-in.');
            }
            $front = body_str($body, 'front');
            if (!in_array($front, AUTH_FRONTS, true)) {
                api_fail(400, 'Choose the Reader or the sign-in page.');
            }
            auth_save_front($dataDir, $front);
            auth_history_add($dataDir, $user['id'], $front === 'reader' ? 'Front page set to the Reader' : 'Front page set to the sign-in');
            api_json(['ok' => true, 'front' => $front]);
        }

        case 'users': {
            [, , $user] = require_full($dataDir);
            require_admin($user);
            api_json(['users' => array_values(array_map('auth_public_user', auth_users($dataDir)))]);
        }

        case 'user-create': {
            // {name, display, next}: the new person's first password is 'next'; 'password' (and 'code') are the owner's.
            $body = api_body();
            [, , $me] = require_full($dataDir);
            require_admin($me);
            $name = strtolower(trim(body_str($body, 'name')));
            $password = body_str($body, 'next');
            if ($problem = auth_name_problem($name)) {
                api_fail(400, $problem);
            }
            if ($problem = auth_password_problem($password, $name)) {
                api_fail(400, $problem);
            }
            // Adding a person gives someone a way in: the owner's own password (and code) first, so someone at the
            // owner's unlocked, unattended desktop cannot do it.
            confirm_identity($dataDir, $me, $body);
            $display = trim(body_str($body, 'display'));
            $user = auth_locked($dataDir, static function () use ($dataDir, $name, $display, $password): array {
                $users = auth_users($dataDir);
                if (auth_find_user($users, $name)) {
                    api_fail(409, "There is already someone called \"$name\" here. Choose another user name.");
                }
                $max = (int) (api_config()['max_users'] ?? 10);
                if (count($users) >= $max) {
                    api_fail(409, "This desktop holds up to $max people (max_users in server/config.php).");
                }
                $id = auth_new_user_id();
                $users[$id] = ['id' => $id, 'name' => $name, 'display' => auth_cut($display !== '' ? $display : $name, 60), 'hash' => auth_hash_password($password), 'admin' => false, 'created' => time(), 'totp' => null, 'recovery' => [], 'pin' => null];
                auth_save_users($dataDir, $users);

                return $users[$id];
            });
            auth_history_add($dataDir, $user['id'], 'Account created by ' . $me['name']);
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }

        case 'user-password':
        case 'user-disable':
        case 'user-2fa-off': {
            $body = api_body();
            [, , $me] = require_full($dataDir);
            require_admin($me);
            $id = body_str($body, 'id');
            if ($id === $me['id']) {
                api_fail(400, 'Change your own account under My account, not here.');
            }
            // Setting someone's password or turning off their two-step opens their account, and switching an account off
            // or on decides who gets in: the owner's own password (and code) first, so someone at the owner's unlocked,
            // unattended desktop cannot do it.
            confirm_identity($dataDir, $me, $body);
            if ($op === 'user-password') {
                $target = auth_users($dataDir)[$id] ?? null;
                $password = body_str($body, 'next');
                if ($target && ($problem = auth_password_problem($password, $target['name']))) {
                    api_fail(400, $problem);
                }
                $user = update_user($dataDir, $id, static function (array $u) use ($password): array {
                    $u['hash'] = auth_hash_password($password);
                    if (($u['vault']['state'] ?? 'off') !== 'off') {
                        $u['vault']['stale'] = true;
                    }

                    return $u;
                });
                $event = 'Password set by ' . $me['name'] . (($user['vault']['state'] ?? 'off') !== 'off' ? ' (the recovery key is needed to open the encrypted files)' : '');
            } elseif ($op === 'user-disable') {
                $off = !empty($body['disabled']);
                $user = update_user($dataDir, $id, static fn (array $u): array => ['disabled' => $off] + $u);
                $event = ($off ? 'Account switched off by ' : 'Account switched on by ') . $me['name'];
            } else {
                $user = update_user($dataDir, $id, static function (array $u): array {
                    $u['totp'] = null;
                    $u['recovery'] = [];

                    return $u;
                });
                $event = 'Two-step sign-in turned off by ' . $me['name'];
            }
            $ended = auth_sessions_end_all($dataDir, $id);
            auth_history_add($dataDir, $id, $event . ($ended ? " (signed out of $ended " . ($ended === 1 ? 'device)' : 'devices)') : ''));
            api_json(['ok' => true, 'user' => auth_public_user($user)]);
        }
    }
    api_fail(404, 'The accounts service has no operation by that name.');
} catch (InvalidArgumentException $bad) {
    api_fail(400, 'The desktop sent a request the server could not read: ' . $bad->getMessage() . '.');
} catch (Throwable $error) {
    error_log('auth.php: ' . $error->getMessage());
    api_fail(500, 'The accounts service could not finish (the reason is in the server error log). Nothing was changed; try again.');
}
