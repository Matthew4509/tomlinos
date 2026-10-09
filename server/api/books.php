<?php
// The Reader's Gutenberg library (lib/gutenberg.php), for signed-in people only. The Reader anyone can see, on the
// front page and the lock screen, has Sherlock Holmes and nothing else; everything here needs a signed-in, unlocked
// session, so a person passing a locked screen cannot browse or open anything.
//   GET ?path=ping        204 when the library may be shown
//   GET ?path=index       the book list (61,000-odd English books), compressed
//   GET ?path=book/<id>   one book's text, fetched from Project Gutenberg the first time, then kept on this server
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/gutenberg.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    api_fail(405, 'Only reading is possible here.');
}
$path = (string) ($_GET['path'] ?? '');
if (preg_match('#^book/[1-9][0-9]{0,6}$#', $path)) {
    $wait = rate_take($root, (string) $user['id'], 'books', 60, 3600);
    if ($wait > 0) {
        api_fail(429, 'That is 60 books in an hour. Wait a while, then carry on.', ['wait' => $wait]);
    }
    if (!extension_loaded('openssl')) {
        api_fail(501, 'This server\'s PHP has no secure-connection support (the openssl extension is off), so it cannot fetch books. The owner can switch it on in the host\'s PHP settings.');
    }
}
gutenberg_serve($path, __DIR__ . '/../books', $root . '/books-cache');
