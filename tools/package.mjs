// Builds the upload for a cPanel host: dist/tomlinos-<version>.zip. Unzip it in the account's HOME folder (the one that
// holds public_html) and it lands as:
//   public_html/            the desktop's page, .htaccess, storage.json (says "server"), and two tiny api/*.php doors
//   tomlinos/                 the real PHP (api/, lib/), config.example.php, tools/, and data/ (files + accounts)
// Nothing in tomlinos/ can be fetched from the web: it sits beside public_html, not inside it.
// Left out on purpose: authenticator.* (the 2FA test page), server/dev-router.php, server/config.php (the local one).
// Run from the repository folder:  npm run package
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerList } from './headers.mjs';
import { writeZip } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
const stage = join(dist, 'stage');
const web = join(stage, 'public_html');
const priv = join(stage, 'tomlinos');
const zip = join(dist, `tomlinos-${version}.zip`);

execFileSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(web, { recursive: true });

// Apps this release hides (src/release.ts, the one list): their stand-alone pages stay out of the upload. Add-on apps
// (games and the like) are never in public/ at all: they come from the app store (appstore-src/, tools/store-publish.mjs).
const hidden = JSON.parse((/HIDDEN_APPS[^=]*=\s*(\[[^\]]*\])/.exec(readFileSync(join(root, 'src', 'release.ts'), 'utf8'))?.[1] ?? '[]').replaceAll("'", '"'));
const standAlone = { printer: 'office-printer' };
const leftOut = hidden.map((id) => standAlone[id]).filter(Boolean);
const outDir = join(root, 'out');

// The web root: the built page minus the test-only authenticator and hidden apps' stand-alone pages.
cpSync(outDir, web, { recursive: true, filter: (src) => !/[\\/]authenticator\.[a-z]+$/.test(src) && !leftOut.some((d) => relative(outDir, src).split(sep)[0] === d) });
writeFileSync(join(web, 'storage.json'), JSON.stringify({ backend: 'server', api: '/api/store.php', auth: '/api/auth.php' }) + '\n');

// Plain HTTP is sent to HTTPS before anything else (the sign-in cookie is only Secure over HTTPS).
// The headers come from security-headers.json, the same list the build and the dev router use.
const htaccess = ['<IfModule mod_headers.c>', ...headerList().map(([name, value]) => `  Header always set ${name} "${value.replace(/"/g, '\\"')}"`), '</IfModule>', ''].join('\n');
writeFileSync(join(web, '.htaccess'), [
  '# TOMLIN OS live server. Everything below the rewrite is the same header list the dev router sends.',
  'Options -Indexes',
  '# Files starting with a dot (.user.ini, .htaccess) are settings, never pages.',
  '<FilesMatch "^\\.">',
  '  Require all denied',
  '</FilesMatch>',
  '<IfModule mod_rewrite.c>',
  '  RewriteEngine On',
  '  RewriteCond %{HTTPS} !=on',
  '  RewriteCond %{HTTP:X-Forwarded-Proto} !=https',
  '  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]',
  '  # The AI model files live in tomlinos/models, outside the web root: every /models/ address goes to the door that',
  '  # checks the visitor is signed in. Without mod_rewrite they are simply not found (never served openly).',
  '  RewriteRule ^models/ api/modelfile.php [L]',
  '</IfModule>',
  htaccess,
  '# Store apps run in a sandboxed frame (an origin of their own): their files, and the Reader they open, may be fetched',
  '# across origins. Public files anyway.',
  '<IfModule mod_headers.c>',
  '  <If "%{REQUEST_URI} =~ m#^/(apps|reader)/#">',
  '    Header always set Access-Control-Allow-Origin "*"',
  '  </If>',
  '  # The same sandbox when an app\'s page is opened on its own (a link to /apps/...): without it the app would run as',
  '  # the desktop itself, with the visitor\'s sign-in. A second policy only adds limits to the one above.',
  '  <If "%{REQUEST_URI} =~ m#^/apps/#">',
  '    Header always add Content-Security-Policy "sandbox allow-scripts"',
  '  </If>',
  '</IfModule>',
  '# The desktop\'s own files are checked with the server each time they are used (a short "not changed" answer when',
  '# they are not). Without this a browser guesses how long to keep them from their age, and after an update (System',
  '# update or a new zip) could go on running the old version, or half old and half new, for days.',
  '<IfModule mod_headers.c>',
  '  <FilesMatch "\\.(html|js|mjs|css|json|wasm|svg|txt)$">',
  '    Header set Cache-Control "no-cache"',
  '  </FilesMatch>',
  '</IfModule>',
  '# Browsers remember to use https for this site for a year (only sent over https).',
  '<IfModule mod_headers.c>',
  '  Header always set Strict-Transport-Security "max-age=31536000" "expr=%{HTTPS} == \'on\'"',
  '</IfModule>',
  '# Under mod_php (where .user.ini is not read), errors still never reach the page.',
  '<IfModule mod_php.c>',
  '  php_flag display_errors off',
  '</IfModule>',
].join('\n'));

