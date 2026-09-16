'use strict';
/*
 * Server-side game runtime for the Mystery Engine.
 *
 * SPOILER-SAFE BY CONSTRUCTION:
 *  - The solution/variant is selected server-side and SEALED. It is never
 *    returned to any client until the Reveal phase (6).
 *  - Evidence text (from the encoded pack) is only ever served in response to a
 *    deliberate in-game action (scanning a prop, an assigned drop), gated by
 *    phase. Every step of the chain has a phase, not just the keystone, and
 *    the keystone (E6) is never served before Phase 4.
 *  - Every exhibit answers with exactly one paragraph in exactly one field, in
 *    every variant at every phase, so the shape of the reply carries nothing.
 *  - Each player receives only their OWN character brief, never another's.
 *
 * There are no world literals in this file. Every player-facing string — prop
 * labels, exhibit numbers, rescue nudges, lock hints — comes from the loaded
 * pack. The only hardcoded strings left are neutral, world-free fallbacks for a
 * pack that has not authored its copy yet.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Which story pack this deployment runs. Set MYSTERY_PACK in the Netlify
// environment to the folder name under packs/ to switch games; the default
// keeps existing deployments on the first pack.
const PACK_NAME = process.env.MYSTERY_PACK || 'last-exhibit';
const PACK_B64 = path.join(__dirname, '..', '..', 'packs', PACK_NAME, 'pack.json.b64');

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

// ---------------------------------------------------------------------------
// PACK COPY ACCESS. Every accessor takes an OPTIONAL pack; when it is omitted
// the process-wide loaded pack (MYSTERY_PACK_FILE or the default) is used, so
// existing call sites keep working unchanged.
// ---------------------------------------------------------------------------

/** The pack to read copy from: the one handed in, or the loaded one. */
function activePack(pack) {
  if (pack) return pack;
  try { return loadRuntimePack(); } catch (_) { return null; }
}

/** The pack's public, spoiler-free prop catalog: number, label, blurb, flourish. */
function propCatalog(pack) {
  const p = activePack(pack);
  return (p && p.propCatalog) || {};
}
function propEntry(propId, pack) { return propCatalog(pack)[propId] || null; }

/** Player-facing item numbers (printed on cards / written into NFC tags).
 *  Internal prop IDs (P1..Pn) are NEVER shown to players; this is the mapping. */
function exhibitNumber(propId, pack) {
  const e = propEntry(propId, pack);
  return e && e.number != null ? String(e.number) : null;
}
/** Resolve a player input (typed item number, or NFC value) to an internal prop id. */
function propIdFromInput(input, pack) {
  if (input == null) return null;
  const t = String(input).trim().toUpperCase();
  const catalog = propCatalog(pack);
  if (/^P\d+$/.test(t) && catalog[t]) return t; // tolerate internal id (dev / legacy NFC)
  const num = t.replace(/[^0-9]/g, '');
  if (!num) return null;
  for (const [pid, e] of Object.entries(catalog)) {
    const n = e && e.number != null ? String(e.number) : null;
    if (n && (n === num || String(Number(n)) === String(Number(num)))) return pid;
  }
  return null;
}

// Neutral, world-free fallbacks. A pack that authors its copy never sees these.
const FALLBACK = {
  itemNoun: 'item',
  itemNounPlural: 'items',
  lockedHint: 'This one is not ready to be read yet.',
  unknownTag: 'Nothing matches that number.',
  pronouns: { subject: 'they', object: 'them', possessive: 'their', possessivePronoun: 'theirs', reflexive: 'themself' },
  nudges: [
    'Someone just glanced at you across the room. Go find out why.',
    'You have been quiet. Pick the person you trust least and ask them where they were.',
    'Your character is protecting something. Make sure no one is circling it.',
    'Go look at something you have not looked at yet, and tap its tag.',
    'Start a rumour. Nothing steadies a room like a little chaos.',
    'Compare notes with someone. One of you knows more than you think.',
    'Ask the room a question out loud. Watch who gets uncomfortable.',
  ],
};

