'use strict';
/*
 * Server-side game runtime for the Mystery Engine.
 *
 * SPOILER-SAFE BY CONSTRUCTION:
 *  - The solution/variant is selected server-side and SEALED. It is never
 *    returned to any client until the Reveal phase (6).
 *  - Evidence text (from the encoded pack) is only ever served in response to a
 *    deliberate in-game action (scanning a prop, an assigned drop), gated by
 *    phase. The keystone (E6) is never served before Phase 4.
 *  - Each player receives only their OWN character brief, never another's.
 *
 * The only plot-adjacent literals in this file are the PHYSICAL prop
 * descriptions, which already appear in the (Kali-readable) props guide.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACK_B64 = path.join(__dirname, '..', '..', 'packs', 'last-exhibit', 'pack.json.b64');

const PHASES = [
  { n: 1, key: 'arrivals', name: 'Arrivals' },
  { n: 2, key: 'unveiling', name: 'The Unveiling' },
  { n: 3, key: 'investigation', name: 'Investigation' },
  { n: 4, key: 'keystone', name: 'The Keystone' },
  { n: 5, key: 'accusation', name: 'Accusation' },
  { n: 6, key: 'reveal', name: 'The Reveal' },
];
const KEYSTONE_PHASE = 4;
const KILLER_UNLOCK_PHASE = 3; // the hybrid killer learns the truth mid-game
// Suggested minutes per phase (host guidance only — never auto-advances).
const PHASE_MINUTES = { 1: 20, 2: 10, 3: 35, 4: 25, 5: 20, 6: 10 };

// Player-facing exhibit numbers (printed on placards / written into NFC tags).
// Internal prop IDs (P1..P7) are NEVER shown to players; this is the mapping.
const EXHIBIT_NUMBERS = { P1: '21', P2: '22', P3: '23', P4: '24', P5: '25', P6: '26', P7: '27' };
function exhibitNumber(propId) { return EXHIBIT_NUMBERS[propId] || null; }
/** Resolve a player input (typed exhibit number, or NFC value) to an internal prop id. */
function propIdFromInput(input) {
  if (input == null) return null;
  const t = String(input).trim().toUpperCase();
  if (/^P[1-7]$/.test(t)) return t; // tolerate internal id (dev / legacy NFC)
  const num = t.replace(/[^0-9]/g, '');
  if (!num) return null;
  for (const [pid, n] of Object.entries(EXHIBIT_NUMBERS)) {
    if (n === num || String(Number(n)) === String(Number(num))) return pid;
  }
  return null;
}

// Safe physical descriptions (identical to the props guide Kali already has).
const PROP_CATALOG = {
  P1: { label: 'Champagne flute', blurb: 'A single flute, a bold lipstick print on the rim. Left somewhere a glass looks abandoned, not staged.' },
  P2: { label: 'Day planner', blurb: 'A small datebook. One page has been torn out; the stub still carries an impression.' },
  P3: { label: 'Prescription bottle', blurb: 'A pill bottle, its label partially scratched away.' },
  P4: { label: 'Sealed black envelope', blurb: 'A black envelope, sealed. It feels deliberate.' },
  P5: { label: 'Art-handling gloves', blurb: 'White cotton gloves with a colored smudge across one palm.' },
  P6: { label: 'Old photograph', blurb: 'A photograph with one face scratched out.' },
  P7: { label: 'Gallery key fob', blurb: 'A staff key fob on a snapped lanyard — "GALERIE NOIR — STAFF".' },
};

// --- Narration audio (opaque filenames; no plot in the name) --------------
// A logical key ("phase.3", "reveal.A.method", …) hashes to an opaque mp3 name.
// The generator and the server compute this identically (sha256), so files line
// up without a manifest. Keys and prop IDs never reach the client — only hashes.
function audioName(key) {
  return crypto.createHash('sha256').update('narration:' + key).digest('hex').slice(0, 20) + '.mp3';
}
const AUDIO_KEYS = {
  phase: (n) => 'phase.' + n,
  screenHint: (propId) => 'hint.' + propId + '.ph4',
  medical: () => 'screen.medical',
  revealTitle: (v) => 'reveal.' + v + '.title',
  revealMethod: (v) => 'reveal.' + v + '.method',
};

