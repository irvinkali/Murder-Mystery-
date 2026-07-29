'use strict';
/* POST /api/poll  — anonymous/public poll mechanics.
 *   { action:'create', partyCode, hostToken, id, question, options[] }
 *   { action:'vote',   partyCode, personalCode, id, choice }
 *   { action:'close',  partyCode, hostToken, id } -> tallies (no voter identities)
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack } = require('../lib/runtime');
const { matchCharByLabel, computeDefense, computeMedical, mergeDrops } = require('../lib/branching');

const KEYSTONE_PHASE = 4;

function tally(poll) {
  const counts = {};
  for (const opt of poll.options) counts[opt] = 0;
  for (const choice of Object.values(poll.votes)) {
    if (choice in counts) counts[choice] += 1;
  }
  return counts;
}

function winningOption(counts) {
  let best = null, bestN = -1;
  for (const [opt, n] of Object.entries(counts)) if (n > bestN) { best = opt; bestN = n; }
  return best;
}

/**
 * Run the branching consequence tied to a poll on close. Mutates `g`. Returns a
 * short, spoiler-free tag describing what fired (never the drop text).
 */
function resolvePollBranch(g, poll, counts) {
  const pack = loadRuntimePack();
  g.branchFired = g.branchFired || {};

  // §4.1 Defense drops — Phase 3, once, "who benefits" poll.
  if (poll.branch === 'benefits' && g.phase === 3 && !g.branchFired.defense) {
    const winId = matchCharByLabel(pack, winningOption(counts));
    if (winId) {
      const res = computeDefense(pack, g, winId);
      if (res) { mergeDrops(g, [res]); g.branchFired.defense = true; return 'defense'; }
    }
  }

  // §4.3 Medical reveal — Phase 4, once, "subpoena" poll.
  if (poll.branch === 'subpoena' && g.phase === KEYSTONE_PHASE && !g.branchFired.medical) {
    const yes = Object.entries(counts).filter(([o]) => /^y/i.test(o)).reduce((s, [, n]) => s + n, 0);
    const no = Object.entries(counts).filter(([o]) => /^n/i.test(o)).reduce((s, [, n]) => s + n, 0);
    const outcome = yes > no ? 'yes' : 'no';
    const { drops, screen } = computeMedical(pack, g, outcome);
    mergeDrops(g, drops);
    if (screen) g.screen = { text: screen, at: new Date().toISOString() };
    g.branchFired.medical = outcome;
    return 'medical:' + outcome;
  }
  return null;
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
    const branch = ['benefits', 'subpoena'].includes(b.branch) ? b.branch : null;
    await updateGame(code, (g) => {
      g.polls[b.id] = { question: b.question || '', options: b.options, votes: {}, closed: false, branch };
      g.log.push({ at: new Date().toISOString(), kind: 'poll-create', id: b.id });
      return g;
    });
    return ok({ id: b.id, created: true, branch });
  }

  if (b.action === 'vote') {
    if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join first');
    const poll = game.polls[b.id];
    if (!poll) return notFound('no such poll');
    if (poll.closed) return bad('poll closed');
    if (!poll.options.includes(b.choice)) return bad('invalid choice');
    await updateGame(code, (g) => {
      g.polls[b.id].votes[b.personalCode] = b.choice; // one vote per player; anonymous in tally
      if (g.players[b.personalCode]) g.players[b.personalCode].lastActive = new Date().toISOString();
      return g;
    });
    return ok({ id: b.id, voted: true });
  }

  if (b.action === 'close') {
    if (b.hostToken !== game.hostToken) return forbidden('host only');
    const poll = game.polls[b.id];
    if (!poll) return notFound('no such poll');
    let counts = null;
    let fired = null;
    await updateGame(code, (g) => {
      g.polls[b.id].closed = true;
      counts = tally(g.polls[b.id]);
      fired = resolvePollBranch(g, g.polls[b.id], counts);
      g.log.push({ at: new Date().toISOString(), kind: 'poll-close', id: b.id, fired });
      return g;
    });
    return ok({ id: b.id, closed: true, counts, fired });
  }

  return bad('unknown action');
};
