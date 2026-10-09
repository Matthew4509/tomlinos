// Settings › AI: where the built-in AI and the keys for AI services are set up. Talking to an AI happens in Chat ›
// Agents (and the Panel's chat); this part only chooses and keeps things.
//   Built-in AI: which models there are and where each comes from; the owner can save a model's files on this TOMLIN OS
//   (so browsers fetch it from here, not Hugging Face) or remove them; Find AI models adds more.
//   Your model list: each person's favourites (listed first in Chat › Agents), models hidden from that list, and
//   "Disconnect when idle" (assistant/prefs.ts).
//   Claude: the person's own Anthropic key, model and monthly limit (claude.ts).
//   OpenRouter: the person's own OpenRouter key, for hundreds of models from many makers (openrouter.ts).
import { h, on } from '../../core/dom.ts';
import { formatSize } from '../../core/format.ts';
import { ServiceApi } from '../../net/service.ts';
import type { Shell } from '../../shell/types.ts';
import { BUILT_IN_MODELS, checkDevice, modelLabel } from './engine.ts';
import { claudeSection } from './claude.ts';
import { openRouterSection } from './openrouter.ts';
import { listModels, removeModel, saveModel, sourceWords, withMyModels, type ModelInfo } from './models.ts';
import { IDLE_MINUTES, readPrefs, withFavourite, withHidden, writePrefs, type AiPrefs } from './prefs.ts';
import { OnDevice } from './engine.ts';

