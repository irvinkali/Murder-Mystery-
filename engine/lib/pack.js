'use strict';
/*
 * Pack loader/parser for the Mystery Engine.
 *
 * SPOILER PROTOCOL: this module decodes a radioactive `*.b64` plot bible ONLY
 * into memory and returns a structured object. It NEVER writes decoded content
 * to disk, stdout, or logs. Callers that emit anything human-readable are
 * responsible for keeping plot content out of their output. There are no plot
 * strings hard-coded here — everything is derived from the encoded input by
 * generic pattern matching, so this file is safe to read and commit.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARROW = '→'; // →

/** Decode a base64 pack file into a UTF-8 string held only in memory. */
function decodeBible(b64Path) {
  const b64 = fs.readFileSync(b64Path, 'utf8');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** Split the document into `## N. TITLE` sections. */
function splitSections(text) {
  const re = /^##\s+(\d+)\.\s+(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ num: Number(m[1]), title: m[2].trim(), start: m.index, bodyStart: re.lastIndex });
  }
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out[marks[i].num] = { title: marks[i].title, body: text.slice(marks[i].bodyStart, end) };
  }
  return out;
}

/**
 * Parse a roster of characters whose ids share a letter prefix. Used for the
 * core cast (`C`) and, when authored, flex characters (`F`). Each entry:
 * `**<L><n>. Name** ...persona/secret... [PIECE No. <k>]`.
 * `brief` is the character's private dossier — served ONLY to the player who
 * holds that character, never to others, and never as part of the solution.
 */
