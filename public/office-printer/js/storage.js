// Where the stand-alone page keeps your endings: this browser's localStorage. Some browsers refuse it (private
// windows, blocked site data); then the game still plays and simply forgets when the page closes.
// TOMLIN OS does not use this file: it keeps the same data in your own files (/System/office-printer.json).

const KEY = 'office-printer';

export const browserStore = {
  async load() {
    try {
      const text = window.localStorage.getItem(KEY);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  },
  async save(data) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      // Not saved; the game carries on.
    }
  },
};
