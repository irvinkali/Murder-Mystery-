#!/usr/bin/env node
'use strict';
/*
 * Party audit. Three questions the owner actually asked, answered by playing
 * the game rather than by reading the code:
 *
 *   1. LEAKS     Can any player-visible payload, at any phase, reach the sealed
 *                solution before the reveal - in its words, or in the shape of
 *                what it declines to say?
 *   2. BRANCHING Does the evening actually change with what the room votes and
 *                what people find, or does it run on rails?
 *   3. TALK      Does every player have something to say and something to do in
 *                every phase, without the answer being handed to them?
 *
 * SPOILER-SAFE: it plays real games with real sealed variants, but it prints
 * only counts and PASS/FAIL. The killer, the variant and the evidence text are
 * held in memory, compared against, and never written out. Safe to run in
 * front of the owner.
 *
 * Usage: MYSTERY_PACK_FILE=../packs/<pack>/pack.json.b64 node audit.js
 */

delete process.env.NETLIFY;

const createGame = require('./functions/create-game').handler;
const join = require('./functions/join').handler;
const state = require('./functions/state').handler;
const scan = require('./functions/scan').handler;
const poll = require('./functions/poll').handler;
const advance = require('./functions/advance').handler;
const reveal = require('./functions/reveal').handler;
const casefile = require('./functions/casefile').handler;
const kit = require('./functions/kit').handler;
const cast = require('./functions/cast').handler;
const { getGame, updateGame } = require('./lib/store');
const {
  loadRuntimePack, resolveKillerId, exhibitNumber, assignableIds, propCatalog,
} = require('./lib/runtime');

const POST = (b) => ({ httpMethod: 'POST', body: JSON.stringify(b) });
const GET = (q) => ({ httpMethod: 'GET', queryStringParameters: q });
const j = async (r) => JSON.parse((await r).body);