export function aiSettings(shell: Shell, signal: AbortSignal): HTMLElement {
  const modelsApi = shell.account ? new ServiceApi(shell.account.api.base, 'models') : null;
  const service = shell.account ? new ServiceApi(shell.account.api.base, 'ai') : null;

  let models: ModelInfo[] = [];
  let owner = false;
  let savingId: string | null = null;
  const deviceLine = h('p', { class: 'hint' }, 'Checking this device...');
  const pick = h('select', { class: 'field', 'aria-label': 'Built-in model' });
  const modelNote = h('p', { class: 'hint' });
  const sourceLine = h('p', { class: 'hint' });
  const saveBtn = h('button', { type: 'button', class: 'btn' }, 'Save to this TOMLIN OS');
  const stopSaveBtn = h('button', { type: 'button', class: 'btn', hidden: true }, 'Stop saving');
  const removeBtn = h('button', { type: 'button', class: 'btn danger' }, 'Remove from this TOMLIN OS');
  const saveBar = h('progress', { class: 'ai-progress', max: 1, value: 0, hidden: true });
  const saveText = h('p', { class: 'hint', role: 'status' });
  const waitLine = h('p', { class: 'hint', hidden: true });
  const retiredBox = h('div', {});
  const ownerBox = h('div', { hidden: true },
    h('p', { class: 'hint' }, 'As the owner you can save a model\'s files on this TOMLIN OS, so browsers fetch it from here instead of Hugging Face.'),
    h('div', { class: 'row-buttons' }, saveBtn, stopSaveBtn, removeBtn), waitLine, saveBar, saveText);
  const findBtn = h('button', { type: 'button', class: 'btn' }, 'Find AI models...');
  const myList = h('div', { class: 'ai-mylist', role: 'list', 'aria-label': 'Your model list' });
  const idleBox = h('input', { type: 'checkbox' });
  const chatBtn = h('button', { type: 'button', class: 'btn primary' }, 'Open Chat › Agents');

  const chosen = () => models.find(m => m.id === pick.value) ?? null;
  function paint(): void {
    const m = chosen();
    const b = BUILT_IN_MODELS.find(x => x.id === pick.value);
    modelNote.textContent = b && m ? `${b.name}, made by ${b.maker} (${b.licence}): ${b.note} (about ${(m.vram / 1024).toFixed(1)} GB of graphics memory).`
      : m?.mine ? `${modelLabel(m.id)}: one you added from Hugging Face. Read its model card for its licence. About ${(m.vram / 1024).toFixed(1)} GB of graphics memory.` : '';
    sourceLine.textContent = m ? sourceWords(m, formatSize) : '';
    // Saving on the server is for the built-in models; one a person added always comes from Hugging Face.
    ownerBox.hidden = !owner || !m || !!m.mine;
    const saving = savingId !== null;
    // Removed less than a day ago: it can be saved again only then (a mirror's bandwidth is shared).
    const wait = !saving && m && !m.saved && !m.saving ? (m.resaveWait ?? 0) : 0;
    saveBtn.hidden = !m || m.saved || saving || wait > 0;
    saveBtn.textContent = m?.saving ? 'Carry on saving' : 'Save to this TOMLIN OS';
    waitLine.hidden = wait <= 0;
    if (wait > 0 && m) {
      const at = new Date(Date.now() + wait * 1000);
      waitLine.textContent = `${m.name} was removed from this TOMLIN OS less than a day ago. It can be saved again after ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. Until then, browsers fetch it from Hugging Face.`;
    }
    stopSaveBtn.hidden = !saving;
    removeBtn.hidden = !m || (!m.saved && !m.saving) || saving;
    pick.disabled = saving;
  }

  async function fill(): Promise<void> {
    const list = await listModels(modelsApi);
    models = await withMyModels(list.models, shell.fs);
    owner = list.owner;
    const was = pick.value;
    pick.replaceChildren(...models.map(m => h('option', { value: m.id }, `${modelLabel(m.id)} (${formatSize(m.bytes)}${m.mine ? ', you added it' : m.saved ? ', saved here' : ', from Hugging Face'})`)));
    // A model this TOMLIN OS no longer offers but still holds: the owner can free its space.
    retiredBox.replaceChildren(...(list.owner ? list.retired : []).map(r => {
      const b = h('button', { type: 'button', class: 'btn danger' }, `Remove ${r.name}`);
      on(b, 'click', async () => {
        const ok = await shell.dialogs.confirm({ title: `Remove ${r.name} from this TOMLIN OS?`, text: `It is no longer one of the built-in models. Its files (${formatSize(r.bytes)}) are deleted from the server.`, ok: 'Remove', danger: true });
        if (!ok || !modelsApi) return;
        try {
          await removeModel(modelsApi, r.id);
          saveText.textContent = `${r.name} was removed from this TOMLIN OS.`;
        } catch (error) {
          saveText.textContent = error instanceof Error ? error.message : 'It could not be removed.';
        }
        await fill();
      }, signal);
      return h('p', { class: 'hint' }, `${r.name} is still saved on this TOMLIN OS (${formatSize(r.bytes)}) but is no longer offered. `, b);
    }));
    pick.value = models.some(m => m.id === was) ? was : (models[0]?.id ?? '');
    paint();
    await paintMyList();
  }

  // ---- Your model list ----
  async function changePrefs(change: (p: AiPrefs) => AiPrefs): Promise<void> {
    try {
      await writePrefs(shell.fs, change(await readPrefs(shell.fs)));
    } catch (error) {
      await shell.report('Could not keep your AI choices', error);
    }
    await paintMyList();
  }
  async function paintMyList(): Promise<void> {
    const prefs = await readPrefs(shell.fs);
    idleBox.checked = prefs.idleDisconnect;
    // Favourites first, in the order starred; then the rest as listed above. Hidden ones stay here, so they can come back.
    const ordered = [...prefs.favourites.map(id => models.find(m => m.id === id)).filter((m): m is ModelInfo => !!m), ...models.filter(m => !prefs.favourites.includes(m.id))];
    myList.replaceChildren(...ordered.map(m => {
      const fav = prefs.favourites.includes(m.id);
      const hidden = prefs.hidden.includes(m.id);
      const star = h('button', { type: 'button', class: 'btn ai-star', 'aria-pressed': String(fav), 'aria-label': `Favourite: ${modelLabel(m.id)}`, title: fav ? 'A favourite: listed first in Chat › Agents. Press to take it off.' : 'Make it a favourite: listed first in Chat › Agents, and the first is chosen when Chat opens.' }, fav ? '★' : '☆');
      const show = h('input', { type: 'checkbox', checked: !hidden, 'aria-label': `Show ${modelLabel(m.id)} in Chat › Agents` });
      on(star, 'click', () => void changePrefs(p => withFavourite(p, m.id, !fav)), signal);
      on(show, 'change', () => void changePrefs(p => withHidden(p, m.id, !show.checked)), signal);
      return h('div', { class: 'ai-mylist-row' + (hidden ? ' off' : ''), role: 'listitem' }, star,
        h('span', { class: 'ai-mylist-name' }, modelLabel(m.id), h('span', { class: 'hint' }, ` ${formatSize(m.bytes)}${m.mine ? ', you added it' : ''}`)),
        h('label', { class: 'ai-mylist-show' }, show, ' Show in Chat'));
    }));
  }

  on(pick, 'change', paint, signal);
  on(saveBtn, 'click', async () => {
    const m = chosen();
    if (!m || !modelsApi || savingId) return;
    savingId = m.id;
    paint();
    saveBar.hidden = false;
    saveText.textContent = 'Starting the save...';
    try {
      const done = await saveModel(modelsApi, m.id, (have, total) => {
        saveBar.value = total ? have / total : 0;
        saveText.textContent = `Saving ${m.name} to this TOMLIN OS: ${formatSize(have)} of ${formatSize(total)}. You can keep using TOMLIN OS; closing Settings pauses it.`;
      }, () => savingId !== m.id || signal.aborted);
      saveText.textContent = done ? `${m.name} is saved on this TOMLIN OS. Browsers now get it from here.` : 'Saving paused. "Carry on saving" picks it up where it stopped.';
    } catch (error) {
      saveText.textContent = error instanceof Error ? error.message : 'The save stopped.';
    } finally {
      savingId = null;
      saveBar.hidden = true;
      await fill();
    }
  }, signal);
  on(stopSaveBtn, 'click', () => {
    savingId = null;
    saveText.textContent = 'Stopping after this piece...';
  }, signal);
  on(removeBtn, 'click', async () => {
    const m = chosen();
    if (!m || !modelsApi) return;
    const ok = await shell.dialogs.confirm({ title: `Remove ${m.name} from this TOMLIN OS?`, text: `Its files (${formatSize(m.bytes)}) are deleted from the server. Browsers then fetch it from Hugging Face when it starts. It can be saved here again after a day.`, ok: 'Remove', danger: true });
    if (!ok) return;
    try {
      await removeModel(modelsApi, m.id);
      saveText.textContent = `${m.name} was removed from this TOMLIN OS.`;
    } catch (error) {
      saveText.textContent = error instanceof Error ? error.message : 'It could not be removed.';
    }
    await fill();
  }, signal);
  on(findBtn, 'click', () => void shell.openApp('aimodels'), signal);
  on(idleBox, 'change', async () => {
    const want = idleBox.checked;
    await changePrefs(p => ({ ...p, idleDisconnect: want }));
    OnDevice.idleAfter(want ? IDLE_MINUTES : null);
  }, signal);
  on(chatBtn, 'click', () => void shell.openApp('chat', 'agents'), signal);

  // Claude: "Use Claude" goes to where the talking is, with that AI chosen there.
  const cloud = claudeSection(service, signal, () => void shell.openApp('chat', 'agents:claude'));
  const router = openRouterSection(shell.account ? new ServiceApi(shell.account.api.base, 'openrouter') : null, signal, () => void shell.openApp('chat', 'agents:openrouter'));

  const el = h('div', { class: 'set-ai' },
    h('h3', { class: 'set-sub' }, 'Built-in AI'),
    h('p', {}, 'An AI that downloads and runs on this device: free and private, as fast as your graphics chip allows. You talk to it in Chat › Agents and on the Panel.'),
    deviceLine,
    h('label', { class: 'bin-set' }, 'Model ', pick),
    modelNote, sourceLine, ownerBox, retiredBox,
    h('div', { class: 'row-buttons' }, chatBtn, findBtn),
    h('h4', { class: 'ai-mylist-head' }, 'Your model list'),
    h('p', { class: 'hint' }, 'Favourites (★) come first in Chat › Agents, and the first is chosen when Chat opens. Untick "Show in Chat" to leave a model out of the list; it stays here, so you can bring it back.'),
    myList,
    h('label', { class: 'check-row' }, idleBox, ` Disconnect when idle: after ${IDLE_MINUTES} minutes without a question, the built-in AI stops and frees its graphics memory. Your next message starts it again by itself.`),
    cloud.el,
    router.el);

  void (async () => {
    try {
      await fill();
      deviceLine.textContent = (await checkDevice()).advice;
    } catch (error) {
      deviceLine.textContent = `The models could not be listed: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
    void cloud.refresh();
    void router.refresh();
  })();
  return el;
}
