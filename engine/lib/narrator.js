'use strict';
/*
 * The Narrator — the voice that is present in the room all night.
 *
 * Two kinds of speech:
 *  1. Phase monologues (the "what happens now" cards) — fuller, theatrical,
 *     paced with deliberate ellipses so the TTS performs rather than reads.
 *  2. Live interjections — reactions to real events (an item found, the room's
 *     suspicion landing on someone, votes resolving) plus atmospheric asides
 *     when the room goes quiet.
 *
 * SPOILER-SAFETY *and* PACK-AGNOSTICISM: this file contains no copy at all. The
 * narrator's entire vocabulary — monologues, flourishes, asides, awards — is
 * authored in the pack and read through lib/runtime's copy accessors. Character
 * names and item numbers are substituted at runtime. Nothing here names anyone
 * or any place, so the spoiler scanner stays clean and a second pack sounds like
 * itself rather than like the first one. Because the name/prop space is
 * enumerable, nearly every line can still be pre-rendered by the TTS generator
 * under an opaque filename — the browser voice is only the fallback.
 */

const { audioName, propCatalog, exhibitNumber, narrationCopy, say } = require('./runtime');

// Neutral fallbacks: used only by a pack that has not authored its narration.
const FALLBACK_ASIDES = [
  'A lovely hush. Rooms only go this quiet when someone is rehearsing.',
  'Do refresh your drinks. Steady hands are wasted on the innocent.',
  'Notice who keeps checking the exits.',
  'The guest who asks no questions already knows the answers.',
  'Someone here has told the same story twice tonight, word for word.',
  'Watch hands, not faces. Faces audition. Hands confess.',
];
const FALLBACK = {
  attention: 'Your attention, please.',
  warn2min: 'Two minutes, everyone.',
  awardsIntro: 'Before you compare notes, a few honours to bestow.',
  photo: 'Gather in, everyone. One photograph.',
  photoScreen: 'PHOTOGRAPH. Gather in.',
  blackoutStart: 'The lights have gone. Stay calm. Stay where you are.',
  blackoutEnd: 'And then, light. Welcome back.',
  blackoutMoved: 'One more thing. No. {number} is not where it was a minute ago.',
  suspect: 'The votes are in, and the room has settled on {name}.',
  subpoenaYes: 'The vote carries. The files are open.',
  subpoenaNo: 'The room votes for discretion. The files stay shut, for now.',
  finalClosed: 'The last ballot is cast and counted.',
  medicalScreen: 'The files are open.',
  found: 'Someone has a good eye. Take a close look, and decide who you tell.',
};

const ASIDE_QUIET_MS = 4 * 60 * 1000; // a quiet stretch = ~4 min with no narrator activity
const ASIDE_PHASES = new Set([2, 3, 4, 5]);

function line(pack, key) {
  return say(pack, narrationCopy(pack)[key]) || FALLBACK[key];
}

// ---------------------------------------------------------------------------
// 1. PHASE MONOLOGUES — the pack's own voice, one per phase.
// ---------------------------------------------------------------------------

/** The monologue for a phase, or '' when the pack has not authored one. */
function monologue(pack, phase) {
  const m = (narrationCopy(pack).monologues || {})[phase];
  return say(pack, m) || '';
}

// ---------------------------------------------------------------------------
// 2. LIVE INTERJECTIONS — templates filled from the pack + the live game.
// ---------------------------------------------------------------------------

/** Spoken call-to-attention, played after the bell and before any MAJOR beat. */
function attentionLine(pack) { return line(pack, 'attention'); }
/** Spoken two-minute warning before an automatic phase change (ambient, no bell). */
function warn2minLine(pack) { return line(pack, 'warn2min'); }
/** Spoken lead-in to the awards, after the reveal itself. */
function awardsIntroLine(pack) { return line(pack, 'awardsIntro'); }
/** The host-triggered group photo moment. */
function photoLine(pack) { return line(pack, 'photo'); }
/** The screen card that accompanies the photo moment. */
function photoScreenLine(pack) { return line(pack, 'photoScreen'); }
function blackoutStartLine(pack) { return line(pack, 'blackoutStart'); }
function blackoutEndLine(pack) { return line(pack, 'blackoutEnd'); }
/** The public screen text when the medical files open. */
function medicalScreenLine(pack) { return line(pack, 'medicalScreen'); }

/** First-discovery flourish for one prop (physical description only). */
function foundLine(propId, pack) {
  const cat = propCatalog(pack)[propId];
  if (!cat) return null;
  return say(pack, cat.flourish) || say(pack, FALLBACK.found);
}

