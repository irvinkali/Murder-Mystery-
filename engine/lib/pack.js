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
  const medRe = /\*\*Variant\s+([A-D])\s*[|—]\s*FULL:\*\*\s*"([^"]*)"\s*[|—]\s*PARTIAL:\s*"([^"]*)"/g;
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
 * Parse the per-phase script lines + escalating find-hints + fairness
 * disclosure. Pure structure — no plot literals; text flows from the source.
 *
 * A bullet is `- PH3 QUOTE: "..." | PROMPT: ...`. An optional `+N` on the phase
 * marker (`- PH3+12 ...`) is a DRIP: that entry does not exist for the player
 * until N minutes of real play have passed in the phase. A long phase can carry
 * several, and packs stagger the offsets per character so the whole room is not
 * handed a new line at the same instant.
 *
 * Returns { scriptLines, findHints, fairnessDisclosure }.
 *   scriptLines[charId][phaseNumber] = { quote, prompt } | { reaction }, plus an
 *     optional `more: [...]` on any phase that drips
 *   each `more` entry = { quote, prompt, afterMin } | { reaction, afterMin }
 *   findHints[propId] = { ph3, ph4 }
 */
function parseScriptLines(text) {
  if (!text) return null;
  const t = text.replace(/[“”]/g, '"');
  const section = (n, next) => {
    const re = next
      ? new RegExp('## SECTION ' + n + '[\\s\\S]*?(?=## SECTION ' + next + ')')
      : new RegExp('## SECTION ' + n + '[\\s\\S]*$');
    return (t.match(re) || [''])[0];
  };

  // §1 per-phase lines, grouped by character block.
  const s1 = section(1, 2);
  const scriptLines = {};
  const headRe = /^###\s+([CF]\d+)\b[^\n]*$/gm;
  const marks = [];
  let hm;
  while ((hm = headRe.exec(s1)) !== null) marks.push({ id: hm[1], at: hm.index, after: headRe.lastIndex });
  const lineRe = /^-\s*PH([1-5])(?:\+(\d+))?\s+(QUOTE|REACTION):\s*"([^"]*)"(?:\s*\|\s*PROMPT:\s*([^\n]+))?/gm;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : s1.length;
    const body = s1.slice(marks[i].after, end);
    const byPhase = {};
    let lm;
    lineRe.lastIndex = 0;
    while ((lm = lineRe.exec(body)) !== null) {
      const phase = Number(lm[1]);
      const afterMin = lm[2] === undefined ? 0 : Number(lm[2]);
      const entry = lm[3] === 'REACTION'
        ? { reaction: lm[4].trim() }
        : { quote: lm[4].trim(), prompt: (lm[5] || '').trim() };
      if (afterMin === 0 || !byPhase[phase]) {
        // The phase-change line. Anything already dripped stays attached to it.
        const dripped = byPhase[phase] && byPhase[phase].more;
        if (dripped) entry.more = dripped;
        byPhase[phase] = entry;
      } else {
        // A timed line. `more` appears only on phases that actually drip, so a
        // pack with one line per phase serializes exactly as it always did.
        entry.afterMin = afterMin;
        const base = byPhase[phase];
        base.more = (base.more || []).concat(entry).sort((a, b) => a.afterMin - b.afterMin);
      }
    }
    scriptLines[marks[i].id] = byPhase;
  }
  let m;

  // §2 find-hints per prop.
  const s2 = section(2, 3);
  const findHints = {};
  // The field separator may be a pipe or a dash: packs written before the
  // no-dash rule still use a dash, and both have to keep parsing.
  const hintRe = /^-\s*(P[1-7])\b[^|—\n]*[|—]\s*PH3:\s*"([^"]*)"\s*\|\s*PH4\s*\[SCREEN\]:\s*"([^"]*)"/gm;
  while ((m = hintRe.exec(s2)) !== null) {
    findHints[m[1]] = { ph3: m[2].trim(), ph4: m[3].trim() };
  }

  // §3 fairness disclosure (engine copy, name-free).
  const s3 = section(3, null);
  const disc = s3.match(/must include:\s*"([^"]*)"/i);
  const fairnessDisclosure = disc ? disc[1].trim() : null;

  return { scriptLines, findHints, fairnessDisclosure };
}

