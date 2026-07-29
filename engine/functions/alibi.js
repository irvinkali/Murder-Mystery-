'use strict';
/* POST /api/alibi — the "Where were you at 6:40?" public-question flow (§2/§4.2).
 *   { action:'submit',  partyCode, personalCode, answer }  (player logs an answer)
 *   { action:'resolve', partyCode, hostToken }             (host closes; flag fires
 *                                                           privately if the variant
 *                                                           target contradicts)
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack } = require('../lib/runtime');
const { computeAlibi, mergeDrops } = require('../lib/branching');

const ALIBI_PHASE = 3;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  if (!b.partyCode || !b.action) return bad('partyCode and action required');
  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');

  if (b.action === 'submit') {
    if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join first');
    if (typeof b.answer !== 'string' || !b.answer.trim()) return bad('answer required');
    await updateGame(code, (g) => {
      g.alibi = g.alibi || {};
      g.alibi[b.personalCode] = b.answer.trim().slice(0, 500);
      if (g.players[b.personalCode]) g.players[b.personalCode].lastActive = new Date().toISOString();
      return g;
    });
    return ok({ submitted: true });
  }

  if (b.action === 'resolve') {
    if (b.hostToken !== game.hostToken) return forbidden('host only');
    if (game.phase !== ALIBI_PHASE) return bad(`alibi resolves in phase ${ALIBI_PHASE}`);
    await updateGame(code, (g) => {
      g.branchFired = g.branchFired || {};
      if (g.branchFired.alibi) return g; // once per game
      const pack = loadRuntimePack();
      const res = computeAlibi(pack, g);
      if (res) mergeDrops(g, [res]);
      g.branchFired.alibi = true;
      return g;
    });
    // Spoiler-safe: do not tell the host whether/whom it flagged.
    return ok({ resolved: true });
  }

  return bad('unknown action');
};
