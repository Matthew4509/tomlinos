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
    echo json_encode(['error' => $message] + $extra);
    exit;
}

function api_json(array $body): never
{
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
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
function api_guard(): void
{
    $config = api_config();
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
