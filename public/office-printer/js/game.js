// Office Printer: the game on a page. mountGame(element, host) builds it inside `element`; the stand-alone page
// (index.html) and TOMLIN OS both call it, each with its own "host": where to keep the saved game, how to read files,
// and which document to print. The story itself is script.json; this file shows it and keeps time.
import {
  INKS, applyStep, choicesOf, endingOf, fill, foundCount, gossipFor, holds, inkWords, inksOf, loadSave, mockLine,
  newRun, nextOf, resolve, roastLines, speakerOf, stepOf, tell, textOf, unlock, varsOf, warrantyDue,
} from './engine.js';
import { RENDERS } from './renders.js';
import { face, fileIcon, sheet } from './draw.js';
import { describe, factsFor } from './facts.js';
import { sampleFiles } from './samples.js';
import { Sound } from './sound.js';

const BASE = new URL('../', import.meta.url);

/** Builds an element from text and child elements only (never from markup). */
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (/^on|^style$/i.test(key)) throw new Error(`"${key}" is not allowed here`);
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** A line of dialogue with *stars* shown as emphasis. */
function richText(text) {
  const out = [];
  const parts = String(text).split(/\*([^*]+)\*/);
  parts.forEach((part, i) => {
    if (!part) return;
    out.push(i % 2 ? el('em', {}, part) : document.createTextNode(part));
  });
  return out;
}

function deferred() {
  let resolveIt;
  const promise = new Promise(res => {
    resolveIt = res;
  });
  return { promise, resolve: resolveIt };
}

function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (navigator.userAgentData?.mobile || /Mobi|Android|iPhone/i.test(ua)) return 'phone';
  return 'laptop';
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function mountGame(root, host = {}) {
  const game = new Game(root, host);
  await game.init();
  return {
    print: file => game.printRequest(file),
    /** "Retry" on the printer's error message: print the last document again. */
    printLast: () => game.printLast(),
    destroy: () => game.destroy(),
  };
}