/** The item that moved during the blackout, named by its public number. */
function blackoutMovedLine(propId, pack) {
  const n = exhibitNumber(propId, pack);
  if (!n) return null;
  return say(pack, narrationCopy(pack).blackoutMoved || FALLBACK.blackoutMoved, { number: n });
}

function suspectLine(name, pack) {
  return say(pack, narrationCopy(pack).suspect || FALLBACK.suspect, { name });
}

function subpoenaLine(outcome, pack) {
  return outcome === 'yes' ? line(pack, 'subpoenaYes') : line(pack, 'subpoenaNo');
}

function finalClosedLine(pack) { return line(pack, 'finalClosed'); }

/** Atmospheric asides for quiet stretches, in the pack's voice. */
function asideList(pack) {
  const list = narrationCopy(pack).asides;
  return (list && list.length) ? list : FALLBACK_ASIDES;
}
function asideText(idx, pack) {
  const list = asideList(pack);
  return say(pack, list[((idx % list.length) + list.length) % list.length]);
}

// ---------------------------------------------------------------------------
// 3. THE FEED — how interjections reach the room.
// ---------------------------------------------------------------------------

/** Append a narrator interjection to the game's feed. `key` drives the opaque
 *  pre-rendered audio filename; text is the speech (and the fallback).
 *  `major: true` makes the gallery ring the bell + speak the attention call
 *  first (vote outcomes, verdicts). Ambient lines (finds, asides) stay minor. */
function pushNarrator(game, key, text, major) {
  if (!text) return;
  game.narratorFeed = game.narratorFeed || [];
  game.narrSeq = (game.narrSeq || 0) + 1;
  game.narratorFeed.push({ id: game.narrSeq, key, text, audio: audioName(key), major: !!major, at: new Date().toISOString() });
  game.lastNarratorAt = Date.now();
  if (game.narratorFeed.length > 24) game.narratorFeed = game.narratorFeed.slice(-24);
}

/** Pure check: has the room gone quiet enough for an aside? (No mutation.) */
function shouldAside(game, nowMs) {
  const now = nowMs || Date.now();
  if (!ASIDE_PHASES.has(game.phase) || game.paused) return false;
  const last = game.lastNarratorAt || Date.parse(game.phaseStartedAt || game.createdAt || 0) || 0;
  return now - last >= ASIDE_QUIET_MS;
}

/** Fire a quiet-stretch aside if due. Mutates game; returns true if one fired. */
function maybeAside(game, nowMs, pack) {
  if (!shouldAside(game, nowMs)) return false;
  const idx = game.asideIdx = (game.asideIdx || 0) + 1;
  const list = asideList(pack);
  pushNarrator(game, 'aside.' + (((idx - 1) % list.length) + 1), asideText(idx - 1, pack));
  return true;
}

// ---------------------------------------------------------------------------
// 4. INVENTORY — every enumerable line, for the TTS generator.
// ---------------------------------------------------------------------------

/** All narrator lines that can be pre-rendered (names/props are enumerable). */
function narratorInventory(pack) {
  const items = [];
  items.push({ key: 'attention', text: attentionLine(pack) });
  items.push({ key: 'warn.2min', text: warn2minLine(pack) });
  items.push({ key: 'awards.intro', text: awardsIntroLine(pack) });
  items.push({ key: 'photo', text: photoLine(pack) });
  items.push({ key: 'blackout.start', text: blackoutStartLine(pack) });
  items.push({ key: 'blackout.end', text: blackoutEndLine(pack) });
  const propIds = Object.keys(propCatalog(pack));
  for (const propId of propIds) {
    const t = blackoutMovedLine(propId, pack);
    if (t) items.push({ key: 'blackout.moved.' + propId, text: t });
  }
  for (const propId of propIds) {
    const t = foundLine(propId, pack);
    if (t) items.push({ key: 'found.' + propId, text: t });
  }
  for (const c of pack.cast || []) {
    items.push({ key: 'suspect.' + c.id, text: suspectLine(c.name, pack) });
  }
  items.push({ key: 'subpoena.yes', text: subpoenaLine('yes', pack) });
  items.push({ key: 'subpoena.no', text: subpoenaLine('no', pack) });
  items.push({ key: 'final.closed', text: finalClosedLine(pack) });
  asideList(pack).forEach((t, i) => items.push({ key: 'aside.' + (i + 1), text: asideText(i, pack) }));
  return items;
}

module.exports = {
  ASIDE_QUIET_MS, ASIDE_PHASES,
  monologue,
  attentionLine, warn2minLine, awardsIntroLine, photoLine, photoScreenLine,
  blackoutStartLine, blackoutEndLine, blackoutMovedLine, medicalScreenLine,
  foundLine, suspectLine, subpoenaLine, finalClosedLine,
  asideList, asideText,
  pushNarrator, shouldAside, maybeAside, narratorInventory,
};
