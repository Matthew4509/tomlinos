// Find AI models: search Hugging Face for more on-device models and add them to your own list, which Chat › Agents
// then offers beside the built-in ones. "Good places to start" lists a few well-known ones by the kind of computer
// (assistant/suggest.ts), each with the graphics memory it needs and an Add button. The person types words and narrows with
// drop-downs (size, kind of compression, order); results are the models the built-in engine can run (assistant/
// hfsearch.ts has the rule). An added model is fetched from Hugging Face by this browser when started; it is never
// saved on the server (the owner's Save is for the built-in models only).
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { pickBuild, SUGGESTED } from './assistant/suggest.ts';
import {
  describe, HF, isBuiltIn, KIND_FILTERS, passes, readMyModels, searchHF, SIZE_FILTERS, SORTS, toMyModel, writeMyModels,
  type Filters, type Found, type Listed, type MyModel,
} from './assistant/hfsearch.ts';

/** Results shown at a time; "Show more" reads the next ones. */
const PAGE = 12;
/** Repositories read at once (each is two small requests to Hugging Face). */
const AT_ONCE = 6;

export const aiModelsApp: AppDef = {
  ...APPS.aimodels,
  async launch(app) {
    const { shell, signal } = app;
    app.root.classList.add('aim');
    let mine: MyModel[] = await readMyModels(shell.fs);

    const query = h('input', { type: 'search', class: 'field aim-query', placeholder: 'Model name, e.g. gemma, qwen, llama, uncensored', 'aria-label': 'Search Hugging Face', spellcheck: false, autocomplete: 'off' });
    const select = <T extends { id: string; label: string }>(label: string, options: readonly T[]) =>
      h('select', { class: 'field aim-filter', 'aria-label': label }, ...options.map(o => h('option', { value: o.id }, o.label)));
    const size = select('Model size', SIZE_FILTERS);
    const kind = select('Kind of model', KIND_FILTERS);
    const sort = select('Order', SORTS);
    size.value = '2';
    const go = h('button', { type: 'submit', class: 'btn primary' }, 'Search');
    const form = h('form', { class: 'aim-bar' }, query, go, h('label', { class: 'aim-lab' }, 'Size ', size), h('label', { class: 'aim-lab' }, 'Kind ', kind), h('label', { class: 'aim-lab' }, 'Order ', sort));
    const mineBox = h('div', { class: 'aim-mine' });
    const startBox = h('div', { class: 'aim-start' });
    // Half precision (newer graphics chips) takes the smaller, quicker builds; older chips the ones that run everywhere.
    let halfPrecision = false;
    try {
      const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu?.requestAdapter();
      halfPrecision = !!adapter?.features.has('shader-f16');
    } catch {
      halfPrecision = false;
    }
    const results = h('div', { class: 'aim-results', role: 'list', 'aria-label': 'Models found' });
    const more = h('button', { type: 'button', class: 'btn', hidden: true }, 'Show more');
    const status = h('div', { class: 'statusbar', role: 'status' });
    app.root.append(
      form,
      h('div', { class: 'aim-body' },
        h('p', { class: 'hint aim-warn' }, 'These models are made and uploaded by other people. TOMLIN OS checks only that its engine can run one, not what it says or how good it is. Read a model\'s card (its licence, and whether it is made for chat) before you add it. An added model downloads from Hugging Face into this browser when you start it.'),
        h('h2', { class: 'aim-head' }, 'Good places to start'),
        h('p', { class: 'hint' }, 'A few well-known models for each kind of computer. A smaller model answers sooner; a larger one answers better but needs more graphics memory. You can search for anything above.'),
        startBox,
        h('h2', { class: 'aim-head' }, 'My models'), mineBox,
        h('h2', { class: 'aim-head' }, 'Found on Hugging Face'), results, more),
      status,
    );

    function paintMine(): void {
      mineBox.replaceChildren(...(mine.length ? mine.map(m => {
        const remove = h('button', { type: 'button', class: 'btn' }, 'Remove');
        on(remove, 'click', async () => {
          mine = mine.filter(x => x.id !== m.id);
          await save(`${m.name} was taken off your list.`);
        }, signal);
        return h('div', { class: 'aim-row', role: 'listitem' },
          h('div', { class: 'aim-main' }, h('strong', {}, m.name), h('span', { class: 'aim-meta' }, `uploaded by ${m.uploader} · ${formatSize(m.bytes)} · ${m.quant} · about ${(m.vram / 1024).toFixed(1)} GB of graphics memory`)),
          cardLink(m.repo), remove);
      }) : [h('p', { class: 'hint' }, 'None yet. Search below and press Add; the model then shows in Chat › Agents.')]));
    }

    async function save(done: string): Promise<void> {
      try {
        await writeMyModels(shell.fs, mine);
        status.textContent = done;
      } catch (error) {
        await shell.report('Could not save your list of models', error);
      }
      paintMine();
      paintStart();
      repaintResults();
    }

    function paintStart(): void {
      startBox.replaceChildren(...SUGGESTED.map(group => h('div', { class: 'aim-group' },
        h('h3', { class: 'aim-group-head' }, group.title, h('span', { class: 'aim-spec' }, ` (${group.spec})`)),
        ...group.models.map(m => pickBuild(m, halfPrecision)).filter(m => !!m).map(m => {
          const have = mine.some(x => x.repo === m.repo);
          const add = h('button', { type: 'button', class: 'btn primary', disabled: have || m.builtIn }, m.builtIn ? 'Built in' : have ? 'Added' : 'Add');
          on(add, 'click', async () => {
            add.disabled = true;
            status.textContent = `Reading ${m.name}'s details from Hugging Face...`;
            const found = await describe({ repo: m.repo, downloads: 0, likes: 0, updated: '' });
            const row = toMyModel(found);
            if (!row) {
              status.textContent = `${m.name} could not be read from Hugging Face just now, or TOMLIN OS's engine cannot run it. Try again in a minute.`;
              add.disabled = false;
              return;
            }
            if (mine.some(x => x.repo === row.repo)) return;
            mine = [...mine, row];
            await save(`${m.name} was added. Choose it in Chat › Agents.`);
          }, signal);
          return h('div', { class: 'aim-row', role: 'listitem' },
            h('div', { class: 'aim-main' },
              h('strong', {}, `${m.name} by ${m.maker}`),
              h('span', { class: 'aim-meta' }, `about ${(m.vram / 1024).toFixed(1)} GB of graphics memory · ${m.quant}${m.builtIn ? ' · already in TOMLIN OS' : ''}`)),
            cardLink(m.repo), add);
        }))));
    }

    const cardLink = (repo: string) => h('a', { class: 'btn', href: `${HF}/${repo}`, target: '_blank', rel: 'noopener noreferrer', title: 'Opens the model\'s page on Hugging Face in a new browser tab' }, 'Model card');

    // ---- The search ----
    let listed: Listed[] = [];
    let next = 0;
    let shown: Found[] = [];
    let run = 0;
    const filters = (): Filters => ({ size: size.value as Filters['size'], kind: kind.value as Filters['kind'], sort: sort.value as Filters['sort'] });

    function resultRow(m: Found): HTMLElement {
      const have = mine.some(x => x.repo === m.repo);
      const builtIn = isBuiltIn(m.repo);
      const add = h('button', { type: 'button', class: 'btn primary', disabled: have || builtIn || !m.lib }, have ? 'Added' : builtIn ? 'Built in' : 'Add');
      on(add, 'click', async () => {
        const row = toMyModel(m);
        if (!row || mine.some(x => x.repo === m.repo)) return;
        mine = [...mine, row];
        await save(`${m.name} was added. Choose it in Chat › Agents.`);
      }, signal);
      const why = !m.lib ? 'TOMLIN OS\'s engine has no program for this kind of model, so it cannot start here.' : builtIn ? 'This is one of the built-in models already.' : '';
      return h('div', { class: 'aim-row', role: 'listitem' },
        h('div', { class: 'aim-main' },
          h('strong', {}, m.name),
          h('span', { class: 'aim-meta' }, [
            `uploaded by ${m.uploader}`,
            m.bytes ? formatSize(m.bytes) : 'size not listed',
            m.quant || 'kind not listed',
            m.lib ? `about ${(m.lib.vram / 1024).toFixed(1)} GB of graphics memory` : '',
            `${m.downloads.toLocaleString()} downloads`,
          ].filter(Boolean).join(' · ')),
          why ? h('span', { class: 'aim-why' }, why) : null),
        cardLink(m.repo), add);
    }

    function repaintResults(): void {
      results.replaceChildren(...shown.map(resultRow));
    }

    /** Reads repositories until another page of results passes the filters, or the list runs out. */
    async function fill(mineRun: number): Promise<void> {
      more.hidden = true;
      const want = shown.length + PAGE;
      while (shown.length < want && next < listed.length) {
        const batch = listed.slice(next, next + AT_ONCE);
        next += batch.length;
        status.textContent = `Reading the models' details: ${next} of ${listed.length} found...`;
        const read = await Promise.all(batch.map(item => describe(item)));
        if (mineRun !== run || signal.aborted) return;
        const f = filters();
        // Those the engine cannot run are still listed, with the reason, so none silently vanish.
        shown.push(...read.filter(m => passes(m, f)));
        repaintResults();
      }
      const runnable = shown.filter(m => m.lib).length;
      status.textContent = listed.length
        ? `${shown.length} shown (${runnable} can start in TOMLIN OS), ${listed.length - next} more not read yet.`
        : 'Nothing found. Try other words, or "Any size".';
      if (!shown.length && next >= listed.length && listed.length) status.textContent = `None of the ${listed.length} found match the filters. Try a larger size or "Any kind".`;
      more.hidden = next >= listed.length;
    }

    async function search(): Promise<void> {
      const mineRun = ++run;
      shown = [];
      next = 0;
      results.replaceChildren();
      status.textContent = 'Searching Hugging Face...';
      try {
        listed = await searchHF(query.value, filters().sort);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'The search did not work.';
        return;
      }
      if (mineRun !== run) return;
      await fill(mineRun);
    }

    on(form, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      void search();
    }, signal);
    for (const s of [size, kind, sort]) on(s, 'change', () => void search(), signal);
    on(more, 'click', () => void fill(run), signal);

    paintMine();
    paintStart();
    status.textContent = 'Type a name (or nothing, for the most downloaded) and press Search.';
    query.focus();
  },
};
