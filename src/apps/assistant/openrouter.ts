// "Your own OpenRouter key" in Settings › AI (server/api/openrouter.php): one key for hundreds of models from many makers.
// As with Claude, the key goes to the server once and never comes back (only its last four characters), and the server
// keeps the monthly limit and the cost log. The chat itself uses the same streamed answers as Claude (askClaude).
import { infoTip } from '../../shell/infotip.ts';
import { h, on } from '../../core/dom.ts';
import type { ServiceApi } from '../../net/service.ts';
import type { DialogLayer } from '../../shell/dialogs.ts';
import { money } from './claude.ts';
import { keyTile, showCostLog } from './keytile.ts';

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

const price = (m: OpenRouterModel): string => (m.in === 0 && m.out === 0 ? 'free' : `$${m.in} in, $${m.out} out per million tokens`);

/** The models whose name or id has every word typed. */
export function filterModels(models: OpenRouterModel[], words: string): OpenRouterModel[] {
  const want = words.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(m => want.every(w => `${m.name} ${m.id}`.toLowerCase().includes(w)));
}

/**
 * The OpenRouter tile of Settings › AI: "Connect OpenRouter" and whether a key is set; it opens a pop-up with the key,
 * the model (found by typing), the monthly limit, Use OpenRouter and the cost log.
 */
export function openRouterSection(api: ServiceApi | null, dialogs: DialogLayer, signal: AbortSignal, onUse: (s: OpenRouterSettings) => void): { el: HTMLElement; refresh: () => Promise<void> } {
  let current: OpenRouterSettings | null = null;
  let models: OpenRouterModel[] = [];
  let open = false;
  const tile = keyTile('openrouter', 'Connect OpenRouter', !!api);
  tile.show(null, api ? 'Checking...' : 'OpenRouter needs the desktop\'s server, which this copy does not have.');

  const keyInput = h('input', { type: 'password', class: 'field', autocomplete: 'off', spellcheck: false, 'aria-label': 'OpenRouter key', placeholder: 'sk-or-...' });
  const find = h('input', { type: 'search', class: 'field', 'aria-label': 'Find a model', placeholder: 'Find a model: claude, gpt, gemini, llama, free...' });
  const modelSelect = h('select', { class: 'field', 'aria-label': 'OpenRouter model' });
  const modelNote = h('p', { class: 'ai-cloud-hint' });
  const capInput = h('input', { type: 'number', class: 'field ai-cap', min: '0', max: '1000', step: '0.5', 'aria-label': 'Monthly limit in US dollars' });
  const forgetBtn = h('button', { type: 'button', class: 'btn danger' }, 'Remove my key');
  const logBtn = h('button', { type: 'button', class: 'btn' }, 'Cost log...');
  const formMsg = h('p', { class: 'ai-cloud-msg', role: 'status' });
  const keyNote = h('span', { class: 'ai-cloud-hint' });
  const stateLine = h('p', { class: 'ai-key-state' });
  const body = h('div', { class: 'ai-key-dialog' },
    h('p', { class: 'ai-key-about' }, 'One key for hundreds of AI models, some of them free. Answers are paid from your OpenRouter credit, and what you send goes to OpenRouter and the model\'s maker. ', infoTip('OpenRouter', 'Models from many makers: Claude, GPT, Gemini, Llama, Mistral and more.')),
    stateLine,
    h('label', { class: 'ai-row' }, h('span', {}, 'Key'), keyInput),
    h('p', { class: 'ai-cloud-hint' }, keyNote),
    h('label', { class: 'ai-row' }, h('span', {}, 'Model'), find),
    h('div', { class: 'ai-row' }, modelSelect),
    modelNote,
    h('label', { class: 'ai-row' }, h('span', {}, 'Monthly limit, US$'), capInput),
    h('p', { class: 'ai-cloud-hint' }, 'OpenRouter is not asked once a question could take the month past this limit. $0 stops it. ', infoTip('the monthly limit', 'Before each question, the most it could cost is checked against this limit.')),
    h('p', { class: 'ai-cloud-hint' }, 'Whoever runs this server could use your key: save it only on a server you trust. ', infoTip('your key', 'It is kept encrypted on this server and never shown again, only its last four characters. Make a key at openrouter.ai > Keys; you can give it its own credit limit there too.')),
    h('div', { class: 'row-buttons' }, logBtn, forgetBtn),
    formMsg);

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

  const summary = (s: OpenRouterSettings): string => `${s.model ? s.modelName : 'no model chosen yet'} · ${money(s.spent)} of your ${money(s.cap)} limit used this month`;
  function paintTile(): void {
    const s = current;
    if (s) tile.show(s.hasKey, s.hasKey ? summary(s) : '');
  }

  function paint(): void {
    const s = current;
    if (!s) return;
    paintTile();
    stateLine.textContent = s.hasKey ? `Your key ending ${s.hint} · ${summary(s)}.` : 'No key saved yet.';
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
      tile.show(null, error instanceof Error ? error.message : 'The OpenRouter settings could not be read.');
    }
  }

  /** What is in the boxes differs from what is saved (a model left unchosen in the list changes nothing). */
  const changed = (): boolean => !!keyInput.value.trim() || (!!current && ((!!modelSelect.value && modelSelect.value !== current.model) || Number(capInput.value) !== current.cap));

  /** Saves what is in the boxes. A refusal leaves the server's words in the pop-up, and the boxes as they were. */
  async function save(): Promise<boolean> {
    if (!api) return false;
    tile.show(null, keyInput.value.trim() ? 'Checking the key with OpenRouter...' : 'Saving...');
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

  /** The models are read once, the first time the pop-up opens. */
  async function loadModels(): Promise<void> {
    if (!api || models.length) return;
    formMsg.textContent = 'Reading OpenRouter\'s list of models...';
    try {
      models = (await api.call<{ models: OpenRouterModel[] }>('models')).models;
      formMsg.textContent = '';
    } catch (error) {
      formMsg.textContent = error instanceof Error ? error.message : 'The list of models could not be read.';
    }
    fillSelect();
  }

  /** The pop-up; after a refused save it opens again with what was typed, and the reason. */
  async function openDialog(): Promise<void> {
    if (!api || open) return;
    open = true;
    paint();
    modelSelect.value = '';
    fillSelect();
    void loadModels();
    try {
      for (;;) {
        const answer = await dialogs.ask<'save' | 'use' | 'cancel'>({
          title: 'Connect OpenRouter',
          body,
          buttons: [
            { label: 'Save', value: 'save', primary: true },
            ...(current?.hasKey ? [{ label: 'Use OpenRouter', value: 'use' as const }] : []),
            { label: 'Cancel', value: 'cancel' },
          ],
          cancel: 'cancel',
          focus: () => keyInput,
        });
        if (answer === 'cancel') break;
        // Use OpenRouter keeps what was changed in the boxes first.
        if ((answer === 'save' || changed()) && !(await save())) continue;
        if (answer === 'use') {
          if (!current?.hasKey) break;
          if (!current.model) {
            formMsg.textContent = 'Choose a model first, then Use OpenRouter.';
            continue;
          }
          onUse(current);
        }
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
    on(find, 'input', fillSelect, signal);
    // Enter in the search box only finds; it does not press Save.
    on(find, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') event.stopPropagation();
    }, signal);
    on(modelSelect, 'change', paintModelNote, signal);
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
    on(logBtn, 'click', () => showCostLog(dialogs, api, 'OpenRouter cost log'), signal);
  }
  return { el: tile.el, refresh };
}
