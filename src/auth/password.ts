// Helping people pick a good password instead of refusing them: a generator (the browser's own random numbers, with
// rejection sampling so no word is likelier than another) and a one-line verdict. The verdict never blocks anything;
// only the server refuses, and only for too short, a well-known password, or the user name itself.

const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'autumn', 'badger', 'bamboo', 'banjo', 'barley', 'basket', 'beacon', 'birch', 'biscuit', 'blossom', 'bramble', 'breeze',
  'bridge', 'bronze', 'bubble', 'butter', 'cabin', 'cactus', 'candle', 'canoe', 'canyon', 'carpet', 'castle', 'cedar', 'cherry', 'chimney', 'cinnamon', 'citrus',
  'clover', 'cobalt', 'coconut', 'comet', 'copper', 'coral', 'cotton', 'cricket', 'crystal', 'daisy', 'dolphin', 'dragon', 'drizzle', 'ember', 'falcon', 'feather',
  'fern', 'fiddle', 'firefly', 'flannel', 'forest', 'fossil', 'garden', 'garnet', 'ginger', 'glacier', 'granite', 'harbour', 'harvest', 'hazel', 'heron', 'hickory',
  'honey', 'island', 'ivory', 'jasmine', 'jigsaw', 'juniper', 'kettle', 'kite', 'ladder', 'lagoon', 'lantern', 'lavender', 'lemon', 'lighthouse', 'lilac', 'linen',
  'magnet', 'maple', 'marble', 'meadow', 'mercury', 'mint', 'mitten', 'monsoon', 'mosaic', 'muffin', 'nectar', 'nutmeg', 'oasis', 'olive', 'orbit', 'orchard',
  'otter', 'paddle', 'pebble', 'pepper', 'piano', 'pickle', 'pigeon', 'pillow', 'pine', 'planet', 'plum', 'pocket', 'pumpkin', 'quartz', 'quill', 'rabbit',
  'raven', 'ribbon', 'river', 'rocket', 'saffron', 'sailor', 'salmon', 'sapphire', 'satchel', 'scarlet', 'shadow', 'sparrow', 'spruce', 'squirrel', 'station', 'summit',
  'sunset', 'teapot', 'thistle', 'thunder', 'timber', 'toffee', 'tulip', 'tunnel', 'turtle', 'velvet', 'violet', 'walnut', 'willow', 'window', 'winter', 'zephyr',
];

/** A uniform random whole number below n, from the browser's crypto (no modulo bias). */
function randomBelow(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Four words and a two-digit number, like "harbour-kettle-maple-violet-47": easy to type, hard to guess. */
export function suggestPassword(): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomBelow(WORDS.length)]);
  return `${words.join('-')}-${10 + randomBelow(90)}`;
}

/** A plain-words opinion of a password. Advice only: nothing is refused because of it. */
export function passwordVerdict(password: string, name: string): { level: 0 | 1 | 2 | 3; text: string } {
  if (!password) return { level: 0, text: '' };
  const n = [...password].length;
  if (n < 8) return { level: 0, text: 'Too short: use at least 8 characters.' };
  if (name && password.toLowerCase().replace(/\d+$/, '') === name.toLowerCase()) return { level: 0, text: 'That is your user name. Choose something else.' };
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length;
  const words = password.split(/[\s\-_.]+/).filter(w => w.length >= 3).length;
  if (n >= 20 || (n >= 14 && (kinds >= 3 || words >= 3))) return { level: 3, text: 'Strong.' };
  if (n >= 12) return { level: 2, text: 'Good. A little longer would make it strong.' };
  return { level: 1, text: 'OK. Longer is stronger: a few words together work well.' };
}
