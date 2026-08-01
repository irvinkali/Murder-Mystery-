'use strict';
/*
 * Phase-transition effects: what everyone sees and what each player privately
 * receives when the game moves to a new phase.
 *
 *  - Narration card (all players + gallery): a distinct in-world "what happens
 *    now" beat per phase. Phase 1 embeds the props fairness disclosure verbatim
 *    from the content pack.
 *  - Script lines (private): each player gets ONLY their character's line for
 *    the new phase (never future phases), as an in-world note. Phase 2 is the
 *    single reaction line, delivered with the discovery/unveiling.
 *  - Find-hints (Section 2): at Phase 3, each still-unfound prop's private hint
 *    is dealt to the two least-active players (their idle rescue). At Phase 4,
 *    each still-unfound prop's [SCREEN] narrator line goes to the gallery. Found
 *    props are skipped; if everything is found, nothing is served.
 *
 * No plot literals here — all text flows from the pack. Nothing references
 * internal prop IDs.
 */

const { mergeDrops } = require('./branching');
const { audioName, AUDIO_KEYS } = require('./runtime');
const { MONOLOGUES, narratorInventory } = require('./narrator');

// In-world narration beats — the velvet emcee's phase monologues (see
// lib/narrator.js; engine copy, paced and theatrical, no plot content).
const NARRATION = MONOLOGUES;

/** Build the phase narration card (Phase 1 appends the fairness disclosure). */
function narrationFor(pack, phase) {
  let text = NARRATION[phase] || '';
  if (phase === 1 && pack.fairnessDisclosure) text += '\n\n' + pack.fairnessDisclosure;
  return text;
}

/** Players ordered least-active first (fewest prop finds, then stalest activity). */
function leastActive(game, n) {
  return Object.entries(game.players)
    .map(([code, p]) => ({ code, scans: p.scanCount || 0, seen: p.lastActive || p.joinedAt || '' }))
    .sort((a, b) => (a.scans - b.scans) || a.seen.localeCompare(b.seen))
    .slice(0, n)
    .map((x) => x.code);
}

function unfoundProps(pack, game) {
  return pack.props.filter((p) => !(game.discovered && game.discovered[p]));
}

/**
 * Apply everything that happens on entering `newPhase`. Mutates `game`.
 * Returns a spoiler-free summary of what fired (counts only).
 */
function applyPhaseTransition(pack, game, newPhase) {
  game.phase = newPhase;

  // 1) Narration to all + gallery (with its opaque audio filename).
  game.narration = {
    phase: newPhase,
    text: narrationFor(pack, newPhase),
    audio: audioName(AUDIO_KEYS.phase(newPhase)),
    at: new Date().toISOString(),
  };
  game.lastNarratorAt = Date.now(); // a monologue counts as narrator activity

  // 2) Script lines are served LIVE per phase (see state.js `you.lines`) so a
  //    player only ever sees the current phase's line — never future phases.

  // 3) Find-hints for still-unfound props.
  let hintCount = 0;
  const unfound = unfoundProps(pack, game);
  if (pack.findHints && unfound.length) {
    if (newPhase === 3) {
      // Deal each unfound prop's private hint across the two least-active players.
      const recipients = leastActive(game, 2);
      if (recipients.length) {
        const drops = [];
        unfound.forEach((propId, i) => {
          const h = pack.findHints[propId];
          if (!h || !h.ph3) return;
          const code = recipients[i % recipients.length];
          drops.push({ targetCode: code, drop: { kind: 'hint', text: h.ph3 } });
          hintCount++;
        });
        if (drops.length) mergeDrops(game, drops);
      }
    } else if (newPhase === 4) {
      // Each still-unfound prop's [SCREEN] narrator line goes to the gallery.
      game.screenCards = game.screenCards || [];
      for (const propId of unfound) {
        const h = pack.findHints[propId];
        if (!h || !h.ph4) continue;
        game.screenCards.push({ kind: 'hint', text: h.ph4, audio: audioName(AUDIO_KEYS.screenHint(propId)), at: new Date().toISOString() });
        hintCount++;
      }
    }
  }

  return { phase: newPhase, hintCount, unfound: unfound.length };
}

/**
 * Every gallery narration string with its logical audio key — the generator
 * uses this to render one opaque mp3 per line. Returns [{ key, text }].
 * (Text is returned for synthesis only; callers must never print it.)
 */
function narrationInventory(pack) {
  const items = [];
  for (let n = 1; n <= 6; n++) items.push({ key: AUDIO_KEYS.phase(n), text: narrationFor(pack, n) });
  if (pack.findHints) {
    for (const [propId, h] of Object.entries(pack.findHints)) {
      if (h && h.ph4) items.push({ key: AUDIO_KEYS.screenHint(propId), text: h.ph4 });
    }
  }
  items.push({ key: AUDIO_KEYS.medical(), text: 'The files are open.' });
  for (const v of pack.variants || []) {
    items.push({ key: AUDIO_KEYS.revealTitle(v.letter), text: `Variant ${v.letter}. ${v.killer}.` });
    if (v.method) items.push({ key: AUDIO_KEYS.revealMethod(v.letter), text: v.method });
  }
  // The narrator's live interjections are enumerable too (props × cast × votes
  // × asides), so they pre-render in the docent voice like everything else.
  items.push(...narratorInventory(pack));
  return items;
}

module.exports = { NARRATION, narrationFor, leastActive, unfoundProps, applyPhaseTransition, narrationInventory };