// PHP settings for this folder (cPanel reads .user.ini): errors to the log, never into a page, where they would show
// server paths (a POST over post_max_size prints its warning before any of our code runs).
writeFileSync(join(web, '.user.ini'), ['display_errors = Off', 'log_errors = On', ''].join('\n'));

// The doors: the only PHP inside public_html. Each hands over to the real file outside the web root.
mkdirSync(join(web, 'api'), { recursive: true });
for (const name of readdirSync(join(root, 'server', 'api')).filter(n => /^[a-z]+\.php$/.test(n))) {
  writeFileSync(join(web, 'api', name), `<?php\n// Door only: the real code lives outside the web root.\nrequire __DIR__ . '/../../tomlinos/api/${name}';\n`);
}

// The private folder.
// vendor/ holds Anthropic's official Claude library and the HTTP client it recommends (installed by Composer from
// server/composer.json; committed, so the zip needs nothing installed on the host).
if (!existsSync(join(root, 'server', 'vendor', 'autoload.php'))) throw new Error('server/vendor is missing: run composer install in server/.');
// books/: the Gutenberg list the Reader's library reads (server/api/books.php), kept out of the web root.
for (const dir of ['api', 'lib', 'tools', 'vendor', 'books']) cpSync(join(root, 'server', dir), join(priv, dir), { recursive: true });
const example = readFileSync(join(root, 'server', 'config.example.php'), 'utf8');
const dataLine = "'data_dir' => getenv('DESKTOP_DATA_DIR') ?: dirname(__DIR__, 2) . '/desktop-data',";
if (!example.includes(dataLine)) throw new Error('config.example.php: the data_dir line changed; update tools/package.mjs.');
writeFileSync(join(priv, 'config.example.php'), example
  .replace('The default is ../desktop-data, beside the repository (not inside it).', 'The default is tomlinos/data, beside public_html (not inside it).')
  .replace(dataLine, "'data_dir' => getenv('DESKTOP_DATA_DIR') ?: __DIR__ . '/data',"));
mkdirSync(join(priv, 'data'), { recursive: true });
// The version System update compares against (server/lib/updater.php).
writeFileSync(join(priv, 'VERSION'), `${version}\n`);
writeFileSync(join(priv, '.htaccess'), '# Belt and braces: this folder is outside the web root, but if a host ever serves it, refuse.\nRequire all denied\n');
writeFileSync(join(priv, 'data', '.htaccess'), 'Require all denied\n');

