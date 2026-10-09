<?php
// The Reader's Gutenberg service, read-only.
//   ping                 204: the Reader may show the Gutenberg library (TOMLIN OS answers only signed-in people)
//   index                the book list (gutenberg.json), compressed when the browser accepts it
//   book/<id>            one book's plain text, fetched from Gutenberg (its mirror first) the first time anyone asks for it, then
//                        kept in the cache folder (gutenberg.org sends no CORS header, so a browser cannot fetch it)
// Only numbered books at Gutenberg's own address are fetched, one per request: it cannot be used to fetch anything else.
// Used by server/api/books.php (signed-in people only) and labs/serve-printer.php (local, no accounts).
declare(strict_types=1);

const GUTENBERG_MAX_BYTES = 25_000_000;
/** The most the kept books may take on the server; past it, the books read longest ago go first. */
const GUTENBERG_CACHE_BYTES = 500_000_000;

function gutenberg_trim(string $cacheDir, int $max): void
{
    $books = glob($cacheDir . '/pg*.txt') ?: [];
    $total = array_sum(array_map('filesize', $books));
    if ($total <= $max) {
        return;
    }
    usort($books, static fn ($a, $b) => filemtime($a) <=> filemtime($b));
    foreach ($books as $book) {
        if ($total <= $max) {
            break;
        }
        $total -= (int) filesize($book);
        @unlink($book);
    }
}

function gutenberg_fail(int $code, string $message): void
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
}

/**
 * $rest: ping, index or book/<id>. $booksDir holds gutenberg.json (tools: labs/reader/tools/build-gutenberg.mjs);
 * $cacheDir keeps the fetched books and the compressed list. Returns true once it has answered.
 */
function gutenberg_serve(string $rest, string $booksDir, string $cacheDir): bool
{
    header('X-Content-Type-Options: nosniff');
    if ($rest === 'ping') {
        http_response_code(204);
        return true;
    }
    if ($rest === 'index') {
        $file = $booksDir . '/gutenberg.json';
        if (!is_file($file)) {
            gutenberg_fail(404, 'The book list has not been built yet. Run: node labs/reader/tools/build-gutenberg.mjs');
            return true;
        }
        header('Content-Type: application/json');
        header('Cache-Control: no-cache');
        if (!is_dir($cacheDir)) {
            mkdir($cacheDir, 0775, true);
        }
        $gz = $cacheDir . '/gutenberg.json.gz';
        if (!is_file($gz) || filemtime($gz) < filemtime($file)) {
            file_put_contents($gz, gzencode((string) file_get_contents($file), 6));
        }
        if (str_contains($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip')) {
            header('Content-Encoding: gzip');
            header('Content-Length: ' . filesize($gz));
            readfile($gz);
        } else {
            header('Content-Length: ' . filesize($file));
            readfile($file);
        }
        return true;
    }
    if (!preg_match('#^book/([1-9][0-9]{0,6})$#', $rest, $m)) {
        gutenberg_fail(404, 'Not found');
        return true;
    }
    $id = (int) $m[1];
    if (!is_dir($cacheDir)) {
        mkdir($cacheDir, 0775, true);
    }
    $cached = "$cacheDir/pg$id.txt";
    if (!is_file($cached)) {
        // Gutenberg's own mirror first (it asks programs to use mirrors), then the main site.
        $text = gutenberg_fetch("https://gutenberg.pglaf.org/cache/epub/$id/pg$id.txt")
            ?? gutenberg_fetch("https://www.gutenberg.org/cache/epub/$id/pg$id.txt");
        if ($text === null) {
            gutenberg_fail(502, "Project Gutenberg did not send book $id. It may be busy; try again in a minute.");
            return true;
        }
        file_put_contents($cached, $text);
        gutenberg_trim($cacheDir, GUTENBERG_CACHE_BYTES);
    }
    // Read again: it counts as recent, so the cache lets the least-read books go first.
    @touch($cached);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: private, max-age=86400');
    header('Content-Length: ' . filesize($cached));
    readfile($cached);
    return true;
}

function gutenberg_fetch(string $url): ?string
{
    $headers = "User-Agent: TomlinOS Reader (one book, opened by a reader)\r\n";
    $context = stream_context_create(['http' => ['timeout' => 40, 'header' => $headers, 'ignore_errors' => true]]);
    $body = @file_get_contents($url, false, $context, 0, GUTENBERG_MAX_BYTES);
    $got = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : [];
    // After redirects the last status line is the one that counts.
    $lines = array_values(array_filter($got, fn ($l) => str_starts_with($l, 'HTTP/')));
    $last = end($lines) ?: '';
    $status = preg_match('#\s(\d{3})(\s|$)#', $last, $s) ? (int) $s[1] : 0;
    if ($body === false || $status !== 200 || $body === '') {
        return null;
    }
    // A book, not an error page: Gutenberg's texts all carry its start marker.
    return str_contains($body, '*** START OF') ? $body : null;
}