// ---------------------------------------------------------------------------
// PLAYER-FACING COPY. The engine owns the mechanism; the pack owns every word a
// guest can read or hear. These parsers are generic — no pack supplies a string
// to this file, they only describe the shape a bible writes its copy in.
// ---------------------------------------------------------------------------

/** `- P1 | 21 | Label | Blurb | Flourish | Placement` → the public catalog. */
function parsePropCatalog(sectionBody) {
  const out = {};
  if (!sectionBody) return out;
  const re = /^-\s*(P\d+)\s*\|([^\n]*)$/gm;
  let m;
  while ((m = re.exec(sectionBody)) !== null) {
    const f = m[2].split('|').map((s) => s.trim());
    out[m[1]] = { number: f[0] || null, label: f[1] || '', blurb: f[2] || '', flourish: f[3] || '', placement: f[4] || '' };
  }
  return out;
}

/** `- KEY WORDS: value` lines, in order. Keys are SHOUTED so values may contain colons. */
function parseKeyedLines(sectionBody) {
  const out = [];
  if (!sectionBody) return out;
  const re = /^-\s*([A-Z][A-Z0-9]*(?: [A-Z0-9]+)*)\s*:\s*([^\n]*\S)\s*$/gm;
  let m;
  while ((m = re.exec(sectionBody)) !== null) out.push({ key: m[1].trim(), value: m[2].trim() });
  return out;
}

const NARRATION_KEYS = {
  'ATTENTION': 'attention', 'WARN 2MIN': 'warn2min', 'AWARDS INTRO': 'awardsIntro',
  'PHOTO': 'photo', 'PHOTO SCREEN': 'photoScreen',
  'BLACKOUT START': 'blackoutStart', 'BLACKOUT END': 'blackoutEnd', 'BLACKOUT MOVED': 'blackoutMoved',
  'SUSPECT': 'suspect', 'SUBPOENA YES': 'subpoenaYes', 'SUBPOENA NO': 'subpoenaNo',
  'FINAL CLOSED': 'finalClosed', 'MEDICAL SCREEN': 'medicalScreen', 'LOCKED HINT': 'lockedHint',
  'UNKNOWN TAG': 'unknownTag',
};
const AWARD_KEYS = {
  'AWARD BEST DETECTIVE': 'bestDetective', 'AWARD SHARPEST EYE': 'sharpestEye',
  'AWARD MOST SUSPECTED': 'mostSuspected', 'AWARD CAUGHT': 'caught', 'AWARD PERFECT': 'perfect',
};

/** The narrator's whole vocabulary for this pack: monologues, interjections, awards. */
function parseNarration(sectionBody) {
  const rows = parseKeyedLines(sectionBody);
  if (!rows.length) return null;
  const out = { monologues: {}, phaseNames: {}, asides: [], nudges: [], awards: {} };
  for (const { key, value } of rows) {
    const pn = key.match(/^PHASE NAME ([1-9])$/);
    if (pn) { out.phaseNames[Number(pn[1])] = value; continue; }
    const ph = key.match(/^PHASE ([1-9])$/);
    if (ph) { out.monologues[Number(ph[1])] = value; continue; }
    if (key === 'ASIDE') { out.asides.push(value); continue; }
    if (key === 'NUDGE') { out.nudges.push(value); continue; }
    if (AWARD_KEYS[key]) {
      const f = value.split('|').map((s) => s.trim());
      out.awards[AWARD_KEYS[key]] = { title: f[0] || '', note: f[1] || '' };
      continue;
    }
    if (NARRATION_KEYS[key]) out[NARRATION_KEYS[key]] = value;
  }
  return out;
}

/** `- id | question | guidance` for each engine-scheduled poll. */
function parsePollCopy(sectionBody) {
  const out = {};
  if (!sectionBody) return out;
  const re = /^-\s*([a-z][a-z0-9_-]*)\s*\|([^\n]*)$/gm;
  let m;
  while ((m = re.exec(sectionBody)) !== null) {
    const f = m[2].split('|').map((s) => s.trim());
    out[m[1]] = { question: f[0] || '', guidance: f[1] || '' };
  }
  return out;
}

/**
 * Multi-line values: a line `- KEY >>>` opens a block, a bare `<<<` closes it.
 * Repeated keys accumulate, so a section can carry a list of blocks.
 */
