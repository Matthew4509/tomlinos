<?php
// Mail over the network for api/mail.php: a small IMAP client (read) and SMTP client (send), our own code (PHP's
// imap extension left PHP in 8.4). The mailbox password arrives with each request, is used for that request only,
// and is never written anywhere or put in a message.
//
// Where the server may connect is limited, because the host name comes from the person: only the usual mail ports,
// never an address inside the server's own network (127.x, 10.x, 192.168.x, the cloud metadata address...), always
// with the certificate checked, and to the address the name was checked for (a name cannot change address between
// the check and the connection). An owner running their own mail on their network lists it in config
// 'mail_allow_hosts'; only hosts listed there may use an unencrypted connection, and only if 'mail_allow_plain' is on.
declare(strict_types=1);

final class MailError extends RuntimeException
{
}

const MAIL_PORTS = [143, 993, 465, 587, 25, 2525];
const MAIL_MAX_MESSAGE = 25 * 1024 * 1024;

/**
 * True for an address on the public internet. IPv4: not private, reserved, loopback, link-local or carrier-shared
 * (100.64/10). IPv6: only ordinary global addresses (2000::/3), and an IPv4 address carried inside one (::ffff:,
 * 6to4 2002::, NAT64 64:ff9b::) is judged as that IPv4 address (so 64:ff9b::7f00:1 cannot slip through).
 */
function mail_public_ip(string $ip): bool
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false
            && !preg_match('/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./', $ip);
    }
    $bin = @inet_pton($ip);
    if ($bin === false || strlen($bin) !== 16) {
        return false;
    }
    $embedded = null;
    if (str_starts_with($bin, str_repeat("\0", 10) . "\xff\xff")) {
        $embedded = substr($bin, 12, 4);
    } elseif (str_starts_with($bin, "\x00\x64\xff\x9b")) {
        $embedded = substr($bin, 12, 4);
    } elseif (str_starts_with($bin, "\x20\x02")) {
        $embedded = substr($bin, 2, 4);
    }
    if ($embedded !== null) {
        return mail_public_ip((string) inet_ntop($embedded));
    }
    if ((ord($bin[0]) & 0xE0) !== 0x20) {
        return false; // outside 2000::/3: loopback, link-local, unique-local, multicast, and the rest
    }

    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
}

/** A public address for $host, or a refusal. Returns [ip, allowedPlain]. */
function mail_resolve(string $host, int $port, string $security): array
{
    $config = api_config();
    $listed = in_array(strtolower($host) . ':' . $port, array_map('strtolower', (array) ($config['mail_allow_hosts'] ?? [])), true);
    if (!$listed && !in_array($port, MAIL_PORTS, true)) {
        throw new MailError("Port $port is not a mail port. Use 993 (IMAP, secure), 143 (IMAP with STARTTLS), 465 or 587 (sending).");
    }
    if (!preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i', $host) && !filter_var($host, FILTER_VALIDATE_IP)) {
        throw new MailError("“{$host}” is not a server name.");
    }
    $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
    if (!$ips) {
        throw new MailError("The mail server “{$host}” could not be found. Check the name.");
    }
    foreach ($ips as $ip) {
        $public = mail_public_ip($ip);
        if ($public || $listed) {
            if ($security === 'none' && !($listed && !empty($config['mail_allow_plain']))) {
                throw new MailError('This desktop only connects to mail servers over an encrypted connection (SSL/TLS or STARTTLS).');
            }

            return [$ip, $listed];
        }
    }
    throw new MailError("“{$host}” points inside the server's own network, so this desktop will not connect to it. (An owner running their own mail server lists it in mail_allow_hosts.)");
}

/** A line-based connection with TLS, a deadline, and a cap on what is read. */
final class MailLine
{
    /** @var resource */
    private $s;
    private string $host;
    private int $deadline;

