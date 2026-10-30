// The owner's own password (and two-step code, or a recovery code) asked for in a dialog before an action that reaches
// beyond their own account: deleting a store app from the server, installing a System update, going back to the earlier
// version. The server asks for it (confirm_identity in server/lib/auth.php), as it does for adding a person, so someone
// at the owner's unlocked, unattended desktop cannot do these.
import { h } from '../core/dom.ts';
import type { Shell } from '../shell/types.ts';
import { passwordField } from './gate.ts';

export interface Identity {
  password: string;
  code: string;
}

/**
 * Asks for the signed-in person's password (and code, when two-step is on) under `title`, with `text` saying what it is
 * for and `ok` on the button that goes ahead. Resolves null when they cancel, or when nobody is signed in.
 */
export async function askIdentity(shell: Shell, options: { title: string; text: string; ok: string; danger?: boolean; signal: AbortSignal }): Promise<Identity | null> {
  const user = shell.account?.user();
  if (!user) return null;
  const pass = passwordField({ label: 'Your password', autocomplete: 'current-password', signal: options.signal });
  const code = h('input', { type: 'text', class: 'field', autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', maxlength: 14 });
  const body = h('div', {},
    h('p', { class: 'hint' }, 'Your password confirms that it is you asking, and not someone at your desk while you were away.'),
    pass.row,
    ...(user.totp ? [h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code from your authenticator, or a recovery code'), code)] : []));
  const go = await shell.dialogs.ask<boolean>({
    title: options.title,
    text: options.text,
    body,
    buttons: [
      { label: options.ok, value: true, primary: !options.danger, danger: options.danger },
      { label: 'Cancel', value: false, primary: options.danger },
    ],
    cancel: false,
    primaryEnabled: () => pass.input.value !== '',
    focus: () => pass.input,
  });
  return go ? { password: pass.input.value, code: code.value.trim() } : null;
}
