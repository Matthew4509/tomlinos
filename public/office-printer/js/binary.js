// Text to ones and zeros and back. The Dot Matrix prints its messages this way, and they really do decode.

/** Each byte of the text (UTF-8) as eight 0s and 1s. */
export function toBinary(text) {
  return [...new TextEncoder().encode(text)].map(byte => byte.toString(2).padStart(8, '0'));
}

/** Groups of eight 0s and 1s, separated by any spacing, back to text. Anything else is refused. */
export function fromBinary(bits) {
  const groups = String(bits).trim().split(/\s+/).filter(Boolean);
  if (!groups.every(g => /^[01]{8}$/.test(g))) throw new Error('Not groups of eight 0s and 1s');
  return new TextDecoder().decode(Uint8Array.from(groups.map(g => parseInt(g, 2))));
}

/** The binary of a text laid out a few bytes to a line, as the Dot Matrix prints it. */
export function binaryLines(text, perLine = 4) {
  const groups = toBinary(text);
  const lines = [];
  for (let i = 0; i < groups.length; i += perLine) lines.push(groups.slice(i, i + perLine).join(' '));
  return lines;
}