let _cache = null;
let _cacheKey = null;

/** Which pack file to load: env override (rehearsal/test) or the real pack. */
function packPath() {
  return process.env.MYSTERY_PACK_FILE || PACK_B64;
}

/**
 * Load the structured pack into memory (cached). A `.b64` file is base64; any
 * other extension is treated as plain JSON (used by the dummy rehearsal pack).
 */
function loadRuntimePack() {
  const p = packPath();
  if (_cache && _cacheKey === p) return _cache;
  const raw = fs.readFileSync(p, 'utf8');
  const json = p.endsWith('.b64') ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  _cache = JSON.parse(json);
  _cacheKey = p;
  return _cache;
}

/** Select a solution variant. Server-authoritative; sealed by the caller. */
function selectVariant(pack, seed) {
  const letters = pack.variants.map((v) => v.letter);
  let idx;
  if (typeof seed === 'number') {
    idx = seed % letters.length; // deterministic path for tests only
  } else {
    idx = crypto.randomInt(0, letters.length);
  }
  return letters[idx];
}

function getVariant(pack, letter) {
  return pack.variants.find((v) => v.letter === letter) || null;
}

function phaseInfo(n) {
  return PHASES.find((p) => p.n === n) || PHASES[0];
}

/** The public "everyone knows this" blurb about the victim. */
function publicVictimBlurb(pack) {
  const text = pack.victim || '';
  const m = text.match(/Public knowledge at game start:\**\s*([\s\S]*)$/i);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim();
}

/** Cast roster that is public (character name only — personas are public roles). */
function publicRoster(pack) {
  return pack.cast.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * A character's PUBLIC persona — the part of their dossier everyone learns at
 * game start (everything before their SECRETS). Safe for the join screen.
 */
function publicPersona(character) {
  if (!character || !character.brief) return '';
  return String(character.brief)
    .split(/SECRETS?\s*:/i)[0]
    .replace(/^[\s—–-]+/, '')
    .replace(/\*+/g, '')
    .trim();
}

/** Unclaimed seats (core first, then flex) with their public personas. */
function castingList(pack, game) {
  const taken = new Set(Object.keys(game.assignments || {}));
  return [...pack.cast, ...(pack.flex || [])]
    .filter((c) => !taken.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, persona: publicPersona(c) }));
}

/** A single player's private dossier. Served ONLY to that player. */
function playerBrief(pack, characterId) {
  const c = [...pack.cast, ...(pack.flex || [])].find((x) => x.id === characterId);
  if (!c) return null;
  return { id: c.id, name: c.name, piece: c.piece != null ? c.piece : null, brief: c.brief };
}

/** Seating order: core cast first (10-player games use only these), then flex. */
function assignableIds(pack) {
  return [...pack.cast.map((c) => c.id), ...(pack.flex || []).map((f) => f.id)];
}

/** Total seats available = core + flex. */
function capacity(pack) {
  return pack.cast.length + (pack.flex ? pack.flex.length : 0);
}

/**
 * Resolve what scanning a prop reveals, for the active (sealed) variant at the
 * current phase. Never leaks the variant identity; never serves the keystone
 * before Phase 4.
 */
function resolvePropScan(pack, variantLetter, propId, phase) {
  const catalog = PROP_CATALOG[propId];
  if (!catalog) return { propId, unknown: true };

  const base = { propId, label: catalog.label, blurb: catalog.blurb };

  const v = getVariant(pack, variantLetter);
  if (!v) return base;

  const kind = (pack.matrix[propId] || {})[variantLetter] || 'herring';

  // Find the evidence step (if any) that this prop surfaces in this variant.
  const step = (v.evidence.steps || []).find((s) => new RegExp('\\b' + propId + '\\b').test(s.text));

  // Herring in this variant, or no evidence tie: show only the neutral catalog
  // entry. Players cannot distinguish "herring" from "not yet unlocked", which
  // is what keeps every prop feeling important (per the design requirement).
  if (kind === 'herring' || !step) {
    return { ...base, extra: null };
  }

  // Gate the keystone until Phase 4 under all paths (fairness rule 4).
  const isKeystone = kind === 'keystone' || step.n === 6;
  if (isKeystone && phase < KEYSTONE_PHASE) {
    return { ...base, extra: null, locked: true, lockedHint: "The catalog entry for this piece is marked 'to be announced'." };
  }

  // Evidence-bearing and unlocked: reveal the evidence-step text.
  return { ...base, extra: { step: step.n, text: step.text, keystone: isKeystone } };
}