    public function __construct(string $host, int $port, string $security, int $seconds = 25)
    {
        [$ip] = mail_resolve($host, $port, $security);
        $this->host = $host;
        $this->deadline = time() + $seconds;
        if (!extension_loaded('openssl') && $security !== 'none') {
            throw new MailError('This server\'s PHP has no secure-connection support (the openssl extension is off). The owner can switch it on in the host\'s PHP settings.');
        }
        $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host, 'SNI_enabled' => true]]);
        $target = ($security === 'ssl' ? 'ssl://' : 'tcp://') . (str_contains($ip, ':') ? "[$ip]" : $ip) . ':' . $port;
        $s = @stream_socket_client($target, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $context);
        if ($s === false) {
            throw new MailError(str_contains((string) $errstr, 'certificate')
                ? "The mail server “{$host}” did not show a valid certificate, so the connection was stopped (your password was not sent)."
                : "The mail server “{$host}” did not answer on port $port. Check the server name, the port and the security setting.");
        }
        stream_set_timeout($s, 15);
        $this->s = $s;
    }

    public function startTls(): void
    {
        if (!@stream_socket_enable_crypto($this->s, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
            throw new MailError("The mail server “{$this->host}” did not show a valid certificate, so the connection was stopped (your password was not sent).");
        }
    }

    public function write(string $data): void
    {
        $this->check();
        for ($done = 0; $done < strlen($data);) {
            $n = @fwrite($this->s, substr($data, $done, 65536));
            if ($n === false || $n === 0) {
                throw new MailError('The connection to the mail server dropped.');
            }
            $done += $n;
        }
    }

    public function line(int $max = 1048576): string
    {
        $this->check();
        $line = fgets($this->s, $max);
        if ($line === false) {
            throw new MailError(stream_get_meta_data($this->s)['timed_out'] ? 'The mail server took too long to answer.' : 'The connection to the mail server dropped.');
        }

        return $line;
    }

    public function bytes(int $n): string
    {
        if ($n > MAIL_MAX_MESSAGE) {
            throw new MailError("That message is over 25 MB, the most this desktop reads at once (read it on your provider's own mail page).");
        }
        $out = '';
        while (strlen($out) < $n) {
            $this->check();
            $chunk = fread($this->s, min(65536, $n - strlen($out)));
            if ($chunk === false || $chunk === '') {
                throw new MailError('The connection to the mail server dropped.');
            }
            $out .= $chunk;
        }

        return $out;
    }

    private function check(): void
    {
        if (time() > $this->deadline) {
            throw new MailError('The mail server is taking too long. Try again; a very full folder may need a moment.');
        }
    }

    public function close(): void
    {
        if (is_resource($this->s)) {
            @fclose($this->s);
        }
    }
}

// ---- IMAP ----------------------------------------------------------------------------------------------------------

final class Imap
{
    private MailLine $c;
    private int $n = 0;
    /** @var string[] */
    public array $caps = [];

    public function __construct(string $host, int $port, string $security, string $user, string $password)
    {
        $this->c = new MailLine($host, $port, $security);
        $greeting = $this->c->line();
        if (!str_starts_with($greeting, '* OK') && !str_starts_with($greeting, '* PREAUTH')) {
            throw new MailError('That server did not answer like a mail (IMAP) server.');
        }
        if ($security === 'starttls') {
            $this->cmd('STARTTLS');
            $this->c->startTls();
        }
        $this->caps = $this->capabilities();
        if (in_array('LOGINDISABLED', $this->caps, true)) {
            throw new MailError('The mail server does not accept a password on this connection. Choose SSL/TLS or STARTTLS.');
        }
        $plain = base64_encode("\0" . $user . "\0" . $password);
        try {
            if (in_array('AUTH=PLAIN', $this->caps, true)) {
                if (in_array('SASL-IR', $this->caps, true)) {
                    $this->cmd('AUTHENTICATE PLAIN ' . $plain);
                } else {
                    $this->cmd('AUTHENTICATE PLAIN', [$plain]);
                }
            } else {
                $this->cmd('LOGIN ' . self::q($user) . ' ' . self::q($password));
            }
        } catch (MailError $e) {
            throw new MailError('The mail server refused the name or password. ' . self::hint($host) . ' (It said: ' . $e->getMessage() . ')');
        }
        $this->caps = $this->capabilities();
    }