function parseBlocks(sectionBody) {
  const out = {};
  if (!sectionBody) return out;
  const lines = sectionBody.split('\n');
  let key = null;
  let buf = [];
  for (const line of lines) {
    if (key === null) {
      const m = line.match(/^-\s*([A-Z][A-Z0-9]*(?: [A-Z0-9]+)*)\s*>>>\s*$/);
      if (m) { key = m[1]; buf = []; }
      continue;
    }
    if (/^<<<\s*$/.test(line)) {
      (out[key] = out[key] || []).push(buf.join('\n').replace(/^\n+|\n+$/g, ''));
      key = null;
      continue;
    }
    buf.push(line);
  }
  return out;
}

/** Turn `KIND:`/`TITLE:`/`LINE:`/`NOTE:` lines inside a PRINTABLE block into an object. */
function parsePrintableBlock(text) {
  const out = { kind: 'note', title: '', lines: [], note: '' };
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([A-Z]+):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === 'KIND') out.kind = v || 'note';
    else if (m[1] === 'TITLE') out.title = v;
    else if (m[1] === 'NOTE') out.note = v;
    else if (m[1] === 'LINE') out.lines.push(v);
  }
  return out;
}

/**
 * The host-facing kit: page branding, placard and invite copy, and the
 * printable inserts. Spoiler-free by construction — it is the same material the
 * host already has on paper — and served to the front-end by functions/kit.js.
 */
function parseFrontend(sectionBody) {
  const rows = parseKeyedLines(sectionBody);
  const blocks = parseBlocks(sectionBody);
  if (!rows.length && !Object.keys(blocks).length) return null;
  const KEYS = {
    'SITE TITLE': 'siteTitle', 'BRAND EYEBROW': 'brandEyebrow', 'BRAND TAGLINE': 'brandTagline',
    'SCREEN EYEBROW': 'screenEyebrow', 'CASEFILE TITLE': 'casefileTitle',
    'CASEFILE EPIGRAPH': 'casefileEpigraph',
    'PLACARD TITLE': 'placardTitle', 'PLACARD NOTE': 'placardNote', 'PLACARD BRAND': 'placardBrand',
    'PLACARD LABEL': 'placardLabel', 'PLACARD MEDIUM': 'placardMedium', 'PLACARD COUNT': 'placardCount',
    'INVITE EYEBROW': 'inviteEyebrow', 'INVITE FOOTNOTE': 'inviteFootnote',
  };
  const brand = {};
  for (const { key, value } of rows) if (KEYS[key]) brand[KEYS[key]] = value;
  if (brand.placardCount) brand.placardCount = Number(brand.placardCount) || 0;

  const first = (k) => (blocks[k] && blocks[k][0]) || '';
  const invite = {
    card: first('INVITE CARD'),
    fine: first('INVITE FINE'),
    printLines: first('INVITE PRINT LINES'),
    printNote: first('INVITE PRINT NOTE'),
    poll: first('INVITE POLL'),
    short: first('INVITE SHORT'),
    long: first('INVITE LONG'),
  };
  const printables = (blocks.PRINTABLE || []).map(parsePrintableBlock);
  return { brand, invite, printables };
}


/**
 * The deduction layer (bible section 13). Pure structure, generic patterns, no
 * plot literals: every line is `- KEY | field | field`.
 *
 * It carries four things the engine needs and cannot invent:
 *   readings   what an exhibit says when it is not saying everything, per tier,
 *              the SAME under every answer so the reply shape carries nothing
 *   chain      five links, four of them held by named core characters, that
 *              together name the answer and separately name nobody
 *   cleared    why a member of the answer set is out, published by the staged
 *              releases one at a time
 *   leads      a false lead per non-answer core character, with the find that
 *              clears it again before the reveal
 */
