'use strict';
/*
 * THE DEDUCTION LAYER.
 *
 * Three things live here, and they exist because of one measured failure: the
 * answer used to be reachable by one person, alone, early, by tapping objects.
 *
 *  1. THE SEATED CHAIN (change 2). Five links. One is published to the room in
 *     the fourth phase; the other four sit privately with four core characters
 *     who are the same four under every answer and are never themselves the
 *     answer. Four of the five are never enough. The two links that put a name
 *     to something are worthless until a fourth holder puts a TIME on them,
 *     which is what makes the fourth seat necessary rather than decorative.
 *     `solve()` below is the whole semantics, and `minimumSeats()` proves the
 *     floor by enumerating every subset rather than by assertion.
 *
 *  2. STAGED RELEASES (change 3). One member of the answer set is cleared when
 *     the room closes its third-phase question, a second on entering the fourth
 *     phase, and nothing after that, so a room that has not done the work walks
 *     into the accusations holding two names and an argument.
 *
 *  3. FALSE LEADS (change 4). One is drawn each night, points at a core
 *     character who is never the answer under any variant, is published in the
 *     third phase and cleared in the fourth, so nobody is left holding it.
 *
 * SPOILER-SAFE in the sense the rest of lib/ is: it handles the answer, so no
 * caller may print what it returns. There are no plot literals here - every
 * word comes from the pack's deduction section.
 */

const crypto = require('crypto');
const { getVariant, resolveKillerId, say, KEYSTONE_PHASE } = require('./runtime');

const LINK_IDS = ['L1', 'L2', 'L3', 'L4'];
const RELEASE_PHASE_EARLY = 3;  // Asking Around, when the room's question closes
const RELEASE_PHASE_MID = 4;    // The Hard Part, on entry

/** The pack's deduction section, or null for a pack that has not authored one. */
function layer(pack) {
  const d = pack && pack.deduction;
  if (!d || !d.answerSet || d.answerSet.length < 2) return null;
  if (!d.links || !d.holders) return null;
  return d;
}

function pick(list) { return list[crypto.randomInt(0, list.length)]; }
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const k = crypto.randomInt(0, i + 1); [a[i], a[k]] = [a[k], a[i]]; }
  return a;
}

/**
 * Draw everything about tonight that is not the variant itself, and seal it the
 * same way. Returns null for a pack with no deduction layer, which simply means
 * that pack runs without a seated chain.
 *
 * Nothing in here may ever be returned to a client before the reveal.
 */
function sealDeduction(pack, variantLetter) {
  const d = layer(pack);
  if (!d) return null;
  const culprit = resolveKillerId(pack, variantLetter);
  if (!culprit || !d.answerSet.includes(culprit)) return null;

  const innocents = shuffled(d.answerSet.filter((id) => id !== culprit));
  const holders = Object.values(d.holders);
  // The other pair of hands on the token: a core character who is never the
  // answer and is not holding a link, so no link ever has to name its own
  // holder. Drawn from whoever the pack authored a trait for.
  const secondPool = Object.keys(d.traits || {})
    .filter((id) => !d.answerSet.includes(id) && !holders.includes(id));
  if (!secondPool.length) return null;
  const leadPool = Object.keys(d.leads || {}).filter((id) => !d.answerSet.includes(id));
  if (!leadPool.length) return null;

  return {
    // Two of the three innocents in the answer set are cleared in public, one
    // at each staged release. The third is not, which is the argument the room
    // takes into the accusations.
    clearEarly: innocents[0],
    clearMid: innocents[1],
    foil: innocents[2],
    secondHands: pick(secondPool),
    // Which of the two naming links names the person who did it. Drawn so that
    // neither holder can tell what they are holding.
    culpritNamedBy: crypto.randomInt(0, 2) === 0 ? 'L2' : 'L3',
    falseLead: pick(leadPool),
  };
}

// ---------------------------------------------------------------------------
// LINK ASSEMBLY. The pack authors the sentence; the seal fills the blanks.
// ---------------------------------------------------------------------------

function nameOf(pack, id) {
  const c = [...pack.cast, ...(pack.flex || [])].find((x) => x.id === id);
  return c ? c.name : id;
}

/** The two characters whose hands the token passed through, in drawn order. */
function tokenPair(pack, game) {
  const s = game.seal || {};
  const culprit = resolveKillerId(pack, game.variant);
  return s.culpritNamedBy === 'L2' ? [culprit, s.secondHands] : [s.secondHands, culprit];
}

/** Which character each naming link puts a name to. L2 takes the first hand. */
function namedBy(pack, game, linkId) {
  const [first, second] = tokenPair(pack, game);
  return linkId === 'L2' ? first : second;
}

