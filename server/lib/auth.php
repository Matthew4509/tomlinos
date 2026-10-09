<?php
// Accounts for the desktop: people, passwords, two-step codes (TOTP, RFC 6238), recovery codes, the 4-digit screen PIN,
// sessions, the lock, sign-in history, and the brakes on guessing. Everything lives in <data>/accounts/, OUTSIDE the
// web root, next to each person's own file store in <data>/users/<id>/.
//
// What is stored: password and PIN as slow hashes (Argon2id, else bcrypt), the PIN with a server-side pepper as well;
// recovery codes as SHA-256 of pepper + code; session cookies only as SHA-256 of the token (a copied accounts folder
// holds no live cookie). The two-step secret is stored as it is: the server has to compute the same codes.
declare(strict_types=1);

const AUTH_NAME_RE = '/^[a-z0-9][a-z0-9._-]{1,31}$/';
const AUTH_PIN_RE = '/^[0-9]{4}$/D';
const AUTH_TOTP_STEP = 30;
const AUTH_TOTP_DIGITS = 6;
const AUTH_RECOVERY_COUNT = 10;
const AUTH_UNLOCK_TRIES = 5;
const AUTH_CODE_TRIES = 5;
const AUTH_HISTORY_KEEP = 50;

/** Passwords people pick first. Refused, with a way out (the generator); nothing else about a password is refused. */
const AUTH_COMMON = [
    'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', '11111111',
    'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'welcome1', 'letmein1', 'abc12345', 'admin123', 'passw0rd',
    'trustno1', 'superman', 'whatever', 'starwars', 'computer', 'michelle', 'jennifer', 'dragon12', 'monkey12', 'tomlinos123',
];

final class AuthError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message, public readonly array $extra = [])
    {
        parent::__construct($message);
    }
}

// ---- Storage ----------------------------------------------------------------------------------------------------------

function auth_dir(string $dataDir): string
{
    $dir = $dataDir . '/accounts';
    foreach ([$dir, $dir . '/sessions', $dir . '/history'] as $d) {
        if (!is_dir($d) && !@mkdir($d, 0700, true) && !is_dir($d)) {
            throw new RuntimeException('the accounts folder cannot be created');
        }
    }

    return $dir;
}

/**
 * Runs $fn holding the accounts lock, so two sign-ins never write the people file over each other. Safe to nest: a
 * call made while this request already holds the lock just runs (a second flock on a new handle would wait forever).
 */
function auth_locked(string $dataDir, callable $fn): mixed
{
    static $held = 0;
    if ($held > 0) {
        return $fn();
    }
    $lock = fopen(auth_dir($dataDir) . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('the accounts lock cannot be taken');
    }
    $held++;
    try {
        return $fn();
    } finally {
        $held--;
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function auth_read_json(string $path, mixed $default): mixed
{
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return $default;
    }
    $value = json_decode($raw, true);
    if (!is_array($value)) {
        throw new RuntimeException('an accounts file is damaged (' . basename($path) . ')');
    }

    return $value;
}

function auth_write_json(string $path, mixed $value): void
{
    $text = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $text, LOCK_EX) !== strlen($text)) {
        @unlink($tmp);
        throw new RuntimeException('the disk refused a write (is it full?)');
    }
    for ($try = 0; $try < 10; $try++) {
        if (@rename($tmp, $path)) {
            return;
        }
        usleep(20000);
    }
    @unlink($tmp);
    throw new RuntimeException('an accounts file could not be replaced');
}

/** @return array<string, array> people by id */
function auth_users(string $dataDir): array
{
    return auth_read_json(auth_dir($dataDir) . '/users.json', []);
}

function auth_save_users(string $dataDir, array $users): void
{
    auth_write_json(auth_dir($dataDir) . '/users.json', $users);
}

function auth_find_user(array $users, string $name): ?array
{
    foreach ($users as $user) {
        if ($user['name'] === strtolower(trim($name))) {
            return $user;
        }
    }

    return null;
}

/** 32 random bytes made once and kept beside the accounts. Never rotated: every PIN and recovery code depends on it. */
function auth_pepper(string $dataDir): string
{
    $path = auth_dir($dataDir) . '/pepper';
    $pepper = @file_get_contents($path);
    if ($pepper !== false && strlen($pepper) === 64) {
        return (string) hex2bin($pepper);
    }

    return auth_locked($dataDir, static function () use ($path): string {
        $again = @file_get_contents($path);
        if ($again !== false && strlen($again) === 64) {
            return (string) hex2bin($again);
        }
        $fresh = random_bytes(32);
        if (file_put_contents($path, bin2hex($fresh), LOCK_EX) !== 64) {
            throw new RuntimeException('the accounts pepper cannot be written');
        }

        return $fresh;
    });
}