writeFileSync(join(stage, 'INSTALL.txt'), `TOMLIN OS ${version}

1. In cPanel File Manager, open your HOME folder (the one that contains public_html).
2. Upload this zip there and Extract. It adds public_html/ files and a new tomlinos/ folder beside it.
   Updating later: extract the new zip the same way. Your files, accounts and tomlinos/config.php are never in the zip
   (it only carries an empty tomlinos/data with a lock file), so they are kept.
3. Check the host: in cPanel > Terminal run   php tomlinos/tools/server-check.php
   It names anything missing (PHP version, upload size limits, the data folder).
4. Before the site answers anyone but the server itself: copy tomlinos/config.example.php to tomlinos/config.php and set
   'allow_remote' => true. Do this only with HTTPS working on the domain.
5. Visit the site. The first visit sets up the OWNER account. It asks for a set-up code: open cPanel File Manager,
   go to tomlinos/data/accounts/ and open SETUP-CODE.txt (made the moment the page first loads). The file is
   deleted once you are set up. This stops a stranger who finds the new site first from becoming its owner.
Do not put the site behind a proxy or "Flexible SSL" CDN: the server must see the visitor's own address (for the
brakes on guessing) and a real https connection (it refuses plain http from outside).
Needs PHP 8.2+ with Argon2 password hashing. Forgotten owner password: tomlinos/tools/reset-password.php (run from the
cPanel Terminal, not the web).
Held out by the sign-in brakes (wrong passwords): wait, use "Email me an unlock link" (set an unlock email in My
account first), or run  php tomlinos/tools/clear-brakes.php  from the cPanel Terminal (or delete
tomlinos/data/accounts/throttle.json in File Manager). Addresses listed in trusted_ips (tomlinos/config.php) are never held.
Backups: everything that is yours is in tomlinos/data/ and tomlinos/config.php (copy both). After putting a backup
back, run  php tomlinos/tools/store-check.php  from the cPanel Terminal: it says whether each person's files hang
together (--repair finishes a save that was cut off and corrects the totals; it never deletes a file). The version
before the last System update: Application manager > Updates > Go back, or  php tomlinos/tools/rollback-update.php
Mail, the Reader's library and your own Claude or OpenRouter key need the PHP extension "openssl";
Claude and saving AI models also need "curl" (server-check.php says).
Games and other add-ons: the owner downloads them in the Application manager from the TOMLIN OS app store (only apps
signed by TOMLIN OS; they land in public_html/apps/). That needs the PHP extensions "sodium", "zip" and "openssl".
The built-in AI models are NOT in this zip: Qwen 3.5 0.8B (about 430 MB), Gemma 2 2B by Google (about
1.4 GB) and Qwen 3.5 4B (about 2.2 GB). Without them it still works: each browser fetches the model from Hugging Face when it
starts. To keep one on your own server (so browsers get it from here, and nothing is fetched from Hugging Face by
them): sign in as the owner, open Settings > AI, choose the model and press "Save to this TOMLIN OS"; the server fetches it
from Hugging Face in 16 MB pieces into tomlinos/models/. That folder is outside public_html: only people signed in
to this desktop can fetch the files. "Remove from this TOMLIN OS" frees the space again; a removed model can be saved
again a day later.
Every model file is pinned to one version and checked against its SHA-256 (tomlinos/lib/model-pins.json), so a file
changed upstream is never used. If Hugging Face or GitHub no longer has that version, a model already saved here keeps
working; otherwise Find AI models (Start > Accessories) searches Hugging Face for another model to use.
(Or on your own computer run node tools/fetch-model.mjs and upload the models/ folder into tomlinos/.)
`);

cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE.txt'));
cpSync(join(root, 'README.md'), join(stage, 'README.md'));

// Sanity: nothing that must stay private ended up in the web root.
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const webFiles = walk(web).map((f) => relative(web, f).replaceAll('\\', '/'));
const bad = webFiles.filter((f) => /authenticator\.|dev-router|config\.php|^lib\/|^tools\/|^models\//.test(f) ||(f.endsWith('.php') && !/^api\/[a-z]+\.php$/.test(f)));
if (bad.length) throw new Error(`Must not be in public_html: ${bad.join(', ')}`);
const stray = webFiles.filter((f) => leftOut.some((d) => f.startsWith(`${d}/`)));
if (stray.length) throw new Error(`A hidden app's page is in public_html: ${stray.slice(0, 3).join(', ')}`);
// Every PHP file in the web root is a door of three lines that hands over to tomlinos/, never real code.
for (const f of webFiles.filter((x) => x.endsWith('.php'))) {
  const text = readFileSync(join(web, f), 'utf8');
  if (!/^<\?php\n\/\/ Door only[^\n]*\nrequire __DIR__ \. '\/\.\.\/\.\.\/tomlinos\/api\/[a-z]+\.php';\n$/.test(text)) throw new Error(`${f} is not a plain door file.`);
}
if (existsSync(join(priv, 'config.php'))) throw new Error('tomlinos/config.php must never ship.');

writeZip(stage, zip);
console.log(`Packaged ${webFiles.length} web files into ${relative(process.cwd(), zip)}`);