/** The rendered text of one link, or '' when the pack has not authored it. */
function linkText(pack, game, linkId) {
  const d = layer(pack);
  if (!d) return '';
  const tmpl = d.links[linkId];
  if (!tmpl) return '';
  const [first, second] = tokenPair(pack, game);
  const vars = { token: d.token || '' };
  if (linkId === 'L1') {
    vars.traitOne = d.traits[first] || '';
    vars.traitTwo = d.traits[second] || '';
  } else if (linkId === 'L2' || linkId === 'L3') {
    const who = namedBy(pack, game, linkId);
    vars.trait = d.traits[who] || '';
    vars.name = nameOf(pack, who);
  }
  return say(pack, tmpl, vars);
}

/** The rendered text of a staged release, or '' if unauthored. */
function clearedText(pack, charId) {
  const d = layer(pack);
  if (!d) return '';
  const t = d.cleared[charId];
  return t ? say(pack, t, { name: nameOf(pack, charId) }) : '';
}

function leadText(pack, charId, which) {
  const d = layer(pack);
  const e = d && d.leads[charId];
  // A lead nobody can put a name to is not a lead, so the person it points at
  // is filled in the same way the staged releases fill theirs.
  return e ? say(pack, which === 'clear' ? e.clear : e.lead, { name: nameOf(pack, charId) }) : '';
}

// ---------------------------------------------------------------------------
// THE CONSTRAINT MODEL. What a given set of held items actually proves.
//
// This is deliberately written as data rather than prose so it can be checked:
// the validator enumerates every subset of the links against it and refuses a
// pack whose answer can be reached from fewer seats than intended.
// ---------------------------------------------------------------------------

/** What each item a guest can hold asserts. `held` is a Set of item keys. */
function solve(pack, game, held) {
  const d = layer(pack);
  if (!d) return d === null ? new Set() : new Set();
  const seal = game.seal || {};
  const set = new Set(d.answerSet);

  // Staged releases name a person and take them out.
  if (held.has('clearEarly') && seal.clearEarly) set.delete(seal.clearEarly);
  if (held.has('clearMid') && seal.clearMid) set.delete(seal.clearMid);

  // A naming link only counts once somebody has put a time on it (L4).
  const named = {};
  if (held.has('L4')) {
    for (const id of ['L2', 'L3']) {
      if (held.has(id)) { const who = namedBy(pack, game, id); named[who] = true; }
    }
  }

  // The token links the person who did it to exactly two pairs of hands. Until
  // BOTH of those are named, the pair contains somebody unaccounted for, so it
  // rules nobody out.
  if (held.has('L0') && held.has('L1')) {
    const pair = tokenPair(pack, game);
    if (pair.every((id) => named[id])) {
      for (const c of [...set]) if (!pair.includes(c)) set.delete(c);
    }
  }
  return set;
}

/** Every subset of the private links, with the public items always available. */
function subsetReport(pack, game) {
  const withPublic = ['clearEarly', 'clearMid', 'L0'];
  const rows = [];
  for (let mask = 0; mask < (1 << LINK_IDS.length); mask++) {
    const links = LINK_IDS.filter((_, i) => mask & (1 << i));
    const held = new Set(withPublic.concat(links));
    rows.push({ links, seats: links.length, remaining: solve(pack, game, held).size });
  }
  return rows;
}

/**
 * The fewest DISTINCT SEATS whose private content has to be combined before the
 * answer stands alone, with every public release already in hand. Returns
 * Infinity if it can never be reached, and null for a pack with no layer.
 */
function minimumSeats(pack, game) {
  if (!layer(pack)) return null;
  const solved = subsetReport(pack, game).filter((r) => r.remaining === 1);
  return solved.length ? Math.min(...solved.map((r) => r.seats)) : Infinity;
}


// ---------------------------------------------------------------------------
// PUBLISHING. Everything here fires at most once per party, guarded on the
// state it creates, so a host doing it by hand and autopilot doing it for her
// cannot double up.
// ---------------------------------------------------------------------------

function fired(game, key) {
  game.released = game.released || {};
  return !!game.released[key];
}
function markFired(game, key) {
  game.released = game.released || {};
  game.released[key] = new Date().toISOString();
}

/** To the room: a card on the screen and the same words onto every phone. */
function publishToRoom(pack, game, key, kind, text) {
  if (!text || fired(game, key)) return false;
  const { mergeDrops } = require('./branching');
  game.screenCards = game.screenCards || [];
  game.screenCards.push({ kind, text, audio: null, at: new Date().toISOString() });
  mergeDrops(game, Object.keys(game.players || {}).map((code) => ({ targetCode: code, drop: { kind, text } })));
  markFired(game, key);
  return true;
}

/** To one seat, privately, if that character is actually being played tonight. */
function dropToCharacter(pack, game, key, charId, kind, text) {
  if (!text || fired(game, key)) return false;
  const code = (game.assignments || {})[charId];
  // Mark it fired either way: an empty seat is not a reason to keep retrying,
  // and at ten or more guests every core seat is filled.
  markFired(game, key);
  if (!code) return false;
  const { mergeDrops } = require('./branching');
  mergeDrops(game, [{ targetCode: code, drop: { kind, text } }]);
  return true;
}

