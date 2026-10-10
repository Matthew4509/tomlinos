// Drives Office Printer in a real Chrome: first the stand-alone page (/office-printer/, every one of the 20 endings
// played through the screen, the printouts that must decode, the saved endings, a phone-width screen), then the
// same game inside TOMLIN OS (the desktop icon, Ctrl+P on a file, the saved game in your own files, never the browser's).
// Needs the dev server on a FRESH, EMPTY data folder (the TOMLIN OS part sets up the owner) and `npm run build` done.
//   node test/browser-printer.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';
import { HIDDEN_APPS } from '../src/release.ts';
import { etaFor } from '../public/office-printer/js/engine.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];
// A stuck step must not hang the whole run (browser.close can hang on Windows too).
const deadline = setTimeout(() => {
  console.log('STOPPED: the suite ran over 20 minutes');
  process.exit(2);
}, 20 * 60000);

let page;
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
const shot = async name => SHOTS && page && page.screenshot({ path: `${SHOTS}/printer-${name}.png` });

// ---- Playing the game through its screen ---------------------------------------------------------------------------

/** The game inside `scope` (the page, or a TOMLIN OS window). */
function game(scope) {
  const g = {
    async choices() {
      return scope.locator('.op-choice').evaluateAll(bs => bs.map(b => b.innerText.replace(/^\d\s*/, '').trim()));
    },
    async pick(label, ms = 60000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const list = await g.choices();
        if (list.includes(label)) {
          await scope.locator('.op-choice').filter({ hasText: new RegExp(`^\\d?\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().click();
          return;
        }
        await page.waitForTimeout(80);
      }
      throw new Error(`"${label}" never offered; the chat ends: ${(await g.tail(5)).join(' / ')}`);
    },
    async until(fn, ms = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await fn()) return;
        await page.waitForTimeout(80);
      }
      throw new Error('waited too long');
    },
    async tail(n) {
      const text = await scope.locator('.op-log').innerText().catch(() => '');
      return text.split('\n').filter(Boolean).slice(-n);
    },
    async log() {
      return scope.locator('.op-log').innerText();
    },
    async ending(ms = 60000) {
      const card = scope.locator('.op-ending h2').last();
      await card.waitFor({ timeout: ms });
      return card.innerText();
    },
    /** Waits until the chat has said `text`. */
    async says(text, ms = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if ((await g.log()).includes(text)) return;
        await page.waitForTimeout(80);
      }
      throw new Error(`the chat never said "${text}"; it ends: ${(await g.tail(5)).join(' / ')}`);
    },
    /** A step that failed part-way leaves a print going: cancel it, so the next step starts clean. */
    async stopRun() {
      const cancel = scope.locator('.op-cancel');
      if (await cancel.isVisible()) {
        await cancel.click();
        await scope.locator('button.op-print').waitFor();
      }
    },
    async start() {
      await g.stopRun();
      const again = scope.locator('.op-choice', { hasText: 'Print again' });
      if (await again.count()) await again.click();
      else await scope.locator('button.op-print').click();
    },
    async home() {
      await g.stopRun();
      const change = scope.locator('.op-choice', { hasText: 'Change document' });
      if (await change.count()) await change.click();
      await scope.locator('button.op-print').waitFor();
    },
    async sample(name) {
      await g.home();
      await scope.getByRole('button', { name: 'Change document...' }).click();
      await scope.locator('.op-file', { hasText: name }).click();
      await scope.locator('.op-doc strong', { hasText: name }).waitFor();
      await scope.locator('.op-doc span', { hasText: 'Reading the file' }).waitFor({ state: 'detached', timeout: 20000 });
    },
    async agree() {
      const box = scope.locator('.op-tos-box');
      await box.waitFor({ timeout: 30000 });
      await box.evaluate(el => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await scope.getByRole('button', { name: 'I Agree' }).click();
    },
    async pullPaper() {
      const pull = scope.getByRole('button', { name: 'Pull the paper' });
      await pull.waitFor({ timeout: 30000 });
      for (let i = 0; i < 12 && !(await scope.locator('.op-ending').count()); i++) {
        if (await pull.isEnabled()) await pull.click().catch(() => {});
        await page.waitForTimeout(400);
      }
    },
    async play(labels) {
      await g.start();
      for (const label of labels) await g.pick(label);
      return g.ending();
    },
  };
  return g;
}

const bits = text => (text.match(/\b[01]{8}\b/g) ?? []).map(b => String.fromCharCode(parseInt(b, 2))).join('');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const problems = [];
const watch = p => {
  p.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
  p.on('pageerror', e => problems.push('pageerror: ' + e.message));
};

// ================================================================================================================
console.log('Office Printer, stand-alone page, against ' + BASE);
const alone = await browser.newContext({ viewport: { width: 900, height: 820 } });
page = await alone.newPage();
watch(page);
const op = game(page);
await page.goto(`${BASE}/office-printer/index.html?speed=20`);

await step('the page opens on the report with a Print button, all ink showing full, and no errors', async () => {
  await page.locator('button.op-print').waitFor({ timeout: 20000 });
  eq(await page.locator('.op-doc strong').innerText(), 'Quarterly_Report_FINAL_v3.pdf', 'document');
  eq(await page.locator('.op-ink').getAttribute('aria-label'), 'Ink, LaserJet: cyan full, magenta full, yellow full, black full', 'ink');
  eq(await page.locator('.op-dialog h1').innerText(), 'Print', 'it starts as a plain print dialog');
  ok(!(await page.locator('.op-attempts').isVisible()) && !(await page.locator('.op-top .op-chip', { hasText: 'Endings' }).isVisible()), 'no game counters before the first ending');
  await shot('start');
});

await step('Ctrl+P prints; the example flow: LaserJet busy, Inkjet calibrates away the cyan, Photo Printer, Dot Matrix binary that decodes to TRY FAX', async () => {
  await page.keyboard.press('Control+p');
  await op.pick('OK');
  const early = await op.log();
  for (const line of ['Spooling Quarterly_Report_FINAL_v3.pdf (1 page)...', 'Sending to LaserJet (2nd floor)...', 'LaserJet: Busy']) ok(early.includes(line), `an ordinary print job first: ${line}`);
  await op.until(() => op.choices().then(c => c.includes('Sure')));
  const cover = await page.evaluate(() => {
    const log = document.querySelector('.op-log').getBoundingClientRect();
    const last = [...document.querySelectorAll('.op-log .op-msg')].at(-1).getBoundingClientRect();
    return { last: Math.round(last.bottom), log: Math.round(log.bottom) };
  });
  ok(cover.last <= cover.log, `the answers must not cover the newest line: ${JSON.stringify(cover)}`);
  await op.pick('Just print it');
  await op.pick('Next printer');
  await page.locator('.op-msg p', { hasText: 'What is this... a PDF?' }).waitFor({ timeout: 30000 });
  eq(await page.locator('.op-ink').getAttribute('aria-label'), 'Ink, Photo Printer: cyan full, magenta full, yellow full, black full', 'every printer claims full ink');
  await op.pick("What's wrong with it?");
  await op.pick('Cancel');
  eq(await op.ending(), 'Ending 4/20: Lost in Translation', 'ending');
  const log = await op.log();
  for (const line of ["Sorry, I'm busy.", "I'm going to pretend you said 'sure'.", 'Do you hate me?', 'Everything, darling.', 'Printing pixel 1 of 12,000,000, page 1 of 1...',
    // Today plus 4.5 years: "March 2031" until the last hours of 30 Sep 2026, then later months (a fixed month failed on that day).
    `Estimated completion: ${etaFor(new Date(), 12000000, { etaYears: 4.5, report: [4000, 3000] })}.`, "Rude. I'll be telling the others.", 'HEARD ABOUT YOU. NO HABLO PDF, SEÑOR.']) {
    ok(log.includes(line), `missing line: ${line}`);
  }
  const printout = await page.locator('.op-printout figcaption').last().textContent();
  eq(bits(printout), 'TRY FAX', 'the Dot Matrix binary');
  eq(await page.locator('.op-top .op-chip').first().innerText(), 'Endings 1/20', 'counter');
  await shot('lost-in-translation');
});

await step('the second attempt opens the Terms of Service (47,000 words, I Agree only at the bottom); a fast agree is called a liar', async () => {
  await op.start();
  const agree = page.getByRole('button', { name: 'I Agree' });
  await agree.waitFor({ timeout: 30000 });
  ok(await agree.isDisabled(), 'I Agree waits for the bottom');
  ok((await page.locator('.op-tos .op-small').first().innerText()).includes('47,000 words'), 'says how long it is');
  ok((await page.locator('.op-tos-box').innerText()).includes('4.2 The Printer is not responsible for cyan.'), 'clause 4.2');
  await shot('terms');
  await op.agree();
  await op.pick('No');
  await op.says('Clause 12 says honesty costs $4.99.');
  const log = await op.log();
  ok(/You read 47,000 words in \d+(\.\d)? seconds\. Impressive\. Liar\./.test(log), 'the liar line');
  ok(log.includes('Thank you for your honesty. Clause 12 says honesty costs $4.99.'), 'honesty costs $4.99');
  await op.pick('OK');
  await op.pick('Sure');
  await op.pick("It's fine");
  await op.pick('Please just print it');
  await op.pick('Wait');
  eq(await op.ending(), 'Ending 11/20: Technically Correct', 'ending');
  ok((await op.log()).includes("You're just saying that."), 'the apology');
});

await step('the queue: position 1,278,975, ETA 14 years', async () => {
  eq(await op.play(["I'll wait", 'Keep waiting', 'Keep waiting']), 'Ending 12/20: The Queue', 'ending');
  const queue = await page.locator('.op-printout figcaption', { hasText: 'print queue' }).first().textContent();
  ok(/Your place in the print queue is 1,27\d,\d{3}\. ETA: 14 years\./.test(queue), `the queue: ${queue}`);
});

await step('the Extended Warranty: bought, covers nothing', async () => {
  eq(await op.play(["I'll wait", 'Keep waiting', 'Is there a faster way?', 'The Extended Warranty', 'Buy it']), 'Ending 13/20: Extended Warranty', 'ending');
  ok((await op.log()).includes('It covers everything except ink, paper, jams, print heads, and printing.'), 'covers');
});

await step('No thanks to the warranty: an instant jam; the paper rips every time it is pulled', async () => {
  await op.start();
  for (const label of ["I'll wait", 'Keep waiting', 'Is there a faster way?', 'The Extended Warranty', 'No thanks']) await op.pick(label);
  await op.pullPaper();
  eq(await op.ending(), 'Ending 19/20: The Jam', 'ending');
  await shot('jam');
});

await step('four things to gossip about: the next print, every printer on the network knows you', async () => {
  eq(await op.play(['Who told you?']), 'Ending 18/20: Infamous', 'ending');
  ok((await op.log()).includes('Oh. It\'s you.'), 'recognised');
});

await step('double-sided, for the environment: 400 blank pages', async () => {
  eq(await op.play(["I'll wait", 'Keep waiting', 'Is there a faster way?', 'Double-sided, for the environment', "That's just one side"]), 'Ending 7/20: For the Environment', 'ending');
});

await step('attempt 8: the certificate, then round the network: the Inkjet calibrates away its last drop of cyan', async () => {
  await op.start();
  await page.locator('.op-printout figcaption', { hasText: 'Most Attempts' }).waitFor({ timeout: 30000 });
  for (const label of ["I'll wait", 'Find another printer', 'Connect', 'Could you calibrate?']) await op.pick(label);
  eq(await op.ending(), 'Ending 2/20: Calibrated', 'ending');
});

await step('printing without magenta needs 40 minutes of firmware, then it is out of cyan', async () => {
  eq(await op.play(["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Print it without magenta', 'Wait 40 minutes']), 'Ending 10/20: Firmware', 'ending');
});

await step('attempt 10: Linda\'s card is finished, and the document that prints is the wrong one', async () => {
  eq(await op.play(['Finally!']), 'Ending 16/20: The Wrong Document', 'ending');
});

await step('kind to the Inkjet twice: it falls for your laptop', async () => {
  eq(await op.play(['OK', 'Thanks, I think?']), 'Ending 20/20: Love Story', 'ending');
  ok((await op.log()).includes('I only print for your laptop now.'), 'only for the laptop');
});

await step('round the network: the Dot Matrix overhears HELP I AM TRAPPED IN A CANON; the fax unionises everyone', async () => {
  eq(await op.play(["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Try the fax', 'Can you print my file?']), 'Ending 8/20: Collective Bargaining', 'ending');
  const captions = await page.locator('.op-printout figcaption').allTextContents();
  ok(captions.some(c => bits(c) === 'HELP I AM TRAPPED IN A CANON'), 'the overheard binary decodes');
  await shot('strike');
});

await step('the LaserJet\'s screen: PC LOAD LETTER, and no explanation', async () => {
  eq(await op.play(["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'What does your screen say?', 'What does that mean?']), 'Ending 5/20: PC LOAD LETTER', 'ending');
});

await step('the Canon: Please load A4. That\'s Letter.', async () => {
  eq(await op.play(["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Load A4', 'It says A4 on the box']), 'Ending 14/20: A4 Is Letter', 'ending');
  ok((await op.log()).includes('(please send help)'), 'the Canon whispers');
});

await step('all the way round: back at the Inkjet, now out of cyan AND magenta; the Cyan Loop', async () => {
  eq(await op.play(["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine']), 'Ending 1/20: The Cyan Loop', 'ending');
  eq(await page.locator('.op-ink').getAttribute('aria-label'), 'Ink, Home Inkjet: cyan empty, magenta empty, yellow full, black full', 'the bars finally tell the truth');
  await shot('cyan-loop');
});

await step('IMG_4471.jpg: roasted from its name and colours, then straight to the fridge', async () => {
  await op.sample('IMG_4471.jpg');
  ok((await page.locator('.op-doc span').innerText()).startsWith('Picture · 1600 × 1200'), 'measured');
  eq(await op.play(['OK', 'Please just print it', 'Take it to the home printer']), 'Ending 3/20: Straight to the Fridge', 'ending');
  const log = await op.log();
  ok(log.includes("IMG_4471.jpg. Didn't even name it."), 'name roast');
  ok(log.includes('Mostly cyan. Absolutely not.'), 'colour roast');
  ok(log.includes('Printed at 12 × 12 pixels, as intended.'), 'tiny print');
  await shot('fridge');
});

await step('the same photo pixel by pixel: it stops at the first cyan pixel', async () => {
  await op.start();
  for (const label of ['OK', 'Please just print it', "That's tiny!"]) await op.pick(label);
  await page.locator('.op-msg p', { hasText: 'Cyan. Absolutely not.' }).waitFor({ timeout: 30000 });
  await op.pick('Wait');
  eq(await op.ending(), 'Ending 11/20: Technically Correct', 'ending');
});

await step('a .png with a see-through background prints nothing', async () => {
  await op.sample('logo_transparent.png');
  eq(await op.play(['OK']), 'Ending 15/20: Transparent', 'ending');
  ok((await op.log()).includes('Transparent background detected. Printing nothing, as requested.'), 'line');
});

await step('a Word document: which version exactly, reformatted in Comic Sans, offended', async () => {
  await op.sample('Minutes_Tuesday.docx');
  eq(await op.play(['OK', 'No idea', 'Why is it in Comic Sans?']), 'Ending 6/20: Comic Sans', 'ending');
  ok((await op.log()).includes('Which version of Word? No, which version exactly?'), 'which version');
});

await step('a spreadsheet: 47 pages, one column each, on the Dot Matrix', async () => {
  await op.sample('Budget_2026.xlsx');
  eq(await op.play(['OK', 'Can you fit it on one page?']), 'Ending 11/20: Technically Correct', 'ending');
  ok((await op.log()).includes('47 PAGES. ONE COLUMN EACH.'), '47 pages');
});

await step('plain text: finally, someone with taste; printed perfectly, and the wrong file', async () => {
  await op.sample('notes.txt');
  eq(await op.play(['OK', 'Print it, please']), 'Ending 16/20: The Wrong Document', 'ending');
  ok((await op.log()).includes('FINALLY, SOMEONE WITH TASTE.'), 'taste');
});

await step('a program: absolutely not, I\'ve seen what those do', async () => {
  await op.sample('setup.exe');
  eq(await op.play(['OK', "It's just a setup file"]), 'Ending 8/20: Collective Bargaining', 'ending');
  ok((await op.log()).includes("ABSOLUTELY NOT. I'VE SEEN WHAT THOSE DO."), 'refused');
});

await step('Terms of Service from the start screen: clause 212.1 hides the trapped printer', async () => {
  await op.home();
  await page.getByRole('button', { name: 'Terms of Service' }).click();
  const help = page.getByRole('button', { name: 'Please send help.' });
  await help.waitFor({ timeout: 30000 });
  await help.click();
  eq(await op.ending(), 'Ending 17/20: Clause 212.1', 'ending');
});

await step('the speed-reading test: yes, and yes again; the Hamlet quiz has no right answer', async () => {
  await op.home();
  await page.getByRole('button', { name: 'Terms of Service' }).click();
  await op.agree();
  await op.pick('Yes');
  await op.pick('Yes');
  await page.locator('.op-speed h2').waitFor({ timeout: 30000 });
  ok((await page.locator('.op-speed h2').innerText()).includes('Shakespeare') || (await page.locator('.op-speed h2').innerText()).includes('Hamlet'), 'a work is flashed');
  await op.pick('Yorick', 90000);
  eq(await op.ending(), 'Ending 9/20: Speed Reader', 'ending');
  ok((await op.log()).includes('IT WAS ME. I WAS THERE.'), 'it was me');
});

await step('the warranty pops up at a bad moment on an even attempt; No thanks jams whichever printer you are at', async () => {
  await op.sample('Quarterly_Report_FINAL_v3.pdf');
  // The pop-up comes on even attempts only: play a quick one first if the next would be odd.
  if (Number((await page.locator('.op-attempts').innerText()).replace(/\D/g, '')) % 2 === 0) {
    await op.play(["I'll wait", 'Keep waiting', 'Keep waiting']);
    await op.home();
  }
  await op.start();
  const attempt = Number((await page.locator('.op-attempts').innerText()).replace(/\D/g, ''));
  ok(attempt % 2 === 0, `this must be an even attempt (it is ${attempt})`);
  await op.pick('OK');
  await op.pick('Sure');
  await page.locator('.op-popup').waitFor({ state: 'visible', timeout: 30000 });
  await shot('warranty');
  await page.locator('.op-popup').getByRole('button', { name: 'No thanks' }).click();
  await op.pullPaper();
  eq(await op.ending(), 'Ending 19/20: The Jam', 'ending');
  ok((await op.log()).includes('Home Inkjet\nUnderstood.') || (await page.locator('.op-from-inkjet p', { hasText: 'Understood.' }).count()) > 0, 'the Inkjet jams');
});

await step('20 of 20 found, kept in this browser: a reload remembers them', async () => {
  await page.getByRole('button', { name: /^Endings/ }).first().click();
  eq(await page.locator('#op-endings-title').innerText(), 'Endings: 20 of 20 found', 'all found');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.reload();
  await page.locator('button.op-print').waitFor();
  eq(await page.locator('.op-top .op-chip').first().innerText(), 'Endings 20/20', 'after a reload');
});

await step('phone width (375 x 812): nothing sideways, the choices stack, the ink bar and counters stay', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.locator('button.op-print').waitFor();
  eq(await page.evaluate(() => document.documentElement.scrollWidth), 375, 'page width');
  await op.start();
  await op.pick('OK', 60000).catch(() => {});
  await page.locator('.op-choice').first().waitFor();
  const boxes = await page.locator('.op-choice').evaluateAll(bs => bs.map(b => b.getBoundingClientRect()).map(r => ({ x: Math.round(r.x), w: Math.round(r.width) })));
  ok(boxes.length >= 2 && boxes.every(b => b.x === boxes[0].x), 'choices in one column: ' + JSON.stringify(boxes));
  ok(await page.locator('.op-ink').isVisible(), 'ink visible');
  ok(await page.locator('.op-attempts').isVisible(), 'attempts visible');
  eq(await page.evaluate(() => document.documentElement.scrollWidth), 375, 'page width during a run');
  const small = await page.evaluate(() => [...document.querySelectorAll('.op *')].filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12 && !el.closest('.op-sr')).map(el => el.className || el.tagName));
  eq(small, [], 'text under 12px');
  await shot('phone');
  await page.setViewportSize({ width: 900, height: 820 });
});

await step('no errors on the stand-alone page (a missing Shakespeare text is a 404, which is allowed)', async () => {
  eq(problems.filter(p => !p.includes('404')), [], 'problems');
});
await alone.close();

// ================================================================================================================
// Hidden in this release (src/release.ts): the desktop part waits; the features suite checks it is nowhere on the desktop.
if (HIDDEN_APPS.includes('printer')) console.log('Office Printer inside TOMLIN OS: hidden in this release, not run');
else {
console.log('Office Printer inside TOMLIN OS');
problems.length = 0;
const inside = await browser.newContext({ viewport: { width: 1280, height: 800 } });
page = await inside.newPage();
watch(page);
const front = () => page.locator('.win.active');
const winGame = () => game(page.locator('.win', { has: page.locator('.op') }).first());
async function closeAll() {
  if (await page.locator('.start-menu').isVisible().catch(() => false)) await page.keyboard.press('Escape');
  for (let i = 0; i < 30; i++) {
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
}
await page.clock.install();
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('three minutes in, the printer reports a failed print, Windows-style; Retry sends the document again', async () => {
  await closeAll();
  await page.clock.fastForward('03:30');
  const toast = page.locator('.toast', { hasText: 'LaserJet (2nd floor): Quarterly_Report_FINAL_v3.pdf' });
  await toast.waitFor({ timeout: 20000 });
  await shot('tomlinos-alert');
  await toast.getByRole('button', { name: 'Retry' }).click();
  const w = page.locator('.win', { has: page.locator('.op') });
  await w.locator('.op-system', { hasText: 'Printing Quarterly_Report_FINAL_v3.pdf...' }).waitFor({ timeout: 20000 });
  await w.locator('.op-cancel').click();
  await closeAll();
});

await step('the desktop has an Office Printer icon; double-clicking it opens the game on its start screen', async () => {
  const icon = page.locator('#desktop .item', { has: page.locator('.item-name', { hasText: /^Office Printer$/ }) });
  await icon.waitFor({ timeout: 10000 });
  await icon.dblclick();
  const w = front();
  await w.locator('.op-dialog h1', { hasText: 'Print' }).waitFor({ timeout: 20000 });
  eq(await w.locator('.win-title-text').innerText(), 'Office Printer', 'window title');
  ok(!(await w.locator('.op-attempts').isVisible()), 'no counters yet');
  await shot('tomlinos-window');
});

await step('a print in the window reaches an ending, and the game is kept in your files, not the browser', async () => {
  const g = winGame();
  await g.start();
  // The second print (Retry was the first), so the Terms of Service come first, as on the stand-alone page.
  await g.agree();
  await g.pick('No');
  for (const label of ["I'll wait", 'Keep waiting', 'Keep waiting']) await g.pick(label);
  eq(await g.ending(), 'Ending 12/20: The Queue', 'ending');
  await page.waitForTimeout(800);
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('Office Printer');
  await page.locator('.start-menu [data-app="printer"]').first().click();
  const w = front();
  await w.locator('.op-top .op-chip', { hasText: 'Endings 1/20' }).waitFor({ timeout: 20000 });
  eq(await page.evaluate(() => localStorage.length), 0, 'nothing in localStorage');
  await closeAll();
});

await step('Ctrl+P with nothing open: the printer answers about its own report', async () => {
  await page.locator('#desktop').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Control+p');
  const w = front();
  await w.locator('.op-system', { hasText: 'Printing Quarterly_Report_FINAL_v3.pdf...' }).waitFor({ timeout: 20000 });
  await w.locator('.op-msg p', { hasText: "Sorry, I'm busy." }).waitFor({ timeout: 30000 });
  await closeAll();
});

await step('Ctrl+P in Notepad prints that file: the Dot Matrix takes the plain text', async () => {
  const dir = tempDir('tomlinos-printer-');
  writeFileSync(join(dir, 'memo.txt'), 'Remember to buy cyan.\r\n');
  await page.keyboard.press('Control+Alt+e');
  const explorer = front();
  await explorer.locator('.item', { hasText: 'Documents' }).first().dblclick();
  const chooser = page.waitForEvent('filechooser');
  await explorer.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'memo.txt')]);
  await explorer.locator('.item', { hasText: 'memo' }).first().waitFor({ timeout: 10000 });
  await explorer.locator('.item', { hasText: 'memo' }).first().dblclick();
  await page.locator('.win.active .win-title-text', { hasText: 'memo.txt' }).waitFor({ timeout: 15000 });
  await page.keyboard.press('Control+p');
  const w = page.locator('.win', { has: page.locator('.op') });
  await w.locator('.op-system', { hasText: 'Printing memo.txt...' }).waitFor({ timeout: 20000 });
  const g = winGame();
  await g.pick('OK');
  await w.locator('.op-msg p', { hasText: 'FINALLY, SOMEONE WITH TASTE.' }).waitFor({ timeout: 30000 });
  await shot('tomlinos-ctrl-p');
  await closeAll();
});

await step('Print something else > one of your files, through the desktop\'s own picker', async () => {
  await page.locator('#desktop .item', { has: page.locator('.item-name', { hasText: /^Office Printer$/ }) }).dblclick();
  const w = front();
  await w.getByRole('button', { name: 'Change document...' }).click();
  await w.getByRole('button', { name: 'Choose one of your files...' }).click();
  const dialog = page.locator('.dialog');
  await dialog.locator('.pick-row', { hasText: 'memo.txt' }).click();
  await dialog.getByRole('button', { name: 'Print this' }).click();
  await w.locator('.op-doc strong', { hasText: 'memo.txt' }).waitFor({ timeout: 15000 });
  await closeAll();
});

await step('Ctrl+P is on the Keyboard shortcuts list', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('Keyboard shortcuts');
  await page.locator('.start-menu [data-app="shortcuts"]').first().click();
  await front().getByText('Ctrl+P', { exact: true }).waitFor({ timeout: 10000 });
  await closeAll();
});

await step('no errors inside TOMLIN OS', async () => eq(problems.filter(p => !p.includes('404')), [], 'problems'));

clearTimeout(deadline);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed: ' + failures.join('; '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
process.exit(failures.length ? 1 : 0);
