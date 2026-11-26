// The classic menu bar's model (access letters, items built from their getters, shortcuts, what fits) and the 16 px
// toolbar pictures (every one drawn on a 16 by 16 grid from the allowed parts and colours, and its markup well formed).
// Run: node --test test/menubar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ariaShortcut, BROWSER_KEYS, checkShortcuts, fitCount, nextUsable, pickAccessKeys, RESERVED_ALT_KEYS, shortcutMatches, splitLabel, toMenuItems, toolTip,
  type BarItem,
} from '../src/shell/menubar.ts';
import { isToolIconId, TOOL_ICON_IDS, toolIconMarkup, toolIconParts } from '../src/shell/toolicons.ts';

test('each menu gets its own Alt letter, never one the desktop keeps', () => {
  assert.deepEqual(pickAccessKeys([{ label: 'File' }, { label: 'Edit' }, { label: 'View' }, { label: 'Format' }, { label: 'Help' }]), ['f', 'e', 'v', 'o', 'h']);
  // Format would take F, which File has; Tools, Table: T then a.
  assert.deepEqual(pickAccessKeys([{ label: 'File' }, { label: 'Format' }, { label: 'Tools' }, { label: 'Table' }]), ['f', 'o', 't', 'a']);
  // L and Q are Alt+L (lock) and Alt+Q (close the window).
  const keys = pickAccessKeys([{ label: 'Layout' }, { label: 'Query' }]);
  assert.ok(keys.every(k => !RESERVED_ALT_KEYS.includes(k)), keys.join());
  assert.deepEqual(keys, ['a', 'u']);
  // A given key wins; a given key the desktop keeps is not used.
  assert.deepEqual(pickAccessKeys([{ label: 'Insert', key: 'n' }, { label: 'Lines', key: 'l' }]), ['n', 'i']);
  // Nothing left to pick: no key at all rather than a clash.
  assert.deepEqual(pickAccessKeys([{ label: 'A' }, { label: 'A' }]), ['a', '']);
});

test('the label is cut round its letter for underlining', () => {
  assert.deepEqual(splitLabel('Format', 'o'), ['F', 'o', 'rmat']);
  assert.deepEqual(splitLabel('File', 'f'), ['', 'F', 'ile']);
  assert.deepEqual(splitLabel('Help', 'x'), ['Help', '', '']);
  assert.deepEqual(splitLabel('Help', ''), ['Help', '', '']);
});

test('items are built from their getters each time, with tidy separators', () => {
  let dirty = false;
  let status = true;
  const ran: string[] = [];
  const items: BarItem[] = [
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl+S', enabled: () => dirty, action: () => ran.push('save') },
    { label: 'Secret', shown: () => false, action: () => ran.push('secret') },
    { separator: true },
    { separator: true },
    { label: 'Status bar', checked: () => status, action: () => (status = !status) },
    { label: 'Recent', submenu: () => [] },
    { label: 'Zoom', submenu: [{ label: 'In', shortcut: 'Ctrl+=', action: () => ran.push('in') }] },
    { separator: true },
  ];
  let menu = toMenuItems(items);
  assert.deepEqual(menu.map(m => (m.separator ? '-' : m.label)), ['Save', '-', 'Status bar', 'Recent', 'Zoom']);
  assert.equal(menu[0].disabled, true);
  assert.equal(menu[0].hint, 'Ctrl+S');
  assert.equal(menu[2].checked, true);
  assert.equal(menu[1].checked, undefined, 'a separator is not a checkbox');
  assert.equal(menu[3].disabled, true, 'an empty submenu is shown disabled');
  assert.equal(menu[3].submenu, undefined);
  assert.equal(menu[4].submenu?.[0].label, 'In');
  assert.equal(menu[4].action, undefined, 'an item with a submenu opens it rather than running');
  dirty = true;
  status = false;
  menu = toMenuItems(items);
  assert.equal(menu[0].disabled, false);
  assert.equal(menu[2].checked, false);
  // Unticked is still a checkbox (aria-checked="false"), not a plain item.
  assert.equal(typeof menu[2].checked, 'boolean');
  // The wrap is used for every action, submenus too.
  const wrapped: string[] = [];
  menu = toMenuItems(items, a => () => {
    wrapped.push('w');
    a();
  });
  menu[0].action!();
  menu[4].submenu![0].action!();
  assert.deepEqual(ran, ['save', 'in']);
  assert.deepEqual(wrapped, ['w', 'w']);
  // Pictures are gathered by label, submenus too.
  const icons = new Map();
  toMenuItems([{ label: 'Save', icon: 'save' }, { label: 'More', submenu: [{ label: 'Print', icon: 'print', action() {} }] }], undefined, icons);
  assert.deepEqual([...icons], [['Save', 'save'], ['Print', 'print']]);
});