// Generic, plot-free rescue prompts for players who have gone quiet. They nod
// at "your character has something to protect" without encoding any secret.
const NUDGES = [
  'Someone just glanced at you across the room. Go find out why.',
  'You have been quiet. Pick the person you trust least and ask them where they were.',
  'Your character is protecting something. Make sure no one is circling it.',
  'Go examine a piece you have not looked at yet — tap its tag.',
  'Start a rumor. Nothing steadies a room like a little chaos.',
  'Compare notes with someone. One of you knows more than you think.',
  'Ask the room a question out loud. Watch who gets uncomfortable.',
];
const NUDGE_PHASES = new Set([2, 3, 4, 5]);
const NUDGE_THRESHOLD_MS = 8 * 60 * 1000;

function hashId(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * A rescue nudge for an idle player. Returns null unless the player has been
 * inactive past the threshold during an active phase. Deterministic pick (no
 * randomness) so it is testable and stable between polls.
 */
function idleNudge(characterId, phase, idleMs, thresholdMs) {
  const limit = typeof thresholdMs === 'number' ? thresholdMs : NUDGE_THRESHOLD_MS;
  if (!NUDGE_PHASES.has(phase)) return null;
  if (!(idleMs >= limit)) return null;
  const idx = (hashId(characterId) + phase) % NUDGES.length;
  return { text: NUDGES[idx], idleMinutes: Math.floor(idleMs / 60000) };
}

/**
 * Map a variant's killer (stored as a prose name) to a character id, by finding
 * the cast member whose name appears in the killer string.
 */
function resolveKillerId(pack, variantLetter) {
  const v = getVariant(pack, variantLetter);
  if (!v) return null;
  const target = String(v.killer).toUpperCase();
  const hit = pack.cast.find((c) => target.includes(String(c.name).toUpperCase()));
  return hit ? hit.id : null;
}

/**
 * The mid-game private unlock delivered ONLY to the player whose character is
 * the sealed variant's killer, and only from Phase 3 onward. `whatYouDid` is the
 * method text from the pack; the guidance is generic and requires no acting
 * skill (fairness rule 6). Returns null for everyone else / too-early.
 */
function killerUnlock(pack, variantLetter, characterId, phase) {
  if (phase < KILLER_UNLOCK_PHASE) return null;
  if (resolveKillerId(pack, variantLetter) !== characterId) return null;
  const v = getVariant(pack, variantLetter);
  return {
    youAreTheKiller: true,
    unlockedAtPhase: KILLER_UNLOCK_PHASE,
    whatYouDid: v.method,
    guidance: [
      'The app will never expose you — only the evidence can. Stay calm.',
      'Keep playing your character exactly as before. No new performance is required.',
      'You may lie about where you were and what you know. You never have to volunteer anything.',
      'React to accusations with the same energy as everyone else — curiosity, not panic.',
      'You "win" if no accusation reaches a group majority against you before the Reveal.',
      'Do NOT confess, wink, or hint. Do NOT invent evidence — the props speak for themselves.',
    ],
  };
}

/** Parse the branching hooks into a lightweight list the host tools can fire. */
function branchingHooks(pack) {
  const text = pack.branching || '';
  return text
    .split(/\n-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  PHASES,
  KEYSTONE_PHASE,
  KILLER_UNLOCK_PHASE,
  PHASE_MINUTES,
  NUDGE_THRESHOLD_MS,
  PROP_CATALOG,
  EXHIBIT_NUMBERS,
  exhibitNumber,
  propIdFromInput,
  audioName,
  AUDIO_KEYS,
  loadRuntimePack,
  selectVariant,
  getVariant,
  phaseInfo,
  publicVictimBlurb,
  publicRoster,
  publicPersona,
  castingList,
  playerBrief,
  assignableIds,
  capacity,
  resolvePropScan,
  resolveKillerId,
  killerUnlock,
  idleNudge,
  branchingHooks,
};
