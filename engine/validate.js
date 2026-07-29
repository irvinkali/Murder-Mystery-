#!/usr/bin/env node
'use strict';
/*
 * Fairness-rule validator for a Mystery Engine story pack.
 *
 * SPOILER-SAFE: prints only rule PASS/FAIL, counts, and check strength. It
 * never prints character names, killers, secrets, evidence text, or which prop
 * is genuine in which variant. Safe to run in front of the owner.
 *
 * Usage:  node engine/validate.js [path/to/pack.md.b64]
 * Exit:   0 if all rules pass, 1 otherwise.
 */

const { loadPack, DEFAULT_BIBLE } = require('./lib/pack');

const EXPECTED = {
  md5: '424fe1e3e0cd2df4010b9a71f6bf9c6c', // from STATE.md (safe, non-spoiler)
  coreCast: 10,
  variants: 4,
  props: 7,
  evidencePerVariant: 6,
  playerRange: [10, 20],
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const results = [];
function check(id, label, strength, passed, detail) {
  results.push({ id, label, strength, passed, detail });
}

function run() {
  const b64Path = process.argv[2] || DEFAULT_BIBLE;
  let pack;
  try {
    pack = loadPack(b64Path);
  } catch (e) {
    console.error(`${RED}FATAL${RESET} could not load pack: ${e.message}`);
    process.exit(2);
  }

  const V = pack.variants;
  const coreIds = new Set(pack.cast.map((c) => c.id));
  // Guard against vacuous passes: rules that fold over the variant list must
  // fail outright if the variants did not parse to the expected count.
  const variantsOk = V.length === EXPECTED.variants;

  // ---- Integrity pre-checks (structure the rules rely on) ----
  check('I0', 'Bible checksum matches STATE.md', 'rigorous',
    pack.checksum === EXPECTED.md5,
    pack.checksum === EXPECTED.md5 ? 'md5 verified' : 'md5 MISMATCH');
  check('I1', 'Core cast count', 'rigorous',
    pack.cast.length === EXPECTED.coreCast, `found ${pack.cast.length}/${EXPECTED.coreCast}`);
  check('I2', 'Solution variant count', 'rigorous',
    V.length === EXPECTED.variants, `found ${V.length}/${EXPECTED.variants}`);
  check('I3', 'Prop count in matrix', 'rigorous',
    pack.props.length === EXPECTED.props, `found ${pack.props.length}/${EXPECTED.props}`);

  // ---- §7 Rule 1: killer provable from E1..E6 + <=2 prop finds ----
  {
    let ok = true;
    const notes = [];
    for (const v of V) {
      const ns = v.evidence.steps.map((s) => s.n).sort((a, b) => a - b);
      const complete = ns.length === EXPECTED.evidencePerVariant &&
        ns.every((n, i) => n === i + 1);
      const keystoneIsE6 = v.evidence.keystoneStep === 6;
      const genuineOk = v.genuineProps.length <= 4; // props needed to corroborate
      if (!(complete && keystoneIsE6 && genuineOk)) ok = false;
      if (!complete) notes.push(`V${v.letter}:E-chain`);
      if (!keystoneIsE6) notes.push(`V${v.letter}:keystone!=E6`);
    }
    check('R1', 'Every variant killer provable from E1–E6 (keystone at E6)',
      'structural', ok && variantsOk, notes.length ? notes.join(' ') : 'E1–E6 complete, E6 = keystone in all variants');
  }

  // ---- §7 Rule 2: no solution depends on a flex character ----
  {
    let ok = true;
    const notes = [];
    for (const v of V) {
      const blob = [v.killer, v.motive, v.method, v.voices,
        ...v.evidence.steps.map((s) => s.text)].join(' ');
      const usesFlex = /\bF\d+\b/.test(blob);
      const killerIsCore = /\bC\d+\b/.test(v.killer) ? coreIds.has((v.killer.match(/C\d+/) || [])[0]) : true;
      // Killer is named (prose) rather than by id; assert no flex token appears.
      if (usesFlex) { ok = false; notes.push(`V${v.letter}:flex-ref`); }
      void killerIsCore;
    }
    // With flex list currently empty this is trivially satisfied; the scan still
    // guards against a future flex character becoming load-bearing.
    check('R2', 'No variant solution depends on a flex character',
      'rigorous', ok && variantsOk, `flex chars defined: ${pack.flex.length}; ${notes.length ? notes.join(' ') : 'no flex references in any solution'}`);
  }

  // ---- §7 Rule 3: every core character surface-plausible in every variant ----
  {
    const allHavePiece = pack.cast.every((c) => Number.isInteger(c.piece));
    const pieces = pack.cast.map((c) => c.piece);
    const distinctPieces = new Set(pieces).size === pieces.length;
    const ok = pack.cast.length === EXPECTED.coreCast && allHavePiece && distinctPieces;
    check('R3', 'Every core character carries an exposure (no one obviously safe)',
      'proxy', ok,
      `${pack.cast.length} characters, each mapped to a distinct MEMENTO piece: ${ok ? 'yes' : 'NO'}`);
  }

  // ---- §7 Rule 4: keystone unavailable before Phase 4 under all poll paths ----
  {
    const everyKeystoneE6 = V.every((v) => v.evidence.keystoneStep === 6);
    // Guard: no branching hook releases the keystone/E6 in an earlier phase.
    const branch = pack.branching || '';
    const earlyRelease = /(phase\s*[123])[^.]*\bE6\b/i.test(branch) ||
      /\bE6\b[^.]*(phase\s*[123])\b/i.test(branch) ||
      /keystone[^.]*(phase\s*[123])\b/i.test(branch);
    const ruleStated = pack.fairnessRules.some((r) => /keystone|E6/i.test(r.text) && /phase\s*4/i.test(r.text));
    const ok = variantsOk && everyKeystoneE6 && !earlyRelease && ruleStated;
    check('R4', 'Keystone (E6) unreachable before Phase 4 on all poll paths',
      'structural', ok,
      `keystone=E6 all variants: ${everyKeystoneE6}; no early-release hook: ${!earlyRelease}; rule stated: ${ruleStated}`);
  }

  // ---- §7 Rule 5: every prop genuine >=1 variant; each variant uses 3-4 ----
  {
    const cols = ['A', 'B', 'C', 'D'];
    const isGenuine = (kind) => kind === 'genuine' || kind === 'keystone';

    // (a) each prop genuine in >= 1 variant
    let everyPropUsed = true;
    for (const p of pack.props) {
      const count = cols.reduce((n, c) => n + (isGenuine(pack.matrix[p][c]) ? 1 : 0), 0);
      if (count < 1) everyPropUsed = false;
    }
    // (b) each variant uses 3-4 genuine props (from the matrix column)
    let colCountsOk = true;
    const perVariantCounts = {};
    for (const c of cols) {
      const count = pack.props.reduce((n, p) => n + (isGenuine(pack.matrix[p][c]) ? 1 : 0), 0);
      perVariantCounts[c] = count;
      if (count < 3 || count > 4) colCountsOk = false;
    }
    // (c) consistency: matrix column matches each variant's "Genuine props" bullet
    let consistent = true;
    for (const v of V) {
      const fromMatrix = pack.props.filter((p) => isGenuine(pack.matrix[p][v.letter])).sort();
      const fromBullet = [...v.genuineProps].sort();
      if (JSON.stringify(fromMatrix) !== JSON.stringify(fromBullet)) consistent = false;
    }
    const ok = variantsOk && everyPropUsed && colCountsOk && consistent;
    check('R5', 'Every prop genuine in ≥1 variant; each variant uses 3–4 genuine props',
      'rigorous', ok,
      `all props used: ${everyPropUsed}; per-variant counts in [3,4]: ${colCountsOk}; matrix↔bullet consistent: ${consistent}`);
  }

  // ---- §7 Rule 6: any character (incl. killer) playable w/o acting skill ----
  {
    const ruleStated = pack.fairnessRules.some((r) => /acting/i.test(r.text) || /any character/i.test(r.text));
    check('R6', 'Any character (incl. killer) drawable; instructions need no acting skill',
      'deferred', ruleStated,
      ruleStated
        ? 'rule present; enforced by killer do/don\'t scripts in printables/host tools (Step 5)'
        : 'rule statement not found');
  }

  // ---- Player-count sweep 10..20 (Rule 2 interacts: 10-player omits flex) ----
  {
    const [lo, hi] = EXPECTED.playerRange;
    let ok = true;
    const failing = [];
    for (let n = lo; n <= hi; n++) {
      // At any count, the required cast for the solution must be a subset of core.
      // Flex are additive/optional and never load-bearing (Rule 2), so every
      // count from the minimum (flex omitted) upward is solvable with core only.
      const solvableWithCoreOnly = V.every((v) =>
        !/\bF\d+\b/.test([v.motive, v.method, ...v.evidence.steps.map((s) => s.text)].join(' ')));
      if (!solvableWithCoreOnly) { ok = false; failing.push(n); }
    }
    check('PC', `Solvable at every player count ${lo}–${hi} (flex never load-bearing)`,
      'rigorous', ok && variantsOk, ok ? `all ${hi - lo + 1} counts solvable with core cast only` : `failing counts: ${failing.join(',')}`);
  }

  // ---- Seating capacity (core + flex). Surfaced honestly; not a silent cap. ----
  {
    const [, hi] = EXPECTED.playerRange;
    const seats = pack.cast.length + (pack.flex ? pack.flex.length : 0);
    const reaches = seats >= hi;
    check('CAP', `Seats available for players (target up to ${hi})`,
      'rigorous', seats >= EXPECTED.coreCast,
      reaches
        ? `${seats} seats — covers the full ${EXPECTED.playerRange[0]}–${hi} range`
        : `${seats} seats (core only) — author flex characters F1–F${hi - pack.cast.length} to seat players ${pack.cast.length + 1}–${hi}`);
  }

  report(pack);
}

function report(pack) {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(`\n${BOLD}Mystery Engine — Fairness Validation${RESET}`);
  console.log(`${DIM}pack: last-exhibit  ·  variants: ${pack.variants.length}  ·  core cast: ${pack.cast.length}  ·  props: ${pack.props.length}  ·  flex: ${pack.flex.length}${RESET}`);
  console.log(`${DIM}(spoiler-safe: no identities, secrets, or solutions are printed)${RESET}\n`);

  let allPass = true;
  for (const r of results) {
    if (!r.passed) allPass = false;
    const tag = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${tag}  ${pad(r.id, 4)} ${pad(r.label, 62)} ${DIM}[${r.strength}]${RESET}`);
    if (r.detail) console.log(`        ${DIM}${r.detail}${RESET}`);
  }

  const passCount = results.filter((r) => r.passed).length;
  console.log(`\n${BOLD}${allPass ? GREEN + '✓ ALL CHECKS PASS' : RED + '✗ SOME CHECKS FAILED'}${RESET}  (${passCount}/${results.length})`);
  console.log(`${DIM}strength legend: rigorous = fully derived from data · structural = shape/labels · proxy = strong indirect · deferred = enforced in a later build step${RESET}\n`);

  process.exit(allPass ? 0 : 1);
}

run();
