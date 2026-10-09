<?php
// Mail for the Mail app: reads a mailbox over IMAP and sends over SMTP, for the signed-in person. Every request is a
// POST carrying the mailbox settings and password (kept in the person's own files, sealed with their key when file
// encryption is on); the server uses the password for this one request and keeps nothing.
//   op=test      sign in to both servers and say what worked
//   op=folders   every folder, its special use and its unread count
//   op=list      a page of message headers in a folder (newest first), or those matching search words
//   op=message   one whole message (base64), marked read
//   op=flag      read/unread, flagged
//   op=move      to another folder; op=delete: to the bin folder, or for good when already there
//   op=send      send (and put a copy in Sent, except where the provider does that itself)
// Each person has 900 requests an hour and 100 sent messages a day.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/mailnet.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$uid = (string) $user['id'];

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    api_fail(405, 'Mail requests are sent as POST.');
}
$op = (string) ($_GET['op'] ?? '');
// 18 MB of attachments is about 24 MB once base64-encoded in the request; more would not fit a 25 MB mail limit
// and would risk the host's 128 MB PHP memory limit while the message is built.
$max = $op === 'send' ? 26 * 1048576 : 65536;
$raw = (string) file_get_contents('php://input', false, null, 0, $max + 1);
if (strlen($raw) > $max) {
    api_fail(413, $op === 'send' ? 'That message with its attachments is over 18 MB of files. Mail servers such as Gmail refuse bigger messages; send the files in several messages.' : 'The request is too big.');
}
$body = json_decode($raw, true);
unset($raw);
if (!is_array($body)) {
    api_fail(400, 'The desktop sent a request the server could not read. Reload the page and try again.');
}
$wait = rate_take($root, $uid, 'mail', 900, 3600);
if ($wait > 0) {
    api_fail(429, 'That is a lot of mail requests in an hour. Wait a few minutes, then try again.', ['wait' => $wait]);
}

/** The mailbox settings from the request, checked. */
function mail_account(array $body): array
{
    $a = is_array($body['account'] ?? null) ? $body['account'] : [];
    $server = static function ($s, string $what): array {
        $s = is_array($s) ? $s : [];
        $host = strtolower(trim(body_str($s, 'host')));
        $port = (int) ($s['port'] ?? 0);
        $security = body_str($s, 'security');
        if ($host === '' || $port < 1 || $port > 65535 || !in_array($security, ['ssl', 'starttls', 'none'], true)) {
            api_fail(400, "The $what server settings are not complete.");
        }

        return [$host, $port, $security];
    };
    $userName = body_str($a, 'user');
    $password = body_str($a, 'password');
    if ($userName === '' || $password === '' || strlen($userName) > 320 || strlen($password) > 1024) {
        api_fail(400, 'The mailbox name and password are needed.');
    }

    return ['imap' => $server($a['imap'] ?? null, 'incoming (IMAP)'), 'smtp' => $server($a['smtp'] ?? null, 'sending (SMTP)'), 'user' => $userName, 'password' => $password];
}

function mail_uids(array $body): array
{
    $u = array_values(array_filter(array_map('intval', is_array($body['uids'] ?? null) ? $body['uids'] : []), static fn ($x) => $x > 0));
    if (!$u || count($u) > 500) {
        api_fail(400, 'Choose between 1 and 500 messages.');
    }

    return $u;
}

function mail_folder(array $body, string $key = 'folder'): string
{
    $f = body_str($body, $key);
    if ($f === '' || strlen($f) > 500 || preg_match('/[\r\n\0]/', $f)) {
        api_fail(400, 'That folder name cannot be used.');
    }

    return $f;
}

$acct = mail_account($body);
$imap = null;
$open = static function () use (&$imap, $acct): Imap {
    return $imap ??= new Imap($acct['imap'][0], $acct['imap'][1], $acct['imap'][2], $acct['user'], $acct['password']);
};

