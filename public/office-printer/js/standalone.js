// The stand-alone page: the game fills the page, Ctrl+P (or Cmd+P) prints, and endings are kept in this browser.
// ?speed=4 plays everything four times faster (up to 50), for testing.
import { mountGame } from './game.js';
import { browserStore } from './storage.js';

const host = document.getElementById('office-printer');
const speed = Number(new URLSearchParams(location.search).get('speed')) || 1;

mountGame(host, { storage: browserStore, ownPrintKey: true, speed }).catch(error => {
  host.textContent = `Office Printer could not start (${error.message}). Reload the page to try again.`;
});
