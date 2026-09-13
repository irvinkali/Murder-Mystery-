'use strict';
/* POST /api/cast — host-side casting (host only).
 *   { action: 'get', partyCode, hostToken }
 *       -> { roster: [{ id, name, flex, guest, claimedBy }] }  all 20 characters
 *   { action: 'save', partyCode, hostToken, reservations: { [characterId]: guestName } }
 *       -> same shape, after saving
 *
 * Reservations live on the party and are never included in /api/state, so the
 * gallery screen and players never see who was cast as whom. A guest whose
 * name matches a reservation (case and spacing ignored) gets that character at
 * join; anyone else is seated from what's left. Any flex character may be
 * reserved — fairness rule 2 means no solution depends on one. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, assignableIds } = require('../lib/runtime');

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

  const { action, partyCode, hostToken, reservations } = parseBody(event);
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

  return bad('unknown action');
};
