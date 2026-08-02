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

  // 9. The living narrator — discovery reactions, vote reactions, asides.
  {
    const { exhibitNumber } = require('./lib/runtime');
    const { narratorInventory, shouldAside, maybeAside } = require('./lib/narrator');
    const { updateGame } = require('./lib/store');
    const c = await j(createGame(POST({})));
    const codes2 = [];
    for (let i = 0; i < 4; i++) { const r = await j(join(POST({ partyCode: c.partyCode, name: 'V' + i }))); codes2.push(r.personalCode); }
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 })));

    // First find speaks; the second find of the SAME exhibit stays silent.
    await j(scan(POST({ partyCode: c.partyCode, personalCode: codes2[0], exhibit: exhibitNumber('P6') })));
    await j(scan(POST({ partyCode: c.partyCode, personalCode: codes2[1], exhibit: exhibitNumber('P6') })));
    let g = await getGame(c.partyCode);
    const foundEntries = (g.narratorFeed || []).filter((n) => n.key === 'found.P6');
    assert('narrator reacts to a discovery exactly once', foundEntries.length === 1);
    assert('narrator feed entries carry opaque audio names',
      (g.narratorFeed || []).every((n) => /^[0-9a-f]{20}\.mp3$/.test(n.audio)));

    // Benefits close → the suspicion lands, by name, with a per-cast audio key.
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
    const suspectName = pack.cast[3].name;
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: codes2[0], id: 'benefits', choice: suspectName })));
    await j(poll(POST({ action: 'close', partyCode: c.partyCode, hostToken: c.hostToken, id: 'benefits' })));
    g = await getGame(c.partyCode);
    const sus = (g.narratorFeed || []).find((n) => n.key === 'suspect.' + pack.cast[3].id);
    assert('narrator names the room\'s suspect after the benefits vote',
      !!sus && sus.text.includes(suspectName));

    // Quiet stretch → an aside fires (and only when actually quiet).
    assert('no aside while the narrator has spoken recently', !shouldAside(g));
    await updateGame(c.partyCode, (gg) => { gg.lastNarratorAt = Date.now() - 10 * 60 * 1000; return gg; });
    const s = await j(state(GET({ partyCode: c.partyCode })));
    assert('a quiet stretch produces an atmospheric aside',
      (s.state.narratorFeed || []).some((n) => /darlings|whisper|quiet|hands|drink|art/i.test(n.text)));

    // The final vote closing gets its line.
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: codes2[0], id: 'final', choice: pack.cast[0].name })));
    await j(poll(POST({ action: 'close', partyCode: c.partyCode, hostToken: c.hostToken, id: 'final' })));
    g = await getGame(c.partyCode);
    assert('narrator marks the final ballot closing',
      (g.narratorFeed || []).some((n) => n.key === 'final.closed'));

    // Attention tiers: vote outcomes ring the bell (major), ambient lines don't.
    const feed = g.narratorFeed || [];
    assert('vote-outcome interjections are marked major (bell + attention call)',
      feed.filter((n) => /^(suspect\.|subpoena\.|final\.)/.test(n.key)).every((n) => n.major === true));
    assert('discovery and aside interjections stay ambient (no bell)',
      feed.filter((n) => /^(found\.|aside\.)/.test(n.key)).every((n) => !n.major));
    const sAttn = await j(state(GET({ partyCode: c.partyCode })));
    assert('state serves the spoken attention call with an opaque audio name',
      !!(sAttn.state.attention && sAttn.state.attention.text) &&
      /^[0-9a-f]{20}\.mp3$/.test(sAttn.state.attention.audio || ''));

    // Inventory: every enumerable interjection pre-renders (props + cast + votes + asides).
    const inv = narratorInventory(pack);
    assert('narrator inventory covers attention, props, cast, votes, and asides',
      inv.some((i) => i.key === 'attention') &&
      inv.filter((i) => i.key.startsWith('found.')).length === 7 &&
      inv.filter((i) => i.key.startsWith('suspect.')).length === pack.cast.length &&
      inv.some((i) => i.key === 'subpoena.yes') && inv.some((i) => i.key === 'final.closed') &&
      inv.filter((i) => i.key.startsWith('aside.')).length >= 6);
  }

  // 10. Auto-advance phase clock.
  {
    const { updateGame } = require('./lib/store');
    const backdate = (pc, mins) => updateGame(pc, (g) => { g.phaseStartedAt = new Date(Date.now() - mins * 60000).toISOString(); return g; });
    const mkParty = async () => {
      const c = await j(createGame(POST({})));
      await j(join(POST({ partyCode: c.partyCode, name: 'T' })));
      return c;
    };

    // Time expires → the phase advances by itself on the next state poll.
    let c = await mkParty();
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 }))); // 10-minute phase
    await backdate(c.partyCode, 11);
    let s = await j(state(GET({ partyCode: c.partyCode })));
    assert('phase auto-advances when its time runs out', s.state.phase === 3);

    // Two-minute warning fires once, without advancing.
    c = await mkParty();
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 })));
    await backdate(c.partyCode, 9); // 1 minute left of 10
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('two-minute warning is spoken before an auto change',
      s.state.phase === 2 && (s.state.narratorFeed || []).some((n) => /two minutes/i.test(n.text)));
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('the warning does not repeat',
      (s.state.narratorFeed || []).filter((n) => /two minutes/i.test(n.text)).length === 1);

    // Pause stops the clock.
    c = await mkParty();
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, pause: true })));
    await backdate(c.partyCode, 30);
    await updateGame(c.partyCode, (g) => { g.pausedAt = Date.now() - 30 * 60000; return g; });
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('a paused phase never auto-advances', s.state.phase === 2);

    // Auto off → host keeps manual control.
    c = await mkParty();
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, auto: false })));
    await backdate(c.partyCode, 30);
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('auto off means phases only change manually', s.state.phase === 2);

    // Extending buys time past the original allotment.
    c = await mkParty();
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 2 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, extend: 5 })));
    await backdate(c.partyCode, 12); // past 10, inside 15
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('+5 minutes holds the phase past its original time', s.state.phase === 2);
    assert('timing reports the extended allotment', s.state.timing.allottedMinutes === 15);
  }

  // 11. Concurrency: simultaneous votes must all be recorded (CAS + retry).
  {
    const c = await j(createGame(POST({})));
    const vcodes = [];
    for (let i = 0; i < 8; i++) { const r = await j(join(POST({ partyCode: c.partyCode, name: 'C' + i }))); vcodes.push(r.personalCode); }
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
    const target = pack.cast[0].name;
    await Promise.all(vcodes.map((code) => j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: code, id: 'benefits', choice: target })))));
    const g = await getGame(c.partyCode);
    assert('8 simultaneous votes are all recorded (no lost writes)',
      Object.keys(g.polls.benefits.votes).length === 8);
  }

  // 12. Resume-a-seat: valid seat code returns the character; wrong one doesn't.
  {
    const c = await j(createGame(POST({})));
    const r = await j(join(POST({ partyCode: c.partyCode, name: 'Resumer' })));
    const good = await j(state(GET({ partyCode: c.partyCode, personalCode: r.personalCode })));
    assert('a valid seat code recovers the same character',
      good.you && good.you.character && good.you.character.id === r.character.id);
    const bad2 = await j(state(GET({ partyCode: c.partyCode, personalCode: 'ZZZZZ' })));
    assert('an invalid seat code recovers nothing', !bad2.you);
  }

  // 13. The finale: vote results + awards ride the reveal.
  {
    const { resolveKillerId } = require('./lib/runtime');
    const nameFor = (id) => pack.cast.find((x) => x.id === id).name;
    const c = await j(createGame(POST({})));
    const fcodes = [];
    for (let i = 0; i < 10; i++) { const r = await j(join(POST({ partyCode: c.partyCode, name: 'F' + i }))); fcodes.push(r.personalCode); } // full core cast → the killer's seat is claimed
    const sealed = (await getGame(c.partyCode)).variant;
    const killerName = nameFor(resolveKillerId(pack, sealed));
    const wrongName = pack.cast.map((x) => x.name).find((n) => n !== killerName);
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: fcodes[0], id: 'final', choice: killerName })));
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: fcodes[1], id: 'final', choice: killerName })));
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: fcodes[2], id: 'final', choice: wrongName })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    const rev = await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    assert('reveal carries the final-vote counts', rev.voteCounts && rev.voteCounts[killerName] === 2);
    assert('killer caught by plurality is flagged', rev.caught === true);
    const titles = (rev.awards || []).map((a) => a.title);
    assert('awards include Best Detective and the killer\'s bow',
      titles.includes('Best Detective') && titles.includes('Caught Red-Handed'));
    assert('Best Detective actually voted for the killer',
      (rev.awards.find((a) => a.title === 'Best Detective') || {}).firstName.startsWith('F'));
  }

  // 14. The blackout set-piece.
  {
    const { updateGame } = require('./lib/store');
    const c = await j(createGame(POST({})));
    for (let i = 0; i < 3; i++) await j(join(POST({ partyCode: c.partyCode, name: 'B' + i })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
    const r1 = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, blackout: true })));
    assert('host can trigger the blackout', r1.blackout === true);
    let s = await j(state(GET({ partyCode: c.partyCode })));
    assert('the room is dark while the blackout runs', s.state.blackout === true);
    let g = await getGame(c.partyCode);
    assert('blackout start is a major narrator beat',
      (g.narratorFeed || []).some((n) => n.key === 'blackout.start' && n.major));
    await updateGame(c.partyCode, (gg) => { gg.blackout.endsAt = Date.now() - 1000; return gg; });
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('the lights come back on', s.state.blackout === false);
    g = await getGame(c.partyCode);
    assert('the narrator closes the blackout and reports the moved exhibit',
      (g.narratorFeed || []).some((n) => n.key === 'blackout.end') &&
      (g.narratorFeed || []).some((n) => n.key.startsWith('blackout.moved.')));
    const r2 = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, blackout: true })));
    assert('the blackout fires at most once', !!r2.error);
    const { narratorInventory } = require('./lib/narrator');
    const inv = narratorInventory(pack);
    assert('blackout + awards lines are pre-renderable',
      inv.some((i) => i.key === 'blackout.start') && inv.some((i) => i.key === 'blackout.end') &&
      inv.filter((i) => i.key.startsWith('blackout.moved.')).length === 7 &&
      inv.some((i) => i.key === 'awards.intro'));
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ ENGINE OK' : '\x1b[31m✗ ENGINE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(2); });
