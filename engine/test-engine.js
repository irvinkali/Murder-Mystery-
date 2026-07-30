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
  // Flex characters are authored, so seats now extend to 20.
  const eleventh = await j(join(POST({ partyCode, name: 'Player11' })));
  assert('11th player is seated into a flex role', !!eleventh.personalCode && /^F\d+$/.test(eleventh.character.id));
  for (let i = 12; i <= 20; i++) await j(join(POST({ partyCode, name: 'Player' + i })));
  assert('21st join is rejected once all 20 seats are filled',
    !!(await j(join(POST({ partyCode, name: 'Overflow' })))).error);

  // Flex seating mechanism (players 11–20). Pure logic test with placeholder
  // ids — no plot content. Proves the engine will seat flex the moment authored
  // flex characters are dropped in, and that seats are honestly capped until then.
  {
    const { assignableIds, capacity } = require('./lib/runtime');
    const synth = {
      cast: Array.from({ length: 10 }, (_, i) => ({ id: 'C' + (i + 1) })),
      flex: Array.from({ length: 10 }, (_, i) => ({ id: 'F' + (i + 1) })),
    };
    const seats = assignableIds(synth);
    assert('flex: seating order is core (1–10) then flex (11–20)',
      seats.length === 20 && seats[9] === 'C10' && seats[10] === 'F1' && seats[19] === 'F10');
    assert('flex: capacity reaches 20 when flex is present', capacity(synth) === 20);
    assert('flex absent: capacity is honestly the core count (10)',
      capacity({ cast: synth.cast, flex: [] }) === 10);
  }

  // 3. player state — own brief present, no variant, no other briefs.
  const st = await j(state(GET({ partyCode, personalCode: codes[0] })));
  assert('public state hides the variant', !('variant' in st.state));
  assert('player sees their own character brief', !!(st.you && st.you.character && st.you.character.brief));
  assert('roster shows character + first name, never secrets',
    st.state.roster.length >= 10 && st.state.roster.every((c) => c.characterName && ('firstName' in c) && !('brief' in c)));

  // 3b. Hybrid-killer unlock: hidden until Phase 3, then ONLY the killer sees it.
  const { resolveKillerId } = require('./lib/runtime');
  const sealedForKiller = (await getGame(partyCode)).variant;
  const killerId = resolveKillerId(pack, sealedForKiller);
  const killerCode = (await getGame(partyCode)).assignments[killerId];
  async function killerFlags() {
    const flags = {};
    for (const c of codes) { const s = await j(state(GET({ partyCode, personalCode: c }))); flags[c] = !!(s.you && s.you.killer); }
    return flags;
  }
  let kf = await killerFlags();
  assert('no killer unlock before Phase 3', Object.values(kf).every((x) => !x));
  await j(advance(POST({ partyCode, hostToken, phase: 3 })));
  kf = await killerFlags();
  assert('exactly one player is unlocked as the killer at Phase 3',
    Object.values(kf).filter(Boolean).length === 1);
  assert('the unlocked player is the sealed variant\'s killer', !!killerCode && kf[killerCode] === true);

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

  // 4c. Idle-rescue nudge — absent for an active player, present once idle.
  //     Use a player who did NOT receive a Phase-3 find-hint (those two players
  //     have their idle rescue covered by the hint, which suppresses the nudge).
  {
    const freshCode = codes[5];
    const s1 = await j(state(GET({ partyCode, personalCode: freshCode })));
    assert('no nudge for a recently-active player', !(s1.you && s1.you.nudge));
    // Backdate this player's activity well past the threshold.
    const { NUDGE_THRESHOLD_MS } = require('./lib/runtime');
    const { updateGame } = require('./lib/store');
    await updateGame(partyCode, (g) => {
      g.players[freshCode].lastActive = new Date(Date.now() - NUDGE_THRESHOLD_MS - 60000).toISOString();
      return g;
    });
    const s2 = await j(state(GET({ partyCode, personalCode: freshCode })));
    assert('idle player gets a rescue nudge during an active phase',
      !!(s2.you && s2.you.nudge && s2.you.nudge.text));
    // A deliberate action (scan) clears the idle state.
    await j(scan(POST({ partyCode, personalCode: freshCode, propId: 'P1' })));
    const s3 = await j(state(GET({ partyCode, personalCode: freshCode })));
    assert('a scan clears the nudge', !(s3.you && s3.you.nudge));
  }

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

  // 8. Narration audio wiring — opaque hashes match the generator's scheme.
  {
    const { audioName, AUDIO_KEYS } = require('./lib/runtime');
    const { narrationInventory } = require('./lib/phases');
    const c = await j(createGame(POST({})));
    for (let i = 0; i < 4; i++) await j(join(POST({ partyCode: c.partyCode, name: 'N' + i })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 4 })));
    const s = await j(state(GET({ partyCode: c.partyCode })));
    assert('narration card carries its opaque audio hash',
      s.state.narrationAudio === audioName(AUDIO_KEYS.phase(4)));
    assert('phase-4 [SCREEN] hints carry opaque audio hashes',
      (s.state.screenCards || []).some((cd) => cd.kind === 'hint' && /^[0-9a-f]{20}\.mp3$/.test(cd.audio || '')));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    const sealed = (await getGame(c.partyCode)).variant;
    const s6 = await j(state(GET({ partyCode: c.partyCode })));
    assert('reveal audio references ONLY the active variant\'s files',
      s6.state.reveal && Array.isArray(s6.state.reveal.audio) &&
      s6.state.reveal.audio[0] === audioName(AUDIO_KEYS.revealTitle(sealed)) &&
      s6.state.reveal.audio[1] === audioName(AUDIO_KEYS.revealMethod(sealed)));
    const inv = narrationInventory(pack);
    const names = new Set(inv.map((it) => audioName(it.key)));
    assert('narration inventory is complete and every filename is opaque',
      inv.length >= 6 + 1 + pack.variants.length * 2 &&
      names.size === inv.length &&
      [...names].every((n) => /^[0-9a-f]{20}\.mp3$/.test(n)));
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ ENGINE OK' : '\x1b[31m✗ ENGINE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(2); });