// ---- Passwords and PINs -----------------------------------------------------------------------------------------------

function auth_hash_password(string $password): string
{
    // 19 MiB and 2 passes (OWASP's Argon2id setting), not PHP's 64 MiB: twenty sign-ins at once must not exhaust a
    // shared host's memory. Older hashes carry their own settings and still verify.
    return defined('PASSWORD_ARGON2ID')
        ? password_hash($password, PASSWORD_ARGON2ID, ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1])
        : password_hash($password, PASSWORD_DEFAULT);
}

/** The only things a password is refused for. Returns the reason, or null. */
function auth_password_problem(string $password, string $name): ?string
{
    if (strlen($password) > 1024) {
        return 'That password is over 1,024 characters. Use a shorter one.';
    }
    if (auth_chars($password) < 8) {
        return 'Use at least 8 characters. A few ordinary words together are easy to remember and hard to guess; Suggest one makes a strong one for you.';
    }
    $plain = strtolower($password);
    if (in_array($plain, AUTH_COMMON, true)) {
        return 'That password is on every guessing list. Add a few words of your own, or press Suggest one.';
    }
    if ($name !== '' && rtrim($plain, '0123456789') === strtolower($name)) {
        return 'That password is your user name. Choose something else, or press Suggest one.';
    }

    return null;
}

/** Characters (not bytes) in UTF-8 text, without needing the mbstring extension (not every host turns it on). */
function auth_chars(string $text): int
{
    return (int) preg_match_all('/./su', $text);
}

/** The first $n characters of UTF-8 text; invalid UTF-8 comes back empty. */
function auth_cut(string $text, int $n): string
{
    $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);

    return $chars === false ? '' : implode('', array_slice($chars, 0, $n));
}

function auth_name_problem(string $name): ?string
{
    if (!preg_match(AUTH_NAME_RE, $name)) {
        return 'A user name is 2 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    }

    return null;
}

function auth_hash_pin(string $dataDir, string $pin): string
{
    return password_hash(hash_hmac('sha256', $pin, auth_pepper($dataDir)), PASSWORD_DEFAULT);
}

function auth_check_pin(string $dataDir, string $pin, string $hash): bool
{
    return password_verify(hash_hmac('sha256', $pin, auth_pepper($dataDir)), $hash);
}

// ---- Two-step codes (TOTP, RFC 6238 with HMAC-SHA1) ---------------------------------------------------------------------

const AUTH_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function auth_base32_encode(string $bytes): string
{
    $bits = '';
    foreach (str_split($bytes) as $c) {
        $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 5) as $chunk) {
        $out .= AUTH_B32[bindec(str_pad($chunk, 5, '0'))];
    }

    return $out;
}

function auth_base32_decode(string $text): string
{
    $text = strtoupper(preg_replace('/[\s=-]/', '', $text) ?? '');
    $bits = '';
    foreach (str_split($text) as $c) {
        $v = strpos(AUTH_B32, $c);
        if ($v === false) {
            throw new InvalidArgumentException('not base32');
        }
        $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 8) as $byte) {
        if (strlen($byte) === 8) {
            $out .= chr(bindec($byte));
        }
    }

    return $out;
}