    private static function hint(string $host): string
    {
        $h = strtolower($host);
        if (str_contains($h, 'gmail') || str_contains($h, 'google')) {
            return 'Gmail needs an "app password" here (Google Account > Security > 2-Step Verification > App passwords), not your normal password.';
        }
        if (str_contains($h, 'outlook') || str_contains($h, 'hotmail') || str_contains($h, 'office365') || str_contains($h, 'live.com')) {
            return 'Outlook.com and Hotmail no longer accept passwords from mail apps (Microsoft requires its own sign-in, which this desktop does not have yet).';
        }
        if (str_contains($h, 'yahoo') || str_contains($h, 'icloud') || str_contains($h, 'me.com') || str_contains($h, 'aol')) {
            return 'This provider needs an "app password" made in its account settings, not your normal password.';
        }

        return 'Check the user name (often the whole email address) and the password.';
    }

    private function capabilities(): array
    {
        $caps = [];
        foreach ($this->cmd('CAPABILITY') as $line) {
            if (preg_match('/^CAPABILITY (.*)$/i', $line['text'], $m)) {
                $caps = array_map('strtoupper', preg_split('/\s+/', trim($m[1])));
            }
        }

        return $caps;
    }

    /** IMAP quoted string (names and passwords with quotes or backslashes are escaped; line breaks are refused). */
    public static function q(string $s): string
    {
        if (preg_match('/[\r\n\0]/', $s)) {
            throw new MailError('A name or password cannot contain line breaks.');
        }

        return '"' . addcslashes($s, '"\\') . '"';
    }

    /** Folder names as IMAP wants them: modified UTF-7. */
    public static function utf7(string $s): string
    {
        return function_exists('mb_convert_encoding') ? mb_convert_encoding($s, 'UTF7-IMAP', 'UTF-8') : $s;
    }

    /** A folder name from the server, as readable text (plain names pass through when mbstring is missing). */
    public static function fromUtf7(string $s): string
    {
        return function_exists('mb_convert_encoding') && str_contains($s, '&') ? mb_convert_encoding($s, 'UTF-8', 'UTF7-IMAP') : $s;
    }

    /**
     * Sends a command; returns the untagged responses, each ['text' => line with literals replaced by \0Ln\0 markers,
     * 'lits' => literal strings]. Throws MailError with the server's words on NO or BAD. $continue holds lines to
     * send after each "+" the server asks for.
     */
    public function cmd(string $command, array $continue = []): array
    {
        $tag = 'A' . (++$this->n);
        $this->c->write("$tag $command\r\n");
        $out = [];
        for (;;) {
            $line = $this->c->line();
            if (str_starts_with($line, '+')) {
                $this->c->write((array_shift($continue) ?? '') . "\r\n");
                continue;
            }
            $lits = [];
            // A line ending in {n} is followed by n bytes, then the rest of the line.
            while (preg_match('/\{(\d+)\}\r\n$/', $line, $m)) {
                $lits[] = $this->c->bytes((int) $m[1]);
                $line = substr($line, 0, -strlen($m[0])) . "\0L" . (count($lits) - 1) . "\0" . $this->c->line();
            }
            $line = rtrim($line, "\r\n");
            if (str_starts_with($line, "$tag ")) {
                $rest = substr($line, strlen($tag) + 1);
                if (!preg_match('/^OK\b/i', $rest)) {
                    throw new MailError(trim((string) preg_replace('/^(NO|BAD)\s*(\[[^\]]*\]\s*)?/i', '', $rest)) ?: 'The mail server said no.');
                }

                return $out;
            }
            if (str_starts_with($line, '* ')) {
                $out[] = ['text' => substr($line, 2), 'lits' => $lits];
            } elseif ($out) {
                $out[count($out) - 1]['text'] .= $line;
            }
        }
    }

