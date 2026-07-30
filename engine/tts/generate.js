#!/usr/bin/env node
'use strict';
/*
 * Narration TTS generator.
 *
 * Renders EVERY gallery narration line (phase cards incl. the discovery/
 * unveiling, [SCREEN] find-hints, the medical announcement, and each variant's
 * full Phase-6 reveal) to an opaque-named mp3, using edge-tts with a calm,
 * low, slightly formal "gallery docent" voice.
 *
 * SPOILER-SAFE:
 *  - The narration text is never printed. Each line is written to a temp file
 *    that is deleted immediately after synthesis.
 *  - Output filenames are sha256 hashes of a logical key — they reveal nothing,
 *    so the spoiler scanner stays clean.
 *  - Output goes to engine/public/assets/narration/, which is git-ignored, so
 *    reveal audio (which speaks the killer) is never committed.
 *
 * Usage:
 *   node engine/tts/generate.js                 # real pack
 *   MYSTERY_PACK_FILE=packs/test/pack.json \
 *     node engine/tts/generate.js               # dummy pack (safe rehearsal audio)
 *   NARRATION_VOICE="en-GB-RyanNeural" node engine/tts/generate.js
 *   node engine/tts/generate.js --force         # re-render existing files
 *
 * Requires edge-tts:  pip install edge-tts   (needs network at generation time)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadRuntimePack } = require('../lib/runtime');
const { narrationInventory } = require('../lib/phases');
const { audioName } = require('../lib/runtime');

const OUT = path.join(__dirname, '..', 'public', 'assets', 'narration');
const VOICE = process.env.NARRATION_VOICE || 'en-US-RogerNeural'; // mature, calm, formal
const RATE = process.env.NARRATION_RATE || '-8%';
const PITCH = process.env.NARRATION_PITCH || '-4Hz';
const FORCE = process.argv.includes('--force');

function haveEdgeTts() {
  try { execFileSync('edge-tts', ['--list-voices'], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function synth(text, outFile) {
  const tmp = path.join(os.tmpdir(), 'narr-' + Math.abs(hash(outFile)) + '.txt');
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    execFileSync('edge-tts', ['--voice', VOICE, '--rate=' + RATE, '--pitch=' + PITCH, '--file', tmp, '--write-media', outFile], { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pack = loadRuntimePack();
  const items = narrationInventory(pack);
  const packId = pack.id || 'pack';

  if (!haveEdgeTts()) {
    console.error('edge-tts not found. Install it first:  pip install edge-tts');
    console.error(`Would render ${items.length} narration files for pack "${packId}" into ${path.relative(process.cwd(), OUT)}/`);
    process.exit(3);
  }

  let written = 0, skipped = 0, failed = 0;
  for (const it of items) {
    const file = path.join(OUT, audioName(it.key));
    if (!FORCE && fs.existsSync(file)) { skipped++; continue; }
    try {
      synth(it.text, file);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error('empty output');
      written++;
    } catch (e) {
      failed++;
      try { fs.unlinkSync(file); } catch (_) { /* leave no broken/empty file → clean fallback */ }
      console.error('  failed:', it.key);
    }
  }
  // Counts only — never the narration text.
  console.log(`Narration TTS for pack "${packId}" (voice ${VOICE}):`);
  console.log(`  items ${items.length} · written ${written} · skipped ${skipped} · failed ${failed}`);
  console.log(`  output: ${path.relative(process.cwd(), OUT)}/  (git-ignored)`);
  process.exit(failed ? 1 : 0);
}

main();
