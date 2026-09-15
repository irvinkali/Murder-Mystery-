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
  { id: 'liar', title: 'Best liar', line: 'Said it with a straight face all night.' },
  { id: 'suspected', title: 'First one you suspected', line: 'Fairly or otherwise.' },
  { id: 'era', title: 'Most 1989', line: 'Came as they were and committed.' },
  { id: 'detective', title: 'Should have been a detective', line: 'Asked the question nobody else thought to.' },
  { id: 'costume', title: 'Best costume', line: 'Purely on the clothes.' },
];

const findAward = (id) => SUPERLATIVES.find((a) => a.id === id) || null;

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

/** The whole awards round for the room screen, or null before the host opens it. */
function awardsPublic(pack, game) {
  if (!game || !game.awardsOpen) return null;
  return {
    open: true,
    openedAt: game.awardsOpenedAt || null,
    candidates: awardCandidates(pack, game),
    results: SUPERLATIVES.map((a) => tallyAward(pack, game, a)),
  };
}

module.exports = {
  AWARD_VOTE_KEY, SUPERLATIVES, findAward,
  awardCandidates, isSeated, recordAwardVote, ownAwardVotes, tallyAward, awardsPublic,
};
