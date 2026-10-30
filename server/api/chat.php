<?php
// Chat for the Chat app: General (everyone with an account on this TOMLIN OS) and Direct (two people). The browser
// encrypts every message before sending it (src/apps/chat/crypto.ts); this file keeps scrambled text, each person's
// public key, and the General key wrapped separately for each person. It cannot read a message.
//   GET  op=state                    people (name, public key, online, whether their files are encrypted), the General
//                                    key wrapped for me, and per conversation its newest message and my unread count
//   POST op=key                      my public key {pub}; replacing one needs {replace:true} (my old messages then
//                                    cannot be opened, and my General key is handed to me again by someone who has it)
//   POST op=wrap                     the General key for someone {user, epoch, fromPub, iv, ct}; {genesis:true} makes
//                                    the first one (only while nobody holds a General key)
//   GET  op=messages&conv=&after=    up to 200 messages after that number, and the numbers of messages deleted
//   POST op=send                     {conv, iv, ct, epoch}
//   POST op=read                     {conv, id}: read up to there
//   POST op=delete                   {conv, id}: one of my messages, gone from the server for everyone; {conv, mine:true}
//                                    all of mine there; the owner may also delete anyone's in General, or {conv:'general',
//                                    all:true} every message in it
//   GET  op=settings                 how many days messages are kept (0: until deleted)
//   POST op=settings                 owner only: {vanishDays, password, code} 0, 3, 7 or 30; older messages are deleted
//                                    from the server
//   POST op=reset                    owner only: {password, code} a new General key; messages under the old one can no
//                                    longer be opened
// Nobody signed in: 401. Screen locked: 423.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';

const CHAT_KEEP = 5000;         // messages kept per conversation (the oldest go first)
const CHAT_KEEP_BYTES = 2097152; // and at most 2 MB of scrambled text per conversation: every look for new messages
                                 // reads each conversation's file, so one person sending huge messages must not make
                                 // that slow for everyone (2 MB is about 250,000 words)
const CHAT_PAGE = 200;          // messages per answer
const CHAT_ONLINE = 30;         // seconds since the last look that still counts as online
const CHAT_MAX_CT = 16384;      // base64 characters of one scrambled message (about 4,000 words)
const CHAT_VANISH_CHOICES = [0, 3, 7, 30]; // days messages are kept (Settings, the owner's choice); 0 = until deleted
const CHAT_GONE_KEPT = 1000;    // numbers of deleted messages remembered per conversation, so open screens drop them
                                 // (one delete is always remembered whole, even over that)
const CHAT_SWEEP = 60;          // seconds between sweeps of every conversation for messages past "vanish after"

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $me] = require_full($root);
$uid = (string) $me['id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$op = query_str('op');

function chat_dir(string $root): string
{
    $dir = $root . '/chat';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('the chat folder cannot be created');
    }

    return $dir;
}

