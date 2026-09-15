'use strict';
/*
 * AUTOPILOT: "Run the night for me."
 *
 * Kali is playing the busiest character in the room and hosting it at the same
 * time, and there is nobody to hand the phone to. With the switch on, the app
 * runs the evening itself:
 *
 *   - phases change themselves on the clock, with the usual two-minute warning
 *   - the reveal plays itself once Phase 6 has started and the final vote has
 *     closed, instead of waiting for a button
 *   - the superlatives open themselves once the reveal has had time to play
 *   - the 6:40 question closes itself at the end of Asking Around, if she has
 *     not closed it by hand
 *
 * Announcing the winners is deliberately NOT automated: somebody has to be
 * standing there with the gift cards.
 *
 * It is a floor, not a cage. Every manual control keeps working, and every
 * automatic step is guarded on the state it would create, so autopilot can
 * never repeat something the host already did herself. The switch lives on the
 * game object, so it is remembered per party rather than per device, and it is
 * off until she turns it on.
 *
 * There is no background job in serverless, so like auto-advance this runs
 * lazily on every state poll. A guest's phone or the room screen is enough to
 * keep it turning.
 *
 * SPOILER-SAFE: this module fires the reveal, so it handles the solution. It
 * returns only action names and counts; a caller must never print more.
 */

const { fireAlibi } = require('./branching');
const { finalVoteClosed } = require('./pollsched');
const { applyReveal, REVEAL_PHASE } = require('./finale');
const { phaseElapsedMs, phaseAllottedMs } = require('./phases');

/** The phase whose end closes the 6:40 question (Asking Around). */
const ALIBI_PHASE = 3;
/** Close the 6:40 question this long before Asking Around runs out. */
const ALIBI_BEFORE_MS = 60 * 1000;
/** How long the reveal is given to play before the superlatives open over it. */
const REVEAL_PLAYOUT_MS = 90 * 1000;
/** Quiet stretch that counts as the superlative voting having settled. */
const AWARDS_SETTLE_MS = 45 * 1000;

/** Is the app running the night? Off unless the host turned it on. */
function autopilotOn(game) {
  return !!(game && game.autopilot);
}

const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
};

// ---------------------------------------------------------------------------
// WHAT IS DUE. Each of these is a pure question about the game as it stands.
// Every one is false the moment the host has done that thing herself.
// ---------------------------------------------------------------------------

/** The reveal: Phase 6 has started, the final vote has closed, nobody revealed. */
function revealDue(game) {
  if (!autopilotOn(game) || game.lobby) return false;
  if (game.reveal) return false;                       // already done, by hand or by us
  if (game.phase < REVEAL_PHASE) return false;
  return finalVoteClosed(game);
}

/** The superlatives: the reveal is up and has had its time on screen. */
function awardsDue(game, nowMs) {
  if (!autopilotOn(game) || game.lobby) return false;
  if (game.awardsOpen) return false;                   // already open, by hand or by us
  if (!game.reveal) return false;
  const at = ms(game.reveal.at);
  if (at === null) return false;
  return (nowMs || Date.now()) - at >= REVEAL_PLAYOUT_MS;
}

/** The 6:40 question: Asking Around is nearly out of road and it is still open. */
function alibiDue(game, nowMs) {
  if (!autopilotOn(game) || game.lobby) return false;
  if (game.branchFired && game.branchFired.alibi) return false;   // she closed it
  if (game.phase !== ALIBI_PHASE) return false;
  const allotted = phaseAllottedMs(game);
  if (!allotted) return false;
  if (game.paused) return false;
  return allotted - phaseElapsedMs(game, nowMs) <= ALIBI_BEFORE_MS;
}

/** Everything due right now, in the order it would fire. Pure; no mutation. */
function autopilotDue(game, nowMs) {
  const due = [];
  if (alibiDue(game, nowMs)) due.push('alibi');
  if (revealDue(game)) due.push('reveal');
  if (awardsDue(game, nowMs)) due.push('awards');
  return due;
}

/**
 * Run whatever is due. Mutates `game`; returns the list of what actually fired,
 * which is names only, never the reveal it may have just published.
 */
function runAutopilot(pack, game, nowMs) {
  const fired = [];
  if (alibiDue(game, nowMs)) { if (fireAlibi(pack, game)) fired.push('alibi'); }
  if (revealDue(game)) { if (applyReveal(pack, game)) fired.push('reveal'); }
  // Re-checked after the reveal so it cannot open the awards in the same tick:
  // the room gets the reveal to itself for its full playout either way.
  if (awardsDue(game, nowMs)) {
    game.awardsOpen = true;
    game.awardsOpenedAt = new Date().toISOString();
    fired.push('awards');
  }
  if (fired.length) {
    game.log = game.log || [];
    game.log.push({ at: new Date().toISOString(), kind: 'autopilot', did: fired.join(',') });
  }
  return fired;
}

/**
 * Close the 6:40 question on the way out of Asking Around. Autopilot normally
 * catches it on the clock, but a host who advances early would otherwise leave
 * it open forever, because it can only resolve inside its own phase.
 */
function autopilotLeavingPhase(pack, game, fromPhase, toPhase) {
  if (!autopilotOn(game)) return null;
  if (fromPhase !== ALIBI_PHASE || toPhase === ALIBI_PHASE) return null;
  return fireAlibi(pack, game) ? 'alibi' : null;
}

// ---------------------------------------------------------------------------
// THE CUE. One instruction at a time on the host's own drawer, and only when a
// human is genuinely needed. Two moments qualify: asking the room out loud
// where they were at 6:40, and handing out the gift cards. Everything else the
// app can do by itself, so it does, and says nothing.
// ---------------------------------------------------------------------------

/** Has the superlative voting gone quiet, or has everybody voted on everything? */
function awardsSettled(game, nowMs) {
  if (!game.awardsOpen || game.awardsClosed || game.ceremony) return false;
  const now = nowMs || Date.now();
  const opened = ms(game.awardsOpenedAt);
  if (opened === null || now - opened < AWARDS_SETTLE_MS) return false;
  const last = ms(game.awardsLastVoteAt);
  if (last === null) return true;                 // open a while, nobody voting
  return now - last >= AWARDS_SETTLE_MS;          // the flurry is over
}

/**
 * The one thing the host is needed for right now, or null. Host-only: callers
 * must serve this behind the host token and never put it in the public state.
 */
function hostCue(pack, game, nowMs) {
  if (!game || game.lobby) return null;

  // Asking Around: the question has to be asked out loud by a person.
  if (game.phase === ALIBI_PHASE && !(game.branchFired && game.branchFired.alibi)) {
    return {
      id: 'ask-alibi',
      text: 'Ask the room, out loud: where were you at 6:40? Let them answer on their phones, then close it.',
      action: 'alibi-resolve',
      button: 'Close the 6:40 question',
    };
  }

  // The gift cards are in your hand, not the app's.
  if (awardsSettled(game, nowMs)) {
    return {
      id: 'announce-winners',
      text: 'Voting has gone quiet. Announce the winners and hand out the gift cards.',
      action: 'awards-announce',
      button: 'Announce the winners',
    };
  }

  return null;
}

module.exports = {
  autopilotOn, autopilotDue, runAutopilot, autopilotLeavingPhase, hostCue,
  revealDue, awardsDue, alibiDue, awardsSettled,
  ALIBI_PHASE, ALIBI_BEFORE_MS, REVEAL_PLAYOUT_MS, AWARDS_SETTLE_MS,
};
