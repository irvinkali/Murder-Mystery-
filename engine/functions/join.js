'use strict';
/* POST /api/join  { partyCode, name, characterId? } -> { personalCode, character }
 * With characterId: claims that specific unclaimed character (casting).
 * Without: assigns the next available seat, core cast first (fairness rule 2:
 * flex are never load-bearing and are layered in only above the core cast). */

const { ok, bad, notFound, preflight, parseBody, personalCode } = require('../lib/api');
const { updateGame } = require('../lib/store');
const { loadRuntimePack, playerBrief, assignableIds } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, name, characterId } = parseBody(event);
  if (!partyCode || !name) return bad('partyCode and name required');

  const pack = loadRuntimePack();
  const seatOrder = assignableIds(pack); // core cast first, then flex
  if (characterId && !seatOrder.includes(characterId)) return bad('no such character');

  let assignedId = null;
  let pcode = null;
  let alreadyClaimed = false;

  const game = await updateGame(partyCode.toUpperCase(), (g) => {
    const taken = new Set(Object.keys(g.assignments));
    if (characterId) {
      if (taken.has(characterId)) { alreadyClaimed = true; return g; }
      assignedId = characterId;
    } else {
      assignedId = seatOrder.find((id) => !taken.has(id)) || null;
    }
    if (!assignedId) return g; // full (all seats claimed)
    pcode = personalCode();
    const now = new Date().toISOString();
    g.players[pcode] = { name, characterId: assignedId, joinedAt: now, lastActive: now };
    g.assignments[assignedId] = pcode;
    g.log.push({ at: new Date().toISOString(), kind: 'join', characterId: assignedId });
    return g;
  });

  if (!game) return notFound('no such party');
  if (alreadyClaimed) return bad('that character was just claimed — pick another');
  if (!assignedId) return bad('party is full (all characters assigned)');

  return ok({ personalCode: pcode, character: playerBrief(pack, assignedId) });
};
