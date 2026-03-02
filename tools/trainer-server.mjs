#!/usr/bin/env node
/**
 * AI-900 Personal Trainer - Local Server
 *
 * Receives trigger from Cloudflare Tunnel, runs Opus/Sonnet analysis.
 * Zero polling. Only activates when user finishes a session.
 *
 * Usage:
 *   node tools/trainer-server.mjs          # Start server + tunnel
 *   node tools/trainer-server.mjs --local  # Server only (no tunnel, for testing)
 */

import http from 'http';
import { spawn, execSync } from 'child_process';
import { existsSync, appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 3900;
const APP_URL = 'https://ai900-pwa.pages.dev';
const LOG_DIR = join(ROOT, 'logs');

mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString().slice(5, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(join(LOG_DIR, 'trainer.log'), line + '\n');
}

// ---- State ----
let isRunning = false;
let tunnelUrl = null;

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ ok: true, running: isRunning, tunnel: tunnelUrl }));
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    if (isRunning) {
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ ok: true, status: 'already_running' }));
    }

    log('Trigger received! Starting trainer...');
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, status: 'started' }));

    // Run trainer asynchronously
    runTrainer();
    return;
  }

  res.writeHead(404, cors);
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---- Trainer Execution ----
async function runTrainer() {
  if (isRunning) return;
  isRunning = true;

  try {
    log('=== Trainer cycle started ===');

    // Step 1: Fetch learning data
    log('Fetching learning data...');
    const backupResp = await fetch(`${APP_URL}/api/backup`).then(r => r.json()).catch(() => null);
    if (!backupResp?.ok || !backupResp?.found || !backupResp.history?.length) {
      log('No learning data available. Skipping.');
      isRunning = false;
      return;
    }

    // Pre-compute stats
    const stats = computeStats(backupResp);
    log(`Stats: ${stats.totalAnswers} answers, ${stats.uniqueSeen} unique seen, ${stats.pool.total} pool, ${stats.pool.unseen} unseen`);

    // Step 2: Opus analysis + strategy
    log('Opus: Analyzing...');
    const strategy = await runClaude('opus', buildAnalysisPrompt(stats));
    if (!strategy) {
      log('Opus analysis failed.');
      isRunning = false;
      return;
    }

    // Upload strategy
    await fetch(`${APP_URL}/api/strategy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: strategy,
    }).catch(() => {});
    log(`Strategy uploaded. Coach: ${safeJsonField(strategy, 'coachMessage')}`);

    // Step 3: Sonnet session optimization
    log('Sonnet: Optimizing next session...');
    const allQids = getAllQids();
    const session = await runClaude('sonnet', buildSessionPrompt(strategy, stats, allQids));
    if (session) {
      await fetch(`${APP_URL}/api/next-session`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: session,
      }).catch(() => {});
      log(`Next session: ${safeJsonField(session, 'questions.length', 'count')} questions curated.`);
    } else {
      log('Sonnet session planning failed (non-critical).');
    }

    // Step 4: Question generation (if needed)
    const genNeeded = safeJsonField(strategy, 'generation.needed');
    const genCount = parseInt(safeJsonField(strategy, 'generation.count')) || 0;
    if (genNeeded === 'true' && genCount > 0) {
      log(`Generating ${genCount} new questions...`);
      await generateQuestions(strategy, genCount);
    }

    // Step 5: Mark analysis done
    await fetch(`${APP_URL}/api/status`, { method: 'PUT' }).catch(() => {});
    log('=== Trainer cycle complete ===');

  } catch (e) {
    log(`ERROR: ${e.message}`);
  } finally {
    isRunning = false;
  }
}

function computeStats(backup) {
  const h = backup.history || [];
  const sess = backup.sessions || [];
  const uniqueQids = new Set();
  const byDomain = {}, byType = {};
  const wrongQids = [];

  for (const r of h) {
    uniqueQids.add(r.qid);
    const d = r.domain || 'unknown', t = r.type || 'unknown';
    if (!byDomain[d]) byDomain[d] = { c: 0, t: 0 };
    if (!byType[t]) byType[t] = { c: 0, t: 0 };
    byDomain[d].t++; byType[t].t++;
    if (r.correct) { byDomain[d].c++; byType[t].c++; }
    else wrongQids.push(r.qid);
  }

  // Pool info from disk
  const pool = getPoolInfo(uniqueQids);

  return {
    sessionCount: sess.length,
    totalAnswers: h.length,
    uniqueSeen: uniqueQids.size,
    pool,
    accuracy: { byDomain, byType },
    wrongQids: [...new Set(wrongQids)].slice(-30),
  };
}

function getPoolInfo(seenQids) {
  const dir = join(ROOT, 'public', 'packs');
  let total = 0;
  const byDomain = {};
  const allQids = [];

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.questions) continue;
      for (const q of d.questions) {
        total++;
        const qid = d.pack.id + '::' + q.id;
        allQids.push(qid);
        byDomain[q.domain] = (byDomain[q.domain] || 0) + 1;
      }
    } catch {}
  }

  const unseen = allQids.filter(id => !seenQids.has(id)).length;
  return { total, byDomain, unseen, allQids };
}

function getAllQids() {
  const dir = join(ROOT, 'public', 'packs');
  const qids = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.questions) continue;
      for (const q of d.questions) {
        qids.push({ qid: d.pack.id + '::' + q.id, domain: q.domain, type: q.type, tags: q.tags || [] });
      }
    } catch {}
  }
  return JSON.stringify(qids);
}

// ---- Claude CLI wrapper ----
function runClaude(model, prompt) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--model', model, '-p', prompt], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      if (code !== 0) {
        log(`Claude ${model} exited with code ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      // Extract JSON
      let text = stdout;
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) text = fence[1];
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          JSON.parse(text.slice(start, end + 1)); // validate
          resolve(text.slice(start, end + 1));
        } catch {
          log(`JSON parse failed for ${model}`);
          resolve(null);
        }
      } else {
        log(`No JSON found in ${model} output`);
        resolve(null);
      }
    });

    child.on('error', (e) => {
      log(`Claude ${model} spawn error: ${e.message}`);
      resolve(null);
    });
  });
}

