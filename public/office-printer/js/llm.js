// ============================================================================================================
// STUB: the optional "hybrid" mode. NOT BUILT. Nothing in the game calls this yet.
// ============================================================================================================
//
// The idea: the player types free text, and a small local model (Qwen family, about 2B, via llama.cpp on the VPS)
// answers as the current printer. The model is given the printer's persona and the game state, and must answer with
// JSON only:
//
//   { "reply": string, "mood": string, "action": "none" | "jam" | "out_of_ink" | "bounce" | "ending:<id>" }
//
// - Actions trigger the game's own scripted events (a jam, an ink bar draining, moving to the next printer).
// - The model never decides an ending freely: "ending:<id>" is only obeyed for ids on an allowed list the game passes
//   in for the current node.
// - A malformed answer (not JSON, a missing field, an action not on the list) falls back to a canned line.
//
// To build it: replace the body below with a POST to the model endpoint, validate the answer as described, and keep
// the canned line as the fallback.

/**
 * @param {{ printer: string, persona?: string, lines: string[], allowedEndings?: string[] }} state
 * @param {string} playerText
 * @returns {Promise<{ reply: string, mood: string, action: string }>}
 */
export async function askPrinter(state, playerText) {
  void playerText;
  const lines = state.lines?.length ? state.lines : ['PC LOAD LETTER.'];
  return { reply: lines[Math.floor(Math.random() * lines.length)], mood: 'neutral', action: 'none' };
}
