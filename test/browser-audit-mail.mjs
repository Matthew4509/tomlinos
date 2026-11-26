// Audit of Mail (and its compose window) in a real Chrome, against the stand-in mail server (test/fake-mail.mjs).
// Needs `npm run build` done and a PHP server on a FRESH, EMPTY data folder, started with
// DESKTOP_MAIL_ALLOW_HOSTS=127.0.0.1:<imap>,127.0.0.1:<smtp> DESKTOP_MAIL_ALLOW_PLAIN=1.
//   MAIL_IMAP_PORT=3143 MAIL_SMTP_PORT=3587 node test/browser-audit-mail.mjs [http://127.0.0.1:3110] [screenshot folder]
// Steps marked P0 fail now and should pass once the fault is fixed; P1 steps report faults of lesser weight.
import { chromium } from 'playwright-core';
import { startFakeMail, USER as MAIL_USER, PASS as MAIL_PASS } from './fake-mail.mjs';
import { parseMessage } from '../src/apps/mail/mime.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3110';
const SHOTS = process.argv[3] ?? null;
const IMAP = Number(process.env.MAIL_IMAP_PORT ?? 3143);
const SMTP = Number(process.env.MAIL_SMTP_PORT ?? 3587);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const msg = (head, body) => head.join('\r\n') + '\r\n\r\n' + body + '\r\n';
const fake = await startFakeMail({ imap: IMAP, smtp: SMTP });
const add = (box, raw, seen = false) => {
  const b = fake.boxes[box];
  b.msgs.push({ uid: b.next++, raw, flags: new Set(seen ? ['\\Seen'] : []), date: new Date() });
};
fake.boxes.Drafts = { validity: 9, next: 1, msgs: [] };
add('Drafts', msg(['From: ' + MAIL_USER, 'To: zed@example.org', 'Subject: Half written', 'Content-Type: text/plain'], 'Dear Zed, I was going to say'), true);
add('Sent', msg(['From: ' + MAIL_USER, 'To: Carol <carol@example.org>', 'Subject: My sent note', 'Date: Tue, 29 Sep 2026 09:00:00 +1000', 'Message-ID: <s1@example.test>', 'Content-Type: text/plain'], 'Carol, the hedge is done.'), true);
add('INBOX', msg(['From: News <news@letters.example>', 'To: ' + MAIL_USER, 'Subject: HTML only letter', 'Message-ID: <h1@letters.example>', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8'],
  '<html><head><style>.promo{color:red;font-size:40px}</style></head><body><p>First line</p><p>Second line<br>Third line</p><script>var leakedScriptText=1</script></body></html>'));
add('INBOX', msg(['From: Pat <pat@example.org>', 'To: ' + MAIL_USER, 'Subject: Plan from my Mac', 'Message-ID: <a1@example.org>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="AP"'],
  ['--AP', 'Content-Type: text/plain', '', 'See the plan.', '--AP', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: inline; filename="plan.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--AP--'].join('\r\n')));
add('INBOX', msg(['From: Dot <dot@example.org>', 'To: ' + MAIL_USER, 'Subject: Unread to delete', 'Content-Type: text/plain'], 'delete me'));
add('INBOX', msg(['From: Dot <dot@example.org>', 'To: ' + MAIL_USER, 'Subject: Unread to move', 'Content-Type: text/plain'], 'move me'));
add('INBOX', msg(['From: Logo <logo@example.org>', 'To: ' + MAIL_USER, 'Subject: Embedded data picture', 'Content-Type: text/html'], '<p>Our logo:</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="logo"><p><a href="mailto:bob@example.org">write to Bob</a></p>'));
add('INBOX', msg(['From: Notes <notes@example.org>', 'To: ' + MAIL_USER, 'Subject: Notes file', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="NB"'],
  ['--NB', 'Content-Type: text/plain', '', 'Notes attached.', '--NB', 'Content-Type: text/plain; name="notes.txt"', '', 'line in the notes file', '--NB--'].join('\r\n')));
add('INBOX', msg(['From: =?ISO-2022-JP?B?GyRCOzNFRBsoQg==?= <yamada@example.jp>', 'To: ' + MAIL_USER, 'Subject: =?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=', 'Content-Type: text/plain; charset=ISO-2022-JP'], '\x1b$B$3$s$K$A$O\x1b(B'));
{
  const big = Buffer.alloc(12 * 1024 * 1024, 7).toString('base64').replace(/.{76}/g, '$&\r\n');
  add('INBOX', msg(['From: Big <big@example.org>', 'To: ' + MAIL_USER, 'Subject: Huge attachment', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BG"'],
    ['--BG', 'Content-Type: text/plain', '', 'A big file.', '--BG', 'Content-Type: application/octet-stream; name="big.bin"', 'Content-Disposition: attachment; filename="big.bin"', 'Content-Transfer-Encoding: base64', '', big, '--BG--'].join('\r\n')));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const mailWin = () => page.locator('.win', { has: page.locator('.mail') });
const composeWin = () => page.locator('.win', { has: page.locator('.compose') });
async function closeCompose() {
  for (let i = 0; i < 5 && (await composeWin().count()); i++) {
    await composeWin().last().locator('.win-close').first().click();
    const d = page.locator('.dialog');
    await page.waitForTimeout(150);
    if (await d.count()) await d.getByRole('button', { name: /without saving|Lose the changes|Close anyway|Discard/ }).first().click().catch(() => d.getByRole('button').last().click());
  }
}
const openRow = async subject => {
  const w = mailWin();
  await w.locator('.mail-row', { hasText: subject }).click();
  await w.locator('.mail-head h2', { hasText: subject }).waitFor({ timeout: 20000 });
};
const deliveredWith = s => fake.delivered.filter(d => d.raw.includes(`Subject: ${s}`));

console.log(`Mail audit against ${BASE} (IMAP ${IMAP}, SMTP ${SMTP})`);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

async function fillServers(w, password) {
  await w.getByLabel('Email address', { exact: true }).fill(MAIL_USER);
  await w.getByLabel('Provider', { exact: true }).selectOption('other');
  await w.getByLabel('Password', { exact: true }).fill(password);
  if (!(await w.locator('.mail-adv').evaluate(d => d.open))) await w.locator('.mail-adv summary').click();
  const servers = w.locator('.mail-servers');
  await servers.getByLabel('Server').nth(0).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(0).fill(String(IMAP));
  await servers.getByLabel('Security').nth(0).selectOption('none');
  await servers.getByLabel('Server').nth(1).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(1).fill(String(SMTP));
  await servers.getByLabel('Security').nth(1).selectOption('none');
}

await step('setup: a wrong password is refused with a clear reason and nothing is saved', async () => {
  await openApp('mail');
  const w = mailWin();
  await w.locator('.mail-setup').waitFor({ timeout: 20000 });
  await fillServers(w, 'wrong-password');
  await w.getByRole('button', { name: 'Test and save' }).click();
  await w.locator('.mail-test .bad').first().waitFor({ timeout: 20000 });
  ok(/refused the name or password/.test(await w.locator('.mail-test').innerText()), 'says the password was refused');
  ok(await w.locator('.mail-setup').isVisible(), 'stays on setup');
});

await step('setup: the right password signs in and Inbox lists every message', async () => {
  const w = mailWin();
  await w.getByLabel('Password', { exact: true }).fill(MAIL_PASS);
  await w.getByRole('button', { name: 'Test and save' }).click();
  await w.locator('.mail-row').first().waitFor({ timeout: 20000 });
  eq(await w.locator('.mail-row').count(), fake.boxes.INBOX.msgs.length, 'all inbox rows');
});

await step('P1 settings: typing in the email field keeps the server settings already entered', async () => {
  const w = mailWin();
  await w.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.menu').getByText('Mailbox settings...').click();
  await w.locator('.mail-setup').waitFor();
  const email = w.getByLabel('Email address', { exact: true });
  await email.press('End');
  await email.type('x');
  await email.press('Backspace');
  const host = await w.locator('.mail-servers').getByLabel('Server').nth(0).inputValue();
  const port = await w.locator('.mail-servers').getByLabel('Port').nth(0).inputValue();
  // Back to mail either way, so later steps run.
  await w.getByRole('button', { name: 'Back to mail' }).click();
  await w.locator('.mail-row').first().waitFor({ timeout: 20000 });
  eq([host, port], ['127.0.0.1', String(IMAP)], 'IMAP server after editing the address');
});

await step('reading: a Japanese (ISO-2022-JP) sender, subject and body show as text', async () => {
  await openRow('こんにちは');
  const w = mailWin();
  ok((await w.locator('.mail-head').innerText()).includes('山田'), 'sender name decoded');
  ok((await w.locator('.mail-text').innerText()).includes('こんにちは'), 'body decoded');
});

await step('P0 compose: Ctrl+Enter pressed twice sends the message once', async () => {
  const w = mailWin();
  await w.getByRole('button', { name: '✉ New' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  await c.getByLabel('To').fill('once@example.org');
  await c.getByLabel('Subject').fill('Only once please');
  await c.locator('.compose-text').fill('Hello.');
  await c.locator('.compose-text').press('Control+Enter');
  await c.locator('.compose-text').press('Control+Enter').catch(() => {});
  for (let i = 0; i < 60 && !deliveredWith('Only once please').length; i++) await page.waitForTimeout(250);
  await page.waitForTimeout(3000);
  await closeCompose();
  eq(deliveredWith('Only once please').length, 1, 'times delivered');
});

await step('P0 compose: Send clicked, then Ctrl+Enter while it is sending, sends once', async () => {
  const w = mailWin();
  await w.getByRole('button', { name: '✉ New' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  await c.getByLabel('To').fill('twice@example.org');
  await c.getByLabel('Subject').fill('Click then keys');
  await c.locator('.compose-text').fill('Hello.');
  await c.getByRole('button', { name: 'Send' }).click();
  await c.locator('.compose-text').press('Control+Enter').catch(() => {});
  await page.waitForTimeout(4000);
  await closeCompose();
  eq(deliveredWith('Click then keys').length, 1, 'times delivered');
});

await step('compose: an address the server refuses leaves the message there with the reason', async () => {
  const w = mailWin();
  await w.getByRole('button', { name: '✉ New' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  await c.getByLabel('To').fill('not an address');
  await c.getByLabel('Subject').fill('Bad address');
  await c.locator('.compose-text').fill('Keep me.');
  await c.getByRole('button', { name: 'Send' }).click();
  await c.locator('.statusbar', { hasText: 'Not sent' }).waitFor({ timeout: 15000 });
  ok(await c.getByRole('button', { name: 'Send' }).isEnabled(), 'Send can be pressed again');
  eq(await c.locator('.compose-text').inputValue(), 'Keep me.', 'text kept');
  eq(deliveredWith('Bad address').length, 0, 'nothing delivered');
  await closeCompose();
});

await step('P1 compose: a message can be saved as a draft (Drafts folder)', async () => {
  const w = mailWin();
  await w.getByRole('button', { name: '✉ New' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  const has = await c.getByRole('button', { name: /draft/i }).count();
  await closeCompose();
  ok(has > 0, 'no Save draft button in the compose window');
});

await step('P1 reading: a message in Drafts can be opened to carry on writing it', async () => {
  const w = mailWin();
  await w.locator('.mail-folder', { hasText: 'Drafts' }).click();
  await openRow('Half written');
  const can = await w.getByRole('button', { name: /edit|continue|resume/i }).count();
  await w.locator('.mail-folder', { hasText: 'Inbox' }).click();
  await w.locator('.mail-row').first().waitFor({ timeout: 20000 });
  ok(can > 0, 'no way to carry on writing a draft');
});

await step('P1 reply: replying to an HTML-only message quotes its words line by line, not its style sheet or script', async () => {
  await openRow('HTML only letter');
  const w = mailWin();
  await w.getByRole('button', { name: 'Reply', exact: true }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  const text = await c.locator('.compose-text').inputValue();
  await closeCompose();
  ok(!/promo|color:red|leakedScriptText/.test(text), 'quote carries CSS or script text: ' + JSON.stringify(text.slice(0, 200)));
  ok(/> First line\n(> *\n)?> Second line\n> Third line/.test(text), 'paragraphs and line breaks kept: ' + JSON.stringify(text.slice(0, 200)));
});

await step('P1 forward: an attachment sent "inline" (as Apple Mail does) goes with the forward', async () => {
  await openRow('Plan from my Mac');
  const w = mailWin();
  ok((await w.locator('.mail-atts').innerText()).includes('plan.pdf'), 'the reader lists plan.pdf');
  await w.getByRole('button', { name: 'Forward' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  const atts = await c.locator('.compose-atts').innerText();
  await closeCompose();
  ok(atts.includes('plan.pdf'), 'forward attachments: ' + JSON.stringify(atts));
});

await step('P1 reply: replying to a message in Sent writes to the person it was sent to, not to yourself', async () => {
  const w = mailWin();
  await w.locator('.mail-folder', { hasText: 'Sent' }).click();
  await openRow('My sent note');
  await w.getByRole('button', { name: 'Reply', exact: true }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  const to = await c.getByLabel('To').inputValue();
  await closeCompose();
  await w.locator('.mail-folder', { hasText: 'Inbox' }).click();
  await w.locator('.mail-row').first().waitFor({ timeout: 20000 });
  ok(to.includes('carol@example.org'), 'To: ' + to);
});

await step('P1 reading: a text file attached without a disposition is offered as a file, not run into the body', async () => {
  await openRow('Notes file');
  const w = mailWin();
  const atts = await w.locator('.mail-atts').count();
  ok(atts > 0 && (await w.locator('.mail-atts').innerText()).includes('notes.txt'), 'notes.txt not offered: body is ' + JSON.stringify(await w.locator('.mail-text').innerText()));
});

await step('P1 reading: a picture embedded in the mail (data:) is not reported as "from the web"', async () => {
  await openRow('Embedded data picture');
  const w = mailWin();
  const note = (await w.locator('.mail-blocked').count()) ? await w.locator('.mail-blocked').innerText() : '';
  ok(!/from the web/.test(note), 'note: ' + note);
});

await step('P1 reading: a mailto: link in a message opens a new message in Mail', async () => {
  const w = mailWin();
  const link = w.locator('.mail-text a', { hasText: 'write to Bob' });
  await link.waitFor();
  const popup = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await link.click();
  const p = await popup;
  if (p) await p.close().catch(() => {});
  await page.waitForTimeout(800);
  const opened = await composeWin().count();
  await closeCompose();
  ok(opened > 0, 'no compose window opened for mailto (target=_blank hands it to the browser)');
});

await step('P1 unread: deleting an unread message lowers the Inbox unread count', async () => {
  const w = mailWin();
  const count = async () => Number((await w.locator('.mail-folder', { hasText: 'Inbox' }).locator('.mail-count').innerText().catch(() => '0')) || 0);
  // Select it without opening it (opening marks it read): mark unread again after opening.
  await openRow('Unread to delete');
  await w.getByRole('button', { name: 'Mark unread' }).click();
  await w.locator('.mail-row.unread', { hasText: 'Unread to delete' }).waitFor();
  const before = await count();
  await w.getByRole('button', { name: 'Delete' }).click();
  await w.locator('.statusbar', { hasText: 'Moved to Deleted' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await count();
  eq(after, before - 1, 'unread count after deleting an unread message');
});

await step('P1 unread: moving an unread message lowers the Inbox unread count', async () => {
  const w = mailWin();
  const count = async () => Number((await w.locator('.mail-folder', { hasText: 'Inbox' }).locator('.mail-count').innerText().catch(() => '0')) || 0);
  await w.locator('.mail-row', { hasText: 'Unread to move' }).waitFor();
  await openRow('Unread to move');
  await w.getByRole('button', { name: 'Mark unread' }).click();
  await w.locator('.mail-row.unread', { hasText: 'Unread to move' }).waitFor();
  const before = await count();
  await w.getByRole('button', { name: 'Move to ▾' }).click();
  await page.locator('.menu').getByText('Garden').click();
  await w.locator('.statusbar', { hasText: 'Moved to' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  eq(await count(), before - 1, 'unread count after moving an unread message');
});

await step('attachments out: a file from Documents with a non-ASCII name is sent and arrives whole', async () => {
  await openRow('Invoice attached');
  const w = mailWin();
  await w.locator('.mail-att', { hasText: 'invoice.txt' }).click();
  const d = page.locator('.dialog');
  await d.getByLabel('File name').fill('résumé ünï.txt');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved' }).first().waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: '✉ New' }).click();
  const c = composeWin();
  await c.locator('.compose-text').waitFor();
  await c.getByLabel('To').fill('Dee Example <dee@example.org>');
  await c.getByLabel('Subject').fill('With file');
  await c.locator('.compose-text').fill('Here it is.');
  await c.getByRole('button', { name: /Attach/ }).click();
  await page.locator('.pick-row', { hasText: 'résumé ünï.txt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Open' }).click();
  await c.locator('.compose-atts', { hasText: 'résumé' }).waitFor();
  await c.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: 'Sent to' }).first().waitFor({ timeout: 20000 });
  const got = deliveredWith('With file');
  eq(got.length, 1, 'delivered');
  const m = parseMessage(new Uint8Array(Buffer.from(got[0].raw, 'latin1')));
  eq(m.attachments.map(a => a.name), ['résumé ünï.txt'], 'attachment name');
  eq(Buffer.from(m.attachments[0].data).toString(), 'Invoice 42: $150 for pruning', 'attachment bytes');
  eq(fake.boxes.Sent.msgs.filter(x => x.raw.includes('Subject: With file')).length, 1, 'a copy in Sent');
});

await step('P1 compose: the name typed with an address ("Dee Example <...>") is kept in the To line', async () => {
  const got = deliveredWith('With file');
  ok(got.length && /^To: .*Dee Example/m.test(got[0].raw), 'To line: ' + (/^To: .*$/m.exec(got[0]?.raw ?? '')?.[0] ?? ''));
});

await step('search: words in a body find the message; clearing the search shows the folder again', async () => {
  const w = mailWin();
  const s = w.getByLabel('Search this folder');
  await s.fill('magnolia');
  await s.press('Enter');
  await w.locator('.statusbar', { hasText: 'matching' }).waitFor({ timeout: 15000 });
  eq(await w.locator('.mail-row').count(), 1, 'one match');
  await s.fill('');
  await s.press('Enter');
  await w.locator('.statusbar', { hasText: /^Inbox: \d+ messages/ }).waitFor({ timeout: 15000 });
});

await step('reading: a 12 MB attachment opens within 20 seconds and offers the file', async () => {
  const t = Date.now();
  await openRow('Huge attachment');
  const w = mailWin();
  ok((await w.locator('.mail-atts').innerText()).includes('big.bin'), 'big.bin offered');
  console.log('       (opened in ' + (Date.now() - t) + ' ms)');
});

await step('keyboard: Arrow keys move through messages and Delete removes the open one, focus stays in the list', async () => {
  const w = mailWin();
  await w.locator('.mail-row').first().click();
  await w.locator('.mail-head').waitFor();
  await w.locator('.mail-list').focus();
  const first = await w.locator('.mail-row.on .mail-subj').innerText();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1200);
  const second = await w.locator('.mail-row.on .mail-subj').innerText();
  ok(first !== second, 'ArrowDown moved');
  await page.keyboard.press('Delete');
  await w.locator('.statusbar', { hasText: 'Moved to Deleted' }).waitFor({ timeout: 15000 });
  const inMail = await page.evaluate(() => !!document.activeElement?.closest('.mail'));
  ok(inMail, 'focus left Mail after Delete: ' + (await page.evaluate(() => document.activeElement?.className)));
});

await step('P1 small window: at 520 x 360 (the smallest Mail allows) every toolbar button can be reached', async () => {
  const w = mailWin();
  await page.setViewportSize({ width: 800, height: 600 });
  // Size the window to its minimum through the shell's own drag edge is fiddly; set it the way a drag would end.
  await w.evaluate(el => {
    el.style.width = '520px';
    el.style.height = '360px';
  });
  await page.waitForTimeout(300);
  await shot('mail-small');
  const hidden = await w.locator('.mail-bar > *').evaluateAll(els => {
    const bar = els[0].parentElement.getBoundingClientRect();
    return els.filter(e => {
      const r = e.getBoundingClientRect();
      return r.right > bar.right + 1 || r.width < 4;
    }).map(e => e.getAttribute('aria-label') || e.textContent);
  });
  const readerW = await w.locator('.mail-reader').evaluate(e => e.getBoundingClientRect().width);
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(!hidden.length, 'toolbar parts cut off: ' + JSON.stringify(hidden));
  ok(readerW > 150, 'reader only ' + readerW + 'px wide');
});

await step('P0 narrow screen: on a 400 px wide screen (windows go full screen) an opened message can be read', async () => {
  await page.setViewportSize({ width: 400, height: 760 });
  await page.waitForTimeout(500);
  const w = mailWin();
  await w.locator('.mail-row').first().click();
  await page.waitForTimeout(1500);
  await shot('mail-narrow');
  const r = await w.locator('.mail-reader').evaluate(e => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  ok(r.w >= 250 && r.right <= 401, 'reader box at 400 px: ' + JSON.stringify(r));
});

await step('server errors: with the mail server down, Check for new mail says so and Mail keeps working', async () => {
  const w = mailWin();
  await fake.close();
  await w.getByRole('button', { name: 'Check for new mail' }).click();
  await w.locator('.statusbar', { hasText: /could not|did not answer|dropped/ }).waitFor({ timeout: 30000 });
  ok(await w.locator('.mail-row').count() > 0, 'the list is still there');
});

await step('no errors in the page console', async () => {
  const real = problems.filter(p => !/Failed to load resource|502|Bad Gateway/.test(p));
  ok(!real.length, real.join('\n'));
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
