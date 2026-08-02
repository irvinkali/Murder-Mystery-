'use strict';
/* GET /api/casefile?partyCode=..  ->  the printable keepsake data.
 * Available ONLY after the reveal has played (everything in it is public to
 * the room by then). Any guest can pull it — it's the party favor. */

const { ok, bad, notFound, forbidden, preflight } = require('../lib/api');
const { getGame } = require('../lib/store');
const { loadRuntimePack, PROP_CATALOG, exhibitNumber } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const q = event.queryStringParameters || {};
  if (!q.partyCode) return bad('partyCode required');

  const game = await getGame(q.partyCode.toUpperCase());
  if (!game) return notFound('no such party');
  if (!game.reveal) return forbidden('the case file opens after the reveal');

  const pack = loadRuntimePack();
  const chName = (id) => {
    const c = [...pack.cast, ...(pack.flex || [])].find((x) => x.id === id);
    return c ? c.name : id;
  };

  // Timeline of discoveries (public physical descriptions only).
  const discoveries = Object.entries(game.discovered || {})
    .map(([propId, d]) => ({
      exhibit: exhibitNumber(propId),
      label: (PROP_CATALOG[propId] || {}).label || 'Exhibit',
      firstAt: d.firstAt,
      examinations: d.count,
    }))
    .sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));

  // The room's votes (aggregate) for every anonymous poll.
  const polls = Object.entries(game.pollResults || {}).map(([id, r]) => ({ id, question: r.question, counts: r.counts }));

  const guests = Object.values(game.players || {}).map((p) => ({
    firstName: p.name,
    characterName: chName(p.characterId),
    exhibitsExamined: p.scanCount || 0,
  }));

  return ok({
    partyCode: game.partyCode,
    playedAt: game.createdAt,
    guests,
    discoveries,
    polls,
    solution: {
      variant: game.reveal.variant,
      killer: game.reveal.killer,
      method: game.reveal.method,
      motive: game.reveal.motive || null,
      caught: game.reveal.caught,
    },
    voteCounts: game.reveal.voteCounts || {},
    awards: game.reveal.awards || [],
    blackoutHappened: !!game.blackout,
  });
};
