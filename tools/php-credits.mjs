// Writes the Credits files for the server's PHP libraries (server/vendor, installed by Composer from
// server/composer.json): public/vendor/claude-php-packages.json (name, version, licence of each) and
// public/vendor/claude-php-LICENSES.txt (their licence texts), which About > Credits shows. Run after every
// composer install/update; test/credits.test.ts fails when the list and composer.lock disagree.
//   node tools/php-credits.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'server', 'composer.lock'), 'utf8'));
const packages = lock.packages.map(p => ({ name: p.name, version: p.version.replace(/^v/, ''), license: (p.license ?? []).join(' OR ') || 'unknown' }))
  .sort((a, b) => a.name.localeCompare(b.name));
const texts = packages.map(p => {
  const dir = join(root, 'server', 'vendor', ...p.name.split('/'));
  const file = existsSync(dir) ? readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
  const body = file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file in the package; its licence is ' + p.license + ')';
  // The package record and its licence file can disagree (standard-webhooks says MIT, its file is Apache-2.0).
  // Credits say what the FILE says as well, so nothing ships under a licence it does not carry.
  const found = /Apache License[\s\S]{0,80}Version 2\.0/.test(body) ? 'Apache-2.0' : /Permission is hereby granted, free of charge/.test(body) ? 'MIT' : /Redistribution and use in source and binary forms/.test(body) ? 'BSD' : null;
  if (found && !p.license.includes(found)) p.license = `${p.license} in its package record; its licence file is ${found}`;
  return `${p.name} ${p.version} (${p.license})\n${'-'.repeat(60)}\n${body}\n`;
});
writeFileSync(join(root, 'public', 'vendor', 'claude-php-packages.json'), JSON.stringify(packages, null, 1) + '\n');
writeFileSync(join(root, 'public', 'vendor', 'claude-php-LICENSES.txt'), texts.join('\n'));
console.log(`${packages.length} PHP packages credited.`);
