// The "your own Claude key" side (server/api/ai.php). The key goes to the
// server once and never comes back: the page only ever learns its last four characters. The server keeps the monthly
// limit and the cost log; this file shows them, and sends a conversation and reads the answer as it arrives.
import { h, on } from '../../core/dom.ts';
import type { ServiceApi } from '../../net/service.ts';
import type { ChatTurn } from './engine.ts';

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
interface LogRow {
  at: number;
  model: string;
  in: number;
  out: number;
  cost: number;
  note: string;
}

/** How much text one question may carry to Claude (letters); the server allows a little more for the conversation. */
export const CLAUDE_MAX_INPUT = 300_000;

export const money = (d: number): string => (d > 0 && d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`);

/**
 * The conversation to send: the newest turns that fit in `maxChars`, starting with the person's turn (the server
 * refuses any other order), and at most `maxTurns` of them.
 */
export function claudeTurns(turns: ChatTurn[], maxChars = CLAUDE_MAX_INPUT, maxTurns = 79): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'system') continue;
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

/** The "Claude, with your own API key" section of Settings › AI: state, settings and cost log. */
export function claudeSection(api: ServiceApi | null, signal: AbortSignal, onUse: (settings: ClaudeSettings) => void): { el: HTMLElement; refresh: () => Promise<void>; settings: () => ClaudeSettings | null } {
  let current: ClaudeSettings | null = null;
  const state = h('p', { class: 'ai-device' }, api ? 'Checking...' : 'Claude needs the desktop\'s server, which this copy does not have.');
  const useBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Use Claude');
  const setBtn = h('button', { type: 'button', class: 'btn', disabled: !api }, 'Claude settings...');
  const logBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Cost log...');

  const keyInput = h('input', { type: 'password', class: 'field', autocomplete: 'off', spellcheck: false, 'aria-label': 'Anthropic API key', placeholder: 'sk-ant-...' });
  const modelSelect = h('select', { class: 'field', 'aria-label': 'Claude model' });
  const capInput = h('input', { type: 'number', class: 'field ai-cap', min: '0', max: '1000', step: '0.5', 'aria-label': 'Monthly limit in US dollars' });
  const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Save');
  const forgetBtn = h('button', { type: 'button', class: 'btn danger' }, 'Remove my key');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Close settings');
  const formMsg = h('p', { class: 'ai-cloud-msg', role: 'status' });
  const keyNote = h('span', { class: 'ai-cloud-hint' });
  const form = h('div', { class: 'ai-cloud-form', hidden: true },
    h('label', { class: 'ai-row' }, h('span', {}, 'API key'), keyInput),
    h('p', { class: 'ai-cloud-hint' }, keyNote),
    h('label', { class: 'ai-row' }, h('span', {}, 'Model'), modelSelect),
    h('label', { class: 'ai-row' }, h('span', {}, 'Monthly limit, US$'), capInput),
    h('p', { class: 'ai-cloud-hint' }, 'Before each question the most it could cost is checked against this limit; when the month\'s spending would pass it, Claude is not asked. $0 stops it altogether.'),
    h('p', { class: 'ai-cloud-hint' }, 'Your key is kept encrypted on this TOMLIN OS server and is never shown again, only its last four characters. Whoever runs this server could use it, so save it only on a server you trust. Make a key at console.anthropic.com > API keys; a key just for TOMLIN OS is best, so you can delete it on its own.'),
    h('div', { class: 'row-buttons' }, saveBtn, forgetBtn, cancelBtn),
    formMsg);
  const logBody = h('tbody');
  const logHead = h('p', { class: 'ai-cloud-hint' });
  const logBox = h('div', { class: 'ai-cloud-log', hidden: true }, logHead,
    h('table', { class: 'ai-log-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Model'), h('th', {}, 'Tokens in'), h('th', {}, 'Tokens out'), h('th', {}, 'Cost'), h('th', {}, 'Note'))), logBody));

  const el = h('section', { class: 'ai-cloud' },
    h('h2', {}, 'Claude, with your own API key'),
    h('p', {}, 'Much more capable than the built-in AI, and it can take long text. It is not free: each answer is paid for by your own Anthropic account, and what you send goes to Anthropic.'),
    state,
    h('div', { class: 'row-buttons' }, useBtn, setBtn, logBtn),
    form, logBox);

  function paint() {
    const s = current;
    if (!s) return;
    const model = s.models.find(m => m.id === s.model);
    state.textContent = s.hasKey
      ? `Your key ending ${s.hint} · ${model?.name ?? s.model} · ${money(s.spent)} of your ${money(s.cap)} limit used this month.`
      : 'No key saved yet. Add yours in Claude settings.';
    useBtn.disabled = !s.hasKey;
    logBtn.disabled = false;
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
      state.textContent = error instanceof Error ? error.message : 'The Claude settings could not be read.';
    }
  }

  if (api) {
    on(setBtn, 'click', () => {
      form.hidden = !form.hidden;
      logBox.hidden = true;
      formMsg.textContent = '';
      if (!form.hidden) keyInput.focus();
    }, signal);
    on(cancelBtn, 'click', () => {
      form.hidden = true;
      keyInput.value = '';
    }, signal);
    on(saveBtn, 'click', async () => {
      saveBtn.disabled = true;
      formMsg.textContent = keyInput.value.trim() ? 'Trying the key with Anthropic...' : 'Saving...';
      try {
        await api.call('save', { body: { key: keyInput.value.trim(), model: modelSelect.value, cap: capInput.value } });
        keyInput.value = '';
        form.hidden = true;
        await refresh();
      } catch (error) {
        formMsg.textContent = error instanceof Error ? error.message : 'It could not be saved.';
      } finally {
        saveBtn.disabled = false;
      }
    }, signal);
    on(forgetBtn, 'click', async () => {
      try {
        await api.call('forget', { body: {} });
        keyInput.value = '';
        form.hidden = true;
        await refresh();
      } catch (error) {
        formMsg.textContent = error instanceof Error ? error.message : 'It could not be removed.';
      }
    }, signal);
    on(logBtn, 'click', async () => {
      logBox.hidden = !logBox.hidden;
      form.hidden = true;
      if (logBox.hidden) return;
      try {
        const r = await api.call<{ month: string; spent: number; cap: number; rows: LogRow[] }>('log');
        logHead.textContent = `${r.month}: ${money(r.spent)} of your ${money(r.cap)} limit. The log keeps numbers only, never what was asked or answered.`;
        logBody.replaceChildren(...r.rows.map(row => h('tr', {},
          h('td', {}, new Date(row.at * 1000).toLocaleString()), h('td', {}, row.model), h('td', {}, row.in.toLocaleString()),
          h('td', {}, row.out.toLocaleString()), h('td', {}, money(row.cost)), h('td', {}, row.note))));
        if (!r.rows.length) logBody.append(h('tr', {}, h('td', { colspan: '6' }, 'Nothing yet this month.')));
      } catch (error) {
        logHead.textContent = error instanceof Error ? error.message : 'The cost log could not be read.';
      }
    }, signal);
    on(useBtn, 'click', () => current && onUse(current), signal);
  }
  return { el, refresh, settings: () => current };
}
