'use strict';
/* POST /api/join  { partyCode, name } -> { personalCode, character }
 * Assigns the next available CORE character (fairness rule 2: flex are never
 * load-bearing and are layered in only above the core cast). */

const { ok, bad, notFound, preflight, parseBody, personalCode } = require('../lib/api');
const { updateGame } = require('../lib/store');
const { loadRuntimePack, playerBrief, assignableIds } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, name } = parseBody(event);
  if (!partyCode || !name) return bad('partyCode and name required');

  const pack = loadRuntimePack();
  const seatOrder = assignableIds(pack); // core cast first, then flex

  let assignedId = null;
  let pcode = null;

  const game = await updateGame(partyCode.toUpperCase(), (g) => {
    const taken = new Set(Object.keys(g.assignments));
    assignedId = seatOrder.find((id) => !taken.has(id)) || null;
    if (!assignedId) return g; // full (core cast exhausted)
    pcode = personalCode();
    const now = new Date().toISOString();
    g.players[pcode] = { name, characterId: assignedId, joinedAt: now, lastActive: now };
    g.assignments[assignedId] = pcode;
    g.log.push({ at: new Date().toISOString(), kind: 'join', characterId: assignedId });
    return g;
  });

  if (!game) return notFound('no such party');
  if (!assignedId) return bad('party is full (all characters assigned)');

  return ok({ personalCode: pcode, character: playerBrief(pack, assignedId) });
};
