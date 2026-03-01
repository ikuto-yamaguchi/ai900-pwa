#!/usr/bin/env node
/**
 * validate_packs.mjs
 * public/packs/*.json を走査し、スキーマ整合性を全検証する。
 * 失敗したら exit 1。
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PACKS_DIR = join(import.meta.dirname, '..', 'public', 'packs');
const DOMAINS = ['Workloads', 'ML', 'CV', 'NLP', 'GenAI'];
const TYPES = ['single', 'multi', 'dropdown', 'match', 'order', 'hotarea', 'casestudy'];

let totalErrors = 0;

function error(msg) {
  console.error(`  ERROR: ${msg}`);
  totalErrors++;
}

function validateQuestion(q, packId) {
  if (!q.id) { error('Missing question id'); return; }
  const prefix = `[${packId}::${q.id}]`;
  if (!q.type) { error(`${prefix} Missing type`); return; }
  if (!TYPES.includes(q.type)) error(`${prefix} Unknown type: ${q.type}`);
  if (!q.prompt) error(`${prefix} Missing prompt`);
  if (!q.domain) error(`${prefix} Missing domain`);
  if (q.domain && !DOMAINS.includes(q.domain)) error(`${prefix} Unknown domain: ${q.domain}`);

  switch (q.type) {
    case 'single':
    case 'multi':
      if (!Array.isArray(q.choices) || q.choices.length < 2) error(`${prefix} choices must have >=2 items`);
      if (!Array.isArray(q.answer)) { error(`${prefix} answer must be array`); break; }
      for (const a of q.answer) {
        if (a < 0 || a >= (q.choices || []).length) error(`${prefix} answer index ${a} out of range (choices: ${(q.choices||[]).length})`);
      }
      if (q.type === 'single' && q.answer.length !== 1) error(`${prefix} single must have exactly 1 answer`);
      if (q.type === 'multi' && q.answer.length < 2) error(`${prefix} multi should have >=2 answers`);
      break;
    case 'dropdown':
      if (!Array.isArray(q.dropdowns)) { error(`${prefix} Missing dropdowns`); break; }
      q.dropdowns.forEach((d, i) => {
        if (!Array.isArray(d.options) || d.options.length < 2) error(`${prefix} dropdown[${i}] needs >=2 options`);
        if (typeof d.answer !== 'number' || d.answer < 0 || d.answer >= (d.options || []).length) error(`${prefix} dropdown[${i}] answer out of range`);
        if (!q.prompt.includes(`{{${i}}}`)) error(`${prefix} prompt missing {{${i}}}`);
      });
      break;
    case 'match':
      if (!Array.isArray(q.left)) { error(`${prefix} Missing left`); break; }
      if (!Array.isArray(q.right)) { error(`${prefix} Missing right`); break; }
      if (!q.answerMap || typeof q.answerMap !== 'object') { error(`${prefix} Missing answerMap`); break; }
      for (const l of q.left) {
        if (!(l in q.answerMap)) error(`${prefix} answerMap missing key "${l}"`);
      }
      for (const v of Object.values(q.answerMap)) {
        if (!q.right.includes(v)) error(`${prefix} answerMap value "${v}" not in right`);
      }
      break;
    case 'order':
      if (!Array.isArray(q.items)) { error(`${prefix} Missing items`); break; }
      if (!Array.isArray(q.answerOrder)) { error(`${prefix} Missing answerOrder`); break; }
      if (q.answerOrder.length !== q.items.length) error(`${prefix} answerOrder length mismatch`);
      const sorted = [...q.answerOrder].sort((a, b) => a - b);
      const expected = q.items.map((_, i) => i);
      if (JSON.stringify(sorted) !== JSON.stringify(expected)) error(`${prefix} answerOrder indices invalid: got ${JSON.stringify(q.answerOrder)}`);
      break;
    case 'hotarea':
      if (!q.grid || !Array.isArray(q.grid.cells)) { error(`${prefix} Missing grid.cells`); break; }
      if (!Array.isArray(q.answer)) { error(`${prefix} Missing answer`); break; }
      for (const a of q.answer) {
        if (a < 0 || a >= q.grid.cells.length) error(`${prefix} hotarea answer ${a} out of range (cells: ${q.grid.cells.length})`);
      }
      if (typeof q.grid.cols !== 'number' || q.grid.cols < 1) error(`${prefix} grid.cols invalid`);
      if (typeof q.grid.rows !== 'number' || q.grid.rows < 1) error(`${prefix} grid.rows invalid`);
      if (q.grid.cells.length !== q.grid.cols * q.grid.rows) error(`${prefix} grid.cells length (${q.grid.cells.length}) != cols*rows (${q.grid.cols}*${q.grid.rows})`);
      break;
    case 'casestudy':
      if (!Array.isArray(q.subQuestions) || q.subQuestions.length === 0) { error(`${prefix} casestudy needs subQuestions`); break; }
      const subIds = new Set();
      for (const sq of q.subQuestions) {
        if (subIds.has(sq.id)) error(`${prefix} duplicate subQuestion id: ${sq.id}`);
        subIds.add(sq.id);
        validateQuestion({ ...sq, domain: q.domain }, packId);
      }
      break;
  }
}

function validatePack(filePath) {
  console.log(`\nValidating: ${filePath}`);
  let json;
  try {
    json = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    error(`Failed to parse JSON: ${e.message}`);
    return;
  }

  if (json.schema !== 'ai900-pack-v1') { error(`Invalid schema: ${json.schema}`); return; }
  if (!json.pack || !json.pack.id) { error('Missing pack.id'); return; }
  if (!Array.isArray(json.questions)) { error('Missing questions array'); return; }

  console.log(`  Pack: ${json.pack.id} (${json.pack.title})`);
  console.log(`  Questions: ${json.questions.length}`);

  const ids = new Set();
  for (const q of json.questions) {
    if (ids.has(q.id)) error(`Duplicate question id: ${q.id}`);
    ids.add(q.id);
    validateQuestion(q, json.pack.id);
  }

  // Stats
  const byType = {};
  const byDomain = {};
  for (const q of json.questions) {
    byType[q.type] = (byType[q.type] || 0) + 1;
    byDomain[q.domain] = (byDomain[q.domain] || 0) + 1;
  }
  console.log('  By type:', JSON.stringify(byType));
  console.log('  By domain:', JSON.stringify(byDomain));
}

// Also validate index.json
function validateIndex() {
  const indexPath = join(PACKS_DIR, 'index.json');
  console.log(`\nValidating index: ${indexPath}`);
  let json;
  try {
    json = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch (e) {
    error(`Failed to parse index.json: ${e.message}`);
    return;
  }
  if (json.schema !== 'ai900-pack-index-v1') { error(`Invalid index schema: ${json.schema}`); return; }
  if (!Array.isArray(json.packs)) { error('Missing packs array'); return; }
  console.log(`  Packs listed: ${json.packs.length}`);
  for (const p of json.packs) {
    if (!p.id || !p.version || !p.url) error(`Index entry missing required fields: ${JSON.stringify(p)}`);
  }
}

// Run
console.log('=== AI-900 Pack Validator ===');
validateIndex();

const files = readdirSync(PACKS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
for (const f of files) {
  validatePack(join(PACKS_DIR, f));
}

console.log(`\n=== Result: ${totalErrors} error(s) ===`);
process.exit(totalErrors > 0 ? 1 : 0);
