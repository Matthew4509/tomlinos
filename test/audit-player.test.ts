// Audit of what the Player relies on before it plays a file (src/apps/media.ts and src/shell/filetypes.ts), without a
// browser. The browser half is test/browser-audit-player.mjs. Tests marked todo are P1 findings.
// Run: node --test test/audit-player.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaTypeOf } from '../src/apps/media.ts';
import { fileTypeOf } from '../src/shell/filetypes.ts';

const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus'];
const VIDEO = ['mp4', 'webm', 'm4v', 'mov', 'ogv'];

test('every file kind File Explorer sends to the Player has an audio or video type', () => {
  for (const ext of [...AUDIO, ...VIDEO]) {
    const name = `song.${ext}`;
    assert.ok(fileTypeOf(name).apps.includes('player'), `${ext} opens in the Player`);
    const type = mediaTypeOf(name);
    assert.ok(type && /^(audio|video)\//.test(type), `${ext} -> ${type}`);
    assert.equal(type!.startsWith('video/'), VIDEO.includes(ext), `${ext} is shown as ${VIDEO.includes(ext) ? 'video' : 'music'}`);
  }
});

test('upper-case extensions play too', () => {
  assert.equal(mediaTypeOf('TRACK.MP3'), 'audio/mpeg');
  assert.equal(mediaTypeOf('Clip.WebM'), 'video/webm');
});

// MP-P1: no subtitle files. A .vtt or .srt next to a video is not offered; both are "File" with no app.
test('subtitle files (.vtt, .srt) are known, so a video can show them', { todo: 'P1' }, () => {
  assert.notEqual(fileTypeOf('film.vtt').apps.length, 0);
  assert.notEqual(fileTypeOf('film.srt').apps.length, 0);
});

// MP-P1: common audio and video kinds a player user expects are not listed at all, so they open in nothing
// (Chrome plays .mka/.mkv with VP9/Opus, and .weba is WebM audio).
test('WebM audio (.weba) and Matroska (.mkv, .mka) open in the Player', { todo: 'P1' }, () => {
  for (const name of ['a.weba', 'a.mka', 'a.mkv']) assert.ok(fileTypeOf(name).apps.includes('player'), name);
});

// MP-P1: no playlists. An .m3u/.m3u8 (the usual playlist file) is "File" with no app.
test('a playlist file (.m3u, .m3u8) opens in the Player', { todo: 'P1' }, () => {
  for (const name of ['list.m3u', 'list.m3u8']) assert.ok(fileTypeOf(name).apps.includes('player'), name);
});
