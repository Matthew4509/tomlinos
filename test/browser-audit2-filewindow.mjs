// Round-2 audit of the shared Open / Save as / Choose a folder window (src/shell/filepicker.ts) and File Explorer, in a
// real browser. Each FW step was written to catch a fault found by reading the code or by trying to break the window;
// a FAIL points at a P0 that is still there, an "info" line at a P1 or P2 kept for the owner. The other steps check
// rules the window keeps today (Enter and Escape scoped to their box, Replace asked, a folder name refused...).
// Needs the dev server on a FRESH, EMPTY data folder and `node tools/build.mjs` done.
//   node test/browser-audit2-filewindow.mjs [http://127.0.0.1:3501] [shots]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3501';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'audit2-filewindow-made-up-pass-31';
let passed = 0;
const failures = [];
const ok = (cond, what) => {
  if (cond) passed++;
  else failures.push(what);
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
};
const info = (cond, what) => console.log((cond ? '  ok   ' : '  info ') + what);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const p = await context.newPage();
p.on('pageerror', e => failures.push(`page error: ${e.message}`));

async function signIn(page) {
  await page.goto(BASE);
  const first = await Promise.race([
    page.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 }).then(() => 'setup'),
    page.getByRole('button', { name: 'Log in for more' }).waitFor({ timeout: 30000 }).then(() => 'reader'),
    page.locator('#desktop .item').first().waitFor({ timeout: 30000 }).then(() => 'in'),
  ]);
  if (first === 'setup') {
    await page.getByLabel('Your name').fill('Audit');
    await page.getByLabel('User name (for signing in)').fill('auditor');
    await page.locator('.gate input[type=password]').fill(PASS);
    await page.locator('.gate-go').click();
    await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
    await page.locator('.gate .check-row input').click();
    await page.getByRole('button', { name: 'Continue' }).click();
  } else if (first === 'reader') {
    await page.getByRole('button', { name: 'Log in for more' }).click();
    await page.getByLabel('Username').fill('auditor');
    await page.locator('input[type=password]').first().fill(PASS);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
}

async function openApp(page, name) {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(name);
  await page.locator('.start-menu .start-item', { hasText: name }).first().click();
  await page.locator('.win.active').waitFor();
  await page.waitForTimeout(500);
  return page.locator('.win.active');
}
async function closeAll(page = p) {
  for (let i = 0; i < 12; i++) {
    if (await page.locator('.dialog').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      continue;
    }
    const close = page.locator('.win.active .win-close');
    if (!(await close.count())) break;
    await close.click();
    await page.waitForTimeout(300);
    const discard = page.locator('.dialog button', { hasText: /Close|Discard|Don.t save|Don.t keep/ }).first();
    if (await discard.count()) await discard.click();
    await page.waitForTimeout(200);
  }
}
const shot = async name => SHOTS && p.screenshot({ path: `${SHOTS}/fw-${name}.png` });

// The window as it is open now (the last dialog holding a .pick).
const pick = (page = p) => page.locator('.dialog:has(.pick)').last();
const crumbs = async (page = p) => (await pick(page).locator('.crumb').allTextContents()).join(' > ');
const rowNames = async (page = p) => pick(page).locator('.pick-row .pick-name').allTextContents();

/** Quick Notes with some text and its Save as window open. */
async function quickNotesSaveAs(text = 'hello') {
  const win = await openApp(p, 'Quick Notes');
  await win.locator('textarea').fill(text);
  await p.keyboard.press('Control+Shift+S');
  await pick().waitFor();
  await p.waitForTimeout(500);
  return win;
}
async function goTop() {
  await pick().locator('.crumb', { hasText: 'This desktop' }).click();
  await p.waitForTimeout(400);
}
/** Renames a row of the window's list through F2 (the window's own Rename). */
async function renameRow(from, to) {
  await pick().locator('.pick-row', { hasText: from }).first().click();
  await pick().locator('.pick-list').press('F2');
  await p.waitForTimeout(200);
  const edit = pick().locator('input.pick-edit');
  await edit.fill(to);
  await edit.press('Enter');
  await p.waitForTimeout(700);
}

await signIn(p);
console.log('signed in');

