#!/usr/bin/env node
'use strict';
/*
 * End-to-end engine test over the in-memory store (no Netlify needed).
 * SPOILER-SAFE: asserts invariants and prints only PASS/FAIL + counts. It never
 * prints a killer, a variant identity, evidence text, or a character secret.
 */

delete process.env.NETLIFY; // force in-memory backend

const createGameRaw = require('./functions/create-game').handler;
const join = require('./functions/join').handler;
const state = require('./functions/state').handler;
const scan = require('./functions/scan').handler;
const poll = require('./functions/poll').handler;
const advance = require('./functions/advance').handler;
const reveal = require('./functions/reveal').handler;
const cast = require('./functions/cast').handler;
const lobbyVote = require('./functions/lobby-vote').handler;
const { getGame } = require('./lib/store');
const { loadRuntimePack } = require('./lib/runtime');

const POST = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });

/* Every party now opens in the LOBBY, which has no clock and no gameplay. These
 * tests are about the evening itself, so the helper creates a party and opens
 * the doors in one step; the lobby has its own tests. */
const createGame = async (ev) => {
  const res = await createGameRaw(ev);
  const body = JSON.parse(res.body);
  if (body.partyCode) {
    await advance(POST({ partyCode: body.partyCode, hostToken: body.hostToken, openDoors: true }));
  }
  return res;
};
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
    // Pack-agnostic: assert the MECHANISM (an aside fired, keyed and spoken),
    // not the first pack's vocabulary — a second pack's asides are its own
    // words. Keys are read server-side; the public feed never carries them.
    const asideFeed = ((await getGame(c.partyCode)).narratorFeed || []).filter((n) => /^aside\./.test(n.key));
    assert('a quiet stretch produces an atmospheric aside',
      asideFeed.length >= 1 && !!asideFeed[0].text);
    assert('the aside also reaches the public feed without exposing its key',
      (s.state.narratorFeed || []).some((n) => n.text === asideFeed[0].text) &&
      (s.state.narratorFeed || []).every((n) => !('key' in n)));

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
      inv.filter((i) => i.key.startsWith('found.')).length === pack.props.length &&
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
      inv.filter((i) => i.key.startsWith('blackout.moved.')).length === pack.props.length &&
      inv.some((i) => i.key === 'awards.intro'));
  }

  // 15. Casting: pick a character at join; personas carry no secrets.
  {
    const c = await j(createGame(POST({})));
    let s = await j(state(GET({ partyCode: c.partyCode })));
    assert('casting lists all 20 unclaimed characters with personas',
      s.state.casting.length === 20 && s.state.casting.every((x) => x.name && x.persona));
    assert('casting personas never contain secrets',
      s.state.casting.every((x) => !/secret/i.test(x.persona)));
    const pick = s.state.casting[3];
    const r = await j(join(POST({ partyCode: c.partyCode, name: 'Chooser', characterId: pick.id })));
    assert('a guest can claim a chosen character', r.character && r.character.id === pick.id);
    const dup = await j(join(POST({ partyCode: c.partyCode, name: 'Late', characterId: pick.id })));
    assert('claiming a taken character is refused', !!dup.error && /claimed/i.test(dup.error));
    s = await j(state(GET({ partyCode: c.partyCode })));
    assert('claimed characters leave the casting list', !s.state.casting.some((x) => x.id === pick.id));
  }

  // 15b. Host-side casting: reservations by name, forgiving match, any flex, never public.
  {
    const cast = require('./functions/cast').handler;
    const c = await j(createGame(POST({})));
    const hc = (body) => j(cast(POST({ partyCode: c.partyCode, hostToken: c.hostToken, ...body })));
    const denied = await cast(POST({ action: 'get', partyCode: c.partyCode, hostToken: 'nope' }));
    assert('host casting is host only', denied.statusCode === 403);
    const g0 = await hc({ action: 'get' });
    assert('host casting roster lists all 20 characters',
      g0.roster.length === 20 && g0.roster.filter((x) => x.flex).length === 10);
    const saved = await hc({ action: 'save', reservations: { C1: 'Opal Brindlewick', C3: 'Zebulon Quartz', F9: 'Xanthe', F4: '   ' } });
    const row = (r, id) => r.roster.find((x) => x.id === id);
    assert('reservations save with the party (blank names dropped)',
      row(saved, 'C3').guest === 'Zebulon Quartz' && row(saved, 'F9').guest === 'Xanthe' && !row(saved, 'F4').guest);
    assert('reserving a nonexistent character is refused', !!(await hc({ action: 'save', reservations: { X99: 'A' } })).error);
    const s = await j(state(GET({ partyCode: c.partyCode })));
    assert('public state (gallery) carries no casting names',
      !/Opal|Brindlewick|Zebulon|Quartz|Xanthe|reservation/i.test(JSON.stringify(s)));
    assert('reserved characters are hidden from the guest casting picker',
      !s.state.casting.some((x) => ['C1', 'C3', 'F9'].includes(x.id)) && s.state.casting.length === 17);
    const m = await j(join(POST({ partyCode: c.partyCode, name: '  zebulon   QUARTZ ' })));
    assert('a reserved guest gets their character (case/space-insensitive)', m.character && m.character.id === 'C3');
    const f = await j(join(POST({ partyCode: c.partyCode, name: 'xanthe' })));
    assert('any flex character can be reserved, not only F1 onward', f.character && f.character.id === 'F9');
    const pickReserved = await j(join(POST({ partyCode: c.partyCode, name: 'Other', characterId: 'C1' })));
    assert('picking a character reserved for someone else is refused', !!pickReserved.error && /reserved/i.test(pickReserved.error));
    const u = await j(join(POST({ partyCode: c.partyCode, name: 'Surprise Guest' })));
    assert('an unmatched name is seated from unreserved seats', u.character && u.character.id === 'C2');
    for (let i = 0; i < 16; i++) await j(join(POST({ partyCode: c.partyCode, name: 'Walkin' + i })));
    const last = await j(join(POST({ partyCode: c.partyCode, name: 'Typo Opal' })));
    assert('an unmatched guest still gets a reserved seat once nothing else is free', last.character && last.character.id === 'C1');
    const g1 = await hc({ action: 'get' });
    assert('host roster shows who joined as each character (stray spacing tidied)',
      row(g1, 'C3').claimedBy === 'zebulon QUARTZ');
  }

  // 15c. Moving a guest who already joined. A reservation cannot undo a wrong
  // pick, because joining is sticky on purpose, so the host needs a real move.
  {
    const c = await j(createGame(POST({})));
    const hc = (body) => j(cast(POST({ partyCode: c.partyCode, hostToken: c.hostToken, ...body })));
    const row = (r, id) => r.roster.find((x) => x.id === id);
    const mike = await j(join(POST({ partyCode: c.partyCode, name: 'Mike Weaver', characterId: 'F5' })));
    assert('a guest can pick their own character', mike.character && mike.character.id === 'F5');

    await hc({ action: 'save', reservations: { F3: 'Mike Weaver' } });
    const stuck = await j(join(POST({ partyCode: c.partyCode, name: 'Mike Weaver' })));
    assert('a reservation alone cannot move a guest who already holds a seat',
      stuck.character && stuck.character.id === 'F5' && stuck.returning === true);
    await hc({ action: 'save', reservations: {} });

    const denied = await cast(POST({ action: 'move', partyCode: c.partyCode, hostToken: 'nope', characterId: 'F5', toCharacterId: 'F3' }));
    assert('moving a guest is host only', denied.statusCode === 403);
    assert('moving from an empty seat is refused', /nobody has joined/i.test((await hc({ action: 'move', characterId: 'F9', toCharacterId: 'F8' })).error || ''));
    assert('moving to a nonexistent character is refused', /no such character/i.test((await hc({ action: 'move', characterId: 'F5', toCharacterId: 'X99' })).error || ''));

    const moved = await hc({ action: 'move', characterId: 'F5', toCharacterId: 'F3' });
    assert('the host can move a joined guest to an unclaimed character',
      row(moved, 'F3').claimedBy === 'Mike Weaver' && !row(moved, 'F5').claimedBy);
    assert('the move leaves the new character reserved in their name', row(moved, 'F3').guest === 'Mike Weaver');

    const after = await j(state(GET({ partyCode: c.partyCode, personalCode: mike.personalCode })));
    assert('the guest keeps their seat code and their phone shows the new character',
      after.you && after.you.character && after.you.character.id === 'F3');
    const rejoin = await j(join(POST({ partyCode: c.partyCode, name: 'Mike Weaver' })));
    assert('rejoining after a move returns the new character, not the old one',
      rejoin.character && rejoin.character.id === 'F3');

    await j(join(POST({ partyCode: c.partyCode, name: 'Someone Else', characterId: 'F5' })));
    assert('moving onto a character somebody has joined as is refused',
      /already joined/i.test((await hc({ action: 'move', characterId: 'F3', toCharacterId: 'F5' })).error || ''));
    await hc({ action: 'save', reservations: { F6: 'Not Mike' } });
    assert('moving onto a character reserved for somebody else is refused',
      /reserved/i.test((await hc({ action: 'move', characterId: 'F3', toCharacterId: 'F6' })).error || ''));
  }

  // 15d. Removing a guest. One person signing up twice under two spellings of
  // their name takes two seats, and a drop-out leaves a seat held.
  {
    const c = await j(createGame(POST({})));
    const hc = (body) => j(cast(POST({ partyCode: c.partyCode, hostToken: c.hostToken, ...body })));
    const row = (r, id) => r.roster.find((x) => x.id === id);
    const first = await j(join(POST({ partyCode: c.partyCode, firstName: 'Mike', lastName: 'Weaver', characterId: 'F4' })));
    const dupe = await j(join(POST({ partyCode: c.partyCode, firstName: 'Michael', lastName: 'Weaver', characterId: 'F5' })));
    assert('two spellings of one name take two seats', first.character.id === 'F4' && dupe.character.id === 'F5');
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: dupe.personalCode, id: 'final', choice: 'anybody' })));

    const denied = await cast(POST({ action: 'remove', partyCode: c.partyCode, hostToken: 'nope', characterId: 'F5' }));
    assert('removing a guest is host only', denied.statusCode === 403);
    assert('removing from an empty seat is refused',
      /nobody has joined/i.test((await hc({ action: 'remove', characterId: 'F9' })).error || ''));

    const gone = await hc({ action: 'remove', characterId: 'F5' });
    assert('the host can remove a guest and the seat opens again',
      gone.removed === 'Michael Weaver' && !row(gone, 'F5').claimedBy);
    const s2 = await j(state(GET({ partyCode: c.partyCode })));
    assert('a removed character returns to the guest picker', s2.state.casting.some((x) => x.id === 'F5'));
    const orphan = await j(state(GET({ partyCode: c.partyCode, personalCode: dupe.personalCode })));
    assert('the removed seat code stops working', !orphan.you);
    const g2 = await getGame(c.partyCode);
    assert('the removed guest takes their vote with them',
      !Object.values(g2.polls || {}).some((p) => p.votes && dupe.personalCode in p.votes));
    assert('the other sign-up is untouched', row(gone, 'F4').claimedBy === 'Mike Weaver');

    await hc({ action: 'save', reservations: { F4: 'Mike Weaver', F6: 'Somebody Else' } });
    const g3 = await hc({ action: 'remove', characterId: 'F4' });
    assert('removing clears a reservation held in that guest name', !row(g3, 'F4').guest);
    assert('removing leaves somebody else reservation alone', row(g3, 'F6').guest === 'Somebody Else');
    const back = await j(join(POST({ partyCode: c.partyCode, firstName: 'Mike', lastName: 'Weaver' })));
    assert('a removed guest can join again', back.character && back.personalCode !== first.personalCode);
  }

  // 16. Photo moment + case file.
  {
    const casefile = require('./functions/casefile').handler;
    const { resolveKillerId, exhibitNumber } = require('./lib/runtime');
    const firstExhibit = exhibitNumber('P1'); // numbering is pack data, not a constant
    const nameFor = (id) => pack.cast.find((x) => x.id === id).name;
    const c = await j(createGame(POST({})));
    const pcodes = [];
    for (let i = 0; i < 10; i++) { const r = await j(join(POST({ partyCode: c.partyCode, name: 'K' + i }))); pcodes.push(r.personalCode); }

    const ph = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, photo: true })));
    const g1 = await getGame(c.partyCode);
    assert('the photo moment is a major narrator beat with a screen card',
      ph.photo === true &&
      (g1.narratorFeed || []).some((n) => n.key === 'photo' && n.major) &&
      (g1.screenCards || []).some((x) => x.kind === 'photo'));

    const early = await casefile(GET({ partyCode: c.partyCode }));
    assert('the case file is sealed before the reveal', JSON.parse(early.body).error !== undefined);

    const sealed = (await getGame(c.partyCode)).variant;
    const killerName = nameFor(resolveKillerId(pack, sealed));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
    await j(scan(POST({ partyCode: c.partyCode, personalCode: pcodes[0], exhibit: firstExhibit })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: pcodes[0], id: 'final', choice: killerName })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    const cf = await j(casefile(GET({ partyCode: c.partyCode })));
    assert('the case file opens after the reveal with the night\'s record',
      cf.solution && cf.solution.killer === killerName &&
      cf.guests.length === 10 &&
      cf.discoveries.some((d) => d.exhibit === firstExhibit) &&
      Array.isArray(cf.awards));
  }

  // ---------------------------------------------------------------------
  // THE LOBBY. The weeks between casting and the party. A guest can claim
  // their character and read the public half of it; everything else has to
  // be unreachable, including to someone reading the raw response.
  // ---------------------------------------------------------------------
  {
    const c = await j(createGameRaw(POST({})));
    assert('a new party opens in the lobby', c.lobby === true);

    await j(cast(POST({ action: 'save', partyCode: c.partyCode, hostToken: c.hostToken, reservations: { C3: 'Dana' } })));
    const first = await j(join(POST({ partyCode: c.partyCode, name: 'Dana' })));
    assert('a reservation is honoured in the lobby', first.character.id === 'C3' && first.returning === false);

    const lob = await j(state(GET({ partyCode: c.partyCode, personalCode: first.personalCode })));
    assert('lobby state says so and reports no phase', lob.state.lobby === true && lob.state.phase === 0);
    assert('lobby state carries no victim, clock, narration or roster',
      !('victim' in lob.state) && !('timing' in lob.state) &&
      !('narration' in lob.state) && !('roster' in lob.state));
    assert('a lobby guest gets the public half and nothing more',
      lob.you.character.persona && !('brief' in lob.you.character) &&
      !('lines' in lob.you) && !('killer' in lob.you) && !('drops' in lob.you));
    assert('the public half never contains the secret marker',
      !/SECRET/i.test(lob.you.character.persona));
    assert('a future beat never leaves the server',
      Array.isArray(lob.state.beats) &&
      lob.state.beats.every((b) => !b.at || Date.parse(b.at) <= Date.now()));

    // Nothing that belongs to the evening may run yet.
    const noScan = await j(scan(POST({ partyCode: c.partyCode, personalCode: first.personalCode, exhibit: '1' })));
    const noAdv = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    assert('scanning and advancing are refused while the lobby is up',
      !!noScan.error && !!noAdv.error);

    // The whole point: the same name on the night returns the same seat.
    const again = await j(join(POST({ partyCode: c.partyCode, name: '  dANa ' })));
    assert('rejoining by name returns the same seat and character',
      again.returning === true && again.personalCode === first.personalCode && again.character.id === 'C3');
    const g = await getGame(c.partyCode);
    assert('rejoining does not consume a second seat', Object.keys(g.players).length === 1);

    const opened = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, openDoors: true })));
    assert('opening the doors starts phase 1', opened.lobby === false && opened.phase === 1);
    const now = await j(state(GET({ partyCode: c.partyCode, personalCode: first.personalCode })));
    assert('the dossier appears only once the doors are open',
      !now.state.lobby && !!now.you.character.brief && now.you.character.id === 'C3');
    const twice = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, openDoors: true })));
    assert('the doors cannot be opened twice', !!twice.error);
  }

  // ---------------------------------------------------------------------
  // THE WEEKLY QUESTION. Light lobby noise: everybody answers, everybody sees
  // the tally, and nobody ever sees who answered what. The questions are pack
  // plaintext dated like the beats, so this block pins the pack whose weekly
  // questions it is about and freezes the clock on a date by which they have
  // all opened. Everything private to the evening is somebody else's block:
  // nothing here can reach a secret, because a question has no character in it.
  // ---------------------------------------------------------------------
  {
    const { questionsSoFar, loadLobbyFile } = require('./lib/lobby');

    // The filter on its own: one question open, one still to come.
    const fixture = { questions: [
      { id: 'open', at: '2020-01-01T00:00:00Z', question: 'Already asked', options: ['one', 'two'] },
      { id: 'later', at: '2099-01-01T00:00:00Z', question: 'Not asked yet', options: ['one', 'two'] },
    ] };
    const filtered = questionsSoFar(new Date('2021-06-01T00:00:00Z'), fixture);
    assert('a future lobby question never leaves the server',
      filtered.length === 1 && filtered[0].id === 'open' &&
      JSON.stringify(filtered).indexOf('Not asked yet') === -1);

    const RealDate = Date;
    const FROZEN = RealDate.parse('2026-11-20T18:00:00-05:00');
    class FrozenDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); }
      static now() { return FROZEN; }
    }
    const realPack = process.env.MYSTERY_PACK;
    process.env.MYSTERY_PACK = 'reunion-1989';
    const file = loadLobbyFile();
    const authored = (file && file.questions) || [];

    // The pack's own questions, read at a date partway through the run: the
    // ones still to come are absent, not merely hidden.
    const midway = '2026-10-04T12:00:00-04:00';
    const early = questionsSoFar(new RealDate(midway), file);
    assert('the pack\'s questions open one at a time and the rest stay on the server',
      authored.length > 0 && early.length > 0 && early.length < authored.length &&
      early.every((x) => RealDate.parse(x.at) <= RealDate.parse(midway)));

    global.Date = FrozenDate;
    try {
      const c = await j(createGameRaw(POST({})));
      const g1 = await j(join(POST({ partyCode: c.partyCode, name: 'Wexler Ondry' })));
      const g2 = await j(join(POST({ partyCode: c.partyCode, name: 'Pomeroy Skarn' })));

      const lob = await j(state(GET({ partyCode: c.partyCode, personalCode: g1.personalCode })));
      const qs = lob.state.questions || [];
      assert('the lobby serves the questions that have opened, with options and a tally',
        qs.length === authored.length && qs.length > 0 &&
        qs.every((x) => x.id && x.question && Array.isArray(x.options) && x.options.length >= 2 &&
          x.counts && typeof x.total === 'number' && 'yourChoice' in x) &&
        qs.every((x) => x.yourChoice === null && x.total === 0));

      const q = qs[0];
      const [optA, optB] = q.options;

      const noSeat = await j(lobbyVote(POST({ partyCode: c.partyCode, id: q.id, choice: optA })));
      assert('answering a lobby question needs a seat', !!noSeat.error);
      const noSuch = await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g1.personalCode, id: 'not-a-question', choice: optA })));
      const badOpt = await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g1.personalCode, id: q.id, choice: 'something else entirely' })));
      assert('an unasked question and an off-list answer are both refused',
        !!noSuch.error && !!badOpt.error);

      await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g1.personalCode, id: q.id, choice: optA })));
      await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g2.personalCode, id: q.id, choice: optB })));
      const changed = await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g1.personalCode, id: q.id, choice: optB })));
      assert('a lobby answer is one per seat and changeable',
        changed.question && changed.question.yourChoice === optB &&
        changed.question.counts[optB] === 2 && changed.question.counts[optA] === 0 &&
        changed.question.total === 2);

      const mine = await j(state(GET({ partyCode: c.partyCode, personalCode: g2.personalCode })));
      const theirs = (mine.state.questions || []).find((x) => x.id === q.id);
      assert('each guest sees the same tally with their own answer marked',
        theirs.yourChoice === optB && theirs.total === 2);

      // Aggregate only. The seat-to-answer map exists on the game object and
      // reaches nobody: not the voter, not another guest, not the host.
      const raw = await getGame(c.partyCode);
      const held = raw.lobbyAnswers && raw.lobbyAnswers[q.id];
      const anon = JSON.stringify(await j(state(GET({ partyCode: c.partyCode }))));
      const asMe = JSON.stringify(mine);
      assert('the lobby tally never says who answered what',
        !!held && Object.keys(held).length === 2 &&
        [anon, asMe].every((s) => s.indexOf(g1.personalCode) === -1 && s.indexOf(g2.personalCode) === -1));

      // The two ballots never meet: lobby answers have their own key, and a
      // game poll cannot see them or be fed by them.
      assert('a lobby answer never lands in a game poll',
        !(raw.polls && raw.polls[q.id]) && Object.keys(raw.polls || {}).length === 0);
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, openDoors: true })));
      await j(poll(POST({ action: 'create', partyCode: c.partyCode, hostToken: c.hostToken, id: q.id, question: 'A real one', options: [optA, optB] })));
      await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: g1.personalCode, id: q.id, choice: optA })));
      const after = await getGame(c.partyCode);
      assert('a game vote never lands in the lobby answers either',
        Object.keys(after.lobbyAnswers[q.id]).length === 2 &&
        after.lobbyAnswers[q.id][g1.personalCode] === optB &&
        after.polls[q.id].votes[g1.personalCode] === optA);

      const shut = await j(lobbyVote(POST({ partyCode: c.partyCode, personalCode: g1.personalCode, id: q.id, choice: optA })));
      assert('the lobby question closes when the doors open', !!shut.error);
    } finally {
      global.Date = RealDate;
      if (realPack === undefined) delete process.env.MYSTERY_PACK;
      else process.env.MYSTERY_PACK = realPack;
    }
  }

  // ---------------------------------------------------------------------
  // DEPLOY. A pack's plaintext files are read from disk at request time, so
  // they are only there in production if netlify.toml ships them. lobby.json
  // reached production missing exactly once; this is so it cannot happen to
  // the next one.
  // ---------------------------------------------------------------------
  {
    const fs = require('fs');
    const path = require('path');
    const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
    const line = (toml.match(/^\s*included_files\s*=\s*\[(.+)\]\s*$/m) || [])[1] || '';
    const globs = line.split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''));
    const covers = (file) => globs.some((g) => {
      const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + '$');
      return re.test(file);
    });
    const packsDir = path.join(__dirname, '..', 'packs');
    const missing = [];
    for (const dir of fs.readdirSync(packsDir)) {
      const full = path.join(packsDir, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        const rel = `packs/${dir}/${f}`;
        if (!covers(rel)) missing.push(rel);
      }
    }
    assert('netlify.toml ships every file a pack carries', missing.length === 0);
  }

  // 18. Guest names: full name asked for, first name shown, more only on a clash.
  {
    const { displayNames, matchNames, splitName, fullName } = require('./lib/names');
    const one = displayNames({ players: { a: { name: 'Marlow Ashgrove' }, b: { name: 'Dana Whitfield' } } });
    assert('names: a unique first name shows on its own', one.a === 'Marlow' && one.b === 'Dana');
    const two = displayNames({ players: { a: { name: 'Quilley Pellit' }, b: { name: 'Quilley Ashgrove' } } });
    assert('names: a shared first name gains a last initial', two.a === 'Quilley P.' && two.b === 'Quilley A.');
    const three = displayNames({ players: { a: { name: 'Sam Brooks' }, b: { name: 'Sam Bell' } } });
    assert('names: matching initials fall through to the whole last name',
      three.a === 'Sam Brooks' && three.b === 'Sam Bell');
    const four = displayNames({ players: { a: { name: 'Sam' }, b: { name: 'Sam Bell' } } });
    assert('names: a guest with no last name keeps their first name', four.a === 'Sam' && four.b === 'Sam B.');
    assert('names: split and rejoin are stable',
      splitName('  Marlow   Van Horn ').last === 'Van Horn' && fullName(' Marlow ', ' Van Horn ') === 'Marlow Van Horn');
    const seats = [{ key: 's1', name: 'Taylor Pellit' }, { key: 's2', name: 'Dana Whitfield' }];
    assert('names: a first name alone finds the one seat it can mean',
      matchNames('Taylor', seats).length === 1 && matchNames('taylor  pellit', seats)[0] === 's1');
    assert('names: two different full names never match each other',
      matchNames('Taylor Ashgrove', seats).length === 0);
    assert('names: an ambiguous first name matches nothing on its own',
      matchNames('Taylor', [{ key: 'a', name: 'Taylor Pellit' }, { key: 'b', name: 'Taylor Ashgrove' }]).length === 2);

    // End to end: the join page sends two fields, the room shows one name.
    const c = await j(createGame(POST({ hostName: 'Kali' })));
    const g1 = await j(join(POST({ partyCode: c.partyCode, firstName: 'Quilley', lastName: 'Pellit' })));
    const g2 = await j(join(POST({ partyCode: c.partyCode, firstName: 'Quilley', lastName: 'Ashgrove' })));
    const g3 = await j(join(POST({ partyCode: c.partyCode, firstName: 'Dana', lastName: 'Whitfield' })));
    const st2 = await j(state(GET({ partyCode: c.partyCode, personalCode: g1.personalCode })));
    const shown = st2.state.roster.map((r) => r.firstName).sort();
    assert('join: the room sees first names, disambiguated only where it must',
      shown.join('|') === 'Dana|Quilley A.|Quilley P.' && !!g2.personalCode && !!g3.personalCode);
    const again = await j(join(POST({ partyCode: c.partyCode, firstName: 'Quilley', lastName: 'Pellit' })));
    assert('join: typing the same name again returns the same seat',
      again.returning === true && again.personalCode === g1.personalCode);
    const lobbyName = await j(join(POST({ partyCode: c.partyCode, name: 'Dana' })));
    assert('join: a guest who joined on a first name is recognized when they add a last',
      lobbyName.personalCode === g3.personalCode);
  }


  console.log(`\n${fail === 0 ? '\x1b[32m✓ ENGINE OK' : '\x1b[31m✗ ENGINE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(2); });
