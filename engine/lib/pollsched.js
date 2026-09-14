'use strict';
/*
 * Poll scheduling + resolution.
 *
 *  - Polls auto-open at the start of their phase and auto-close when the phase
 *    advances, unless the host overrides (open early / extend / skip).
 *  - Anonymous polls publish aggregate-only results (for the gallery) on close;
 *    the public "6:40" question is handled separately (attributed, via alibi).
 *  - The Phase-5 "who did it" vote is mandatory: the reveal is blocked until it
 *    closes (see reveal.js / finalVoteClosed).
 *
 * No plot literals and no world copy: the option lists come from the pack's cast
 * names, and the question + guidance wording for each scheduled poll comes from
 * the pack's POLL COPY section. The engine owns only the mechanism — which poll
 * opens in which phase, what it branches to, and how it is tallied.
 */

const { matchCharByLabel, computeDefense, computeMedical, mergeDrops } = require('./branching');
const { audioName, AUDIO_KEYS, say } = require('./runtime');
const { pushNarrator, suspectLine, subpoenaLine, finalClosedLine } = require('./narrator');

const KEYSTONE_PHASE = 4;

// Scheduled polls by phase — MECHANISM ONLY. options:'CAST' is expanded to core
// character names; the fallback wording is neutral and world-free, and any pack
// that authors POLL COPY overrides it.
const SCHEDULE = {
  3: [{
    id: 'benefits', kind: 'anonymous', branch: 'benefits', options: 'CAST',
    question: 'Who benefits most?',
    guidance: 'Anonymous. Vote your gut.',
  }],
  4: [{
    id: 'subpoena', kind: 'anonymous', branch: 'subpoena', options: ['Yes', 'No'],
    question: 'Should the files be opened?',
    guidance: 'Anonymous. A majority Yes opens the files for the whole room.',
  }],
  5: [{
    id: 'final', kind: 'anonymous', mandatory: true, options: 'CAST',
    question: 'Final vote: who did it?',
    guidance: 'Anonymous and final. Nothing is revealed until this vote closes.',
  }],
};

function scheduleFor(phase) { return SCHEDULE[phase] || []; }

/** This poll's player-facing wording, from the pack when it authors it. */
function pollCopy(pack, sched) {
  const c = ((pack && pack.polls) || {})[sched.id] || {};
  return {
    question: say(pack, c.question || sched.question) || '',
    guidance: say(pack, c.guidance || sched.guidance) || '',
  };
}

function findSchedById(id) {
  for (const phase of Object.keys(SCHEDULE)) {
    const hit = SCHEDULE[phase].find((s) => s.id === id);
    if (hit) return { phase: Number(phase), sched: hit };
  }
  return null;
}

function optionsFor(pack, sched) {
  return sched.options === 'CAST' ? pack.cast.map((c) => c.name) : sched.options.slice();
}

function tally(poll) {
  const counts = {};
  for (const opt of poll.options) counts[opt] = 0;
  for (const choice of Object.values(poll.votes)) if (choice in counts) counts[choice] += 1;
  return counts;
}

function winningOption(counts) {
  let best = null, bestN = -1;
  for (const [opt, n] of Object.entries(counts)) if (n > bestN) { best = opt; bestN = n; }
  return best;
}

/** Create a scheduled poll if it doesn't exist and wasn't skipped. */
function openPoll(pack, game, sched) {
  game.polls = game.polls || {};
  game.skippedPolls = game.skippedPolls || {};
  if (game.polls[sched.id] || game.skippedPolls[sched.id]) return false;
  const copy = pollCopy(pack, sched);
  game.polls[sched.id] = {
    question: copy.question,
    options: optionsFor(pack, sched),
    votes: {},
    closed: false,
    branch: sched.branch || null,
    kind: sched.kind || 'anonymous',
    mandatory: !!sched.mandatory,
    guidance: copy.guidance,
    phase: null,
  };
  return true;
}

