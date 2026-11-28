// CAD Draft's two toolbar picture sets: every picture the toolbars use has a Workshop drawing (no gaps), each drawing
// stays inside the 16 px square in the set's own colours and line weights, and the chosen set is read back as kept.
// Run: node --test test/cad-icons.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ICON_STYLES, WORKSHOP_FOR_DESKTOP, WORKSHOP_NAMES, readIconStyle, workshopParts } from '../src/apps/cad/workshop-icons.ts';

const cadSource = readFileSync(new URL('../src/apps/cad.ts', import.meta.url), 'utf8');
const standardSource = readFileSync(new URL('../src/apps/cad/icons.ts', import.meta.url), 'utf8');

/** The names CAD Draft's toolbars ask for: its own pictures (btn, toolBtn, picture, the snap table) and the desktop's (std). */
function namesUsed(): { own: Set<string>; desktop: Set<string> } {
  const own = new Set<string>();
  const desktop = new Set<string>();
  for (const m of cadSource.matchAll(/\b(?:btn|toolBtn|picture|cadIcon)\('([A-Za-z0-9]+)'/g)) own.add(m[1]);
  const snaps = /const SNAP_ICONS[^=]*=\s*\{([^}]*)\}/.exec(cadSource);
  assert.ok(snaps, 'the snap pictures table is in cad.ts');
  for (const m of snaps[1].matchAll(/:\s*'([A-Za-z0-9]+)'/g)) own.add(m[1]);
  for (const m of cadSource.matchAll(/\bstd\('([a-z-]+)'/g)) desktop.add(m[1]);
  return { own, desktop };
}

test('every picture on the toolbars has a Workshop drawing', () => {
  const { own, desktop } = namesUsed();
  assert.ok(own.size >= 70, `found the toolbars' own pictures (${own.size})`);
  assert.ok(desktop.size >= 8, `found the desktop pictures the toolbars use (${desktop.size})`);
  const gaps = [...own].filter(name => !workshopParts(name)?.length);
  assert.deepEqual(gaps, [], 'own pictures without a Workshop drawing');
  const map = WORKSHOP_FOR_DESKTOP as Record<string, string>;
  const desktopGaps = [...desktop].filter(id => !map[id] || !workshopParts(map[id])?.length);
  assert.deepEqual(desktopGaps, [], 'desktop pictures without a Workshop drawing');
});

test('the Workshop set has a drawing for every Standard picture, and nothing else', () => {
  const standard = [...standardSource.matchAll(/^ {2}([A-Za-z0-9]+): \(\) =>/gm)].map(m => m[1]);
  assert.ok(standard.length >= 80, `read the Standard names (${standard.length})`);
  assert.deepEqual([...WORKSHOP_NAMES].sort(), [...standard].sort());
});

test('each Workshop drawing is path data inside the 16 px square, in the set colours and line weights', () => {
  for (const name of WORKSHOP_NAMES) {
    const parts = workshopParts(name)!;
    assert.ok(parts.length >= 1 && parts.length <= 5, `${name}: one to five paths`);
    for (const [d, stroke, fill, width] of parts) {
      assert.match(d, /^[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/, `${name}: plain path data`);
      assert.match(stroke, /^#[0-9A-F]{6}$/, `${name}: stroke colour`);
      if (fill !== null) assert.match(fill, /^#[0-9A-F]{6}$/, `${name}: fill colour`);
      assert.ok(width >= 0.5 && width <= 2, `${name}: line width ${width}`);
      // Absolute move and line points stay on the square (relative arcs are checked by their start).
      for (const m of d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)) {
        const x = Number(m[1]);
        const y = Number(m[2]);
        assert.ok(x >= 0 && x <= 16 && y >= 0 && y <= 16, `${name}: point ${x},${y} inside the square`);
      }
    }
  }
  assert.equal(workshopParts('no-such-picture'), null);
  assert.equal(workshopParts('constructor'), null);
});

test('the chosen set is kept and read back; anything else is the Workshop set, the default', () => {
  for (const style of ICON_STYLES) assert.equal(readIconStyle(JSON.parse(JSON.stringify({ iconStyle: style })).iconStyle), style);
  for (const junk of [undefined, null, '', 'Workshop', 'classic', 3, true, {}, ['workshop']]) assert.equal(readIconStyle(junk), 'workshop');
  // cad.ts keeps it with the other settings and reads it with readIconStyle.
  assert.match(cadSource, /iconStyle: 'workshop'/);
  assert.match(cadSource, /settings\.iconStyle = readIconStyle\(saved\.iconStyle\)/);
});
