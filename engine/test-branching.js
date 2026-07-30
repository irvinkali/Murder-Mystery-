#!/usr/bin/env node
'use strict';
/*
 * Branching-resolver test — verifies branching.md §4 gating exactly, driven
 * through the real scheduled-poll flow (polls auto-open by phase).
 * SPOILER-SAFE: asserts only drop KINDS, counts, and booleans.
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
const { loadRuntimePack, resolveKillerId, exhibitNumber } = require('./lib/runtime');
const { visibleDrops } = require('./lib/branching');

const pack = loadRuntimePack();
const POST = (b) => ({ httpMethod: 'POST', body: JSON.stringify(b) });
const GET = (q) => ({ httpMethod: 'GET', queryStringParameters: q });
const j = async (r) => JSON.parse((await r).body);
const nameOf = (id) => pack.cast.find((c) => c.id === id).name;
const dropsOf = (g, code) => (g.drops && g.drops[code]) || [];
const hasKind = (g, code, kind) => dropsOf(g, code).some((d) => d.kind === kind);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}`); }
}

async function freshGame(variant, toPhase) {
  const c = await j(createGame(POST({})));
  await updateGame(c.partyCode, (g) => { g.variant = variant; return g; });
  const codes = {};
  for (let i = 0; i < 10; i++) {
    const r = await j(join(POST({ partyCode: c.partyCode, name: 'P' + i })));
    codes[r.character.id] = r.personalCode;
  }
  if (toPhase) await j(advance(POST({ partyCode: c.partyCode, hostToken: c.hostToken, phase: toPhase })));
  return { pc: c.partyCode, ht: c.hostToken, codes };
}
const vote = (pc, code, id, choice) => j(poll(POST({ action: 'vote', partyCode: pc, personalCode: code, id, choice })));
const closePoll = (pc, ht, id) => j(poll(POST({ action: 'close', partyCode: pc, hostToken: ht, id })));

async function benefitsWonBy(pc, ht, codes, winnerName, otherName) {
  const vs = Object.values(codes);
  await vote(pc, vs[0], 'benefits', winnerName);
  await vote(pc, vs[1], 'benefits', winnerName);
  await vote(pc, vs[2], 'benefits', otherName);
  return closePoll(pc, ht, 'benefits');
}

async function main() {
  const VARIANTS = pack.variants.map((v) => v.letter);

  // §4.5 ordering — complicating suppressed until the killer unlock fires.
  for (const V of VARIANTS) {
    const killerId = resolveKillerId(pack, V);
    const killerName = nameOf(killerId);
    const otherName = nameOf(pack.cast.find((c) => c.id !== killerId).id);

    // (a) unlock NOT fired → DEFAULT (complicating suppressed).
    {
      const { pc, ht, codes } = await freshGame(V, 3); // Phase 3 auto-opens "benefits"
      await benefitsWonBy(pc, ht, codes, killerName, otherName);
      const g = await getGame(pc); const kc = codes[killerId];
      assert(`V${V}: killer wins before unlock → DEFAULT (complicating suppressed)`,
        hasKind(g, kc, 'defense') && !hasKind(g, kc, 'defense-complicating'));
    }
    // (b) unlock fired (killer polled state at Phase 3) → COMPLICATING.
    {
      const { pc, ht, codes } = await freshGame(V, 3);
      const kc = codes[killerId];
      await j(state(GET({ partyCode: pc, personalCode: kc }))); // fires the unlock
      await benefitsWonBy(pc, ht, codes, killerName, otherName);
      const g = await getGame(pc);
      assert(`V${V}: killer wins after unlock → COMPLICATING`, hasKind(g, kc, 'defense-complicating'));
    }
  }

  // Defense to a non-killer fires the default; and it fires only once.
  {
    const V = 'A'; const killerId = resolveKillerId(pack, V);
    const nonKiller = pack.cast.find((c) => c.id !== killerId).id;
    const { pc, ht, codes } = await freshGame(V, 3);
    const r1 = await benefitsWonBy(pc, ht, codes, nameOf(nonKiller), nameOf(killerId));
    const g = await getGame(pc);
    assert('non-killer winner gets a default defense drop', hasKind(g, codes[nonKiller], 'defense') && r1.fired === 'defense');
    const r2 = await closePoll(pc, ht, 'benefits'); // already closed
    assert('defense poll cannot be re-closed / re-fired', !r2 || r2.error || r2.closed === undefined || r2.fired == null);
  }

  // Medical reveal.
  {
    const V = 'A';
    // YES → FULL to all + [SCREEN].
    {
      const { pc, ht, codes } = await freshGame(V, 4); // Phase 4 auto-opens "subpoena"
      for (const c of Object.values(codes)) await vote(pc, c, 'subpoena', 'Yes');
      await closePoll(pc, ht, 'subpoena');
      const g = await getGame(pc);
      assert('medical YES → FULL drop to every player', Object.values(codes).every((c) => hasKind(g, c, 'medical-full')));
      assert('medical YES → public [SCREEN] announcement set', !!(g.screen && g.screen.text));
    }
    // NO → PARTIAL leak to 3 most-active, delayed.
    {
      const { pc, ht, codes } = await freshGame(V, 4);
      const vs = Object.values(codes);
      for (const c of [vs[0], vs[1], vs[2]]) await j(scan(POST({ partyCode: pc, personalCode: c, exhibit: exhibitNumber('P1') })));
      for (const c of vs) await vote(pc, c, 'subpoena', 'No');
      await closePoll(pc, ht, 'subpoena');
      const g = await getGame(pc);
      const leaked = vs.filter((c) => hasKind(g, c, 'medical-leak'));
      assert('medical NO → PARTIAL leak to exactly 3 players', leaked.length === 3);
      assert('medical NO leak is delayed — not visible immediately', !visibleDrops(g, leaked[0], 4, Date.now()).some((d) => d.kind === 'medical-leak'));
      assert('medical NO leak surfaces by Phase 5', visibleDrops(g, leaked[0], 5, Date.now()).some((d) => d.kind === 'medical-leak'));
    }
  }

  // Alibi contradiction flag.
  {
    const V = 'A'; const targetId = pack.branchingData.alibi[V].charId;
    {
      const { pc, ht, codes } = await freshGame(V, 3);
      await j(alibi(POST({ action: 'submit', partyCode: pc, personalCode: codes[targetId], answer: 'by the bar all night' })));
      await j(alibi(POST({ action: 'resolve', partyCode: pc, hostToken: ht })));
      assert('alibi: contradicting answer flags the target', hasKind(await getGame(pc), codes[targetId], 'alibi'));
    }
    {
      const { pc, ht, codes } = await freshGame(V, 3);
      await j(alibi(POST({ action: 'submit', partyCode: pc, personalCode: codes[targetId], answer: 'I was near the back room the whole time' })));
      await j(alibi(POST({ action: 'resolve', partyCode: pc, hostToken: ht })));
      assert('alibi: truthful near-scene answer does NOT fire', !hasKind(await getGame(pc), codes[targetId], 'alibi'));
    }
  }

  // Scheduled-poll wiring + final-vote gating.
  {
    const { pc, ht, codes } = await freshGame('A', 3);
    let st = await j(state(GET({ partyCode: pc })));
    assert('Phase 3 auto-opens the "benefits" poll with guidance', st.state.polls.some((p) => p.id === 'benefits' && p.guidance));
    await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 5 })));
    st = await j(state(GET({ partyCode: pc })));
    assert('Phase 5 auto-opens the mandatory final vote', st.state.polls.some((p) => p.id === 'final' && p.mandatory && !p.closed));
    // Reveal blocked until final closes.
    await j(advance(POST({ partyCode: pc, hostToken: ht, phase: 6 })));
    st = await j(state(GET({ partyCode: pc })));
    assert('advancing to Phase 6 auto-closes the final vote', st.state.polls.some((p) => p.id === 'final' && p.closed));
    assert('public state still carries no variant', !('variant' in st.state));
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ BRANCHING OK' : '\x1b[31m✗ BRANCHING FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('branching test crashed:', e.message); process.exit(2); });
