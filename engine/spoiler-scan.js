#!/usr/bin/env node
'use strict';
/*
 * Spoiler-leak scanner.
 *
 * Derives the sensitive proper nouns (victim + character names) from the pack
 * in memory, then scans every git-tracked file EXCEPT the radioactive *.b64
 * pack files for any occurrence. Any hit means plot content leaked into a
 * Kali-readable file — a protocol violation.
 *
 * By default it MASKS the offending token in output (first letter + length) so
 * running the scanner itself never prints a name. Pass --show to unmask (use
 * only in a private context while fixing a leak).
 *
 * Usage: node engine/spoiler-scan.js [--show]
 * Exit:  0 clean · 1 leak found · 2 error
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadRuntimePack } = require('./lib/runtime');

const SHOW = process.argv.includes('--show');
const REPO = path.join(__dirname, '..');

// Words that are safe even though they are capitalized in names (titles, etc.).
const SAFE_TOKENS = new Set(['Dr', 'The', 'No', 'A', 'Of', 'At', 'Rest']);

// Text of the known Kali-facing (safe) docs. A name token that already appears
// here is not a NEW leak — most importantly the venue "Noir" collides with a
// character surname, but the venue is public (it is printed in the props guide).
function safeCorpus() {
  const files = ['STATE.md', 'README.md', 'docs/last-exhibit-props-guide.md', 'docs/design-doc.md'];
  let txt = '';
  for (const f of files) {
    try { txt += '\n' + fs.readFileSync(path.join(REPO, f), 'utf8'); } catch (_) { /* ignore */ }
  }
  return txt.toLowerCase();
}

function sensitiveTokens(pack) {
  const safe = safeCorpus();
  const tokens = new Set();
  const add = (name) => {
    if (!name) return;
    for (const w of String(name).split(/[^A-Za-z]+/)) {
      if (w.length < 3 || SAFE_TOKENS.has(w)) continue;
      if (new RegExp('\\b' + w.toLowerCase() + '\\b').test(safe)) continue; // already public
      tokens.add(w);
    }
  };
  for (const c of pack.cast) add(c.name);
  // Victim: first bold token in the victim section.
  const vm = (pack.victim || '').match(/\*\*([^*]+)\*\*/);
  if (vm) add(vm[1]);
  return [...tokens];
}

// Flex names are checked as FULL-NAME phrases (not single tokens), so common
// words inside them — "Dev", "June", "Park" — never false-positive on code.
function sensitivePhrases(pack) {
  const safe = safeCorpus();
  return (pack.flex || [])
    .map((f) => f.name)
    .filter((n) => n && /\s/.test(n))
    .filter((n) => !safe.includes(n.toLowerCase()));
}

function trackedFiles() {
  const out = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !f.endsWith('.b64')); // radioactive files are allowed to hold plot
}

function mask(tok) {
  return SHOW ? tok : tok[0] + '•'.repeat(Math.max(1, tok.length - 1));
}

function main() {
  const pack = loadRuntimePack();
  const tokens = sensitiveTokens(pack);
  const phrases = sensitivePhrases(pack);
  const files = trackedFiles();
  const res = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch (_) { continue; }
    for (const tok of tokens) {
      if (new RegExp('\\b' + tok + '\\b').test(text)) res.push({ file: f, tok });
    }
    for (const ph of phrases) {
      if (new RegExp('\\b' + esc(ph) + '\\b').test(text)) res.push({ file: f, tok: ph });
    }
  }

  console.log(`\nSpoiler scan — ${tokens.length} names + ${phrases.length} flex names × ${files.length} tracked files (excluding *.b64)`);
  if (res.length === 0) {
    console.log('\x1b[32m✓ CLEAN — no plot names found in any Kali-readable file\x1b[0m\n');
    process.exit(0);
  }
  console.log('\x1b[31m✗ LEAK — plot names found in committed files:\x1b[0m');
  for (const r of res) console.log(`   ${r.file}  ←  ${mask(r.tok)}`);
  console.log(SHOW ? '' : '\n(run with --show to unmask while fixing)\n');
  process.exit(1);
}

try { main(); } catch (e) { console.error('scan error:', e.message); process.exit(2); }