// ---- FW-1: the window's Rename changes the desktop's standard folders --------------------------------------------------
// Explorer and the desktop refuse to rename Desktop, Documents, Pictures, Videos and Music (actions.ts protectedReason).
// The file window calls fs.rename directly, so it renames them; with nothing selected, its Rename button renames the
// folder being shown, which in every app's first Save as is Documents.
try {
  await quickNotesSaveAs();
  ok((await crumbs()).endsWith('Documents'), `Save as opens in Documents (${await crumbs()})`);
  await pick().locator('button[aria-label="Rename (F2)"]').click();
  await p.waitForTimeout(300);
  const box = pick().locator('input.pick-edit');
  if (await box.count()) {
    await box.fill('Docs');
    await box.press('Enter');
    await p.waitForTimeout(800);
  }
  await goTop();
  const top = await rowNames();
  ok(top.includes('Documents') && !top.includes('Docs'), `FW-1: Rename with nothing selected must not rename the standard Documents folder (top folder now: ${top.join(', ')})`);
  if (top.includes('Docs')) await renameRow('Docs', 'Documents');

  // The Desktop folder: renamed from the window, the desktop loses every icon after a reload.
  await renameRow('Desktop', 'Desk');
  const after = await rowNames();
  ok(after.includes('Desktop') && !after.includes('Desk'), `FW-1: F2 in the window must not rename the standard Desktop folder (top folder now: ${after.join(', ')})`);
  if (after.includes('Desk')) {
    // Shown before putting it back: what the person sees after a reload.
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await closeAll();
    await p.reload();
    await signIn(p);
    await p.waitForTimeout(1000);
    const empty = (await p.locator('#desktop .fv-empty').allTextContents()).join(' ');
    console.log(`       (after the rename and a reload the desktop says: "${empty}")`);
    await shot('fw1-desktop');
    await quickNotesSaveAs();
    await goTop();
    await renameRow('Desk', 'Desktop');
  }
  await closeAll();
} catch (e) {
  ok(false, `FW-1: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- Rules the window keeps: Enter and Escape in their own boxes, Replace asked, a folder name refused ------------------
try {
  await quickNotesSaveAs('first text');
  const nameBox = pick().locator('.pick-name-box');
  await nameBox.fill('kept.txt');
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(1200);
  ok((await p.locator('.dialog').count()) === 0, 'Save as saves kept.txt in Documents');
  await closeAll();

  await quickNotesSaveAs('second text');
  // Search: Enter finds, never saves; Escape clears the box, never closes the window.
  const search = pick().locator('.pick-search');
  await search.fill('kept');
  await search.press('Enter');
  await p.waitForTimeout(300);
  ok((await pick().count()) === 1, 'Enter in the search box does not press Save');
  await search.press('Escape');
  await p.waitForTimeout(300);
  ok((await pick().count()) === 1 && (await search.inputValue()) === '', 'Escape in a search box with text clears it and leaves the window open');
  // New folder: Escape in its name box closes only the box; Enter there does not press Save.
  await pick().locator('.pick-list').click({ position: { x: 4, y: 4 } }).catch(() => {});
  await pick().locator('button[aria-label="New folder"]').click();
  await p.waitForTimeout(500);
  const edit = pick().locator('input.pick-edit');
  await edit.waitFor({ timeout: 5000 }).catch(() => {});
  ok((await edit.count()) === 1, 'New folder puts a name box over the new folder');
  await edit.fill('Letters');
  await edit.press('Enter');
  await p.waitForTimeout(700);
  ok((await pick().count()) === 1 && (await rowNames()).includes('Letters'), 'Enter in the new folder\'s name box names it and does not press Save');
  await renameRow('Letters', 'kept.txt');
  ok((await rowNames()).filter(n => n.toLowerCase() === 'kept.txt').length === 1 && (await rowNames()).includes('Letters'), 'renaming a folder to a file\'s name is refused; nothing merged');
  const said = (await pick().locator('.dialog-problem').textContent()) ?? '';
  ok(/already/i.test(said), `and says why in words ("${said}")`);
  await pick().locator('.pick-row', { hasText: 'Letters' }).click();
  await pick().locator('.pick-list').press('F2');
  await p.waitForTimeout(200);
  await pick().locator('input.pick-edit').press('Escape');
  await p.waitForTimeout(300);
  ok((await pick().count()) === 1 && (await pick().locator('input.pick-edit').count()) === 0, 'Escape in a rename box closes only the box');
  // The name box: a folder's name and Enter opens the folder.
  await nameBox.fill('letters');
  await nameBox.press('Enter');
  await p.waitForTimeout(600);
  ok((await crumbs()).endsWith('Letters') && (await pick().count()) === 1, `a folder's name and Enter in the file name box opens that folder (${await crumbs()})`);
  await pick().locator('button[aria-label="Up one folder"]').click();
  await p.waitForTimeout(400);
  // An existing name asks first.
  await nameBox.fill('kept');
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(500);
  const ask = p.locator('.dialog', { hasText: 'Replace it?' });
  ok((await ask.count()) === 1, 'saving as an existing name asks "Replace it?" first');
  await ask.getByRole('button', { name: 'Choose another name' }).click();
  await p.waitForTimeout(600);
  // A folder's name is refused (typed with the ending the type adds).
  await nameBox.fill('Letters');
  await pick().locator('select.pick-type-box').selectOption({ label: 'All files (*.*)' });
  await nameBox.fill('Letters');
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(500);
  const refused = p.locator('.dialog', { hasText: 'That is a folder' });
  ok((await refused.count()) === 1, 'saving under a folder\'s name is refused in words');
  if (await refused.count()) await refused.getByRole('button', { name: 'OK' }).click();
  await p.waitForTimeout(600);
  // The type drop-down swaps the ending.
  await pick().locator('select.pick-type-box').selectOption({ label: 'Text document (*.txt)' });
  await nameBox.fill('notes.txt');
  await pick().locator('select.pick-type-box').selectOption({ label: 'Markdown (*.md)' });
  ok((await nameBox.inputValue()) === 'notes.md', `choosing Markdown makes notes.txt notes.md (${await nameBox.inputValue()})`);
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(1200);
  ok((await p.locator('.dialog').count()) === 0, 'and Save saves it');
  await closeAll();
  // Rule 1: after a reload the file is where the window showed, under that name.
  await p.reload();
  await signIn(p);
  const ex = await openApp(p, 'File Explorer');
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await p.waitForTimeout(800);
  const docs = await ex.locator('.item .item-name').allTextContents();
  ok(docs.includes('notes.md') && docs.includes('kept.txt'), `after a reload Documents holds notes.md and kept.txt (${docs.join(', ')})`);
  await closeAll();
} catch (e) {
  ok(false, `window rules: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- FW-2 (P1): a name the window cannot use greys out Save and says nothing ------------------------------------------
try {
  await quickNotesSaveAs();
  const nameBox = pick().locator('.pick-name-box');
  await nameBox.fill('plan: week 1.txt');
  await p.waitForTimeout(200);
  const disabled = await pick().locator('.btn.primary').isDisabled();
  const said = ((await pick().locator('.dialog-problem').textContent()) ?? '').trim();
  info(!disabled || said !== '', `FW-2 (P1): a name with ":" turns Save grey ${disabled ? 'with no words' : ''} (problem line: "${said}"); New folder and Rename say why, the file name box does not`);
  await closeAll();
} catch (e) {
  info(false, `FW-2: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- FW-3 (P1): Back and Forward stick on a folder deleted in another tab -------------------------------------------------
try {
  await quickNotesSaveAs();
  for (const name of ['Alpha', 'Beta']) {
    await pick().locator('.pick-list').click({ position: { x: 4, y: 4 } }).catch(() => {});
    await pick().locator('button[aria-label="New folder"]').click();
    await pick().locator('input.pick-edit').waitFor({ timeout: 5000 });
    await pick().locator('input.pick-edit').fill(name);
    await pick().locator('input.pick-edit').press('Enter');
    await p.waitForTimeout(600);
    await pick().locator('.pick-row', { hasText: name }).dblclick();
    await p.waitForTimeout(600);
  }
  await pick().locator('button[aria-label="Back"]').click();
  await p.waitForTimeout(500);
  // Another tab puts Documents/Alpha/Beta in the Recycle Bin.
  const q = await context.newPage();
  await signIn(q);
  const ex = await openApp(q, 'File Explorer');
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await q.waitForTimeout(600);
  await ex.locator('.item', { hasText: 'Alpha' }).first().dblclick();
  await q.waitForTimeout(600);
  await ex.locator('.item', { hasText: 'Beta' }).first().click();
  await q.keyboard.press('Delete');
  await q.waitForTimeout(1200);
  await q.close();
  const forward = pick().locator('button[aria-label="Forward"]');
  await forward.click();
  await p.waitForTimeout(700);
  const said = ((await pick().locator('.dialog-problem').textContent()) ?? '').trim();
  ok(/not there/i.test(said) && (await crumbs()).endsWith('Alpha'), `Forward to a deleted folder says so in words and stays where it was ("${said}")`);
  info(await forward.isDisabled(), `FW-3 (P1): Forward stays on, pointing at the deleted folder for good (each press repeats the message, Back cannot pass it either)`);
  await closeAll();
} catch (e) {
  info(false, `FW-3: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- FW-6 (P1, L16): a folder selected in Save mode, then Save, saves beside it, not in it ------------------------------
try {
  await quickNotesSaveAs('where am I');
  await pick().locator('.pick-row', { hasText: 'Alpha' }).click();
  await pick().locator('.pick-name-box').fill('placed.txt');
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(1200);
  const ex = await openApp(p, 'File Explorer');
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await p.waitForTimeout(700);
  const inDocs = (await ex.locator('.item .item-name').allTextContents()).includes('placed.txt');
  info(!inDocs, `FW-6 (P1): with the folder Alpha selected, Save put placed.txt in ${inDocs ? 'Documents, beside Alpha' : 'Alpha'}`);
  await closeAll();
} catch (e) {
  info(false, `FW-6: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- FW-7 (P1): "Choose this folder" with a folder selected chooses the folder around it ---------------------------------
try {
  const win = await openApp(p, 'Notepad Pro');
  await p.keyboard.press('Control+Shift+F');
  await p.waitForTimeout(400);
  await win.locator('button', { hasText: 'Folder...' }).first().click();
  await pick().waitFor();
  await p.waitForTimeout(400);
  await pick().locator('.pick-row', { hasText: 'Alpha' }).click();
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(400);
  const chosen = await win.locator('.npp-folder').textContent();
  info(chosen === '/Documents/Alpha', `FW-7 (P1): Alpha selected, "Choose this folder" chose ${chosen}`);
  await closeAll();
} catch (e) {
  info(false, `FW-7: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- FW-8 (P2): a long name loses the ending the type should give it ------------------------------------------------------
try {
  await quickNotesSaveAs('long');
  const long = 'n'.repeat(252);
  await pick().locator('.pick-name-box').fill(long);
  await pick().locator('.btn.primary').click();
  await p.waitForTimeout(1200);
  const title = (await p.locator('.win.active .win-title-text').textContent()) ?? '';
  info(title.endsWith('.txt'), `FW-8 (P2): with "Text document (*.txt)" chosen, a 252-letter name was saved ${title.endsWith('.txt') ? 'with' : 'without'} .txt`);
  await closeAll();
} catch (e) {
  info(false, `FW-8: ${e.message.split('\n')[0]}`);
  await closeAll();
}

// ---- Explorer: rules it keeps ------------------------------------------------------------------------------------------
try {
  const ex = await openApp(p, 'File Explorer');
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await p.waitForTimeout(700);
  // A name that differs only by letter case.
  await ex.locator('.item', { hasText: 'kept.txt' }).first().click();
  await p.keyboard.press('F2');
  await p.waitForTimeout(200);
  await ex.locator('input.rename').fill('Kept.txt');
  await ex.locator('input.rename').press('Enter');
  await p.waitForTimeout(800);
  ok((await ex.locator('.item .item-name').allTextContents()).includes('Kept.txt'), 'Explorer renames kept.txt to Kept.txt (letter case only)');
  // Copy and paste in the same folder: a copy beside it, nothing replaced.
  await ex.locator('.item', { hasText: 'Kept.txt' }).first().click();
  await p.keyboard.press('Control+c');
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(1000);
  const names = await ex.locator('.item .item-name').allTextContents();
  ok(names.includes('Kept.txt') && names.includes('Kept (2).txt'), `copy and paste beside itself makes "Kept (2).txt" (${names.join(', ')})`);
  // A standard folder cannot be renamed from Explorer.
  await p.keyboard.press('Alt+ArrowUp');
  await p.waitForTimeout(700);
  await ex.locator('.item', { hasText: 'Music' }).first().click();
  await p.keyboard.press('F2');
  await p.waitForTimeout(200);
  await ex.locator('input.rename').fill('Tunes');
  await ex.locator('input.rename').press('Enter');
  await p.waitForTimeout(700);
  const refused = p.locator('.dialog', { hasText: 'Could not rename' });
  ok((await refused.count()) === 1, 'Explorer refuses to rename Music, in words');
  if (await refused.count()) await refused.getByRole('button', { name: 'OK' }).click();
  // The address box: the hidden System folder is not reachable.
  await ex.locator('.explorer-view').click({ position: { x: 300, y: 220 } });
  await p.keyboard.press('Control+l');
  await ex.locator('input.address').fill('/system');
  await ex.locator('input.address').press('Enter');
  await p.waitForTimeout(500);
  const sys = p.locator('.dialog', { hasText: 'not for files' });
  ok((await sys.count()) === 1, 'typing /system in the address box is refused');
  if (await sys.count()) await sys.getByRole('button', { name: 'OK' }).click();
  await p.waitForTimeout(200);
  await ex.locator('input.address').press('Escape').catch(() => {});
  // A folder renamed in another tab is followed to its new name (earlier E-P1-5).
  await ex.locator('.explorer-view').click({ position: { x: 300, y: 220 } });
  await p.keyboard.press('Control+l');
  await ex.locator('input.address').fill('/Documents/Letters');
  await ex.locator('input.address').press('Enter');
  await p.waitForTimeout(700);
  const q = await context.newPage();
  await signIn(q);
  const ex2 = await openApp(q, 'File Explorer');
  await ex2.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await q.waitForTimeout(600);
  await ex2.locator('.item', { hasText: 'Letters' }).first().click();
  await q.keyboard.press('F2');
  await ex2.locator('input.rename').fill('Post');
  await ex2.locator('input.rename').press('Enter');
  await q.waitForTimeout(1000);
  await q.close();
  await ex.locator('button[aria-label="Refresh"], .cbar-tool[aria-label="Refresh"]').first().click().catch(() => p.keyboard.press('F5'));
  await p.waitForTimeout(1200);
  const title = (await p.locator('.win.active .win-title-text').textContent()) ?? '';
  ok(title.includes('Post'), `Explorer showing Letters follows its rename in another tab to Post (title "${title}")`);
  // FW-10 (P2): a click on the status bar focuses the window frame, outside the part that hears Ctrl+L, Ctrl+F, Alt+arrows.
  await ex.locator('.statusbar').click();
  await p.keyboard.press('Control+l');
  await p.waitForTimeout(300);
  info(await ex.locator('input.address').isVisible(), 'FW-10 (P2): after a click on the status bar, Ctrl+L (type a path) does nothing');
  await p.keyboard.press('Escape');
  await closeAll();
} catch (e) {
  ok(false, `Explorer rules: ${e.message.split('\n')[0]} (dialogs open: ${(await p.locator('.dialog').allTextContents()).join(' | ')})`);
  await shot('explorer-rules');
  await closeAll();
}

// ---- Phone width (375 px) ----------------------------------------------------------------------------------------------
await p.setViewportSize({ width: 375, height: 740 });
await p.waitForTimeout(500);
try {
  await quickNotesSaveAs('narrow');
  const over = await pick().evaluate(d => {
    const box = d.getBoundingClientRect();
    return [...d.querySelectorAll('.pick-foot, .pick-files, .pick-bar, .pick-name-box')]
      .filter(e => e.getBoundingClientRect().right > box.right - 1)
      .map(e => `${e.className.split(' ').pop()} ends at ${Math.round(e.getBoundingClientRect().right)}`)
      .concat(`dialog ends at ${Math.round(box.right)}`);
  });
  info(over.length === 1, `FW-5 (P1): at 375 px the window's parts stick out past its right edge: ${over.join(', ')}`);
  await shot('fw5-375');
  // FW-4: use the tree, hide it, press New folder: the name box goes into the hidden tree and the window stops opening folders.
  await pick().locator('button[aria-label="Show folders"]').click();
  await p.waitForTimeout(300);
  await pick().locator('.pick-node', { hasText: 'Pictures' }).click();
  await p.waitForTimeout(500);
  await pick().locator('button[aria-label="Show folders"]').click();
  await p.waitForTimeout(300);
  await pick().locator('button[aria-label="New folder"]').click();
  await p.waitForTimeout(800);
  const boxShown = await pick().locator('input.pick-edit').isVisible().catch(() => false);
  await pick().locator('.pick-row', { hasText: 'New folder' }).dblclick();
  await p.waitForTimeout(600);
  const inIt = (await crumbs()).endsWith('New folder');
  info(boxShown || inIt, `FW-4 (P1): at phone width, New folder after using the tree puts its name box in the hidden tree (box shown: ${boxShown}); double-clicking the new folder then does nothing (${await crumbs()})`);
  await closeAll();
} catch (e) {
  info(false, `FW-4/5: ${e.message.split('\n')[0]}`);
  await closeAll();
}

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
