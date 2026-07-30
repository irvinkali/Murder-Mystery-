#!/usr/bin/env node
'use strict';
/*
 * HTTP smoke test: boots the dev server on an ephemeral port and drives the
 * real request path (static routing + /api functions). Complements the unit
 * test-engine.js by exercising the actual HTTP wiring. SPOILER-SAFE output.
 */

// Smoke-test the REAL pack path (dev-server otherwise defaults to the test pack).
process.env.USE_REAL_PACK = process.env.USE_REAL_PACK || '1';
const { start } = require('./dev-server');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}`); }
}

async function main() {
  const server = await start(0);
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const get = (p) => fetch(base + p);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    // Static routing (mirrors netlify.toml pretty routes).
    const idx = await get('/'); const idxText = await idx.text();
    assert('GET / serves the join page', idx.status === 200 && /Join the party/i.test(idxText));
    const host = await get('/host'); assert('GET /host serves host controls', host.status === 200 && /Host controls/i.test(await host.text()));
    const prop = await get('/prop/P4'); assert('GET /prop/P4 serves the NFC landing', prop.status === 200 && /found something/i.test(await prop.text()));
    const css = await get('/app.css'); assert('static assets serve with a css content-type', (css.headers.get('content-type') || '').includes('text/css'));

    // API flow over HTTP.
    const created = await (await post('/api/create-game', { hostName: 'Kali' })).json();
    assert('POST /api/create-game returns a code and hides the variant', !!created.partyCode && !('variant' in created));
    const j1 = await (await post('/api/join', { partyCode: created.partyCode, name: 'A' })).json();
    assert('POST /api/join assigns a character', !!j1.personalCode && !!j1.character);
    const st = await (await get(`/api/state?partyCode=${created.partyCode}&personalCode=${j1.personalCode}`)).json();
    assert('GET /api/state returns public state + own brief, no variant',
      !('variant' in st.state) && !!(st.you && st.you.character.brief));
    const scanned = await (await post('/api/scan', { partyCode: created.partyCode, personalCode: j1.personalCode, propId: 'P1' })).json();
    assert('POST /api/scan returns a prop reveal', !!(scanned.reveal && scanned.reveal.label));

    // Reveal gating over HTTP.
    const early = await post('/api/reveal', { partyCode: created.partyCode, hostToken: created.hostToken });
    assert('reveal is forbidden before Phase 6 (HTTP 403)', early.status === 403);
    // Route through Phase 5 (opens the mandatory final vote) then 6 (auto-closes it).
    await post('/api/advance', { partyCode: created.partyCode, hostToken: created.hostToken, phase: 5 });
    await post('/api/advance', { partyCode: created.partyCode, hostToken: created.hostToken, phase: 6 });
    const rev = await (await post('/api/reveal', { partyCode: created.partyCode, hostToken: created.hostToken })).json();
    assert('reveal at Phase 6 (after final vote) returns the sealed solution', !!(rev.killer && rev.variant));
  } finally {
    server.close();
  }

  console.log(`\n${fail === 0 ? '\x1b[32m✓ SMOKE OK' : '\x1b[31m✗ SMOKE FAILURES'}\x1b[0m  (${pass}/${pass + fail})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke crashed:', e.message); process.exit(2); });
