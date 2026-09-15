'use strict';
/* POST /api/lobby-vote  { partyCode, personalCode, id, choice }
 *
 * The light weekly question in the lobby. Lobby only: once the doors are open
 * this is refused, the same way scanning and advancing are, because the lobby
 * is over and the evening has its own polls.
 *
 * One answer per seat per question, changeable until the doors open. A guest
 * has to hold a seat to answer. Nothing here can reach plot content: the
 * questions are plaintext pack copy with no character in them, and the answers
 * live under their own key on the game object, so a lobby answer can never be
 * counted in a game poll or a game vote counted here.
 *
 * What comes back is aggregate: counts per option and a mark on the asking
 * guest's own choice. Who answered what is never served, to anybody, including
 * the host.
 */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { openQuestion, lobbyQuestions, recordLobbyAnswer } = require('../lib/lobby');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  if (!b.partyCode || !b.id) return bad('partyCode and id required');

  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (!game.lobby) return bad('the doors are open; the lobby questions are closed');
  if (!b.personalCode || !game.players[b.personalCode]) return forbidden('claim a character first');

  const now = new Date();
  // A question dated in the future is not answerable because it does not exist
  // yet, in the same sense that it never leaves the server.
  const q = openQuestion(b.id, now);
  if (!q) return notFound('no such question');
  if (!q.options.includes(b.choice)) return bad('invalid choice');

  const next = await updateGame(code, (g) => recordLobbyAnswer(g, b.id, b.personalCode, b.choice));

  const view = lobbyQuestions(next || game, now, b.personalCode).find((x) => x.id === b.id);
  return ok({ id: b.id, voted: true, question: view || null });
};