class Game {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.speed = Math.min(50, Math.max(0.1, Number(host.speed) || 1));
    this.reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.env = { device: host.device ?? detectDevice(), now: new Date() };
    this.life = new AbortController();
    this.sound = new Sound();
    this.run = null;
    this.beat = null;
    this.runAbort = null;
    this.saveTimer = 0;
    this.shown = { c: 100, m: 100, y: 100, k: 100 };
    this.closers = [];
    if (host.signal) host.signal.addEventListener('abort', () => this.destroy(), { once: true });
  }

  // ---- Setting up ------------------------------------------------------------------------------------------------

  async loadText(path) {
    if (this.host.loadText) return this.host.loadText(path);
    const res = await fetch(new URL(path, BASE), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.text();
  }

  async init() {
    this.script = JSON.parse(await this.loadText('script.json'));
    let saved = null;
    try {
      saved = await this.host.storage?.load();
    } catch {
      saved = null;
    }
    this.save = loadSave(saved);
    this.samples = sampleFiles(this.script);
    this.build();
    this.showStart();
    await this.setFile(this.host.file ?? this.samples[0]);
    const listen = { signal: this.life.signal };
    this.el.addEventListener('keydown', event => this.onKey(event), listen);
    if (this.host.ownPrintKey) {
      document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
          event.preventDefault();
          this.printRequest();
        }
      }, listen);
    }
    this.wobble();
  }

  destroy() {
    if (this.life.signal.aborted) return;
    this.flush();
    this.life.abort();
    this.runAbort?.abort();
    this.beat?.abort();
    this.sound.close();
    this.el?.remove();
  }

  g() {
    return { script: this.script, save: this.save, run: this.run, env: { ...this.env, now: new Date() } };
  }

  build() {
    const s = this.script;
    this.faceHost = el('span', { class: 'op-who-face' });
    this.whoName = el('strong', {});
    this.whoPlace = el('span', { class: 'op-who-place' });
    this.attemptsEl = el('span', { class: 'op-attempts' });
    this.endingsBtn = el('button', { type: 'button', class: 'op-chip' });
    this.soundBtn = el('button', { type: 'button', class: 'op-chip', 'aria-pressed': 'false' });
    this.cancelBtn = el('button', { type: 'button', class: 'op-chip op-cancel', hidden: true }, 'Cancel print');
    this.bars = {};
    this.boxes = {};
    this.inkName = el('span', { class: 'op-ink-name' });
    const ink = el('div', { class: 'op-ink', role: 'img' }, el('span', { class: 'op-ink-label', 'aria-hidden': 'true' }, 'Ink', this.inkName));
    for (const c of INKS) {
      const fillEl = el('span', { class: 'op-bar-fill' });
      this.bars[c] = fillEl;
      this.boxes[c] = el('span', { class: `op-bar op-bar-${c}`, 'aria-hidden': 'true' }, el('span', { class: 'op-bar-track' }, fillEl), el('span', { class: 'op-bar-label' }, c.toUpperCase()));
      ink.append(this.boxes[c]);
    }
    this.inkEl = ink;
    this.startEl = el('section', { class: 'op-start' });
    this.log = el('div', { class: 'op-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Printers', hidden: true });
    this.choicesEl = el('div', { class: 'op-choices', role: 'group', 'aria-label': 'Your answer' });
    this.layer = el('div', { class: 'op-layer', hidden: true });
    this.popup = el('aside', { class: 'op-popup', role: 'alertdialog', 'aria-label': s.warranty.title, hidden: true });
    this.el = el('div', { class: 'op' },
      el('header', { class: 'op-top' },
        el('div', { class: 'op-who' }, this.faceHost, el('div', { class: 'op-who-text' }, this.whoName, this.whoPlace)),
        el('div', { class: 'op-stats' }, this.attemptsEl, this.endingsBtn, this.soundBtn, this.cancelBtn)),
      ink,
      el('main', { class: 'op-main' }, this.startEl, this.log),
      this.choicesEl,
      this.popup,
      this.layer);
    this.root.append(this.el);
    const listen = { signal: this.life.signal };
    // When the answers appear (or a picture finishes, or the window changes size), the chat gets shorter: keep its
    // newest line in view unless the player has scrolled up to read.
    this.stick = true;
    this.log.addEventListener('scroll', () => {
      this.stick = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    }, { passive: true, ...listen });
    const keep = new ResizeObserver(() => {
      if (this.stick && !this.log.hidden) this.log.scrollTop = this.log.scrollHeight;
    });
    keep.observe(this.log);
    keep.observe(this.choicesEl);
    this.life.signal.addEventListener('abort', () => keep.disconnect(), { once: true });
    this.endingsBtn.addEventListener('click', () => this.showEndings(), listen);
    this.soundBtn.addEventListener('click', () => {
      this.save.sound = !this.save.sound;
      this.sound.enable(this.save.sound);
      this.sound.play('beep');
      this.persist();
      this.paintStats();
    }, listen);
    this.cancelBtn.addEventListener('click', () => this.cancelRun(), listen);
    this.paintWho('laserjet');
    this.paintStats();
    this.paintInk(true);
  }

  // ---- The start screen and the file to print ---------------------------------------------------------------------

  async setFile(file) {
    this.file = file;
    this.reading = true;
    this.facts = { name: file.name, kind: 'other', ext: '' };
    this.paintDoc(true);
    try {
      this.facts = await factsFor(this.script, file);
    } catch {
      this.facts = { name: file.name, kind: 'other', ext: '', unreadable: true };
    }
    this.reading = false;
    this.paintDoc(false);
  }

  paintDoc(reading) {
    if (!this.docCard || !this.facts) return;
    const icon = sheet(56, 64);
    fileIcon(icon.g, this.facts.kind, 6, 2, 56, this.facts.ext);
    this.docCard.replaceChildren(icon.canvas, el('div', { class: 'op-doc-text' },
      el('strong', {}, this.facts.name),
      el('span', {}, reading ? 'Reading the file...' : describe(this.facts))));
  }

  showStart() {
    this.closeLayer();
    this.hidePopup();
    this.cancelBtn.hidden = true;
    // It starts as an ordinary print dialog. Nothing says "game" until the printers start talking.
    const lj = this.script.speakers.laserjet;
    this.docCard = el('div', { class: 'op-doc' });
    const printBtn = el('button', { type: 'button', class: 'op-btn op-primary op-print' }, 'Print');
    const otherBtn = el('button', { type: 'button', class: 'op-btn' }, 'Change document...');
    const tosBtn = el('button', { type: 'button', class: 'op-link' }, 'Terms of Service');
    const row = (label, value) => el('div', { class: 'op-field' }, el('span', { class: 'op-field-label' }, label), el('span', { class: 'op-field-value' }, value));
    this.startEl.replaceChildren(
      el('div', { class: 'op-dialog' },
        el('h1', {}, 'Print'),
        row('Printer', `${lj.name} (${lj.place}), default`),
        el('div', { class: 'op-field' }, el('span', { class: 'op-field-label' }, 'Document'), this.docCard),
        row('Pages', 'All'),
        row('Copies', '1'),
        row('Colour', 'Colour'),
        el('div', { class: 'op-start-actions' }, otherBtn, printBtn),
        el('p', { class: 'op-small' }, 'By printing, you agree to the ', tosBtn, '.')));
    this.paintDoc(false);
    const listen = { signal: this.life.signal };
    printBtn.addEventListener('click', () => this.startRun(), listen);
    otherBtn.addEventListener('click', () => this.showPicker(), listen);
    tosBtn.addEventListener('click', () => this.startRun(this.script.tosStart), listen);
    this.startEl.hidden = false;
    this.log.hidden = true;
    this.choicesEl.replaceChildren();
    this.run = null;
    this.paintWho('laserjet');
    this.shown = { c: 100, m: 100, y: 100, k: 100 };
    this.paintInk(true);
    printBtn.focus({ preventScroll: true });
  }

  showPicker() {
    const list = el('ul', { class: 'op-files' });
    for (const file of this.samples) {
      const icon = sheet(32, 36);
      const kind = this.script && Object.entries(this.script.kinds).find(([, exts]) => exts.some(e => file.name.toLowerCase().endsWith(e)))?.[0];
      fileIcon(icon.g, kind ?? 'other', 3, 1, 34, file.name.slice(file.name.lastIndexOf('.')));
      const btn = el('button', { type: 'button', class: 'op-file' }, icon.canvas, el('span', {}, el('strong', {}, file.name), el('span', {}, file.note)));
      btn.addEventListener('click', () => {
        this.closeLayer();
        void this.setFile(file);
      }, { signal: this.life.signal });
      list.append(el('li', {}, btn));
    }
    const own = el('button', { type: 'button', class: 'op-btn' }, this.host.pickLabel ?? 'Choose a file from this device...');
    own.addEventListener('click', async () => {
      const file = await this.pickOwn();
      if (!file) return;
      this.closeLayer();
      await this.setFile(file);
    }, { signal: this.life.signal });
    const close = el('button', { type: 'button', class: 'op-btn' }, 'Back');
    close.addEventListener('click', () => this.closeLayer(), { signal: this.life.signal });
    this.openLayer(el('div', { class: 'op-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'op-pick-title' },
      el('h2', { id: 'op-pick-title' }, 'Change document'),
      list,
      el('div', { class: 'op-panel-actions' }, own, close),
      el('p', { class: 'op-small' }, 'Your file stays on this device. The printers only look at its name, its size and, for a picture, its colours.')));
  }

  pickOwn() {
    if (this.host.pickFile) return this.host.pickFile();
    return new Promise(resolveIt => {
      const input = el('input', { type: 'file', class: 'op-sr' });
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        input.remove();
        resolveIt(f ? { name: f.name, size: f.size, blob: async () => f } : null);
      }, { once: true });
      input.addEventListener('cancel', () => {
        input.remove();
        resolveIt(null);
      }, { once: true });
      this.el.append(input);
      input.click();
    });
  }

  /** Ctrl+P, the Print button or a host asking: start printing, unless a print job is already going. */
  async printRequest(file) {
    if (this.life.signal.aborted) return;
    if (this.run && !this.run.over) {
      if (!this.busyNoted) {
        this.busyNoted = true;
        this.addSystem('One print job at a time.');
      }
      return;
    }
    if (file) await this.setFile(file);
    this.startRun();
  }

  // ---- A run -------------------------------------------------------------------------------------------------------

  startRun(entry) {
    if (!this.facts || this.reading || this.life.signal.aborted) return;
    this.closeLayer();
    this.hidePopup();
    if (this.save.sound) this.sound.enable(true);
    this.save.attempts += 1;
    this.persist();
    this.runAbort?.abort();
    this.beat?.abort();
    this.runAbort = new AbortController();
    this.run = newRun(this.script, this.facts, entry ?? this.script.start);
    this.run.inkAt = 'laserjet';
    this.busyNoted = false;
    this.shown = { c: 100, m: 100, y: 100, k: 100 };
    this.startEl.hidden = true;
    this.log.hidden = false;
    this.log.replaceChildren();
    this.choicesEl.replaceChildren();
    this.cancelBtn.hidden = false;
    this.paintWho('laserjet');
    this.paintInk(true);
    this.paintStats();
    this.save.lastDoc = { name: this.facts.name, path: this.file?.path ?? null, sample: this.file?.sample ?? null };
    this.addSystem(`Printing ${this.facts.name}...`);
    void this.preroll(this.runAbort.signal).then(() => {
      if (!this.runAbort.signal.aborted) void this.goto(this.run.node);
    });
  }

  /** A few seconds of an ordinary print job before anyone talks: spooling, sending, a status. */
  async preroll(signal) {
    const lj = this.script.speakers.laserjet;
    const steps = [`Spooling ${this.facts.name} (1 page)...`, `Sending to ${lj.name} (${lj.place})...`, `${lj.name}: Busy`];
    for (const line of steps) {
      await this.wait(this.reduced ? 150 : 900, signal);
      if (signal.aborted) return;
      this.addSystem(line);
    }
    await this.wait(this.reduced ? 150 : 1400, signal);
  }

  /** Print the last document again (the printer's "Retry"). */
  async printLast() {
    const doc = this.save.lastDoc;
    let file = null;
    if (doc?.sample) file = this.samples.find(f => f.sample === doc.sample) ?? null;
    else if (doc?.path && this.host.fileAt) file = await this.host.fileAt(doc.path).catch(() => null);
    return this.printRequest(file);
  }

  cancelRun() {
    this.runAbort?.abort();
    this.beat?.abort();
    this.flush();
    this.showStart();
  }

  async goto(id) {
    this.beat?.abort();
    const beat = new AbortController();
    this.beat = beat;
    const signal = beat.signal;
    if (!this.run || this.runAbort.signal.aborted) return;
    this.busyNoted = false;
    try {
      const { id: nodeId, node } = resolve(this.script, this.g(), id);
      this.run.node = nodeId;
      this.stepsDone = deferred();
      if (node.bounce) await this.switchTo(node.bounce, signal);
      for (const step of textOf(node)) {
        if (signal.aborted) return;
        if ((await this.doStep(step, node, signal)) === 'end') return;
      }
      if (signal.aborted) return;
      this.stepsDone.resolve();
      if (node.ending) return this.finish(node.ending);
      const choices = choicesOf(node, this.g());
      if (choices.length) return this.showChoices(node, choices, signal);
      const next = nextOf(node.next, this.g());
      if (!next) throw new Error(`"${nodeId}" has no choices, no ending and no next`);
      await this.wait(350, signal);
      if (!signal.aborted) void this.goto(next);
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    }
  }

  /** One line or effect from a node's "text" or a choice's "effects". Returns 'end' when it ended the run. */
  async doStep(raw, node, signal) {
    const g = this.g();
    const step = stepOf(raw);
    const speaker = speakerOf(node.speaker ?? 'network', g);
    if (step.if && !holds(step.if, g)) return;
    if (step.line != null) return this.say(speaker, step.line, signal);
    if (step.say) return this.say(speakerOf(step.by ?? speaker, g), step.say, signal, step.style);
    if (step.render) return this.render(step, speaker, signal);
    if (step.bounce) return this.switchTo(step.bounce, signal);
    if (step.ending) {
      this.stepsDone.resolve();
      await this.finish(step.ending);
      return 'end';
    }
    if (applyStep(step, g)) {
      this.persist();
      if (inksOf(step).length) await this.animateInk(step, signal);
      return;
    }
    if (step.wait) return this.wait(step.wait, signal);
    if (step.sound) return this.sound.play(step.sound);
    if (step.mock) {
      const line = mockLine(this.script, this.save);
      if (line) await this.say(speaker, line, signal);
      return;
    }
    if (step.gossip) {
      const heard = gossipFor(this.script, this.save, speaker);
      if (heard) {
        tell(this.save, speaker, heard.note);
        this.persist();
        await this.say(speaker, heard.line, signal);
      }
      return;
    }
    if (step.roast) {
      for (const line of roastLines(this.script, this.run.file, g)) {
        if (signal.aborted) return;
        await this.say(speaker, line, signal);
      }
      return;
    }
    if (step.warranty) return this.worstMoment();
    throw new Error(`A step the game does not know: ${JSON.stringify(step)}`);
  }

  render(step, speaker, signal) {
    const draw = RENDERS[step.render];
    if (!draw) throw new Error(`No picture called "${step.render}"`);
    const runSignal = this.runAbort.signal;
    const kit = {
      script: this.script,
      save: this.save,
      run: this.run,
      facts: this.run.file,
      speed: this.speed,
      sound: this.sound,
      reduced: this.reduced,
      signal,
      runSignal,
      stepsDone: this.stepsDone.promise,
      el,
      sheet,
      figure: (content, caption, opts = {}) => this.addFigure(content, caption, opts),
      say: (text, by) => this.say(by ?? speaker, text, signal),
      wait: ms => this.wait(ms, signal),
      frame: (s = signal) => this.frame(s),
      fill: (text, extra) => fill(text, this.g(), extra),
      vars: () => varsOf(this.g()),
      worstMoment: () => this.worstMoment(),
      overlay: node => this.openLayer(node),
      loadText: path => this.loadText(path),
    };
    return draw(step, kit);
  }

  showChoices(node, choices, signal) {
    const buttons = choices.map((choice, i) => {
      const btn = el('button', { type: 'button', class: 'op-choice' }, el('span', { class: 'op-key', 'aria-hidden': 'true' }, String(i + 1)), choice.label);
      btn.addEventListener('click', () => void this.choose(node, choice, signal), { signal });
      return btn;
    });
    this.choicesEl.classList.toggle('op-quiz', !!node.quiz);
    this.choicesEl.replaceChildren(...buttons);
    this.scrollDown();
    buttons[0]?.focus({ preventScroll: true });
  }

  async choose(node, choice, signal) {
    if (signal.aborted || this.choicesEl.dataset.busy) return;
    this.choicesEl.dataset.busy = '1';
    this.choicesEl.replaceChildren();
    this.addYou(choice.say ?? choice.label);
    try {
      for (const step of choice.effects ?? []) {
        if (signal.aborted) return;
        if ((await this.doStep(step, node, signal)) === 'end') return;
      }
      if (!signal.aborted) void this.goto(nextOf(choice.next, this.g()));
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    } finally {
      delete this.choicesEl.dataset.busy;
    }
  }

  async finish(id) {
    const ending = endingOf(this.script, id);
    const fresh = unlock(this.save, id, today());
    this.run.over = true;
    this.flush();
    this.runAbort.abort();
    this.hidePopup();
    this.cancelBtn.hidden = true;
    this.sound.play('chime');
    const total = this.script.endings.length;
    const found = foundCount(this.script, this.save);
    const times = this.save.endings[id].count;
    this.log.append(el('section', { class: `op-ending${fresh ? ' op-new' : ''}` },
      el('h2', {}, `Ending ${ending.n}/${total}: ${ending.title}`),
      el('p', {}, ending.text),
      el('p', { class: 'op-ending-meta' }, fresh ? `New ending. ${found} of ${total} found.` : `Found ${times} times. ${found} of ${total} found.`)));
    this.scrollDown();
    this.paintStats();
    const again = el('button', { type: 'button', class: 'op-choice op-primary' }, 'Print again');
    const list = el('button', { type: 'button', class: 'op-choice' }, 'Endings');
    const other = el('button', { type: 'button', class: 'op-choice' }, 'Change document');
    const listen = { signal: this.life.signal };
    again.addEventListener('click', () => this.startRun(), listen);
    list.addEventListener('click', () => this.showEndings(), listen);
    other.addEventListener('click', () => this.showStart(), listen);
    this.choicesEl.classList.remove('op-quiz');
    this.choicesEl.replaceChildren(again, list, other);
    again.focus({ preventScroll: true });
  }

  fail(error) {
    console.error(error);
    this.host.onError?.(error);
    this.log.append(el('p', { class: 'op-system op-fault' }, `Something went wrong in the game: ${error?.message ?? error}. Cancel the print and try again.`));
    this.scrollDown();
  }

  // ---- Talking -----------------------------------------------------------------------------------------------------

  wait(ms, signal) {
    const scaled = ms / this.speed;
    return new Promise(res => {
      if (signal?.aborted) return res();
      const timer = setTimeout(done, scaled);
      function done() {
        signal?.removeEventListener('abort', done);
        clearTimeout(timer);
        res();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The next animation frame. A page that is not being drawn (a background tab, a covered window) gets no frames at
   * all, so a slow timer stands in and the story creeps on instead of stopping dead.
   */
  frame(signal) {
    return new Promise(res => {
      if (signal?.aborted) return res(performance.now());
      let id = 0;
      let timer = 0;
      const done = () => {
        cancelAnimationFrame(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        res(performance.now());
      };
      id = requestAnimationFrame(done);
      timer = setTimeout(done, 70);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async say(speakerId, raw, signal, style) {
    if (signal?.aborted) return;
    const who = this.script.speakers[speakerId] ?? this.script.speakers.network;
    const text = fill(raw, this.g());
    const shown = who.caps ? text.toUpperCase() : text;
    const typing = this.addMessage(speakerId, null, style);
    const ms = this.reduced ? 150 : Math.min(1500, 320 + shown.length * 16);
    await this.wait(ms, signal);
    if (signal?.aborted) {
      typing.remove();
      return;
    }
    typing.replaceWith(this.addMessage(speakerId, shown, style, false));
    this.scrollDown();
    await this.wait(220, signal);
  }

  addMessage(speakerId, text, style, append = true) {
    const who = this.script.speakers[speakerId] ?? this.script.speakers.network;
    const bubble = el('div', { class: 'op-bubble' }, el('span', { class: 'op-name' }, who.name));
    if (text == null) {
      bubble.append(el('span', { class: 'op-typing', 'aria-label': `${who.name} is typing` }, el('i', {}), el('i', {}), el('i', {})));
    } else {
      bubble.append(el('p', {}, ...richText(text)));
    }
    const row = el('div', { class: `op-msg op-from-${speakerId}${style ? ` op-${style}` : ''}` }, face(speakerId, 36), bubble);
    if (append) {
      this.log.append(row);
      this.scrollDown();
    }
    return row;
  }

  addYou(text) {
    this.log.append(el('div', { class: 'op-msg op-you' }, el('div', { class: 'op-bubble' }, el('span', { class: 'op-name' }, 'You'), el('p', {}, text))));
    this.scrollDown();
  }

  addSystem(text) {
    this.log.append(el('p', { class: 'op-system' }, text));
    this.scrollDown();
  }

  addFigure(content, caption, opts) {
    const fig = el('figure', { class: 'op-printout' }, content, opts.extra ?? null, el('figcaption', { class: 'op-sr' }, caption));
    this.log.append(fig);
    this.scrollDown();
    return fig;
  }

  /** Keeps the newest line in view (straight there: a smooth scroll can be overtaken by the next line). */
  scrollDown() {
    if (this.log.hidden) return;
    this.stick = true;
    this.log.scrollTop = this.log.scrollHeight;
  }

  // ---- The header: who you are talking to, the ink, the counters -------------------------------------------------------

  async switchTo(id, signal) {
    if (this.run.at === id) return;
    this.run.at = id;
    const who = this.script.speakers[id];
    this.addSystem(`Connecting to ${who.name} (${who.place})...`);
    this.sound.play('beep');
    await this.wait(550, signal);
    this.paintWho(id);
    if (who.printer) {
      this.run.inkAt = id;
      this.shown = { c: 100, m: 100, y: 100, k: 100 };
      this.paintInk(true);
    }
  }

  paintWho(id) {
    const who = this.script.speakers[id];
    this.faceHost.replaceChildren(face(id, 40));
    this.whoName.textContent = who.name;
    this.whoPlace.textContent = who.place;
  }

  paintStats() {
    const total = this.script.endings.length;
    // The counters give the game away, so they appear only once the first ending has been found.
    const revealed = foundCount(this.script, this.save) > 0;
    this.attemptsEl.hidden = !revealed;
    this.endingsBtn.hidden = !revealed;
    this.attemptsEl.textContent = `Attempt ${Math.max(1, this.save.attempts)}`;
    this.endingsBtn.textContent = `Endings ${foundCount(this.script, this.save)}/${total}`;
    this.soundBtn.textContent = this.save.sound ? 'Sound on' : 'Sound off';
    this.soundBtn.setAttribute('aria-pressed', String(this.save.sound));
  }

  /** The bars show what the printer claims, which is "full", until the moment it matters. */
  paintInk(instant) {
    for (const c of INKS) {
      this.bars[c].style.transform = `scaleY(${Math.max(0, Math.min(100, this.shown[c])) / 100})`;
      this.boxes[c].classList.toggle('op-empty', this.shown[c] <= 0);
    }
    const who = this.script.speakers[this.run?.inkAt ?? 'laserjet'];
    this.inkName.textContent = who.name;
    this.inkEl.setAttribute('aria-label', `Ink, ${who.name}: ${inkWords(this.shown)}`);
    this.inkEl.classList.toggle('op-instant', !!instant);
  }

  async animateInk(step, signal) {
    const who = step.printer ?? this.run.at;
    if (who !== this.run.inkAt) return;
    const tank = this.run.ink[who];
    const falling = inksOf(step).some(c => tank[c] < this.shown[c]);
    if (falling) this.sound.play('glug');
    for (const c of inksOf(step)) this.shown[c] = tank[c];
    this.paintInk(false);
    await this.wait(this.reduced ? 100 : 900, signal);
  }

  /** Now and then a bar rises for no reason, then falls again. */
  wobble() {
    if (this.reduced) return;
    const tick = () => {
      if (this.life.signal.aborted) return;
      const c = INKS[Math.floor(Math.random() * INKS.length)];
      const bar = this.bars[c];
      bar.classList.add('op-wobble');
      setTimeout(() => bar.classList.remove('op-wobble'), 2200);
      setTimeout(tick, 9000 + Math.random() * 9000);
    };
    setTimeout(tick, 7000);
  }

  // ---- The Extended Warranty -------------------------------------------------------------------------------------------

  worstMoment() {
    if (!warrantyDue(this.save, this.run) || this.run?.over) return;
    this.run.warrantyShown = true;
    const w = this.script.warranty;
    const buy = el('button', { type: 'button', class: 'op-btn op-primary' }, w.buy);
    const no = el('button', { type: 'button', class: 'op-btn' }, w.decline);
    this.popup.replaceChildren(el('strong', {}, w.title), el('p', {}, fill(w.pitch, this.g())), el('div', { class: 'op-panel-actions' }, buy, no));
    this.popup.hidden = false;
    const runSignal = this.runAbort.signal;
    const timer = setTimeout(() => this.hidePopup(), 12000 / Math.min(this.speed, 4));
    const pick = (label, node) => {
      clearTimeout(timer);
      this.hidePopup();
      if (!this.run || this.run.over || runSignal.aborted) return;
      this.choicesEl.replaceChildren();
      this.addYou(label);
      void this.goto(node);
    };
    buy.addEventListener('click', () => pick(w.buy, 'warranty_buy'), { signal: runSignal });
    no.addEventListener('click', () => pick(w.decline, 'jam_1'), { signal: runSignal });
  }

  hidePopup() {
    if (this.popup) this.popup.hidden = true;
  }

  // ---- Endings ------------------------------------------------------------------------------------------------------------

  showEndings() {
    const s = this.script;
    const found = foundCount(s, this.save);
    const grid = el('ol', { class: 'op-grid' });
    for (const ending of s.endings) {
      const got = this.save.endings[ending.id];
      grid.append(el('li', { class: `op-card${got ? ' op-got' : ''}` },
        el('span', { class: 'op-card-n' }, String(ending.n)),
        el('strong', {}, got ? ending.title : '???'),
        el('span', {}, got ? ending.text : `Not found yet. Hint: ${ending.hint}`),
        got ? el('span', { class: 'op-card-meta' }, got.count > 1 ? `Found ${got.count} times` : 'Found once') : null));
    }
    const close = el('button', { type: 'button', class: 'op-btn op-primary' }, 'Back');
    close.addEventListener('click', () => this.closeLayer(), { signal: this.life.signal });
    const panel = el('div', { class: 'op-panel op-endings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'op-endings-title' },
      el('h2', { id: 'op-endings-title' }, `Endings: ${found} of ${s.endings.length} found`),
      el('p', { class: 'op-small' }, `Attempts so far: ${this.save.attempts}.`),
      grid);
    if (this.host.messages) {
      const box = el('input', { type: 'checkbox' });
      box.checked = this.save.messages;
      box.addEventListener('change', () => {
        this.save.messages = box.checked;
        this.persist();
      }, { signal: this.life.signal });
      panel.append(el('label', { class: 'op-check' }, box, ' Show printer error alerts on the desktop (at most one a day)'));
    }
    panel.append(el('div', { class: 'op-panel-actions' }, close));
    this.openLayer(panel);
  }

  // ---- Overlays -------------------------------------------------------------------------------------------------------------

  openLayer(node) {
    this.closeLayer();
    this.layer.replaceChildren(node);
    this.layer.hidden = false;
    const back = document.activeElement;
    const onKey = event => {
      if (event.key === 'Escape' && !node.classList.contains('op-tos') && !node.classList.contains('op-speed')) {
        event.stopPropagation();
        this.closeLayer();
      }
    };
    this.layer.addEventListener('keydown', onKey);
    const close = () => {
      this.layer.removeEventListener('keydown', onKey);
      if (this.layer.firstChild === node) {
        this.layer.replaceChildren();
        this.layer.hidden = true;
      }
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
    this.closers = [close];
    node.querySelector('button, [tabindex]')?.focus({ preventScroll: true });
    return close;
  }

  closeLayer() {
    for (const close of this.closers.splice(0)) close();
  }

  onKey(event) {
    if (event.target instanceof HTMLInputElement || event.defaultPrevented) return;
    if (!this.layer.hidden) return;
    const n = Number(event.key);
    if (n >= 1 && n <= 9 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const btn = this.choicesEl.querySelectorAll('button')[n - 1];
      if (btn) {
        event.preventDefault();
        btn.click();
      }
    }
  }

  // ---- Saving -------------------------------------------------------------------------------------------------------------

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.saveTimer);
    const store = this.host.storage;
    if (!store) return;
    Promise.resolve(store.save(JSON.parse(JSON.stringify(this.save)))).catch(error => this.host.onError?.(error));
  }
}