/** The code for one 30-second step. $key is the raw secret. */
function auth_totp(string $key, int $step, int $digits = AUTH_TOTP_DIGITS): string
{
    $mac = hash_hmac('sha1', pack('J', $step), $key, true);
    $at = ord($mac[19]) & 0x0f;
    $bin = ((ord($mac[$at]) & 0x7f) << 24) | (ord($mac[$at + 1]) << 16) | (ord($mac[$at + 2]) << 8) | ord($mac[$at + 3]);

    return str_pad((string) ($bin % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
}

/**
 * Checks a code against the step before, now and after (a phone clock a little out). Returns the step it matched, or
 * null. A step at or before $lastStep is refused, so a code seen over someone's shoulder cannot be used twice.
 */
function auth_totp_check(string $secret, string $code, int $lastStep, ?int $now = null): ?int
{
    $code = preg_replace('/\s+/', '', $code) ?? '';
    if (!preg_match('/^[0-9]{6}$/', $code)) {
        return null;
    }
    $key = auth_base32_decode($secret);
    $step = intdiv($now ?? time(), AUTH_TOTP_STEP);
    foreach ([$step - 1, $step, $step + 1] as $s) {
        if ($s > $lastStep && hash_equals(auth_totp($key, $s), $code)) {
            return $s;
        }
    }

    return null;
}

function auth_totp_uri(string $secret, string $name, string $issuer): string
{
    return 'otpauth://totp/' . rawurlencode($issuer) . ':' . rawurlencode($name) . '?secret=' . $secret . '&issuer=' . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
}

/** Ten one-time codes like "k7m2-9xq4-bd". Returns [shown once, stored]. */
function auth_recovery_codes(string $dataDir): array
{
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    $plain = [];
    $stored = [];
    for ($i = 0; $i < AUTH_RECOVERY_COUNT; $i++) {
        $c = '';
        for ($j = 0; $j < 10; $j++) {
            $c .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $code = substr($c, 0, 4) . '-' . substr($c, 4, 4) . '-' . substr($c, 8, 2);
        $plain[] = $code;
        $stored[] = hash_hmac('sha256', $code, auth_pepper($dataDir));
    }

    return [$plain, $stored];
}

// ---- Sessions ---------------------------------------------------------------------------------------------------------

function auth_session_path(string $dataDir, string $token): string
{
    return auth_dir($dataDir) . '/sessions/' . hash('sha256', $token) . '.json';
}

/** Makes a session and returns the cookie token. $stage is 'full' or '2fa' (password right, code still to come). */
function auth_session_create(string $dataDir, string $userId, string $stage): string
{
    $token = bin2hex(random_bytes(32));
    $now = time();
    auth_write_json(auth_session_path($dataDir, $token), [
        'user' => $userId, 'stage' => $stage, 'created' => $now, 'seen' => $now, 'locked' => false, 'fails' => 0,
        'ip' => (string) ($_SERVER['REMOTE_ADDR'] ?? ''), 'agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200),
    ]);

    return $token;
}

/** The session for a token, or null when there is none or it has run out (and then its file is removed). */
function auth_session_load(string $dataDir, string $token): ?array
{
    if (!preg_match('/^[0-9a-f]{64}$/', $token)) {
        return null;
    }
    $path = auth_session_path($dataDir, $token);
    try {
        $session = auth_read_json($path, null);
    } catch (RuntimeException) {
        @unlink($path);

        return null;
    }
    if (!is_array($session)) {
        return null;
    }
    $config = api_config();
    if (auth_session_expired($session)) {
        @unlink($path);

        return null;
    }

    return $session;
}

/** Past its idle limit (12 hours signed in; 10 minutes half-way through signing in) or its whole life (30 days). */
function auth_session_expired(array $session): bool
{
    $config = api_config();
    $idle = (int) ($config['session_idle_hours'] ?? 12) * 3600;
    $life = (int) ($config['session_days'] ?? 30) * 86400;
    $limit = ($session['stage'] ?? '') === 'full' ? $idle : 600;

    return time() - (int) ($session['seen'] ?? 0) > $limit || time() - (int) ($session['created'] ?? 0) > $life;
}

function auth_session_save(string $dataDir, string $token, array $session): void
{
    auth_write_json(auth_session_path($dataDir, $token), $session);
}

/**
 * Changes one session under the lock, from a fresh read, so two requests never write back each other's old copy (a
 * "last seen" refresh landing with a lock must not undo the lock). $fn returns the new session, or null to end it.
 * Returns what was saved, or null when the session is gone or was ended.
 */
function auth_session_update(string $dataDir, string $token, callable $fn): ?array
{
    return auth_locked($dataDir, static function () use ($dataDir, $token, $fn): ?array {
        $session = auth_session_load($dataDir, $token);
        if ($session === null) {
            return null;
        }
        $next = $fn($session);
        if ($next === null) {
            auth_session_end($dataDir, $token);

            return null;
        }
        auth_session_save($dataDir, $token, $next);

        return $next;
    });
}

/**
 * Uses up one guess (PIN, password or code) from this session BEFORE the guess is checked, under the lock. Guesses
 * sent in parallel therefore each take one, and no burst of requests can get more than the limit between them.
 * Returns the number of guesses used including this one, or null when the session is gone.
 */
function auth_session_take_try(string $dataDir, string $token): ?int
{
    $s = auth_session_update($dataDir, $token, static fn (array $s): array => ['fails' => (int) ($s['fails'] ?? 0) + 1] + $s);

    return $s === null ? null : (int) $s['fails'];
}

/** Marks a two-step step as used, under the lock; false if it (or a later one) was used already (a replay). */
function auth_totp_use(string $dataDir, string $userId, int $step): bool
{
    return auth_locked($dataDir, static function () use ($dataDir, $userId, $step): bool {
        $users = auth_users($dataDir);
        if (!isset($users[$userId]) || $step <= (int) ($users[$userId]['totp']['last'] ?? 0)) {
            return false;
        }
        $users[$userId]['totp']['last'] = $step;
        auth_save_users($dataDir, $users);

        return true;
    });
}

/** Requests from this computer itself (the owner at the server, or the dev server) need no set-up code. */
function auth_is_local(): bool
{
    return api_is_local();
}

/**
 * The one-time code a fresh install asks for before anyone can become its owner, so a stranger who finds the new site
 * first cannot. Made on first need and kept in the data folder, where only the person with the hosting account can
 * read it (cPanel File Manager: tomlinos/data/accounts/SETUP-CODE.txt). Deleted once the owner is set up.
 */
function auth_setup_code(string $dataDir): string
{
    $path = auth_dir($dataDir) . '/SETUP-CODE.txt';

    return auth_locked($dataDir, static function () use ($path): string {
        $code = trim((string) @file_get_contents($path));
        if (!preg_match('/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/', $code)) {
            $raw = strtolower(auth_base32_encode(random_bytes(8)));
            $code = substr($raw, 0, 4) . '-' . substr($raw, 4, 4) . '-' . substr($raw, 8, 4);
            if (@file_put_contents($path, $code . "\n", LOCK_EX) === false) {
                throw new RuntimeException('the set-up code file could not be written');
            }
            @chmod($path, 0600);
        }

        return $code;
    });
}

function auth_session_end(string $dataDir, string $token): void
{
    @unlink(auth_session_path($dataDir, $token));
}

/**
 * Every live session of one person: [file id => session]. The id is the first 12 characters of the file name.
 * Expired or unreadable session files met on the way are deleted, so the folder cannot grow for ever.
 */
function auth_sessions_of(string $dataDir, string $userId): array
{
    $out = [];
    foreach (glob(auth_dir($dataDir) . '/sessions/*.json') ?: [] as $file) {
        $s = json_decode((string) @file_get_contents($file), true);
        if (!is_array($s) || auth_session_expired($s)) {
            @unlink($file);
            continue;
        }
        if (($s['user'] ?? '') === $userId) {
            $out[basename($file, '.json')] = $s;
        }
    }

    return $out;
}

/** Signs a person out everywhere except the session whose file id is $keep. Returns how many ended. */
function auth_sessions_end_all(string $dataDir, string $userId, ?string $keep = null): int
{
    $n = 0;
    foreach (array_keys(auth_sessions_of($dataDir, $userId)) as $id) {
        if ($id !== $keep && @unlink(auth_dir($dataDir) . '/sessions/' . $id . '.json')) {
            $n++;
        }
    }

    return $n;
}

// ---- Brakes on guessing -------------------------------------------------------------------------------------------------

/**
 * How long this address must wait before another sign-in try for this name, in seconds (0 = go ahead).
 * After 5 wrong passwords for one name FROM ONE ADDRESS: 1 minute, then doubling to 1 hour. After 20 wrong from one
 * address in 15 minutes (any names): 15 minutes. A right password clears that name's counts.
 * The name's count is kept per address: counted for the name alone, anyone who knew a user name could keep its owner
 * out from everywhere by typing wrong passwords (account lock vs address lock).
 */
/** The brake's key for one name tried from one address. */
function auth_throttle_key(string $name, string $ip): string
{
    return strtolower($name) . '|' . $ip;
}

/** An IPv6 visitor usually has a whole /64 to pick addresses from, so the brake counts the /64, not each address. */
function auth_throttle_ip(string $ip): string
{
    $bin = @inet_pton($ip);
    if ($bin === false || strlen($bin) !== 16) {
        return $ip;
    }

    return inet_ntop(substr($bin, 0, 8) . str_repeat("\0", 8)) . '/64';
}

function auth_throttle_wait(string $dataDir, string $ip, string $name): int
{
    if (auth_trusted_ip($ip)) {
        return 0;
    }
    $ip = auth_throttle_ip($ip);
    $t = auth_read_json(auth_dir($dataDir) . '/throttle.json', []);
    $now = time();
    $wait = 0;
    $ipFails = array_filter($t['ip'][$ip] ?? [], static fn ($at) => $now - $at < 900);
    if (count($ipFails) >= 20) {
        $wait = max($wait, 900 - ($now - min($ipFails)));
    }
    $n = $t['name'][auth_throttle_key($name, $ip)] ?? null;
    if ($n) {
        $wait = max($wait, auth_brake_hold((int) $n['count']) - ($now - (int) $n['last']));
    }

    return max(0, $wait);
}

/**
 * The sign-in brake, checked and charged in one step under the lock, so a burst of parallel tries cannot all pass
 * the check before any is counted. Returns the wait in seconds (nothing charged), or 0 after charging this try; a
 * right password then calls auth_throttle_clear for the name.
 */
function auth_throttle_take(string $dataDir, string $ip, string $name): int
{
    return auth_locked($dataDir, static function () use ($dataDir, $ip, $name): int {
        $wait = auth_throttle_wait($dataDir, $ip, $name);
        if ($wait === 0) {
            auth_throttle_fail($dataDir, $ip, $name);
        }

        return $wait;
    });
}

function auth_throttle_fail(string $dataDir, string $ip, string $name): void
{
    // Only real-looking names get a bucket: anything typed could otherwise grow the file without end.
    if (auth_name_problem($name) !== null) {
        $name = '';
    }
    if (auth_trusted_ip($ip)) {
        return;
    }
    $ip = auth_throttle_ip($ip);
    auth_locked($dataDir, static function () use ($dataDir, $ip, $name): void {
        $path = auth_dir($dataDir) . '/throttle.json';
        $t = auth_read_json($path, []);
        $now = time();
        $t['ip'][$ip] = array_values(array_filter([...($t['ip'][$ip] ?? []), $now], static fn ($at) => $now - $at < 900));
        $key = $name === '' ? '' : auth_throttle_key($name, $ip);
        $prev = $t['name'][$key] ?? ['count' => 0, 'last' => 0];
        // A name left alone for a week starts again (the longest hold is 64 hours, so a hold never outlives its count).
        $t['name'][$key] = ['count' => ($now - $prev['last'] > AUTH_BRAKE_FORGET ? 0 : $prev['count']) + 1, 'last' => $now];
        // Keep the file small: forget addresses and names with nothing recent.
        foreach ($t['ip'] as $k => $v) {
            $recent = array_values(array_filter($v, static fn ($at) => $now - $at < 900));
            if ($recent) {
                $t['ip'][$k] = $recent;
            } else {
                unset($t['ip'][$k]);
            }
        }
        foreach ($t['name'] as $k => $v) {
            if ($now - $v['last'] > AUTH_BRAKE_FORGET) {
                unset($t['name'][$k]);
            }
        }
        unset($t['name']['']);
        // A hard cap, newest kept, so no flood of addresses or names can make every sign-in slow.
        if (count($t['ip']) > 2000) {
            uasort($t['ip'], static fn ($a, $b) => max($b) <=> max($a));
            $t['ip'] = array_slice($t['ip'], 0, 2000, true);
        }
        if (count($t['name']) > 2000) {
            uasort($t['name'], static fn ($a, $b) => $b['last'] <=> $a['last']);
            $t['name'] = array_slice($t['name'], 0, 2000, true);
        }
        auth_write_json($path, $t);
    });
}

/** Gives back the try auth_throttle_take charged to this address, when it turned out right: people sharing one
    connection (a household, an office) must not use up each other's tries by signing in correctly. */
function auth_throttle_refund(string $dataDir, string $ip): void
{
    // Tries are booked by auth_throttle_ip (an IPv6 address by its /64), so the refund looks there too.
    $ip = auth_throttle_ip($ip);
    auth_locked($dataDir, static function () use ($dataDir, $ip): void {
        $path = auth_dir($dataDir) . '/throttle.json';
        $t = auth_read_json($path, []);
        if (!empty($t['ip'][$ip])) {
            array_pop($t['ip'][$ip]);
            if (!$t['ip'][$ip]) {
                unset($t['ip'][$ip]);
            }
            auth_write_json($path, $t);
        }
    });
}

function auth_throttle_clear(string $dataDir, string $name): void
{
    auth_locked($dataDir, static function () use ($dataDir, $name): void {
        $path = auth_dir($dataDir) . '/throttle.json';
        $t = auth_read_json($path, []);
        // Every address's count for this name: the right password proves the person, wherever the wrong tries came from.
        $before = count($t['name'] ?? []);
        foreach (array_keys($t['name'] ?? []) as $k) {
            if (str_starts_with((string) $k, strtolower($name) . '|')) {
                unset($t['name'][$k]);
            }
        }
        if (count($t['name'] ?? []) !== $before) {
            auth_write_json($path, $t);
        }
    });
}

// ---- Sign-in history ----------------------------------------------------------------------------------------------------

function auth_history_add(string $dataDir, string $userId, string $event): void
{
    // Under the lock: two sign-ins at the same moment must not each drop the other's line.
    auth_locked($dataDir, static function () use ($dataDir, $userId, $event): void {
        $path = auth_dir($dataDir) . '/history/' . $userId . '.json';
        $list = auth_read_json($path, []);
        $row = ['at' => time(), 'event' => $event, 'ip' => (string) ($_SERVER['REMOTE_ADDR'] ?? ''), 'agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200)];
        $last = $list[0] ?? null;
        // The same thing again from the same device within the hour is one line with a count, so a flood of wrong
        // tries cannot push the older lines out of the list.
        if (is_array($last) && ($last['event'] ?? '') === $event && ($last['ip'] ?? '') === $row['ip'] && ($last['agent'] ?? '') === $row['agent'] && $row['at'] - (int) ($last['at'] ?? 0) < 3600) {
            $list[0] = $row + ['times' => (int) ($last['times'] ?? 1) + 1];
        } else {
            array_unshift($list, $row);
        }
        auth_write_json($path, array_slice($list, 0, AUTH_HISTORY_KEEP));
    });
}

function auth_history(string $dataDir, string $userId): array
{
    return auth_read_json(auth_dir($dataDir) . '/history/' . $userId . '.json', []);
}

// ---- Each person's own files --------------------------------------------------------------------------------------------

function auth_user_store(string $dataDir, string $userId): string
{
    if (!preg_match('/^[0-9a-f]{16}$/', $userId)) {
        throw new InvalidArgumentException('not a user id');
    }

    return $dataDir . '/users/' . $userId;
}

/**
 * The first person set up takes over the files already on the desktop (from before accounts existed): the old
 * shared store is MOVED into their folder, never copied or deleted.
 */
function auth_adopt_old_store(string $dataDir, string $userId): bool
{
    $old = $dataDir . '/objects';
    if (!is_dir($old)) {
        return false;
    }
    $mine = auth_user_store($dataDir, $userId);
    if (!is_dir($mine) && !@mkdir($mine, 0700, true) && !is_dir($mine)) {
        throw new RuntimeException('your file folder cannot be created');
    }
    if (is_dir($mine . '/objects')) {
        return false;
    }
    if (!@rename($old, $mine . '/objects')) {
        throw new RuntimeException('the files already on this desktop could not be moved into your folder');
    }
    foreach (['.journal'] as $f) {
        if (is_file($dataDir . '/' . $f)) {
            @rename($dataDir . '/' . $f, $mine . '/' . $f);
        }
    }

    return true;
}

/** What a person's page is told about them. Never a hash, a secret or a code. */
function auth_public_user(array $user): array
{
    return [
        'id' => $user['id'], 'name' => $user['name'], 'display' => $user['display'], 'admin' => (bool) $user['admin'],
        'totp' => !empty($user['totp']['enabled']), 'pin' => !empty($user['pin']), 'recoveryLeft' => count($user['recovery'] ?? []),
        'created' => $user['created'], 'disabled' => !empty($user['disabled']),
        'recoveryKey' => !empty($user['rkey']), 'recoveryKeyMade' => (int) ($user['rkeyMade'] ?? 0),
        'vault' => (string) ($user['vault']['state'] ?? 'off'),
        // Only masked: the list of people the owner sees must not hand out addresses.
        'unlockEmail' => auth_mask_email((string) ($user['unlockEmail'] ?? '')),
    ];
}

// ---- Recovery key and encryption (the vault) --------------------------------------------------------------------------
// The browser makes both. The recovery key never reaches the server: the browser derives two values from it, sends one
// ("auth", kept here only as a keyed hash, to prove the key at "Forgot your password?") and keeps the other for itself
// (it unwraps the file key). Likewise the file key is only ever here wrapped: once by the password, once by the recovery
// key. The server cannot open either wrap; it stores them and hands them back to the signed-in person.

const AUTH_VAULT_STATES = ['off', 'migrating-on', 'on', 'migrating-off'];

function auth_rkey_hash(string $dataDir, string $authHex): string
{
    if (!preg_match('/^[0-9a-f]{64}$/', $authHex)) {
        throw new InvalidArgumentException('a recovery proof is 64 hex characters');
    }

    return hash_hmac('sha256', 'rkey:' . $authHex, auth_pepper($dataDir));
}

/** The wrapped file key and how to unwrap it, checked for shape (the server cannot check more). */
function auth_vault_keys(array $body): array
{
    $b64 = static function (mixed $v, int $bytes, string $what): string {
        $raw = is_string($v) ? base64_decode($v, true) : false;
        if ($raw === false || strlen($raw) !== $bytes) {
            throw new InvalidArgumentException("$what is not the right shape");
        }

        return $v;
    };
    $iter = $body['iter'] ?? null;
    if (!is_int($iter) || $iter < 100000 || $iter > 10000000) {
        throw new InvalidArgumentException('the key-stretching count is out of range');
    }

    return [
        'salt' => $b64($body['salt'] ?? null, 16, 'the salt'),
        'iter' => $iter,
        'wrapPw' => $b64($body['wrapPw'] ?? null, 40, 'the password-wrapped key'),
    ];
}

function auth_wrap_rk(array $body): string
{
    $v = $body['wrapRk'] ?? null;
    $raw = is_string($v) ? base64_decode($v, true) : false;
    if ($raw === false || strlen($raw) !== 40) {
        throw new InvalidArgumentException('the recovery-wrapped key is not the right shape');
    }

    return $v;
}

/** What the signed-in person's own page needs to open their files. Never sent for anyone else. */
function auth_vault_for_owner(array $user): ?array
{
    $v = $user['vault'] ?? null;
    if (!$v || ($v['state'] ?? 'off') === 'off') {
        return null;
    }

    return ['state' => $v['state'], 'salt' => $v['salt'], 'iter' => $v['iter'], 'wrapPw' => $v['wrapPw'], 'wrapRk' => $v['wrapRk'], 'stale' => !empty($v['stale'])];
}

// ---- The current request's session (used by both the accounts API and the file store) ------------------------------

function cookie_name(): string
{
    // "__Host-" makes the browser refuse the cookie unless it is Secure, for this host only, on every path.
    return api_https() ? '__Host-tomlinos' : 'tomlinos';
}

function set_session_cookie(string $token, int $days): void
{
    setcookie(cookie_name(), $token, [
        'expires' => $token === '' ? time() - 3600 : time() + $days * 86400,
        'path' => '/', 'secure' => api_https(), 'httponly' => true, 'samesite' => 'Strict',
    ]);
}

/** @return array{0: string, 1: array, 2: array}|null [token, session, user] */
function current_session(string $dataDir): ?array
{
    $token = (string) ($_COOKIE[cookie_name()] ?? '');
    $session = $token === '' ? null : auth_session_load($dataDir, $token);
    if ($session === null) {
        return null;
    }
    $user = auth_users($dataDir)[$session['user']] ?? null;
    if ($user === null || !empty($user['disabled'])) {
        auth_session_end($dataDir, $token);

        return null;
    }
    if (time() - (int) $session['seen'] >= 60) {
        // Only "seen" changes, on a fresh read under the lock: a copy read before a lock must never be written back.
        $session = auth_session_update($dataDir, $token, static fn (array $s): array => ['seen' => time()] + $s);
        if ($session === null) {
            return null;
        }
    }

    return [$token, $session, $user];
}

/** A signed-in, unlocked session, or a refusal the page understands (auth: signin / locked). */
function require_full(string $dataDir): array
{
    $current = current_session($dataDir);
    if ($current === null || $current[1]['stage'] !== 'full') {
        api_fail(401, 'You are signed out. Sign in again to carry on.', ['auth' => 'signin']);
    }
    if (!empty($current[1]['locked'])) {
        api_fail(423, 'The screen is locked. Unlock it to carry on.', ['auth' => 'locked']);
    }

    return $current;
}

function require_admin(array $user): void
{
    if (empty($user['admin'])) {
        api_fail(403, 'Only the owner of this desktop can manage other people.');
    }
}

/**
 * What the site shows anyone not signed in: "reader" (a book reader with Sherlock Holmes and a small Log in link, so
 * a visitor or a bot finds only old books), or "signin" (the TOMLIN OS sign-in). Chosen by the owner; the Reader is the
 * default.
 */
const AUTH_FRONTS = ['reader', 'signin'];

function auth_front(string $dataDir): string
{
    $s = auth_read_json(auth_dir($dataDir) . '/site.json', []);
    $front = is_array($s) ? (string) ($s['front'] ?? 'reader') : 'reader';

    return in_array($front, AUTH_FRONTS, true) ? $front : 'reader';
}

function auth_save_front(string $dataDir, string $front): void
{
    auth_write_json(auth_dir($dataDir) . '/site.json', ['front' => $front]);
}

// ---- Brakes: the schedule, trusted addresses, the picture check, unlock links ----------------------------------------
// Wrong passwords for one name from one address: after 5, that address waits 1 hour; then it has 3 more tries before
// the next hold, each twice as long (2, 4, 8, 16, 32, then 64 hours at most). Only that name from that address is held:
// someone guessing elsewhere cannot lock the real person out. From the second wrong try on, the picture check is
// asked for as well. The owner can list trusted addresses (config.php) that are never held or asked.

const AUTH_BRAKE_FIRST = 5;
const AUTH_BRAKE_BETWEEN = 3;
const AUTH_BRAKE_MAX_HOURS = 64;
const AUTH_BRAKE_FORGET = 7 * 86400;
const AUTH_LINK_TTL = 3600;
const AUTH_LINK_TRIES = 3;

/** How long (seconds) a name is held after its count-th wrong try: 0 between holds. */
function auth_brake_hold(int $count): int
{
    if ($count < AUTH_BRAKE_FIRST || ($count - AUTH_BRAKE_FIRST) % AUTH_BRAKE_BETWEEN !== 0) {
        return 0;
    }

    return 3600 * min(AUTH_BRAKE_MAX_HOURS, 2 ** intdiv($count - AUTH_BRAKE_FIRST, AUTH_BRAKE_BETWEEN));
}

/** An address the owner listed in config.php (trusted_ips): never held, never asked for the picture. */
function auth_trusted_ip(string $ip): bool
{
    $list = api_config()['trusted_ips'] ?? [];
    if (!is_array($list) || $ip === '') {
        return false;
    }
    $mine = auth_throttle_ip($ip);
    foreach ($list as $trusted) {
        if (is_string($trusted) && $trusted !== '' && auth_throttle_ip(trim($trusted)) === $mine) {
            return true;
        }
    }

    return false;
}

/** Whether a password try for this name from this address must come with the picture check. */
function auth_captcha_needed(string $dataDir, string $ip, string $name): bool
{
    if (auth_trusted_ip($ip)) {
        return false;
    }
    $key = auth_throttle_ip($ip);
    $t = auth_read_json(auth_dir($dataDir) . '/throttle.json', []);
    $now = time();
    $n = $t['name'][auth_throttle_key($name, $key)] ?? null;
    $recentFromHere = count(array_filter($t['ip'][$key] ?? [], static fn ($at) => $now - $at < 900));

    // After a wrong try for this name, or three wrong tries for any names from this address (someone trying names).
    return ($n && (int) $n['count'] >= 1 && $now - (int) $n['last'] < AUTH_BRAKE_FORGET) || $recentFromHere >= 3;
}

/** "a***@example.com": enough for the person to recognise, not enough to be of use to anyone else. */
function auth_mask_email(string $email): string
{
    $at = strrpos($email, '@');
    if ($at === false || $at < 1) {
        return '';
    }

    return substr($email, 0, 1) . str_repeat('*', max(3, min(8, $at - 1))) . substr($email, $at);
}

/**
 * Sends one plain-text email with PHP's own mail() (cPanel hosts deliver it). The tests point DESKTOP_MAIL_LOG at a file,
 * and then the message is written there instead (only an environment variable can do that).
 */
function auth_send_mail(string $to, string $subject, string $text): bool
{
    $clean = static fn (string $v): string => trim(str_replace(["\r", "\n"], ' ', $v));
    $to = $clean($to);
    $subject = $clean($subject);
    $log = (string) getenv('DESKTOP_MAIL_LOG');
    if ($log !== '') {
        return file_put_contents($log, json_encode(['to' => $to, 'subject' => $subject, 'text' => $text]) . "\n", FILE_APPEND | LOCK_EX) !== false;
    }
    if (!function_exists('mail')) {
        return false;
    }
    $from = $clean((string) (api_config()['mail_from'] ?? ''));
    $headers = ['Content-Type: text/plain; charset=utf-8'];
    if ($from !== '' && filter_var($from, FILTER_VALIDATE_EMAIL)) {
        $headers[] = 'From: ' . $from;
    }

    return @mail($to, $subject, $text, implode("\r\n", $headers));
}
