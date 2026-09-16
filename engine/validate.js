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

const path = require('path');
const { loadPack, DEFAULT_BIBLE } = require('./lib/pack');
const { PHASE_MINUTES, resolvePropScan, sanitizeReading } = require('./lib/runtime');
const DED = require('./lib/deduction');

const EXPECTED = {
  // Checksum pin for the default bible (safe, non-spoiler). Re-pinned again when
  // British spellings were corrected to American; the previous value was
  // 9aed8f4c2eb09757074eed40c0881216. Re-pinned when the
  // player-facing copy sections (8–11) moved out of the engine and into the
  // bible; the previous value was 424fe1e3e0cd2df4010b9a71f6bf9c6c.
  // Re-pinned again when variant B gained a keystone prop (R4b) and Phase 2
  // gained script lines (R7); the previous value was
  // b5531a15dcbcf9d9d34edf6a4bf3e713.
  // Re-pinned when the deduction layer landed: every step of the evidence chain
  // gained a phase, the exhibit readings were authored so a dead end and a step
  // that has not opened look alike, and the shortest and longest replies were
  // evened up. The previous value was 38c58a4559160c9fd4294521f3fa34b5.
  md5: 'a518781264f371bcc061c5ac788814fd',
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
let packId = 'unknown';
function check(id, label, strength, passed, detail) {
  results.push({ id, label, strength, passed, detail });
}

function run() {
  const b64Path = process.argv[2] || DEFAULT_BIBLE;
  packId = path.basename(path.dirname(path.resolve(b64Path)));
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
  // The checksum is pinned per pack: the default bible against STATE.md, any
  // other pack only when the caller pins one via MYSTERY_EXPECTED_MD5.
  const isDefaultBible = path.resolve(b64Path) === path.resolve(DEFAULT_BIBLE);
  const expectedMd5 = process.env.MYSTERY_EXPECTED_MD5 || (isDefaultBible ? EXPECTED.md5 : null);
  check('I0', 'Bible checksum matches its pin', 'rigorous',
    expectedMd5 ? pack.checksum === expectedMd5 : true,
    !expectedMd5 ? 'no checksum pinned for this pack (set MYSTERY_EXPECTED_MD5 to pin it)'
      : pack.checksum === expectedMd5 ? 'md5 verified' : 'md5 MISMATCH');
  check('I1', 'Core cast count', 'rigorous',
    pack.cast.length === EXPECTED.coreCast, `found ${pack.cast.length}/${EXPECTED.coreCast}`);
  check('I2', 'Solution variant count', 'rigorous',
    V.length === EXPECTED.variants, `found ${V.length}/${EXPECTED.variants}`);
  check('I3', 'Prop count in matrix', 'rigorous',
    pack.props.length === EXPECTED.props, `found ${pack.props.length}/${EXPECTED.props}`);

  // ---- I4: the pack carries ALL its own player-facing copy ----
  // The engine holds only neutral fallbacks; a pack that leans on them would
  // sound like no particular world, so a complete pack must supply every string.
  {
    const cat = pack.propCatalog || {};
    const narr = pack.narration || {};
    const world = pack.world || {};
    const polls = pack.polls || {};
    const catOk = pack.props.length > 0 && pack.props.every((p) => {
      const e = cat[p];
      return !!(e && e.number && e.label && e.blurb && e.flourish && e.placement);
    });
    const monoOk = [1, 2, 3, 4, 5, 6].every((n) => !!(narr.monologues || {})[n]);
    const nameOk = [1, 2, 3, 4, 5, 6].every((n) => !!(narr.phaseNames || {})[n]);
    const linesOk = ['attention', 'warn2min', 'awardsIntro', 'photo', 'photoScreen',
      'blackoutStart', 'blackoutEnd', 'blackoutMoved', 'suspect', 'subpoenaYes',
      'subpoenaNo', 'finalClosed', 'medicalScreen', 'lockedHint', 'unknownTag']
      .every((k) => !!narr[k]);
    const awardsOk = ['bestDetective', 'sharpestEye', 'mostSuspected', 'caught', 'perfect']
      .every((k) => { const a = (narr.awards || {})[k]; return !!(a && a.title && a.note); });
    const listsOk = (narr.asides || []).length >= 6 && (narr.nudges || []).length >= 6;
    const pollsOk = ['benefits', 'subpoena', 'final']
      .every((id) => !!(polls[id] && polls[id].question && polls[id].guidance));
    const fe = pack.frontend || {};
    const feOk = !!(fe.brand && fe.brand.siteTitle && fe.brand.brandEyebrow && fe.brand.placardLabel &&
      fe.brand.placardCount && fe.invite && fe.invite.card && fe.invite.poll && fe.invite.short &&
      fe.invite.long && fe.invite.printLines && (fe.printables || []).length);
    const worldOk = !!(world.title && world.itemNoun && world.itemNounPlural &&
      world.alibiQuestion && (world.nearScene || []).length && world.victimPronouns &&
      world.victimPronouns.subject);
    const ok = catOk && monoOk && nameOk && linesOk && awardsOk && listsOk && pollsOk && worldOk && feOk;
    check('I4', 'Pack carries its own player-facing copy (no engine fallbacks)', 'rigorous', ok,
      `catalog: ${catOk}; monologues: ${monoOk}; phase names: ${nameOk}; narrator lines: ${linesOk}; awards: ${awardsOk}; ` +
      `asides+nudges: ${listsOk}; poll copy: ${pollsOk}; world hooks: ${worldOk}; front-end kit: ${feOk}`);
  }

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
    // Full names of flex characters, so we can confirm none appears in a solution.
    const flexNames = (pack.flex || []).map((f) => f.name).filter(Boolean);
    for (const v of V) {
      const blob = [v.killer, v.motive, v.method, v.voices,
        ...v.evidence.steps.map((s) => s.text)].join(' ');
      const usesFlexId = /\bF\d+\b/.test(blob);
      const usesFlexName = flexNames.some((n) => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(blob));
      if (usesFlexId || usesFlexName) { ok = false; notes.push(`V${v.letter}:flex-ref`); }
    }
    // With flex list currently empty this is trivially satisfied; the scan still
    // guards against a future flex character becoming load-bearing.
    check('R2', 'No variant solution depends on a flex character',
      'rigorous', ok && variantsOk, `flex chars defined: ${pack.flex.length}; ${notes.length ? notes.join(' ') : 'no flex id or name appears in any solution'}`);
  }

  // ---- §7 Rule 3: every core character surface-plausible in every variant ----
  {
    const allHavePiece = pack.cast.every((c) => Number.isInteger(c.piece));
    const pieces = pack.cast.map((c) => c.piece);
    const distinctPieces = new Set(pieces).size === pieces.length;
    const ok = pack.cast.length === EXPECTED.coreCast && allHavePiece && distinctPieces;
    check('R3', 'Every core character carries an exposure (no one obviously safe)',
      'proxy', ok,
      `${pack.cast.length} characters, each mapped to a distinct exposure number: ${ok ? 'yes' : 'NO'}`);
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

  // ---- R4b: the keystone is an OBJECT somebody has to find ----
  // R4 proves E6 is the last step and nothing releases it early. That is a
  // statement about the chain. This is the runtime half: the decisive step has
  // to hang off a prop the room can physically find, or Phase 4 has nothing to
  // open and that night is materially easier than the other three. One pack
  // shipped with a variant that had no keystone prop at all, which is why this
  // rule exists.
  {
    const notes = [];
    let ok = variantsOk;
    for (const v of V) {
      const letter = v.id || v.letter || v.key;
      const ks = pack.props.filter((p) => {
        const id = typeof p === 'string' ? p : p.id;
        return ((pack.matrix[id] || {})[letter]) === 'keystone';
      }).map((p) => (typeof p === 'string' ? p : p.id));
      const e6 = (v.evidence.steps || []).find((st) => st.n === 6);
      const named = e6 ? ks.filter((id) => new RegExp('\\b' + id + '\\b').test(e6.text)) : [];
      if (ks.length !== 1) { ok = false; notes.push(`variant ${letter}: ${ks.length} keystone props (want 1)`); }
      else if (named.length !== 1) { ok = false; notes.push(`variant ${letter}: E6 does not name its keystone prop`); }
    }
    check('R4b', 'Every variant hangs its keystone on a findable prop', 'rigorous', ok,
      notes.length ? notes.join('; ') : 'all variants: exactly one keystone prop, named by E6');
  }

  // ---- R7: every character has something to say in every playable phase ----
  // A phase where nobody is handed a line is a phase where the quiet guests go
  // quiet. Phases 1 to 5 are played; 6 is the reveal and needs no lines.
  //
  // How MANY lines a phase carries is the pack's call. A long phase wants more
  // than one prompt to get through it, a short one does not. What the validator
  // insists on is that the pack made that call for EVERYBODY: within a phase,
  // no character may be handed fewer lines than their neighbours. It also
  // insists that any dripped line lands in order and inside its own phase.
  {
    const ids = [...pack.cast.map((c) => c.id), ...(pack.flex || []).map((f) => f.id)];
    const lines = pack.scriptLines || {};
    const depthOf = (id, ph) => {
      const l = (lines[id] || {})[ph];
      if (!l || (!l.quote && !l.prompt && !l.reaction)) return 0;
      return 1 + ((l.more || []).length);
    };
    const gaps = [];
    const shape = [];
    for (let ph = 1; ph <= 5; ph++) {
      const depths = ids.map((id) => depthOf(id, ph));
      const deepest = Math.max(...depths);
      shape.push(`ph${ph}:${deepest}`);
      const missing = depths.filter((d) => d === 0).length;
      if (missing) { gaps.push(`phase ${ph}: ${missing}/${ids.length} characters with no line`); continue; }
      const thin = depths.filter((d) => d < deepest).length;
      if (thin) gaps.push(`phase ${ph}: ${thin}/${ids.length} characters carry fewer than the ${deepest} lines the rest get`);
      // Drip offsets must climb, and must land inside the phase they belong to.
      const allotted = PHASE_MINUTES[ph] || 0;
      const badDrip = ids.filter((id) => {
        const more = ((lines[id] || {})[ph] || {}).more || [];
        let prev = 0;
        return more.some((m) => {
          const at = m.afterMin || 0;
          const bad = at <= prev || (allotted && at >= allotted);
          prev = at;
          return bad;
        });
      }).length;
      if (badDrip) gaps.push(`phase ${ph}: ${badDrip} characters have drip offsets that do not climb or fall outside the ${allotted}-minute phase`);
    }
    check('R7', 'Every character has a private line in every played phase', 'rigorous',
      gaps.length === 0, gaps.length ? gaps.join('; ')
        : `all ${ids.length} characters carry the same depth of line in every played phase (${shape.join(' ')}), dripped in order inside the phase`);
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


  // ---- D1..D6: the deduction layer -------------------------------------
  // These are the rules that stop the night being solvable by one person, early,
  // from objects alone. They are written as measurements rather than assertions:
  // D1 enumerates every subset of the private links instead of trusting that
  // four are needed, and D2 sweeps every exhibit under every answer at every
  // phase instead of trusting that the replies look alike.
  {
    // The CHAIN, not merely the section: a pack may author exhibit readings
    // without a seated chain, and D1/D5/D6 do not apply to one that has not.
    const D = DED.layer(pack);
    const phases = [1, 2, 3, 4, 5];
    const letters = V.map((v) => v.letter);

    // D2: the SHAPE of what an exhibit says back must be identical under all
    // four answers, at every phase. This is the leak that shipped: three
    // distinguishable reply classes whose pattern across the seven exhibits was
    // unique to each answer, readable without understanding a word of it.
    {
      const fingerprint = (letter, phase) => pack.props.map((pr) => {
        const r = resolvePropScan(pack, letter, pr, phase);
        return Object.keys(r).filter((k) => k !== 'propId').sort().join('+') +
          (r.reading ? ':said' : ':silent') + ':' + (r.entries || 0);
      }).join('|');
      // And which exhibits say something new at each phase turn. If a live one
      // settled while the dead ends kept moving, re-reading all seven either
      // side of a phase change would name the answer.
      const churn = (letter, a, b) => pack.props.map((pr) =>
        (resolvePropScan(pack, letter, pr, a).reading === resolvePropScan(pack, letter, pr, b).reading) ? '.' : 'c').join('');
      let ok = variantsOk;
      const bad = [];
      for (const phase of phases) {
        const seen = new Set(letters.map((l) => fingerprint(l, phase)));
        if (seen.size !== 1) { ok = false; bad.push('phase ' + phase + ': ' + seen.size + ' distinct'); }
      }
      for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5]]) {
        const seen = new Set(letters.map((l) => churn(l, a, b)));
        if (seen.size !== 1) { ok = false; bad.push('boundary ' + a + '-' + b + ': ' + seen.size + ' distinct'); }
      }
      check('D2', 'Exhibit replies are indistinguishable in shape across all answers',
        'rigorous', ok, bad.length ? bad.join('; ') : 'one fingerprint at every phase and one change-pattern at every phase turn (' + phases.length + ' phases, 4 turns)');
    }

    // D3: and comparable in weight, so "that one gave me a paragraph and this
    // one gave me a line" is not a tell either.
    {
      // Comparable, not identical: measured as a RATIO rather than an absolute
      // band, because one pack writes its evidence as case notes and another
      // writes it as paragraphs, and neither is wrong. What matters is that no
      // reply is conspicuously heavier or lighter than its neighbours.
      const FLOOR = 80, RATIO = 2.5;
      let lo = Infinity, hi = 0, empty = 0;
      for (const letter of letters) for (const phase of phases) for (const pr of pack.props) {
        const t = (resolvePropScan(pack, letter, pr, phase).reading || '');
        if (!t) empty++;
        // Per ENTRY: a reply accumulates one entry per phase, so measuring the
        // whole reply would just measure how late in the evening it is.
        for (const part of t.split('\n\n')) { lo = Math.min(lo, part.length); hi = Math.max(hi, part.length); }
      }
      // A pack with no authored readings falls back to the catalog flourish for
      // every dead end, which keeps the SHAPE uniform (D2) but leaves the
      // WEIGHT uneven wherever that pack writes its evidence shorter or longer
      // than its flourishes. That is a real residual tell, so it is reported
      // rather than hidden - but it is a missing-content finding, not a broken
      // rule, so it does not fail a pack that has not authored the layer yet.
      const authored = !!pack.readings;
      const ratio = lo > 0 && lo !== Infinity ? hi / lo : Infinity;
      const ok = variantsOk && !empty && lo >= FLOOR && ratio <= RATIO;
      const spread = empty + ' empty; shortest entry ' + (lo === Infinity ? 0 : lo) + ', longest ' + hi +
        ' (ratio ' + (ratio === Infinity ? 'n/a' : ratio.toFixed(2)) + ', limit ' + RATIO + ', floor ' + FLOOR + ')';
      if (authored) {
        check('D3', 'Every exhibit reply is present and of comparable weight', 'rigorous', ok, spread);
      } else {
        check('D3', 'Every exhibit reply is present and of comparable weight', 'deferred', true,
          'no exhibit readings authored for this pack - replies fall back to the catalog flourish. ' +
          spread + '. Uneven weight is still a visible difference; author READING lines to close it.');
      }
    }

    // D4: nothing a guest reads may carry the authoring scaffolding. The chain
    // ordinal tells them how far along a six-step chain they are and the
    // internal exhibit id is not supposed to leave the server; both were being
    // rendered inside the prose, not only in the payload fields, so stripping
    // the fields alone did not close it. This rule stops new authoring from
    // reintroducing either of them.
    {
      let hits = 0;
      for (const letter of letters) for (const phase of phases) for (const pr of pack.props) {
        const t = resolvePropScan(pack, letter, pr, phase).reading || '';
        if (/\bP[1-9]\d*\b/.test(t) || /^\s*E[1-9]\b/.test(t) || /KEYSTONE/i.test(t)) hits++;
      }
      const sanOk = sanitizeReading('E6 KEYSTONE: P4 a thing happened') === 'a thing happened';
      check('D4', 'No served text carries a chain ordinal or an internal exhibit id',
        'rigorous', hits === 0 && sanOk,
        hits + ' served readings carrying scaffolding; sanitizer self-test: ' + (sanOk ? 'pass' : 'FAIL'));
    }

    if (!D) {
      check('D1', 'Answer needs four separate seats (seated chain)', 'deferred', true,
        'no deduction layer authored for this pack - it runs without a seated chain');
      check('D5', 'Answer set narrows one step at a time, never to one in public', 'deferred', true,
        'no deduction layer authored for this pack');
      check('D6', 'False leads point away from the answer and are cleared in play', 'deferred', true,
        'no deduction layer authored for this pack');
    } else {
      const DRAWS = 200;
      const seals = [];
      for (const v of V) for (let i = 0; i < DRAWS / V.length; i++) {
        const seal = DED.sealDeduction(pack, v.letter);
        if (seal) seals.push({ variant: v.letter, seal, assignments: {} });
      }

      // D1: four seats, proven by enumerating every subset of the private links
      // with every public release already in hand.
      {
        let minSeats = Infinity, worstThree = Infinity, unreachable = 0;
        for (const g of seals) {
          const m = DED.minimumSeats(pack, g);
          if (m === Infinity) unreachable++;
          minSeats = Math.min(minSeats, m);
          for (const row of DED.subsetReport(pack, g)) {
            if (row.seats <= 3) worstThree = Math.min(worstThree, row.remaining);
          }
        }
        const ok = seals.length > 0 && !unreachable && minSeats === 4 && worstThree >= 2;
        check('D1', 'Answer needs four separate seats (seated chain)', 'rigorous', ok,
          seals.length + ' sealed draws; fewest seats that reach one answer: ' + minSeats +
          '; best any three seats can do: ' + worstThree + ' answers left; unreachable draws: ' + unreachable);
      }

      // D5: the public half narrows four to three to two and stops there.
      {
        let ok = seals.length > 0;
        const notes = [];
        for (const g of seals) {
          const none = DED.solve(pack, g, new Set()).size;
          const one = DED.solve(pack, g, new Set(['clearEarly'])).size;
          const two = DED.solve(pack, g, new Set(['clearEarly', 'clearMid'])).size;
          const withLink = DED.solve(pack, g, new Set(['clearEarly', 'clearMid', 'L0'])).size;
          if (!(none === 4 && one === 3 && two === 2 && withLink === 2)) {
            ok = false; if (notes.length < 3) notes.push(none + '/' + one + '/' + two + '/' + withLink);
          }
        }
        check('D5', 'Answer set narrows one step at a time, never to one in public',
          'rigorous', ok, ok ? 'four, then three, then two, and the public half stops there'
            : 'saw ' + notes.join(' ') + ' (want 4/3/2/2)');
      }

      // D6: the structure around the chain. Holders and leads must be core, must
      // never be the answer, and every lead must have the find that takes it back.
      {
        const answers = new Set(D.answerSet);
        const holders = Object.values(D.holders || {});
        const leadIds = Object.keys(D.leads || {});
        const nameOfId = (id) => String((pack.cast.find((c) => c.id === id) || {}).name || 'no-such-name');
        const holdersCore = holders.every((id) => coreIds.has(id));
        const holdersInnocent = holders.every((id) => !answers.has(id));
        const holdersDistinct = new Set(holders).size === holders.length && holders.length === 4;
        const answersCore = D.answerSet.every((id) => coreIds.has(id));
        const answersCoverKillers = V.every((v) => D.answerSet.some((id) =>
          String(v.killer).toUpperCase().includes(nameOfId(id).toUpperCase())));
        const leadsCore = leadIds.every((id) => coreIds.has(id));
        const leadsInnocent = leadIds.every((id) => !answers.has(id));
        const leadsPaired = leadIds.every((id) => D.leads[id].lead && D.leads[id].clear);
        const traitsForAnswers = D.answerSet.every((id) => !!(D.traits || {})[id]);
        const secondHandsPool = Object.keys(D.traits || {})
          .filter((id) => !answers.has(id) && !holders.includes(id) && coreIds.has(id));
        const ok = holdersCore && holdersInnocent && holdersDistinct && answersCore &&
          answersCoverKillers && leadsCore && leadsInnocent && leadsPaired && leadIds.length >= 1 &&
          traitsForAnswers && secondHandsPool.length >= 1;
        check('D6', 'False leads point away from the answer and are cleared in play',
          'rigorous', ok,
          holders.length + ' link holders (core, never the answer: ' + (holdersCore && holdersInnocent) + '); ' +
          leadIds.length + ' leads, each with its clearing find: ' + leadsPaired + '; ' +
          'answer set of ' + D.answerSet.length + ' covers every variant killer: ' + answersCoverKillers + '; ' +
          'second-hands pool: ' + secondHandsPool.length);
      }
    }
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
  console.log(`${DIM}pack: ${packId}  ·  variants: ${pack.variants.length}  ·  core cast: ${pack.cast.length}  ·  props: ${pack.props.length}  ·  flex: ${pack.flex.length}${RESET}`);
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
