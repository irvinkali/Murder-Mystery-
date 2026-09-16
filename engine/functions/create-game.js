'use strict';
/* POST /api/create-game  { hostName? } -> { partyCode, hostToken }
 * Creates a party and SEALS a randomly selected solution variant. The variant
 * is never returned here or in any player-facing response before the reveal. */

const { ok, bad, preflight, parseBody, partyCode, token } = require('../lib/api');
const { connect, putGame } = require('../lib/store');
const { loadRuntimePack, selectVariant } = require('../lib/runtime');
const { sealDeduction } = require('../lib/deduction');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { hostName } = parseBody(event);
  const pack = loadRuntimePack();

  const code = partyCode();
  const hostToken = token();
  const sealedVariant = selectVariant(pack); // server-authoritative, sealed
  // Everything else about tonight that is drawn rather than authored: which two
  // of the answer set are cleared in public and in what order, whose hands the
  // token passed through besides the one that matters, which of the two naming
  // links carries the name, and which false lead runs tonight. Sealed exactly
  // like the variant and never returned before the reveal.
  const seal = sealDeduction(pack, sealedVariant);

  const game = {
    partyCode: code,
    hostToken,
    createdAt: new Date().toISOString(),
    // The party opens in the LOBBY: guests can claim their character and read
    // the public half of it, but the evening itself has not started. The host
    // ends it with Open the doors, which is when the phase clock really begins.
    lobby: true,
    phase: 1,
    phaseStartedAt: new Date().toISOString(),
    autoAdvance: true, // the app runs the clock; host can pause/extend/turn off
    variant: sealedVariant,
    seal,
    hostName: hostName || 'Host',
    players: {},
    assignments: {},
    discovered: {},
    polls: {},
    log: [{ at: new Date().toISOString(), kind: 'created' }],
  };
  await putGame(code, game);

  // NOTE: sealedVariant and seal are intentionally NOT returned.
  return ok({ partyCode: code, hostToken, phase: 1, lobby: true });
};
