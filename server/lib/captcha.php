<?php
// The picture check asked for after a wrong password (lib/auth.php decides when). Drawn by this server as an SVG of
// hand-drawn strokes (no letters as text, no outside service: a captcha from another company is blocked in some
// countries and tells that company who signs in). Each picture is five digits, bent and turned, over a few stray lines.
// It answers once, for five minutes. It slows a guessing program; the brakes and a good password do the real work.
declare(strict_types=1);

const CAPTCHA_TTL = 300;
const CAPTCHA_LENGTH = 5;
const CAPTCHA_MAX_KEPT = 500;
const CAPTCHA_MAX_PER_ADDRESS = 20;

/** Each digit as strokes on a 10 x 16 grid. 0 and 1 are left out: they look too like O and I. */
const CAPTCHA_GLYPHS = [
    '2' => 'M1 4 C2 0 9 0 9 4 C9 8 1 12 1 16 L9 16',
    '3' => 'M1 2 L9 2 L4 8 C10 8 10 16 5 16 C3 16 1 15 1 14',
    '4' => 'M7 16 L7 1 L1 11 L10 11',
    '5' => 'M9 1 L2 1 L1 8 C5 6 10 8 9 12 C8 16 3 16 1 14',
    '6' => 'M8 1 C2 3 1 9 1 12 C1 16 9 16 9 12 C9 8 2 8 1 12',
    '7' => 'M1 1 L9 1 L4 16',
    '8' => 'M5 8 C1 8 1 1 5 1 C9 1 9 8 5 8 C0 8 0 16 5 16 C10 16 10 8 5 8',
    '9' => 'M9 5 C9 0 1 0 1 5 C1 9 9 9 9 5 L8 16',
];

function captcha_file(string $dataDir): string
{
    return auth_dir($dataDir) . '/captcha.json';
}

/** The picture for an answer, as SVG text. */
function captcha_svg(string $answer): string
{
    $parts = [];
    $x = 14;
    foreach (str_split($answer) as $digit) {
        $angle = random_int(-22, 22);
        $scale = random_int(170, 215) / 100;
        $y = random_int(12, 22);
        $skew = random_int(-12, 12);
        $colour = sprintf('#%02x%02x%02x', random_int(20, 90), random_int(20, 90), random_int(40, 110));
        $parts[] = sprintf('<path d="%s" transform="translate(%d %d) rotate(%d 5 8) skewX(%d) scale(%.2f)" fill="none" stroke="%s" stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round"/>',
            CAPTCHA_GLYPHS[$digit], $x, $y, $angle, $skew, $scale, $colour, random_int(10, 14) / 10);
        $x += random_int(30, 36);
    }
    // Stray lines across the digits, so the strokes cannot simply be read off one by one.
    for ($i = 0; $i < 6; $i++) {
        $parts[] = sprintf('<path d="M%d %d C%d %d %d %d %d %d" fill="none" stroke="#8a93a6" stroke-width="%.1f"/>',
            random_int(0, 40), random_int(5, 65), random_int(40, 90), random_int(0, 70), random_int(100, 160), random_int(0, 70), random_int(160, 200), random_int(5, 65), random_int(8, 14) / 10);
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 70" width="200" height="70"><rect width="200" height="70" fill="#f4f1e8"/>' . implode('', $parts) . '</svg>';
}

/** A new picture for this address: its id and SVG. The answer is kept only as a hash. */
function captcha_new(string $dataDir, string $ip): array
{
    $answer = '';
    $digits = array_keys(CAPTCHA_GLYPHS);
    for ($i = 0; $i < CAPTCHA_LENGTH; $i++) {
        $answer .= (string) $digits[random_int(0, count($digits) - 1)];
    }
    $id = bin2hex(random_bytes(12));
    auth_locked($dataDir, static function () use ($dataDir, $ip, $id, $answer): void {
        $now = time();
        $kept = array_filter(auth_read_json(captcha_file($dataDir), []), static fn ($c) => is_array($c) && ($c['until'] ?? 0) > $now);
        // One address cannot pile up pictures; the oldest of its own go first.
        $mine = array_keys(array_filter($kept, static fn ($c) => ($c['ip'] ?? '') === $ip));
        foreach (array_slice($mine, 0, max(0, count($mine) - CAPTCHA_MAX_PER_ADDRESS + 1)) as $old) {
            unset($kept[$old]);
        }
        $kept[$id] = ['hash' => hash('sha256', $answer), 'until' => $now + CAPTCHA_TTL, 'ip' => $ip];
        auth_write_json(captcha_file($dataDir), array_slice($kept, -CAPTCHA_MAX_KEPT, null, true));
    });

    // The server tests set DESKTOP_TEST_CAPTCHA to read the answer (only an environment variable can; never on a live site).
    return ['id' => $id, 'svg' => captcha_svg($answer)] + (getenv('DESKTOP_TEST_CAPTCHA') === '1' ? ['answer' => $answer] : []);
}

/** Whether the answer matches its picture. Either way the picture is used up. */
function captcha_check(string $dataDir, string $id, string $answer): bool
{
    if (!preg_match('/^[0-9a-f]{24}$/D', $id)) {
        return false;
    }

    return auth_locked($dataDir, static function () use ($dataDir, $id, $answer): bool {
        $kept = auth_read_json(captcha_file($dataDir), []);
        $c = $kept[$id] ?? null;
        unset($kept[$id]);
        auth_write_json(captcha_file($dataDir), $kept);

        return is_array($c) && ($c['until'] ?? 0) > time() && hash_equals((string) $c['hash'], hash('sha256', preg_replace('/\s+/', '', $answer) ?? ''));
    });
}
