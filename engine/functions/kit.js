'use strict';
/* GET /api/kit  ->  the loaded pack's host-facing, spoiler-free presentation kit.
 *
 * This is what makes the front-end pack-agnostic: page branding, the item
 * number map, placard and invite copy, and the printable inserts all come from
 * whichever pack is loaded rather than being baked into the HTML.
 *
 * SPOILER-SAFE BY CONSTRUCTION: it returns only material the host already has
 * on paper (the props guide) plus page copy. It never touches the matrix, the
 * variants, the cast, the evidence chains or the sealed solution, so it is safe
 * to serve with no party code and no authentication.
 */

const { ok, preflight } = require('../lib/api');
const { connect } = require('../lib/store');
const { loadRuntimePack, propCatalog, worldCopy, say } = require('../lib/runtime');
const { loadTheme, voiceConfig } = require('../lib/theme');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();

  const pack = loadRuntimePack();
  const fe = pack.frontend || {};
  const w = worldCopy(pack);
  const catalog = propCatalog(pack);

  // Public item list, ordered by prop id. Number + label + placement only.
  const items = Object.keys(catalog)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((id) => ({
      number: catalog[id].number,
      label: say(pack, catalog[id].label),
      placement: say(pack, catalog[id].placement),
    }));

  const brand = {};
  for (const [k, v] of Object.entries(fe.brand || {})) brand[k] = typeof v === 'string' ? say(pack, v) : v;
  const invite = {};
  for (const [k, v] of Object.entries(fe.invite || {})) invite[k] = say(pack, v);
  const printables = (fe.printables || []).map((p) => ({
    kind: p.kind,
    title: say(pack, p.title),
    note: say(pack, p.note),
    lines: (p.lines || []).map((l) => say(pack, l)),
  }));

  return ok({
    id: pack.id || null,
    world: {
      title: w.title || null,
      venue: w.venue || null,
      itemNoun: w.itemNoun || null,
      itemNounPlural: w.itemNounPlural || null,
      alibiQuestion: w.alibiQuestion || null,
    },
    brand,
    // How the narrator should sound on the room screen (from the pack's theme).
    voice: voiceConfig(loadTheme()),
    items,
    printables,
    invite,
  });
};
