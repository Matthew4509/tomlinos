<?php
// Requests the server makes to other sites (the Reader's library, app store, models, updates, AI keys), and a per-person rate limit.
// Only https, the certificate is always checked, answers are capped in size, and every fault becomes plain words.
declare(strict_types=1);

const OUTBOUND_MAX_BYTES = 2 * 1024 * 1024;

/** GETs a JSON answer from an https address. Throws RuntimeException with words for the person on any fault. */
function outbound_get_json(string $url, int $timeout = 10): array
{
    if (!str_starts_with($url, 'https://')) {
        throw new RuntimeException('Only secure (https) addresses are asked.');
    }
    if (!extension_loaded('openssl')) {
        throw new RuntimeException('This server\'s PHP has no secure-connection support (the openssl extension is off). The owner can switch it on in the host\'s PHP settings.');
    }
    $context = stream_context_create([
        'http' => ['method' => 'GET', 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0, 'header' => "Accept: application/json\r\nUser-Agent: TomlinOS\r\n"],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $stream = @fopen($url, 'rb', false, $context);
    if ($stream === false) {
        throw new RuntimeException('The other site could not be reached. Try again in a minute; if it keeps happening, the server may not reach the internet.');
    }
    $meta = stream_get_meta_data($stream);
    $body = (string) stream_get_contents($stream, OUTBOUND_MAX_BYTES + 1);
    fclose($stream);
    if (strlen($body) > OUTBOUND_MAX_BYTES) {
        throw new RuntimeException('The other site sent back far more than expected, so it was not read.');
    }
    $status = 0;
    foreach ($meta['wrapper_data'] ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $line, $m)) {
            $status = (int) $m[1];
        }
    }
    $data = json_decode($body, true);
    if (!is_array($data)) {
        throw new RuntimeException('The other site\'s answer could not be read.');
    }
    if ($status >= 400) {
        $data['_status'] = $status;
    }

    return $data;
}

/**
 * A per-person brake: at most $max uses of $bucket in $window seconds. Returns 0 and counts this use, or the seconds
 * to wait (nothing counted). Kept in the accounts folder under the accounts lock, so parallel requests are counted.
 */
function rate_take(string $dataDir, string $userId, string $bucket, int $max, int $window): int
{
    return auth_locked($dataDir, static function () use ($dataDir, $userId, $bucket, $max, $window): int {
        $path = auth_dir($dataDir) . '/rates.json';
        $all = auth_read_json($path, []);
        $now = time();
        $key = $bucket . ':' . $userId;
        $uses = array_values(array_filter($all[$key] ?? [], static fn ($t) => is_int($t) && $now - $t < $window));
        if (count($uses) >= $max) {
            return max(1, $window - ($now - min($uses)));
        }
        $uses[] = $now;
        $all[$key] = $uses;
        // Drop other people's old entries while the file is open, so it never grows without end.
        foreach ($all as $k => $list) {
            $all[$k] = array_values(array_filter((array) $list, static fn ($t) => is_int($t) && $now - $t < 86400));
            if (!$all[$k]) {
                unset($all[$k]);
            }
        }
        auth_write_json($path, $all);

        return 0;
    });
}
