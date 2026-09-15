'use strict';
/*
 * The superlatives: a short awards round after the reveal has played.
 *
 * The room votes five prizes onto the people in it, the winners go up on the
 * room screen with the character name and the real first name, and the host
 * hands out the gift cards. It runs last on purpose: the mystery is over, so
 * nothing here can steer it.
 *
 * PRIVATE BY CONSTRUCTION. Votes are held by seat code on the game object,
 * under their own key, and what leaves this module is counts and names only.
 * There is no call here that returns who voted for whom, so no payload has one
 * to carry, and that includes the host's. The seat key is also why an award
 * vote can never be counted in a game poll or a lobby question, or the reverse.
 *
 * The five titles are presentation copy, like the award notes in the reveal.
 * No plot content lives here.
 */

const { displayNames } = require('./names');

const AWARD_VOTE_KEY = 'awardVotes';

const SUPERLATIVES = [
  { id: 'liar', title: 'Best liar', line: 'Said it with a straight face all night.',
    announce: 'And the last one. Best liar, which this committee means as a compliment, mostly.' },
  { id: 'suspected', title: 'First one you suspected', line: 'Fairly or otherwise.',
    announce: 'First one you suspected. Fairly or otherwise, and for most of you it was otherwise.' },
  { id: 'era', title: 'Most 1989', line: 'Came as they were and committed.',
    announce: 'Most 1989. Not the outfit on its own. The whole performance.' },
  { id: 'detective', title: 'Should have been a detective', line: 'Asked the question nobody else thought to.',
    announce: 'Should have been a detective. Somebody in this room asked the question nobody else thought to ask.' },
  { id: 'costume', title: 'Best costume', line: 'Purely on the clothes.',
    announce: 'We start with best costume. Purely on the clothes, and the committee has been looking all night.' },
];

const findAward = (id) => SUPERLATIVES.find((a) => a.id === id) || null;

/*
 * THE CEREMONY. The host closes the voting and the room screen walks the five
 * awards one at a time on its own clock: the title alone first, so the room can
 * shout a guess, then the winner, then a hold long enough to actually hand over
 * a gift card. The order builds; best liar is the payoff and goes last.
 *
 * The walk is server-side on purpose. A later award is not merely hidden on the
 * screen, it has not left the building: nothing past the award on stage is in
 * the payload, so there is nothing to read ahead in the network tab either.
 */
const CEREMONY_ORDER = ['costume', 'era', 'suspected', 'detective', 'liar'];
const TITLE_MS = 7000;    // the title alone, held for a beat
const HOLD_MS = 15000;    // the winner up, and time to hand over the card
const STEP_MS = TITLE_MS + HOLD_MS;
const CLOSING_LINE = 'That is all five. The winners are on the screen for as long as you need them. Photographs now; gift cards from the host.';
const NOBODY_LINE = 'Nobody cast a vote, so there is nobody to crown. The committee is choosing to read that as a compliment to everybody.';

/** "A", "A and B", "A, B and C" - so a tie reads aloud the way it is written. */
function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/** What the room screen says and captions when a winner goes up. */
function verdictLine(result) {
  if (!result.winners.length) {
    return 'No votes for this one, which the committee will take up with you individually.';
  }
  const names = joinNames(result.winners.map((w) => w.characterName));
  const votes = `${result.votes} ${result.votes === 1 ? 'vote' : 'votes'}`;
  return result.tie
    ? `It is a tie, and the committee is not about to break it. ${names}, on ${votes} each.`
    : `${names}, on ${votes}.`;
}

/** Everyone actually seated at this party, the way the room list shows them. */
function awardCandidates(pack, game) {
  const chars = [...pack.cast, ...(pack.flex || [])];
  const shown = displayNames(game);
  return Object.entries(game.players || {}).map(([code, p]) => {
    const c = chars.find((x) => x.id === p.characterId);
    return {
      characterId: p.characterId,
      characterName: c ? c.name : p.characterId,
      firstName: shown[code] || p.name || '',
    };
  });
}

/** Whether a character id belongs to somebody sitting in this room. */
function isSeated(game, characterId) {
  return Object.values(game.players || {}).some((p) => p.characterId === characterId);
}

/** One seat's vote. One per award, changeable while the awards are open. */
function recordAwardVote(game, awardId, personalCode, characterId) {
  game[AWARD_VOTE_KEY] = game[AWARD_VOTE_KEY] || {};
  game[AWARD_VOTE_KEY][awardId] = game[AWARD_VOTE_KEY][awardId] || {};
  game[AWARD_VOTE_KEY][awardId][personalCode] = characterId;
  return game;
}

/** This guest's own five choices, and nobody else's. */
function ownAwardVotes(game, personalCode) {
  const all = (game && game[AWARD_VOTE_KEY]) || {};
  const out = {};
  for (const a of SUPERLATIVES) {
    const mine = (all[a.id] || {})[personalCode];
    if (mine) out[a.id] = mine;
  }
  return out;
}

/**
 * The result of one award. Every tied name is reported rather than one being
 * picked, because a tie is a real answer and the room should see it. The
 * runner-up is a NUMBER: how many votes the next name down took. Naming them,
 * or listing the rest, would be the full breakdown this deliberately withholds.
 */