try {
    switch ($op) {
        case 'test':
            $result = ['imap' => null, 'smtp' => null];
            try {
                $result['imap'] = ['ok' => true, 'folders' => count($open()->folders())];
            } catch (MailError $e) {
                $result['imap'] = ['ok' => false, 'error' => $e->getMessage()];
            }
            try {
                $smtp = new Smtp($acct['smtp'][0], $acct['smtp'][1], $acct['smtp'][2], $acct['user'], $acct['password']);
                $smtp->quit();
                $result['smtp'] = ['ok' => true];
            } catch (MailError $e) {
                $result['smtp'] = ['ok' => false, 'error' => $e->getMessage()];
            }
            api_json($result);

        case 'folders':
            $folders = $open()->folders();
            foreach ($folders as $i => $f) {
                if ($i >= 60) {
                    break; // counts for the first 60 only; a huge folder tree is still listed
                }
                try {
                    foreach ($imap->cmd('STATUS ' . Imap::q($f['raw']) . ' (UNSEEN MESSAGES)') as $r) {
                        if (preg_match('/UNSEEN (\d+)/i', $r['text'], $m)) {
                            $folders[$i]['unread'] = (int) $m[1];
                        }
                        if (preg_match('/MESSAGES (\d+)/i', $r['text'], $m)) {
                            $folders[$i]['total'] = (int) $m[1];
                        }
                    }
                } catch (MailError) {
                    // A folder that cannot be counted is still listed.
                }
            }
            api_json(['folders' => $folders]);

        case 'list':
            $folder = mail_folder($body);
            [$exists, $validity] = $open()->select($folder, true);
            $words = trim(body_str($body, 'q'));
            if ($words !== '') {
                if (strlen($words) > 200 || preg_match('/[\r\n\0]/', $words)) {
                    api_fail(400, 'Search for up to 200 letters.');
                }
                $all = preg_match('/[^\x20-\x7e]/', $words) ? mail_search_literal($imap, $words) : $imap->uids('TEXT ' . Imap::q($words));
            } else {
                $all = $imap->uids();
            }
            $before = (int) ($body['before'] ?? 0);
            if ($before > 0) {
                $all = array_values(array_filter($all, static fn ($u) => $u < $before));
            }
            $page = array_slice($all, -50);
            api_json(['total' => $words === '' ? $exists : count($all), 'validity' => $validity, 'more' => count($all) > count($page), 'rows' => $imap->summaries($page)]);

        case 'message':
            $folder = mail_folder($body);
            $open()->select($folder);
            $msgUid = (int) ($body['uid'] ?? 0);
            if ($msgUid < 1) {
                api_fail(400, 'Which message?');
            }
            api_json(['raw' => base64_encode($imap->message($msgUid, !empty($body['peek'])))]);

        case 'flag':
            $open()->select(mail_folder($body));
            $flag = body_str($body, 'flag') === 'flagged' ? '\\Flagged' : '\\Seen';
            $imap->flag(mail_uids($body), $flag, !empty($body['on']));
            api_json(['ok' => true]);

        case 'move':
            $open()->select(mail_folder($body));
            $imap->move(mail_uids($body), mail_folder($body, 'to'));
            api_json(['ok' => true]);

        case 'delete':
            $folder = mail_folder($body);
            $trash = body_str($body, 'trash');
            $open()->select($folder);
            if ($trash === '' || $trash === $folder) {
                $imap->destroy(mail_uids($body));
                api_json(['ok' => true, 'forGood' => true]);
            }
            $imap->move(mail_uids($body), $trash);
            api_json(['ok' => true, 'forGood' => false]);

        case 'send':
            mail_send($root, $uid, $acct, $body, $open);

        default:
            api_fail(400, 'Unknown mail request.');
    }
} catch (MailError $e) {
    api_fail(502, $e->getMessage());
}
// (No logout step: every branch above ends the request with exit, which closes the connection.)