    /** Splits one response into tokens: atoms, quoted strings, literals, NIL (null) and nested lists. */
    public static function parse(string $text, array $lits): array
    {
        $i = 0;
        $n = strlen($text);
        $read = static function () use (&$read, &$i, $n, $text, $lits): array {
            $list = [];
            while ($i < $n) {
                $ch = $text[$i];
                if ($ch === ' ') {
                    $i++;
                } elseif ($ch === '(') {
                    $i++;
                    $list[] = $read();
                } elseif ($ch === ')') {
                    $i++;

                    return $list;
                } elseif ($ch === '"') {
                    $s = '';
                    for ($i++; $i < $n && $text[$i] !== '"'; $i++) {
                        if ($text[$i] === '\\' && $i + 1 < $n) {
                            $i++;
                        }
                        $s .= $text[$i];
                    }
                    $i++;
                    $list[] = $s;
                } elseif ($ch === "\0") {
                    $end = strpos($text, "\0", $i + 1);
                    $list[] = $lits[(int) substr($text, $i + 2, $end - $i - 2)] ?? '';
                    $i = $end + 1;
                } else {
                    $s = '';
                    $depth = 0;
                    while ($i < $n) {
                        $c = $text[$i];
                        if ($c === '[') {
                            $depth++;
                        } elseif ($c === ']') {
                            $depth--;
                        } elseif ($depth === 0 && ($c === ' ' || $c === '(' || $c === ')')) {
                            break;
                        }
                        $s .= $c;
                        $i++;
                    }
                    $list[] = strtoupper($s) === 'NIL' ? null : $s;
                }
            }

            return $list;
        };

        return $read();
    }

    /** Every folder: name (UTF-8), the raw name, its special use (inbox, sent, drafts, trash, junk, archive). */
    public function folders(): array
    {
        $out = [];
        foreach ($this->cmd('LIST "" "*"') as $r) {
            if (!preg_match('/^LIST /i', $r['text'])) {
                continue;
            }
            $t = self::parse(substr($r['text'], 5), $r['lits']);
            $flags = array_map('strtolower', (array) ($t[0] ?? []));
            $raw = (string) ($t[2] ?? '');
            if (in_array('\\noselect', $flags, true) || in_array('\\nonexistent', $flags, true)) {
                continue;
            }
            $use = strtoupper($raw) === 'INBOX' ? 'inbox' : null;
            foreach (['sent', 'drafts', 'trash', 'junk', 'archive', 'flagged', 'all'] as $u) {
                if (in_array('\\' . $u, $flags, true)) {
                    $use = $u;
                }
            }
            $out[] = ['name' => self::fromUtf7($raw), 'raw' => $raw, 'delim' => (string) ($t[1] ?? '/'), 'use' => $use];
        }

        return $out;
    }

    /** Opens a folder; returns [count of messages, uidvalidity]. */
    public function select(string $raw, bool $readOnly = false): array
    {
        $exists = 0;
        $validity = 0;
        foreach ($this->cmd(($readOnly ? 'EXAMINE ' : 'SELECT ') . self::q($raw)) as $r) {
            if (preg_match('/^(\d+) EXISTS/i', $r['text'], $m)) {
                $exists = (int) $m[1];
            } elseif (preg_match('/UIDVALIDITY (\d+)/i', $r['text'], $m)) {
                $validity = (int) $m[1];
            }
        }

        return [$exists, $validity];
    }