test('shortcut text: tooltip, screen-reader form and matching a key press', () => {
  assert.equal(toolTip('Save', 'Ctrl+S'), 'Save (Ctrl+S)');
  assert.equal(toolTip('Bold'), 'Bold');
  assert.equal(ariaShortcut('Ctrl+Shift+S'), 'Control+Shift+S');
  assert.equal(ariaShortcut('Del'), 'Delete');
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.ok(shortcutMatches(key('s', { ctrlKey: true }), 'Ctrl+S'));
  assert.ok(shortcutMatches(key('S', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+S'));
  assert.ok(!shortcutMatches(key('S', { ctrlKey: true, shiftKey: true }), 'Ctrl+S'), 'Shift makes it another shortcut');
  assert.ok(shortcutMatches(key('s', { metaKey: true }), 'Ctrl+S'), 'Cmd on a Mac');
  assert.ok(!shortcutMatches(key('s'), 'Ctrl+S'));
  assert.ok(shortcutMatches(key('F5'), 'F5'));
  assert.ok(shortcutMatches(key('Delete'), 'Del'));
  assert.ok(shortcutMatches(key('Enter', { altKey: true }), 'Alt+Enter'));
  assert.ok(shortcutMatches(key('+', { ctrlKey: true, shiftKey: true }), 'Ctrl+Plus'));
  assert.ok(shortcutMatches(key('=', { ctrlKey: true }), 'Ctrl+='));
  assert.ok(!shortcutMatches(key('x', { ctrlKey: true, altKey: true }), 'Ctrl+X'), 'Ctrl+Alt is AltGr, not Ctrl');
});

test('a menu that uses a key the browser keeps is named', () => {
  assert.ok(BROWSER_KEYS.includes('Ctrl+N') && BROWSER_KEYS.includes('Ctrl+W') && BROWSER_KEYS.includes('Ctrl+T'));
  const bad = checkShortcuts([
    { label: 'File', items: [{ label: 'New', shortcut: 'Ctrl+N' }, { label: 'Open', shortcut: 'Ctrl+O' }, { label: 'More', submenu: [{ label: 'Close', shortcut: 'Ctrl + W' }] }] },
    { label: 'Edit', items: () => [{ label: 'Undo', shortcut: 'Ctrl+Z' }] },
  ]);
  assert.deepEqual(bad, ['File > New (Ctrl+N)', 'File > More > Close (Ctrl + W)']);
});

test('what fits in a narrow bar, keeping room for »', () => {
  assert.equal(fitCount([40, 40, 40], 120, 20), 3, 'all fit: no » needed');
  assert.equal(fitCount([40, 40, 40], 119, 20), 2);
  assert.equal(fitCount([40, 40, 40], 59, 20), 0);
  assert.equal(fitCount([], 10, 20), 0);
});

test('the arrows skip what cannot be used and wrap round', () => {
  assert.equal(nextUsable([true, false, true], 0, 1), 2);
  assert.equal(nextUsable([true, false, true], 2, 1), 0);
  assert.equal(nextUsable([true, false, true], 0, -1), 2);
  assert.equal(nextUsable([true, true], -1, 1), 0, 'from nothing to the first');
  assert.equal(nextUsable([true, true], 2, -1), 1, 'from past the end to the last');
  assert.equal(nextUsable([false, false], 0, 1), -1);
});

// ---- The pictures ----

const REQUIRED = [
  'new', 'open', 'save', 'save-as', 'print', 'print-preview', 'close', 'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'find', 'replace', 'select-all',
  'bold', 'italic', 'underline', 'strikethrough', 'font-colour', 'highlight', 'align-left', 'align-centre', 'align-right', 'justify', 'bullets', 'numbering',
  'indent', 'outdent', 'insert-picture', 'insert-table', 'insert-link', 'page-setup', 'zoom-in', 'zoom-out', 'zoom-fit', 'refresh', 'properties', 'help',
  'new-folder', 'up-folder', 'back', 'forward', 'recycle', 'restore', 'sort', 'filter', 'sum', 'chart', 'play', 'pause', 'stop', 'rename', 'settings',
];

test('every picture the bars need is there, once', () => {
  for (const id of REQUIRED) assert.ok(isToolIconId(id), id);
  assert.equal(new Set(TOOL_ICON_IDS).size, TOOL_ICON_IDS.length);
  assert.ok(!isToolIconId('toString') && !isToolIconId('constructor'));
});

/** Every number in a path, in pairs where they are points (good enough to keep a drawing on its grid). */
function pathNumbers(d: string): number[] {
  return (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
}

test('every picture is drawn on the 16 grid, in the house style', () => {
  for (const id of TOOL_ICON_IDS) {
    const parts = toolIconParts(id);
    assert.ok(parts.length > 0, `${id} draws something`);
    for (const part of parts) {
      assert.ok(['path', 'rect', 'circle'].includes(part.tag), `${id}: ${part.tag}`);
      const allowed = { path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx'], circle: ['cx', 'cy', 'r'] }[part.tag];
      for (const k of Object.keys(part.attrs)) assert.ok(allowed.includes(k), `${id}: ${part.tag} has ${k}`);
      if (part.w !== undefined) assert.ok([1, 1.5, 2].includes(part.w), `${id}: line width ${part.w}`);
      if (part.tag === 'rect') {
        const [x, y, w, hh] = ['x', 'y', 'width', 'height'].map(k => Number(part.attrs[k]));
        assert.ok(x >= 0 && y >= 0 && x + w <= 16 && y + hh <= 16 && w > 0 && hh > 0, `${id}: rect inside 16x16`);
      } else if (part.tag === 'circle') {
        const [cx, cy, r] = ['cx', 'cy', 'r'].map(k => Number(part.attrs[k]));
        assert.ok(cx - r >= 0 && cy - r >= 0 && cx + r <= 16 && cy + r <= 16, `${id}: circle inside 16x16`);
      } else {
        assert.match(part.attrs.d, /^M[-\d. MLHVCSQTAZmlhvcsqtaz,]+$/, `${id}: path data`);
        // Absolute moves stay on the page (relative steps are checked in the browser test by measuring the drawing).
        const moves = [...part.attrs.d.matchAll(/M(-?\d*\.?\d+)[ ,](-?\d*\.?\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
        for (const [x, y] of moves) assert.ok(x >= 0 && x <= 16 && y >= 0 && y <= 16, `${id}: starts inside (${x}, ${y})`);
        assert.ok(pathNumbers(part.attrs.d).every(n => Number.isFinite(n)), id);
      }
    }
  }
});

test('every picture is a well-formed 16x16 SVG in the text colour and at most the accent', () => {
  for (const id of TOOL_ICON_IDS) {
    const markup = toolIconMarkup(id);
    assert.match(markup, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" width="16" height="16" /, id);
    assert.ok(markup.endsWith('</svg>'), id);
    // Well formed: every element closes itself, and nothing but the three shapes is inside.
    const inner = markup.slice(markup.indexOf('>') + 1, -'</svg>'.length);
    assert.match(inner, /^(<(path|rect|circle)( [a-z-]+="[^"<>]*")+\/>)+$/, id);
    // Colours: only currentColor (the accent is a class the stylesheet colours), and no colour written in.
    const colours = [...markup.matchAll(/(fill|stroke)="([^"]+)"/g)].map(m => m[2]);
    assert.ok(colours.every(v => v === 'currentColor' || v === 'none'), `${id}: ${colours.join()}`);
    assert.ok(!/#[0-9a-f]{3,6}\b|rgb\(/i.test(markup), id);
    const classes = [...inner.matchAll(/class="([^"]+)"/g)].map(m => m[1]);
    assert.ok(classes.every(c => c === 'ti-acc' || c === 'ti-acc-line'), `${id}: ${classes.join()}`);
    assert.equal(toolIconMarkup(id, 32).includes('width="32" height="32"'), true);
  }
});