/** Everything that lands on entering a phase. Mutates `game`. */
function applyDeductionPhase(pack, game, phase) {
  const d = layer(pack);
  if (!d || !game.seal) return { fired: 0 };
  let n = 0;
  if (phase === RELEASE_PHASE_EARLY) {
    if (publishToRoom(pack, game, 'lead', 'lead', leadText(pack, game.seal.falseLead, 'lead'))) n++;
    if (dropToCharacter(pack, game, 'L1', d.holders.L1, 'testimony', linkText(pack, game, 'L1'))) n++;
    if (dropToCharacter(pack, game, 'L2', d.holders.L2, 'testimony', linkText(pack, game, 'L2'))) n++;
  } else if (phase === RELEASE_PHASE_MID) {
    if (dropToCharacter(pack, game, 'L3', d.holders.L3, 'testimony', linkText(pack, game, 'L3'))) n++;
    if (dropToCharacter(pack, game, 'L4', d.holders.L4, 'testimony', linkText(pack, game, 'L4'))) n++;
    if (publishToRoom(pack, game, 'clearMid', 'cleared', clearedText(pack, game.seal.clearMid))) n++;
  }
  return { fired: n };
}

/** The room closed its third-phase question: the first name comes off the list. */
function fireEarlyRelease(pack, game) {
  if (!layer(pack) || !game.seal) return false;
  return publishToRoom(pack, game, 'clearEarly', 'cleared', clearedText(pack, game.seal.clearEarly));
}

/** The room settled the files question: the false lead is taken back. */
function fireLeadCleared(pack, game) {
  if (!layer(pack) || !game.seal) return false;
  return publishToRoom(pack, game, 'leadCleared', 'lead-cleared', leadText(pack, game.seal.falseLead, 'clear'));
}

/** The public link. Fires when the keystone exhibit is first read in the fourth
 *  phase, or at the end of that phase if nobody has read it, so the chain is
 *  always completable by a room that did the work. */
function fireTokenLink(pack, game) {
  if (!layer(pack) || !game.seal) return false;
  if (game.phase < KEYSTONE_PHASE) return false;
  return publishToRoom(pack, game, 'L0', 'testimony', linkText(pack, game, 'L0'));
}

/* The public link should be IN the room's hands during the fourth phase, not
 * at the edge of it, so a room that has done the private work can finish while
 * the phase it belongs to is still running. Reading the decisive exhibit is the
 * intended trigger; this is the clock catching a room that never got to it.
 * Late require: lib/phases already depends on this file. */
const TOKEN_LINK_AT = 0.6; // of the phase's allotted time

function tokenLinkDue(pack, game) {
  if (!layer(pack) || !game || !game.seal) return false;
  if (game.phase !== KEYSTONE_PHASE || fired(game, 'L0')) return false;
  const { phaseElapsedMs, phaseAllottedMs } = require('./phases');
  const allotted = phaseAllottedMs(game);
  if (!allotted) return false;
  return phaseElapsedMs(game) >= allotted * TOKEN_LINK_AT;
}

/** Is this exhibit the keystone of the sealed variant? */
function isKeystoneProp(pack, game, propId) {
  return ((pack.matrix || {})[propId] || {})[game.variant] === 'keystone';
}

/** Backstop: anything a phase owed the room that the room never triggered. */
function fireOutstanding(pack, game, leavingPhase) {
  if (!layer(pack) || !game.seal) return 0;
  let n = 0;
  if (leavingPhase >= RELEASE_PHASE_EARLY && fireEarlyRelease(pack, game)) n++;
  if (leavingPhase >= KEYSTONE_PHASE) {
    if (fireTokenLink(pack, game)) n++;
    if (fireLeadCleared(pack, game)) n++;
  }
  return n;
}

/** What the reveal owes the room: the lead that was withdrawn, and the person
 *  the evidence still fitted at the end. Neither is the answer. */
function revealNotes(pack, game) {
  const d = layer(pack);
  if (!d || !game.seal) return null;
  return {
    falseLead: { name: nameOf(pack, game.seal.falseLead), lead: leadText(pack, game.seal.falseLead, 'lead'), cleared: leadText(pack, game.seal.falseLead, 'clear') },
    stillStanding: nameOf(pack, game.seal.foil),
    clearedDuringPlay: [game.seal.clearEarly, game.seal.clearMid].map((id) => nameOf(pack, id)),
  };
}

module.exports = {
  LINK_IDS, RELEASE_PHASE_EARLY, RELEASE_PHASE_MID, KEYSTONE_PHASE,
  layer, sealDeduction, tokenPair, namedBy, linkText, clearedText, leadText,
  solve, subsetReport, minimumSeats, nameOf,
  applyDeductionPhase, fireEarlyRelease, fireLeadCleared, fireTokenLink, fireOutstanding,
  isKeystoneProp, revealNotes, publishToRoom, dropToCharacter, tokenLinkDue, TOKEN_LINK_AT,
};
