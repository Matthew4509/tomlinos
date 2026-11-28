<?php
// The Calendar's subscriptions (lib/icalfetch.php), for signed-in people only.
//   POST ?op=fetch  {url}   the calendar file at that link, as {text}. Nothing is kept on the server.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/icalfetch.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$op = query_str('op');
if ($op !== 'fetch') {
    api_fail(404, 'There is no such calendar request.');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    api_fail(405, 'Send the link with POST.');
}
$body = api_body();
$url = body_str($body, 'url');
if ($url === '') {
    api_fail(400, 'Paste the calendar\'s link first.');
}
// A brake, so this server is never used to hammer another site: 120 fetches an hour each (a person with ten
// calendars refreshing every hour uses ten).
$wait = rate_take($root, (string) $user['id'], 'ical', 120, 3600);
if ($wait > 0) {
    api_fail(429, 'That is a lot of calendar fetches in an hour. Wait a while, then refresh again.', ['wait' => $wait]);
}
@set_time_limit(60);
try {
    $text = ical_fetch($url);
} catch (IcalFetchError $e) {
    api_fail(422, $e->getMessage());
}
api_json(['text' => $text]);
