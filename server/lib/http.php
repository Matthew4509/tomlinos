<?php
// What every desktop API answer shares: the headers, the refusal format, and the check that a request came from the
// desktop's own page (a custom header another site cannot send without asking, and a matching Origin).
declare(strict_types=1);

// A warning printed into an answer would show server paths and break the JSON. Faults go to the error log instead.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

function api_config(): array
{
    static $config = null;
    if ($config === null) {
        $config = require (is_file(__DIR__ . '/../config.php') ? __DIR__ . '/../config.php' : __DIR__ . '/../config.example.php');
    }

    return $config;
}

function api_headers(): void
{
    // PHP announces its version unless the host turns expose_php off (a .user.ini cannot); the app removes it itself.
    header_remove('X-Powered-By');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    header('X-Frame-Options: DENY');
}

function api_fail(int $status, string $message, array $extra = []): never
{
    http_response_code($status);
    // A "wait" refusal says how long in the header too, for anything that is not the desktop's own page.
    if ($status === 429 && isset($extra['wait'])) {
        header('Retry-After: ' . max(1, (int) $extra['wait']));
    }
    header('Content-Type: application/json');
    echo json_encode(['error' => $message] + $extra, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

/**
 * A query parameter as text, or '' when it is missing or is not text (?op[]=x makes it a list, which turned into the
 * word "Array" with a warning in the error log).
 */
function query_str(string $name): string
{
    $value = $_GET[$name] ?? '';
    return is_string($value) ? $value : '';
}

// A string that is not valid UTF-8 (one old-style Latin-1 byte in a mail header, say) used to make json_encode give up
// on the whole answer, so the page received nothing. Such a byte becomes U+FFFD (the "unknown character" mark) instead.
function api_json(array $body): never
{
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

/**
 * A request from this computer itself. Only PHP's own development server is believed: on a real web server a loopback
 * address usually means a proxy in front that did not pass on the visitor's address, and every stranger would look local.
 */
function api_is_local(): bool
{
    return PHP_SAPI === 'cli-server' && in_array((string) ($_SERVER['REMOTE_ADDR'] ?? ''), ['127.0.0.1', '::1'], true);
}

/** Refuses anything that is not the desktop's own page asking. */
function api_guard(bool $updating = false): void
{
    $config = api_config();
    // While System update replaces the site's files (update/operation.json, with its lock held), every other request waits:
    // answered now, it could run half old and half new code. update.php itself passes $updating to keep answering.
    $op = dirname(__DIR__) . '/update/operation.json';
    if (!$updating && is_file($op) && ($lock = @fopen(dirname($op) . '/.lock', 'c'))) {
        // Nobody holds the lock but the operation file is there: an install or Go back was cut off (a time limit, a
        // restart) and the site may be half one version, half the other. The first request to see it puts the earlier
        // version back whole before anything else runs; the rest wait for it.
        if (flock($lock, LOCK_EX | LOCK_NB)) {
            try {
                require_once __DIR__ . '/updater.php';
                if (is_file($op)) {
                    @set_time_limit(300);
                    update_recover(dirname($op));
                }
            } catch (Throwable $e) {
                error_log('api_guard: finishing a cut-off update failed: ' . $e->getMessage());
            } finally {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
            if (is_file($op)) {
                header('Retry-After: 30');
                api_fail(503, 'An update was cut off part-way and could not be put right. The owner can run  php tomlinos/tools/rollback-update.php  from the host\'s Terminal.');
            }
        } else {
            fclose($lock);
            header('Retry-After: 30');
            api_fail(503, 'TOMLIN OS is installing an update. Try again in a minute; nothing you had open was lost.');
        }
    }
    if (!api_is_local() && empty($config['allow_remote'])) {
        api_fail(403, 'This desktop only answers the computer it runs on. To reach it from elsewhere, the owner turns on allow_remote in tomlinos/config.php.');
    }
    // On this computer, only this computer's own names: another site whose name was pointed at 127.0.0.1 (DNS
    // rebinding) sends its own name as Host and Origin, and would otherwise pass every check below.
    if (api_is_local()) {
        $name = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
        if (!in_array($name, ['127.0.0.1', 'localhost', '[::1]'], true) && !str_ends_with($name, '.localhost')) {
            api_fail(403, 'On this computer the desktop only answers its own address (127.0.0.1 or localhost).');
        }
    }
    // Reached from elsewhere, only over HTTPS: the sign-in cookie must never travel in the clear.
    if (!api_is_local() && !api_https()) {
        api_fail(403, 'This desktop only answers over a secure connection. Open it with https:// at the start of the address.');
    }
    if (($_SERVER['HTTP_X_DESKTOP_STORE'] ?? '') !== '1') {
        api_fail(400, 'This address is for the desktop itself, not for opening in a browser.');
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        $host = parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '');
        if ($host !== ($_SERVER['HTTP_HOST'] ?? '')) {
            api_fail(403, 'Requests from other sites are refused.');
        }
    }
}

/** A text field of a JSON body. Anything that is not text or a number reads as empty: an array must never reach code
    that expects a string (it would raise a warning, and a warning can show server paths). */
function body_str(array $body, string $key): string
{
    $v = $body[$key] ?? '';

    return is_string($v) ? $v : (is_int($v) || is_float($v) ? (string) $v : '');
}

/** The JSON object a POST carried, or a refusal. */
function api_body(): array
{
    $raw = (string) file_get_contents('php://input', false, null, 0, 65536);
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        api_fail(400, 'The desktop sent a request the server could not read. Reload the page and try again.');
    }

    return $body;
}

function api_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
}
