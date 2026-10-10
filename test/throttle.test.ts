// The sign-in brake (server/lib/auth.php), run by PHP directly so two different addresses can be used (the test
// server always sees 127.0.0.1). Kept for the name alone, the name's count would let wrong tries from anywhere keep
// the real person out; it is kept per name AND address. Skipped without PHP.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');

test('wrong tries from one address do not stop the right person at another; the guessing address still waits', { skip: !hasPhp && 'no PHP' }, () => {
  const dir = tempDir('tomlinos-throttle-');
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/auth.php'))};
$d = ${JSON.stringify(dir)};
for ($i = 0; $i < 5; $i++) auth_throttle_take($d, '203.0.113.9', 'alex');
$out = [
  'guesser' => auth_throttle_wait($d, '203.0.113.9', 'alex'),
  'owner_elsewhere' => auth_throttle_wait($d, '198.51.100.7', 'alex'),
  'other_name_same_address' => auth_throttle_wait($d, '203.0.113.9', 'ann'),
];
auth_throttle_clear($d, 'ALEX');
$out['after_right_password'] = auth_throttle_wait($d, '203.0.113.9', 'alex');
for ($i = 0; $i < 20; $i++) auth_throttle_take($d, '203.0.113.50', 'name' . $i);
$out['address_limit'] = auth_throttle_wait($d, '203.0.113.50', 'someone');
for ($i = 0; $i < 5; $i++) auth_throttle_take($d, '2001:db8:1:2::' . dechex($i + 1), 'bea');
$out['v6_same_64'] = auth_throttle_wait($d, '2001:db8:1:2:ffff::9', 'bea');
$out['v6_other_64'] = auth_throttle_wait($d, '2001:db8:1:3::1', 'bea');
echo json_encode($out);`);
  const r = JSON.parse(execFileSync(PHP, [file], { encoding: 'utf8' })) as Record<string, number>;
  assert.ok(r.guesser > 0, 'the address that guessed waits');
  assert.equal(r.owner_elsewhere, 0, 'the owner at another address is not kept out');
  assert.equal(r.other_name_same_address, 0, 'five wrong tries on one name do not block others from that address');
  assert.equal(r.after_right_password, 0, 'a right password clears the count, whatever the case of the name');
  assert.ok(r.address_limit > 0, 'one address trying many names is still stopped after 20');
  assert.ok(r.v6_same_64 > 0, 'changing addresses inside one IPv6 /64 does not escape the brake');
  assert.equal(r.v6_other_64, 0, 'another /64 is someone else');
});
