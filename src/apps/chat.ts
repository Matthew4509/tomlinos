// Chat: talk to the other people who have an account on this TOMLIN OS. General is everyone; Direct is two people. The
// layout is a staff chat (General | Direct, a dot for who is online, the thread with a box under it). Messages
// are encrypted in this browser before they leave it (chat/crypto.ts); the line under the tabs says whether a
// conversation is end to end or not, and why. Nothing here reaches anyone outside this TOMLIN OS.
// Agents (chat/agentpane.ts) is the third tab: an AI to talk to, the built-in one or Claude with the person's own key,
// its threads kept in Documents › AI chats. (Only a conversation with Claude leaves the TOMLIN OS: it goes to Anthropic.)
import { h, on } from '../core/dom.ts';
import { icon } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { ChatSession, MAX_TEXT, dmId, type Message } from './chat/session.ts';
import { agentPane, type CloudAgent } from './chat/agentpane.ts';

type View = 'general' | 'people' | 'agents' | string;

const AVATAR_COLOURS = 8;
const avatarClass = (id: string): string => {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `chat-av chat-av-${n % AVATAR_COLOURS}`;
};
const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();

function when(at: number): string {
  const d = new Date(at * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

export const chatApp: AppDef = {
  ...APPS.chat,
  async launch(app, arg) {
    const { shell, signal } = app;
    app.root.classList.add('chat-app');
    if (!shell.account) {
      app.root.append(h('p', { class: 'app-message' }, 'Chat is for the people who sign in to this TOMLIN OS, so it needs TOMLIN OS running on its server with accounts. Here, files are kept in this browser only.'));
      return;
    }
    const chat = ChatSession.for(shell);
    // Opened with "agents" (Settings › AI, the Panel's AI link) it starts on the Agents tab; "agents:claude" or
    // "agents:openrouter" (Settings › AI's "Use Claude", "Use OpenRouter") also picks that AI when it is ready to use.
    const agentsArg = (a: string | undefined): { want?: CloudAgent } | null => {
      const m = /^agents(?::(claude|openrouter))?$/.exec(a ?? '');
      return m ? { want: m[1] as CloudAgent | undefined } : null;
    };
    let view: View = agentsArg(arg) ? 'agents' : 'general';
    // Who is in Chat is who has an account here: the owner adds people in My account, so Chat says so and has the
    // button, where the question comes up (General with nobody else, and the Direct list).
    const owner = !!shell.account.user().admin;
    const addPeople = () => {
      const b = h('button', { type: 'button', class: 'chat-add' }, 'Add people...');
      on(b, 'click', () => void shell.openApp('account', 'people'), signal);
      return b;
    };

    const tabGeneral = h('button', { type: 'button', class: 'chat-tab', role: 'tab' }, 'General');
    const tabDirect = h('button', { type: 'button', class: 'chat-tab', role: 'tab' }, 'Direct');
    const tabAgents = h('button', { type: 'button', class: 'chat-tab', role: 'tab', title: 'Talk to an AI: the built-in one, or Claude with your key' }, 'Agents');
    const lock = h('span', { class: 'chat-lock' });
    const status = h('p', { class: 'chat-status', hidden: true });
    const head = h('div', { class: 'chat-head' }, h('div', { class: 'chat-tabs', role: 'tablist', 'aria-label': 'Conversations' }, tabGeneral, tabDirect, tabAgents), lock);

    const threadHead = h('div', { class: 'chat-thread-head', hidden: true });
    const list = h('ol', { class: 'chat-msgs', 'aria-live': 'polite', 'aria-label': 'Messages' });
    const box = h('textarea', { class: 'chat-box', rows: 2, maxlength: MAX_TEXT, placeholder: 'Message General', 'aria-label': 'Message' });
    const sendBtn = h('button', { type: 'submit', class: 'chat-send' }, 'Send');
    const form = h('form', { class: 'chat-say' }, box, sendBtn);
    // Under the messages: how long they are kept, and deleting (your own; the owner can also clear General).
    const tools = h('div', { class: 'chat-tools' });
    const threadPane = h('div', { class: 'chat-thread' }, threadHead, list, tools, form);
    const people = h('ul', { class: 'chat-people', 'aria-label': 'People' });
    const peoplePane = h('div', { class: 'chat-people-pane', hidden: true }, people);
    const agents = agentPane(app);
    app.root.append(h('div', { class: 'chat' }, head, status, threadPane, peoplePane, agents.el));

    let shownConv = '';
    let shownVersion = -1;

    const conv = (): string => (view === 'general' || view === 'people' || view === 'agents' ? 'general' : view);

    /** Deletes after asking; the words say it is for everyone, and what deleting cannot undo. */
    async function removeAsked(title: string, text: string, what: { id: number } | { mine: true } | { all: true }): Promise<void> {
      const ok = await shell.dialogs.confirm({ title, text: `${text} Anyone who already read it may remember it or have copied it.`, ok: 'Delete', danger: true });
      if (!ok) return;
      try {
        const n = await chat.remove(conv(), what);
        if (!('id' in what)) shell.toast(n ? `Deleted ${n} message${n === 1 ? '' : 's'}.` : 'There was nothing to delete.');
      } catch (error) {
        await shell.dialogs.alert('Not deleted', error instanceof Error ? error.message : 'Chat could not delete that. Try again.');
      }
    }

    function renderMessage(m: Message): HTMLElement {
      const who = chat.person(m.from);
      const name = who ? (who.me ? 'You' : who.display) : 'Someone who has left';
      const mayDelete = who?.me || (owner && conv() === 'general');
      const del = mayDelete ? h('button', { type: 'button', class: 'chat-del', 'aria-label': 'Delete this message', title: 'Delete this message, for everyone' }, 'Delete') : null;
      if (del) on(del, 'click', () => void removeAsked('Delete this message?', 'It is removed from the server, for everyone in this conversation.', { id: m.id }), signal);
      return h('li', { class: 'chat-msg' + (who?.me ? ' mine' : '') },
        h('span', { class: avatarClass(m.from), 'aria-hidden': 'true' }, initial(who?.display ?? '?')),
        h('div', { class: 'chat-msg-body' },
          h('div', { class: 'chat-who' }, name, h('time', { datetime: new Date(m.at * 1000).toISOString() }, when(m.at)), del),
          m.text === null
            ? h('p', { class: 'chat-text sealed' }, chat.blocked(conv()) ? 'Waiting for the key to open this message.' : 'This message cannot be opened here: it was sent under an earlier chat key, or changed on the way.')
            : h('p', { class: 'chat-text' }, m.text)));
    }

    function renderTools(): void {
      const c = conv();
      const days = chat.state?.vanishDays ?? 0;
      const mine = chat.thread(c).some(m => chat.person(m.from)?.me);
      const parts: Array<HTMLElement | string> = [h('span', { class: 'chat-sub' }, days ? `Messages vanish after ${days} days.` : 'Messages are kept until deleted.')];
      if (mine) {
        const b = h('button', { type: 'button', class: 'chat-code' }, 'Delete my messages here...');
        on(b, 'click', () => void removeAsked('Delete all your messages here?', `Every message you sent in ${c === 'general' ? 'General' : 'this conversation'} is removed from the server, for everyone.`, { mine: true }), signal);
        parts.push(b);
      }
      if (owner && c === 'general' && chat.thread(c).length) {
        const b = h('button', { type: 'button', class: 'chat-code' }, 'Clear General...');
        on(b, 'click', () => void removeAsked('Clear General?', 'Every message in General, from everyone, is removed from the server.', { all: true }), signal);
        parts.push(b);
      }
      tools.replaceChildren(...parts);
    }

    function renderThread(): void {
      const c = conv();
      renderTools();
      const messages = chat.thread(c);
      const version = chat.threadVersion(c);
      if (c === shownConv && version === shownVersion) return;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      const fresh = c !== shownConv;
      list.replaceChildren(...messages.map(renderMessage));
      if (!messages.length) {
        const alone = (chat.state?.people.length ?? 0) < 2;
        const words = c === 'general'
          ? alone
            ? owner
              ? 'Only you have an account here, so General is a place for notes to yourself for now. Everyone you add to this desktop joins it, and can be messaged under Direct.'
              : 'Only you have an account here so far. Everyone the owner adds to this desktop joins General.'
            : 'No messages yet. Say hello.'
          : 'No messages yet.';
        list.append(h('li', { class: 'chat-empty' }, words, ...(c === 'general' && alone && owner ? [h('br'), addPeople()] : [])));
      }
      shownConv = c;
      shownVersion = version;
      if (fresh || nearBottom) list.scrollTop = list.scrollHeight;
      if (!document.hidden) void chat.markRead(c);
    }

    function renderPeople(): void {
      const others = (chat.state?.people ?? []).filter(p => !p.me);
      people.replaceChildren(...others.map(p => {
        const c = chat.state ? dmId(chat.state.me, p.id) : '';
        const unread = chat.unread(c);
        const sub = p.disabled ? 'account switched off' : !p.pub ? 'has not opened Chat yet' : p.online ? 'online' : 'away';
        const b = h('button', { type: 'button', class: 'chat-person' },
          h('span', { class: 'chat-dot' + (p.online ? ' on' : ''), 'aria-hidden': 'true' }),
          h('span', { class: 'chat-person-main' }, h('b', {}, p.display), h('span', { class: 'chat-sub' }, sub)),
          unread ? h('span', { class: 'chat-count', 'aria-label': `${unread} unread` }, String(unread)) : null);
        on(b, 'click', () => show(c), signal);
        return h('li', {}, b);
      }));
      if (!others.length) people.append(h('li', { class: 'chat-empty' }, owner ? 'Nobody else has an account here yet. Add someone, and they appear here.' : 'Nobody else has an account here yet. The owner of this desktop adds people.'));
      if (owner) people.append(h('li', { class: 'chat-add-row' }, addPeople()));
    }

    function renderLock(): void {
      const c = conv();
      const open = view !== 'people' && view !== 'agents';
      lock.hidden = !open || !chat.state;
      if (!open || !chat.state) return;
      const plain = chat.notEndToEnd(c);
      lock.replaceChildren(icon('lock', 16), plain.length ? 'Not end to end' : 'End to end');
      lock.classList.toggle('weak', plain.length > 0);
      const names = plain.map(p => (p.me ? 'your' : `${p.display}'s`));
      lock.title = plain.length
        ? `Messages are encrypted on the way and on the server, but not end to end: ${names.join(' and ')} files are not encrypted, so that chat key is kept readable on this server. Turn on file encryption in My account to close this gap.`
        : 'Only the people in this conversation can open its messages. The server keeps them scrambled.';
    }

    function renderThreadHead(): void {
      if (view === 'general' || view === 'people' || view === 'agents') {
        threadHead.hidden = true;
        return;
      }
      const other = chat.other(view);
      const back = h('button', { type: 'button', class: 'chat-back', 'aria-label': 'Back to Direct' }, '‹');
      on(back, 'click', () => show('people'), signal);
      const code = h('button', { type: 'button', class: 'chat-code' }, 'Safety code');
      on(code, 'click', async () => {
        const c = await chat.safety(view);
        await shell.dialogs.alert('Safety code', c
          ? `Read these digits to ${other?.display ?? 'them'} (in person or on the phone). If their screen shows the same, the messages this server stores and passes on cannot be read by it or anyone else.`
          : `${other?.display ?? 'They'} have not opened Chat yet, so there is no code to compare.`, c || undefined);
      }, signal);
      threadHead.replaceChildren(back,
        h('span', { class: 'chat-dot' + (other?.online ? ' on' : ''), 'aria-hidden': 'true' }),
        h('b', {}, other?.display ?? 'Unknown'),
        h('span', { class: 'chat-sub' }, other?.online ? 'online' : 'away'),
        code);
      threadHead.hidden = false;
    }

    function renderTabs(): void {
      const direct = Object.entries(chat.state?.convs ?? {}).filter(([c]) => c !== 'general').reduce((n, [, i]) => n + i.unread, 0);
      const general = chat.unread('general');
      tabGeneral.setAttribute('aria-selected', String(view === 'general'));
      tabDirect.setAttribute('aria-selected', String(view !== 'general' && view !== 'agents'));
      tabAgents.setAttribute('aria-selected', String(view === 'agents'));
      tabGeneral.replaceChildren('General', general && view !== 'general' ? h('span', { class: 'chat-count' }, String(general)) : '');
      tabDirect.replaceChildren('Direct', direct ? h('span', { class: 'chat-count' }, String(direct)) : '');
    }

    function renderStatus(): void {
      const why = view === 'agents' ? null : chat.problem ?? (view !== 'people' && chat.state ? chat.blocked(conv()) : null);
      status.hidden = !why;
      status.textContent = why ?? '';
      const blocked = view === 'people' || !!chat.blocked(conv());
      box.disabled = blocked;
      sendBtn.disabled = blocked;
    }

    function render(): void {
      threadPane.hidden = view === 'people' || view === 'agents';
      peoplePane.hidden = view !== 'people';
      agents.el.hidden = view !== 'agents';
      renderTabs();
      renderLock();
      renderStatus();
      if (view === 'agents') return;
      if (view === 'people') renderPeople();
      else {
        renderThreadHead();
        renderThread();
      }
    }

    async function show(next: View, want?: CloudAgent): Promise<void> {
      view = next;
      shownConv = '';
      if (next === 'agents') {
        render();
        await agents.shown(want);
        return;
      }
      if (next !== 'people') {
        const other = next === 'general' ? null : chat.other(next);
        box.placeholder = next === 'general' ? 'Message General' : `Message ${other?.display ?? ''}`;
      }
      render();
      if (next !== 'people' && chat.state) {
        await chat.load(conv()).catch(() => undefined);
        render();
      }
    }

    on(tabGeneral, 'click', () => void show('general'), signal);
    on(tabDirect, 'click', () => void show('people'), signal);
    on(tabAgents, 'click', () => void show('agents'), signal);
    on(box, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    }, signal);
    on(form, 'submit', async (e: SubmitEvent) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text || box.disabled) return;
      sendBtn.disabled = true;
      try {
        await chat.send(conv(), text);
        box.value = '';
      } catch (error) {
        await shell.dialogs.alert('Not sent', error instanceof Error ? error.message : 'Chat could not send that. Try again.');
      } finally {
        render();
        box.focus();
      }
    }, signal);

    chat.changed.on(() => {
      render();
      const c = conv();
      const info = chat.state?.convs[c];
      if (view !== 'people' && view !== 'agents' && info && info.last > (chat.thread(c).at(-1)?.id ?? 0)) void chat.load(c).then(render, () => undefined);
    }, signal);
    chat.arrived.on(({ conv: c }) => {
      if (c === conv() && view !== 'people' && view !== 'agents') return;
      const who = c === 'general' ? 'General' : chat.other(c)?.display ?? 'someone';
      shell.toast(`New message in ${c === 'general' ? who : `Direct from ${who}`}`);
    }, signal);
    on(document, 'visibilitychange', () => !document.hidden && view !== 'agents' && void chat.markRead(conv()), signal);

    // Opened again while open (Settings › AI's "Open Chat › Agents"): go where that asks.
    app.onReopen(next => {
      const to = agentsArg(next);
      if (to) void show('agents', to.want);
    });

    render();
    chat.use(signal);
    await chat.refresh();
    await show(view, agentsArg(arg)?.want);
  },
};
