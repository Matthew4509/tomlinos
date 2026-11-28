<?php
// Fetching a calendar a person subscribes to by its link (Google's "Secret address in iCal format", Outlook's ICS
// link, an iCloud public calendar), for api/calendar.php. The page cannot fetch another site itself (the browser
// blocks it), so this server does, and because the address comes from the person it is held tightly:
//   - https only, on the usual port, with the certificate checked; no name and password in the address;
//   - never an address inside the server's own network (127.x, 10.x, 192.168.x, the cloud metadata address...): the
//     name is looked up once, checked, and the connection made to that same address, so it cannot change in between;
//   - a redirect is followed only a few times, each new address checked the same way;
//   - at most ICAL_MAX_BYTES read, and a firm time limit;
//   - what comes back must be an iCalendar file.
// The address can be a secret (Google's private address), so it is never written to a log or a message.
// An owner whose calendars live on their own network lists them in config 'ical_allow_hosts' ('host:port'); only
// listed hosts may be on a private address or use plain http. The tests set it for a stand-in on 127.0.0.1.
declare(strict_types=1);

require_once __DIR__ . '/mailnet.php';

final class IcalFetchError extends RuntimeException
{
}

const ICAL_MAX_BYTES = 4 * 1024 * 1024;
const ICAL_MAX_REDIRECTS = 3;

/** The seconds a fetch may take in all (the tests may lower it, never raise it). */
function ical_timeout(): int
{
    $test = (int) getenv('DESKTOP_ICAL_TIMEOUT');

    return $test > 0 ? min(20, $test) : 20;
}

/**
 * Checks an address and says where to connect: [url, host, port, ip]. webcal:// (Apple's and Outlook's links) is
 * https. Throws IcalFetchError in words.
 */
function ical_target(string $url): array
{
    $url = trim($url);
    if (strlen($url) > 2000) {
        throw new IcalFetchError('That link is too long to be a calendar address.');
    }
    if (preg_match('#^webcals?://#i', $url)) {
        $url = 'https://' . substr($url, strpos($url, '://') + 3);
    }
    if (preg_match('/[\x00-\x20\x7f]/', $url)) {
        throw new IcalFetchError('That link has spaces or hidden characters in it. Copy it again.');
    }
    $p = parse_url($url);
    if (!is_array($p) || !isset($p['scheme'], $p['host'])) {
        throw new IcalFetchError('That is not a web address. Copy the whole link, starting with https://.');
    }
    $scheme = strtolower((string) $p['scheme']);
    $host = strtolower(trim((string) $p['host'], '[]'));
    if (isset($p['user']) || isset($p['pass'])) {
        throw new IcalFetchError('Links with a name and password in them are not fetched. Use the calendar\'s own iCal or ICS link.');
    }
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'http' ? 80 : 443);
    $config = api_config();
    $listed = in_array($host . ':' . $port, array_map('strtolower', (array) ($config['ical_allow_hosts'] ?? [])), true);
    if ($scheme !== 'https' && !($scheme === 'http' && $listed)) {
        throw new IcalFetchError('Only secure links (starting with https:// or webcal://) can be added.');
    }
    if (!$listed && $port !== 443) {
        throw new IcalFetchError('Calendar links on other ports than the usual one are not fetched.');
    }
    $isIp = filter_var($host, FILTER_VALIDATE_IP) !== false;
    if (!$isIp && !preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/', $host)) {
        throw new IcalFetchError('That link does not name a web site this server can look up.');
    }
    $ips = $isIp ? [$host] : ical_lookup($host);
    if (!$ips) {
        throw new IcalFetchError('The site in that link could not be found. Check the link.');
    }
    // Every address the name gives must be public: a name that also points inside the network is refused whole, so a
    // second lookup by anything else can never land there.
    foreach ($ips as $ip) {
        if (!$listed && !mail_public_ip($ip)) {
            throw new IcalFetchError('That link points inside the server\'s own network, so it is not fetched.');
        }
    }

    return [$url, $host, $port, $ips[0]];
}

/** The addresses a name has (IPv4 and IPv6). The tests can answer for a made-up name (DESKTOP_ICAL_TEST_DNS: "name=ip,..."). */
function ical_lookup(string $host): array
{
    foreach (array_filter(explode(',', (string) getenv('DESKTOP_ICAL_TEST_DNS'))) as $pair) {
        [$name, $ip] = array_pad(explode('=', $pair, 2), 2, '');
        if (strtolower($name) === $host) {
            return [$ip];
        }
    }
    $ips = gethostbynamel($host) ?: [];
    if (function_exists('dns_get_record')) {
        foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $r) {
            if (!empty($r['ipv6'])) {
                $ips[] = (string) $r['ipv6'];
            }
        }
    }

    return array_values(array_unique($ips));
}

/**
 * The calendar file at a link, as text (UTF-8). Follows at most ICAL_MAX_REDIRECTS redirects, each checked afresh.
 * Throws IcalFetchError in words for the person.
 */
