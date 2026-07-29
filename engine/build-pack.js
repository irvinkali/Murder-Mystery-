#!/usr/bin/env node
'use strict';
/*
 * Build the structured story pack from the plot bible.
 *
 * SPOILER-SAFE: reads the radioactive bible, parses it in memory, serializes to
 * JSON, and writes ONLY a base64-encoded artifact (`pack.json.b64`) — the same
 * radioactive treatment as the bible. Plaintext JSON is never written to disk
 * and never printed. Output to the terminal is structural stats only.
 *
 * Usage: node engine/build-pack.js
 */

const fs = require('fs');
const path = require('path');
const { loadPack, md5, DEFAULT_BIBLE } = require('./lib/pack');

const OUT = path.join(__dirname, '..', 'packs', 'last-exhibit', 'pack.json.b64');

function main() {
  const pack = loadPack(DEFAULT_BIBLE);

  const structured = {
    schema: 'mystery-engine/pack@1',
    id: 'last-exhibit',
    generatedFrom: { checksum: pack.checksum, byteLength: pack.byteLength },
    victim: pack.victim,
    timeline: pack.timeline,
    cast: pack.cast,
    flex: pack.flex,
    props: pack.props,
    matrix: pack.matrix,
    variants: pack.variants,
    branching: pack.branching,
    fairnessRules: pack.fairnessRules,
  };

  // Serialize in memory only; emit base64 exclusively.
  const json = JSON.stringify(structured);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  // Wrap at 76 cols to match the bible's shape and keep diffs readable.
  const wrapped = b64.replace(/(.{76})/g, '$1\n');
  fs.writeFileSync(OUT, wrapped + '\n', 'utf8');

  // Structural stats only — no plot content.
  console.log('Built structured pack (encoded):');
  console.log('  path:            packs/last-exhibit/pack.json.b64');
  console.log('  source bible md5:', pack.checksum);
  console.log('  pack json md5:   ', md5(json));
  console.log('  cast:            ', pack.cast.length);
  console.log('  variants:        ', pack.variants.length);
  console.log('  props:           ', pack.props.length);
  console.log('  flex:            ', pack.flex.length);
  console.log('  encoded bytes:   ', Buffer.byteLength(wrapped, 'utf8'));
}

main();