function parseDeduction(sectionBody) {
  if (!sectionBody) return null;
  const out = {
    readings: {}, answerSet: [], holders: {}, traits: {}, links: {},
    cleared: {}, leads: {}, token: '',
  };
  const re = /^-\s*([A-Z][A-Z0-9]*(?: [A-Z0-9]+)*)\s*\|\s*([^\n]*)$/gm;
  let m;
  let seen = 0;
  while ((m = re.exec(sectionBody)) !== null) {
    const key = m[1].trim();
    const fields = m[2].split('|').map((x) => x.trim());
    const rest = fields[0];
    const parts = key.split(/\s+/);
    seen++;
    if (parts[0] === 'READING' && parts.length === 3) {
      const tier = Number(String(parts[2]).replace(/[^0-9]/g, ''));
      if (!out.readings[parts[1]]) out.readings[parts[1]] = {};
      out.readings[parts[1]][tier] = rest;
    } else if (key === 'ANSWER SET') {
      out.answerSet = fields.filter((x) => /^C\d+$/.test(x));
    } else if (parts[0] === 'HOLDER' && parts.length === 2) {
      out.holders[parts[1]] = rest;
    } else if (key === 'TOKEN') {
      out.token = rest;
    } else if (parts[0] === 'TRAIT' && parts.length === 2) {
      out.traits[parts[1]] = rest;
    } else if (parts[0] === 'LINK' && parts.length === 2) {
      out.links[parts[1]] = rest;
    } else if (parts[0] === 'CLEARED' && parts.length === 2) {
      out.cleared[parts[1]] = rest;
    } else if (parts[0] === 'LEAD' && parts.length === 2) {
      out.leads[parts[1]] = { lead: rest, clear: fields[1] || '' };
    } else {
      seen--;
    }
  }
  return seen ? out : null;
}

/** Facts the resolver needs that used to be baked into the engine. */
function parseWorld(sectionBody) {
  const rows = parseKeyedLines(sectionBody);
  if (!rows.length) return null;
  const out = { nearScene: [] };
  const split = (v) => v.split('|').map((s) => s.trim()).filter(Boolean);
  for (const { key, value } of rows) {
    if (key === 'TITLE') out.title = value;
    else if (key === 'VENUE') out.venue = value;
    else if (key === 'ALIBI QUESTION') out.alibiQuestion = value;
    else if (key === 'NEAR SCENE') out.nearScene.push(...split(value));
    else if (key === 'ITEM NOUN') {
      const f = split(value);
      out.itemNoun = f[0] || '';
      out.itemNounPlural = f[1] || (f[0] ? f[0] + 's' : '');
    } else if (key === 'VICTIM PRONOUNS') {
      const f = split(value);
      out.victimPronouns = {
        subject: f[0] || 'they', object: f[1] || 'them', possessive: f[2] || 'their',
        possessivePronoun: f[3] || 'theirs', reflexive: f[4] || 'themself',
      };
    }
  }
  return out;
}

/** Load script-lines data from an optional radioactive file (in memory only). */
function loadScriptLines(b64Path) {
  if (!b64Path || !fs.existsSync(b64Path)) return null;
  const text = Buffer.from(fs.readFileSync(b64Path, 'utf8'), 'base64').toString('utf8');
  return parseScriptLines(text);
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

  // Script lines + find-hints live in an optional sibling file; null until authored.
  const scriptData = loadScriptLines(path.join(path.dirname(b64Path), 'script-lines.md.b64'));

  // Distinct prop ids referenced by the matrix.
  const props = Object.keys(matrix).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

  // Player-facing copy sections. Optional: a bible without them still loads, and
  // the engine falls back to neutral, world-free wording.
  const propCatalog = parsePropCatalog(findSection('PROP CATALOG'));
  const narration = parseNarration(findSection('NARRATION'));
  const polls = parsePollCopy(findSection('POLL COPY'));
  const world = parseWorld(findSection('WORLD'));
  const frontend = parseFrontend(findSection('FRONT-END'));
  const deduction = parseDeduction(findSection('DEDUCTION'));

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
    scriptLines: scriptData ? scriptData.scriptLines : null,
    findHints: scriptData ? scriptData.findHints : null,
    fairnessDisclosure: scriptData ? scriptData.fairnessDisclosure : null,
    propCatalog,
    narration,
    polls,
    world,
    frontend,
    deduction,
    readings: deduction ? deduction.readings : null,
  };
}

module.exports = {
  loadPack,
  decodeBible,
  loadFlex,
  loadBranching,
  parseBranching,
  loadScriptLines,
  parseScriptLines,
  parseRoster,
  md5,
  parsePropCatalog,
  parseNarration,
  parsePollCopy,
  parseWorld,
  parseFrontend,
  parseDeduction,
  parseBlocks,
  // exported for unit-level reuse if ever needed
  _internal: { splitSections, parseCast, parseRoster, parseVariants, parseMatrix, parseEvidenceChain, parseKeyedLines },
  DEFAULT_BIBLE: path.join(__dirname, '..', '..', 'packs', 'last-exhibit', 'plot-bible.md.b64'),
};
