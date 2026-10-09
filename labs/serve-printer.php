<?php
// Local only: Office Printer A and B side by side on one port, to compare them.
//   /      a page with the two links
//   /a/    version A, the game as built (public/office-printer/, untouched)
//   /b/    version B, the new flow (appstore-src/officeprinter/, the app store's copy). Texts fall back to
//          labs/office-printer-b/texts (Sherlock Holmes), then A's (Hamlet, Shakespeare).
//   /reader/  the immersive reader (labs/reader/), which B opens in a window; texts/ as for B.
// Start it with "Start Office Printer A-B.cmd" beside this file.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/');
$a = realpath(__DIR__ . '/../public/office-printer');
$b = realpath(__DIR__ . '/../appstore-src/officeprinter');
$bTexts = realpath(__DIR__ . '/office-printer-b/texts');
$reader = realpath(__DIR__ . '/reader');

if ($path === '/' || $path === '/index.html') {
    header('Content-Type: text/html; charset=utf-8');
    // The demo page: the whole game from the start, then every printer on its own (?at=), the Dot Matrix's three
    // excuses (?reason=), and the Reader.
    $stages = [
        ['/b/', 'The whole game, from the start', 'taskbar (!), licence, reading check, then every printer in turn'],
        ['/b/?at=photo', 'Photo Printer (Marketing)', '14 pages on one 6 x 4 photo; Enhance'],
        ['/b/?at=receipt', 'Receipt Printer (Reception)', 'the report on a till roll, then the merchant copy'],
        ['/b/?at=fax', 'Fax Machine (Reception)', 'faxes it to the Dot Matrix, which refuses'],
        ['/b/?at=threed', '3D Printer (Workshop)', 'the report as an object, until the cyan runs out'],
        ['/b/?at=fridge', 'Fridge (Staff kitchen)', 'door screen, shopping list, printing in ice'],
        ['/b/?at=strike', 'The strike', 'the printers vote; the demands'],
        ['/b/?at=cloud', 'PrintNet (The Cloud)', 'the plans, then the LaserJet: it was never broken'],
    ];
    $li = fn ($href, $name, $what) => '<li><a href="' . htmlspecialchars($href) . '">' . htmlspecialchars($name) . '</a> <span>' . htmlspecialchars($what) . '</span></li>';
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Office Printer demo</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:32px auto;max-width:760px;padding:0 16px;color:#1b1b1b}',
        'h2{font-size:18px;margin:28px 0 6px}li{margin:4px 0}span{color:#5f6368}code{background:#f1f1f1;padding:1px 4px}</style></head><body>',
        '<h1>Office Printer demo</h1><h2>Version B</h2><ul>', implode('', array_map(fn ($x) => $li(...$x), $stages)), '</ul>',
        '<h2>The Dot Matrix\'s three excuses</h2><ul>',
        $li('/b/?reason=filetype', 'File type', 'prints the PDF\'s own code, then stops'),
        $li('/b/?reason=ribbon', 'Ribbon', 'fades to nothing'),
        $li('/b/?reason=jam', 'Jam', 'the last lines on top of each other'), '</ul>',
        '<h2>The Reader</h2><ul>', $li('/reader/', 'Immersive Reader', 'Shakespeare, Sherlock Holmes and the Gutenberg library'), '</ul>',
        '<h2>For comparison</h2><ul>', $li('/a/', 'Version A', 'the game as first built (Print dialog, chat story, 20 endings)'), '</ul>',
        '<p>Faster, for a quick look: add <code>speed=5</code> to any address (for example <a href="/b/?speed=5">/b/?speed=5</a>). ',
        'The licence timing always uses real seconds.</p></body></html>';
    return true;
}
if ($path === '/a' || $path === '/b' || $path === '/reader') {
    header("Location: $path/", true, 302);
    return true;
}
// The Reader's Gutenberg library: the book list, and one book at a time from gutenberg.org (cached in reader/.cache).
if (preg_match('#^/reader/gutenberg/(.+)$#', $path, $g)) {
    require __DIR__ . '/../server/lib/gutenberg.php';
    gutenberg_serve($g[1], __DIR__ . '/../server/books', $reader . DIRECTORY_SEPARATOR . '.cache' . DIRECTORY_SEPARATOR . 'books');
    return true;
}
if (!preg_match('#^/(a|b|reader)/(.*)$#', $path, $m)) {
    http_response_code(404);
    echo 'Not found';
    return true;
}
$root = ['a' => $a, 'b' => $b, 'reader' => $reader][$m[1]];
$rel = $m[2] === '' ? 'index.html' : $m[2];
$file = realpath($root . '/' . $rel);
// B and the Reader share the texts: their own first, then Sherlock Holmes (labs), then A's (Shakespeare).
if ($m[1] !== 'a' && $file === false && str_starts_with($rel, 'texts/')) {
    $file = realpath($bTexts . '/' . substr($rel, 6)) ?: realpath($a . '/' . $rel);
}
// Only files inside the version's own folder, or a texts/ folder: never ../ out of them.
$inside = fn ($f, $dir) => $f !== false && str_starts_with($f, $dir . DIRECTORY_SEPARATOR) && is_file($f);
if (!$inside($file, $root) && !$inside($file, $a . DIRECTORY_SEPARATOR . 'texts') && !$inside($file, $bTexts)) {
    http_response_code(404);
    echo 'Not found';
    return true;
}
$types = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
    'json' => 'application/json', 'txt' => 'text/plain; charset=utf-8', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg'];
header('Content-Type: ' . ($types[strtolower(pathinfo($file, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Content-Length: ' . filesize($file));
readfile($file);
return true;