/** Search with words outside plain ASCII: the words go as a literal, as IMAP requires. */
function mail_search_literal(Imap $imap, string $words): array
{
    $uids = [];
    foreach ($imap->cmd('UID SEARCH CHARSET UTF-8 TEXT {' . strlen($words) . '}', [$words]) as $r) {
        if (preg_match('/^SEARCH\s*(.*)$/i', $r['text'], $m)) {
            foreach (preg_split('/\s+/', trim($m[1])) as $u) {
                if (ctype_digit($u)) {
                    $uids[] = (int) $u;
                }
            }
        }
    }
    sort($uids);

    return $uids;
}

function mail_send(string $root, string $uid, array $acct, array $body, callable $open): never
{
    $from = trim(body_str($body, 'from'));
    if (!mail_valid_address($from)) {
        api_fail(400, 'The “from” address is not a valid email address. Check it in the mail account settings.');
    }
    $list = static function (string $key) use ($body): array {
        $out = [];
        foreach (is_array($body[$key] ?? null) ? $body[$key] : [] as $a) {
            $a = trim((string) $a);
            if ($a === '') {
                continue;
            }
            if (!mail_valid_address($a)) {
                api_fail(400, "“{$a}” is not a valid email address.");
            }
            $out[] = $a;
        }

        return array_values(array_unique($out));
    };
    $to = $list('to');
    $cc = $list('cc');
    $bcc = $list('bcc');
    $all = array_values(array_unique([...$to, ...$cc, ...$bcc]));
    if (!$all) {
        api_fail(400, 'Add at least one address to send to.');
    }
    if (count($all) > 100) {
        api_fail(400, 'A message can go to at most 100 addresses.');
    }
    $attachments = [];
    foreach (is_array($body['attachments'] ?? null) ? $body['attachments'] : [] as $a) {
        $data = is_array($a) ? body_str($a, 'data') : '';
        if ($data === '' || !preg_match('#^[A-Za-z0-9+/]*={0,2}$#', $data)) {
            api_fail(400, 'An attachment could not be read.');
        }
        $type = body_str($a, 'type');
        $attachments[] = [
            'name' => mail_cut(body_str($a, 'name') ?: 'attachment', 150),
            'type' => preg_match('#^[a-z]+/[a-z0-9.+-]+$#iD', $type) ? $type : 'application/octet-stream',
            'data' => $data,
        ];
    }
    $refs = static fn (string $v) => preg_match('/^(<[^<>\s]{1,250}> ?){1,20}$/D', trim($v)) ? trim($v) : '';
    $message = mail_build([
        'from' => $from,
        'fromName' => mail_cut(body_str($body, 'fromName'), 100),
        'to' => $to,
        'cc' => $cc,
        'subject' => mail_cut(body_str($body, 'subject'), 500),
        'text' => body_str($body, 'text'),
        'inReplyTo' => $refs(body_str($body, 'inReplyTo')),
        'references' => $refs(body_str($body, 'references')),
        'attachments' => $attachments,
    ]);
    $wait = rate_take($root, $uid, 'mail-send', 100, 86400);
    if ($wait > 0) {
        api_fail(429, 'That is 100 messages sent today, the most each person can send from this desktop. Try again tomorrow.', ['wait' => $wait]);
    }
    $smtp = new Smtp($acct['smtp'][0], $acct['smtp'][1], $acct['smtp'][2], $acct['user'], $acct['password']);
    try {
        $smtp->deliver($from, $all, $message);
    } finally {
        $smtp->quit();
    }
    // Sent. Now the copy in Sent: a failure here is reported, but the message has gone.
    $copy = 'skipped';
    $sent = body_str($body, 'sentFolder');
    if ($sent !== '' && empty($body['providerSavesSent'])) {
        try {
            $open()->append($sent, $message);
            $copy = 'saved';
        } catch (MailError $e) {
            $copy = 'failed: ' . $e->getMessage();
        }
    }
    api_json(['sent' => true, 'recipients' => count($all), 'copy' => $copy]);
}
