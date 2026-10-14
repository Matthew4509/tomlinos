// About TOMLIN OS: the version, and Credits for every outside piece that ships with it (its author, licence and where it
// comes from). The MIT licence asks for its notice to travel with the code; the full texts are in public/vendor and
// open from here. The list of bundled packages is read from the file the vendor build writes, so it cannot drift.
import { h, on } from '../core/dom.ts';
import { readLocalJson, readLocalText } from '../core/local.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

interface Credit {
  name: string;
  what: string;
  author: string;
  licence: string;
  home: string;
  /** Written by the vendor build: [{ name, version, license }]. */
  packages?: string;
  /** The full licence texts, served beside the bundle. */
  texts?: string;
}

export const CREDITS: Credit[] = [
  {
    name: 'CodeMirror 6 and Lezer',
    what: 'The text editor inside Notepad Pro, its colouring for each language, and the Markdown reader behind its preview.',
    author: 'Marijn Haverbeke and contributors',
    licence: 'MIT',
    home: 'https://codemirror.net/',
    packages: 'vendor/codemirror-packages.json',
    texts: 'vendor/codemirror-LICENSES.txt',
  },
  {
    name: 'ProseMirror',
    what: 'The editor inside TOMLIN Write: typing, formatting, lists, tables, undo, and reading pasted text.',
    author: 'Marijn Haverbeke and contributors',
    licence: 'MIT',
    home: 'https://prosemirror.net/',
    packages: 'vendor/prosemirror-packages.json',
    texts: 'vendor/prosemirror-LICENSES.txt',
  },
  {
    name: 'WebLLM',
    what: "Runs the built-in AI (Chat › Agents) on this device's graphics chip.",
    author: 'The MLC team (Carnegie Mellon University and contributors)',
    licence: 'Apache-2.0',
    home: 'https://github.com/mlc-ai/web-llm',
    packages: 'vendor/webllm-packages.json',
    texts: 'vendor/webllm-LICENSE.txt',
  },
  {
    name: 'Claude library for PHP, with Guzzle',
    what: "Connects Chat › Agents to Claude with a person's own API key. It runs on the server; none of it reaches the browser.",
    author: 'Anthropic (the official library); Guzzle by Michael Dowling and contributors; helper packages by their authors',
    licence: 'MIT (one helper package carries an Apache-2.0 licence file)',
    home: 'https://github.com/anthropics/anthropic-sdk-php',
    packages: 'vendor/claude-php-packages.json',
    texts: 'vendor/claude-php-LICENSES.txt',
  },
];

/** The built-in AI models' own licences (checked on Hugging Face, September 2026). */
export const MODEL_LICENCES: Record<string, string> = {
  'Qwen3.5-0.8B-q4f32_1-MLC': 'Qwen 3.5 0.8B by the Qwen team (Alibaba Cloud), Apache-2.0',
  // Google's terms ask that anyone passing Gemma on says so, with the terms' address.
  'gemma-2-2b-it-q4f32_1-MLC': 'Gemma 2 2B by Google. Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms',
  'Qwen3.5-4B-q4f32_1-MLC': 'Qwen 3.5 4B by the Qwen team (Alibaba Cloud), Apache-2.0',
};

export const aboutApp: AppDef = {
  ...APPS.about,
  async launch(app) {
    app.root.classList.add('about');
    let version = '';
    try {
      version = (await readLocalJson<{ version?: string }>('version.json')).version ?? '';
    } catch {
      // A copy without the file still shows its credits.
    }
    const list = h('div', { class: 'about-credits' });
    app.root.append(
      h('div', { class: 'about-head' }, h('h1', {}, 'TOMLIN OS'), h('p', {}, version ? `Version ${version}` : 'Version not known')),
      h('p', { class: 'about-lead' }, 'A private desktop in the browser. The desktop and its apps are this project\'s own code. These outside pieces ship with it, with thanks:'),
      list,
    );
    // The built-in AI models, each with its maker and licence: always listed, since a browser fetches one from Hugging
    // Face whether or not it is saved on this TOMLIN OS.
    list.append(h('section', { class: 'about-credit' }, h('h2', {}, 'Built-in AI models'),
      h('p', {}, "Converted for WebLLM by the MLC team; each keeps its maker's licence. A model is downloaded from Hugging Face, or from this TOMLIN OS when the owner saved it here."),
      h('ul', { class: 'about-pkgs' }, ...Object.values(MODEL_LICENCES).map(text => h('li', {}, text)))));
    for (const c of CREDITS) {
      const pkgs = h('ul', { class: 'about-pkgs' });
      const textBtn = c.texts ? h('button', { type: 'button', class: 'tool wide' }, 'Show the licence texts') : null;
      const textBox = h('pre', { class: 'about-text', hidden: true });
      list.append(h('section', { class: 'about-credit' },
        h('h2', {}, c.name),
        h('p', {}, c.what),
        h('p', { class: 'about-meta' }, `By ${c.author}. Licence: ${c.licence}. `, h('a', { href: c.home, target: '_blank', rel: 'noopener noreferrer' }, c.home)),
        pkgs, textBtn, textBox));
      if (c.packages) {
        try {
          const rows = await readLocalJson<Array<{ name: string; version: string; license: string }>>(c.packages);
          pkgs.append(...rows.map(p => h('li', {}, `${p.name} ${p.version} (${p.license})`)));
        } catch {
          pkgs.append(h('li', {}, 'The package list could not be read.'));
        }
      }
      if (textBtn && c.texts) {
        on(textBtn, 'click', async () => {
          if (textBox.hidden && !textBox.textContent) {
            try {
              textBox.textContent = await readLocalText(c.texts!);
            } catch {
              textBox.textContent = 'The licence texts could not be read.';
            }
          }
          textBox.hidden = !textBox.hidden;
          textBtn.textContent = textBox.hidden ? 'Show the licence texts' : 'Hide the licence texts';
        }, app.signal);
      }
    }
  },
};
