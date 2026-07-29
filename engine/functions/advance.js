'use strict';
/* POST /api/advance  { partyCode, hostToken, phase? } -> { phase }
 * Host-only. Advances to the next phase, or to an explicit phase number. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { PHASES, phaseInfo } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken, phase } = parseBody(event);
  if (!partyCode) return bad('partyCode required');
  const code = partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');

  const max = PHASES.length;
  const target = typeof phase === 'number' ? phase : game.phase + 1;
  if (target < 1 || target > max) return bad(`phase must be 1..${max}`);

  const next = await updateGame(code, (g) => {
    g.phase = target;
    g.log.push({ at: new Date().toISOString(), kind: 'phase', phase: target });
    return g;
  });

  return ok({ phase: next.phase, phaseName: phaseInfo(next.phase).name });
};
