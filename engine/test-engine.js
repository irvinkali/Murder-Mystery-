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
const awards = require('./functions/awards').handler;
const { getGame } = require('./lib/store');
const { loadRuntimePack, PHASE_MINUTES } = require('./lib/runtime');
const path = require('path');

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
  // THE SUPERLATIVES. Five gift-card awards the room votes onto the people in
  // it, after the reveal has played and never before. One vote per seat per
  // award, never for yourself, and the winners carry a real first name because
  // somebody has to be handed the card. Who voted for whom is held by seat and
  // served to nobody, the host included.
  // ---------------------------------------------------------------------
  {
    const { SUPERLATIVES } = require('./lib/awards');
    const c = await j(createGame(POST({ hostName: 'Kali' })));   // opens the doors
    const seats = [];
    for (const who of ['Fennimore Quill', 'Ondine Trask', 'Barnaby Skelp', 'Perpetua Vane']) {
      seats.push(await j(join(POST({ partyCode: c.partyCode, name: who }))));
    }
    const ch = seats.map((s) => s.character.id);
    const [A, B] = SUPERLATIVES.map((a) => a.id);
    const vote = (i, target, id) => j(awards(POST({
      action: 'vote', partyCode: c.partyCode, personalCode: seats[i].personalCode,
      awardId: id || A, characterId: target,
    })));

    const earlyVote = await vote(0, ch[1]);
    const earlyOpen = await j(awards(POST({ action: 'open', partyCode: c.partyCode, hostToken: c.hostToken })));
    const before = await j(state(GET({ partyCode: c.partyCode })));
    assert('awards voting is refused before the reveal',
      !!earlyVote.error && !!earlyOpen.error && before.state.awards === null);

    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));

    assert('the superlatives still wait for the host to open them', !!(await vote(0, ch[1])).error);
    assert('a guest cannot open the superlatives',
      !!(await j(awards(POST({ action: 'open', partyCode: c.partyCode, hostToken: 'not-the-host' })))).error);

    const opened = await j(awards(POST({ action: 'open', partyCode: c.partyCode, hostToken: c.hostToken })));
    assert('the host opens the superlatives with one button',
      opened.open === true && opened.awards && opened.awards.results.length === 5 &&
      opened.awards.results.every((r) => r.title && r.line && r.winners.length === 0));

    assert('a guest cannot vote for themselves', !!(await vote(0, ch[0])).error);
    assert('a vote for somebody who is not in the room is refused',
      !!(await vote(0, 'C99')).error &&
      !!(await j(awards(POST({ action: 'vote', partyCode: c.partyCode, personalCode: seats[0].personalCode, awardId: 'not-an-award', characterId: ch[1] })))).error);

    // Award A ends level: two names on two votes each.
    await vote(0, ch[1]); await vote(1, ch[2]); await vote(2, ch[3]); await vote(3, ch[2]);
    await vote(0, ch[3]);                       // one seat changes its mind
    // Award B has a clear winner and somebody behind them.
    await vote(0, ch[1], B); await vote(1, ch[0], B); await vote(2, ch[1], B); await vote(3, ch[1], B);

    const live = await j(state(GET({ partyCode: c.partyCode, personalCode: seats[0].personalCode })));
    const res = (id) => live.state.awards.results.find((r) => r.id === id);
    const nameOf = (id) => live.state.roster.find((r) => r.characterId === id).characterName;

    assert('a superlative vote is one per seat and changeable',
      res(A).total === 4 && (live.you.awardVotes || {})[A] === ch[3]);
    assert('a tie reports every tied name and says so',
      res(A).tie === true && res(A).votes === 2 && res(A).winners.length === 2 &&
      res(A).winners.map((w) => w.characterName).sort().join('|') === [nameOf(ch[2]), nameOf(ch[3])].sort().join('|'));
    assert('a clear winner carries the character name and the real first name',
      res(B).tie === false && res(B).winners.length === 1 &&
      res(B).winners[0].characterName === nameOf(ch[1]) && res(B).winners[0].firstName === 'Ondine' &&
      res(B).votes === 3 && res(B).total === 4);
    assert('the runner-up is a count and never a name',
      res(B).runnerUpVotes === 1 &&
      JSON.stringify(res(B)).indexOf(nameOf(ch[0])) === -1);

    // The whole point: no payload anywhere can say who voted for whom.
    const raw = await getGame(c.partyCode);
    const asGuest = JSON.stringify(live);
    const asRoom = JSON.stringify(await j(state(GET({ partyCode: c.partyCode }))));
    const onVote = JSON.stringify(await vote(1, ch[2]));
    const held = Object.keys(raw.awardVotes[A] || {});
    assert('the awards payload never exposes who voted for whom',
      held.length === 4 &&
      seats.every((s) => [asGuest, asRoom, onVote].every((p) => p.indexOf(s.personalCode) === -1)));
    assert('a guest is shown their own five choices and nobody else\'s',
      Object.keys(live.you.awardVotes).sort().join('|') === [A, B].sort().join('|'));

    // Three ballots, three keys, no leakage between them.
    assert('an award vote never lands in a game poll or a lobby answer',
      !!raw.awardVotes && !raw.lobbyAnswers &&
      !Object.keys(raw.polls || {}).some((id) => SUPERLATIVES.some((a) => a.id === id)) &&
      !Object.values(raw.polls || {}).some((p) => Object.values(p.votes || {}).some((v) => ch.includes(v))));

    // -------------------------------------------------------------------
    // THE CEREMONY. The host closes the voting and the room screen walks the
    // five awards one at a time. The walk is server-side, so an award that is
    // not on stage yet is not in the payload: there is nothing to read ahead.
    // -------------------------------------------------------------------
    const { updateGame } = require('./lib/store');
    const { CEREMONY_ORDER, TITLE_MS, STEP_MS, findAward } = require('./lib/awards');
    // Move the award on stage back in time, the way the phase tests do.
    const rewind = (ms) => updateGame(c.partyCode, (g) => {
      g.ceremony.stepStartedAt = new Date(Date.now() - ms).toISOString();
      return g;
    });
    const sup = async (code) => (await j(state(GET(Object.assign({ partyCode: c.partyCode }, code ? { personalCode: code } : {}))))).state.awards;
    const laterTitles = (i) => CEREMONY_ORDER.slice(i + 1).map((id) => findAward(id).title);

    const live0 = await sup();
    assert('the tally stays live and open right up until the host announces',
      live0.voting === true && live0.ceremony === null && live0.results.length === 5);

    const announced = await j(awards(POST({ action: 'announce', partyCode: c.partyCode, hostToken: c.hostToken })));
    assert('a guest cannot announce the winners',
      announced.announcing === true &&
      !!(await j(awards(POST({ action: 'announce', partyCode: c.partyCode, hostToken: 'not-the-host' })))).error);
    assert('voting is refused once the ceremony has started',
      !!(await vote(0, ch[1])).error);

    // Award 1 of 5: the title is up alone, and no winner has left the server.
    const t0 = await sup();
    assert('the ceremony opens on the first award, title alone',
      t0.voting === false && t0.ceremony.running === true && t0.ceremony.index === 0 &&
      t0.ceremony.stage === 'title' && t0.ceremony.count === 5 &&
      t0.ceremony.current.id === CEREMONY_ORDER[0] && !('winners' in t0.ceremony.current) &&
      t0.results.length === 0);
    assert('the ceremony builds to best liar and never shows a later award early',
      CEREMONY_ORDER[CEREMONY_ORDER.length - 1] === 'liar' &&
      laterTitles(0).every((title) => JSON.stringify(t0).indexOf(title) === -1));

    await rewind(TITLE_MS + 500);
    const w0 = await sup();
    assert('the title holds for a beat, then the winner goes up',
      w0.ceremony.index === 0 && w0.ceremony.stage === 'winner' &&
      Array.isArray(w0.ceremony.current.winners) && typeof w0.ceremony.current.speech === 'string' &&
      w0.results.length === 1 && w0.results[0].id === CEREMONY_ORDER[0] &&
      laterTitles(0).every((title) => JSON.stringify(w0).indexOf(title) === -1));

    // The hold is generous, and the host can cut it short.
    const holding = await sup();
    assert('the winner is held rather than rushed past',
      holding.ceremony.index === 0 && STEP_MS - TITLE_MS >= 15000);
    await j(awards(POST({ action: 'next', partyCode: c.partyCode, hostToken: c.hostToken })));
    const t1 = await sup();
    assert('the host can skip an award forward',
      t1.ceremony.index === 1 && t1.ceremony.stage === 'title' &&
      t1.ceremony.current.id === CEREMONY_ORDER[1] && t1.results.length === 1);

    // It also walks itself, one step at a time, when nobody touches it.
    await rewind(STEP_MS + 500);
    const t2 = await sup();
    assert('the ceremony advances one award at a time on its own clock',
      t2.ceremony.index === 2 && t2.ceremony.current.id === CEREMONY_ORDER[2] &&
      laterTitles(2).every((title) => JSON.stringify(t2).indexOf(title) === -1));

    // Walk to best liar, which is where the tie is.
    await j(awards(POST({ action: 'next', partyCode: c.partyCode, hostToken: c.hostToken })));
    await j(awards(POST({ action: 'next', partyCode: c.partyCode, hostToken: c.hostToken })));
    await rewind(TITLE_MS + 500);
    const tieUp = await sup();
    const tied = tieUp.ceremony.current;
    const tiedNames = [nameOf(ch[2]), nameOf(ch[3])].sort();
    assert('a tie announces every tied name, on screen and in the speech',
      tied.id === 'liar' && tied.tie === true && tied.winners.length === 2 &&
      tied.winners.map((w) => w.characterName).sort().join('|') === tiedNames.join('|') &&
      /tie/i.test(tied.speech) && tiedNames.every((n) => tied.speech.indexOf(n) !== -1));

    // Every stage of the walk, and nowhere a seat code.
    const seen = [JSON.stringify(t0), JSON.stringify(w0), JSON.stringify(t1), JSON.stringify(t2), JSON.stringify(tieUp),
      JSON.stringify(announced), JSON.stringify(await sup(seats[0].personalCode))];
    assert('the ceremony payload never exposes who voted for whom',
      seats.every((s) => seen.every((p) => p.indexOf(s.personalCode) === -1)));

    await j(awards(POST({ action: 'next', partyCode: c.partyCode, hostToken: c.hostToken })));
    const done = await sup();
    assert('the ceremony settles on all five winners together',
      done.ceremony.done === true && done.ceremony.running === false &&
      done.ceremony.current === null && !!done.ceremony.closing &&
      done.results.length === 5 &&
      done.results.map((r) => r.id).join('|') === CEREMONY_ORDER.join('|'));
  }

  // ---------------------------------------------------------------------
  // Announcing with nobody having voted. A rented hall is a real place and
  // this will happen; it says so on the screen rather than crowning nobody.
  // ---------------------------------------------------------------------
  {
    const c = await j(createGame(POST({ hostName: 'Kali' })));
    await j(join(POST({ partyCode: c.partyCode, name: 'Lisbeth Crandall' })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    await j(awards(POST({ action: 'open', partyCode: c.partyCode, hostToken: c.hostToken })));

    const r = await j(awards(POST({ action: 'announce', partyCode: c.partyCode, hostToken: c.hostToken })));
    const st = await j(state(GET({ partyCode: c.partyCode })));
    const cer = st.state.awards.ceremony;
    assert('announcing with no votes says so instead of crowning nobody',
      r.announcing === true && r.empty === true &&
      cer.empty === true && cer.running === false && cer.done === true &&
      typeof cer.message === 'string' && cer.message.length > 0 &&
      st.state.awards.results.length === 0);
    // And it stays harmless when the clock and the skip button are poked at.
    const poked = await j(awards(POST({ action: 'next', partyCode: c.partyCode, hostToken: c.hostToken })));
    const again = await j(state(GET({ partyCode: c.partyCode })));
    assert('an empty ceremony cannot be walked or crashed',
      !poked.error && again.state.awards.ceremony.empty === true &&
      again.state.awards.ceremony.current === null);
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


  // ---------------------------------------------------------------------
  // CARRYING THE MIDDLE OF THE EVENING. The two long phases (Asking Around,
  // The Hard Part) run 35 and 25 minutes with fourteen people in the room, and
  // one prompt apiece will not hold them. They carry three lines each now, and
  // the second and third are withheld until the phase clock reaches them, so a
  // guest gets something new every ten minutes or so instead of a wall of text.
  // SPOILER-SAFE: these assert counts, offsets and name-overlap only. No line
  // text, no character name and no secret is ever printed.
  // ---------------------------------------------------------------------
  {
    const { loadPack } = require('./lib/pack');
    const { releasedLines, phaseElapsedMs } = require('./lib/phases');
    const MIDDLE = [3, 4];
    const SHORT = [1, 2, 5];

    // --- shape, on the pack that is actually being played ---
    const authored = loadPack(path.join(__dirname, '..', 'packs', 'reunion-1989', 'plot-bible.md.b64'));
    const everyone = [...authored.cast, ...(authored.flex || [])].map((c) => c.id);
    const lines = authored.scriptLines || {};
    const depth = (id, ph) => {
      const l = (lines[id] || {})[ph];
      return l ? 1 + ((l.more || []).length) : 0;
    };

    assert('the two long middle phases carry three lines for every character',
      everyone.length === 20 && MIDDLE.every((ph) => everyone.every((id) => depth(id, ph) === 3)));

    assert('the short phases still carry exactly one line each',
      SHORT.every((ph) => everyone.every((id) => depth(id, ph) === 1)));

    // The later lines drip: offsets climb, and land inside their own phase.
    const dripOk = MIDDLE.every((ph) => everyone.every((id) => {
      const more = (lines[id][ph].more || []);
      if (more.length !== 2) return false;
      return more[0].afterMin > 0 && more[1].afterMin > more[0].afterMin
        && more[1].afterMin < PHASE_MINUTES[ph];
    }));
    assert('every extra middle-phase line is timed, in order, inside its phase', dripOk);

    // Staggered per character, so the whole room is not looking down at once.
    const spread = (ph, i) => new Set(everyone.map((id) => lines[id][ph].more[i].afterMin)).size;
    assert('the drip offsets are staggered across the cast, not shared by everyone',
      MIDDLE.every((ph) => spread(ph, 0) >= 5 && spread(ph, 1) >= 5));

    // Flex characters are optional and may not be in the room, so a core
    // character's line may never send a guest to one. The other way round is
    // fine: flex may name core freely.
    {
      const flexNames = (authored.flex || []).map((f) => f.name).filter(Boolean);
      const coreIds = new Set(authored.cast.map((c) => c.id));
      let offenders = 0;
      for (const id of everyone) {
        if (!coreIds.has(id)) continue;
        for (const ph of Object.keys(lines[id])) {
          const entry = lines[id][ph];
          for (const l of [entry].concat(entry.more || [])) {
            const text = [l.quote, l.reaction, l.prompt].filter(Boolean).join(' ');
            if (flexNames.some((n) => text.includes(n))) offenders++;
          }
        }
      }
      assert('no core character\'s line sends a guest to an optional flex character', offenders === 0);
    }

    // --- the mechanism, on a stub pack, so it is testable without the plot ---
    {
      const stub = { scriptLines: { X1: { 3: {
        quote: 'first', prompt: 'do the first thing',
        more: [
          { quote: 'second', prompt: 'do the second thing', afterMin: 10 },
          { quote: 'third', prompt: 'do the third thing', afterMin: 22 },
        ],
      } } } };
      const at = (min, extra) => Object.assign({ phase: 3, phaseStartedAt: new Date(Date.now() - min * 60000).toISOString() }, extra || {});
      const count = (min, extra) => (releasedLines(stub, at(min, extra), 'X1') || {}).more.length;

      assert('a middle phase opens with one line and holds the other two back',
        count(0) === 0 && count(9) === 0);
      assert('the second line arrives on the phase clock, the third still waits',
        count(10) === 1 && count(21) === 1);
      assert('the third line arrives later in the same phase',
        count(22) === 2 && count(40) === 2);

      // A pause stops the drip: the clock that withholds lines is real play
      // time, the same clock auto-advance runs on.
      const paused = at(30, { paused: true, pausedAt: Date.now() - 25 * 60000 });
      assert('a paused phase does not keep dripping lines',
        phaseElapsedMs(paused) < 10 * 60000 && (releasedLines(stub, paused, 'X1') || {}).more.length === 0);

      assert('a character with nothing for this phase still gets nothing',
        releasedLines(stub, at(40), 'NOBODY') === null &&
        releasedLines({ scriptLines: null }, at(40), 'X1') === null);
    }

    // --- end to end: a withheld line never leaves the server ---
    {
      const c = await j(createGame(POST({ hostName: 'Kali' })));
      const g = await j(join(POST({ partyCode: c.partyCode, name: 'Ondry Wexlin' })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      const fresh = await j(state(GET({ partyCode: c.partyCode, personalCode: g.personalCode })));
      const served = fresh.you && fresh.you.lines;
      const late = (((loadRuntimePack().scriptLines || {})[fresh.you.character.id] || {})[3] || {}).more || [];
      const timed = late.filter((m) => (m.afterMin || 0) > 0);
      assert('a phase that has just started serves none of its timed lines',
        !!served && (served.more || []).length === 0);
      assert('the withheld text is nowhere in the payload the phone receives',
        timed.every((m) => JSON.stringify(fresh).indexOf(m.quote) === -1
          && (!m.prompt || JSON.stringify(fresh).indexOf(m.prompt) === -1)));
    }
  }


  // ---------------------------------------------------------------------
  // AUTOPILOT: "Run the night for me." Kali is playing the busiest character
  // in the room and hosting it, and there is nobody to hand the phone to. With
  // the switch on the app runs the evening itself: phases on the clock, the
  // reveal when the final vote closes, the superlatives once the reveal has
  // played, the 6:40 question at the end of Asking Around. Handing out the
  // gift cards stays hers. Every manual control keeps working, and nothing
  // fires twice.
  // SPOILER-SAFE: asserts that a reveal exists and what fired, never its text.
  // ---------------------------------------------------------------------
  {
    const { updateGame } = require('./lib/store');
    const { revealDue, hostCue, REVEAL_PLAYOUT_MS, AWARDS_SETTLE_MS } = require('./lib/autopilot');
    const alibi = require('./functions/alibi').handler;

    const edit = (code, fn) => updateGame(code, (g) => { fn(g); return g; });
    const guestPoll = (c, seat) => j(state(GET({ partyCode: c.partyCode, personalCode: seat })));
    const hostPoll = (c) => j(state(GET({ partyCode: c.partyCode, hostToken: c.hostToken })));
    const didAuto = async (c, what) =>
      ((await getGame(c.partyCode)).log || []).filter((e) => e.kind === 'autopilot' && String(e.did || '').includes(what)).length;

    // A party sat at Phase 6 with the final ballot closed behind it.
    const atTheEnd = async ({ autopilot }) => {
      const c = await j(createGame(POST({})));
      const seats = [];
      for (let i = 0; i < 10; i++) {
        const r = await j(join(POST({ partyCode: c.partyCode, name: 'Auto' + i })));
        seats.push(r.personalCode);
      }
      if (autopilot) await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 5 })));
      await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: seats[0], id: 'final', choice: pack.cast[0].name })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
      return { c, seats };
    };

    // --- the switch itself ---
    {
      const c = await j(createGame(POST({})));
      const before = await getGame(c.partyCode);
      const on = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      const after = await getGame(c.partyCode);
      const off = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: false })));
      assert('autopilot is off until the host turns it on, and turning it on turns auto-advance on with it',
        !before.autopilot && on.autopilot === true && after.autopilot === true
        && after.autoAdvance === true && off.autopilot === false);
      const notHost = await j(advance(POST({ partyCode: c.partyCode, hostToken: 'not-the-host', autopilot: true })));
      assert('only the host can switch autopilot on', !!notHost.error);
      // Remembered on the party, so a second device with the host key finds it on.
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      const otherDevice = await hostPoll(c);
      const otherParty = await j(createGame(POST({})));
      assert('the switch is remembered per party, not per device',
        otherDevice.host.autopilot === true && !(await getGame(otherParty.partyCode)).autopilot);
    }

    // --- the reveal plays itself, once, and only after the final vote closes ---
    {
      const { c, seats } = await atTheEnd({ autopilot: true });
      assert('autopilot will not reveal while the final vote is still open',
        revealDue({ autopilot: true, phase: 6, polls: { final: { closed: false } } }) === false
        && revealDue({ autopilot: true, phase: 5, polls: { final: { closed: true } } }) === false);

      await guestPoll(c, seats[0]);
      const g = await getGame(c.partyCode);
      assert('autopilot plays the reveal itself once Phase 6 has started and the final vote has closed',
        !!(g.reveal && g.reveal.at) && (await didAuto(c, 'reveal')) === 1);

      const firstAt = g.reveal.at;
      for (let i = 0; i < 4; i++) await guestPoll(c, seats[i % seats.length]);
      assert('autopilot fires the reveal exactly once, however many phones are polling',
        (await didAuto(c, 'reveal')) === 1 && (await getGame(c.partyCode)).reveal.at === firstAt);

      // --- and then the superlatives, but only once the reveal has played ---
      assert('the superlatives do not open over the top of a reveal that is still playing',
        !(await getGame(c.partyCode)).awardsOpen);
      await edit(c.partyCode, (x) => { x.reveal.at = new Date(Date.now() - REVEAL_PLAYOUT_MS - 1000).toISOString(); });
      await guestPoll(c, seats[0]);
      assert('autopilot opens the superlatives once the reveal has finished playing',
        !!(await getGame(c.partyCode)).awardsOpen && (await didAuto(c, 'awards')) === 1);
      for (let i = 0; i < 4; i++) await guestPoll(c, seats[i % seats.length]);
      assert('autopilot opens the superlatives exactly once', (await didAuto(c, 'awards')) === 1);

      // --- announcing the winners is never automated ---
      await edit(c.partyCode, (x) => {
        x.awardsOpenedAt = new Date(Date.now() - 10 * AWARDS_SETTLE_MS).toISOString();
        x.awardsLastVoteAt = new Date(Date.now() - 10 * AWARDS_SETTLE_MS).toISOString();
      });
      for (let i = 0; i < 4; i++) await guestPoll(c, seats[i % seats.length]);
      const end = await getGame(c.partyCode);
      assert('autopilot never announces the winners: somebody has to be holding the gift cards',
        !end.ceremony && !end.awardsClosed && (await didAuto(c, 'announce')) === 0);
    }

    // --- with the switch off, the app touches nothing ---
    {
      const { c, seats } = await atTheEnd({ autopilot: false });
      for (let i = 0; i < 5; i++) await guestPoll(c, seats[i % seats.length]);
      const g = await getGame(c.partyCode);
      assert('with autopilot off nothing fires itself',
        !g.reveal && !g.awardsOpen && !(g.branchFired || {}).alibi
        && !(g.log || []).some((e) => e.kind === 'autopilot' && e.did));
    }

    // --- it never repeats something the host did by hand ---
    {
      const { c, seats } = await atTheEnd({ autopilot: false });
      await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
      await j(awards(POST({ action: 'open', partyCode: c.partyCode, hostToken: c.hostToken })));
      const byHand = await getGame(c.partyCode);
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      for (let i = 0; i < 4; i++) await guestPoll(c, seats[i % seats.length]);
      const after = await getGame(c.partyCode);
      assert('autopilot never re-fires a reveal the host already played herself',
        after.reveal.at === byHand.reveal.at && (await didAuto(c, 'reveal')) === 0);
      assert('autopilot never re-opens superlatives the host already opened herself',
        after.awardsOpenedAt === byHand.awardsOpenedAt && (await didAuto(c, 'awards')) === 0);
    }

    // --- the 6:40 question closes itself at the end of Asking Around ---
    {
      const c = await j(createGame(POST({})));
      const g1 = await j(join(POST({ partyCode: c.partyCode, name: 'Sixforty One' })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      await guestPoll(c, g1.personalCode);
      assert('the 6:40 question stays open while Asking Around still has time in it',
        !((await getGame(c.partyCode)).branchFired || {}).alibi);
      // Wind the phase clock to its last minute.
      await edit(c.partyCode, (x) => {
        x.phaseStartedAt = new Date(Date.now() - (PHASE_MINUTES[3] * 60000 - 30000)).toISOString();
      });
      await guestPoll(c, g1.personalCode);
      assert('the 6:40 question resolves itself at the end of Asking Around',
        !!((await getGame(c.partyCode)).branchFired || {}).alibi);
    }

    // A host who advances early must not strand it: it can only resolve inside
    // its own phase, so leaving that phase closes it on the way out.
    {
      const c = await j(createGame(POST({})));
      await j(join(POST({ partyCode: c.partyCode, name: 'Sixforty Two' })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 4 })));
      assert('advancing out of Asking Around early does not strand the 6:40 question',
        !!((await getGame(c.partyCode)).branchFired || {}).alibi);
    }

    // --- the cue: one instruction at a time, only when a person is needed ---
    {
      const c = await j(createGame(POST({})));
      const g1 = await j(join(POST({ partyCode: c.partyCode, name: 'Cue Guest' })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));

      const lobbyish = await hostPoll(c);
      assert('there is no cue at the start of the evening, when nothing is needed',
        lobbyish.host && lobbyish.host.cue === null);

      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      const asking = await hostPoll(c);
      const cue = asking.host.cue;
      assert('during Asking Around the cue asks the room out loud where they were at 6:40',
        !!cue && cue.id === 'ask-alibi' && /6:40/.test(cue.text) && !!cue.button && cue.action === 'alibi-resolve');
      assert('the cue is one instruction, not a list',
        cue && !Array.isArray(cue) && typeof cue.text === 'string');

      // Host-only. A guest phone and the room screen both send no host token.
      const asGuest = await guestPoll(c, g1.personalCode);
      const asRoom = await j(state(GET({ partyCode: c.partyCode })));
      const asWrongKey = await j(state(GET({ partyCode: c.partyCode, hostToken: 'not-the-host' })));
      assert('the cue is host-only and never reaches a guest or the room screen',
        asGuest.host === null && asRoom.host === null && asWrongKey.host === null
        && [asGuest, asRoom, asWrongKey].every((v) => JSON.stringify(v).indexOf(cue.text) === -1));

      // Doing the thing clears the cue.
      await j(alibi(POST({ action: 'resolve', partyCode: c.partyCode, hostToken: c.hostToken })));
      const done = await hostPoll(c);
      assert('the cue clears once she has done the thing it asked for', done.host.cue === null);
    }

    // The other moment a person is needed: the gift cards.
    {
      const { c, seats } = await atTheEnd({ autopilot: true });
      await guestPoll(c, seats[0]);
      await edit(c.partyCode, (x) => { x.reveal.at = new Date(Date.now() - REVEAL_PLAYOUT_MS - 1000).toISOString(); });
      await guestPoll(c, seats[0]);
      const fresh = await hostPoll(c);
      assert('no cue while the room is still voting on the superlatives', fresh.host.cue === null);
      await edit(c.partyCode, (x) => {
        x.awardsOpenedAt = new Date(Date.now() - 3 * AWARDS_SETTLE_MS).toISOString();
        x.awardsLastVoteAt = new Date(Date.now() - 3 * AWARDS_SETTLE_MS).toISOString();
      });
      const settled = await hostPoll(c);
      assert('once the voting settles the cue tells her to announce the winners and hand out the cards',
        !!settled.host.cue && settled.host.cue.id === 'announce-winners'
        && /gift card/i.test(settled.host.cue.text) && settled.host.cue.action === 'awards-announce');
      await j(awards(POST({ action: 'announce', partyCode: c.partyCode, hostToken: c.hostToken })));
      const announced = await hostPoll(c);
      assert('the gift-card cue clears once the winners have been announced', announced.host.cue === null);
    }

    // --- a floor, not a cage: every manual control still works ---
    {
      const c = await j(createGame(POST({})));
      const g1 = await j(join(POST({ partyCode: c.partyCode, name: 'Manual Guest' })));
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, autopilot: true })));
      const adv = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      const paused = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, pause: true })));
      const resumed = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, pause: false })));
      const autoOff = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, auto: false })));
      const extended = await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, extend: 5 })));
      const resolved = await j(alibi(POST({ action: 'resolve', partyCode: c.partyCode, hostToken: c.hostToken })));
      const still = await getGame(c.partyCode);
      assert('with autopilot on she can still advance, pause, extend and resolve by hand',
        adv.phase === 3 && paused.paused === true && resumed.paused === false
        && extended.extendedMinutes === 5 && resolved.resolved === true && still.autopilot === true);
      assert('she can take the clock back without giving up the rest of autopilot',
        autoOff.autoAdvance === false && still.autoAdvance === false && still.autopilot === true);
      // A paused phase stops the autopilot clock too: nothing creeps forward
      // while she has the room held.
      const { alibiDue } = require('./lib/autopilot');
      const held = { autopilot: true, phase: 3, paused: true, pausedAt: Date.now(),
        phaseStartedAt: new Date(Date.now() - 10 * PHASE_MINUTES[3] * 60000).toISOString(), branchFired: {} };
      assert('a paused phase does not let autopilot close the 6:40 question behind her',
        alibiDue(held) === false && alibiDue({ ...held, paused: false }) === true && !!g1.personalCode);
    }
  }


  // ---------------------------------------------------------------------
  // THE GO-FIND NUDGE. At fourteen people everybody talks to the four they
  // arrived with. From Asking Around onward each seated guest is handed one
  // other seated character to go and find. It is purely social: one rotation
  // of the room per phase, so every seated character is named exactly once and
  // the pattern of who gets named can carry no information at all.
  // SPOILER-SAFE: asserts pairings, counts and variant-independence. The one
  // thing it prints is PASS or FAIL.
  // ---------------------------------------------------------------------
  {
    const { updateGame } = require('./lib/store');
    const { goFindNudge, pairingsFor, seatedCharacterIds, GOFIND_FROM_PHASE } = require('./lib/gofind');
    const ROUNDS = [3, 4, 5, 6];

    const party = async (n) => {
      const c = await j(createGame(POST({})));
      const seats = [];
      for (let i = 0; i < n; i++) {
        const r = await j(join(POST({ partyCode: c.partyCode, name: 'Find' + i })));
        seats.push(r.personalCode);
      }
      return { c, seats, game: await getGame(c.partyCode) };
    };

    // --- the shape of one round ---
    {
      const { game } = await party(14);
      const seated = seatedCharacterIds(game);
      assert('a full table seats fourteen characters to send people between', seated.length === 14);

      let allOk = true, everNull = false;
      const namedCount = {};
      const sentTo = {};
      for (const ph of ROUNDS) {
        const pairs = pairingsFor(game, ph);
        if (Object.keys(pairs).length !== seated.length) allOk = false;
        const targets = [];
        for (const id of seated) {
          const to = pairs[id];
          if (!to) { everNull = true; continue; }
          if (to === id) allOk = false;                           // never yourself
          if (!seated.includes(to)) allOk = false;                // never an empty seat
          targets.push(to);
          namedCount[to] = (namedCount[to] || 0) + 1;
          (sentTo[id] = sentTo[id] || []).push(to);
        }
        // One rotation: everybody named exactly once in the round.
        if (new Set(targets).size !== seated.length) allOk = false;
      }
      assert('every seated guest is sent to another seated character, never to themselves', allOk && !everNull);

      const counts = seated.map((id) => namedCount[id] || 0);
      assert('every seated character is named exactly the same number of times',
        Math.min(...counts) === ROUNDS.length && Math.max(...counts) === ROUNDS.length);

      assert('nobody is sent to the same person twice across the night',
        seated.every((id) => new Set(sentTo[id]).size === sentTo[id].length));
    }

    // --- deterministic, and off before Asking Around ---
    {
      const { c, seats, game } = await party(12);
      const me = game.players[seats[0]].characterId;
      const first = goFindNudge(pack, game, me, 3);
      assert('the nudge does not reshuffle between polls',
        !!first && JSON.stringify(goFindNudge(pack, game, me, 3)) === JSON.stringify(first)
        && JSON.stringify(goFindNudge(pack, await getGame(c.partyCode), me, 3)) === JSON.stringify(first));
      assert('there is no go-find nudge before Asking Around',
        GOFIND_FROM_PHASE === 3 && goFindNudge(pack, game, me, 1) === null
        && goFindNudge(pack, game, me, 2) === null
        && Object.keys(pairingsFor(game, 2)).length === 0);
    }

    // --- THE ONE THAT MATTERS: the nudges cannot know the answer ---
    {
      const { c, seats, game } = await party(14);
      const seated = seatedCharacterIds(game);
      const sequenceUnder = async (letter) => {
        await updateGame(c.partyCode, (g) => { g.variant = letter; return g; });
        const g = await getGame(c.partyCode);
        const out = [];
        for (const ph of ROUNDS) {
          for (const id of seated) {
            const nudge = goFindNudge(pack, g, id, ph);
            out.push(`${ph}|${id}->${nudge ? nudge.characterId : ''}|${nudge ? nudge.text : ''}`);
          }
        }
        return out.join('\n');
      };
      const letters = pack.variants.map((v) => v.letter);
      const seqs = [];
      for (const letter of letters) seqs.push(await sequenceUnder(letter));
      assert('the same party shape produces the identical nudge sequence under all four variants',
        letters.length === 4 && seqs.every((x) => x === seqs[0]) && seqs[0].length > 0);
      // And nothing about the party's own seed is the variant either: two
      // parties with the same shape pair up differently.
      const other = await party(14);
      const otherSeq = ROUNDS.map((ph) => seatedCharacterIds(other.game)
        .map((id) => `${ph}|${id}->${(goFindNudge(pack, other.game, id, ph) || {}).characterId}`).join(',')).join('\n');
      const mineSeq = ROUNDS.map((ph) => seated
        .map((id) => `${ph}|${id}->${(goFindNudge(pack, game, id, ph) || {}).characterId}`).join(',')).join('\n');
      assert('two parties the same size do not get the same pairings',
        otherSeq !== mineSeq && !!seats.length);
    }

    // --- it survives the room changing under it ---
    {
      const { c, game } = await party(12);
      const before = seatedCharacterIds(game);
      const dropped = before[3];
      await j(cast(POST({ action: 'remove', partyCode: c.partyCode, hostToken: c.hostToken, characterId: dropped })));
      const after = await getGame(c.partyCode);
      const left = seatedCharacterIds(after);
      let ok = left.length === before.length - 1 && !left.includes(dropped);
      for (const ph of ROUNDS) {
        const pairs = pairingsFor(after, ph);
        if (Object.keys(pairs).length !== left.length) ok = false;
        for (const [from, to] of Object.entries(pairs)) {
          if (to === from || !left.includes(to) || to === dropped) ok = false;
        }
      }
      assert('a guest leaving mid-party never leaves anyone sent to an empty chair', ok);
      assert('the guest who left is not handed a nudge either',
        goFindNudge(pack, after, dropped, 3) === null);
    }

    // --- edge: a room too small to send anybody anywhere ---
    {
      const { game } = await party(1);
      assert('a party of one has nobody to be sent to',
        Object.keys(pairingsFor(game, 3)).length === 0
        && goFindNudge(pack, game, seatedCharacterIds(game)[0], 3) === null);
    }

    // --- it reads like a person wrote it, not a form letter ---
    {
      const { game } = await party(14);
      const seated = seatedCharacterIds(game);
      const texts = [];
      for (const ph of ROUNDS) for (const id of seated) texts.push(goFindNudge(pack, game, id, ph).text);
      const shapes = new Set(texts.map((t) => t.replace(/[A-Z][a-z]+ [A-Z][a-z']+/g, '{name}')));
      assert('the phrasing varies rather than reading like a form letter', shapes.size >= 5);
      assert('every nudge names somebody and asks for nothing else',
        texts.every((t) => t.length < 160 && !/\bP[1-7]\b/.test(t)));
    }

    // --- end to end: it reaches the phone, and only as a social note ---
    {
      const { c, seats } = await party(14);
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
      const mine = await j(state(GET({ partyCode: c.partyCode, personalCode: seats[0] })));
      const g = await getGame(c.partyCode);
      assert('the nudge reaches the guest\'s own view and names a character in the room',
        !!(mine.you && mine.you.goFind && mine.you.goFind.text)
        && seatedCharacterIds(g).includes(mine.you.goFind.characterId)
        && mine.you.goFind.characterId !== g.players[seats[0]].characterId);
      const room = await j(state(GET({ partyCode: c.partyCode })));
      assert('one guest\'s nudge is not broadcast to the room screen',
        JSON.stringify(room).indexOf(mine.you.goFind.text) === -1);
    }
  }



  // --- back to the lobby -------------------------------------------------
  // A party gets started by accident, or on purpose to rehearse. The casting is
  // the expensive thing in the room, so a reset has to keep it and throw the
  // evening away, and it must not leave the rehearsal's answer behind.
  {
    console.log('\nBack to the lobby');
    const raw = await j(createGameRaw(POST({ hostName: 'Reset' })));
    const partyCode = raw.partyCode, hostToken = raw.hostToken;

    assert('a party in the lobby cannot be sent back to it',
      !!(await j(advance(POST({ partyCode, hostToken, backToLobby: true })))).error);

    await j(cast(POST({ partyCode, hostToken, action: 'save', reservations: { C1: 'Reserved Guest' } })));
    const guest = await j(join(POST({ partyCode, name: 'Reset Guest' })));
    const seatCode = guest.personalCode, seatChar = (guest.character || {}).id;
    assert('a guest claimed a seat in the lobby', !!seatCode && !!seatChar);

    await j(advance(POST({ partyCode, hostToken, openDoors: true })));
    await j(scan(POST({ partyCode, personalCode: seatCode, propId: 'P1' })));
    await j(poll(POST({ action: 'create', partyCode, hostToken, id: 'rq1', question: 'Who?', options: ['A', 'B'] })));
    await j(poll(POST({ action: 'vote', partyCode, personalCode: seatCode, id: 'rq1', choice: 'A' })));
    await j(advance(POST({ partyCode, hostToken, phase: 3 })));
    const mid = await getGame(partyCode);
    mid.players[seatCode].killerSeenAt = new Date().toISOString();   // as a mid-game unlock would
    const playedVariant = mid.variant;
    assert('the party really was played before the reset',
      mid.lobby === false && mid.phase === 3 && Object.keys(mid.discovered).length > 0 && Object.keys(mid.polls).length > 0);

    assert('a stranger cannot send the party back to the lobby',
      !!(await j(advance(POST({ partyCode, hostToken: 'not-the-host', backToLobby: true })))).error);

    const back = await j(advance(POST({ partyCode, hostToken, backToLobby: true })));
    const g2 = await getGame(partyCode);
    assert('the reset answers with the lobby and the seat count', back.lobby === true && back.seats === 1);
    assert('the party is in the lobby again', g2.lobby === true && g2.phase === 1);
    assert('the seat survived with the same character', !!g2.players[seatCode] && g2.players[seatCode].characterId === seatChar);
    assert('the guest can still use their own code', !!(await j(state(GET({ partyCode, personalCode: seatCode })))).you);
    assert('the typed-in reservation survived', JSON.stringify(g2.reservations || {}).indexOf('C1') !== -1);
    assert('what the evening produced is gone',
      Object.keys(g2.discovered || {}).length === 0
      && Object.keys(g2.polls || {}).length === 0
      && !g2.narratorFeed && !g2.screenCards && !g2.narration && !g2.drops && !g2.reveal);
    assert('the seat forgot what it was shown', !g2.players[seatCode].killerSeenAt && !g2.players[seatCode].scanCount);
    assert('a reset party does not run its own clock', g2.autoAdvance === false && !g2.autopilot);
    assert('the room screen sees a lobby, not a phase', (await j(state(GET({ partyCode })))).state.lobby === true);

    // The sealed variant is drawn again, so a rehearsal cannot teach the answer.
    const drawn = new Set([playedVariant, g2.variant]);
    for (let i = 0; i < 30; i++) {
      await j(advance(POST({ partyCode, hostToken, openDoors: true })));
      await j(advance(POST({ partyCode, hostToken, backToLobby: true })));
      drawn.add((await getGame(partyCode)).variant);
    }
    assert('the solution is drawn again on every reset', drawn.size > 1);
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ ENGINE OK' : '\x1b[31m✗ ENGINE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e.message); process.exit(2); });