/** The pack's narration block (monologues, interjections, awards), or {}. */
function narrationCopy(pack) {
  const p = activePack(pack);
  return (p && p.narration) || {};
}
/** The pack's world hooks (pronouns, near-scene phrases, nouns), or {}. */
function worldCopy(pack) {
  const p = activePack(pack);
  return (p && p.world) || {};
}
/** The victim's first name, derived from the bible — never hard-coded. */
function victimName(pack) {
  const p = activePack(pack);
  const m = String((p && p.victim) || '').match(/\*\*([^*\s]+)/);
  return m ? m[1] : '';
}
/** The victim's pronouns, pack-supplied; no gender is assumed by the engine. */
function victimPronouns(pack) {
  return worldCopy(pack).victimPronouns || FALLBACK.pronouns;
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

/** Substitute {tokens} in a pack copy string. Unknown tokens are left alone. */
function fill(text, vars) {
  if (text == null) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole));
}

/** The standard substitution set available to every pack copy string. */
function copyVars(pack, extra) {
  const pr = victimPronouns(pack);
  const w = worldCopy(pack);
  return Object.assign({
    victim: victimName(pack),
    they: pr.subject, them: pr.object, their: pr.possessive,
    theirs: pr.possessivePronoun, themself: pr.reflexive,
    They: cap(pr.subject), Them: cap(pr.object), Their: cap(pr.possessive),
    item: w.itemNoun || FALLBACK.itemNoun,
    items: w.itemNounPlural || FALLBACK.itemNounPlural,
    title: w.title || '', venue: w.venue || '',
  }, extra || {});
}

/** Render a piece of pack copy with the standard vars plus any extras. */
function say(pack, text, extra) {
  return text ? fill(text, copyVars(pack, extra)) : text;
}

// --- Narration audio (opaque filenames; no plot in the name) --------------
// A logical key ("phase.3", "reveal.A.method", …) hashes to an opaque mp3 name.
// The generator and the server compute this identically (sha256), so files line
// up without a manifest. Keys and prop IDs never reach the client — only hashes.
/* The narration file for a logical key.
 *
 * The pack id is part of the hash. Without it every pack produces the SAME
 * filenames, and a deployment that rendered one pack's audio will happily serve
 * it to another: the reunion's room screen speaking gallery lines, which is
 * exactly what happened the first time this was built at deploy time. The
 * generator and the server both call this, so they stay in step. */