function parseRoster(sectionBody, letter) {
  const out = [];
  if (!sectionBody) return out;
  const entryRe = new RegExp('\\*\\*(' + letter + '\\d+)\\.\\s*([^*]+?)\\*\\*', 'g');
  const marks = [];
  let m;
  while ((m = entryRe.exec(sectionBody)) !== null) {
    marks.push({ id: m[1], name: m[2].trim(), at: m.index, after: entryRe.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : sectionBody.length;
    const chunk = sectionBody.slice(marks[i].after, end).trim();
    const piece = chunk.match(/PIECE\s+No\.\s+(\d+)/i);
    out.push({ id: marks[i].id, name: marks[i].name, piece: piece ? Number(piece[1]) : null, brief: chunk });
  }
  return out;
}

function parseCast(sectionBody) {
  return parseRoster(sectionBody, 'C');
}

/**
 * Load flex characters from an optional radioactive file, if present. Returns
 * [] when the file does not exist yet (flex are additive and never
 * load-bearing, so the pack is valid without them). Decodes in memory only.
 */
function loadFlex(flexB64Path) {
  if (!flexB64Path || !fs.existsSync(flexB64Path)) return [];
  const text = Buffer.from(fs.readFileSync(flexB64Path, 'utf8'), 'base64').toString('utf8');
  return parseRoster(text, 'F');
}

/** Find any flex characters (**F<n>. ...**) anywhere in the document. */
function parseFlex(text) {
  const ids = new Set();
  let m;
  const re = /\*\*(F\d+)\.\s*[^*]+\*\*/g;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

/**
 * Pull the value of a `**Label:** value` field out of a variant block. Stops at
 * the next line-level bullet, the next section, OR the next inline bold label
 * (e.g. "Genuine props" and "Herrings emphasized" can share one line).
 */
function bulletValue(block, label) {
  const re = new RegExp(
    '\\*\\*' + label + ':\\*\\*\\s*([\\s\\S]*?)(?=\\n-\\s+\\*\\*|\\n###|\\n##|\\*\\*[A-Z][^*\\n]{0,40}:\\*\\*|$)',
    'i');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

/** Extract P<n> tokens from a fragment, de-duplicated, in order. */
function propTokens(fragment) {
  if (!fragment) return [];
  const seen = [];
  let m;
  const re = /\bP([1-9]\d*)\b/g;
  while ((m = re.exec(fragment)) !== null) {
    const id = 'P' + m[1];
    if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Parse the six-step evidence chain E1..E6 from the "Evidence chain" bullet. */
function parseEvidenceChain(evidenceText) {
  if (!evidenceText) return { steps: [], keystoneStep: null };
  const segments = evidenceText.split(ARROW).map((s) => s.trim()).filter(Boolean);
  const steps = [];
  let keystoneStep = null;
  for (const seg of segments) {
    const mm = seg.match(/\bE([1-6])\b/);
    if (!mm) continue;
    const n = Number(mm[1]);
    const isKeystone = /KEYSTONE/i.test(seg);
    steps.push({ n, isKeystone, text: seg });
    if (isKeystone) keystoneStep = n;
  }
  return { steps, keystoneStep };
}

/** Parse the four solution variants. */
function parseVariants(sectionBody) {
  const headRe = /^###\s+VARIANT\s+([A-Z])\b[\s\S]*?Killer:\s*([^\n]+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = headRe.exec(sectionBody)) !== null) {
    marks.push({ letter: m[1], killer: m[2].trim(), at: m.index, after: headRe.lastIndex });
  }
  const variants = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : sectionBody.length;
    const block = sectionBody.slice(marks[i].after, end);
    const evidence = bulletValue(block, 'Evidence chain');
    const genuineRaw = bulletValue(block, 'Genuine props');
    variants.push({
      letter: marks[i].letter,
      killer: marks[i].killer,
      motive: bulletValue(block, 'Motive'),
      method: bulletValue(block, 'Method'),
      voices: bulletValue(block, 'Voices at 6:40'),
      evidence: parseEvidenceChain(evidence),
      genuineProps: propTokens(genuineRaw),
      herrings: propTokens(bulletValue(block, 'Herrings emphasized')),
    });
  }
  return variants;
}

/** Parse the prop-meaning matrix (markdown table) into {prop: {A,B,C,D: kind}}. */
function parseMatrix(sectionBody) {
  const rows = sectionBody.split('\n').filter((l) => /^\|/.test(l.trim()));
  const matrix = {};
  const cols = ['A', 'B', 'C', 'D'];
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    // cells[0] is '' (leading pipe). cells[1] = prop label, cells[2..5] = A..D.
    const propCell = cells[1] || '';
    const pm = propCell.match(/\bP([1-7])\b/);
    if (!pm) continue; // skip header / separator rows
    const prop = 'P' + pm[1];
    matrix[prop] = {};
    for (let c = 0; c < 4; c++) {
      const cell = cells[2 + c] || '';
      matrix[prop][cols[c]] = classifyCell(cell);
    }
  }
  return matrix;
}

function classifyCell(cell) {
  if (/KEYSTONE/i.test(cell)) return 'keystone';
  if (/GENUINE/i.test(cell)) return 'genuine';
  if (/herring/i.test(cell)) return 'herring';
  return 'unknown';
}

/** Count numbered fairness rules in section 7. */
function parseFairnessRules(sectionBody) {
  const lines = sectionBody.split('\n');
  const rules = [];
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)\.\s+(.*\S)\s*$/);
    if (m) rules.push({ n: Number(m[1]), text: m[2] });
  }
  return rules;
}

/**
 * Parse the branching-consequences document into structured data the resolver
 * consumes. Pure structure — no plot literals here; the drop text is carried
 * through from the (radioactive) source and only ever surfaces to players in
 * game, never to the terminal.
 */
