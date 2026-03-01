#!/usr/bin/env node
/**
 * dedupe.mjs
 * public/packs/*.json のfingerprint を計算し重複をレポートする。
 * meta/fingerprints.json を更新する。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const PACKS_DIR = join(import.meta.dirname, '..', 'public', 'packs');
const META_DIR = join(import.meta.dirname, '..', 'public', 'meta');

mkdirSync(META_DIR, { recursive: true });

function normalize(s) { return (s || '').trim().replace(/\s+/g, ' ').replace(/\r\n/g, '\n'); }

function computeFingerprint(q) {
  let raw = normalize(q.prompt);
  if (q.choices) raw += '|' + q.choices.map(normalize).join(',');
  if (q.left) raw += '|L:' + q.left.map(normalize).join(',');
  if (q.right) raw += '|R:' + q.right.map(normalize).join(',');
  if (q.items) raw += '|I:' + q.items.map(normalize).join(',');
  if (q.dropdowns) raw += '|D:' + q.dropdowns.map(d => d.options.map(normalize).join(',')).join(';');
  if (q.grid) raw += '|G:' + q.grid.cells.map(normalize).join(',');
  if (q.subQuestions) raw += '|SQ:' + q.subQuestions.map(sq => normalize(sq.prompt)).join(';');
  return createHash('sha256').update(raw).digest('hex');
}

const files = readdirSync(PACKS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
const fingerprints = {};
const duplicates = [];

for (const f of files) {
  try {
    const json = JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf-8'));
    if (json.schema !== 'ai900-pack-v1') continue;
    for (const q of json.questions) {
      const fp = computeFingerprint(q);
      const qid = `${json.pack.id}::${q.id}`;
      if (fingerprints[fp]) {
        duplicates.push({ fp, existing: fingerprints[fp], duplicate: qid });
      } else {
        fingerprints[fp] = qid;
      }
    }
  } catch (e) {
    console.warn(`Skipped ${f}: ${e.message}`);
  }
}

// Write fingerprints
const fpPath = join(META_DIR, 'fingerprints.json');
writeFileSync(fpPath, JSON.stringify(fingerprints, null, 2), 'utf-8');
console.log(`Wrote ${fpPath} (${Object.keys(fingerprints).length} entries)`);

if (duplicates.length > 0) {
  console.log(`\n=== ${duplicates.length} DUPLICATE(S) FOUND ===`);
  for (const d of duplicates) {
    console.log(`  ${d.duplicate} duplicates ${d.existing}`);
  }
  process.exit(1);
} else {
  console.log('\nNo duplicates found.');
}
