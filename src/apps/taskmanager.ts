// Task Manager: the open windows (switch to one, or end it; a window with unsaved work still asks first), and how the
// desktop is doing: smoothness (frames a second and how often the page stalls), memory (where the browser tells us),
// and how much your files take up (measured on request, as it reads every folder).
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { joinPath } from '../fs/names.ts';
import { icon } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

interface ChromeMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export const taskManagerApp: AppDef = {
  ...APPS.taskmanager,
  launch(app) {
    const shell = app.shell;
    app.root.classList.add('tm');
    const tabApps = h('button', { type: 'button', class: 'tm-tab', role: 'tab', 'aria-selected': 'true' }, 'Apps');
    const tabPerf = h('button', { type: 'button', class: 'tm-tab', role: 'tab', 'aria-selected': 'false' }, 'Performance');
    const appsPane = h('div', { class: 'tm-pane' });
    const perfPane = h('div', { class: 'tm-pane', hidden: true });
    const status = h('div', { class: 'statusbar', role: 'status' });
    app.root.append(h('div', { class: 'tm-tabs', role: 'tablist' }, tabApps, tabPerf), appsPane, perfPane, status);

    // ---- Apps ----
    let chosen: string | null = null;
    const list = h('div', { class: 'tm-list', role: 'listbox', 'aria-label': 'Open windows', tabindex: '0' });
    const switchBtn = h('button', { type: 'button', class: 'btn' }, 'Switch to');
    const endBtn = h('button', { type: 'button', class: 'btn' }, 'End task');
    appsPane.append(list, h('div', { class: 'row-buttons' }, switchBtn, endBtn));
    const titleOf = (id: string) => shell.apps().find(a => a.id === id)?.title ?? id;
    let drawn = '';
    function paintApps() {
      const wins = shell.windows.list().filter(w => w.id !== app.id);
      if (chosen && !wins.some(w => w.id === chosen)) chosen = null;
      // Rebuild only when something shown here changed: bringing a window to the front also announces a change, and
      // rebuilding then would swap the row under the pointer between its press and its click.
      const now = JSON.stringify([chosen, wins.map(w => [w.id, w.title, w.state, w.dirty])]);
      if (now === drawn) return;
      drawn = now;
      list.replaceChildren(...wins.map(w => {
        const row = h('div', { class: `tm-row${w.id === chosen ? ' on' : ''}`, role: 'option', 'aria-selected': String(w.id === chosen), tabindex: '-1' },
          icon(w.iconName, 20), h('span', { class: 'tm-name' }, w.title), h('span', { class: 'tm-app' }, titleOf(w.appId)),
          h('span', { class: 'tm-state' }, w.dirty ? 'Not saved' : w.state === 'min' ? 'Minimised' : 'Running'));
        on(row, 'click', () => ((chosen = w.id), paintApps()), app.signal);
        on(row, 'dblclick', () => shell.windows.focus(w), app.signal);
        return row;
      }));
      if (!wins.length) list.append(h('p', { class: 'tm-empty' }, 'No other windows are open.'));
      switchBtn.disabled = endBtn.disabled = !chosen;
      status.textContent = plural(wins.length, 'window') + ' open';
    }
    const chosenWin = () => shell.windows.list().find(w => w.id === chosen);
    on(switchBtn, 'click', () => {
      const w = chosenWin();
      if (w) shell.windows.focus(w);
    }, app.signal);
    on(endBtn, 'click', () => {
      const w = chosenWin();
      if (w) void shell.windows.close(w).then(paintApps);
    }, app.signal);
    shell.windows.changed.on(paintApps, app.signal);

    // ---- Performance ----
    const fps = h('strong', {}, '…');
    const stalls = h('strong', {}, '0');
    const heap = h('strong', {}, '…');
    const graph = h('canvas', { class: 'tm-graph', width: 480, height: 90, 'aria-label': 'Frames a second over the last minute' });
    const filesOut = h('strong', {}, 'not measured');
    const measureBtn = h('button', { type: 'button', class: 'btn' }, 'Measure my files');
    perfPane.append(
      h('div', { class: 'tm-cards' },
        h('div', { class: 'tm-card' }, h('span', {}, 'Smoothness'), fps, h('small', {}, 'frames a second (60 is smooth)')),
        h('div', { class: 'tm-card' }, h('span', {}, 'Stalls'), stalls, h('small', {}, 'times the page froze for more than 50 ms')),
        h('div', { class: 'tm-card' }, h('span', {}, 'Memory'), heap, h('small', {}, 'used by this page\'s scripts'))),
      graph,
      h('div', { class: 'tm-files' }, h('span', {}, 'Your files: '), filesOut, ' ', measureBtn),
      h('p', { class: 'hint' }, `Files are kept: ${shell.storeLabel}.`));

    const history: number[] = [];
    let frames = 0;
    let last = performance.now();
    let longTasks = 0;
    let running = true;
    const tick = (now: number) => {
      if (!running) return;
      frames++;
      if (now - last >= 1000) {
        const rate = Math.round((frames * 1000) / (now - last));
        frames = 0;
        last = now;
        history.push(rate);
        if (history.length > 60) history.shift();
        if (!perfPane.hidden) paintPerf(rate);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    app.signal.addEventListener('abort', () => (running = false), { once: true });
    if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const po = new PerformanceObserver(l => (longTasks += l.getEntries().length));
      po.observe({ type: 'longtask', buffered: false });
      app.signal.addEventListener('abort', () => po.disconnect(), { once: true });
    }
    function paintPerf(rate: number) {
      fps.textContent = String(rate);
      stalls.textContent = String(longTasks);
      const mem = (performance as unknown as { memory?: ChromeMemory }).memory;
      heap.textContent = mem ? `${formatSize(mem.usedJSHeapSize)} of ${formatSize(mem.jsHeapSizeLimit)}` : 'not shown by this browser';
      const c = graph.getContext('2d')!;
      c.clearRect(0, 0, graph.width, graph.height);
      c.fillStyle = '#f4f3ee';
      c.fillRect(0, 0, graph.width, graph.height);
      c.strokeStyle = '#2f6db8';
      c.lineWidth = 2;
      c.beginPath();
      history.forEach((v, i) => {
        const x = (i / 59) * graph.width;
        const y = graph.height - (Math.min(v, 75) / 75) * (graph.height - 6) - 3;
        c[i ? 'lineTo' : 'moveTo'](x, y);
      });
      c.stroke();
    }

    on(measureBtn, 'click', async () => {
      measureBtn.disabled = true;
      filesOut.textContent = 'measuring...';
      let bytes = 0;
      let files = 0;
      let folders = 0;
      const walk = async (path: string): Promise<void> => {
        for (const e of await shell.fs.list(path, true)) {
          if (app.signal.aborted) return;
          if (e.kind === 'folder') {
            folders++;
            await walk(joinPath(path, e.name));
          } else {
            files++;
            bytes += e.size;
          }
        }
      };
      try {
        await walk('/');
        filesOut.textContent = `${formatSize(bytes)} in ${plural(files, 'file')} and ${plural(folders, 'folder')} (the Recycle Bin and settings included)`;
      } catch (error) {
        filesOut.textContent = 'could not be measured';
        await shell.report('Could not measure your files', error);
      } finally {
        measureBtn.disabled = false;
      }
    }, app.signal);

    const show = (perf: boolean) => {
      appsPane.hidden = perf;
      perfPane.hidden = !perf;
      tabApps.setAttribute('aria-selected', String(!perf));
      tabPerf.setAttribute('aria-selected', String(perf));
      if (perf) paintPerf(history[history.length - 1] ?? 0);
      else paintApps();
    };
    on(tabApps, 'click', () => show(false), app.signal);
    on(tabPerf, 'click', () => show(true), app.signal);
    on(app.root, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Delete' && chosen && !appsPane.hidden) endBtn.click();
    }, app.signal);
    paintApps();
  },
};
