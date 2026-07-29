'use strict';
/* GET /api/state?partyCode=..&personalCode=..
 * Returns public game state + (if a valid personalCode is given) that player's
 * own private brief. Never returns the sealed variant or other players' briefs
 * before the reveal. */

const { ok, bad, notFound, preflight } = require('../lib/api');
const { getGame } = require('../lib/store');
const { loadRuntimePack, phaseInfo, publicVictimBlurb, publicRoster, playerBrief, killerUnlock } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const q = event.queryStringParameters || {};
  if (!q.partyCode) return bad('partyCode required');

  const game = await getGame(q.partyCode.toUpperCase());
  if (!game) return notFound('no such party');

  const pack = loadRuntimePack();

  const publicState = {
    partyCode: game.partyCode,
    phase: game.phase,
    phaseName: phaseInfo(game.phase).name,
    playerCount: Object.keys(game.players).length,
    victim: publicVictimBlurb(pack),
    roster: publicRoster(pack).map((c) => ({
      ...c,
      claimed: Boolean(game.assignments[c.id]),
    })),
    discoveredProps: Object.keys(game.discovered),
    polls: Object.entries(game.polls).map(([id, p]) => ({
      id, question: p.question, options: p.options, closed: p.closed,
      total: Object.keys(p.votes).length,
    })),
  };

  let you = null;
  if (q.personalCode && game.players[q.personalCode]) {
    const me = game.players[q.personalCode];
    you = {
      name: me.name,
      character: playerBrief(pack, me.characterId),
      // The hybrid-killer unlock: present ONLY for the killer's own device from
      // Phase 3 onward. null for everyone else — the variant never leaks here.
      killer: killerUnlock(pack, game.variant, me.characterId, game.phase),
    };
  }

  return ok({ state: publicState, you });
};
