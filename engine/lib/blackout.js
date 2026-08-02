'use strict';
/*
 * The Blackout — the mid-game set-piece from the design's branching hooks.
 *
 * Sixty seconds of darkness on every screen, announced by the narrator, after
 * which one exhibit has officially "moved." Who moved in the dark becomes a
 * social deduction minigame; the app ties meaning to items, not locations, so
 * the move is pure (delicious) social pressure.
 *
 * Scheduling: arms automatically a few minutes after the Phase-3 "who
 * benefits" poll closes (the design's "fires by earlier poll tilt"), and the
 * host can also trigger it on demand. Fires at most once per game. Evaluated
 * lazily on state polls, like the phase clock.
 */

const { pushNarrator, BLACKOUT_START, BLACKOUT_END, blackoutMovedLine } = require('./narrator');

const BLACKOUT_MS = 60 * 1000;
const ARM_DELAY_MS = 3 * 60 * 1000;   // after the benefits poll closes
const BLACKOUT_PHASES = new Set([3, 4]);

/** Called when the benefits poll closes: arm the auto-trigger. */
function armBlackout(game, nowMs) {
  if (game.blackout || game.blackoutDueAt) return;
  game.blackoutDueAt = (nowMs || Date.now()) + ARM_DELAY_MS;
}

/** Pure check: 'start' | 'end' | null. */
function blackoutDue(game, nowMs) {
  const now = nowMs || Date.now();
  if (game.blackout) {
    if (!game.blackout.ended && now >= game.blackout.endsAt) return 'end';
    return null;
  }
  if (game.blackoutDueAt && now >= game.blackoutDueAt && BLACKOUT_PHASES.has(game.phase) && !game.paused) return 'start';
  return null;
}

function pickMovedProp(pack, game) {
  const unfound = pack.props.filter((p) => !(game.discovered && game.discovered[p]));
  const pool = unfound.length ? unfound : pack.props;
  // Deterministic-ish pick without Math.random dependence on callers: rotate on narrSeq.
  return pool[(game.narrSeq || 0) % pool.length];
}

/** Start now (auto or host-triggered). Mutates game. */
function startBlackout(pack, game, nowMs) {
  if (game.blackout) return false;
  const now = nowMs || Date.now();
  game.blackoutDueAt = null;
  game.blackout = { startedAt: now, endsAt: now + BLACKOUT_MS, movedProp: pickMovedProp(pack, game), ended: false };
  pushNarrator(game, 'blackout.start', BLACKOUT_START, true); // major: bell first
  return true;
}

/** End + aftermath lines. Mutates game. */
function endBlackout(game) {
  if (!game.blackout || game.blackout.ended) return false;
  game.blackout.ended = true;
  pushNarrator(game, 'blackout.end', BLACKOUT_END);
  const moved = blackoutMovedLine(game.blackout.movedProp);
  if (moved) pushNarrator(game, 'blackout.moved.' + game.blackout.movedProp, moved);
  return true;
}

/** Apply whatever blackoutDue says. Mutates game; returns what fired. */
function maybeBlackout(pack, game, nowMs) {
  const due = blackoutDue(game, nowMs);
  if (due === 'start') startBlackout(pack, game, nowMs);
  else if (due === 'end') endBlackout(game);
  return due;
}

/** Is the room dark right now? */
function blackoutActive(game, nowMs) {
  const now = nowMs || Date.now();
  return !!(game.blackout && !game.blackout.ended && now < game.blackout.endsAt);
}

module.exports = { BLACKOUT_MS, ARM_DELAY_MS, armBlackout, blackoutDue, startBlackout, endBlackout, maybeBlackout, blackoutActive };