/** Runs $fn holding the chat lock: two people sending at once must not write a conversation over each other. */
function chat_locked(string $root, callable $fn): mixed
{
    $lock = fopen(chat_dir($root) . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('the chat lock cannot be taken');
    }
    try {
        return $fn(chat_dir($root));
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Base64 of exactly $bytes bytes (or, with $max, of 1..$max characters). */
function chat_b64(string $value, int $bytes = 0, int $max = 0): bool
{
    if ($value === '' || !preg_match('#^[A-Za-z0-9+/]+={0,2}$#', $value)) {
        return false;
    }
    if ($max > 0) {
        return strlen($value) <= $max;
    }
    $raw = base64_decode($value, true);

    return $raw !== false && strlen($raw) === $bytes;
}

/**
 * A P-256 public key as the browser exports it ("raw": 65 bytes, starting 0x04), and a real point on the curve. A key
 * that is not (all zeros, say) is refused here: every browser handing out the General key would otherwise fail on it,
 * and from then on deletes would stop applying and new people would never get the key.
 */
function chat_pub_ok(string $pub): bool
{
    if (!chat_b64($pub, 65)) {
        return false;
    }
    $raw = base64_decode($pub, true);

    return $raw[0] === "\x04" && chat_on_curve(substr($raw, 1, 32), substr($raw, 33, 32));
}

/**
 * Is (x, y) on P-256: y² = x³ − 3x + b (mod p)? Worked out with whichever big-number support this PHP has (gmp, else
 * bcmath, else openssl's own check); with none of them the shape check above is all the server can do.
 */
function chat_on_curve(string $x, string $y): bool
{
    $p = '115792089210356248762697446949407573530086143415290314195533631308867097853951';
    $b = '41058363725152142129326129780047268409114441015993725554835256314039467401291';
    if (function_exists('gmp_init')) {
        $gx = gmp_import($x);
        $gy = gmp_import($y);
        $gp = gmp_init($p);
        if (gmp_cmp($gx, $gp) >= 0 || gmp_cmp($gy, $gp) >= 0) {
            return false;
        }
        $right = gmp_mod(gmp_add(gmp_sub(gmp_powm($gx, 3, $gp), gmp_mul($gx, 3)), gmp_init($b)), $gp);

        return gmp_cmp(gmp_powm($gy, 2, $gp), $right) === 0;
    }
    if (function_exists('bcpowmod')) {
        $dec = static function (string $bytes): string {
            $n = '0';
            foreach (str_split($bytes) as $c) {
                $n = bcadd(bcmul($n, '256', 0), (string) ord($c), 0);
            }

            return $n;
        };
        $dx = $dec($x);
        $dy = $dec($y);
        if (bccomp($dx, $p, 0) >= 0 || bccomp($dy, $p, 0) >= 0) {
            return false;
        }
        $right = bcmod(bcadd(bcsub(bcpowmod($dx, '3', $p, 0), bcmul($dx, '3', 0), 0), $b, 0), $p, 0);
        // bcmod of a negative number keeps the sign: brought back into 0..p-1.
        if (bccomp($right, '0', 0) < 0) {
            $right = bcadd($right, $p, 0);
        }

        return bccomp(bcpowmod($dy, '2', $p, 0), $right, 0) === 0;
    }
    if (function_exists('openssl_pkey_get_public')) {
        // OpenSSL refuses to load a public key whose point is not on its curve.
        $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . "\x04" . $x . $y;

        return openssl_pkey_get_public("-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n") !== false;
    }

    return true;
}

/** The conversations one person belongs to: General, and one Direct conversation with each other person. */
function chat_convs_of(string $uid, array $users): array
{
    $convs = ['general'];
    foreach ($users as $id => $_) {
        // A key of digits only comes back from PHP as a number: compared as text, as the ids are.
        if ((string) $id !== $uid) {
            $convs[] = chat_dm($uid, (string) $id);
        }
    }

    return $convs;
}

function chat_dm(string $a, string $b): string
{
    return strcmp($a, $b) < 0 ? "dm-$a-$b" : "dm-$b-$a";
}

/** The conversation named in a request, if this person is in it. */
function chat_conv(string $conv, string $uid, array $users): string
{
    if ($conv === 'general') {
        return $conv;
    }
    if (!preg_match('/^dm-([0-9a-f]{16})-([0-9a-f]{16})$/D', $conv, $m) || strcmp($m[1], $m[2]) >= 0) {
        api_fail(400, 'That is not a conversation.');
    }
    if (($m[1] !== $uid && $m[2] !== $uid) || !isset($users[$m[1]], $users[$m[2]])) {
        api_fail(403, 'That conversation is between other people.');
    }

    return $conv;
}

/** How many days messages are kept (0: until someone deletes them). */
function chat_vanish_days(string $dir): int
{
    $days = (int) (auth_read_json("$dir/settings.json", [])['vanishDays'] ?? 0);

    return in_array($days, CHAT_VANISH_CHOICES, true) ? $days : 0;
}

/**
 * A conversation, without the messages older than the owner's "vanish after" setting. 'pruned' says some were dropped
 * just now: a caller holding the lock writes the conversation back, so they leave the server's disk too.
 */
function chat_read_conv(string $dir, string $conv): array
{
    $c = auth_read_json("$dir/conv-$conv.json", ['next' => 1, 'messages' => []]);
    $messages = array_values((array) ($c['messages'] ?? []));
    $days = chat_vanish_days($dir);
    $kept = $days > 0 ? array_values(array_filter($messages, static fn (array $m): bool => (int) $m['at'] >= time() - $days * 86400)) : $messages;

    return ['next' => (int) ($c['next'] ?? 1), 'messages' => $kept, 'gone' => array_values(array_map('intval', (array) ($c['gone'] ?? []))),
        'deletes' => (int) ($c['deletes'] ?? 0), 'pruned' => count($kept) !== count($messages)];
}

function chat_write_conv(string $dir, string $conv, array $c): void
{
    unset($c['pruned']);
    auth_write_json("$dir/conv-$conv.json", $c);
}

/**
 * Drops the messages older than the owner's "vanish after" setting from EVERY conversation (run holding the lock), not
 * only the ones someone is looking at: a Direct conversation between two people who never open Chat again would
 * otherwise keep its messages on the server for ever. Every visit to Chat calls this, so it runs at most once a minute
 * (the marker file's time) to keep from reading every conversation on every poll.
 */
function chat_sweep_vanished(string $dir, bool $always = false): void
{
    if (chat_vanish_days($dir) === 0) {
        return;
    }
    $marker = "$dir/.swept";
    clearstatcache(true, $marker);
    if (!$always && is_file($marker) && time() - (int) filemtime($marker) < CHAT_SWEEP) {
        return;
    }
    foreach (glob("$dir/conv-*.json") ?: [] as $file) {
        $conv = substr(basename($file, '.json'), 5);
        $c = chat_read_conv($dir, $conv);
        if ($c['pruned']) {
            chat_write_conv($dir, $conv, $c);
        }
    }
    // A sweep forced by a settings change leaves the marker alone: the polls keep their own once-a-minute rhythm.
    if (!$always) {
        @touch($marker);
    }
}

try {
    $users = auth_users($root);
    chat_dir($root); // made on the first visit, whatever the request (a refused one included)

    if ($method === 'GET' && $op === 'state') {
        $out = chat_locked($root, static function (string $dir) use ($uid, $users): array {
            chat_sweep_vanished($dir);
            $now = time();
            $presence = auth_read_json("$dir/presence.json", []);
            if ($now - (int) ($presence[$uid] ?? 0) >= 10) {
                $presence[$uid] = $now;
                auth_write_json("$dir/presence.json", $presence);
            }
            $keys = auth_read_json("$dir/keys.json", []);
            $general = auth_read_json("$dir/general.json", ['epoch' => 1, 'wraps' => []]);
            $reads = auth_read_json("$dir/reads.json", [])[$uid] ?? [];
            $people = [];
            foreach ($users as $id => $u) {
                $id = (string) $id; // a key of digits only comes back from PHP as a number
                $people[] = [
                    'id' => $id, 'name' => $u['name'], 'display' => $u['display'], 'me' => $id === $uid,
                    'pub' => $keys[$id]['pub'] ?? null,
                    'online' => $now - (int) ($presence[$id] ?? 0) < CHAT_ONLINE,
                    'encrypted' => ($u['vault']['state'] ?? 'off') === 'on',
                    'disabled' => !empty($u['disabled']),
                    'hasGeneral' => isset($general['wraps'][$id]),
                ];
            }
            $convs = [];
            foreach (chat_convs_of($uid, $users) as $conv) {
                $c = chat_read_conv($dir, $conv);
                if ($c['pruned']) {
                    chat_write_conv($dir, $conv, $c);
                }
                $read = (int) ($reads[$conv] ?? 0);
                $last = end($c['messages']) ?: null;
                $unread = 0;
                foreach ($c['messages'] as $m) {
                    if ($m['id'] > $read && $m['from'] !== $uid) {
                        $unread++;
                    }
                }
                $convs[$conv] = ['last' => $last ? (int) $last['id'] : 0, 'lastAt' => $last ? (int) $last['at'] : 0, 'unread' => $unread, 'deletes' => $c['deletes']];
            }

            return [
                'me' => $uid, 'people' => $people, 'convs' => (object) $convs, 'vanishDays' => chat_vanish_days($dir),
                'general' => ['epoch' => (int) $general['epoch'], 'wrap' => $general['wraps'][$uid] ?? null, 'started' => count((array) $general['wraps']) > 0],
            ];
        });
        api_json($out);
    }

    if ($method === 'GET' && $op === 'messages') {
        $conv = chat_conv(query_str('conv'), $uid, $users);
        $after = max(0, (int) ($_GET['after'] ?? 0));
        $out = chat_locked($root, static function (string $dir) use ($conv, $after): array {
            $c = chat_read_conv($dir, $conv);
            if ($c['pruned']) {
                chat_write_conv($dir, $conv, $c);
            }
            $newer = array_values(array_filter($c['messages'], static fn (array $m): bool => $m['id'] > $after));

            return ['messages' => array_slice($newer, 0, CHAT_PAGE), 'more' => count($newer) > CHAT_PAGE, 'gone' => $c['gone'], 'deletes' => $c['deletes']];
        });
        api_json($out);
    }

    if ($method === 'GET' && $op === 'settings') {
        api_json(['vanishDays' => chat_locked($root, static fn (string $dir): int => chat_vanish_days($dir)), 'owner' => !empty($me['admin'])]);
    }

    if ($method !== 'POST') {
        api_fail(405, 'Chat only reads with GET state, messages and settings.');
    }
    $body = api_body();

    if ($op === 'key') {
        $pub = body_str($body, 'pub');
        if (!chat_pub_ok($pub)) {
            api_fail(400, 'That is not a chat key.');
        }
        $replace = ($body['replace'] ?? false) === true;
        chat_locked($root, static function (string $dir) use ($uid, $pub, $replace): void {
            $keys = auth_read_json("$dir/keys.json", []);
            $old = $keys[$uid]['pub'] ?? null;
            if ($old === $pub) {
                return;
            }
            if ($old !== null && !$replace) {
                api_fail(409, 'You already have a chat key on another device or from before. Replacing it means your earlier messages can no longer be opened here.', ['exists' => true]);
            }
            $keys[$uid] = ['pub' => $pub, 'set' => time()];
            auth_write_json("$dir/keys.json", $keys);
            // A General key wrapped for the old key is no use to the new one; someone who holds it wraps it again.
            $general = auth_read_json("$dir/general.json", ['epoch' => 1, 'wraps' => []]);
            if (isset($general['wraps'][$uid])) {
                unset($general['wraps'][$uid]);
                auth_write_json("$dir/general.json", $general);
            }
        });
        api_json(['ok' => true]);
    }

    if ($op === 'wrap') {
        $for = body_str($body, 'user');
        $wrap = ['from' => $uid, 'fromPub' => body_str($body, 'fromPub'), 'toPub' => body_str($body, 'toPub'), 'iv' => body_str($body, 'iv'), 'ct' => body_str($body, 'ct')];
        if (!isset($users[$for]) || !chat_pub_ok($wrap['fromPub']) || !chat_pub_ok($wrap['toPub']) || !chat_b64($wrap['iv'], 12) || !chat_b64($wrap['ct'], 48)) {
            api_fail(400, 'That is not a General key for someone here.');
        }
        $epoch = (int) ($body['epoch'] ?? 0);
        $genesis = ($body['genesis'] ?? false) === true;
        chat_locked($root, static function (string $dir) use ($uid, $for, $wrap, $epoch, $genesis): void {
            $keys = auth_read_json("$dir/keys.json", []);
            $general = auth_read_json("$dir/general.json", ['epoch' => 1, 'wraps' => []]);
            if ($epoch !== (int) $general['epoch']) {
                api_fail(409, 'The General key was changed a moment ago. Chat will pick up the new one.', ['stale' => true]);
            }
            if (($keys[$uid]['pub'] ?? null) !== $wrap['fromPub']) {
                api_fail(409, 'Your chat key changed on another device. Close Chat and open it again.', ['stale' => true]);
            }
            if ($genesis) {
                if ($for !== $uid || count((array) $general['wraps']) > 0) {
                    api_fail(409, 'Someone started the General key a moment ago. Chat will pick it up.', ['stale' => true]);
                }
            } else {
                // Only someone who holds the key can hand it on, only to a person with a chat key, and never over a
                // key they already have (that would let one person swap in a key of their own for somebody else).
                if (!isset($general['wraps'][$uid])) {
                    api_fail(403, 'You do not hold the General key yet, so you cannot hand it on.');
                }
                if (!isset($keys[$for]) || isset($general['wraps'][$for])) {
                    api_fail(409, 'That person does not need the General key from you.', ['stale' => true]);
                }
            }
            // The wrap names the key it was made for. Made for a key that person has since replaced, it can never be
            // opened, yet it would mark them as holding the General key, and nobody would wrap it for them again.
            if (($keys[$for]['pub'] ?? null) !== $wrap['toPub']) {
                api_fail(409, 'That person\'s chat key changed a moment ago. Chat will hand the General key to the new one.', ['stale' => true]);
            }
            $general['wraps'][$for] = $wrap;
            auth_write_json("$dir/general.json", $general);
        });
        api_json(['ok' => true]);
    }

    if ($op === 'send') {
        $conv = chat_conv(body_str($body, 'conv'), $uid, $users);
        $iv = body_str($body, 'iv');
        $ct = body_str($body, 'ct');
        if (!chat_b64($iv, 12) || !chat_b64($ct, 0, CHAT_MAX_CT)) {
            api_fail(400, 'That message is too long to send in one go. Split it into shorter messages.');
        }
        $wait = rate_take($root, $uid, 'chat', 1200, 3600);
        if ($wait > 0) {
            api_fail(429, 'That is a lot of messages in an hour. Wait a few minutes, then carry on.', ['wait' => $wait]);
        }
        $epoch = (int) ($body['epoch'] ?? 0);
        $message = chat_locked($root, static function (string $dir) use ($uid, $conv, $iv, $ct, $epoch): array {
            $m = ['id' => 0, 'from' => $uid, 'at' => time(), 'iv' => $iv, 'ct' => $ct];
            if ($conv === 'general') {
                $general = auth_read_json("$dir/general.json", ['epoch' => 1, 'wraps' => []]);
                if ($epoch !== (int) $general['epoch'] || !isset($general['wraps'][$uid])) {
                    api_fail(409, 'The General key changed. Chat will pick up the new one; then send again.', ['stale' => true]);
                }
                $m['epoch'] = $epoch;
            }
            $c = chat_read_conv($dir, $conv);
            $m['id'] = $c['next'];
            $c['next']++;
            $c['messages'][] = $m;
            if (count($c['messages']) > CHAT_KEEP) {
                $c['messages'] = array_slice($c['messages'], -CHAT_KEEP);
            }
            $bytes = array_sum(array_map(static fn (array $x): int => strlen($x['ct']), $c['messages']));
            while ($bytes > CHAT_KEEP_BYTES && count($c['messages']) > 1) {
                $bytes -= strlen(array_shift($c['messages'])['ct']);
            }
            chat_write_conv($dir, $conv, $c);
            // Sending is reading: your own message never counts as unread, and nor does anything above it.
            $reads = auth_read_json("$dir/reads.json", []);
            $reads[$uid][$conv] = $m['id'];
            auth_write_json("$dir/reads.json", $reads);

            return $m;
        });
        api_json(['message' => $message]);
    }

    if ($op === 'read') {
        $conv = chat_conv(body_str($body, 'conv'), $uid, $users);
        $id = max(0, (int) ($body['id'] ?? 0));
        chat_locked($root, static function (string $dir) use ($uid, $conv, $id): void {
            $reads = auth_read_json("$dir/reads.json", []);
            if ($id > (int) ($reads[$uid][$conv] ?? 0)) {
                $reads[$uid][$conv] = $id;
                auth_write_json("$dir/reads.json", $reads);
            }
        });
        api_json(['ok' => true]);
    }

    if ($op === 'delete') {
        $conv = chat_conv(body_str($body, 'conv'), $uid, $users);
        $id = (int) ($body['id'] ?? 0);
        $mine = ($body['mine'] ?? false) === true;
        $all = ($body['all'] ?? false) === true;
        $owner = !empty($me['admin']);
        if ($all && !($owner && $conv === 'general')) {
            api_fail(403, 'Only the owner can clear General, and nobody can clear a Direct conversation for the other person: delete your own messages there.');
        }
        if (!$all && !$mine && $id < 1) {
            api_fail(400, 'Which message? Nothing was deleted.');
        }
        $count = chat_locked($root, static function (string $dir) use ($conv, $id, $mine, $all, $uid, $owner): int {
            $c = chat_read_conv($dir, $conv);
            $drop = [];
            foreach ($c['messages'] as $m) {
                $hit = $all || ($mine ? $m['from'] === $uid : (int) $m['id'] === $id);
                if (!$hit) {
                    continue;
                }
                // One message: the sender's own, or (in General) the owner's to remove.
                if (!$all && !$mine && $m['from'] !== $uid && !($owner && $conv === 'general')) {
                    api_fail(403, 'You can delete only your own messages.');
                }
                $drop[] = (int) $m['id'];
            }
            if (!$drop) {
                if (!$all && !$mine) {
                    api_fail(404, 'That message is no longer there (it was deleted, or it vanished with age).');
                }

                return 0;
            }
            $c['messages'] = array_values(array_filter($c['messages'], static fn (array $m): bool => !in_array((int) $m['id'], $drop, true)));
            // One delete is always remembered whole, however many messages it took (Clear General over a thousand): an
            // open screen told of only the last thousand would keep showing the rest until it reloaded.
            $c['gone'] = array_slice(array_merge($c['gone'], $drop), -max(CHAT_GONE_KEPT, count($drop)));
            $c['deletes'] += count($drop);
            chat_write_conv($dir, $conv, $c);

            return count($drop);
        });
        api_json(['ok' => true, 'deleted' => $count]);
    }

    if ($op === 'settings') {
        require_admin($me);
        $days = $body['vanishDays'] ?? null;
        if (!is_int($days) || !in_array($days, CHAT_VANISH_CHOICES, true)) {
            api_fail(400, 'Messages can vanish after 3, 7 or 30 days, or be kept until deleted (0).');
        }
        // Everyone's messages: the owner's own password (and code) first, so someone at the owner's unlocked, unattended
        // desktop cannot delete them.
        confirm_identity($root, $me, $body);
        chat_locked($root, static function (string $dir) use ($days): void {
            auth_write_json("$dir/settings.json", ['vanishDays' => $days]);
            // Older messages go from every conversation now, not only when each is next opened.
            chat_sweep_vanished($dir, true);
        });
        api_json(['ok' => true, 'vanishDays' => $days]);
    }

    if ($op === 'reset') {
        require_admin($me);
        // Everyone loses General's old messages: the owner's own password (and code) first, as above.
        confirm_identity($root, $me, $body);
        $epoch = chat_locked($root, static function (string $dir): int {
            $general = auth_read_json("$dir/general.json", ['epoch' => 1, 'wraps' => []]);
            $general = ['epoch' => (int) $general['epoch'] + 1, 'wraps' => []];
            auth_write_json("$dir/general.json", $general);

            return $general['epoch'];
        });
        api_json(['ok' => true, 'epoch' => $epoch]);
    }

    api_fail(400, 'Chat does not know that request.');
} catch (Throwable $error) {
    error_log('chat.php: ' . $error->getMessage());
    api_fail(500, 'Chat could not finish (the reason is in the server error log). Nothing was lost; try again.');
}
