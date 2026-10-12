// Chat's Agents tab: pick an AI, connect it, and talk; every thread is kept in Documents/AI chats (chat/agents.ts).
// The built-in models run on this device (assistant/engine.ts; connecting loads the model, the first time a download
// from this TOMLIN OS). Claude answers with the person's own key (assistant/claude.ts; the key is added in the
// Claude settings in Settings › AI). The AI can be swapped in the middle of a thread; each answer is labelled with the AI
// that wrote it.
//
// The built-in AI and the open thread belong to the whole desktop, not to this tab: moving from the Overview's chat to
// another view shows "Already connected" and the chat so far. A model already running (started here or in another view) is joined without starting it again, and the thread
// (chat/live.ts) is the same one every view shows.
//
// The person's own choices (assistant/prefs.ts): favourite models come first and the first is chosen when nothing else
// is; hidden ones stay out of the list; "Disconnect when idle" frees the graphics memory after a while without a
// question, and the next message starts the same model again by itself. While an answer is written, the line under it
// says how it is going; Copy, Regenerate and Edit sit under the messages. When the built-in AI stops part-way or cannot
// start, a short line says so, and "What happened?" opens a small box with the likely reason and the ways out.
import { h, on } from '../../core/dom.ts';
import { formatSize } from '../../core/format.ts';
import { ServiceApi } from '../../net/service.ts';
import { joinPath } from '../../fs/names.ts';
import { pickSave } from '../../shell/filepicker.ts';
import type { DialogButton } from '../../shell/dialogs.ts';
import type { AppHandle } from '../../shell/types.ts';
import { checkDevice, fitText, isDownloadProblem, jobPrompt, modelLabel, modelName, probeSavedModel, startProblem, OnDevice, rememberModel, type ChatTurn, type StopReason } from '../assistant/engine.ts';
import { inHerOwnWords, personaTurns } from '../assistant/persona.ts';
import { listModels, withMyModels, type ModelInfo } from '../assistant/models.ts';
import { IDLE_MINUTES, NO_PREFS, orderModels, readPrefs, withFavourite, writePrefs, type AiPrefs } from '../assistant/prefs.ts';
import { askClaude, CLAUDE_MAX_INPUT, money, type ClaudeSettings } from '../assistant/claude.ts';
import type { OpenRouterSettings } from '../assistant/openrouter.ts';
import { baseName } from '../../fs/names.ts';
import { pickFile } from '../../shell/filepicker.ts';
import { isTextName } from '../notepadpro/findfiles.ts';
import { AGENT_FOLDER, listThreads, openThread, threadLabel, threadToText, titleFrom, type AgentTurn } from './agents.ts';
import { footWords, LiveChat, PIECE_HINT, writingWords, type Pending } from './live.ts';

const GEMMA = 'gemma-2-2b-it-q4f32_1-MLC';
/** "Try a shorter version": the longest answer asked for, in word-pieces (about 150 words). */
const SHORT_ANSWER = 200;

/** An AI reached with the person's own key, which Chat can be opened on ("agents:claude"). */
export type CloudAgent = 'claude' | 'openrouter';

/** How a question is sent: a new one; the last one again (Regenerate); or the last one cut short after the chip stopped. */
type SendMode = 'new' | 'again' | 'short';

/** Why the last try went wrong, for "What happened?": what kind, the words, the question it lost, and which AI. */
interface Trouble {
  kind: 'lost' | 'start' | 'empty';
  words: string;
  question: { text: string; shown: string } | null;
  agent: string | null;
}

