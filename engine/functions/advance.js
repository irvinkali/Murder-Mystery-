'use strict';
/* POST /api/advance — host phase & clock control.
 *   { partyCode, hostToken, phase? }          advance now (next, or explicit)
 *   { partyCode, hostToken, pause: bool }     pause/resume the phase clock
 *   { partyCode, hostToken, auto: bool }      turn auto-advance on/off
 *   { partyCode, hostToken, extend: minutes } add time to the current phase
 *
 * Phases otherwise advance THEMSELVES on the schedule (see lib/phases.js);
 * these are the host's overrides. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { PHASES, phaseInfo, loadRuntimePack } = require('../lib/runtime');
const { performAdvance } = require('../lib/phases');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken, phase, pause, auto, extend } = parseBody(event);
  if (!partyCode) return bad('partyCode required');
  const code = partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');

  const pack = loadRuntimePack();

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
  return ok({ phase: next.phase, phaseName: phaseInfo(next.phase).name });
};
