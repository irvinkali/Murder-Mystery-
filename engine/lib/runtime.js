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

let _cache = null;

/** Load and decode the structured pack into memory (cached). */
function loadRuntimePack() {
  if (_cache) return _cache;
  const b64 = fs.readFileSync(PACK_B64, 'utf8');
  _cache = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
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

/** A single player's private dossier. Served ONLY to that player. */
function playerBrief(pack, characterId) {
  const c = pack.cast.find((x) => x.id === characterId);
  if (!c) return null;
  return { id: c.id, name: c.name, piece: c.piece, brief: c.brief };
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
  PROP_CATALOG,
  loadRuntimePack,
  selectVariant,
  getVariant,
  phaseInfo,
  publicVictimBlurb,
  publicRoster,
  playerBrief,
  resolvePropScan,
  branchingHooks,
};