function safeJsonField(jsonStr, path, altPath) {
  try {
    const obj = JSON.parse(jsonStr);
    const keys = path.split('.');
    let v = obj;
    for (const k of keys) v = v?.[k];
    if (v === undefined && altPath) {
      v = obj;
      for (const k of altPath.split('.')) v = v?.[k];
    }
    return String(v ?? '');
  } catch { return ''; }
}

// ---- Prompt builders ----
function buildAnalysisPrompt(stats) {
  return `あなたはAI-900試験対策の専門AIコーチです。以下の学習統計を分析し、学習戦略をJSON形式で出力してください。JSONのみ出力。

■ 学習統計:
${JSON.stringify(stats, null, 2)}

■ 出力 (JSON):
{
  "analysis": {
    "overallAccuracy": (全体正答率%),
    "domainAccuracy": {"Workloads":%, "ML":%, "CV":%, "NLP":%, "GenAI":%},
    "typeAccuracy": {"single":%, "multi":%, "dropdown":%, "match":%, "order":%, "hotarea":%, "casestudy":%},
    "weakPoints": ["弱点の説明"],
    "strongPoints": ["強みの説明"],
    "trend": "improving|stable|declining",
    "readiness": (合格推定確率%)
  },
  "nextSession": {
    "domainWeights": {"Workloads":0-100, "ML":0-100, "CV":0-100, "NLP":0-100, "GenAI":0-100},
    "preferTypes": ["優先タイプ"],
    "targetDifficulty": 1-5,
    "unseenRatio": 0.0-1.0,
    "reviewQids": ["再出題すべきqid"],
    "sessionSize": 15-25
  },
  "generation": {
    "needed": true/false,
    "count": 0-50,
    "focusDomains": [],
    "focusTypes": [],
    "reason": ""
  },
  "coachMessage": "ユーザーへの具体的アドバイス（日本語2-3文）"
}`;
}

function buildSessionPrompt(strategyJson, stats, allQids) {
  return `あなたはAI-900出題最適化エンジンです。コーチの戦略に基づき最適な次回セッションをJSON配列で出力。

■ コーチの戦略:
${strategyJson}

■ 学習統計:
${JSON.stringify(stats, null, 2)}

■ 利用可能な問題:
${allQids}

■ 出力 (JSON):
{
  "questions": [
    {"qid": "packId::questionId", "reason": "unseen|weakness_drill|spaced_review|reinforcement"}
  ],
  "sessionType": "balanced|weakness_drill|review|exploration",
  "message": "今回のセッションの狙い（1文、日本語）"
}

ルール:
- nextSession.sessionSizeに従う
- unseenRatioに従い未解答問題を優先
- reviewQidsは必ず含める
- domainWeightsでドメイン配分を調整
- JSONのみ出力`;
}

