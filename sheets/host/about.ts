// Help > About: the program's name, version, who makes it and its licence, with the way to every other licence.
import { h } from '../../src/core/dom.ts';
import type { DialogLayer } from '../../src/shell/dialogs.ts';
import { showLicences } from './licences.ts';
import { tauri } from './tauri.ts';

export const PRODUCT = 'TOMLIN Sheets';

export async function appVersion(): Promise<string> {
  try {
    return tauri ? await tauri.app.getVersion() : 'preview';
  } catch {
    return 'unknown';
  }
}

export async function showAbout(dialogs: DialogLayer): Promise<void> {
  const version = await appVersion();
  const body = h('div', { class: 'about' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-logo', src: 'icon.png', alt: '', width: 56, height: 56 }),
      h('div', {}, h('p', { class: 'about-name' }, PRODUCT), h('p', { class: 'about-version' }, `Version ${version} (64-bit)`))),
    h('p', { class: 'dialog-text' }, 'Spreadsheets for Windows: Excel workbooks (.xlsx), CSV files and its own .sheet files, with formulas, tables, PivotTables, charts, conditional formatting, printing and PDF.'),
    h('p', { class: 'dialog-detail' }, '© 2026 TOMLIN OS. Free for non-commercial use under the PolyForm Noncommercial License 1.0.0. Built with open-source parts, each under its own licence (Licences, below), and shown through Microsoft Edge WebView2, which is part of Windows.'),
    h('p', { class: 'dialog-detail' }, 'Excel is a trademark of Microsoft Corporation. TOMLIN Sheets is not made by or connected with Microsoft.'),
  );
  const answer = await dialogs.ask<'ok' | 'licences'>({ title: `About ${PRODUCT}`, body, buttons: [{ label: 'Licences', value: 'licences' }, { label: 'OK', value: 'ok', primary: true }], cancel: 'ok' });
  if (answer === 'licences') await showLicences(dialogs);
}