function audioName(key) {
  let pack = '';
  try { pack = (loadRuntimePack() || {}).id || ''; } catch (_) { pack = process.env.MYSTERY_PACK || ''; }
  return crypto.createHash('sha256').update('narration:' + pack + ':' + key).digest('hex').slice(0, 20) + '.mp3';
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

/** The player-facing name of a phase — pack copy, with the engine key as backstop. */
function phaseName(n, pack) {
  const named = (narrationCopy(pack).phaseNames || {})[n];
  return named || phaseInfo(n).name;
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

/** Normalize a guest name for reservation matching: case and spacing ignored. */
function normName(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Unclaimed, unreserved seats (core first, then flex) with their public
 * personas. Host reservations are left out so guests can't pick them — and the
 * reserved guest names themselves are never included.
 */
function castingList(pack, game) {
  const taken = new Set(Object.keys(game.assignments || {}));
  const reserved = game.reservations || {};
  return [...pack.cast, ...(pack.flex || [])]
    .filter((c) => !taken.has(c.id) && !reserved[c.id])
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
 * Strip the authoring scaffolding out of an evidence step before a guest reads
 * it. A step is written as `E4 P1 photo-booth strip: ...` for the validator's
 * benefit; the ordinal tells a guest how far along a six-step chain they are,
 * and `P1` is an internal id that is never supposed to leave the server. Both
 * come off here, so what reaches a phone is the sentence and nothing else.
 */
function sanitizeReading(text) {
  if (!text) return text;
  return String(text)
    .replace(/^\s*E\d+\s*(?:KEYSTONE\s*:\s*)?/i, '')
    .replace(/\bP[1-9]\d*\s+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Which phase each evidence step becomes readable in. The chain is released
// across the evening instead of all at once: the opening steps land with the
// discovery, the middle of the chain during the long investigation phase, and
// the last two - the keystone among them - only in the fourth phase.
const STEP_PHASE = { 1: 2, 2: 2, 3: 3, 4: 3, 5: KEYSTONE_PHASE, 6: KEYSTONE_PHASE };
function stepPhase(n) { return STEP_PHASE[n] || KEYSTONE_PHASE; }
// Which tier of generic reading an exhibit gives at a given phase.
function readingTier(phase) { return phase >= KEYSTONE_PHASE ? 4 : (phase >= 3 ? 3 : 2); }
const READING_TIERS = [2, 3, 4];
const READING_SEP = '\n\n';

/**
 * What tapping an exhibit says, for the sealed variant at the current phase.
 *
 * EVERY exhibit answers, in every variant, at every phase, with one paragraph
 * in one field. That is deliberate and it is load-bearing.
 *
 * An earlier build returned the evidence text for a live exhibit, a separately
 * styled "not yet" note for the gated one, and nothing at all for a dead end.
 * Those three replies are externally distinguishable, and the PATTERN of them
 * across the seven exhibits was unique to each sealed answer at every phase. A
 * guest who tapped two exhibits could read the answer off the SHAPE of the
 * replies without understanding a word of the content, and the phase gate did
 * not help, because a gated exhibit announced itself as the gated one.
 *
 * So there is no longer any observable difference between a dead end, a step
 * whose moment has not come round, and a step that is live. All three return
 * `reading`, and nothing else. Do not reintroduce a second field, a flag, or a
 * different style for any of these cases.
 */
function resolvePropScan(pack, variantLetter, propId, phase) {
  const catalog = propEntry(propId, pack);
  if (!catalog) return { propId, unknown: true };

  const base = { propId, label: say(pack, catalog.label), blurb: say(pack, catalog.blurb) };
  // The reply a pack that has authored nothing else still gives: the exhibit's
  // own flourish, which every pack writes for every prop, so the shape holds.
  const fallback = say(pack, catalog.flourish) || say(pack, catalog.blurb) ||
    say(pack, narrationCopy(pack).lockedHint) || FALLBACK.lockedHint;

  const v = getVariant(pack, variantLetter);
  const tiers = READING_TIERS.filter((t) => t <= readingTier(phase));

  // An exhibit's reply is what has been noticed about it SO FAR: one entry per
  // tier of the evening, oldest first, and it gains exactly one entry at every
  // phase boundary. That last part is not cosmetic. If a live exhibit simply
  // swapped its text once and then sat still while the dead ends kept changing,
  // then re-reading all seven before and after a phase turn would show you
  // which ones had settled, and which ones settle is unique to each answer -
  // the original leak, wearing a different coat. Every exhibit gains an entry
  // at every boundary under every answer, so that comparison says nothing.
  const step = v && (v.evidence.steps || []).find((s2) => new RegExp('\\b' + propId + '\\b').test(s2.text));
  const parts = tiers.map((t) => {
    if (step && stepPhase(step.n) === t) return sanitizeReading(say(pack, step.text));
    const authored = ((pack.readings || {})[propId] || {})[t];
    return say(pack, authored) || fallback;
  });
  return { ...base, reading: parts.join(READING_SEP), entries: parts.length };
}

// Rescue prompts for players who have gone quiet, in the pack's own voice. They
// nod at "your character has something to protect" without encoding any secret.
function nudgeList(pack) {
  const list = narrationCopy(pack).nudges;
  return (list && list.length) ? list : FALLBACK.nudges;
}
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
function idleNudge(characterId, phase, idleMs, thresholdMs, pack) {
  const limit = typeof thresholdMs === 'number' ? thresholdMs : NUDGE_THRESHOLD_MS;
  if (!NUDGE_PHASES.has(phase)) return null;
  if (!(idleMs >= limit)) return null;
  const list = nudgeList(pack);
  const idx = (hashId(characterId) + phase) % list.length;
  return { text: say(pack, list[idx]), idleMinutes: Math.floor(idleMs / 60000) };
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
  FALLBACK,
  activePack,
  propCatalog,
  propEntry,
  narrationCopy,
  worldCopy,
  victimName,
  victimPronouns,
  fill,
  copyVars,
  say,
  nudgeList,
  exhibitNumber,
  propIdFromInput,
  audioName,
  AUDIO_KEYS,
  loadRuntimePack,
  selectVariant,
  getVariant,
  phaseInfo,
  phaseName,
  publicVictimBlurb,
  publicRoster,
  publicPersona,
  castingList,
  normName,
  playerBrief,
  assignableIds,
  capacity,
  resolvePropScan,
  stepPhase,
  readingTier,
  READING_TIERS,
  READING_SEP,
  sanitizeReading,
  STEP_PHASE,
  resolveKillerId,
  killerUnlock,
  idleNudge,
  branchingHooks,
};
