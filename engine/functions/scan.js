'use strict';
/* POST /api/scan  { partyCode, personalCode, propId } -> prop reveal
 * Resolves what the prop shows for the sealed variant at the current phase.
 * The keystone is never revealed before Phase 4. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, resolvePropScan } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, personalCode, propId } = parseBody(event);
  if (!partyCode || !propId) return bad('partyCode and propId required');

  const code = partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (!personalCode || !game.players[personalCode]) return forbidden('join the party first');

  const pack = loadRuntimePack();
  const reveal = resolvePropScan(pack, game.variant, propId, game.phase);

  await updateGame(code, (g) => {
    const d = g.discovered[propId] || { count: 0, firstAt: new Date().toISOString() };
    d.count += 1;
    g.discovered[propId] = d;
    if (g.players[personalCode]) {
      g.players[personalCode].lastActive = new Date().toISOString();
      g.players[personalCode].scanCount = (g.players[personalCode].scanCount || 0) + 1;
    }
    g.log.push({ at: new Date().toISOString(), kind: 'scan', propId, by: personalCode });
    return g;
  });

  return ok({ reveal });
};
