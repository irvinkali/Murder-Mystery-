'use strict';
/* GET /api/state?partyCode=..&personalCode=..
 * Returns public game state + (if a valid personalCode is given) that player's
 * own private brief. Never returns the sealed variant or other players' briefs
 * before the reveal. */

const { ok, bad, notFound, preflight } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, phaseInfo, publicVictimBlurb, publicRoster, playerBrief, killerUnlock, idleNudge } = require('../lib/runtime');
const { visibleDrops } = require('../lib/branching');

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
    // Public [SCREEN] announcement (e.g. the medical-files reveal), if any.
    screen: game.screen ? game.screen.text : null,
  };

  let you = null;
  if (q.personalCode && game.players[q.personalCode]) {
    const me = game.players[q.personalCode];
    const idleMs = Date.now() - new Date(me.lastActive || me.joinedAt).getTime();
    const unlock = killerUnlock(pack, game.variant, me.characterId, game.phase);
    you = {
      name: me.name,
      character: playerBrief(pack, me.characterId),
      // The hybrid-killer unlock: present ONLY for the killer's own device from
      // Phase 3 onward. null for everyone else — the variant never leaks here.
      killer: unlock,
      // Rescue nudge if this player has gone quiet during an active phase.
      // Based on deliberate activity (scans/votes), not passive polling.
      nudge: idleNudge(me.characterId, game.phase, idleMs),
      // Private branching drops this player can currently see.
      drops: visibleDrops(game, q.personalCode, game.phase),
      // Whether this player has logged their 6:40 answer (drives the prompt).
      alibiSubmitted: !!(game.alibi && game.alibi[q.personalCode]),
    };
    // Record that the killer unlock has "fired" for this player (§4.5 ordering).
    if (unlock && !me.killerSeenAt) {
      await updateGame(game.partyCode, (g) => {
        if (g.players[q.personalCode] && !g.players[q.personalCode].killerSeenAt) {
          g.players[q.personalCode].killerSeenAt = new Date().toISOString();
        }
        return g;
      });
    }
  }

  return ok({ state: publicState, you });
};