/** Branch consequence tied to a poll on close (defense / medical). Mutates game. */
function resolvePollBranch(pack, game, poll, counts) {
  game.branchFired = game.branchFired || {};
  if (poll.branch === 'benefits' && game.phase === 3 && !game.branchFired.defense) {
    const winId = matchCharByLabel(pack, winningOption(counts));
    if (winId) {
      const res = computeDefense(pack, game, winId);
      if (res) { mergeDrops(game, [res]); game.branchFired.defense = true; return 'defense'; }
    }
  }
  if (poll.branch === 'subpoena' && game.phase === KEYSTONE_PHASE && !game.branchFired.medical) {
    const yes = Object.entries(counts).filter(([o]) => /^y/i.test(o)).reduce((s, [, n]) => s + n, 0);
    const no = Object.entries(counts).filter(([o]) => /^n/i.test(o)).reduce((s, [, n]) => s + n, 0);
    const outcome = yes > no ? 'yes' : 'no';
    const { drops, screen } = computeMedical(pack, game, outcome);
    mergeDrops(game, drops);
    if (screen) {
      const medAudio = audioName(AUDIO_KEYS.medical());
      game.screen = { text: screen, at: new Date().toISOString() };
      game.screenCards = game.screenCards || [];
      game.screenCards.push({ kind: 'medical', text: screen, audio: medAudio, at: new Date().toISOString() });
    }
    game.branchFired.medical = outcome;
    return 'medical:' + outcome;
  }
  return null;
}

/** Close a poll: tally, resolve its branch, publish aggregate results, and let
 *  the narrator react to it out loud. */
function closePoll(pack, game, pollId) {
  const poll = game.polls && game.polls[pollId];
  if (!poll || poll.closed) return null;
  poll.closed = true;
  const counts = tally(poll);
  const fired = resolvePollBranch(pack, game, poll, counts);
  // Anonymous polls publish aggregate-only results for the gallery.
  if (poll.kind === 'anonymous') {
    game.pollResults = game.pollResults || {};
    game.pollResults[pollId] = { question: poll.question, counts, at: new Date().toISOString() };
  }
  // Narrator interjections — names come from the pack at runtime; the audio
  // key is the character ID so the line is pre-renderable per cast member.
  const anyVotes = Object.values(counts).some((n) => n > 0);
  if (pollId === 'benefits' && anyVotes) {
    const win = winningOption(counts);
    const winId = matchCharByLabel(pack, win);
    if (winId) pushNarrator(game, 'suspect.' + winId, suspectLine(win, pack), true); // major: bell first
    require('./blackout').armBlackout(game);   // the set-piece arms off this poll
  } else if (pollId === 'subpoena' && typeof fired === 'string' && fired.startsWith('medical:')) {
    const outcome = fired.slice('medical:'.length);
    pushNarrator(game, 'subpoena.' + outcome, subpoenaLine(outcome, pack), true); // major
  } else if (pollId === 'final' && anyVotes) {
    pushNarrator(game, 'final.closed', finalClosedLine(pack), true);             // major
  }
  return { counts, fired };
}

/** Open all scheduled polls for a phase (host "open early" also uses openPoll). */
function autoOpen(pack, game, phase) {
  let opened = 0;
  for (const sched of scheduleFor(phase)) if (openPoll(pack, game, sched)) opened++;
  return opened;
}

/** Close still-open scheduled polls belonging to the phase being left. */
function autoClose(pack, game, fromPhase) {
  let closed = 0;
  for (const sched of scheduleFor(fromPhase)) {
    const poll = game.polls && game.polls[sched.id];
    if (poll && !poll.closed && !poll.extended) { closePoll(pack, game, sched.id); closed++; }
  }
  return closed;
}

/** The mandatory Phase-5 vote must exist and be closed before the reveal. */
function finalVoteClosed(game) {
  const p = game.polls && game.polls.final;
  return !!(p && p.closed);
}

module.exports = {
  SCHEDULE, scheduleFor, findSchedById, optionsFor, pollCopy, tally, winningOption,
  openPoll, closePoll, autoOpen, autoClose, resolvePollBranch, finalVoteClosed,
};
