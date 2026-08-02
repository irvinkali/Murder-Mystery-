'use strict';
/*
 * The Narrator — a "velvet emcee" who is present in the room all night.
 *
 * Two kinds of speech:
 *  1. Phase monologues (the "what happens now" cards) — fuller, theatrical,
 *     paced with deliberate ellipses so the TTS performs rather than reads.
 *  2. Live interjections — reactions to real events (an exhibit found, the
 *     room's suspicion landing on someone, votes resolving) plus atmospheric
 *     asides when the room goes quiet.
 *
 * SPOILER-SAFETY: this file contains ONLY templates and engine copy. Character
 * names are inserted at runtime from the pack; prop references use the public
 * physical catalog labels. Nothing here names anyone, so the spoiler scanner
 * stays clean. Because the name/prop space is enumerable, nearly every line can
 * still be pre-rendered by the TTS generator under an opaque filename — the
 * browser voice is only the fallback.
 */

const { audioName, PROP_CATALOG, exhibitNumber } = require('./runtime');

// Spoken call-to-attention, played after the gallery bell and before any MAJOR
// announcement — so a room mid-conversation has a beat to quiet down.
// Pre-rendered once under the key 'attention'.
const ATTENTION = 'Ladies and gentlemen — your attention, please.';

// ---------------------------------------------------------------------------
// 1. PHASE MONOLOGUES — velvet emcee, funny-dark, paced for performance.
// ---------------------------------------------------------------------------
const MONOLOGUES = {
  1: 'Good evening, my darlings, and welcome to Galerie Noir. It\'s opening night. The wine is cold, the light is flattering, and every one of you walked in carrying something you\'d rather not discuss. Perfect — that\'s what galleries are for. Mingle. Admire. Lie beautifully. The art is watching, and so am I.',
  2: 'The final piece is unveiled — and it seems our guest of honour won\'t be taking questions. Don\'t crowd. Give the moment its dignity; she\'d have insisted. The doors are locked now, and until we know whose hands did this, none of you are just guests anymore. You\'re material.',
  3: 'Now the real work begins. Circle one another. Ask the questions polite society won\'t allow — tonight, rudeness is a virtue and curiosity is the dress code. This gallery keeps its secrets in plain sight: behind frames, under cushions, in rooms you weren\'t invited into. Go get invited. And keep your stories straight — someone in this room is editing theirs right now.',
  4: 'Feel that? The evening is sharpening. The pleasantries are spent, the alibis are wearing thin, and somewhere in this gallery the one thing that matters is waiting to be held up to the light. Find it, and this stops being a guessing game and becomes a proof.',
  5: 'Enough. Set down your glasses. Say your accusations out loud — to the room, to each other\'s faces. Then, in private, each of you will cast a ballot with a single name on it. Choose carefully. The room is listening, and the room remembers everything.',
  6: 'The ballots are sealed. The gallery has one piece left to show you: the truth, in its original frame. Eyes on the screen. This is The Last Exhibit.',
};

// ---------------------------------------------------------------------------
// 2. LIVE INTERJECTIONS — enumerable templates, filled from the pack.
// ---------------------------------------------------------------------------

// Per-prop discovery flourishes. Physical descriptions only (public catalog).
const FOUND_FLOURISH = {
  P1: 'An abandoned glass, far from the bar, still wearing someone\'s shade. Glasses don\'t walk. They\'re carried, and then they\'re left.',
  P2: 'A little book of days with one day torn out. People only tear out the pages that testify.',
  P3: 'A bottle from someone\'s bathroom shelf, its label scratched nearly to silence. Nearly.',
  P4: 'A sealed black envelope. Sealed things are promises — and someone broke one to hide this.',
  P5: 'The gloves of someone who handles art, marked by work they never mentioned doing.',
  P6: 'A photograph with one face scratched away. We only erase the faces we can\'t stop seeing.',
  P7: 'A staff credential on a snapped lanyard. Doors remember, even when people are in too much of a hurry to.',
};

function foundLine(propId) {
  const cat = PROP_CATALOG[propId];
  if (!cat) return null;
  return `Well — someone has a good eye. ${FOUND_FLOURISH[propId] || `They've found the ${cat.label.toLowerCase()}.`} Take a close look, and decide who you tell.`;
}

function suspectLine(name) {
  return `The votes are in, and how awkward: the room's gaze has settled, politely of course, on ${name}. Compose yourself, dear. Suspicion is only attention wearing gloves.`;
}

