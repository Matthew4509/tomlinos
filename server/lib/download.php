<?php
// Opening a download that may be redirected (a GitHub release file answers with a redirect to GitHub's file host). The
// redirects are followed here, not by PHP, so that one starting on https can never be sent on to plain http: PHP's own
// following goes anywhere, http and other computers on the server's network included.
declare(strict_types=1);

/** $location (absolute, //host/..., /path or relative) read against the address it came from. */
function download_resolve(string $base, string $location): string
{
    if (preg_match('#^[a-z][a-z0-9+.-]*://#i', $location)) {
        return $location;
    }
    $p = parse_url($base);
    $origin = ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
    if (str_starts_with($location, '//')) {
        return ($p['scheme'] ?? 'https') . ':' . $location;
    }
    $dir = (string) preg_replace('#/[^/]*$#', '/', (string) ($p['path'] ?? '/'));
    $joined = str_starts_with($location, '/') ? $location : ($dir === '' ? '/' : $dir) . $location;
    // "a/b/../c" is "a/c", as a browser reads it.
    [$path, $query] = array_pad(explode('?', $joined, 2), 2, null);
    $out = [];
    foreach (explode('/', $path) as $seg) {
        if ($seg === '..') {
            if (count($out) > 1) {
                array_pop($out);
            }
        } elseif ($seg !== '.') {
            $out[] = $seg;
        }
    }
    $clean = implode('/', $out);
    if (str_ends_with($path, '/..') || str_ends_with($path, '/.')) {
        $clean .= '/';
    }

    return $origin . ($clean === '' ? '/' : $clean) . ($query !== null ? '?' . $query : '');
}

/**
 * A stream of the file at $url once it answers 200, following up to 5 redirects, or false when it could not be opened.
 * A download that starts on https stays on https (throws RuntimeException if sent elsewhere). An address that is not
 * http(s) at all (a folder, as the tests use) is opened as it is.
 *
 * @return resource|false
 */
function download_open(string $url, int $timeout = 60, string $agent = 'TomlinOS')
{
    if (!preg_match('#^https?://#i', $url)) {
        return @fopen($url, 'rb');
    }
    $secure = stripos($url, 'https://') === 0;
    for ($hop = 0; $hop <= 5; $hop++) {
        if ($secure && stripos($url, 'https://') !== 0) {
            throw new RuntimeException('The download was sent on to an address that is not secure (not https), so it was not fetched. Nothing was changed.');
        }
        $ctx = stream_context_create([
            'http' => ['timeout' => $timeout, 'follow_location' => 0, 'ignore_errors' => true, 'header' => 'User-Agent: ' . str_replace(["\r", "\n"], '', $agent) . "\r\n"],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $in = @fopen($url, 'rb', false, $ctx);
        if ($in === false) {
            return false;
        }
        $status = 0;
        $location = '';
        foreach (stream_get_meta_data($in)['wrapper_data'] ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $line, $m)) {
                $status = (int) $m[1];
                $location = '';
            } elseif (stripos((string) $line, 'Location:') === 0) {
                $location = trim(substr((string) $line, 9));
            }
        }
        if ($status >= 300 && $status < 400 && $location !== '') {
            fclose($in);
            $url = download_resolve($url, $location);
            continue;
        }
        if ($status !== 200) {
            fclose($in);

            return false;
        }

        return $in;
    }

    return false;
}
