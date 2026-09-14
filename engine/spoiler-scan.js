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
 * Usage: node engine/spoiler-scan.js [--show] [--pack <pack.json.b64>]
 *        (or set MYSTERY_PACK_FILE; scans whichever pack is loaded)
 * Exit:  0 clean · 1 leak found · 2 error
 */

const fs = require('fs');
const path = require('path');

// --pack is a convenience for MYSTERY_PACK_FILE, so a pack can be scanned
// without touching git. Set before requiring the runtime, which caches by path.
{
  const i = process.argv.indexOf('--pack');
  if (i !== -1 && process.argv[i + 1]) process.env.MYSTERY_PACK_FILE = path.resolve(process.argv[i + 1]);
}
const { loadRuntimePack } = require('./lib/runtime');

const SHOW = process.argv.includes('--show');
const REPO = path.join(__dirname, '..');

// Words that are safe even though they are capitalized in names (titles, etc.).
const SAFE_TOKENS = new Set(['Dr', 'The', 'No', 'A', 'Of', 'At', 'Rest']);

// Text of the Kali-facing (safe) docs: the project state, the readme, and EVERY
// host doc under docs/ — which is where each pack's own props guide lives. A
// name token that already appears there is not a NEW leak, because the host is
// meant to read it (e.g. a venue name printed on a props guide that also
// happens to collide with a character surname). Enumerated, not listed, so a
// third pack's host docs are covered the moment they are added.
function safeCorpusFiles() {
  const files = ['STATE.md', 'README.md'];
  const docs = path.join(REPO, 'docs');
  try {
    for (const f of fs.readdirSync(docs).sort()) {
      if (f.toLowerCase().endsWith('.md')) files.push(path.join('docs', f));
    }
  } catch (_) { /* no docs dir */ }
  return files;
}
function safeCorpus() {
  let txt = '';
  for (const f of safeCorpusFiles()) {
    try { txt += '\n' + fs.readFileSync(path.join(REPO, f), 'utf8'); } catch (_) { /* ignore */ }
  }
  return txt.toLowerCase();
}

const publicTokens = new Set(); // name tokens the host docs already expose

function sensitiveTokens(pack) {
  const safe = safeCorpus();
  const tokens = new Set();
  const add = (name) => {
    if (!name) return;
    for (const w of String(name).split(/[^A-Za-z]+/)) {
      if (w.length < 3 || SAFE_TOKENS.has(w)) continue;
      if (new RegExp('\\b' + w.toLowerCase() + '\\b').test(safe)) { publicTokens.add(w); continue; } // already public
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

// Walk the working tree rather than asking git, so a pack that has not been
// committed yet is still scanned (and nothing has to be staged to check it).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.netlify', 'dist', 'coverage']);
const TEXTLIKE = /\.(md|js|mjs|cjs|json|html|css|txt|yml|yaml|toml|svg|sh)$/i;

function scannableFiles(dir, rel, out) {
  const base = dir || REPO;
  const prefix = rel || '';
  const acc = out || [];
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.gitignore') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const relPath = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) { scannableFiles(path.join(base, e.name), relPath, acc); continue; }
    if (!e.isFile()) continue;
    if (relPath.endsWith('.b64')) continue;      // radioactive files may hold plot
    if (!TEXTLIKE.test(relPath)) continue;       // binaries can't leak a name legibly
    acc.push(relPath);
  }
  return acc;
}

function mask(tok) {
  return SHOW ? tok : tok[0] + '•'.repeat(Math.max(1, tok.length - 1));
}

function main() {
  const pack = loadRuntimePack();
  const tokens = sensitiveTokens(pack);
  const phrases = sensitivePhrases(pack);
  const files = scannableFiles();
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

  console.log(`\nSpoiler scan — pack ${pack.id || '(unnamed)'}: ${tokens.length} names + ${phrases.length} flex names × ${files.length} working-tree files (excluding *.b64)`);
  if (publicTokens.size) {
    console.log(`  (${publicTokens.size} name token${publicTokens.size === 1 ? '' : 's'} skipped as already public in STATE.md / README.md / docs/*.md)`);
  }
  if (res.length === 0) {
    console.log('\x1b[32m✓ CLEAN — no plot names found in any Kali-readable file\x1b[0m\n');
    process.exit(0);
  }
  console.log('\x1b[31m✗ LEAK — plot names found in Kali-readable files:\x1b[0m');
  for (const r of res) console.log(`   ${r.file}  ←  ${mask(r.tok)}`);
  console.log(SHOW ? '' : '\n(run with --show to unmask while fixing)\n');
  process.exit(1);
}

try { main(); } catch (e) { console.error('scan error:', e.message); process.exit(2); }
