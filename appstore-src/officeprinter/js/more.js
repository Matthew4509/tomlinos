// After the Canon: more printers, each one stranger than the last (script.json "after" gives the order).
//   Photo Printer   finally online: all 14 pages on one 6 x 4 photo, with a filter. Enhance only makes it blockier.
//   Receipt Printer the whole report on a till roll, metres of it, then the merchant copy
//   Fax Machine     it cannot print, so it faxes the report... to the Dot Matrix, which refuses it
//   3D Printer      the report as an object, in cyan PLA, until the cyan runs out
//   Fridge          the report on its door, on the shopping list, or in ice: one character a cube
//   The strike      every printer walks out; the chat votes; the demands (timed, like the licence)
//   PrintNet        a cloud subscription, which sends it to... the LaserJet. It was never broken.
// Then the summary, and a few seconds later the LaserJet's (!) again, for version 4 of the report.
import { photoPrinter, photoFit, receiptPrinter, faxMachine, printer3d, fridge, picket, laserjet } from './wild.js';
import { countWords } from './terms.js';

/** x: what main.js shares (its helpers, and S and game as getters, since both are replaced as the game runs). */
export function morePrinters(x) {
  const { h, fill, num, duration, sleep, button, para, icon, quiet, speed } = x;

  const card = (title, ...kids) => {
    const heading = h('h2', { text: title });
    const el = h('section', { class: 'b-cal' }, h('div', { class: 'b-cal-head' }, icon('printer', 'b-cal-icon'), heading), ...kids);
    return { el, heading };
  };
  const rowsList = pairs => h('dl', { class: 'b-job-rows' }, pairs.map(([k, v]) => [h('dt', { text: k }), v instanceof Node ? v : h('dd', { text: v })]));
  const dd = text => h('dd', { text });
  const nextIn = id => {
    const order = x.S.after;
    return order[order.indexOf(id) + 1];
  };

  /**
   * The printer window for one of the new printers: "Connecting to the next printer..." on the left until it is found
   * (then it joins the list), Print status and the chat on the right, and "Try another printer" once it has failed.
   */
  function screen(id, { tab, next, canvas = true }) {
    const S = x.S;
    const w = x.mainWindow();
    const signal = x.show(w.el);
    const tabs = x.rightTabs(w, tab);
    const nextBtn = button(next ?? 'Try another printer', () => open(nextIn(id)), true);
    nextBtn.disabled = true;
    w.foot.append(nextBtn, button('Cancel', () => x.closeCurrent()));
    const line = h('p', { class: 'b-connecting' }, h('span', { class: 'b-spinner', 'aria-hidden': 'true' }), h('span', { text: S.connecting.line }));
    w.stage.append(line);
    const view = canvas ? h('canvas', { class: 'b-paper', 'aria-label': id === 'strike' ? 'The picket line' : `The ${x.printer(id)?.name ?? id}` }) : null;
    const connected = quiet(sleep(1500, signal).then(() => {
      if (id !== 'strike') {
        line.replaceChildren(h('span', { class: 'b-found', text: fill(S.connecting.found, { printer: x.printerName(id) }) }));
        w.select(id);
      }
      if (view) w.stage.append(view);
    }));
    const done = () => {
      nextBtn.disabled = false;
      nextBtn.focus();
    };
    return { S, w, signal, tabs, chat: tabs.chat, nextBtn, canvas: view, connected, done, line };
  }

  // ---------- Photo Printer ----------

  function openPhoto() {
    const sc = screen('photo', { tab: x.S.photo.tab, next: x.S.photo.next });
    const { S, w, signal, chat } = sc;
    const P = S.photo;
    const layout = { cols: 5, rows: 3 };
    const vars = { pages: S.doc.pages };
    const note = h('p', { class: 'b-cal-note' });
    const actions = h('div', { class: 'b-buttons b-cal-actions' });
    const c = card(P.heading, rowsList(P.rows.map(([k, v]) => [k, fill(v, vars)])), note, actions);
    sc.tabs.statusPane.append(c.el);
    quiet(sc.connected.then(async () => {
      w.setStatus('photo', P.status.online);
      chat.post(S.chat.photoStart, signal);
      const pr = photoPrinter(sc.canvas, { pages: S.doc.pages, layout, speed, signal });
      await sleep(1200, signal);
      w.setStatus('photo', P.status.printing);
      await pr.print(n => { note.textContent = fill(P.passNote, { n, what: P.passes[n - 1] }); });
      // How small the report is on the photo, from the photo's size and the fit: the same sums the drawing uses.
      const scale = photoFit(layout);
      c.heading.textContent = P.doneHeading;
      note.textContent = fill(P.done, { pages: S.doc.pages, mm: Math.round(297 * scale), pt: (S.doc.fontPt * scale).toFixed(1), font: S.doc.fontPt });
      w.setStatus('photo', P.status.done);
      chat.post(S.chat.photoDone, signal);
      let level = 0;
      const enhanceNote = h('p', { class: 'b-cal-note', 'aria-live': 'polite' });
      const enhance = button(P.enhance, () => {
        level += 1;
        pr.enhance(level);
        enhanceNote.textContent = level >= 4 ? P.enhanceMax : fill(P.enhanced, { x: 2 ** level, pages: S.doc.pages });
        chat.post(S.chat[`enhance${level}`] ?? [], signal);
        if (level >= 4) enhance.disabled = true;
      });
      actions.replaceChildren(enhance);
      c.el.append(enhanceNote);
      sc.done();
    }));
  }

  // ---------- Receipt Printer ----------

  function openReceipt() {
    const sc = screen('receipt', { tab: x.S.receipt.tab });
    const { S, w, signal, chat } = sc;
    const R = S.receipt;
    const cols = 32;
    const mmLine = 25.4 / 6;
    const mmSecond = 200;
    // The report, word-wrapped to the roll: one line for every 32 of its characters, a marker at each page.
    const bodyCount = Math.ceil(S.doc.characters / cols);
    const perPage = Math.ceil(bodyCount / S.doc.pages);
    const words = R.report.join(' ').split(/\s+/);
    const body = [];
    let wi = 0;
    while (body.length < bodyCount) {
      if (body.length % perPage === 0) { body.push(fill(R.pageMark, { n: body.length / perPage + 1, pages: S.doc.pages })); continue; }
      let lineText = '';
      while ((lineText + ' ' + words[wi % words.length]).trim().length <= cols) lineText = (lineText + ' ' + words[wi++ % words.length]).trim();
      body.push(lineText || words[wi++ % words.length].slice(0, cols));
    }
    const total = R.header.length + body.length + R.footer.length;
    const metres = linesDone => `${((linesDone * mmLine) / 1000).toFixed(2)} m`;
    const now = new Date();
    const vars = {
      date: now.toLocaleDateString('en-GB'), time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      doc: S.doc.name.slice(0, 26), pages: S.doc.pages, lines: num(total), length: metres(total),
    };
    const customer = [...R.header, ...body, ...R.footer].map(l => fill(l, vars));
    const merchant = [...R.merchantHeader, ...body, ...R.footer.slice(0, -1), R.merchantHeader[0]].map(l => fill(l, vars));
    const copy = dd(R.customer);
    const length = dd('0.00 m');
    const count = dd('0');
    const note = h('p', { class: 'b-cal-note' });
    const actions = h('div', { class: 'b-buttons b-cal-actions' });
    const c = card(R.heading, para(fill(R.about, { cols, mm: mmSecond })), rowsList([[R.copy, copy], [R.length, length], [R.lines, count]]), note, actions);
    sc.tabs.statusPane.append(c.el);
    quiet(sc.connected.then(async () => {
      chat.post(S.chat.receiptStart, signal);
      const roll = receiptPrinter(sc.canvas, { signal });
      await sleep(1500, signal);
      w.setStatus('receipt', R.status.printing);
      let printed = 0;
      let toldLong = false;
      // n counts both copies: the merchant copy carries on down the same roll.
      const track = n => {
        printed = n;
        length.textContent = metres(printed);
        count.textContent = num(printed);
        if (!toldLong && printed > total * 0.4) { toldLong = true; chat.post(S.chat.receiptLong, signal); }
      };
      await roll.print(customer, mmSecond / mmLine, speed, track);
      roll.cut();
      copy.textContent = R.merchant;
      chat.post(S.chat.receiptMerchant, signal);
      let cancelled = false;
      actions.replaceChildren(button(R.cancelMerchant, e => { cancelled = true; e.currentTarget.disabled = true; }));
      const finished = await roll.print(merchant, mmSecond / mmLine, speed, track, () => cancelled);
      roll.cut();
      actions.replaceChildren();
      c.heading.textContent = R.doneHeading;
      note.textContent = [finished ? '' : fill(R.merchantCancelled, { length: metres(printed - customer.length) }), fill(R.done, { length: metres(printed) })].filter(Boolean).join(' ');
      w.setStatus('receipt', fill(R.status.done, { length: metres(printed) }));
      x.game.receiptMetres = metres(printed);
      await chat.post(S.chat.receiptDone, signal);
      sc.done();
    }));
  }

  // ---------- Fax Machine ----------

  function openFax() {
    const sc = screen('fax', { tab: x.S.fax.tab });
    const { S, w, signal, chat } = sc;
    const F = S.fax;
    const vars = { number: F.number, pages: S.doc.pages, remote: F.remoteId };
    const phase = dd('');
    const speedRow = dd('');
    const remoteRow = h('p', { class: 'b-cal-note' });
    const note = h('p', { class: 'b-cal-note' });
    const send = button(F.send, () => { send.disabled = true; run(); }, true);
    send.disabled = true;
    const c = card(F.heading, para(F.note),
      rowsList([[F.to, h('dd', {}, h('strong', { text: F.number }), h('span', { class: 'b-muted', text: ` · ${F.numberNote}` }))], ['Status', phase], [F.speedsLabel, speedRow]]),
      remoteRow, note, h('div', { class: 'b-buttons b-cal-actions' }, send));
    sc.tabs.statusPane.append(c.el);
    let st;
    quiet(sc.connected.then(() => {
      st = faxMachine(sc.canvas, { signal });
      phase.textContent = F.lcd.ready;
      chat.post(S.chat.faxStart, signal);
      send.disabled = false;
      send.focus();
    }));
    const run = () => quiet((async () => {
      w.setStatus('fax', F.status.sending);
      phase.textContent = fill(F.phases.dialling, vars);
      const digits = F.number.replace(/\s/g, '');
      for (let i = 1; i <= digits.length; i++) { st.lcd = digits.slice(0, i); await sleep(220, signal); }
      phase.textContent = F.phases.ringing;
      st.lcd = F.lcd.ringing;
      await sleep(2600, signal);
      // The two machines agree a speed, falling back one step at a time on a poor line, as real fax machines do.
      phase.textContent = F.phases.handshake;
      st.wave = true;
      chat.post(S.chat.faxDial, signal);
      for (const s of F.speeds) { speedRow.textContent = s; await sleep(900, signal); }
      st.wave = false;
      st.lcd = fill(F.lcd.sending, vars);
      phase.textContent = fill(F.phases.sending, vars);
      remoteRow.textContent = fill(F.remote, vars);
      w.setStatus('dotmatrix', 'Receiving fax');
      for (let i = 0; i <= 20; i++) { st.docIn = (i / 20) * 0.4; await sleep(120, signal); }
      await chat.post(S.chat.faxIncoming, signal);
      // Refused: the page comes back out, and the one thing the fax prints is the report saying so.
      for (let i = 20; i >= 0; i--) { st.docIn = (i / 20) * 0.4; await sleep(40, signal); }
      st.lcd = F.lcd.ng;
      st.report = F.report.map(l => fill(l, vars));
      for (let i = 0; i <= 30; i++) { st.reportOut = i / 30; await sleep(90, signal); }
      phase.textContent = F.phases.failed;
      c.el.classList.add('is-error');
      note.textContent = F.failedText;
      w.setStatus('fax', F.status.failed);
      w.setStatus('dotmatrix', 'Error: Refused a fax');
      await chat.post(S.chat.faxDone, signal);
      sc.done();
    })());
  }

  // ---------- 3D Printer ----------

  /** The report as an object, and what it costs: every number here is worked out from these few. */
  function model3d() {
    const S = x.S;
    const pageMm = 2;
    const layer = 0.2;
    const infill = 0.2;
    const filamentArea = Math.PI * (1.75 / 2) ** 2;
    const flow = 8; // mm³ a second, an ordinary printer's steady rate
    const height = S.doc.pages * pageMm;
    const volume = 210 * 297 * height * infill;
    const layers = Math.round(height / layer);
    const needed = volume / filamentArea / 1000;
    const loaded = 12;
    const seconds = volume / flow;
    const runoutAt = Math.floor((loaded * 1000 * filamentArea) / (volume / layers)) + 1;
    return { pageMm, layer, height, layers, needed, loaded, seconds, runoutAt, perLayerMinutes: seconds / layers / 60 };
  }

  function openThreed() {
    const sc = screen('threed', { tab: x.S.threed.tab });
    const { S, w, signal, chat } = sc;
    const T = S.threed;
    const m = model3d();
    x.game.plaNeeded = Math.round(m.needed);
    const vars = {
      doc: S.doc.name, pages: S.doc.pages, size: `210 x 297 x ${m.height}`, pageMm: m.pageMm, layers: m.layers, layer: m.layer,
      needed: Math.round(m.needed), loaded: m.loaded, time: duration(m.seconds), minutes: Math.round(m.perLayerMinutes),
    };
    const note = h('p', { class: 'b-cal-note' });
    const bar = h('span', { class: 'b-cal-bar' });
    const track = h('span', { class: 'b-cal-track' }, bar);
    const details = h('div', { class: 'b-judgement' });
    const actions = h('div', { class: 'b-buttons b-cal-actions' });
    const c = card(fill(T.slicing, vars), details, track, note, actions);
    sc.tabs.statusPane.append(c.el);
    quiet(sc.connected.then(async () => {
      const st = printer3d(sc.canvas, { layers: m.layers, signal });
      st.screen = T.screen.idle;
      w.setStatus('threed', T.status.slicing);
      chat.post(S.chat.threedStart, signal);
      for (let i = 0; i <= 20; i++) { bar.style.width = `${i * 5}%`; await sleep(100, signal); }
      track.hidden = true;
      c.heading.textContent = T.heading;
      details.append(para(fill(T.model, vars)), ...T.rows.map(r => para(fill(r, vars))));
      const warn = h('div', { class: 'b-verdict' }, h('strong', { text: T.warnHeading }), h('span', { text: ` ${fill(T.warn, vars)}` }));
      details.append(warn);
      const go = button(T.printAnyway, () => { actions.replaceChildren(); resolveGo(); }, true);
      let resolveGo;
      const started = new Promise(r => { resolveGo = r; });
      actions.replaceChildren(go, button(T.cancel, () => x.closeCurrent()));
      go.focus();
      await started;
      // Heating: the nozzle to 210°C, the bed to 60°C.
      w.setStatus('threed', T.status.heating);
      st.screen = T.screen.heat;
      chat.post(S.chat.threedHeat, signal);
      const nozzle = dd('');
      const bed = dd('');
      details.replaceChildren(para(fill(T.model, vars)), rowsList([[T.nozzle, nozzle], [T.bed, bed]]));
      for (let i = 0; i <= 25; i++) {
        st.heat = i / 25;
        nozzle.textContent = `${Math.round(21 + (210 - 21) * st.heat)}°C / 210°C`;
        bed.textContent = `${Math.round(21 + (60 - 21) * st.heat)}°C / 60°C`;
        await sleep(160, signal);
      }
      c.heading.textContent = T.status.printing;
      w.setStatus('threed', T.status.printing);
      st.printing = true;
      track.hidden = false;
      details.append(para(fill(T.timelapse, vars)));
      for (let n = 1; n <= m.runoutAt; n++) {
        st.layer = n - 1;
        st.screen = fill(T.screen.print, { n, layers: m.layers });
        note.textContent = fill(T.printing, { n, layers: m.layers });
        bar.style.width = `${(100 * n) / m.layers}%`;
        const stopAt = n === m.runoutAt ? 10 : 20;
        for (let s = 0; s <= stopAt; s++) {
          st.nozzle = n % 2 ? s / 20 : 1 - s / 20;
          st.spool = Math.max(0, 1 - (n - 1 + s / 20) / m.runoutAt);
          await sleep(40, signal);
        }
      }
      st.runout = true;
      st.spool = 0;
      st.screen = T.screen.runout;
      c.el.classList.add('is-error');
      c.heading.textContent = T.runoutHeading;
      note.textContent = fill(T.runout, { n: m.runoutAt, layers: m.layers });
      w.setStatus('threed', T.status.runout);
      x.game.cyanTwice = true;
      await chat.post(S.chat.threedRunout, signal);
      sc.done();
    }));
  }

  // ---------- Fridge ----------

  function openFridge() {
    const sc = screen('fridge', { tab: x.S.fridge.tab });
    const { S, w, signal, chat } = sc;
    const Fr = S.fridge;
    const note = h('p', { class: 'b-cal-note', 'aria-live': 'polite' });
    const doorBtn = button(`✓ ${Fr.door}`, null);
    doorBtn.disabled = true;
    const listBtn = button(Fr.list, null);
    const iceBtn = button(Fr.ice, null, true);
    const c = card(Fr.heading, para(Fr.note), h('div', { class: 'b-buttons b-cal-actions' }, doorBtn, listBtn, iceBtn), note);
    sc.tabs.statusPane.append(c.el);
    for (const b of [listBtn, iceBtn]) b.disabled = true;
    quiet(sc.connected.then(async () => {
      const fr = fridge(sc.canvas, { signal });
      w.setStatus('fridge', Fr.status.door);
      note.textContent = Fr.doorDone;
      await chat.post(S.chat.fridgeStart, signal);
      chat.post(S.chat.fridgeDoor, signal);
      listBtn.disabled = false;
      iceBtn.disabled = false;
      sc.done();
      listBtn.addEventListener('click', () => quiet((async () => {
        listBtn.disabled = true;
        fr.st.screen = 'list';
        for (const item of Fr.listItems) {
          fr.st.list.push(fill(item, { pages: S.doc.pages, needed: x.game.plaNeeded ?? Math.round(model3d().needed) }));
          await sleep(450, signal);
        }
        note.textContent = Fr.listDone;
        chat.post(S.chat.fridgeList, signal);
      })()));
      iceBtn.addEventListener('click', () => quiet((async () => {
        iceBtn.disabled = true;
        fr.st.screen = 'door';
        const days = Math.ceil(S.doc.characters / Fr.perDay);
        const ready = new Date(Date.now() + days * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        note.textContent = fill(Fr.iceText, { chars: num(S.doc.characters), perDay: Fr.perDay, days: num(days), date: ready });
        w.setStatus('fridge', Fr.status.ice);
        chat.post(S.chat.fridgeIce, signal);
        const textSource = S.receipt.report.join(' ').toUpperCase();
        for (let i = 0; i < Fr.bin; i++) { fr.drop(textSource[i]); await sleep(420, signal); }
        fr.st.full = true;
        w.setStatus('fridge', Fr.status.full);
        note.textContent = `${note.textContent} ${fill(Fr.iceFull, { made: Fr.bin, left: num(S.doc.characters - Fr.bin) })}`;
      })()));
    }));
  }

  // ---------- The strike ----------

  function openStrike() {
    const sc = screen('strike', { tab: x.S.strike.tab, next: x.S.strike.next });
    const { S, w, signal, chat, tabs } = sc;
    const K = S.strike;
    const c = card(K.noneHeading, para(K.none));
    c.el.classList.add('is-error');
    const demandsSlot = h('div', {});
    tabs.statusPane.append(c.el, demandsSlot);
    quiet(sc.connected.then(async () => {
      sc.line.replaceChildren(h('span', { class: 'b-verdict-inline', text: K.noneHeading }));
      picket(sc.canvas, { signs: K.signs, signal });
      // Everyone walks out, one after another; the LaserJet is management, so it stays as it was.
      for (const id of x.game.found) {
        if (id === 'laserjet') continue;
        w.setStatus(id, K.status);
        await sleep(350, signal);
      }
      tabs.select('chat');
      await chat.post(S.chat.strikeCall, signal);
      await chat.post(S.chat.strikeVotes, signal);
      const votesFor = S.chat.strikeVotes.filter(([who]) => who !== 'laserjet').length;
      await chat.post(S.chat.strikeCarried, signal, { for: votesFor });
      await sleep(800, signal);
      demands();
    }));
    function demands() {
      const agree = button(K.agree, null, true);
      agree.disabled = true;
      const radio = (value, label, checked) => h('label', { class: 'b-radio' },
        h('input', { type: 'radio', name: 'b-demands', value, checked, onchange: () => { agree.disabled = value !== 'yes'; } }), h('span', { text: label }));
      const list = h('ol', { class: 'b-demands' }, K.demands.map(d => h('li', { text: d })));
      const box = h('section', { class: 'b-cal' }, h('h2', { text: K.demandsHeading }), para(K.demandsIntro), list,
        h('div', { class: 'b-radios', role: 'radiogroup' }, radio('yes', K.accept, false), radio('no', K.decline, true)),
        h('div', { class: 'b-buttons b-cal-actions' }, agree, button(K.cross, () => settle(false))));
      demandsSlot.replaceChildren(box);
      tabs.select('status');
      const shown = performance.now();
      agree.addEventListener('click', () => settle(true, (performance.now() - shown) / 1000, countWords(box.textContent)));
      function settle(agreed, seconds = 0, words = 0) {
        for (const b of box.querySelectorAll('button, input')) b.disabled = true;
        box.append(h('p', { class: 'b-verdict' }, h('strong', { text: agreed ? K.agreed : K.crossed })));
        if (agreed) x.game.wordsRead += words;
        chat.post(agreed ? S.chat.strikeAgreed : S.chat.strikeCrossed, signal, { seconds: duration(seconds) });
        sc.done();
      }
    }
  }

  // ---------- PrintNet, and the LaserJet ----------

  function openCloud() {
    const sc = screen('cloud', { tab: x.S.cloud.tab, canvas: false });
    const { S, w, signal, chat, tabs } = sc;
    const C = S.cloud;
    const note = h('p', { class: 'b-cal-note', 'aria-live': 'polite' });
    const actions = h('div', { class: 'b-buttons b-cal-actions' });
    let toldFree = false;
    const plans = h('div', { class: 'b-plans' }, C.plans.map(p => h('button', { class: 'b-plan', type: 'button', onclick: e => choose(p, e.currentTarget) },
      h('strong', { text: p.name }), h('span', { class: 'b-plan-price', text: p.price }), h('span', { text: p.note }))));
    const c = card(C.heading, para(C.sub), plans, note, actions);
    tabs.statusPane.append(c.el);
    quiet(sc.connected.then(() => {
      w.setStatus('cloud', C.status.ready);
      chat.post(S.chat.cloudStart, signal);
    }));
    function choose(plan, el) {
      for (const b of plans.children) b.classList.toggle('is-chosen', b === el);
      if (plan.pages < S.doc.pages) {
        note.textContent = fill(C.tooFew, { pages: S.doc.pages, plan: plan.name, n: plan.pages });
        actions.replaceChildren();
        if (!toldFree) { toldFree = true; chat.post(S.chat.cloudFree, signal); }
        return;
      }
      note.textContent = '';
      const trial = button(C.trial, () => { for (const b of plans.children) b.disabled = true; trial.disabled = true; print(); }, true);
      actions.replaceChildren(trial);
      trial.focus();
    }
    const print = () => quiet((async () => {
      note.textContent = C.finding;
      await sleep(1800, signal);
      note.textContent = fill(C.found, { printer: x.printerName('laserjet') });
      w.select('laserjet');
      w.setStatus('laserjet', C.status.printing);
      const view = h('canvas', { class: 'b-paper', 'aria-label': 'The LaserJet printing' });
      sc.line.replaceChildren(h('span', { class: 'b-found', text: fill(S.connecting.found, { printer: x.printerName('laserjet') }) }));
      w.stage.append(view);
      const lj = laserjet(view, { signal });
      chat.post(S.chat.cloudPrint, signal);
      await lj.print(S.doc.pages, speed, n => { w.setStatus('laserjet', fill(C.printing, { n, pages: S.doc.pages })); });
      w.setStatus('laserjet', C.status.ready);
      x.game.printed = S.doc.pages;
      c.heading.textContent = C.doneHeading;
      note.textContent = fill(C.done, { pages: S.doc.pages, printer: x.printerName('laserjet') });
      await sleep(2500, signal);
      summary(w, tabs);
      // And then, a few seconds later, it starts again: someone has saved a new version of the report.
      quiet(sleep(S.summary.loopDelay, signal).then(() => {
        S.doc.name = S.doc.name.replace(/v(\d+)/, (all, n) => `v${Number(n) + 1}`);
        x.toast(true);
      }));
    })());
  }

  /** One short row of numbers, side by side, at the very end. */
  function summary(w, tabs) {
    const S = x.S;
    const game = x.game;
    const s = S.summary;
    const secs = Math.round((Date.now() - game.startedAt) / 1000);
    const spent = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
    const vars = { pages: S.doc.pages, printed: game.printed ?? 0, tried: game.tried.size, spent, wordsRead: num(game.wordsRead), cyan: game.cyanTwice ? s.cyan.two : s.cyan.one };
    tabs.statusPane.append(h('dl', { class: 'b-summary' }, s.stats.map(([value, label]) => h('div', { class: 'b-stat' },
      h('dt', { text: label }), h('dd', { text: fill(value, vars) })))));
    tabs.select('status');
    w.foot.replaceChildren(button(s.again, () => x.openStatus(), true), button(s.close, () => x.closeCurrent()));
  }

  const screens = { photo: openPhoto, receipt: openReceipt, fax: openFax, threed: openThreed, fridge: openFridge, strike: openStrike, cloud: openCloud };
  function open(id) { screens[id](); }
  return { open, first: () => open(x.S.after[0]) };
}
