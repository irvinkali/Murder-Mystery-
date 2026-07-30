'use strict';
/* POST /api/poll — poll mechanics + host overrides.
 *   { action:'vote',   partyCode, personalCode, id, choice }
 *   { action:'close',  partyCode, hostToken, id }        -> aggregate counts
 *   { action:'open',   partyCode, hostToken, id }        -> open a scheduled poll early
 *   { action:'extend', partyCode, hostToken, id }        -> keep open past its phase
 *   { action:'skip',   partyCode, hostToken, id }        -> cancel a scheduled poll
 *   { action:'create', partyCode, hostToken, id, question, options[], kind?, guidance? }
 * Scheduled polls (benefits/subpoena/final) open/close automatically with the
 * phase; these overrides are for the host to steer timing.
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack } = require('../lib/runtime');
const { openPoll, closePoll, findSchedById } = require('../lib/pollsched');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  if (!b.partyCode || !b.action || !b.id) return bad('partyCode, action, id required');
  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  const pack = loadRuntimePack();
  const isHost = () => b.hostToken && b.hostToken === game.hostToken;

  if (b.action === 'vote') {
    if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join first');
    const poll = game.polls && game.polls[b.id];
    if (!poll) return notFound('no such poll');
    if (poll.closed) return bad('poll closed');
    if (!poll.options.includes(b.choice)) return bad('invalid choice');
    await updateGame(code, (g) => {
      g.polls[b.id].votes[b.personalCode] = b.choice; // one vote/player; anonymous in tally
      if (g.players[b.personalCode]) g.players[b.personalCode].lastActive = new Date().toISOString();
      return g;
    });
    return ok({ id: b.id, voted: true });
  }

  if (b.action === 'create') {
    if (!isHost()) return forbidden('host only');
    if (!Array.isArray(b.options) || b.options.length < 2) return bad('options[] (>=2) required');
    await updateGame(code, (g) => {
      g.polls = g.polls || {};
      g.polls[b.id] = {
        question: b.question || '', options: b.options, votes: {}, closed: false,
        branch: null, kind: b.kind === 'public' ? 'public' : 'anonymous',
        mandatory: false, guidance: b.guidance || '', phase: g.phase,
      };
      return g;
    });
    return ok({ id: b.id, created: true });
  }

  if (b.action === 'open') {
    if (!isHost()) return forbidden('host only');
    const found = findSchedById(b.id);
    if (!found) return notFound('no such scheduled poll');
    await updateGame(code, (g) => { openPoll(pack, g, found.sched); return g; });
    return ok({ id: b.id, opened: true });
  }

  if (b.action === 'extend') {
    if (!isHost()) return forbidden('host only');
    await updateGame(code, (g) => { if (g.polls && g.polls[b.id]) g.polls[b.id].extended = true; return g; });
    return ok({ id: b.id, extended: true });
  }

  if (b.action === 'skip') {
    if (!isHost()) return forbidden('host only');
    await updateGame(code, (g) => {
      g.skippedPolls = g.skippedPolls || {};
      g.skippedPolls[b.id] = true;
      if (g.polls && g.polls[b.id] && !g.polls[b.id].closed) g.polls[b.id].closed = true;
      return g;
    });
    return ok({ id: b.id, skipped: true });
  }

  if (b.action === 'close') {
    if (!isHost()) return forbidden('host only');
    let result = null;
    await updateGame(code, (g) => { result = closePoll(pack, g, b.id); return g; });
    if (!result) return bad('poll missing or already closed');
    return ok({ id: b.id, closed: true, counts: result.counts, fired: result.fired });
  }

  return bad('unknown action');
};
