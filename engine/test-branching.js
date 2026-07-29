#!/usr/bin/env node
'use strict';
/*
 * Branching-resolver test — verifies branching.md §4 gating exactly.
 * SPOILER-SAFE: asserts only drop KINDS, counts, and booleans. It never prints
 * drop text, killer identities, or which variant is which.
 */

delete process.env.NETLIFY;

const createGame = require('./functions/create-game').handler;
const join = require('./functions/join').handler;
const state = require('./functions/state').handler;
const poll = require('./functions/poll').handler;
const advance = require('./functions/advance').handler;
const alibi = require('./functions/alibi').handler;
const scan = require('./functions/scan').handler;
const { getGame, updateGame } = require('./lib/store');
const { loadRuntimePack, resolveKillerId } = require('./lib/runtime');
const { visibleDrops } = require('./lib/branching');

const pack = loadRuntimePack();
const POST = (b) => ({ httpMethod: 'POST', body: JSON.stringify(b) });
const GET = (q) => ({ httpMethod: 'GET', queryStringParameters: q });
const j = async (r) => JSON.parse((await r).body);
const nameOf = (id) => pack.cast.find((c) => c.id === id).name;
const dropsOf = (game, code) => (game.drops && game.drops[code]) || [];
const hasKind = (game, code, kind) => dropsOf(game, code).some((d) => d.kind === kind);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}`); }
}

async function freshGame(variant) {
  const c = await j(createGame(POST({})));
  await updateGame(c.partyCode, (g) => { g.variant = variant; return g; });
  const codes = {};
  for (let i = 0; i < 10; i++) {
    const r = await j(join(POST({ partyCode: c.partyCode, name: 'P' + i })));
    codes[r.character.id] = r.personalCode;
  }
  return { pc: c.partyCode, ht: c.hostToken, codes };
}
async function benefitsPollWonBy(pc, ht, codes, winnerName, otherName) {
  const id = 'ben';
  await j(poll(POST({ action: 'create', partyCode: pc, hostToken: ht, id, question: 'Who benefits?', options: [winnerName, otherName], branch: 'benefits' })));
  const vs = Object.values(codes);
  await j(poll(POST({ action: 'vote', partyCode: pc, personalCode: vs[0], id, choice: winnerName })));
  await j(poll(POST({ action: 'vote', partyCode: pc, personalCode: vs[1], id, choice: winnerName })));
  await j(poll(POST({ action: 'vote', partyCode: pc, personalCode: vs[2], id, choice: otherName })));
  return j(poll(POST({ action: 'close', partyCode: pc, hostToken: ht, id })));
}

async function main() {
  const VARIANTS = pack.variants.map((v) => v.letter);

  // ---- §4.5 ordering: complicating drop suppressed until the unlock fires ----
  for (const V of VARIANTS) {
    const killerId = resolveKillerId(pack, V);
    const killerName = nameOf(killerId);
    const otherName = nameOf(pack.cast.find((c) => c.id !== killerId).id);

    // (a) Unlock NOT fired yet → killer wins benefits poll → must get DEFAULT.
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 3 })));
      await benefitsPollWonBy(pc, ht, codes, killerName, otherName);
      const g = await getGame(pc);
      const kc = codes[killerId];
      assert(`V${V}: killer wins before unlock → DEFAULT drop (complicating suppressed)`,
        hasKind(g, kc, 'defense') && !hasKind(g, kc, 'defense-complicating'));
    }

    // (b) Unlock fired (killer polled state at Phase 3) → COMPLICATING drop.
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 3 })));
      const kc = codes[killerId];
      await j(state(GET({ partyCode: pc, personalCode: kc }))); // fires the unlock
      await benefitsPollWonBy(pc, ht, codes, killerName, otherName);
      const g = await getGame(pc);
      assert(`V${V}: killer wins after unlock → COMPLICATING drop`,
        hasKind(g, kc, 'defense-complicating'));
    }
  }

  // ---- Defense to a non-killer, and once-per-game guard ----
  {
    const V = 'A';
    const killerId = resolveKillerId(pack, V);
    const nonKiller = pack.cast.find((c) => c.id !== killerId).id;
    const { pc, ht, codes } = await freshGame(V);
    await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 3 })));
    const r1 = await benefitsPollWonBy(pc, ht, codes, nameOf(nonKiller), nameOf(killerId));
    const g1 = await getGame(pc);
    assert('non-killer winner gets a (default) defense drop',
      hasKind(g1, codes[nonKiller], 'defense') && r1.fired === 'defense');
    // Second benefits poll must NOT fire again.
    const r2 = await benefitsPollWonBy(pc, ht, codes, nameOf(nonKiller), nameOf(killerId));
    assert('defense fires at most once per game', r2.fired === null);
  }

  // ---- Medical reveal: YES → all + [SCREEN]; NO → 3 leaked, delayed ----
  {
    const V = 'A';
    // YES path
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 4 })));
      const id = 'sub';
      await j(poll(POST({ action: 'create', partyCode: pc, hostToken: ht, id, question: 'Subpoena?', options: ['Yes', 'No'], branch: 'subpoena' })));
      for (const c of Object.values(codes)) await j(poll(POST({ action: 'vote', partyCode: pc, personalCode: c, id, choice: 'Yes' })));
      await j(poll(POST({ action: 'close', partyCode: pc, hostToken: ht, id })));
      const g = await getGame(pc);
      const everyoneGotFull = Object.values(codes).every((c) => hasKind(g, c, 'medical-full'));
      assert('medical YES → FULL drop to every player', everyoneGotFull);
      assert('medical YES → public [SCREEN] announcement set', !!(g.screen && g.screen.text));
    }
    // NO path — only the 3 most active investigators, delayed.
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 4 })));
      const vs = Object.values(codes);
      // Three players scan (become the top investigators); others don't.
      for (const c of [vs[0], vs[1], vs[2]]) await j(scan(POST({ partyCode: pc, personalCode: c, propId: 'P1' })));
      const id = 'sub';
      await j(poll(POST({ action: 'create', partyCode: pc, hostToken: ht, id, question: 'Subpoena?', options: ['Yes', 'No'], branch: 'subpoena' })));
      for (const c of vs) await j(poll(POST({ action: 'vote', partyCode: pc, personalCode: c, id, choice: 'No' })));
      await j(poll(POST({ action: 'close', partyCode: pc, hostToken: ht, id })));
      const g = await getGame(pc);
      const leaked = vs.filter((c) => hasKind(g, c, 'medical-leak'));
      assert('medical NO → PARTIAL leak to exactly 3 players', leaked.length === 3);
      // Delayed: not visible immediately at Phase 4…
      const notYet = visibleDrops(g, leaked[0], 4, Date.now()).some((d) => d.kind === 'medical-leak');
      assert('medical NO leak is delayed (~6 min) — not visible immediately', !notYet);
      // …but visible once accusations (Phase 5) open (§4.3).
      const atPhase5 = visibleDrops(g, leaked[0], 5, Date.now()).some((d) => d.kind === 'medical-leak');
      assert('medical NO leak surfaces by Phase 5 (before accusations close)', atPhase5);
    }
  }

  // ---- Alibi contradiction flag (§4.2) ----
  {
    const V = 'A';
    const targetId = pack.branchingData.alibi[V].charId;
    // Contradicting answer → flag fires.
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 3 })));
      await j(alibi(POST({ action: 'submit', partyCode: pc, personalCode: codes[targetId], answer: 'by the bar all night' })));
      await j(alibi(POST({ action: 'resolve', partyCode: pc, hostToken: ht })));
      const g = await getGame(pc);
      assert('alibi: contradicting answer flags the target privately', hasKind(g, codes[targetId], 'alibi'));
    }
    // Honest "near the back room" answer → no flag (honesty is its own gamble).
    {
      const { pc, ht, codes } = await freshGame(V);
      await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 3 })));
      await j(alibi(POST({ action: 'submit', partyCode: pc, personalCode: codes[targetId], answer: 'I was near the back room the whole time' })));
      await j(alibi(POST({ action: 'resolve', partyCode: pc, hostToken: ht })));
      const g = await getGame(pc);
      assert('alibi: truthful near-scene answer does NOT fire a flag', !hasKind(g, codes[targetId], 'alibi'));
    }
  }

  // ---- Drops never leak the variant via public state ----
  {
    const { pc, ht } = await freshGame('A');
    await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 4 })));
    const st = await j(state(GET({ partyCode: pc })));
    assert('public state still carries no variant', !('variant' in st.state));
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ BRANCHING OK' : '\x1b[31m✗ BRANCHING FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('branching test crashed:', e.message); process.exit(2); });
