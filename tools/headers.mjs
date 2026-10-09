// Reads security-headers.json, the one list of the page's security headers, for the build (the meta tag in
// index.html) and the packager (the live .htaccess). server/dev-router.php reads the same file itself.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'security-headers.json'), 'utf8'));

/** The policy as one header value. `meta: true` leaves out frame-ancestors, which browsers ignore in a meta tag. */
export function cspValue({ meta = false } = {}) {
  return Object.entries(spec.csp)
    .filter(([name]) => !(meta && name === 'frame-ancestors'))
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** Every header, the policy first, as [name, value] pairs. */
export function headerList() {
  return [['Content-Security-Policy', cspValue()], ...Object.entries(spec.headers)];
}

/** Outside addresses in the policy, each of which must have a reason in "why". */
export function outsideSources() {
  return [...new Set(Object.values(spec.csp).flat().filter(s => /^https?:/.test(s)))];
}

export const why = spec.why;
