'use strict';
/* POST /api/cast — host-side casting (host only).
 *   { action: 'get', partyCode, hostToken }
 *       -> { roster: [{ id, name, flex, guest, claimedBy }] }  all 20 characters
 *   { action: 'save', partyCode, hostToken, reservations: { [characterId]: guestName } }
 *       -> same shape, after saving
 *   { action: 'move', partyCode, hostToken, characterId, toCharacterId }
 *       -> same shape, after moving the guest who already joined as characterId
 *          into toCharacterId. Joining is deliberately sticky: a name that
 *          already holds a seat gets that same seat back, so a guest who picked
 *          in the lobby cannot be re-seated on the night. That also means a
 *          reservation alone can never undo a wrong pick, which is what this is
 *          for. Their personal code does not change, so their phone keeps
 *          working and simply shows the new character.
 *   { action: 'remove', partyCode, hostToken, characterId }
 *       -> same shape, after taking the guest who joined as characterId out of
 *          the party: the seat opens again and their old seat code stops
 *          working. For duplicate sign-ups (one person who joined twice under
 *          two spellings of their name) and for drop-outs. Their vote and their
 *          6:40 answer go with them so no tally counts a person who is not
 *          there. A reservation on that character is cleared only if it was in
 *          their name, so deliberate casting for somebody else survives.
 *
 * Reservations live on the party and are never included in /api/state, so the
 * gallery screen and players never see who was cast as whom. A guest whose
 * name matches a reservation (case and spacing ignored) gets that character at
 * join; anyone else is seated from what's left. Any flex character may be
 * reserved — fairness rule 2 means no solution depends on one. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, assignableIds } = require('../lib/runtime');
const { matchNames } = require('../lib/names');

function hostRoster(pack, game) {
  const res = game.reservations || {};
  const flexIds = new Set((pack.flex || []).map((f) => f.id));
  return [...pack.cast, ...(pack.flex || [])].map((c) => {
    const pcode = (game.assignments || {})[c.id];
    const player = pcode ? game.players[pcode] : null;
    return {
      id: c.id,
      name: c.name,
      flex: flexIds.has(c.id),
      guest: res[c.id] || '',
      claimedBy: player ? player.name : null,
    };
  });
}

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { action, partyCode, hostToken, reservations, characterId, toCharacterId } = parseBody(event);
  if (!partyCode) return bad('partyCode required');
  const code = partyCode.toUpperCase();

  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');

  const pack = loadRuntimePack();

  if (action === 'get') return ok({ roster: hostRoster(pack, game) });

  if (action === 'save') {
    if (!reservations || typeof reservations !== 'object') return bad('reservations required');
    const valid = new Set(assignableIds(pack));
    const clean = {};
    for (const [id, guest] of Object.entries(reservations)) {
      if (!valid.has(id)) return bad(`no such character: ${id}`);
      const g = String(guest == null ? '' : guest).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (g) clean[id] = g;
    }
    const saved = await updateGame(code, (g) => {
      g.reservations = clean;
      g.log.push({ at: new Date().toISOString(), kind: 'cast', count: Object.keys(clean).length });
      return g;
    });
    return ok({ roster: hostRoster(pack, saved) });
  }

  if (action === 'move') {
    const valid = new Set(assignableIds(pack));
    if (!valid.has(characterId) || !valid.has(toCharacterId)) return bad('no such character');
    if (characterId === toCharacterId) return bad('that guest already has that character');
    let err = null;
    const saved = await updateGame(code, (g) => {
      err = null;
      const pcode = (g.assignments || {})[characterId];
      if (!pcode) { err = 'nobody has joined as that character'; return g; }
      if ((g.assignments || {})[toCharacterId]) { err = 'somebody has already joined as that character'; return g; }
      const player = g.players[pcode];
      const res = g.reservations || {};
      const heldFor = res[toCharacterId];
      if (heldFor && matchNames(player.name, [{ key: 'x', name: heldFor }]).length !== 1) {
        err = 'that character is reserved for another guest'; return g;
      }
      delete g.assignments[characterId];
      g.assignments[toCharacterId] = pcode;
      player.characterId = toCharacterId;
      player.lastActive = new Date().toISOString();
      // Carry the reservation across, so a fresh join by the same name lands here too.
      if (res[characterId]) { res[toCharacterId] = res[characterId]; delete res[characterId]; }
      else if (!heldFor) { res[toCharacterId] = player.name; }
      g.reservations = res;
      g.log.push({ at: new Date().toISOString(), kind: 'move', from: characterId, to: toCharacterId });
      return g;
    });
    if (!saved) return notFound('no such party');
    if (err) return bad(err);
    return ok({ roster: hostRoster(pack, saved) });
  }

  if (action === 'remove') {
    const valid = new Set(assignableIds(pack));
    if (!valid.has(characterId)) return bad('no such character');
    let err = null;
    let removed = null;
    const saved = await updateGame(code, (g) => {
      err = null; removed = null;
      const pcode = (g.assignments || {})[characterId];
      if (!pcode) { err = 'nobody has joined as that character'; return g; }
      const player = g.players[pcode] || {};
      removed = player.name || '';
      delete g.assignments[characterId];
      delete g.players[pcode];
      if (g.alibi) delete g.alibi[pcode];
      for (const poll of Object.values(g.polls || {})) {
        if (poll && poll.votes) delete poll.votes[pcode];
      }
      const res = g.reservations || {};
      if (res[characterId] && matchNames(removed, [{ key: 'x', name: res[characterId] }]).length === 1) {
        delete res[characterId];
        g.reservations = res;
      }
      g.log.push({ at: new Date().toISOString(), kind: 'remove', characterId });
      return g;
    });
    if (!saved) return notFound('no such party');
    if (err) return bad(err);
    return ok({ roster: hostRoster(pack, saved), removed });
  }

  return bad('unknown action');
};