    /** @return int[] */
    public function uids(string $criteria = 'ALL'): array
    {
        $uids = [];
        foreach ($this->cmd('UID SEARCH ' . $criteria) as $r) {
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

    /** Header lines, flags, size and date of the given messages, newest first. */
    public function summaries(array $uids): array
    {
        if (!$uids) {
            return [];
        }
        $set = implode(',', array_map('intval', $uids));
        $rows = [];
        foreach ($this->cmd("UID FETCH $set (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])") as $r) {
            if (!preg_match('/^\d+ FETCH /i', $r['text'])) {
                continue;
            }
            $t = self::parse((string) preg_replace('/^\d+ FETCH /i', '', $r['text']), $r['lits'])[0] ?? [];
            $f = [];
            for ($i = 0; $i + 1 < count($t); $i += 2) {
                $f[strtoupper((string) $t[$i])] = $t[$i + 1];
            }
            $head = '';
            foreach ($f as $k => $v) {
                if (str_starts_with($k, 'BODY[')) {
                    $head = (string) $v;
                }
            }
            $rows[] = [
                'uid' => (int) ($f['UID'] ?? 0),
                'flags' => array_values(array_map('strval', (array) ($f['FLAGS'] ?? []))),
                'size' => (int) ($f['RFC822.SIZE'] ?? 0),
                'date' => (string) ($f['INTERNALDATE'] ?? ''),
                'head' => $head,
            ];
        }
        usort($rows, static fn ($a, $b) => $b['uid'] <=> $a['uid']);

        return $rows;
    }

    /** The whole message, as sent (the browser reads its parts). Marks it read unless $peek. */
    public function message(int $uid, bool $peek = false): string
    {
        foreach ($this->cmd('UID FETCH ' . $uid . ' (UID RFC822.SIZE BODY' . ($peek ? '.PEEK' : '') . '[])') as $r) {
            if (preg_match('/^\d+ FETCH /i', $r['text'])) {
                $t = self::parse((string) preg_replace('/^\d+ FETCH /i', '', $r['text']), $r['lits'])[0] ?? [];
                for ($i = 0; $i + 1 < count($t); $i += 2) {
                    if (strtoupper((string) $t[$i]) === 'BODY[]') {
                        return (string) $t[$i + 1];
                    }
                }
            }
        }
        throw new MailError('That message is not there any more. It may have been moved or deleted in another mail app.');
    }

    public function flag(array $uids, string $flag, bool $on): void
    {
        if (!in_array($flag, ['\\Seen', '\\Flagged'], true)) {
            throw new MailError('Unknown flag.');
        }
        $this->cmd('UID STORE ' . implode(',', array_map('intval', $uids)) . ($on ? ' +' : ' -') . 'FLAGS.SILENT (' . $flag . ')');
    }

    /** Moves messages to another folder (MOVE when the server has it; otherwise copy, mark deleted, expunge). */
    public function move(array $uids, string $toRaw): void
    {
        $set = implode(',', array_map('intval', $uids));
        if (in_array('MOVE', $this->caps, true)) {
            $this->cmd("UID MOVE $set " . self::q($toRaw));

            return;
        }
        $this->cmd("UID COPY $set " . self::q($toRaw));
        $this->cmd("UID STORE $set +FLAGS.SILENT (\\Deleted)");
        $this->cmd(in_array('UIDPLUS', $this->caps, true) ? "UID EXPUNGE $set" : 'EXPUNGE');
    }

    /** Deletes for good (used in the Trash folder itself). */
    public function destroy(array $uids): void
    {
        $set = implode(',', array_map('intval', $uids));
        $this->cmd("UID STORE $set +FLAGS.SILENT (\\Deleted)");
        $this->cmd(in_array('UIDPLUS', $this->caps, true) ? "UID EXPUNGE $set" : 'EXPUNGE');
    }

    /** Adds a message to a folder (a copy of sent mail in Sent). */
    public function append(string $raw, string $message, string $flags = '\\Seen'): void
    {
        $this->cmd('APPEND ' . self::q($raw) . " ($flags) {" . strlen($message) . '}', [$message]);
    }

    public function logout(): void
    {
        try {
            $this->cmd('LOGOUT');
        } catch (MailError) {
            // Closing anyway.
        }
        $this->c->close();
    }
}

// ---- SMTP ----------------------------------------------------------------------------------------------------------

final class Smtp
{
    private MailLine $c;

    public function __construct(string $host, int $port, string $security, string $user, string $password)
    {
        $this->c = new MailLine($host, $port, $security);
        $this->expect(220, 'That server did not answer like a mail-sending (SMTP) server.');
        $ext = $this->ehlo();
        if ($security === 'starttls') {
            if (!isset($ext['STARTTLS'])) {
                throw new MailError('The sending server does not offer STARTTLS on this port. Try port 465 with SSL/TLS.');
            }
            $this->send('STARTTLS', 220);
            $this->c->startTls();
            $ext = $this->ehlo();
        }
        $auth = strtoupper($ext['AUTH'] ?? '');
        try {
            if (str_contains($auth, 'PLAIN')) {
                $this->send('AUTH PLAIN ' . base64_encode("\0$user\0$password"), 235);
            } elseif (str_contains($auth, 'LOGIN')) {
                $this->send('AUTH LOGIN', 334);
                $this->send(base64_encode($user), 334);
                $this->send(base64_encode($password), 235);
            } else {
                throw new MailError('The sending server offers no way to sign in that this desktop knows.');
            }
        } catch (MailError $e) {
            throw new MailError('The sending server refused the name or password. (It said: ' . $e->getMessage() . ')');
        }
    }

    private function ehlo(): array
    {
        $lines = $this->send('EHLO tomlinos.local', 250);
        $ext = [];
        foreach (array_slice($lines, 1) as $l) {
            $parts = explode(' ', trim(substr($l, 4)), 2);
            $ext[strtoupper($parts[0])] = $parts[1] ?? '';
        }

        return $ext;
    }

    /** @return string[] the reply lines */
    private function reply(): array
    {
        $lines = [];
        do {
            $l = $this->c->line(4096);
            $lines[] = rtrim($l, "\r\n");
        } while (strlen($l) > 3 && $l[3] === '-');

        return $lines;
    }

    private function expect(int $code, string $message): array
    {
        $lines = $this->reply();
        if ((int) substr($lines[0], 0, 3) !== $code) {
            throw new MailError($message . ' (' . substr(end($lines), 4) . ')');
        }

        return $lines;
    }

    private function send(string $line, int $code): array
    {
        $this->c->write($line . "\r\n");
        $lines = $this->reply();
        if ((int) substr($lines[0], 0, 3) !== $code) {
            throw new MailError(trim(substr(end($lines), 4)) ?: 'The sending server said no.');
        }

        return $lines;
    }

    /** Hands the message to the server. Returns only when it accepted it (250 after the message). */
    public function deliver(string $from, array $to, string $message): void
    {
        $this->send('MAIL FROM:<' . $from . '>', 250);
        foreach ($to as $rcpt) {
            $this->c->write('RCPT TO:<' . $rcpt . ">\r\n");
            $lines = $this->reply();
            $code = (int) substr($lines[0], 0, 3);
            if ($code !== 250 && $code !== 251) {
                throw new MailError("The sending server refused the address $rcpt: " . trim(substr(end($lines), 4)));
            }
        }
        $this->send('DATA', 354);
        // A line that starts with a dot gets a second dot, so it cannot end the message early.
        $this->c->write((string) preg_replace('/^\./m', '..', $message) . "\r\n.\r\n");
        $lines = $this->reply();
        if ((int) substr($lines[0], 0, 3) !== 250) {
            throw new MailError('The sending server did not accept the message: ' . trim(substr(end($lines), 4)));
        }
    }

    public function quit(): void
    {
        try {
            $this->c->write("QUIT\r\n");
        } catch (MailError) {
            // Closing anyway.
        }
        $this->c->close();
    }
}

// ---- Building a message to send ------------------------------------------------------------------------------------

/** A header word, encoded when it is not plain ASCII (RFC 2047). */
function mail_header_text(string $s): string
{
    $s = (string) preg_replace('/[\r\n\0]+/', ' ', $s);
    if (!preg_match('/[^\x20-\x7e]/', $s)) {
        return $s;
    }
    $out = [];
    // Split on whole characters so no letter is cut in half between encoded words.
    foreach (preg_split('/(?<=.{30})/us', $s, -1, PREG_SPLIT_NO_EMPTY) ?: [$s] as $chunk) {
        $out[] = '=?UTF-8?B?' . base64_encode($chunk) . '?=';
    }

    return implode("\r\n ", $out);
}

/** "Name <a@b.c>" from a checked address and an optional name. */
function mail_address(string $email, string $name = ''): string
{
    $name = trim($name);
    if ($name === '') {
        return $email;
    }
    $shown = preg_match('/^[\w .\'-]+$/u', $name) && !preg_match('/[^\x20-\x7e]/', $name) ? '"' . addcslashes($name, '"\\') . '"' : mail_header_text($name);

    return $shown . ' <' . $email . '>';
}

/** The first $n characters (whole letters, never half of one), with no mbstring needed. */
function mail_cut(string $s, int $n): string
{
    return preg_match('//u', $s) ? (string) preg_replace('/^(.{0,' . $n . '}).*$/us', '$1', $s) : substr($s, 0, $n);
}

function mail_valid_address(string $a): bool
{
    return strlen($a) <= 254 && (bool) preg_match('/^[A-Za-z0-9.!#$%&\'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/', $a);
}

/**
 * The message, ready to send. $m: from, fromName, to[], cc[], subject, text, inReplyTo, references,
 * attachments[] of ['name', 'type', 'data' (base64)]. Returns [message, envelope recipients].
 */
function mail_build(array $m): string
{
    $eol = "\r\n";
    $domain = substr(strrchr($m['from'], '@') ?: '@tomlinos.local', 1);
    $h = [
        'Date: ' . date(DATE_RFC2822),
        'From: ' . mail_address($m['from'], $m['fromName'] ?? ''),
        'To: ' . implode(', ', $m['to']),
    ];
    if ($m['cc']) {
        $h[] = 'Cc: ' . implode(', ', $m['cc']);
    }
    $h[] = 'Subject: ' . mail_header_text($m['subject']);
    $h[] = 'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>';
    if (!empty($m['inReplyTo'])) {
        $h[] = 'In-Reply-To: ' . $m['inReplyTo'];
        $h[] = 'References: ' . trim(($m['references'] ?? '') . ' ' . $m['inReplyTo']);
    }
    $h[] = 'MIME-Version: 1.0';
    $h[] = 'X-Mailer: TOMLIN OS Mail';
    $text = (string) preg_replace('/\r\n?|\n/', $eol, $m['text']);
    $textPart = 'Content-Type: text/plain; charset=UTF-8' . $eol . 'Content-Transfer-Encoding: quoted-printable' . $eol . $eol . quoted_printable_encode($text);
    if (!$m['attachments']) {
        return implode($eol, $h) . $eol . $textPart . $eol;
    }
    $b = '=_tomlinos_' . bin2hex(random_bytes(10));
    $h[] = 'Content-Type: multipart/mixed; boundary="' . $b . '"';
    $body = '--' . $b . $eol . $textPart . $eol;
    foreach ($m['attachments'] as $a) {
        $name = mail_header_text((string) preg_replace('/["\\\\\r\n]/', '_', $a['name']));
        $body .= '--' . $b . $eol
            . 'Content-Type: ' . $a['type'] . '; name="' . $name . '"' . $eol
            . 'Content-Transfer-Encoding: base64' . $eol
            . 'Content-Disposition: attachment; filename="' . $name . '"' . $eol . $eol
            . chunk_split($a['data'], 76, $eol);
    }
    $body .= '--' . $b . '--' . $eol;

    return implode($eol, $h) . $eol . $eol . $body;
}
