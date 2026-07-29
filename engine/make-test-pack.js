#!/usr/bin/env node
'use strict';
/*
 * Generate a SPOILER-SAFE test pack for local rehearsal.
 *
 * The content here is deliberately fake ("Casey One", "Vera Victim", champagne
 * = "TEST CLUE") — it contains none of the real story. It mirrors the real
 * pack's SCHEMA so the engine behaves identically (phases, keystone gating,
 * killer unlock, branching drops), letting the owner rehearse as a player
 * without ever seeing the real solution.
 *
 * Writes packs/test/pack.json (plaintext — it's dummy, nothing to hide).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'packs', 'test', 'pack.json');

const LETTERS = ['A', 'B', 'C', 'D'];
const PROPS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

// Core cast C1..C10 and flex F1..F10 — plainly fake names.
const CORE = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const cast = CORE.map((w, i) => ({
  id: 'C' + (i + 1),
  name: `Casey ${w}`,
  piece: i + 1,
  brief: `TEST DOSSIER — You are Casey ${w}, a guest at the test gallery. PUBLIC: you are pleasant and a little nosy. SECRET: you once "borrowed" a stapler and never returned it. This is dummy content for rehearsal only.`,
}));
const flex = CORE.map((w, i) => ({
  id: 'F' + (i + 1),
  name: `Flex ${w}`,
  piece: null,
  brief: `TEST FLEX DOSSIER — You are Flex ${w}, an extra guest. SECRET: you are secretly bored. Dummy content for rehearsal only.`,
}));

// Prop matrix — each variant uses 3–4 genuine props; P4 is the keystone in all.
const genuineByVariant = { A: ['P1', 'P2', 'P3', 'P4'], B: ['P4', 'P5', 'P6'], C: ['P1', 'P4', 'P7'], D: ['P2', 'P4', 'P6'] };
const matrix = {};
for (const p of PROPS) {
  matrix[p] = {};
  for (const L of LETTERS) {
    if (p === 'P4') matrix[p][L] = 'keystone';
    else if (genuineByVariant[L].includes(p)) matrix[p][L] = 'genuine';
    else matrix[p][L] = 'herring';
  }
}

// Killers: A→C1, B→C2, C→C3, D→C4 (names, so resolveKillerId matches).
const killerByVariant = { A: 'Casey One', B: 'Casey Two', C: 'Casey Three', D: 'Casey Four' };
const variants = LETTERS.map((L) => {
  const gen = genuineByVariant[L];
  const steps = [];
  for (let n = 1; n <= 6; n++) {
    const isKeystone = n === 6;
    // Mention a genuine prop in each step; the keystone step mentions P4.
    const prop = isKeystone ? 'P4' : (gen[(n - 1) % gen.length] || 'P1');
    steps.push({
      n,
      isKeystone,
      text: `E${n} ${isKeystone ? 'KEYSTONE: ' : ''}TEST CLUE referencing ${prop} — dummy evidence for variant ${L}.`,
    });
  }
  return {
    letter: L,
    killer: killerByVariant[L],
    motive: `TEST MOTIVE for variant ${L}: the stapler grudge finally boiled over.`,
    method: `TEST METHOD for variant ${L}: an entirely fictional means, safe to read.`,
    voices: `TEST: muffled test-voices heard at test-o'clock.`,
    evidence: { steps, keystoneStep: 6 },
    genuineProps: gen,
    herrings: PROPS.filter((p) => !gen.includes(p)),
  };
});

// Branching — defaults for all; complicating for each variant's killer.
const complicatingFor = { C1: 'A', C2: 'B', C3: 'C', C4: 'D' };
const targets = {};
for (const c of cast) {
  targets[c.id] = {
    default: `TEST DEFENSE (${c.name}): stay calm, it's only a rehearsal — point at someone else's stapler.`,
    complicating: complicatingFor[c.id]
      ? { variant: complicatingFor[c.id], text: `TEST COMPLICATING (${c.name}): you did it (in this test). Keep bluffing.` }
      : null,
  };
}
const alibi = {};
const medical = {};
for (const L of LETTERS) {
  const killerId = 'C' + (LETTERS.indexOf(L) + 1);
  alibi[L] = { charId: killerId, text: `TEST ALIBI FLAG (variant ${L}): your test-alibi doesn't add up. Fix it or gamble.` };
  medical[L] = {
    full: `TEST MEDICAL FULL (variant ${L}): the dummy files say it was the stapler, definitely.`,
    partial: `TEST MEDICAL PARTIAL (variant ${L}): a leaked dummy page — 'stapler ... inconclusive.'`,
  };
}

const pack = {
  schema: 'mystery-engine/pack@1',
  id: 'test-rehearsal',
  generatedFrom: { checksum: 'TEST', byteLength: 0 },
  victim: '**Vera Victim**, 99, a fictional test-artist. Public knowledge at game start: Vera Victim died at her own test-exhibition; everyone is a suspect. This is dummy content for rehearsal.',
  timeline: 'TEST TIMELINE: things happened at a fictional test hour. Dummy content.',
  cast,
  flex,
  props: PROPS,
  matrix,
  variants,
  branching: 'TEST BRANCHING NOTES (dummy).',
  branchingData: { defense: { targets }, alibi, medical },
  fairnessRules: [{ n: 1, text: 'TEST rule: rehearsal only.' }],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pack, null, 2) + '\n', 'utf8');
console.log('Wrote spoiler-safe test pack → packs/test/pack.json');
console.log(`  cast ${cast.length} · flex ${flex.length} · variants ${variants.length} · props ${PROPS.length}`);
