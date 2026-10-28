# TOMLIN OS

A private desktop in your browser that you host yourself. Put it on your own web hosting and you get a desktop with
windows, a file explorer, notes, documents, mail, a calendar, chat between the accounts on your server, a book reader, and an AI
that can run entirely on your own device. Your files live on your server, not someone else's cloud. To upload files, drag them onto the
desktop: they are saved on your server.

**No git needed:** download the release zip, upload it to your web hosting and follow four short steps. See
[Install](#install-download-the-zip-upload-done).

## What's in it

- **Files and documents:** Explorer, Notepad and Notepad Pro, an editor with syntax highlighting, a spreadsheet,
  photos and a photo editor with layers (a light GIMP: selections, retouching, levels and curves, text layers,
  OpenRaster .ora files), a PDF viewer, a media player, archives (zip), and a recycle bin.
- **Write:** a document writer that opens and saves Word documents (.docx), Markdown and plain text, and opens
  WordPad (.rtf) and LibreOffice (.odt) files: fonts, styles, lists, tables, pictures, pages with margins, a header
  and footer, footnotes and a contents page, find and replace, letters from Contacts or a spreadsheet, templates,
  printing and PDF. A Word file from elsewhere keeps the parts Write cannot show when it is saved.
- **Everyday tools:** Mail (IMAP/SMTP, from your server), Calendar, My Projects (your projects and sites, with
  one-click reminders into the calendar: repeat daily, run for a number of days, appointments), Contacts, Calculator,
  Terminal, Task Manager, Shortcuts, and a Panel with today's events, your starred projects and a scratch pad.
- **Chat:** between the accounts on your own server, sealed in the browser (end to end when everyone in the
  conversation has file encryption on; what that does and does not cover is under Security), with safety codes to check
  keys. You can
  delete your own messages (for everyone); the owner can clear General and choose, in Settings, whether messages vanish
  after 3, 7 or 30 days. Each person can also have their AI chats cleared after 3, 7 or 30 days.
- **AI:** Qwen 3.5 0.8B (the default), Gemma 2 2B or Qwen 3.5 4B run in the browser
  on your own graphics chip (WebGPU): nothing you type leaves your device. Chat › Agents also does Summarise, Rewrite and
  Ask about a file. Optionally, each person can add their own Claude or OpenRouter key (Settings › AI), each with a
  monthly spending cap. The built-in models are pinned to fixed versions and checked (SHA-256) before use; the model's
  program is checked in the browser before it runs. If Hugging Face or GitHub ever drops a pinned version, a model
  already saved on the server keeps working; otherwise Find AI models searches Hugging Face for another one to use.
- **Reader:** Sherlock Holmes built in; signed-in people also get the Project Gutenberg library (60,000-odd free
  books, searched on your server) and can save books to their own files.
- **Games and toys:** a RISC-V Studio with its own RV32I processor and example games.

## Security, in short

- Accounts with Argon2 password hashing, brakes on password guessing, two-step sign-in (authenticator app) with
  recovery codes, and a screen lock with a PIN.
- **Optional file encryption, in the browser** (My account > Encryption > Encrypt my files): every file is sealed
  with AES-256-GCM using a key that the server only ever holds wrapped by your password (PBKDF2-SHA256, 600,000
  rounds) and by a recovery key that never leaves your browser. With encryption on, the stored files cannot be read
  by the desktop's owner account or by anyone who copies the data folder. Lose both the password and the recovery
  key and the files cannot be recovered. This protects data at rest: whoever controls the server could change its
  code to capture a password as it is typed, so run TOMLIN OS on a server you control or trust.
- Chat is end to end only when everyone in a conversation has file encryption on (the app says which). Mail
  passwords and the chat key are stored as plain files unless file encryption is on. The owner account can reset
  other people's passwords, which opens their files unless those files are encrypted.
- What chat's encryption does not do, so you can judge it: a direct chat's key is worked out from the two people's
  long-term keys (ECDH P-256) and does not change from message to message, so someone who later gets one of those keys
  can open the earlier messages still kept. General has one key shared by everyone in it: a person added later is given
  that key and can read the General messages still kept from before they joined, and switching an account off stops it
  reaching the server but does not take back the key its browser already has (Clear General removes the messages; the
  key stays). The server checks who sends each message; the encryption alone does not prove the sender to someone who
  holds the same key. It suits a family or a small team on a server they trust; it is not a replacement for a
  messenger like Signal where the server itself must not be trusted.
- Anyone not signed in sees only a book reader (Sherlock Holmes) with a small Log in link, and the screensaver shows
  the same; the owner can choose the plain sign-in instead. Every page asks search engines not to list it.
- The first visit to a new install asks for a set-up code read from the server's own files, so a stranger who finds
  a fresh site first cannot make themselves its owner.
- The real PHP code and all data sit outside the web root; strict security headers (Content Security Policy with
  Trusted Types, HSTS) are sent on every page. Adding a person, switching an account off or on, setting someone's
  password and turning off their two-step all ask for the owner's own password first.

No software is perfectly secure. Keep your host's PHP up to date, use HTTPS, and keep backups. IF using cpanel, you can
use their inbuilt tool to password protect that root folder for additional security. 

## Install: download the zip, upload, done

**You do not need git, Node.js or a command line.** The release zip is the complete, ready-to-run desktop: nothing
to build, no database to create.

**[Download the latest release zip](https://github.com/Matthew4509/tomlinos/releases/latest)** (the file named
`tomlinos-<version>.zip`). Do not use the green **Code > Download ZIP** button: that is the source code, which has to
be built first (see Build from source, below).

### What your hosting needs

Ordinary shared web hosting ("LAMP" hosting) is enough:

- **Apache or LiteSpeed** web server (TOMLIN OS's security settings are in `.htaccess` files, which these read). Hosts
  that run nginx only will not apply them.
- **PHP 8.2 or newer**, kept up to date (at least 8.2.35, 8.3.36, 8.4.27 or 8.5.12: these fix two critical security
  bugs in PHP itself; `server-check.php` says if yours is older), with Argon2 password hashing. Mail, video titles, the Reader's library and Claude also need
  the `openssl` extension; Claude and saving AI models to the server need `curl`.
- **HTTPS** on your domain (most hosts give a free certificate).
- A folder **above** your web root that you can upload to, so your files and accounts live outside the part of
  the server the web can reach.
- No MySQL or other database: TOMLIN OS keeps everything in files.

Hosting control panels this suits: **cPanel** (the one we test on), **DirectAdmin** and **Plesk**, which between them
run most budget shared hosting. A VPS with Apache and PHP works too. Panels built on nginx only (CloudPanel, for
example) do not read `.htaccess`, so they are not suitable.

### Steps (cPanel)

1. In cPanel File Manager, open your **home** folder (the one that contains `public_html`), upload the zip there and
   Extract. It adds files to `public_html/` and a new `tomlinos/` folder beside it.
2. Optional: in cPanel > Terminal run `php tomlinos/tools/server-check.php`. It names anything missing.
3. Copy `tomlinos/config.example.php` to `tomlinos/config.php`, open it, and set `'allow_remote' => true`. Only do this
   with HTTPS working on your domain.
4. Visit your site. The first visit sets up the **owner** account and asks for a set-up code: open
   `tomlinos/data/accounts/SETUP-CODE.txt` in File Manager. The file is deleted once you are set up.

That's it. To update later, extract the new zip the same way: your files, accounts and `config.php` are never in the
zip, so they are kept.

**Other panels:** the zip expects your web root to be called `public_html` with a folder above it. On
**DirectAdmin**, extract it in `domains/<your domain>/`. Where the web root has another name (Plesk's `httpdocs`,
for example), extract the zip in the folder above it, move everything from the new `public_html/` into your web
root, and leave `tomlinos/` where it is, beside the web root. Then follow steps 2 to 4.

`INSTALL.txt` in the zip has the full notes (updating, AI models, a forgotten owner password). Do not put the site
behind a proxy or "Flexible SSL" CDN: the server must see each visitor's real address and a real HTTPS connection.

### Backups and restoring

Everything that is yours is in `tomlinos/data/` (files, accounts, chat) and `tomlinos/config.php`. Saved AI models
(`tomlinos/models/`) can be fetched again, so they need no backup. Back up those two with cPanel's Backup, or File
Manager > Compress. To restore, put them back where they were, then run `php tomlinos/tools/store-check.php` in cPanel >
Terminal: it says whether each person's files hang together. With `--repair` it also finishes a save that was cut
off and corrects the totals; it never deletes a file. Encrypted files open again only with the password or recovery
key that opened them before.

System update keeps the version from before the last update: Application manager > Updates > Go back, or, if the
desktop will not open, `php tomlinos/tools/rollback-update.php` in cPanel > Terminal.

## Build from source

Needs Node.js 22.13 or newer. PHP 8.2+ is needed for the server and its tests.

On Windows, run `git config --global core.longpaths true` before cloning: some file paths in the bundled Claude
library (`server/vendor/`) are longer than Windows allows by default, and the clone stops partway without it.

```
npm install
npm run build      # the page into out/
npm run package    # the release zip into dist/
npm test           # unit and server tests (set PHP_BIN to your php if it is not on the PATH)
npm run check      # type check
```

To run it locally: `php -S 127.0.0.1:3042 -t out server/dev-router.php` from this folder, then open
http://127.0.0.1:3042. Data goes to `../desktop-data` unless `DESKTOP_DATA_DIR` says otherwise.

## Licence

TOMLIN OS is free for **noncommercial** use under the [PolyForm Noncommercial License 1.0.0](LICENSE): for yourself
and your family, for study, research, hobby projects and testing, and for charities, schools, public research,
health and safety bodies and government. You may change it and share it on the same terms. **Any commercial use
needs written permission first**, including using it in or for a business, selling it, or charging to host or run
it for others. To ask, open an issue on this repository. The libraries it bundles keep their own licences (About >
Credits in the app lists them).