function tallyAward(pack, game, award) {
  const cast = (game[AWARD_VOTE_KEY] || {})[award.id] || {};
  const counts = {};
  for (const characterId of Object.values(cast)) {
    if (!isSeated(game, characterId)) continue;
    counts[characterId] = (counts[characterId] || 0) + 1;
  }
  const who = awardCandidates(pack, game);
  const name = (id) => who.find((c) => c.characterId === id) || { characterName: id, firstName: '' };

  const tallies = Object.values(counts);
  const top = tallies.length ? Math.max(...tallies) : 0;
  const runnerUp = tallies.filter((n) => n < top);
  const winnerIds = Object.keys(counts).filter((id) => counts[id] === top && top > 0);

  return {
    id: award.id,
    title: award.title,
    line: award.line,
    total: Object.keys(cast).length,
    votes: top,
    tie: winnerIds.length > 1,
    winners: winnerIds
      .map((id) => ({ characterName: name(id).characterName, firstName: name(id).firstName }))
      .sort((a, b) => a.characterName.localeCompare(b.characterName)),
    runnerUpVotes: runnerUp.length ? Math.max(...runnerUp) : 0,
  };
}

/** Has anybody voted for anything at all? Decides whether there is a ceremony. */
function anyVotesCast(game) {
  return Object.values((game && game[AWARD_VOTE_KEY]) || {})
    .some((seatMap) => Object.keys(seatMap || {}).length > 0);
}

/**
 * Start the ceremony: voting closes and the walk begins. With no votes at all
 * there is nothing to crown, so it closes and says so rather than handing five
 * awards to nobody.
 */
function startCeremony(game) {
  game.awardsClosed = true;
  const at = new Date().toISOString();
  game.ceremony = anyVotesCast(game)
    ? { startedAt: at, index: 0, stepStartedAt: at, done: false, empty: false }
    : { startedAt: at, index: 0, stepStartedAt: at, done: true, empty: true };
  return game;
}

/** Whether the award on stage has had its full time. */
function ceremonyDue(game) {
  const c = game && game.ceremony;
  if (!c || c.done || c.empty) return false;
  const started = Date.parse(c.stepStartedAt);
  return Number.isFinite(started) && (Date.now() - started) >= STEP_MS;
}

/** Move to the next award, or finish. `force` is the host skipping ahead. */
function advanceCeremony(game, force) {
  const c = game && game.ceremony;
  if (!c || c.done || c.empty) return false;
  if (!force && !ceremonyDue(game)) return false;
  if (c.index >= CEREMONY_ORDER.length - 1) {
    c.done = true;
    c.finishedAt = new Date().toISOString();
  } else {
    c.index += 1;
    c.stepStartedAt = new Date().toISOString();
  }
  return true;
}

/** 'title' while the award is up alone, 'winner' once the name is on screen. */
function ceremonyStage(game) {
  const c = game && game.ceremony;
  if (!c || c.empty || c.done) return 'done';
  const started = Date.parse(c.stepStartedAt);
  return (Number.isFinite(started) && (Date.now() - started) < TITLE_MS) ? 'title' : 'winner';
}

/**
 * The whole awards round for the room screen, or null before the host opens it.
 *
 * While the voting is open this is the live tally everybody can watch. Once the
 * ceremony starts it becomes the walk, and `results` carries only what has
 * actually been announced: the award on stage appears there the moment its
 * winner goes up, and nothing later than that is in the payload at all.
 */
function awardsPublic(pack, game) {
  if (!game || !game.awardsOpen) return null;
  const c = game.ceremony || null;

  if (!c) {
    return {
      open: true,
      voting: true,
      openedAt: game.awardsOpenedAt || null,
      candidates: awardCandidates(pack, game),
      results: SUPERLATIVES.map((a) => tallyAward(pack, game, a)),
      ceremony: null,
    };
  }

  if (c.empty) {
    return {
      open: true,
      voting: false,
      openedAt: game.awardsOpenedAt || null,
      results: [],
      ceremony: { running: false, done: true, empty: true, index: 0, count: CEREMONY_ORDER.length, stage: 'done', current: null, message: NOBODY_LINE, closing: NOBODY_LINE },
    };
  }

  const stage = ceremonyStage(game);
  const running = !c.done;
  const tally = (id) => tallyAward(pack, game, findAward(id));

  // Everything announced so far: the awards already walked past, plus the one
  // on stage once its winner is up. Nothing beyond that is built at all.
  const through = c.done ? CEREMONY_ORDER.length : (c.index + (stage === 'winner' ? 1 : 0));
  const results = CEREMONY_ORDER.slice(0, through).map(tally);

  let current = null;
  if (running) {
    const a = findAward(CEREMONY_ORDER[c.index]);
    current = { id: a.id, title: a.title, line: a.line, announce: a.announce, stage };
    if (stage === 'winner') {
      const r = tally(a.id);
      current = { ...current, winners: r.winners, votes: r.votes, tie: r.tie, total: r.total, runnerUpVotes: r.runnerUpVotes, speech: verdictLine(r) };
    }
  }

  return {
    open: true,
    voting: false,
    openedAt: game.awardsOpenedAt || null,
    results,
    ceremony: {
      running, done: !!c.done, empty: false,
      index: c.index, count: CEREMONY_ORDER.length, stage,
      current,
      closing: c.done ? CLOSING_LINE : null,
    },
  };
}

module.exports = {
  AWARD_VOTE_KEY, SUPERLATIVES, CEREMONY_ORDER, TITLE_MS, HOLD_MS, STEP_MS,
  CLOSING_LINE, NOBODY_LINE, findAward, joinNames, verdictLine,
  awardCandidates, isSeated, recordAwardVote, ownAwardVotes, tallyAward, awardsPublic,
  anyVotesCast, startCeremony, ceremonyDue, advanceCeremony, ceremonyStage,
};
