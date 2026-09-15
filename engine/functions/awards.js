'use strict';
/* POST /api/awards - the superlatives, after the reveal.
 *   { action:'open', partyCode, hostToken }
 *   { action:'vote', partyCode, personalCode, awardId, characterId }
 *
 * The awards round belongs to the end of the night: the host opens it once the
 * reveal has played, and voting is refused before that, so nothing here can
 * touch the mystery while the mystery is still running.
 *
 * One vote per seat per award, for somebody else in the room. Votes live under
 * their own key on the game object, apart from the game polls and apart from
 * the lobby questions, and only counts and winners are ever returned.
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { loadRuntimePack } = require('../lib/runtime');
const { findAward, isSeated, recordAwardVote, awardsPublic } = require('../lib/awards');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  if (!b.partyCode || !b.action) return bad('partyCode and action required');

  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (game.lobby) return bad('the party has not started yet');

  const pack = loadRuntimePack();

  if (b.action === 'open') {
    if (b.hostToken !== game.hostToken) return forbidden('host only');
    if (!game.reveal) return forbidden('the superlatives open once the reveal has played');
    const next = await updateGame(code, (g) => {
      if (!g.awardsOpen) { g.awardsOpen = true; g.awardsOpenedAt = new Date().toISOString(); }
      return g;
    });
    return ok({ open: true, awards: awardsPublic(pack, next || game) });
  }

  if (b.action === 'vote') {
    if (!game.reveal) return forbidden('the superlatives open once the reveal has played');
    if (!game.awardsOpen) return forbidden('the superlatives are not open yet');
    if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join the party first');

    const award = findAward(b.awardId);
    if (!award) return notFound('no such award');
    if (!b.characterId || !isSeated(game, b.characterId)) return bad('pick somebody who is in the room');
    if (game.players[b.personalCode].characterId === b.characterId) return bad('pick somebody other than yourself');

    const next = await updateGame(code, (g) => {
      recordAwardVote(g, award.id, b.personalCode, b.characterId);
      if (g.players[b.personalCode]) g.players[b.personalCode].lastActive = new Date().toISOString();
      return g;
    });
    // Counts and winners only. There is no shape here that could say who voted.
    return ok({ awardId: award.id, voted: true, awards: awardsPublic(pack, next || game) });
  }

  return bad('unknown action');
};
