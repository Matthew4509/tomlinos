// The "your own Claude key" side (server/api/ai.php). The key goes to the
// server once and never comes back: the page only ever learns its last four characters. The server keeps the monthly
// limit and the cost log; this file shows them, and sends a conversation and reads the answer as it arrives.
import { infoTip } from '../../shell/infotip.ts';
import { h, on } from '../../core/dom.ts';
import type { ServiceApi } from '../../net/service.ts';
import type { DialogLayer } from '../../shell/dialogs.ts';
import type { ChatTurn } from './engine.ts';
import { keyTile, showCostLog } from './keytile.ts';

export interface ClaudeModel {
  id: string;
  name: string;
  in: number;
  out: number;
  note: string;
}
export interface ClaudeSettings {
  hasKey: boolean;
  hint: string;
  model: string;
  models: ClaudeModel[];
  cap: number;
  spent: number;
  month: string;
  maxOutput: number;
}
export interface ClaudeDone {
  model: string;
  in: number;
  out: number;
  cost: number;
  stop: string;
  spent: number;
  cap: number;
}
/** How much text one question may carry to Claude (letters); the server allows a little more for the conversation. */
export const CLAUDE_MAX_INPUT = 300_000;

export const money = (d: number): string => (d > 0 && d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`);

/**
 * The turns in the order the server takes: empty ones left out, and two turns in a row from the same side made one (a
 * question left unanswered when the page was closed mid-answer goes with the next question, its words kept).
 */
export function alternating(turns: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const t of turns) {
    if (t.role === 'system' || !t.content.trim()) continue;
    const prev = out[out.length - 1];
    if (prev?.role === t.role) prev.content = `${prev.content}\n\n${t.content}`;
    else out.push({ role: t.role, content: t.content });
  }
  return out;
}

/**
 * The conversation to send: the newest turns that fit in `maxChars`, starting with the person's turn (the server
 * refuses any other order), and at most `maxTurns` of them.
 */
export function claudeTurns(turns: ChatTurn[], maxChars = CLAUDE_MAX_INPUT, maxTurns = 79): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const said = alternating(turns);
  let chars = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const t = said[i];
    if (out.length >= maxTurns || (out.length && chars + t.content.length > maxChars)) break;
    chars += t.content.length;
    out.unshift({ role: t.role, content: t.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** One question to Claude, the answer arriving in `onText` as it is written. Throws the server's words on refusal. */
export async function askClaude(api: ServiceApi, turns: ChatTurn[], onText: (all: string) => void, signal: AbortSignal): Promise<{ text: string; done: ClaudeDone | null; error: string | null }> {
  let text = '';
  let done: ClaudeDone | null = null;
  let error: string | null = null;
  await api.stream('chat', { messages: claudeTurns(turns) }, line => {
    if (typeof line.t === 'string') {
      text += line.t;
      onText(text);
    } else if (line.done) done = line as unknown as ClaudeDone;
    else if (typeof line.error === 'string') error = line.error;
  }, signal);
  return { text, done, error };
}

/**
 * The Claude tile of Settings › AI: "Connect Claude" and whether a key is set; it opens a pop-up with the key, the
 * model, the monthly limit, Use Claude and the cost log.
 */
export function claudeSection(api: ServiceApi | null, dialogs: DialogLayer, signal: AbortSignal, onUse: (settings: ClaudeSettings) => void): { el: HTMLElement; refresh: () => Promise<void>; settings: () => ClaudeSettings | null } {
  let current: ClaudeSettings | null = null;
  let open = false;
  const tile = keyTile('claude', 'Connect Claude', !!api);
  tile.show(null, api ? 'Checking...' : 'Claude needs the desktop\'s server, which this copy does not have.');

  const keyInput = h('input', { type: 'password', class: 'field', autocomplete: 'off', spellcheck: false, 'aria-label': 'Anthropic API key', placeholder: 'sk-ant-...' });
  const modelSelect = h('select', { class: 'field', 'aria-label': 'Claude model' });
  const capInput = h('input', { type: 'number', class: 'field ai-cap', min: '0', max: '1000', step: '0.5', 'aria-label': 'Monthly limit in US dollars' });
  const forgetBtn = h('button', { type: 'button', class: 'btn danger' }, 'Remove my key');
  const logBtn = h('button', { type: 'button', class: 'btn' }, 'Cost log...');
  const formMsg = h('p', { class: 'ai-cloud-msg', role: 'status' });
  const keyNote = h('span', { class: 'ai-cloud-hint' });
  const stateLine = h('p', { class: 'ai-key-state' });
  const body = h('div', { class: 'ai-key-dialog' },
    h('p', { class: 'ai-key-about' }, 'More capable than the built-in AI, and it takes long text. Not free: each answer is paid for by your Anthropic account, and what you send goes to Anthropic.'),
    stateLine,
    h('label', { class: 'ai-row' }, h('span', {}, 'API key'), keyInput),
    h('p', { class: 'ai-cloud-hint' }, keyNote),
    h('label', { class: 'ai-row' }, h('span', {}, 'Model'), modelSelect),
    h('label', { class: 'ai-row' }, h('span', {}, 'Monthly limit, US$'), capInput),
    h('p', { class: 'ai-cloud-hint' }, 'Claude is not asked once a question could take the month past this limit. $0 stops it. ', infoTip('the monthly limit', 'Before each question, the most it could cost is checked against this limit.')),
    h('p', { class: 'ai-cloud-hint' }, 'Whoever runs this server could use your key: save it only on a server you trust. ', infoTip('your key', 'It is kept encrypted on this server and never shown again, only its last four characters. Make a key at console.anthropic.com > API keys; one just for TOMLIN OS can be deleted on its own.')),
    h('div', { class: 'row-buttons' }, logBtn, forgetBtn),
    formMsg);

  const used = (s: ClaudeSettings): string => `${money(s.spent)} of your ${money(s.cap)} limit used this month`;
  const modelName = (s: ClaudeSettings): string => s.models.find(m => m.id === s.model)?.name ?? s.model;
  function paintTile(): void {
    const s = current;
    if (s) tile.show(s.hasKey, s.hasKey ? `${modelName(s)} · ${used(s)}` : '');
  }

  function paint() {
    const s = current;
    if (!s) return;
    paintTile();
    stateLine.textContent = s.hasKey ? `Your key ending ${s.hint} · ${modelName(s)} · ${used(s)}.` : 'No key saved yet.';
    modelSelect.replaceChildren(...s.models.map(m => h('option', { value: m.id, selected: m.id === s.model }, `${m.name}: ${m.note} ($${m.in} in, $${m.out} out per million tokens)`)));
    capInput.value = String(s.cap);
    keyNote.textContent = s.hasKey ? `A key ending ${s.hint} is saved. Leave the box empty to keep it; paste a new one to replace it.` : 'Paste your key; it starts with sk-ant-.';
    forgetBtn.hidden = !s.hasKey;
  }

  async function refresh() {
    if (!api) return;
    try {
      current = await api.call<ClaudeSettings>('settings');
      paint();
    } catch (error) {
      tile.show(null, error instanceof Error ? error.message : 'The Claude settings could not be read.');
    }
  }

  /** What is in the boxes differs from what is saved. */
  const changed = (): boolean => !!keyInput.value.trim() || (!!current && (modelSelect.value !== current.model || Number(capInput.value) !== current.cap));

  /** Saves what is in the boxes. A refusal leaves the server's words in the pop-up, and the boxes as they were. */
  async function save(): Promise<boolean> {
    if (!api) return false;
    tile.show(null, keyInput.value.trim() ? 'Trying the key with Anthropic...' : 'Saving...');
    try {
      await api.call('save', { body: { key: keyInput.value.trim(), model: modelSelect.value, cap: capInput.value } });
      keyInput.value = '';
      formMsg.textContent = '';
      await refresh();
      return true;
    } catch (error) {
      formMsg.textContent = error instanceof Error ? error.message : 'It could not be saved.';
      paintTile();
      return false;
    }
  }

  /** The pop-up; after a refused save it opens again with what was typed, and the reason. */
  async function openDialog(): Promise<void> {
    if (!api || open) return;
    open = true;
    paint();
    try {
      for (;;) {
        const answer = await dialogs.ask<'save' | 'use' | 'cancel'>({
          title: 'Connect Claude',
          body,
          buttons: [
            { label: 'Save', value: 'save', primary: true },
            ...(current?.hasKey ? [{ label: 'Use Claude', value: 'use' as const }] : []),
            { label: 'Cancel', value: 'cancel' },
          ],
          cancel: 'cancel',
          focus: () => keyInput,
        });
        if (answer === 'cancel') break;
        // Use Claude keeps what was changed in the boxes first.
        if ((answer === 'save' || changed()) && !(await save())) continue;
        if (answer === 'use' && current?.hasKey) onUse(current);
        break;
      }
    } finally {
      keyInput.value = '';
      formMsg.textContent = '';
      open = false;
    }
  }

  if (api) {
    on(tile.el, 'click', () => void openDialog(), signal);
    on(forgetBtn, 'click', async () => {
      formMsg.textContent = 'Removing...';
      try {
        await api.call('forget', { body: {} });
        keyInput.value = '';
        await refresh();
        formMsg.textContent = 'Your key was removed from this TOMLIN OS.';
      } catch (error) {
        formMsg.textContent = error instanceof Error ? error.message : 'It could not be removed.';
      }
    }, signal);
    on(logBtn, 'click', () => showCostLog(dialogs, api, 'Claude cost log'), signal);
  }
  return { el: tile.el, refresh, settings: () => current };
}
