#!/usr/bin/env node
'use strict';
/*
 * End-to-end engine test over the in-memory store (no Netlify needed).
 * SPOILER-SAFE: asserts invariants and prints only PASS/FAIL + counts. It never
 * prints a killer, a variant identity, evidence text, or a character secret.
 */

delete process.env.NETLIFY; // force in-memory backend

const createGame = require('./functions/create-game').handler;
const join = require('./functions/join').handler;
const state = require('./functions/state').handler;
const scan = require('./functions/scan').handler;
const poll = require('./functions/poll').handler;
const advance = require('./functions/advance').handler;
const reveal = require('./functions/reveal').handler;
const { getGame } = require('./lib/store');
const { loadRuntimePack } = require('./lib/runtime');

const POST = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const GET = (queryStringParameters) => ({ httpMethod: 'GET', queryStringParameters });
const j = async (res) => JSON.parse((await res).body);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}`); }
}

async function main() {
  const pack = loadRuntimePack();

  // 1. create game — must not leak the sealed variant.
  const created = await j(createGame(POST({ hostName: 'Kali' })));
  assert('create-game returns partyCode + hostToken', !!created.partyCode && !!created.hostToken);
  assert('create-game response hides the sealed variant', !('variant' in created));
  const { partyCode, hostToken } = created;

  // 2. join the full core cast (10) — unique character per player.
  const codes = [];
  const chars = new Set();
  for (let i = 0; i < pack.cast.length; i++) {
    const r = await j(join(POST({ partyCode, name: `Player${i + 1}` })));
    if (r.personalCode) { codes.push(r.personalCode); chars.add(r.character.id); }
  }
  assert('10 players joined', codes.length === 10);
  assert('each player got a distinct character', chars.size === 10);
  assert('11th join is rejected (core cast full)',
    !!(await j(join(POST({ partyCode, name: 'Overflow' })))).error);

  // 3. player state — own brief present, no variant, no other briefs.
  const st = await j(state(GET({ partyCode, personalCode: codes[0] })));
  assert('public state hides the variant', !('variant' in st.state));
  assert('player sees their own character brief', !!(st.you && st.you.character && st.you.character.brief));
  assert('roster is public but carries no secrets',
    st.state.roster.length === 10 && st.state.roster.every((c) => !('brief' in c)));

  // 4. keystone gating — derive the keystone prop for the sealed variant from
  //    the pack (without printing it) and prove it is locked before Phase 4.
  const sealed = (await getGame(partyCode)).variant; // read locally; never printed
  const keystoneProp = pack.props.find((p) => (pack.matrix[p] || {})[sealed] === 'keystone');

  if (keystoneProp) {
    const early = await j(scan(POST({ partyCode, personalCode: codes[0], propId: keystoneProp })));
    assert('keystone prop is NOT revealed before Phase 4',
      !(early.reveal.extra && early.reveal.extra.keystone));

    await j(advance(POST({ partyCode, hostToken, phase: 4 })));
    const late = await j(scan(POST({ partyCode, personalCode: codes[0], propId: keystoneProp })));
    assert('keystone prop reveals at Phase 4',
      !!(late.reveal.extra && late.reveal.extra.keystone));
  } else {
    assert('sealed variant has a keystone prop (or keystone is a non-prop clue)', true);
  }

  // 4b. Deterministic keystone-gate sweep across ALL variants (runtime level).
  const { resolvePropScan } = require('./lib/runtime');
  let sweepProps = 0;
  for (const v of pack.variants) {
    const kProp = pack.props.find((p) => (pack.matrix[p] || {})[v.letter] === 'keystone');
    if (!kProp) continue; // keystone is a non-prop clue in this variant
    sweepProps++;
    const before = resolvePropScan(pack, v.letter, kProp, 3);
    const at = resolvePropScan(pack, v.letter, kProp, 4);
    assert(`variant ${v.letter}: keystone prop locked in Phase 3`,
      !(before.extra && before.extra.keystone));
    assert(`variant ${v.letter}: keystone prop unlocks in Phase 4`,
      !!(at.extra && at.extra.keystone));
  }
  assert('at least one variant exposes its keystone via a prop', sweepProps >= 1);

  // 5. scan requires membership.
  assert('scan rejects a non-player',
    !!(await j(scan(POST({ partyCode, personalCode: 'ZZZZZ', propId: 'P1' })))).error);

  // 6. polls — anonymous tally, one vote per player.
  await j(poll(POST({ action: 'create', partyCode, hostToken, id: 'q1', question: 'Who benefits most?', options: ['A', 'B'] })));
  await j(poll(POST({ action: 'vote', partyCode, personalCode: codes[0], id: 'q1', choice: 'A' })));
  await j(poll(POST({ action: 'vote', partyCode, personalCode: codes[1], id: 'q1', choice: 'A' })));
  await j(poll(POST({ action: 'vote', partyCode, personalCode: codes[2], id: 'q1', choice: 'B' })));
  const closed = await j(poll(POST({ action: 'close', partyCode, hostToken, id: 'q1' })));
  assert('poll tallies correctly (2 vs 1)', closed.counts.A === 2 && closed.counts.B === 1);
  assert('poll rejects a non-host close',
    !!(await j(poll(POST({ action: 'close', partyCode, hostToken: 'bad', id: 'q1' })))).error);

  // 7. reveal gating.
  await j(advance(POST({ partyCode, hostToken, phase: 5 })));
  const tooEarly = await j(reveal(POST({ partyCode, hostToken })));
  assert('reveal is forbidden before Phase 6', !!tooEarly.error);

  await j(advance(POST({ partyCode, hostToken, phase: 6 })));
  const revealed = await j(reveal(POST({ partyCode, hostToken })));
  assert('reveal at Phase 6 returns the solution to the host',
    !!(revealed.killer && revealed.variant && Array.isArray(revealed.evidence)));
  assert('revealed variant matches the sealed one', revealed.variant === sealed);
  assert('reveal rejects a non-host', !!(await j(reveal(POST({ partyCode, hostToken: 'bad' })))).error);

  console.log(`\n${fail === 0 ? '\x1b[32m✓ ENGINE OK' : '\x1b[31m✗ ENGINE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(2); });
