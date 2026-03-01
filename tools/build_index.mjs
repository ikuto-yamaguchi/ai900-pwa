#!/usr/bin/env node
/**
 * build_index.mjs
 * public/packs/ を見て index.json を自動生成/更新する。
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PACKS_DIR = join(import.meta.dirname, '..', 'public', 'packs');

const files = readdirSync(PACKS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
const packs = [];

for (const f of files) {
  try {
    const json = JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf-8'));
    if (json.schema !== 'ai900-pack-v1' || !json.pack) continue;
    const p = json.pack;
    const types = [...new Set(json.questions.map(q => q.type))];
    packs.push({
      id: p.id,
      title: p.title,
      version: p.version,
      url: `/packs/${f}`,
      questionCount: json.questions.length,
      domains: p.domains || [],
      types,
      minAppVersion: '1.0.0'
    });
    console.log(`  Added: ${p.id} (${json.questions.length} questions)`);
  } catch (e) {
    console.warn(`  Skipped ${f}: ${e.message}`);
  }
}

const index = {
  schema: 'ai900-pack-index-v1',
  updatedAt: new Date().toISOString(),
  packs
};

const outPath = join(PACKS_DIR, 'index.json');
writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf-8');
console.log(`\nWrote ${outPath} (${packs.length} packs)`);