// ---- Question Generation ----
async function generateQuestions(strategyJson, count) {
  count = Math.min(Math.max(count, 15), 50);
  const strat = JSON.parse(strategyJson);
  const focusDomains = (strat.generation?.focusDomains || ['Workloads', 'ML', 'CV', 'NLP', 'GenAI']).join(', ');
  const focusTypes = (strat.generation?.focusTypes || ['single', 'multi', 'dropdown']).join(', ');
  const reason = strat.generation?.reason || 'pool replenishment';

  const packId = `ai900.coach.${Date.now()}`;
  const packFile = join(ROOT, 'public', 'packs', `${packId}_${new Date().toISOString().slice(0, 10)}.json`);

  const prompt = `AI-900試験対策の問題パックJSONを生成。JSONのみ出力。フェンス不要。
生成計画: ${reason} / 重点: ${focusDomains} / タイプ: ${focusTypes} / ${count}問

フォーマット (schema: ai900-pack-v1):
{"schema":"ai900-pack-v1","pack":{"id":"${packId}","version":"${new Date().toISOString().slice(0, 10)}","title":"コーチ生成 (${count}問)","description":"AIコーチ自動生成","language":"ja-JP","createdAt":"${new Date().toISOString()}","domains":["Workloads","ML","CV","NLP","GenAI"]},"questions":[...]}

タイプ仕様: single(answer=[idx],choices=4), multi(answer=[idx,...],choices=4-6), dropdown(dropdowns=[{blank,options,answer}],prompt={{0}}), match(left,right,answerMap), order(items,answerOrder), hotarea(grid={cols,rows,cells},answer=[idx]), casestudy(scenario,subQuestions)
全問explanation付与、domain均等+弱点重み付け`;

  const result = await runClaude('opus', prompt);
  if (!result) { log('Question generation failed.'); return; }

  try {
    const parsed = JSON.parse(result);
    writeFileSync(packFile, JSON.stringify(parsed, null, 2));
    log(`Pack written: ${packFile} (${parsed.questions?.length} questions)`);

    // Validate
    execSync('node tools/validate_packs.mjs', { cwd: ROOT, stdio: 'pipe' });
    execSync('node tools/build_index.mjs', { cwd: ROOT, stdio: 'pipe' });
    execSync('node tools/dedupe.mjs', { cwd: ROOT, stdio: 'pipe' });

    // Commit and push
    execSync('git add public/packs/ public/meta/', { cwd: ROOT });
    execSync(`git commit -m "Coach: ${packId} (${count} questions)\n\n${reason}\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"`, { cwd: ROOT });
    execSync('git push origin master', { cwd: ROOT });
    execSync('npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true', { cwd: ROOT, timeout: 120000 });

    log(`Deployed: ${packId}`);
  } catch (e) {
    log(`Generation/deploy error: ${e.message}`);
    try { unlinkSync(packFile); } catch {}
  }
}

// ---- Cloudflare Tunnel ----
function startTunnel() {
  log('Starting Cloudflare Tunnel...');

  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  tunnel.stderr.on('data', (data) => {
    const line = data.toString();
    // Capture tunnel URL
    const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[1];
      log(`Tunnel URL: ${tunnelUrl}`);

      // Store tunnel URL in KV so Pages Function can reach us
      fetch(`${APP_URL}/api/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelUrl }),
      }).then(() => log('Tunnel URL stored in KV.'))
        .catch(() => log('Failed to store tunnel URL.'));
    }
  });

  tunnel.on('close', (code) => {
    log(`Tunnel exited (code ${code}). Restarting in 10s...`);
    tunnelUrl = null;
    setTimeout(startTunnel, 10000);
  });

  tunnel.on('error', (e) => {
    log(`Tunnel error: ${e.message}. Retrying in 10s...`);
    setTimeout(startTunnel, 10000);
  });
}

// ---- Start ----
server.listen(PORT, () => {
  log('==============================================');
  log(' AI-900 Personal Trainer Server');
  log(` Listening on http://localhost:${PORT}`);
  log('==============================================');

  if (!process.argv.includes('--local')) {
    startTunnel();
  } else {
    log('Local mode (no tunnel). Use --local for testing.');
  }
});
