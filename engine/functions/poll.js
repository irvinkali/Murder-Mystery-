'use strict';
/* POST /api/poll  — anonymous/public poll mechanics.
 *   { action:'create', partyCode, hostToken, id, question, options[] }
 *   { action:'vote',   partyCode, personalCode, id, choice }
 *   { action:'close',  partyCode, hostToken, id } -> tallies (no voter identities)
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');

function tally(poll) {
  const counts = {};
  for (const opt of poll.options) counts[opt] = 0;
  for (const choice of Object.values(poll.votes)) {
    if (choice in counts) counts[choice] += 1;
  }
  return counts;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  if (!b.partyCode || !b.action || !b.id) return bad('partyCode, action, id required');
  const code = b.partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');

  if (b.action === 'create') {
    if (b.hostToken !== game.hostToken) return forbidden('host only');
    if (!Array.isArray(b.options) || b.options.length < 2) return bad('options[] (>=2) required');
    await updateGame(code, (g) => {
      g.polls[b.id] = { question: b.question || '', options: b.options, votes: {}, closed: false };
      g.log.push({ at: new Date().toISOString(), kind: 'poll-create', id: b.id });
      return g;
    });
    return ok({ id: b.id, created: true });
  }

  if (b.action === 'vote') {
    if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join first');
    const poll = game.polls[b.id];
    if (!poll) return notFound('no such poll');
    if (poll.closed) return bad('poll closed');
    if (!poll.options.includes(b.choice)) return bad('invalid choice');
    await updateGame(code, (g) => {
      g.polls[b.id].votes[b.personalCode] = b.choice; // one vote per player; anonymous in tally
      return g;
    });
    return ok({ id: b.id, voted: true });
  }

  if (b.action === 'close') {
    if (b.hostToken !== game.hostToken) return forbidden('host only');
    const poll = game.polls[b.id];
    if (!poll) return notFound('no such poll');
    let counts = null;
    await updateGame(code, (g) => {
      g.polls[b.id].closed = true;
      counts = tally(g.polls[b.id]);
      g.log.push({ at: new Date().toISOString(), kind: 'poll-close', id: b.id });
      return g;
    });
    return ok({ id: b.id, closed: true, counts });
  }

  return bad('unknown action');
};
