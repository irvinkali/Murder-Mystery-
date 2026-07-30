'use strict';
/* POST /api/advance — host phase control.
 *   { partyCode, hostToken, phase? }   advance to next phase (or an explicit one)
 *   { partyCode, hostToken, pause:true|false }   pause/resume the phase clock
 *
 * On a phase change it: closes the leaving phase's scheduled polls (running
 * their consequences), applies the new phase's transition effects (narration,
 * private script lines, find-hints), then opens the new phase's polls. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { PHASES, phaseInfo } = require('../lib/runtime');
const { applyPhaseTransition } = require('../lib/phases');
const { autoOpen, autoClose } = require('../lib/pollsched');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken, phase, pause } = parseBody(event);
  if (!partyCode) return bad('partyCode required');
  const code = partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');

  const pack = require('../lib/runtime').loadRuntimePack();

  // Pause / resume the (display-only) phase clock.
  if (typeof pause === 'boolean') {
    const next = await updateGame(code, (g) => {
      const now = Date.now();
      if (pause && !g.paused) { g.paused = true; g.pausedAt = now; }
      else if (!pause && g.paused) { g.pauseAccumMs = (g.pauseAccumMs || 0) + (now - (g.pausedAt || now)); g.paused = false; g.pausedAt = null; }
      return g;
    });
    return ok({ paused: next.paused });
  }

  const max = PHASES.length;
  const target = typeof phase === 'number' ? phase : game.phase + 1;
  if (target < 1 || target > max) return bad(`phase must be 1..${max}`);

  const next = await updateGame(code, (g) => {
    const from = g.phase;
    if (target !== from) autoClose(pack, g, from);       // resolve leaving-phase polls
    applyPhaseTransition(pack, g, target);               // sets phase + narration/script/hints
    autoOpen(pack, g, target);                           // open this phase's polls
    g.phaseStartedAt = new Date().toISOString();
    g.paused = false; g.pausedAt = null; g.pauseAccumMs = 0;
    g.log.push({ at: new Date().toISOString(), kind: 'phase', phase: target });
    return g;
  });

  return ok({ phase: next.phase, phaseName: phaseInfo(next.phase).name });
};
