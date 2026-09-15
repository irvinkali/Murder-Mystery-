'use strict';
/* POST /api/reveal  { partyCode, hostToken }
 * Host-only, Phase 6 only, and ONLY after the mandatory final vote has closed.
 * Publishes the sealed solution to the gallery (everyone sees it) and returns
 * it to the host. The host keeps advance/pause control.
 *
 * Autopilot can fire the same reveal for a host who is busy being a character;
 * both paths go through lib/finale so it is built once and happens once. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { loadRuntimePack } = require('../lib/runtime');
const { finalVoteClosed } = require('../lib/pollsched');
const { applyReveal, REVEAL_PHASE } = require('../lib/finale');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken } = parseBody(event);
  if (!partyCode) return bad('partyCode required');

  const game = await getGame(partyCode.toUpperCase());
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');
  if (game.phase < REVEAL_PHASE) return forbidden(`the reveal unlocks in phase ${REVEAL_PHASE}`);
  if (!finalVoteClosed(game)) return forbidden('the final vote must close before the reveal');

  const pack = loadRuntimePack();
  let solution = null;
  await updateGame(game.partyCode, (g) => { solution = applyReveal(pack, g); return g; });
  if (!solution) return bad('sealed variant missing');
  return ok(solution);
};
