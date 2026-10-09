// "Your own OpenRouter key" in Settings › AI (server/api/openrouter.php): one key for hundreds of models from many makers.
// As with Claude, the key goes to the server once and never comes back (only its last four characters), and the server
// keeps the monthly limit and the cost log. The chat itself uses the same streamed answers as Claude (askClaude).
import { h, on } from '../../core/dom.ts';
import type { ServiceApi } from '../../net/service.ts';
import { money } from './claude.ts';

export interface OpenRouterSettings {
  hasKey: boolean;
  hint: string;
  model: string;
  modelName: string;
  cap: number;
  spent: number;
  month: string;
  maxOutput: number;
}
export interface OpenRouterModel {
  id: string;
  name: string;
  /** US dollars per million tokens. */
  in: number;
  out: number;
  context: number;
}
interface LogRow {
  at: number;
  model: string;
  in: number;
  out: number;
  cost: number;
  note: string;
}

const price = (m: OpenRouterModel): string => (m.in === 0 && m.out === 0 ? 'free' : `$${m.in} in, $${m.out} out per million tokens`);

/** The models whose name or id has every word typed. */
export function filterModels(models: OpenRouterModel[], words: string): OpenRouterModel[] {
  const want = words.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(m => want.every(w => `${m.name} ${m.id}`.toLowerCase().includes(w)));
}

