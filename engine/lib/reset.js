'use strict';
/*
 * Back to the lobby: undo a start.
 *
 * A party can be started by accident, or started on purpose to rehearse, and
 * either way the casting is the expensive thing. Guests claim a character,
 * reservations are typed in by hand, and every seat carries a personal code
 * that is already on somebody's phone. So a reset keeps the room and throws
 * away the evening.
 *
 * It is written as a CARRY list rather than a delete list on purpose. The game
 * object grows a field every time the engine learns a trick (polls, drops,
 * narration, blackout, awards, ceremony, go-find), and a delete list silently
 * misses the newest one, which is exactly the residue that would leak a
 * rehearsal into the real night. Building a new game and carrying five fields
 * across cannot miss anything.
 *
 * The sealed variant is drawn again. A rehearsal must never teach anybody the
 * answer to the night they are going to play.
 */

const { selectVariant } = require('./runtime');
const { LOBBY_ANSWER_KEY } = require('./lobby');

/* What survives a reset: who is in the room and who they are playing. */
const CARRY = ['partyCode', 'hostToken', 'createdAt', 'hostName', 'reservations', LOBBY_ANSWER_KEY];

/* A seat keeps its identity and loses its history: scanCount and killerSeenAt
 * are things that happened during a game that is being thrown away. */
function carrySeat(p) {
  const seat = { name: p.name, characterId: p.characterId };
  if (p.joinedAt) seat.joinedAt = p.joinedAt;
  if (p.lastActive) seat.lastActive = p.lastActive;
  return seat;
}

function resetToLobby(pack, game, now) {
  const at = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  const next = {};
  for (const k of CARRY) if (game[k] !== undefined) next[k] = game[k];

  next.players = {};
  for (const [code, p] of Object.entries(game.players || {})) next.players[code] = carrySeat(p || {});
  next.assignments = Object.assign({}, game.assignments || {});

  next.lobby = true;
  next.phase = 1;
  next.phaseStartedAt = at;
  next.variant = selectVariant(pack);

  // A party that has just been put back is not being played. Auto-advance is on
  // by default at creation, which is how a party left alone walks itself to the
  // reveal; after a reset it stays off until somebody opens the doors again.
  next.autoAdvance = false;
  next.autopilot = false;

  next.discovered = {};
  next.polls = {};
  next.log = [{ at: game.createdAt || at, kind: 'created' }, { at, kind: 'reset' }];
  return next;
}

module.exports = { resetToLobby, CARRY };
