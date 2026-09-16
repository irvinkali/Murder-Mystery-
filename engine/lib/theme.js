'use strict';
/*
 * The loaded pack's presentation file: packs/<id>/theme.json.
 *
 * Presentation only — colours, type, and how the narrator should sound. There
 * is no plot in it, which is why it is the one plaintext file allowed to sit
 * beside an encoded bible, and why it is safe to serve without a party code.
 *
 * Shared by functions/theme.js (which turns `vars` and `css` into a stylesheet)
 * and functions/kit.js (which hands `voice` to the room screen).
 */

const fs = require('fs');
const path = require('path');
const { loadRuntimePack } = require('./runtime');

const PACKS = path.join(__dirname, '..', '..', 'packs');

/** Which pack folder is live: the env override, else the loaded pack's id. */
function packId() {
  if (process.env.MYSTERY_PACK) return process.env.MYSTERY_PACK;
  try { return loadRuntimePack().id || null; } catch (_) { return null; }
}

/** The live pack's theme, or null when it has not authored one. */
function loadTheme(id) {
  const dir = id || packId();
  if (!dir || !/^[a-z0-9._-]+$/i.test(dir)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PACKS, dir, 'theme.json'), 'utf8')); }
  catch (_) { return null; }
}

/* The room screen reads every phase beat aloud through the browser's own
 * speech synthesis, so the voice it picks is the voice of the evening. A pack
 * says which voices suit it; the engine's own fallback is deliberately neutral.
 *
 *  prefer    voice names or language tags, best first — the first one this
 *            device actually has installed wins
 *  rate      speaking speed, 1 is the voice's natural pace
 *  pitch     1 is natural; below 1 reads lower and more formal
 *  audition  the line spoken when the host tries a voice from the picker
 */
function voiceConfig(theme) {
  const v = (theme && theme.voice) || {};
  const prefer = Array.isArray(v.prefer) ? v.prefer.filter((s) => typeof s === 'string').slice(0, 12) : [];
  const num = (x, lo, hi, dflt) => (typeof x === 'number' && x >= lo && x <= hi ? x : dflt);
  return {
    prefer,
    rate: num(v.rate, 0.5, 2, 1),
    pitch: num(v.pitch, 0.5, 2, 1),
    audition: typeof v.audition === 'string' ? v.audition.slice(0, 200) : '',
  };
}

/* The room screen fills silence with a generative pad when a pack has no
 * ambient audio files. That suits a gallery and does not suit a reunion, where
 * the room has its own music playing and the pad reads as a hum behind the
 * narration. A pack that wants silence says so.
 *
 *  pad   false turns the generative soundscape off for this pack
 */
function ambientConfig(theme) {
  const a = (theme && theme.ambient) || {};
  return { pad: a.pad !== false };
}

module.exports = { packId, loadTheme, voiceConfig, ambientConfig };
