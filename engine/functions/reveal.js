'use strict';
/* POST /api/reveal  { partyCode, hostToken } -> sealed solution
 * The ONLY endpoint that returns the sealed variant, and ONLY once the game has
 * reached the Reveal phase (6). Host-authenticated. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame } = require('../lib/store');
const { loadRuntimePack, getVariant, KEYSTONE_PHASE } = require('../lib/runtime');
const { PHASES } = require('../lib/runtime');

const REVEAL_PHASE = PHASES[PHASES.length - 1].n; // 6

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken } = parseBody(event);
  if (!partyCode) return bad('partyCode required');

  const game = await getGame(partyCode.toUpperCase());
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');
  if (game.phase < REVEAL_PHASE) return forbidden(`the reveal unlocks in phase ${REVEAL_PHASE}`);

  const pack = loadRuntimePack();
  const v = getVariant(pack, game.variant);
  if (!v) return bad('sealed variant missing');

  return ok({
    variant: v.letter,
    killer: v.killer,
    motive: v.motive,
    method: v.method,
    evidence: v.evidence.steps,
    keystonePhase: KEYSTONE_PHASE,
  });
};