function parseBranching(text) {
  if (!text) return null;
  const t = text.replace(/[“”]/g, '"'); // normalize curly quotes
  const body = (kw) => {
    const m = t.match(new RegExp('##\\s+\\d+\\.\\s+[^\\n]*' + kw + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+\\d+\\.|$)', 'i'));
    return m ? m[1] : '';
  };

  // §1 Defense drops — per core character: a default line and an optional
  // "killer, complicating" line tied to a specific variant.
  const defBody = body('DEFENSE');
  const targets = {};
  const blockRe = /\*\*C(\d+)\s+[^*]*\*\*([\s\S]*?)(?=\*\*C\d+\s|\n##|$)/g;
  let m;
  while ((m = blockRe.exec(defBody)) !== null) {
    const id = 'C' + m[1];
    const blk = m[2];
    const def = blk.match(/Default[^:]*:\s*"([^"]*)"/i);
    const comp = blk.match(/Variant\s+([A-D])\s*\(killer,\s*complicating\):\s*"([^"]*)"/i);
    targets[id] = { default: def ? def[1] : null, complicating: comp ? { variant: comp[1], text: comp[2] } : null };
  }

  // §2 Alibi contradiction flag — per variant, one target character + drop.
  const aliBody = body('ALIBI');
  const alibi = {};
  const aliRe = /\*\*Variant\s+([A-D])\s*→\s*C(\d+)[^:]*:\*\*\s*"([^"]*)"/g;
  while ((m = aliRe.exec(aliBody)) !== null) alibi[m[1]] = { charId: 'C' + m[2], text: m[3] };

  // §3 Medical files reveal — per variant, a FULL and a PARTIAL text.
  const medBody = body('MEDICAL');
  const medical = {};
  const medRe = /\*\*Variant\s+([A-D])\s*—\s*FULL:\*\*\s*"([^"]*)"\s*—\s*PARTIAL:\s*"([^"]*)"/g;
  while ((m = medRe.exec(medBody)) !== null) medical[m[1]] = { full: m[2], partial: m[3] };

  return { defense: { targets }, alibi, medical };
}

/** Load branching data from an optional radioactive file (in memory only). */
function loadBranching(b64Path) {
  if (!b64Path || !fs.existsSync(b64Path)) return null;
  const text = Buffer.from(fs.readFileSync(b64Path, 'utf8'), 'base64').toString('utf8');
  return parseBranching(text);
}

/**
 * Load and parse a pack bible into a structured object.
 * @param {string} b64Path path to the radioactive *.b64 bible
 */
function loadPack(b64Path) {
  const text = decodeBible(b64Path);
  const sections = splitSections(text);
  const findSection = (kw) => {
    for (const k of Object.keys(sections)) {
      if (new RegExp(kw, 'i').test(sections[k].title)) return sections[k].body;
    }
    return '';
  };

  // Use keywords unique to each section title. Note "NIGHT-OF TIMELINE (...,
  // ALL VARIANTS)" also contains "VARIANT", so match the solutions section on
  // "SOLUTION" specifically.
  const cast = parseCast(findSection('CAST'));
  const variants = parseVariants(findSection('SOLUTION'));
  const matrix = parseMatrix(findSection('MATRIX'));
  const fairnessRules = parseFairnessRules(findSection('FAIRNESS'));
  // Flex characters live in an optional sibling file; [] until authored.
  const flexPath = path.join(path.dirname(b64Path), 'flex-characters.md.b64');
  const flexFromFile = loadFlex(flexPath);
  const flex = flexFromFile.length ? flexFromFile : parseFlex(text).map((id) => ({ id }));

  // Branching consequences live in an optional sibling file; null until authored.
  const branchingData = loadBranching(path.join(path.dirname(b64Path), 'branching.md.b64'));

  // Distinct prop ids referenced by the matrix.
  const props = Object.keys(matrix).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

  return {
    checksum: md5(text),
    byteLength: Buffer.byteLength(text, 'utf8'),
    victim: findSection('VICTIM').trim(),
    timeline: findSection('TIMELINE').trim(),
    cast,
    flex,
    variants,
    props,
    matrix,
    fairnessRules,
    branching: findSection('BRANCH').trim(),
    branchingData,
  };
}

module.exports = {
  loadPack,
  decodeBible,
  loadFlex,
  loadBranching,
  parseBranching,
  parseRoster,
  md5,
  // exported for unit-level reuse if ever needed
  _internal: { splitSections, parseCast, parseRoster, parseVariants, parseMatrix, parseEvidenceChain },
  DEFAULT_BIBLE: path.join(__dirname, '..', '..', 'packs', 'last-exhibit', 'plot-bible.md.b64'),
};