function ical_fetch(string $url): string
{
    if (!function_exists('curl_init')) {
        throw new IcalFetchError('This server\'s PHP has no "curl" extension, which fetching a calendar needs. The owner ticks "curl" in the host\'s PHP extensions.');
    }
    $deadline = microtime(true) + ical_timeout();
    for ($hop = 0; $hop <= ICAL_MAX_REDIRECTS; $hop++) {
        [$url, $host, $port, $ip] = ical_target($url);
        $left = (int) ceil($deadline - microtime(true));
        if ($left <= 0) {
            throw new IcalFetchError('The calendar\'s site took too long to answer. Try again later.');
        }
        [$status, $body, $next, $type] = ical_get($url, $host, $port, $ip, $left);
        if ($status >= 300 && $status < 400) {
            if ($next === '') {
                throw new IcalFetchError('The calendar\'s site sent the request on without saying where.');
            }
            $url = $next;
            continue;
        }
        if ($status === 401 || $status === 403) {
            throw new IcalFetchError('The calendar\'s site refused (' . $status . '). The link may be private to a signed-in account, or it was reset: copy it again.');
        }
        if ($status === 404 || $status === 410) {
            throw new IcalFetchError('The calendar\'s site has no calendar at that link (' . $status . '). It may have been deleted or the link reset.');
        }
        if ($status !== 200) {
            throw new IcalFetchError('The calendar\'s site answered with an error (' . $status . '). Try again later.');
        }
        $text = ical_text($body);
        if (!preg_match('/^\s*BEGIN:VCALENDAR\b/i', $text)) {
            throw new IcalFetchError(stripos($type, 'html') !== false || preg_match('/^\s*</', $text)
                ? 'That link opens a web page, not a calendar file. Use the calendar\'s iCal or ICS link (for Google Calendar, the "Secret address in iCal format").'
                : 'What that link gives is not a calendar file (iCalendar).');
        }

        return $text;
    }
    throw new IcalFetchError('The calendar\'s site sent the request on too many times, so it stopped.');
}

/** The body as UTF-8 text: a byte-order mark dropped, UTF-16 turned to UTF-8, bytes that are not UTF-8 read as Latin-1. */
function ical_text(string $body): string
{
    if (str_starts_with($body, "\xEF\xBB\xBF")) {
        return substr($body, 3);
    }
    if (str_starts_with($body, "\xFF\xFE") || str_starts_with($body, "\xFE\xFF")) {
        $from = str_starts_with($body, "\xFF\xFE") ? 'UTF-16LE' : 'UTF-16BE';
        $out = function_exists('mb_convert_encoding') ? @mb_convert_encoding(substr($body, 2), 'UTF-8', $from) : false;

        return is_string($out) ? $out : '';
    }
    if (!preg_match('//u', $body)) {
        return function_exists('mb_convert_encoding') ? (string) @mb_convert_encoding($body, 'UTF-8', 'ISO-8859-1') : '';
    }

    return $body;
}

/** One GET to the checked address: [status, body, redirect target, content type]. */
function ical_get(string $url, string $host, int $port, string $ip, int $seconds): array
{
    $status = 0;
    $body = '';
    $tooBig = false;
    $type = '';
    $location = '';
    $ch = curl_init($url);
    $https = str_starts_with($url, 'https://');
    $cafile = (string) ini_get('openssl.cafile');
    $options = [
        // The connection goes to the address checked above, whatever another lookup would say now.
        CURLOPT_RESOLVE => [$host . ':' . $port . ':' . (str_contains($ip, ':') ? '[' . $ip . ']' : $ip)],
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => $https ? CURLPROTO_HTTPS : CURLPROTO_HTTP,
        CURLOPT_PROXY => '',
        CURLOPT_NOPROXY => '*',
        CURLOPT_CONNECTTIMEOUT => min(10, $seconds),
        CURLOPT_TIMEOUT => $seconds,
        CURLOPT_USERAGENT => 'TomlinOS Calendar',
        CURLOPT_HTTPHEADER => ['Accept: text/calendar, */*;q=0.5'],
        CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$status, &$type, &$location): int {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                // A new answer (after a 100 Continue): its own headers only.
                $status = (int) $m[1];
                $type = '';
                $location = '';
            } elseif (preg_match('/^Content-Type:\s*(.+)$/i', trim($line), $m)) {
                $type = strtolower($m[1]);
            } elseif (preg_match('/^Location:\s*(.+)$/i', trim($line), $m)) {
                $location = trim($m[1]);
            }

            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => static function ($ch, string $data) use (&$body, &$tooBig): int {
            if (strlen($body) + strlen($data) > ICAL_MAX_BYTES) {
                $tooBig = true;

                return 0; // stop reading
            }
            $body .= $data;

            return strlen($data);
        },
    ];
    if ($cafile !== '' && is_file($cafile)) {
        $options[CURLOPT_CAINFO] = $cafile;
    }
    curl_setopt_array($ch, $options);
    $ok = curl_exec($ch);
    $error = curl_errno($ch);
    if ($tooBig) {
        throw new IcalFetchError('That calendar is larger than ' . (ICAL_MAX_BYTES >> 20) . ' MB, so it was not read.');
    }
    if ($ok === false || $error !== 0) {
        if ($error === CURLE_OPERATION_TIMEDOUT) {
            throw new IcalFetchError('The calendar\'s site took too long to answer. Try again later.');
        }
        // 35: the secure connection failed; 51 and 60: the certificate was not good (named by number: not every PHP defines them all).
        if (in_array($error, [35, 51, 60], true)) {
            throw new IcalFetchError('The calendar\'s site did not show a valid certificate, so nothing was fetched.');
        }
        throw new IcalFetchError('The calendar\'s site could not be reached. Try again in a minute; if it keeps happening, check the link.');
    }
    $next = '';
    if ($status >= 300 && $status < 400 && $location !== '') {
        // A relative Location is taken against the address asked.
        $next = preg_match('#^[a-z][a-z0-9+.-]*://#i', $location) ? $location : ical_join($url, $location);
    }

    return [$status, $body, $next, $type];
}

/** A relative redirect target against the address it came from. */
function ical_join(string $base, string $relative): string
{
    $p = parse_url($base);
    $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (str_starts_with($relative, '//')) {
        return $p['scheme'] . ':' . $relative;
    }
    if (str_starts_with($relative, '/')) {
        return $origin . $relative;
    }
    $dir = preg_replace('#/[^/]*$#', '/', (string) ($p['path'] ?? '/'));

    return $origin . $dir . $relative;
}
