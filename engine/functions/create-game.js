'use strict';
/* POST /api/create-game  { hostName? } -> { partyCode, hostToken }
 * Creates a party and SEALS a randomly selected solution variant. The variant
 * is never returned here or in any player-facing response before the reveal. */

const { ok, bad, preflight, parseBody, partyCode, token } = require('../lib/api');
const { putGame } = require('../lib/store');
const { loadRuntimePack, selectVariant } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { hostName } = parseBody(event);
  const pack = loadRuntimePack();

  const code = partyCode();
  const hostToken = token();
  const sealedVariant = selectVariant(pack); // server-authoritative, sealed

  const game = {
    partyCode: code,
    hostToken,
    createdAt: new Date().toISOString(),
    phase: 1,
    variant: sealedVariant,
    hostName: hostName || 'Host',
    players: {},
    assignments: {},
    discovered: {},
    polls: {},
    log: [{ at: new Date().toISOString(), kind: 'created' }],
  };
  await putGame(code, game);

  // NOTE: sealedVariant is intentionally NOT returned.
  return ok({ partyCode: code, hostToken, phase: 1 });
};
