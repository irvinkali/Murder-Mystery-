'use strict';
/* POST /api/scan  { partyCode, personalCode, exhibit }  ->  prop reveal
 * `exhibit` is the placard number (or the NFC tag value). Internal prop IDs are
 * resolved server-side and never returned. Keystone stays gated until Phase 4. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, resolvePropScan, propIdFromInput } = require('../lib/runtime');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  const raw = b.exhibit != null ? b.exhibit : b.propId; // accept either
  if (!b.partyCode || raw == null) return bad('partyCode and exhibit required');

  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join the party first');

  const pack = loadRuntimePack();
  const propId = propIdFromInput(raw);
  if (!propId) return ok({ reveal: { unknown: true, message: 'No exhibit matches that number.' } });

  const r = resolvePropScan(pack, game.variant, propId, game.phase);
  // Strip the internal prop id from the player-facing payload.
  const reveal = { label: r.label, blurb: r.blurb, extra: r.extra || null, locked: !!r.locked, lockedHint: r.lockedHint || null };

  await updateGame(code, (g) => {
    const d = g.discovered[propId] || { count: 0, firstAt: new Date().toISOString() };
    d.count += 1;
    g.discovered[propId] = d;
    if (g.players[b.personalCode]) {
      g.players[b.personalCode].lastActive = new Date().toISOString();
      g.players[b.personalCode].scanCount = (g.players[b.personalCode].scanCount || 0) + 1;
    }
    g.log.push({ at: new Date().toISOString(), kind: 'scan', propId, by: b.personalCode });
    return g;
  });

  return ok({ reveal });
};
