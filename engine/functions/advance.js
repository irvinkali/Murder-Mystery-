'use strict';
/* POST /api/advance — host phase & clock control.
 *   { partyCode, hostToken, phase? }          advance now (next, or explicit)
 *   { partyCode, hostToken, backToLobby: true } undo a start, keeping the casting
 *   { partyCode, hostToken, pause: bool }     pause/resume the phase clock
 *   { partyCode, hostToken, auto: bool }      turn auto-advance on/off
 *   { partyCode, hostToken, autopilot: bool } run the night for her (or stop)
 *   { partyCode, hostToken, extend: minutes } add time to the current phase
 *
 * Phases otherwise advance THEMSELVES on the schedule (see lib/phases.js);
 * these are the host's overrides. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { PHASES, phaseName, loadRuntimePack } = require('../lib/runtime');
const { performAdvance } = require('../lib/phases');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken, phase, pause, auto, autopilot, extend, blackout, photo, openDoors, backToLobby } = parseBody(event);
  if (!partyCode) return bad('partyCode required');
  const code = partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');

  const pack = loadRuntimePack();

  // Open the doors: the lobby ends, the phase clock starts from now rather
  // than from whenever the party was created, and Phase 1 speaks.
  if (openDoors === true) {
    if (!game.lobby) return bad('the doors are already open');
    const { pushNarrator } = require('../lib/narrator');
    await updateGame(code, (g) => {
      if (!g.lobby) return g;
      g.lobby = false;
      g.phase = 1;
      g.phaseStartedAt = new Date().toISOString();
      g.paused = false; g.pausedAt = null; g.pauseAccumMs = 0;
      g.log.push({ at: new Date().toISOString(), kind: 'doors' });
      return g;
    });
    return ok({ lobby: false, phase: 1 });
  }

  // Back to the lobby: undo a start. The seats, the characters they hold and
  // the typed-in reservations survive; everything the evening produced does
  // not, and the sealed variant is drawn again so a rehearsal cannot teach
  // anybody the answer to the night they are going to play.
  if (backToLobby === true) {
    if (game.lobby) return bad('the party is already in the lobby');
    const { resetToLobby } = require('../lib/reset');
    const next = await updateGame(code, (g) => resetToLobby(pack, g));
    return ok({ lobby: true, phase: 1, autoAdvance: false, autopilot: false, seats: Object.keys((next && next.players) || {}).length });
  }

  // Every other host control belongs to an evening that has begun.
  if (game.lobby) return bad('the party has not started yet; open the doors first');

  // Pause / resume the phase clock (auto-advance waits while paused).
  if (typeof pause === 'boolean') {
    const next = await updateGame(code, (g) => {
      const now = Date.now();
      if (pause && !g.paused) { g.paused = true; g.pausedAt = now; }
      else if (!pause && g.paused) { g.pauseAccumMs = (g.pauseAccumMs || 0) + (now - (g.pausedAt || now)); g.paused = false; g.pausedAt = null; }
      return g;
    });
    return ok({ paused: next.paused });
  }

  // Host-triggered photo moment: the narrator calls the gallery portrait.
  if (photo === true) {
    const { pushNarrator, photoLine, photoScreenLine } = require('../lib/narrator');
    await updateGame(code, (g) => {
      pushNarrator(g, 'photo', photoLine(pack), true); // major: bell first
      g.screenCards = g.screenCards || [];
      g.screenCards.push({ kind: 'photo', text: photoScreenLine(pack), at: new Date().toISOString() });
      return g;
    });
    return ok({ photo: true });
  }

  // Host-triggered blackout (fires the set-piece now; once per game).
  if (blackout === true) {
    const { startBlackout } = require('../lib/blackout');
    let fired = false;
    await updateGame(code, (g) => { fired = startBlackout(pack, g); return g; });
    return fired ? ok({ blackout: true }) : bad('the blackout has already happened');
  }

  // "Run the night for me." Stored on the game, so it is remembered per party
  // rather than per device: she can pick up a different phone and it is still
  // on. Switching it on switches auto-advance on with it, because a night that
  // runs itself has to change its own phases; the auto toggle still works
  // afterwards, so she can take the clock back without giving up the rest.
  if (typeof autopilot === 'boolean') {
    const next = await updateGame(code, (g) => {
      g.autopilot = autopilot;
      if (autopilot) g.autoAdvance = true;
      g.log.push({ at: new Date().toISOString(), kind: 'autopilot', on: autopilot });
      return g;
    });
    return ok({ autopilot: !!next.autopilot, autoAdvance: next.autoAdvance !== false });
  }

  // Auto-advance on/off.
  if (typeof auto === 'boolean') {
    const next = await updateGame(code, (g) => { g.autoAdvance = auto; return g; });
    return ok({ autoAdvance: next.autoAdvance !== false });
  }

  // Add minutes to the current phase.
  if (typeof extend === 'number' && isFinite(extend) && extend > 0) {
    const next = await updateGame(code, (g) => {
      g.phaseExtraMs = (g.phaseExtraMs || 0) + Math.min(extend, 60) * 60000;
      g.phaseWarned = false; // the two-minute warning re-arms for the new end time
      return g;
    });
    return ok({ extendedMinutes: Math.round((next.phaseExtraMs || 0) / 60000) });
  }

  const max = PHASES.length;
  const target = typeof phase === 'number' ? phase : game.phase + 1;
  if (target < 1 || target > max) return bad(`phase must be 1..${max}`);

  const next = await updateGame(code, (g) => { performAdvance(pack, g, target); return g; });
  return ok({ phase: next.phase, phaseName: phaseName(next.phase, pack) });
};