export function agentPane(app: AppHandle): { el: HTMLElement; shown: (want?: CloudAgent) => Promise<void> } {
  const { shell, signal } = app;
  const api = shell.account ? new ServiceApi(shell.account.api.base, 'ai') : null;
  const orApi = shell.account ? new ServiceApi(shell.account.api.base, 'openrouter') : null;
  const ai = new OnDevice();
  signal.addEventListener('abort', () => void ai.unload(), { once: true });
  const live = LiveChat.for(shell);

  let models: ModelInfo[] = [];
  let prefs: AiPrefs = { ...NO_PREFS, favourites: [], hidden: [] };
  let claude: ClaudeSettings | null = null;
  let openrouter: OpenRouterSettings | null = null;
  /** The agent that answers: "device:<model id>", "claude" or "openrouter"; null until connected. */
  let connected: string | null = null;
  /** This tab is starting a model, or waiting for its own answer. */
  let busy = false;
  let claudeStop: AbortController | null = null;
  let trouble: Trouble | null = null;

  const pick = h('select', { class: 'agent-pick', 'aria-label': 'Agent' });
  const starBtn = h('button', { type: 'button', class: 'chat-code agent-star', 'aria-label': 'Favourite', 'aria-pressed': 'false' }, '☆');
  const connectBtn = h('button', { type: 'button', class: 'chat-code' }, 'Connect');
  // Disconnect: for the built-in AI it stops the model for the whole
  // desktop (every view too) and frees its graphics memory; the thread stays.
  const disconnectBtn = h('button', { type: 'button', class: 'chat-code', hidden: true, title: 'Stop the AI. The thread stays; for the built-in AI its graphics memory is freed.' }, 'Disconnect');
  const keyBtn = h('button', { type: 'button', class: 'chat-code', title: 'Add or change your Claude or OpenRouter key in Settings › AI' }, 'AI keys...');
  const idleBox = h('input', { type: 'checkbox' });
  const idleLabel = h('label', { class: 'agent-idle', title: `After ${IDLE_MINUTES} minutes without a question, the built-in AI stops and frees its graphics memory. Your next message starts it again by itself.` }, idleBox, ' Disconnect when idle');
  const recent = h('select', { class: 'agent-pick', 'aria-label': 'Recent threads' });
  const newBtn = h('button', { type: 'button', class: 'chat-code' }, 'New thread');
  const saveBtn = h('button', { type: 'button', class: 'chat-code', title: 'Save a copy of this thread somewhere else' }, 'Save as...');
  const deleteBtn = h('button', { type: 'button', class: 'chat-code', title: 'Move this thread to the Recycle Bin' }, 'Delete');
  // Quick jobs on text in the box, or on a text file.
  const sumBtn = h('button', { type: 'button', class: 'chat-code', title: 'Summarise the text in the box, or a file you choose' }, 'Summarise');
  const rewriteBtn = h('button', { type: 'button', class: 'chat-code', title: 'Rewrite the text in the box clearly and politely' }, 'Rewrite');
  const askFileBtn = h('button', { type: 'button', class: 'chat-code', title: 'Choose a text file, then ask a question about it' }, 'Ask about a file...');
  const noteText = h('span', {});
  const note = h('p', { class: 'agent-note', role: 'status', hidden: true }, noteText);
  const progress = h('progress', { class: 'agent-progress', max: 1, value: 0, hidden: true });
  const list = h('ol', { class: 'chat-msgs', 'aria-live': 'polite', 'aria-label': 'Thread' });
  const box = h('textarea', { class: 'chat-box', rows: 2, 'aria-label': 'Message to the agent' });
  const sendBtn = h('button', { type: 'submit', class: 'chat-send' }, 'Send');
  const stopBtn = h('button', { type: 'button', class: 'chat-code', hidden: true }, 'Stop');
  const form = h('form', { class: 'chat-say' }, box, sendBtn, stopBtn);
  const el = h('div', { class: 'agent-pane', hidden: true },
    h('div', { class: 'agent-bar' }, pick, starBtn, connectBtn, disconnectBtn, keyBtn, idleLabel),
    h('div', { class: 'agent-bar' }, recent, newBtn, saveBtn, deleteBtn),
    h('div', { class: 'agent-bar' }, sumBtn, rewriteBtn, askFileBtn),
    note, progress, list, form);

  const agentName = (agent: string | null): string =>
    agent === 'claude' ? (claude?.models.find(m => m.id === claude?.model)?.name ?? 'Claude')
      : agent === 'openrouter' ? (openrouter?.modelName || 'OpenRouter')
        : agent ? modelName(agent.slice(7)) : '';

  /** "What happened?": a button that opens the small box explaining the last stop. */
  const helpButton = (): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'agent-help', title: 'Why the AI stopped, and what to do' }, 'What happened? ', h('span', { class: 'agent-help-mark', 'aria-hidden': 'true' }, '!'));
    on(b, 'click', () => void openHelp(), signal);
    return b;
  };

  /** The line under the controls: words, and "What happened?" when there is a stop to explain. */
  function setNote(text: string, help = false): void {
    noteText.textContent = text;
    note.querySelector('.agent-help')?.remove();
    if (help) note.append(' ', helpButton());
    note.hidden = !text && !help;
  }

  // ---- Drawing ----
  const lastIndex = (role: AgentTurn['role']): number => {
    const turns = live.thread.turns;
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === role) return i;
    return -1;
  };

  /** Copy on every answer; Regenerate on the last answer; Edit on the last question. Only while nothing is being written. */
  function actionsFor(t: AgentTurn): HTMLElement | null {
    const turns = live.thread.turns;
    const i = turns.indexOf(t);
    if (i < 0) return null;
    const idle = !busy && !live.busy;
    const acts: HTMLElement[] = [];
    if (t.role === 'assistant') {
      const copy = h('button', { type: 'button', class: 'chat-act', title: 'Copy this answer' }, 'Copy');
      on(copy, 'click', () => void navigator.clipboard.writeText(t.text).then(
        () => shell.toast('Answer copied.'),
        () => shell.toast('The browser did not allow copying. Select the answer and press Ctrl+C.'),
      ), signal);
      acts.push(copy);
      if (i === turns.length - 1 && idle && turns[i - 1]?.role === 'user') {
        const again = h('button', { type: 'button', class: 'chat-act', title: 'Ask the same question again for a new answer (this one is replaced)', disabled: !canSend() }, 'Regenerate');
        on(again, 'click', () => void regenerate(), signal);
        acts.push(again);
      }
    } else if (i === lastIndex('user') && idle) {
      const edit = h('button', { type: 'button', class: 'chat-act', title: 'Put this question back in the box to change it (its answer is taken away)' }, 'Edit');
      on(edit, 'click', () => void editLast(), signal);
      acts.push(edit);
    }
    return acts.length ? h('div', { class: 'chat-acts' }, ...acts) : null;
  }

  function renderTurn(t: AgentTurn, writing = false): { li: HTMLElement; text: HTMLElement; status: HTMLElement | null } {
    const name = t.role === 'user' ? 'You' : t.by ?? 'AI';
    const text = h('p', { class: 'chat-text' }, live.labels.get(t) ?? (t.text || (writing ? '…' : '')));
    const foot = writing ? null : live.feet.get(t);
    const status = writing ? h('p', { class: 'agent-foot', title: PIECE_HINT, role: 'status' }) : foot ? h('p', { class: 'agent-foot', title: PIECE_HINT }, foot) : null;
    const li = h('li', { class: 'chat-msg' + (t.role === 'user' ? ' mine' : ' agent') },
      h('span', { class: `chat-av ${t.role === 'user' ? 'chat-av-0' : 'chat-av-5'}`, 'aria-hidden': 'true' }, t.role === 'user' ? 'Y' : name[0].toUpperCase()),
      h('div', { class: 'chat-msg-body' },
        h('div', { class: 'chat-who' }, name, h('time', { datetime: new Date(t.at).toISOString() }, new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
        text, status, writing ? null : actionsFor(t)));
    return { li, text, status: writing ? status : null };
  }

  /** The answer being written (here or in another view), updated as it comes without drawing the thread again. */
  let pendingText: HTMLElement | null = null;
  let pendingStatus: HTMLElement | null = null;
  function renderThread(): void {
    const thread = live.thread;
    list.replaceChildren(...thread.turns.map(t => renderTurn(t).li));
    pendingText = null;
    pendingStatus = null;
    if (live.pending) {
      const p = renderTurn({ role: 'assistant', by: live.pending.by, text: live.pending.text, at: live.pending.started }, true);
      pendingText = p.text;
      pendingStatus = p.status;
      if (pendingStatus) pendingStatus.textContent = writingWords(live.pending);
      list.append(p.li);
    } else if (!thread.turns.length) list.append(h('li', { class: 'chat-empty' }, connected
      ? `Ask ${agentName(connected)} something. This thread is kept in Documents › AI chats as you go.`
      : 'Choose an agent above and press Connect. Threads are kept in Documents › AI chats, so closing or reloading loses nothing.'));
    list.scrollTop = list.scrollHeight;
  }

  function renderPending(): void {
    if (!live.pending || !pendingText) return renderThread();
    pendingText.textContent = live.pending.text || '…';
    if (pendingStatus) pendingStatus.textContent = writingWords(live.pending);
    list.scrollTop = list.scrollHeight;
  }

  /** The built-in AI was stopped for being idle, and can start again by itself when a message is sent. */
  function resumable(): boolean {
    const last = OnDevice.lastModel();
    return !connected && !OnDevice.running() && OnDevice.lastStop() === 'idle' && !!last
      && [...pick.options].some(o => o.value === `device:${last.id}` && !o.disabled);
  }
  const canSend = (): boolean => !busy && !live.busy && (!!connected || resumable());

  function paintStar(): void {
    const id = pick.value.startsWith('device:') ? pick.value.slice(7) : null;
    const isFav = !!id && prefs.favourites.includes(id);
    starBtn.hidden = !id;
    starBtn.textContent = isFav ? '★' : '☆';
    starBtn.setAttribute('aria-pressed', String(isFav));
    starBtn.title = isFav ? 'A favourite: listed first. Press to take it off your favourites.' : 'Make it a favourite: favourites are listed first, and the first is chosen when Chat opens.';
  }

  function renderControls(): void {
    const chosen = pick.value;
    const isConnected = !!chosen && chosen === connected;
    const waiting = live.busy && !busy;
    const again = resumable();
    connectBtn.textContent = isConnected ? 'Connected' : 'Connect';
    connectBtn.disabled = busy || isConnected || !chosen || (chosen === 'claude' && !claude?.hasKey) || (chosen === 'openrouter' && !(openrouter?.hasKey && openrouter.model));
    disconnectBtn.hidden = !connected;
    disconnectBtn.disabled = busy || live.busy;
    keyBtn.hidden = !api;
    starBtn.disabled = busy;
    idleLabel.hidden = !models.length;
    sendBtn.disabled = !canSend();
    box.disabled = !connected && !again;
    box.placeholder = again ? `Ask ${modelName(OnDevice.lastModel()?.id ?? '')}: it starts again by itself.`
      : !connected ? 'Connect an agent, then ask.'
        : waiting ? 'The AI is answering in another window; ask when it has finished.'
          : `Ask ${agentName(connected)}. Enter sends; Shift+Enter starts a new line.`;
    stopBtn.hidden = !busy;
    sumBtn.disabled = rewriteBtn.disabled = askFileBtn.disabled = !canSend();
    saveBtn.disabled = deleteBtn.disabled = busy || live.busy || !live.file;
    newBtn.disabled = busy || live.busy;
    recent.disabled = busy || live.busy;
    paintStar();
  }

  async function fillAgents(): Promise<void> {
    // Saved on this TOMLIN OS, or fetched from Hugging Face when started (assistant/models.ts).
    models = await withMyModels((await listModels(shell.account ? new ServiceApi(shell.account.api.base, 'models') : null)).models, shell.fs);
    prefs = await readPrefs(shell.fs);
    idleBox.checked = prefs.idleDisconnect;
    OnDevice.idleAfter(prefs.idleDisconnect ? IDLE_MINUTES : null);
    claude = null;
    openrouter = null;
    if (api) {
      try {
        claude = await api.call<ClaudeSettings>('settings');
      } catch {
        claude = null;
      }
    }
    if (orApi) {
      try {
        openrouter = await orApi.call<OpenRouterSettings>('settings');
      } catch {
        openrouter = null;
      }
    }
    const was = pick.value;
    // The one connected or running stays in the list even when hidden.
    const deviceNow = connected?.startsWith('device:') ? connected.slice(7) : OnDevice.running()?.id ?? (was.startsWith('device:') ? was.slice(7) : null);
    const shownModels = orderModels(models, prefs, deviceNow);
    pick.replaceChildren(
      ...shownModels.map(m => h('option', { value: `device:${m.id}` }, `${prefs.favourites.includes(m.id) ? '★ ' : ''}${modelLabel(m.id)} (on this device, ${formatSize(m.bytes)}${m.mine ? ', you added it' : m.saved ? '' : ', from Hugging Face'})`)),
      claude?.hasKey
        ? h('option', { value: 'claude' }, `${agentName('claude')} (your API key)`)
        : h('option', { value: 'claude', disabled: true }, api ? 'Claude: add your key first (AI keys...)' : 'Claude: needs the TOMLIN OS server'),
      openrouter?.hasKey && openrouter.model
        ? h('option', { value: 'openrouter' }, `${agentName('openrouter')} (OpenRouter, your key)`)
        : h('option', { value: 'openrouter', disabled: true }, orApi ? 'OpenRouter: add your key and a model first (AI keys...)' : 'OpenRouter: needs the TOMLIN OS server'));
    if (!models.length && !claude?.hasKey && !openrouter?.hasKey) pick.prepend(h('option', { value: '', disabled: true }, 'No agent available yet'));
    const keep = [...pick.options].find(o => o.value === (connected ?? was) && !o.disabled);
    // Nothing chosen yet: the first favourite, else Gemma, the model the built-in AI's character is written for
    // (assistant/persona.ts).
    const favourite = [...pick.options].find(o => o.value === `device:${prefs.favourites.find(id => models.some(m => m.id === id))}` && !o.disabled);
    const gemma = [...pick.options].find(o => o.value === `device:${GEMMA}` && !o.disabled);
    pick.value = keep ? keep.value : (favourite?.value ?? gemma?.value ?? [...pick.options].find(o => !o.disabled)?.value ?? '');
  }

  async function fillRecent(): Promise<void> {
    const threads = (await listThreads(shell.fs)).slice(0, 30);
    const file = live.file;
    recent.replaceChildren(
      h('option', { value: '' }, threads.length ? `Recent threads (${threads.length})` : 'No kept threads yet'),
      ...threads.map(t => h('option', { value: t.name }, threadLabel(t.name))));
    recent.value = file && threads.some(t => t.name === file) ? file : '';
  }

  /** Reads the person's choices fresh (Settings may have changed them), changes one, and keeps them. */
  async function changePrefs(change: (p: AiPrefs) => AiPrefs): Promise<boolean> {
    try {
      prefs = change(await readPrefs(shell.fs, true));
      await writePrefs(shell.fs, prefs);
      return true;
    } catch (error) {
      await shell.report('Could not keep your AI choices', error);
      return false;
    }
  }

  // ---- Connecting ----
  const stoppedWords = (why: StopReason | null) =>
    why === 'disconnect' ? 'Disconnected: the built-in AI stopped and its graphics memory is free. Press Connect to start it again.'
      : why === 'lost' ? 'Disconnected: the AI stopped part-way.'
        : why === 'idle' ? `Disconnected after ${IDLE_MINUTES} minutes without a question, to free graphics memory. Your next message starts it again by itself.`
          : 'The built-in AI stopped. Press Connect to start it again.';
  const connectedWords = (id: string, already: boolean) =>
    `${already ? 'Already connected' : 'Connected'}: ${modelName(id)}, on this device. Nothing you type leaves it. It is small and can be wrong.`;

  /**
   * The built-in model running on this desktop (started here or in another view) is joined: nothing starts again.
   * Not when Claude was chosen here, and not while this tab is busy.
   */
  function joinRunning(): void {
    const running = OnDevice.running();
    if (connected?.startsWith('device:') && (!running || connected !== `device:${running.id}`)) {
      const was = connected;
      connected = null;
      if (!running) {
        const why = OnDevice.lastStop();
        if (why === 'lost' && !trouble) trouble = { kind: 'lost', words: '', question: null, agent: was };
        setNote(stoppedWords(why), why === 'lost');
      }
    }
    if (!running || busy || connected) return;
    const value = `device:${running.id}`;
    if (![...pick.options].some(o => o.value === value && !o.disabled)) return;
    connected = value;
    pick.value = value;
    setNote(connectedWords(running.id, true));
  }

  async function connect(): Promise<void> {
    const chosen = pick.value;
    if (!chosen || busy) return;
    if (chosen === 'claude' || chosen === 'openrouter') {
      if (chosen === 'claude' ? !claude?.hasKey : !(openrouter?.hasKey && openrouter.model)) return;
      connected = chosen;
      setNote(chosen === 'claude'
        ? `Connected: ${agentName('claude')}, with your API key. What you send goes to Anthropic and is paid by your account (${money(claude!.spent)} of your ${money(claude!.cap)} limit used this month).`
        : `Connected: ${agentName('openrouter')}, with your OpenRouter key. What you send goes to OpenRouter and the model's maker, paid from your credit (${money(openrouter!.spent)} of your ${money(openrouter!.cap)} limit used this month).`);
      renderControls();
      renderThread();
      box.focus();
      return;
    }
    const model = models.find(m => `device:${m.id}` === chosen);
    if (!model) return;
    const already = ai.ready && ai.model?.id === model.id;
    if (!already) {
      const device = await checkDevice();
      if (!device.webgpu) {
        setNote(device.advice);
        return;
      }
      busy = true;
      renderControls();
      progress.hidden = false;
      setNote(`Starting ${modelName(model.id)}...`);
      try {
        // Another model running on this desktop is replaced, for every view too.
        await ai.load(model, (fraction, text) => {
          progress.value = fraction;
          setNote(text.replace(/\[[^\]]*\]\s*/g, '').slice(0, 160));
        });
      } catch (error) {
        const words = error instanceof Error ? error.message : 'unknown error';
        const fromServer = model.saved !== false;
        const detail = fromServer && isDownloadProblem(words) ? await probeSavedModel(model) : '';
        trouble = { kind: 'start', words: startProblem(words, 'Connect', fromServer, detail), question: null, agent: chosen };
        setNote(`${modelName(model.id)} could not start.`, true);
      } finally {
        busy = false;
        progress.hidden = true;
      }
    }
    if (ai.ready && ai.model?.id === model.id) {
      connected = chosen;
      trouble = null;
      rememberModel(model.id);
      setNote(connectedWords(model.id, already));
    }
    renderControls();
    renderThread();
    box.focus();
  }

  /** After "Disconnect when idle": the same model starts again by itself, then the message goes. */
  async function resume(): Promise<boolean> {
    const last = OnDevice.lastModel();
    if (!resumable() || !last) return false;
    pick.value = `device:${last.id}`;
    await connect();
    return connected === `device:${last.id}`;
  }

  // ---- Keeping ----
  async function keep(thread = live.thread): Promise<void> {
    if (!thread.turns.length) return;
    try {
      await live.keep(shell.fs, thread);
      await fillRecent();
    } catch (error) {
      setNote(`This thread could not be kept in ${AGENT_FOLDER}: ${error instanceof Error ? error.message : 'unknown error'}. Save as... still works.`);
    }
    renderControls();
  }

  // ---- Talking ----
  const limit = async () => (connected === 'claude' || connected === 'openrouter' ? CLAUDE_MAX_INPUT : (await checkDevice()).maxInput);

  /**
   * `shown` is what the thread shows for a quick job ("Summarise: ..."), when it differs from what the AI is sent.
   * `again`: the last question is already in the thread (Regenerate). `short`: only this question, cut to half of what
   * the device takes, with a short answer asked for (after the graphics chip stopped).
   */
  async function send(text: string, shown = text, mode: SendMode = 'new'): Promise<void> {
    if (busy || live.busy || !text.trim()) return;
    if (!connected && !(await resume())) return;
    const agent = connected!;
    const device = agent.startsWith('device:');
    const by = agentName(agent);
    const thread = live.thread;
    busy = true;
    live.busy = true;
    trouble = null;
    if (!thread.turns.length) thread.title = titleFrom(text);
    let question = thread.turns[thread.turns.length - 1];
    if (mode !== 'again' || question?.role !== 'user') {
      question = { role: 'user', text, at: Date.now() };
      if (shown !== text) live.labels.set(question, shown);
      thread.turns.push(question);
      box.value = '';
    }
    const pending: Pending = { by, text: '', started: Date.now(), first: null, pieces: 0, device };
    live.pending = pending;
    live.tell('thread');
    // The line under the answer counts the seconds even while nothing has come yet.
    const ticker = setInterval(() => live.pending === pending && live.tell('pending'), 1000);
    await keep(thread);
    let turns: ChatTurn[] = thread.turns.map(t => ({ role: t.role, content: t.text }));
    if (mode === 'short') turns = [{ role: 'user', content: `${fitText(text, Math.max(200, Math.floor((await limit()) / 2))).text}\n\nAnswer in two or three short sentences.` }];
    const show = (t: string) => {
      if (live.thread !== thread) return;
      pending.pieces++;
      if (pending.first === null && t) pending.first = Date.now();
      pending.text = t;
      live.pending = pending;
      live.tell('pending');
    };
    let answer = '';
    let perSecond = 0;
    let failed: string | null = null;
    let lost = false;
    try {
      if (agent === 'claude' || agent === 'openrouter') {
        claudeStop = new AbortController();
        // OpenRouter's server half streams the same way as Claude's (server/api/openrouter.php).
        const r = await askClaude(agent === 'claude' ? api! : orApi!, turns, show, claudeStop.signal).catch(error => {
          if ((error as Error).name === 'AbortError') return { text: live.pending?.text ?? '', done: null, error: null };
          throw error;
        });
        answer = r.text;
        if (r.error) failed = r.error;
      } else {
        // The built-in AI is Gemma, the same person everywhere (assistant/persona.ts).
        const r = await ai.ask(await personaTurns(shell.fs, shell.account?.user().display ?? '', turns), show, mode === 'short' ? SHORT_ANSWER : undefined);
        answer = inHerOwnWords(r.text);
        perSecond = r.perSecond;
        if (r.looped) setNote('The answer began repeating itself, so it was stopped there.');
      }
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      if (/disposed|device.*lost|DEVICE_HUNG/i.test(words)) {
        lost = true;
        await ai.lost();
        connected = null;
        failed = 'Disconnected: the AI stopped part-way through this answer.';
      } else failed = words;
    } finally {
      clearInterval(ticker);
      claudeStop = null;
      busy = false;
      live.busy = false;
      live.pending = null;
    }
    if (answer.trim()) {
      const turn: AgentTurn = { role: 'assistant', by, text: answer, at: Date.now() };
      thread.turns.push(turn);
      live.feet.set(turn, footWords(pending, turn.at, perSecond));
    } else {
      // An unanswered question is taken back (the next answer then follows the right question) and put back in the box.
      thread.turns.pop();
      box.value = text;
      if (!failed) failed = 'No answer came back.';
      if (device) trouble = { kind: lost ? 'lost' : 'empty', words: failed, question: { text, shown: live.labels.get(question) ?? shown }, agent };
    }
    await keep(thread);
    live.tell('thread');
    if (failed) {
      const li = h('li', { class: 'chat-empty agent-error', role: 'alert' }, failed, trouble ? ' ' : false, trouble ? helpButton() : false);
      list.append(li);
      list.scrollTop = list.scrollHeight;
      if (lost) setNote(stoppedWords('lost'), true);
    }
    renderControls();
    box.focus();
  }

  /** Regenerate: the last answer is taken away and the same question asked again. */
  async function regenerate(): Promise<void> {
    const thread = live.thread;
    const last = thread.turns[thread.turns.length - 1];
    const question = thread.turns[thread.turns.length - 2];
    if (busy || live.busy || last?.role !== 'assistant' || question?.role !== 'user') return;
    thread.turns.pop();
    live.tell('thread');
    await send(question.text, live.labels.get(question) ?? question.text, 'again');
  }

  /** Edit: the last question goes back in the box, and it and its answer leave the thread (and its file). */
  async function editLast(): Promise<void> {
    const thread = live.thread;
    const i = lastIndex('user');
    if (busy || live.busy || i < 0) return;
    const question = thread.turns[i];
    thread.turns.splice(i);
    live.tell('thread');
    box.value = question.text;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    // The kept file follows, so the old question does not come back when the thread is opened again.
    if (live.file) {
      try {
        await live.keep(shell.fs, thread);
      } catch (error) {
        setNote(`This thread could not be kept in ${AGENT_FOLDER}: ${error instanceof Error ? error.message : 'unknown error'}.`);
      }
    }
  }

  /** "What happened?": the likely reason in a few lines, and the ways out to choose from. */
  async function openHelp(): Promise<void> {
    const t = trouble ?? { kind: 'lost' as const, words: '', question: null, agent: null };
    const lastDevice = OnDevice.lastModel();
    const agent = t.agent?.startsWith('device:') ? t.agent : lastDevice ? `device:${lastDevice.id}` : null;
    // Short: the likely reason in a sentence or two; a start's full words stay under "Details".
    const what = t.kind === 'start'
      ? (/did not download/.test(t.words) ? 'A file of the model did not download, even after a few tries. The parts already downloaded are kept, so the next try carries on.'
        : 'This PC may not have enough graphics memory for this model just now.')
      : t.kind === 'empty' ? 'No answer came back from the AI. A small model sometimes writes nothing for an unusual question.'
        : 'The AI stopped part-way through and was disconnected. This PC may be at its limit: Windows stops an older graphics chip when one piece of work runs too long, and a long question, a long chat or a large model makes that more likely.';
    const tips = h('ul', { class: 'dialog-list' },
      h('li', {}, 'Ask something shorter, or start a New thread (the whole chat is read again with every question).'),
      h('li', {}, 'Close other tabs and programs, so the AI has more memory.'),
      h('li', {}, 'If it keeps stopping, refresh this browser page (F5). Your chats are kept.'),
      h('li', {}, 'Choose a smaller model in the list.'));
    const buttons: DialogButton<string>[] = [];
    const offline = !connected || connected !== agent;
    if (agent && offline && pick.querySelector(`option[value="${CSS.escape(agent)}"]:not([disabled])`)) buttons.push({ label: 'Start again', value: 'start', primary: true });
    if (agent && t.question && t.kind !== 'start') buttons.push({ label: 'Try a shorter version', value: 'short', primary: !buttons.length });
    // A file that would not download may be gone from Hugging Face for good: Find AI models searches it for another.
    const notDownloaded = t.kind === 'start' && /did not download/.test(t.words);
    buttons.push({ label: 'Choose another model', value: 'pick' });
    if (notDownloaded) buttons.push({ label: 'Find another model', value: 'find' });
    buttons.push({ label: 'Close', value: 'close' });
    const choice = await shell.dialogs.ask<string>({
      title: t.kind === 'start' ? 'The AI could not start' : t.kind === 'empty' ? 'No answer came back' : 'The AI stopped',
      text: what,
      body: h('div', { class: 'agent-help-body' }, h('p', { class: 'dialog-text' }, 'What can help:'), tips,
        t.kind === 'start' ? h('details', { class: 'agent-help-more' }, h('summary', {}, 'Details'), h('p', { class: 'dialog-detail' }, t.words)) : null),
      buttons,
      cancel: 'close',
    });
    if (signal.aborted) return;
    if (choice === 'pick') {
      pick.focus();
      return;
    }
    if (choice === 'find') {
      void shell.openApp('aimodels');
      return;
    }
    if ((choice === 'start' || choice === 'short') && agent) {
      if (connected !== agent) {
        pick.value = agent;
        await connect();
      }
      if (choice === 'short' && t.question && connected === agent) await send(t.question.text, `${t.question.shown} (shorter version)`, 'short');
    }
  }

  // ---- Controls ----
  on(pick, 'change', () => {
    if ((pick.value === 'claude' && claude?.hasKey) || (pick.value === 'openrouter' && openrouter?.hasKey && openrouter.model)) void connect();
    else if (pick.value && pick.value !== connected) {
      setNote(ai.ready && `device:${ai.model?.id}` === pick.value
        ? 'Already running on this device: press Connect to use it.'
        : `Press Connect to start it (the first time, the model is copied into this browser from ${models.find(m => `device:${m.id}` === pick.value)?.saved === false ? 'Hugging Face' : 'this TOMLIN OS'}).${ai.ready ? ` It replaces ${modelName(ai.model?.id ?? '')}, for the whole desktop.` : ''}`);
    }
    renderControls();
  }, signal);
  on(starBtn, 'click', async () => {
    const id = pick.value.startsWith('device:') ? pick.value.slice(7) : null;
    if (!id) return;
    const isFav = prefs.favourites.includes(id);
    if (!(await changePrefs(p => withFavourite(p, id, !isFav)))) return;
    await fillAgents();
    renderControls();
    shell.toast(isFav ? `${modelName(id)} is no longer a favourite.` : `${modelName(id)} is a favourite: listed first.`);
  }, signal);
  on(idleBox, 'change', async () => {
    const want = idleBox.checked;
    if (!(await changePrefs(p => ({ ...p, idleDisconnect: want })))) {
      idleBox.checked = !want;
      return;
    }
    OnDevice.idleAfter(want ? IDLE_MINUTES : null);
  }, signal);
  on(connectBtn, 'click', () => void connect(), signal);
  on(disconnectBtn, 'click', async () => {
    if (!connected || busy || live.busy) return;
    if (connected === 'claude' || connected === 'openrouter') {
      const was = agentName(connected);
      connected = null;
      setNote(`Disconnected from ${was}: nothing more is sent until you connect again.`);
    } else await ai.disconnect(); // the model stops for every view too; OnDevice.watch below says so here
    renderThread();
    renderControls();
  }, signal);
  on(keyBtn, 'click', () => void shell.openApp('settings', 'ai'), signal);

  // ---- Quick jobs ----
  async function chooseTextFile(): Promise<{ name: string; text: string } | null> {
    const path = await pickFile(shell, { title: 'Choose a text file', folder: '/Documents' });
    if (!path) return null;
    if (!isTextName(path)) {
      await shell.dialogs.alert('Not a text file', 'This reads text files (.txt, .md, .csv, code and the like). For a PDF or a picture, copy the words into the box instead.');
      return null;
    }
    try {
      return { name: baseName(path), text: new TextDecoder('utf-8', { fatal: true }).decode(await shell.fs.readFile(path)) };
    } catch {
      await shell.dialogs.alert('Could not read it', 'That file does not look like text.');
      return null;
    }
  }
  async function quick(job: 'summarise' | 'rewrite'): Promise<void> {
    let text = box.value.trim();
    let label: string;
    const verb = job === 'summarise' ? 'Summarise' : 'Rewrite';
    if (!text) {
      const chosen = await chooseTextFile();
      if (!chosen) return;
      text = chosen.text;
      label = `${verb} “${chosen.name}”`;
    } else label = `${verb}:
${text}`;
    const max = await limit();
    const fit = fitText(text, max);
    if (fit.cut) setNote(`That text is long, so only the first ${max.toLocaleString()} letters were given to the AI.`);
    await send(jobPrompt(job, fit.text), label);
  }
  on(sumBtn, 'click', () => void quick('summarise'), signal);
  on(rewriteBtn, 'click', () => void quick('rewrite'), signal);
  on(askFileBtn, 'click', async () => {
    const chosen = await chooseTextFile();
    if (!chosen) return;
    const q = await shell.dialogs.prompt({ title: `Ask about “${chosen.name}”`, label: 'Your question', ok: 'Ask', check: v => (v.trim() ? null : 'Type a question.') });
    if (!q) return;
    const fit = fitText(chosen.text, await limit());
    if (fit.cut) setNote('That file is long, so only its first part was given to the AI.');
    await send(jobPrompt('ask', fit.text, q), `About “${chosen.name}”: ${q}`);
  }, signal);
  on(newBtn, 'click', () => {
    if (busy || live.busy) return;
    live.open({ title: '', turns: [] });
    box.focus();
  }, signal);
  on(recent, 'change', async () => {
    const name = recent.value;
    if (!name || busy || live.busy) return;
    try {
      live.open(await openThread(shell.fs, name), name);
    } catch (error) {
      await shell.report('Could not open that thread', error);
    }
  }, signal);
  on(deleteBtn, 'click', async () => {
    const file = live.file;
    if (!file || busy || live.busy) return;
    const ok = await shell.dialogs.confirm({ title: 'Delete this thread?', text: `“${threadLabel(file)}” moves to the Recycle Bin. You can restore it from there.`, ok: 'Delete', danger: true });
    if (!ok) return;
    await shell.actions.deleteToBin([joinPath(AGENT_FOLDER, file)]);
    live.open({ title: '', turns: [] });
    await fillRecent();
  }, signal);
  on(saveBtn, 'click', async () => {
    const file = live.file;
    if (!file) return;
    const target = await pickSave(shell, { title: 'Save a copy of this thread', folder: '/Documents', name: file });
    if (!target) return;
    try {
      await shell.fs.writeFile(target.path, new TextEncoder().encode(threadToText(live.thread)), target.replace ? {} : { mustBeNew: true });
      shell.toast('Copy saved.');
    } catch (error) {
      await shell.report('Could not save the copy', error);
    }
  }, signal);
  on(stopBtn, 'click', () => {
    if (connected === 'claude' || connected === 'openrouter') claudeStop?.abort();
    else ai.stop();
  }, signal);
  on(box, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  }, signal);
  on(form, 'submit', (e: SubmitEvent) => {
    e.preventDefault();
    void send(box.value.trim());
  }, signal);

  // The thread and the built-in AI are shared with the other views: what happens there shows here.
  live.watch(change => {
    if (change === 'pending') return renderPending();
    if (change === 'thread') {
      renderThread();
      void fillRecent();
    }
    renderControls();
  }, signal);
  OnDevice.watch(() => {
    joinRunning();
    renderThread();
    renderControls();
  }, signal);
  // A paid answer nobody can see any more is stopped when the window closes. Added after live.watch, so this pane
  // has already left the watchers when it runs; another view still watching shows the answer, so it carries on.
  signal.addEventListener('abort', () => {
    if (!live.watched) claudeStop?.abort();
  }, { once: true });

  /**
   * Called each time the tab is shown: the agents and threads are read again (a key may have been added meanwhile).
   * `want`: "Use Claude" or "Use OpenRouter" in Settings › AI; that AI is chosen when its key is ready and nothing is
   * being answered, otherwise the usual choice stands.
   */
  async function shown(want?: CloudAgent): Promise<void> {
    await Promise.all([fillAgents(), fillRecent()]);
    // The newest kept thread opens again (once per desktop), so closing the Panel or reloading carries on.
    await live.start(shell.fs);
    if (want && !busy && !live.busy && connected !== want && [...pick.options].some(o => o.value === want && !o.disabled)) {
      pick.value = want;
      await connect();
    }
    joinRunning();
    renderThread();
    renderControls();
  }
  renderControls();
  return { el, shown };
}