function subpoenaLine(outcome) {
  return outcome === 'yes'
    ? 'The vote carries. The files are open. And files never forgive — they simply wait to be read aloud.'
    : 'The room votes for discretion. How civilised. The files stay shut, for now — though secrets tend to leak on their own schedule.';
}

function finalClosedLine() {
  return 'And there it is: the last ballot, cast and counted. Whatever you believe, you believe it in ink now. In a moment, the gallery answers back.';
}

// Spoken two-minute warning before an automatic phase change (ambient, no bell).
const WARN_2MIN = 'Two minutes, everyone. Finish your sentences — the evening moves on with or without you.';

// Spoken lead-in to the awards, after the reveal itself.
const AWARDS_INTRO = 'But before you compare notes over the good wine — the house has a few honours to bestow.';

// The blackout set-piece (60 seconds of dark, then an inventory discrepancy).
const BLACKOUT_START = 'Oh dear. It seems the gallery has lost its lights. Stay calm. Stay where you are. Or don\'t — I can\'t see you either.';
const BLACKOUT_END = 'And — light. Welcome back. Do take a moment to notice who\'s standing somewhere new.';
function blackoutMovedLine(propId) {
  const n = exhibitNumber(propId);
  return n ? `One more thing. Exhibit ${n} is not where it was a minute ago. Curious.` : null;
}

// Atmospheric asides for quiet stretches — generic, funny-dark, re-usable.
const ASIDES = [
  'Do refresh your drinks. Steady hands are wasted on the innocent.',
  'Such a lovely hush. Rooms only go this quiet when someone is rehearsing.',
  'Admire the art, by all means. But notice who keeps admiring the exits.',
  'A word of advice from the house: the guest who asks no questions already knows the answers.',
  'Someone here has told the same story twice tonight, word for word. Memorised things are rarely true things.',
  'The lighting in here flatters everyone. Consider what else in this room might be doing the same.',
  'Whisper if you must. Whispers carry beautifully in a gallery — the acoustics were expensive.',
  'It\'s a fine evening to watch hands, not faces. Faces audition. Hands confess.',
];
const ASIDE_QUIET_MS = 4 * 60 * 1000; // a quiet stretch = ~4 min with no narrator activity
const ASIDE_PHASES = new Set([2, 3, 4, 5]);

function asideText(idx) {
  return ASIDES[((idx % ASIDES.length) + ASIDES.length) % ASIDES.length];
}

// ---------------------------------------------------------------------------
// 3. THE FEED — how interjections reach the gallery.
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
function maybeAside(game, nowMs) {
  if (!shouldAside(game, nowMs)) return false;
  const idx = game.asideIdx = (game.asideIdx || 0) + 1;
  pushNarrator(game, 'aside.' + (((idx - 1) % ASIDES.length) + 1), asideText(idx - 1));
  return true;
}

// ---------------------------------------------------------------------------
// 4. INVENTORY — every enumerable line, for the TTS generator.
// ---------------------------------------------------------------------------

/** All narrator lines that can be pre-rendered (names/props are enumerable). */
function narratorInventory(pack) {
  const items = [];
  items.push({ key: 'attention', text: ATTENTION });
  items.push({ key: 'warn.2min', text: WARN_2MIN });
  items.push({ key: 'awards.intro', text: AWARDS_INTRO });
  items.push({ key: 'blackout.start', text: BLACKOUT_START });
  items.push({ key: 'blackout.end', text: BLACKOUT_END });
  for (const propId of Object.keys(PROP_CATALOG)) {
    const t = blackoutMovedLine(propId);
    if (t) items.push({ key: 'blackout.moved.' + propId, text: t });
  }
  for (const propId of Object.keys(PROP_CATALOG)) {
    const t = foundLine(propId);
    if (t) items.push({ key: 'found.' + propId, text: t });
  }
  for (const c of pack.cast || []) {
    items.push({ key: 'suspect.' + c.id, text: suspectLine(c.name) });
  }
  items.push({ key: 'subpoena.yes', text: subpoenaLine('yes') });
  items.push({ key: 'subpoena.no', text: subpoenaLine('no') });
  items.push({ key: 'final.closed', text: finalClosedLine() });
  ASIDES.forEach((t, i) => items.push({ key: 'aside.' + (i + 1), text: t }));
  return items;
}

module.exports = {
  MONOLOGUES, ASIDES, ASIDE_QUIET_MS, ATTENTION, WARN_2MIN, AWARDS_INTRO,
  BLACKOUT_START, BLACKOUT_END, blackoutMovedLine,
  foundLine, suspectLine, subpoenaLine, finalClosedLine, asideText,
  pushNarrator, shouldAside, maybeAside, narratorInventory,
};