export function openRouterSection(api: ServiceApi | null, signal: AbortSignal, onUse: (s: OpenRouterSettings) => void): { el: HTMLElement; refresh: () => Promise<void> } {
  let current: OpenRouterSettings | null = null;
  let models: OpenRouterModel[] = [];
  const state = h('p', { class: 'ai-device' }, api ? 'Checking...' : 'OpenRouter needs the desktop\'s server, which this copy does not have.');
  const useBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Use OpenRouter');
  const setBtn = h('button', { type: 'button', class: 'btn', disabled: !api }, 'OpenRouter settings...');
  const logBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Cost log...');

  const keyInput = h('input', { type: 'password', class: 'field', autocomplete: 'off', spellcheck: false, 'aria-label': 'OpenRouter key', placeholder: 'sk-or-...' });
  const find = h('input', { type: 'search', class: 'field', 'aria-label': 'Find a model', placeholder: 'Find a model: claude, gpt, gemini, llama, free...' });
  const modelSelect = h('select', { class: 'field', 'aria-label': 'OpenRouter model' });
  const modelNote = h('p', { class: 'ai-cloud-hint' });
  const capInput = h('input', { type: 'number', class: 'field ai-cap', min: '0', max: '1000', step: '0.5', 'aria-label': 'Monthly limit in US dollars' });
  const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Save');
  const forgetBtn = h('button', { type: 'button', class: 'btn danger' }, 'Remove my key');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Close settings');
  const formMsg = h('p', { class: 'ai-cloud-msg', role: 'status' });
  const keyNote = h('span', { class: 'ai-cloud-hint' });
  const form = h('div', { class: 'ai-cloud-form', hidden: true },
    h('label', { class: 'ai-row' }, h('span', {}, 'Key'), keyInput),
    h('p', { class: 'ai-cloud-hint' }, keyNote),
    h('label', { class: 'ai-row' }, h('span', {}, 'Model'), find),
    h('div', { class: 'ai-row' }, modelSelect),
    modelNote,
    h('label', { class: 'ai-row' }, h('span', {}, 'Monthly limit, US$'), capInput),
    h('p', { class: 'ai-cloud-hint' }, 'Before each question the most it could cost is checked against this limit; when the month\'s spending would pass it, OpenRouter is not asked. $0 stops it altogether.'),
    h('p', { class: 'ai-cloud-hint' }, 'Your key is kept encrypted on this TOMLIN OS server and is never shown again, only its last four characters. Whoever runs this server could use it, so save it only on a server you trust. Make a key at openrouter.ai > Keys (you can give it its own credit limit there too).'),
    h('div', { class: 'row-buttons' }, saveBtn, forgetBtn, cancelBtn),
    formMsg);
  const logBody = h('tbody');
  const logHead = h('p', { class: 'ai-cloud-hint' });
  const logBox = h('div', { class: 'ai-cloud-log', hidden: true }, logHead,
    h('table', { class: 'ai-log-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Model'), h('th', {}, 'Tokens in'), h('th', {}, 'Tokens out'), h('th', {}, 'Cost'), h('th', {}, 'Note'))), logBody));

  const el = h('section', { class: 'ai-cloud' },
    h('h2', {}, 'OpenRouter, with your own key'),
    h('p', {}, 'One key for hundreds of AI models from many makers (Claude, GPT, Gemini, Llama, Mistral and more), some of them free. Answers are paid from your OpenRouter credit, and what you send goes to OpenRouter and the model\'s maker.'),
    state,
    h('div', { class: 'row-buttons' }, useBtn, setBtn, logBtn),
    form, logBox);

  /** The list under the search box, keeping the chosen model even when the words hide it. */
  function fillSelect(): void {
    const chosen = modelSelect.value || current?.model || '';
    const shown = filterModels(models, find.value).slice(0, 300);
    const keep = models.find(m => m.id === chosen);
    if (keep && !shown.includes(keep)) shown.unshift(keep);
    modelSelect.replaceChildren(
      h('option', { value: '' }, shown.length ? `Choose a model (${filterModels(models, find.value).length} match)` : 'No model matches those words'),
      ...shown.map(m => h('option', { value: m.id, selected: m.id === chosen }, /\(free\)/i.test(m.name) ? m.name : `${m.name} (${price(m)})`)));
    paintModelNote();
  }
  function paintModelNote(): void {
    const m = models.find(x => x.id === modelSelect.value);
    modelNote.textContent = m ? `${m.id} · ${price(m)}${m.context ? ` · reads up to ${m.context.toLocaleString()} tokens` : ''}` : '';
  }

  function paint(): void {
    const s = current;
    if (!s) return;
    state.textContent = s.hasKey
      ? `Your key ending ${s.hint} · ${s.model ? s.modelName : 'no model chosen yet'} · ${money(s.spent)} of your ${money(s.cap)} limit used this month.`
      : 'No key saved yet. Add yours in OpenRouter settings.';
    useBtn.disabled = !s.hasKey || !s.model;
    logBtn.disabled = false;
    capInput.value = String(s.cap);
    keyNote.textContent = s.hasKey ? `A key ending ${s.hint} is saved. Leave the box empty to keep it; paste a new one to replace it.` : 'Paste your key; it starts with sk-or-.';
    forgetBtn.hidden = !s.hasKey;
  }

  async function refresh(): Promise<void> {
    if (!api) return;
    try {
      current = await api.call<OpenRouterSettings>('settings');
      paint();
    } catch (error) {
      state.textContent = error instanceof Error ? error.message : 'The OpenRouter settings could not be read.';
    }
  }

  if (api) {
    on(setBtn, 'click', async () => {
      form.hidden = !form.hidden;
      logBox.hidden = true;
      formMsg.textContent = '';
      if (form.hidden) return;
      keyInput.focus();
      if (!models.length) {
        formMsg.textContent = 'Reading OpenRouter\'s list of models...';
        try {
          models = (await api.call<{ models: OpenRouterModel[] }>('models')).models;
          formMsg.textContent = '';
        } catch (error) {
          formMsg.textContent = error instanceof Error ? error.message : 'The list of models could not be read.';
        }
      }
      fillSelect();
    }, signal);
    on(find, 'input', fillSelect, signal);
    on(modelSelect, 'change', paintModelNote, signal);
    on(cancelBtn, 'click', () => {
      form.hidden = true;
      keyInput.value = '';
    }, signal);
    on(saveBtn, 'click', async () => {
      saveBtn.disabled = true;
      formMsg.textContent = keyInput.value.trim() ? 'Checking the key with OpenRouter...' : 'Saving...';
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
  return { el, refresh };
}