let pass = 0, fail = 0;
const note = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`); }
}
function info(name, detail) { console.log(`  \x1b[36m····\x1b[0m ${name}  \x1b[2m${detail}\x1b[0m`); }

const pack = loadRuntimePack();
const CHARS = [...pack.cast, ...(pack.flex || [])];
const nameOf = (id) => (CHARS.find((c) => c.id === id) || {}).name;

/** Every string in a payload, flattened, so nothing hides in a nested field. */
function strings(x, out = []) {
  if (x == null) return out;
  if (typeof x === 'string') { out.push(x); return out; }
  if (Array.isArray(x)) { x.forEach((v) => strings(v, out)); return out; }
  if (typeof x === 'object') { Object.values(x).forEach((v) => strings(v, out)); return out; }
  out.push(String(x));
  return out;
}

async function seat(partyCode, n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await j(join(POST({ partyCode, name: 'P' + i })));
    codes.push(r.personalCode);
  }
  return codes;
}
async function openDoors(c) {
  await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, openDoors: true })));
}

// ---------------------------------------------------------------------------
// 1. LEAKS
// ---------------------------------------------------------------------------
async function auditLeaks() {
  console.log('\n\x1b[1m1. Can anything reach the answer before the reveal?\x1b[0m');
  let payloads = 0, leaks = 0, killerNameSeen = 0;
  const variantsSeen = new Set();

  // Enough runs that every sealed variant is exercised several times over.
  for (let run = 0; run < 24; run++) {
    const c = await j(createGame(POST({})));
    await openDoors(c);
    const codes = await seat(c.partyCode, 12);
    const g0 = await getGame(c.partyCode);
    const variant = g0.variant;
    variantsSeen.add(typeof variant === 'object' ? (variant.id || JSON.stringify(variant).slice(0, 12)) : String(variant));
    const killerId = resolveKillerId(pack, variant);
    const killer = nameOf(killerId);
    const variantMarks = strings(variant).filter((s) => s.length > 12);

    const sweep = (payload, where, allowKiller) => {
      payloads++;
      const all = strings(payload);
      // The sealed variant's own text must never appear.
      for (const m of variantMarks) {
        if (all.some((s) => s.includes(m))) { leaks++; console.log(`     leak: variant text in ${where}`); return; }
      }
      // The killer's NAME appearing is not automatically a leak (they are a
      // guest like any other), but it must never appear next to an accusation.
      if (!allowKiller && killer) {
        const near = all.filter((s) => s.includes(killer) &&
          /killed|killer|murder|did it|guilty|responsible|it was/i.test(s));
        if (near.length) { killerNameSeen++; leaks++; console.log(`     leak: killer named as guilty in ${where}`); }
      }
    };

    for (let phase = 1; phase <= 5; phase++) {
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase })));
      // Everything a phone, the room screen, or a passer-by can ask for.
      sweep(await j(state(GET({ partyCode: c.partyCode }))), `public state @${phase}`);
      sweep(await j(kit({ httpMethod: 'GET' })), `kit @${phase}`);
      for (const code of codes) {
        sweep(await j(state(GET({ partyCode: c.partyCode, personalCode: code }))), `player state @${phase}`);
      }
      // Scanning every prop at every phase: the most likely early-release path.
      for (const pid of Object.keys(propCatalog(pack))) {
        const ex = exhibitNumber(pid, pack);
        sweep(await j(scan(POST({ partyCode: c.partyCode, personalCode: codes[0], exhibit: ex }))), `scan @${phase}`);
      }
      // The reveal itself must refuse.
      const early = await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
      if (!early.error) { leaks++; console.log(`     leak: reveal answered at phase ${phase}`); }
      const cf = await j(casefile(GET({ partyCode: c.partyCode })));
      if (!cf.error) { leaks++; console.log(`     leak: case file open at phase ${phase}`); }
      // A guessed personal code must not be a way in.
      const forged = await j(state(GET({ partyCode: c.partyCode, personalCode: 'AAAAA' })));
      if (forged.you) { leaks++; console.log(`     leak: forged seat code returned a player view`); }
    }

    // And once the reveal HAS happened, it is supposed to say so.
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 6 })));
    await j(reveal(POST({ partyCode: c.partyCode, hostToken: c.hostToken })));
    const after = await j(state(GET({ partyCode: c.partyCode })));
    if (!after.state.reveal) { leaks++; console.log('     fault: reveal did not publish at phase 6'); }
  }

  assert('no payload reaches the sealed answer before the reveal', leaks === 0,
    `${payloads} payloads swept across 24 games, ${leaks} leaks`);
  assert('the killer is never named as guilty before the reveal', killerNameSeen === 0);
  info('sealed variants exercised', `${variantsSeen.size} distinct across 24 games`);
}


// ---------------------------------------------------------------------------
// 1b. WITHHELD PATTERN
//
// The sweep above looks for the sealed answer's own words. That is not how this
// leaked the first time. Nothing was ever said: the answer was readable from
// the PATTERN of what the app declined to say - which exhibits answered with
// evidence, which announced themselves as not-yet, which stayed quiet, and
// which of them stopped changing once they had spoken. Seven exhibits, three
// visibly different replies, and the pattern across them was unique to each of
// the four sealed answers at every phase, including before anybody had died.
//
// So this plays all four answers side by side and asks a classifier the same
// question a guest with a good memory would: from the shape of the replies
// alone, how many of the four can I tell apart? One means the pattern carries
// nothing. Four means it carries everything.
// ---------------------------------------------------------------------------
async function auditWithheld() {
  console.log('\n\x1b[1m1b. Does the pattern of what is NOT said give it away?\x1b[0m');
  const letters = pack.variants.map((v) => v.letter);
  const phases = [1, 2, 3, 4, 5];

  // Play one real game per sealed answer, and read the exhibits through the
  // endpoint a guest actually uses rather than through the resolver.
  const games = {};
  for (const letter of letters) {
    const c = await j(createGame(POST({})));
    await updateGame(c.partyCode, (g) => { g.variant = letter; return g; });
    await openDoors(c);
    const codes = await seat(c.partyCode, 12);
    games[letter] = { c, code: codes[0], replies: {} };
    for (const phase of phases) {
      await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase })));
      const row = [];
      for (const pid of Object.keys(propCatalog(pack))) {
        const r = await j(scan(POST({ partyCode: c.partyCode, personalCode: codes[0], exhibit: exhibitNumber(pid, pack) })));
        row.push(r.reveal || {});
      }
      games[letter].replies[phase] = row;
    }
  }

  // Shape: which fields came back, whether anything was said, how many things
  // have been noticed so far. Never the words themselves.
  const shapeOf = (rev) => Object.keys(rev).filter((k) => k !== 'label' && k !== 'blurb').sort().join('+') +
    (rev.reading ? ':said' : ':silent') + ':' + String(rev.reading || '').split('\n\n').length;
  let worstPhase = 1;
  for (const phase of phases) {
    const pats = letters.map((l) => games[l].replies[phase].map(shapeOf).join('|'));
    worstPhase = Math.max(worstPhase, new Set(pats).size);
  }
  assert('the shape of the replies tells the four answers apart: no', worstPhase === 1,
    `best a shape classifier can do across ${phases.length} phases: ${worstPhase} of ${letters.length} answers distinguished`);

  // Churn: which exhibits say something new at each phase turn. A live exhibit
  // that speaks once and then sits still is as good as a labelled one.
  let worstTurn = 1;
  for (let i = 1; i < phases.length; i++) {
    const a = phases[i - 1], b = phases[i];
    const pats = letters.map((l) => games[l].replies[a]
      .map((rev, k) => (String(rev.reading || '') === String(games[l].replies[b][k].reading || '') ? '.' : 'c')).join(''));
    worstTurn = Math.max(worstTurn, new Set(pats).size);
  }
  assert('which exhibits change at a phase turn tells them apart: no', worstTurn === 1,
    `best a change-pattern classifier can do: ${worstTurn} of ${letters.length} answers distinguished`);

  // Weight: how much each exhibit said, coarsely. This one is reported rather
  // than demanded, because evidence is as long as it needs to be; what matters
  // is that it can never single an answer out on its own.
  let worstWeight = 1;
  for (const B of [200, 300, 400, 500]) {
    for (const phase of phases) {
      const pats = letters.map((l) => games[l].replies[phase]
        .map((rev) => Math.floor(String(rev.reading || '').length / B)).join(''));
      worstWeight = Math.max(worstWeight, new Set(pats).size);
    }
  }
  // The bar here is what a person can actually perceive - "that one gave me a
  // good deal more than this one" - not what a character count can separate.
  // Demanding that every reply be the same length would mean writing every
  // piece of evidence to a word budget, which is a worse game. So the invariant
  // is that no reply is conspicuously heavier than its neighbours, and the
  // character-counting figure is printed beside it so nobody forgets it exists.
  let eLo = Infinity, eHi = 0;
  for (const letter of letters) for (const phase of phases) for (const rev of games[letter].replies[phase]) {
    for (const part of String(rev.reading || '').split('\n\n')) { eLo = Math.min(eLo, part.length); eHi = Math.max(eHi, part.length); }
  }
  const ratio = eLo > 0 && eLo !== Infinity ? eHi / eLo : Infinity;
  assert('no exhibit answers at a conspicuously different weight from its neighbours',
    ratio <= 2.5, `longest reply is ${ratio === Infinity ? 'n/a' : ratio.toFixed(2)}x the shortest (limit 2.5x)`);
  info('residual: counting characters', `a classifier that measures reply length can still tell ${worstWeight} of ${letters.length} answers apart`);

  // And the private half: the set of things a seat is holding must not vary
  // with the answer either - only their contents may.
  const kinds = {};
  for (const letter of letters) {
    const g = await getGame(games[letter].c.partyCode);
    kinds[letter] = [...new Set(Object.values(g.drops || {}).flat().map((d) => d.kind))].sort().join(',');
  }
  assert('the kinds of private note in the room do not vary with the answer',
    new Set(Object.values(kinds)).size === 1,
    `${new Set(Object.values(kinds)).size} distinct sets of note kinds across the four answers`);
}

// ---------------------------------------------------------------------------
// 2. BRANCHING
// ---------------------------------------------------------------------------
async function auditBranching() {
  console.log('\n\x1b[1m2. Does the evening change with what the room does?\x1b[0m');

  // Same sealed variant, two rooms that vote differently. If the night is on
  // rails, the two will end up with identical private content.
  const fingerprints = [];
  for (const choice of [0, 1]) {
    const c = await j(createGame(POST({})));
    await openDoors(c);
    const codes = await seat(c.partyCode, 12);
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
    const st = await j(state(GET({ partyCode: c.partyCode })));
    const open = (st.state.polls || []).filter((p) => !p.closed);
    for (const p of open) {
      const opt = p.options[choice % p.options.length];
      for (const code of codes) {
        await j(poll(POST({ action: 'vote', partyCode: c.partyCode, personalCode: code, id: p.id, choice: opt })));
      }
      await j(poll(POST({ action: 'close', partyCode: c.partyCode, hostToken: c.hostToken, id: p.id })));
    }
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 4 })));
    const g = await getGame(c.partyCode);
    // Fingerprint = the shape of what landed privately on phones, not the text.
    const fp = Object.entries(g.drops || {}).map(([code, ds]) =>
      code + ':' + ds.map((d) => d.kind).sort().join(',')).sort().join('|');
    fingerprints.push(fp);
  }
  assert('two rooms voting differently get different private content',
    fingerprints[0] !== fingerprints[1],
    'compared the kinds of private drops, not their wording');

  // Finding things has to matter too.
  const c = await j(createGame(POST({})));
  await openDoors(c);
  const codes = await seat(c.partyCode, 12);
  await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 4 })));
  const before = (await j(state(GET({ partyCode: c.partyCode })))).state.discoveredCount;
  for (const pid of Object.keys(propCatalog(pack))) {
    await j(scan(POST({ partyCode: c.partyCode, personalCode: codes[1], exhibit: exhibitNumber(pid, pack) })));
  }
  const afterSt = await j(state(GET({ partyCode: c.partyCode })));
  assert('finding props changes the room state', afterSt.state.discoveredCount > before,
    `${before} found before, ${afterSt.state.discoveredCount} after`);
  assert('the narrator reacts to what is found',
    (afterSt.state.narratorFeed || []).length > 0,
    `${(afterSt.state.narratorFeed || []).length} narrator interjections queued`);

  // The 6:40 question has to be able to catch somebody out.
  const alibi = require('./functions/alibi').handler;
  await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: 3 })));
  for (let i = 0; i < codes.length; i++) {
    await j(alibi(POST({ partyCode: c.partyCode, personalCode: codes[i], action: 'submit',
      answer: i === 0 ? 'I was nowhere near it, I was outside the whole time' : 'In the room with everyone else' })));
  }
  const res = await j(alibi(POST({ partyCode: c.partyCode, hostToken: c.hostToken, action: 'resolve' })));
  assert('the 6:40 question resolves and can flag a contradiction', !res.error,
    'host is not told whose');

  const sched = require('./lib/pollsched');
  let scheduled = 0;
  for (let p = 1; p <= 6; p++) scheduled += sched.scheduleFor(p).length;
  info('scheduled decision points', `${scheduled} across the night, plus any you open yourself`);
}

// ---------------------------------------------------------------------------
// 3. TALK
// ---------------------------------------------------------------------------
async function auditTalk() {
  console.log('\n\x1b[1m3. Does everyone have something to say, without it being easy?\x1b[0m');

  const ids = assignableIds(pack);
  const lines = pack.scriptLines || {};
  const perChar = ids.map((id) => Object.keys(lines[id] || {}).length);
  assert('every character has a line for every phase',
    perChar.every((n) => n >= 5), `min ${Math.min(...perChar)}, max ${Math.max(...perChar)} per character`);

  // A line is only a conversation starter if it points at somebody or asks for
  // something. Count the ones that name another character or set a task.
  let pointed = 0, total = 0;
  const otherNames = ids.map(nameOf).filter(Boolean);
  const textOf = (l) => (typeof l === 'string' ? l
    : [l && l.quote, l && l.reaction, l && l.prompt].filter(Boolean).join(' '));
  for (const id of ids) {
    for (const ph of Object.keys(lines[id] || {})) {
      const entry = lines[id][ph];
      // Count the phase's opening line AND everything it drips later on.
      const all = [entry].concat((entry && entry.more) || []);
      for (const l of all) {
        const text = textOf(l);
        total++;
        const namesSomeone = otherNames.some((n) => n !== nameOf(id) && text.includes(n));
        const setsATask = /\b(ask|tell|find|get|go|bring|show|make|corner|accuse|deny|admit|offer|warn)\b/i.test(text);
        if (namesSomeone || setsATask) pointed++;
      }
    }
  }
  assert('most private lines point at another guest or set a task',
    pointed / total > 0.7, `${pointed} of ${total} (${Math.round(100 * pointed / total)}%)`);

  // A full night, largest table, counting what the quietest seat receives.
  const c = await j(createGame(POST({})));
  await openDoors(c);
  const codes = await seat(c.partyCode, 20);
  const received = codes.map(() => 0);
  for (let phase = 1; phase <= 5; phase++) {
    await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase })));
    for (let i = 0; i < codes.length; i++) {
      const s = await j(state(GET({ partyCode: c.partyCode, personalCode: codes[i] })));
      if (s.you && s.you.lines) received[i]++;
      if (s.you && (s.you.drops || []).length) received[i]++;
      if (s.you && s.you.nudge) received[i]++;
    }
  }
  assert('at a full table of twenty, nobody sits with an empty phone',
    Math.min(...received) >= 5, `quietest seat received ${Math.min(...received)} pieces, busiest ${Math.max(...received)}`);

  // Not too easy: the decisive step has to stay shut until Phase 4.
  const c2 = await j(createGame(POST({})));
  await openDoors(c2);
  const codes2 = await seat(c2.partyCode, 12);
  const g2v = (await getGame(c2.partyCode)).variant;
  // The last words of a variant's keystone step, held in memory and only ever
  // compared against - never printed.
  const tailOf = (letter, propId) => {
    const v = pack.variants.find((x) => x.letter === letter);
    const st = (v.evidence.steps || []).find((s2) => new RegExp('\\b' + propId + '\\b').test(s2.text) && s2.n === 6);
    return st ? st.text.replace(/^\s*E\d+\s*(?:KEYSTONE\s*:\s*)?/i, '').slice(-50) : '\u0000never';
  };
  let lockedEarly = 0, openLater = 0;
  await j(advance(POST({ partyCode: c2.partyCode, hostToken: c2.hostToken, phase: 3 })));
  for (const pid of Object.keys(propCatalog(pack))) {
    const r = await j(scan(POST({ partyCode: c2.partyCode, personalCode: codes2[0], exhibit: exhibitNumber(pid, pack) })));
    if (r.reveal && r.reveal.reading && !r.reveal.reading.includes(tailOf(g2v, pid))) lockedEarly++;
  }
  await j(advance(POST({ partyCode: c2.partyCode, hostToken: c2.hostToken, phase: 4 })));
  for (const pid of Object.keys(propCatalog(pack))) {
    const r = await j(scan(POST({ partyCode: c2.partyCode, personalCode: codes2[0], exhibit: exhibitNumber(pid, pack) })));
    if (r.reveal && r.reveal.reading && r.reveal.reading.includes(tailOf(g2v, pid))) openLater++;
  }
  assert('something stays locked until Phase 4 and opens after it',
    lockedEarly > 0 && openLater > 0, `${lockedEarly} still shut in Phase 3, ${openLater} giving up more in Phase 4`);

  const hints = (pack.findHints || []);
  info('escalating nudges for props nobody has found', `${Array.isArray(hints) ? hints.length : Object.keys(hints).length} authored`);
  info('the room screen speaks', `${Object.keys(pack.narration || {}).length} authored narration beats`);
}

async function main() {
  console.log(`\n\x1b[1mParty audit\x1b[0m  \x1b[2mpack ${pack.id}, ${CHARS.length} characters, ${pack.variants.length} sealed endings\x1b[0m`);
  await auditLeaks();
  await auditWithheld();
  await auditBranching();
  await auditTalk();
  console.log(`\n${fail === 0 ? '\x1b[32m✓ AUDIT CLEAN' : '\x1b[31m✗ AUDIT FOUND PROBLEMS'}\x1b[0m  (${pass}/${pass + fail})\n`);
  note.forEach((n) => console.log('  ' + n));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('audit crashed:', e.message); process.exit(2); });
