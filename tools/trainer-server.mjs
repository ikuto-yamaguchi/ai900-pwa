#!/usr/bin/env node
/**
 * AI-900 Personal Trainer - Local Server
 *
 * Receives trigger from Cloudflare Tunnel, runs Sonnet analysis + selection.
 * Zero polling. Only activates when user finishes a session.
 *
 * Architecture:
 *   Sonnet: stats + QID pool → analysis + strategy + 50 QID selection + coaching
 *   Server algorithm: validate Sonnet's selection (remove hallucinated QIDs, fill gaps)
 *   Opus: question generation only (when pool is running low)
 *
 * Usage:
 *   node tools/trainer-server.mjs          # Start server + tunnel
 *   node tools/trainer-server.mjs --local  # Server only (no tunnel, for testing)
 */

import http from 'http';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { existsSync, appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync, unlinkSync, renameSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import {
  EXAM_ID, EXAM_NAME, PACK_SCHEMA, ROOT, PORT, APP_URL, LOG_DIR,
  SESSION_SIZE, POOL_MAX_SIZE, DOMAINS, QUALITY_FILE, TAXONOMY_FILE,
  TRAINER_STATE_FILE, QUALITY_LOG_FILE
} from './exam-config.mjs';

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.error(`Failed to create log directory ${LOG_DIR}: ${e.message}`);
  process.exit(1);
}

// ---- Auth & Lock ----
const IS_LOCAL = process.argv.includes('--local');
const TRAINER_SECRET = process.env.TRAINER_SECRET || '';
const LOCK_FILE = join(LOG_DIR, 'trainer.lock');

function log(msg) {
  const line = `[${new Date().toISOString().slice(5, 19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(join(LOG_DIR, 'trainer.log'), line + '\n'); } catch (e) { console.error('log write failed:', e.message); }
}

let lockToken = null;

function acquireLock() {
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx', 0o600); // O_CREAT | O_EXCL — atomic create, owner-only
    const token = `${process.pid}:${Date.now()}`;
    writeSync(fd, token);
    closeSync(fd);
    fd = undefined;
    lockToken = token;
    return true;
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    // Only attempt stale lock recovery on EEXIST (lock file already exists)
    if (err?.code !== 'EEXIST') {
      log(`acquireLock unexpected error: ${err?.code || err?.message}`);
      return false;
    }
    // Check for stale lock (dead process)
    try {
      const content = readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(content.split(':')[0], 10);
      if (pid && !isProcessAlive(pid)) {
        log(`Removing stale lock (PID ${pid} is dead)`);
        unlinkSync(LOCK_FILE);
        // Retry once
        let fd2;
        try {
          fd2 = openSync(LOCK_FILE, 'wx', 0o600);
          const token = `${process.pid}:${Date.now()}`;
          writeSync(fd2, token);
          closeSync(fd2);
          fd2 = undefined;
          lockToken = token;
          return true;
        } catch {
          if (fd2 !== undefined) try { closeSync(fd2); } catch {}
        }
      }
    } catch { /* lock is held by live process or unreadable */ }
    return false;
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

function releaseLock() {
  if (!lockToken) return; // Never acquired — don't touch lock file
  try {
    const content = readFileSync(LOCK_FILE, 'utf8').trim();
    if (content !== lockToken) {
      log('releaseLock: lock owned by another process, skipping');
      lockToken = null;
      return;
    }
    unlinkSync(LOCK_FILE);
  } catch (e) {
    if (e?.code !== 'ENOENT') log('releaseLock failed: ' + e.message);
  }
  lockToken = null;
}

// ---- State ----
let isRunning = false;
let shuttingDown = false;
let tunnelUrl = null;
let lastJobResult = null;
let tunnelRetryDelay = 10000;
let tunnelRestarting = false;
let tunnelRestartTimer = null;
const MAX_TUNNEL_RETRY = 300000; // 5 min

// ---- Helpers ----
function safeCompare(a, b) {
  // Reject arrays and non-strings outright (Node can send duplicate headers as array)
  if (typeof a !== 'string' || a.length > 4096) return false;
  if (typeof b !== 'string' || b.length > 4096) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': APP_URL, 'Vary': 'Origin', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ ok: true, running: isRunning, tunnel: tunnelUrl, lastJob: lastJobResult }));
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    // Auth required unless --local mode
    if (!IS_LOCAL) {
      if (!TRAINER_SECRET) {
        req.resume();
        res.writeHead(503, cors);
        return res.end(JSON.stringify({ error: 'TRAINER_SECRET not configured' }));
      }
      if (!safeCompare(req.headers['authorization'], `Bearer ${TRAINER_SECRET}`)) {
        req.resume();
        res.writeHead(401, cors);
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    req.resume(); // Drain request body after auth to prevent backpressure

    if (isRunning) {
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ ok: true, status: 'already_running' }));
    }

    // Acquire lock before responding to avoid started-but-locked scenario
    if (!acquireLock()) {
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ ok: true, status: 'locked' }));
    }

    isRunning = true; // Set before responding to close race window
    log('Trigger received! Starting trainer...');
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, status: 'started' }));

    runTrainer().catch(e => { log(`runTrainer unhandled: ${e.message}`); isRunning = false; releaseLock(); });
    return;
  }

  res.writeHead(404, cors);
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---- Trainer Execution ----
async function runTrainer() {
  // isRunning already set by /trigger handler; guard against direct calls
  if (!lockToken) { log('runTrainer called without lock, aborting'); return; }
  lastJobResult = { status: 'running', startedAt: new Date().toISOString() };

  try {
    log('=== Trainer cycle started ===');

    // Step 1: Fetch learning data
    log('Fetching learning data...');
    const backupResp = await fetchWithTimeout(`${APP_URL}/api/backup`).then(r => {
      if (!r.ok) { log(`Backup fetch HTTP ${r.status}`); return null; }
      return r.json();
    }).catch(e => { log('Backup fetch failed: ' + e.message); return null; });
    if (!backupResp?.ok || !backupResp?.found || !backupResp.history?.length) {
      log('No learning data available. Skipping.');
      lastJobResult = { status: 'skipped', reason: 'no_data', completedAt: new Date().toISOString() };
      return;
    }

    // Step 2: Compute stats + load pool
    const stats = computeStats(backupResp);
    const poolMeta = getPoolMetadata();
    const validQidSet = new Set(poolMeta.map(q => q.qid));
    log(`Stats: ${stats.totalAnswers} answers, ${stats.uniqueSeen} unique seen, ${poolMeta.length} pool, ${stats.pool.unseen} unseen`);

    // Step 3: Sonnet — analysis + strategy + 50 QID selection
    log('Sonnet: Analyzing + selecting...');
    const sonnetResult = await runClaude('sonnet', buildUnifiedPrompt(stats, poolMeta));

    let sessionQuestions = [];
    let strategy = null;

    if (sonnetResult) {
      try {
        strategy = JSON.parse(sonnetResult);
      } catch { strategy = null; }
    }

    if (strategy?.questions?.length > 0) {
      // Validate Sonnet's QID selections against actual pool
      sessionQuestions = validateAndFill(strategy.questions, poolMeta, validQidSet, stats);
      log(`Sonnet selected ${strategy.questions.length} → validated to ${sessionQuestions.length} questions`);
    }

    // If Sonnet failed or returned too few, fill entirely with algorithm
    if (sessionQuestions.length < SESSION_SIZE) {
      log(`Sonnet insufficient (${sessionQuestions.length}). Algorithmic fill to ${SESSION_SIZE}.`);
      sessionQuestions = algorithmicSelect(poolMeta, stats, SESSION_SIZE);
    }

    // Upload strategy (for UI display)
    if (strategy?.analysis) {
      const stratResp = await fetchWithTimeout(`${APP_URL}/api/strategy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis: strategy.analysis,
          coachMessage: strategy.coachMessage || '',
        }),
      }).catch(e => { log('Strategy upload failed: ' + e.message); return null; });
      if (stratResp && !stratResp.ok) log(`Strategy upload HTTP ${stratResp.status}`);
      log(`Strategy uploaded. Coach: ${(strategy.coachMessage || '').slice(0, 80)}`);
    }

    // Upload session
    const sessionPayload = JSON.stringify({
      questions: sessionQuestions.map(qid => ({ qid, reason: 'ai_selected' })),
      sessionType: strategy?.sessionType || 'balanced',
      message: strategy?.message || '',
    });
    const sessResp = await fetchWithTimeout(`${APP_URL}/api/next-session`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: sessionPayload,
    }).catch(e => { log('Session upload failed: ' + e.message); return null; });
    if (sessResp && !sessResp.ok) log(`Session upload HTTP ${sessResp.status}`);
    log(`Next session uploaded: ${sessionQuestions.length} questions`);

    // Step 4: Quality evaluation pipeline
    const trainerState = loadTrainerState();
    trainerState.cycleCount = (trainerState.cycleCount || 0) + 1;
    const userFlags = await fetchUserFlags();
    const shouldEval = trainerState.cycleCount % 5 === 0 || userFlags.length > 0 || !trainerState.lastEvalAt;
    const allQuestionsFlat = getAllQuestionsFlat(); // Load once, reuse
    if (shouldEval) {
      log('Running quality evaluation...');
      await runQualityEvaluation(poolMeta, userFlags, trainerState, allQuestionsFlat);
    }

    // Step 5: Repair pipeline (if quality issues found)
    const qualityData = loadQualityFile();
    const needsRepair = Object.entries(qualityData.questions || {})
      .filter(([, q]) => q && typeof q === 'object' && (q.quality_state === 'needs_review' || q.quality_state === 'invalid'))
      .slice(0, 5); // max 5 per cycle
    if (needsRepair.length > 0) {
      log(`Repair pipeline: ${needsRepair.length} questions to repair...`);
      await runRepairPipeline(needsRepair, qualityData, allQuestionsFlat);
    }

    // Step 6: Question generation (code-side quantitative trigger, subtopic-aware)
    if (shouldGenerateQuestions(stats, poolMeta.length)) {
      const focusDomains = findStarvedDomains(stats);
      const subtopicGaps = findSubtopicGaps(qualityData);
      log(`Generating questions for domains: ${focusDomains.join(', ')}...`);
      await generateQuestions(focusDomains, stats, subtopicGaps);
    }

    saveTrainerState(trainerState);

    // Step 7: Mark analysis done
    await fetchWithTimeout(`${APP_URL}/api/status`, { method: 'PUT' }).then(r => {
      if (!r.ok) log(`Status update HTTP ${r.status}`);
    }).catch(e => log('Status update failed: ' + e.message));
    lastJobResult = { status: 'complete', completedAt: new Date().toISOString() };
    log('=== Trainer cycle complete ===');

  } catch (e) {
    log(`ERROR: ${e.message}`);
    lastJobResult = { status: 'error', error: e.message, completedAt: new Date().toISOString() };
  } finally {
    isRunning = false;
    releaseLock();
  }
}

// ---- Stats computation ----
function computeStats(backup) {
  const h = backup.history || [];
  const sess = backup.sessions || [];
  const uniqueQids = new Set();
  const byDomain = {}, byType = {};
  const wrongQids = [];
  const qidStats = {};

  for (const r of h) {
    if (!r || typeof r !== 'object' || typeof r.qid !== 'string') continue;
    uniqueQids.add(r.qid);
    const d = typeof r.domain === 'string' ? r.domain : 'unknown';
    const t = typeof r.type === 'string' ? r.type : 'unknown';
    if (!byDomain[d]) byDomain[d] = { c: 0, t: 0 };
    if (!byType[t]) byType[t] = { c: 0, t: 0 };
    byDomain[d].t++; byType[t].t++;
    if (r.correct) { byDomain[d].c++; byType[t].c++; }
    else wrongQids.push(r.qid);

    // Per-QID stats (bounded by pool size, not history size)
    if (!qidStats[r.qid]) qidStats[r.qid] = { c: 0, t: 0 };
    qidStats[r.qid].t++;
    if (r.correct) qidStats[r.qid].c++;
  }

  const pool = getPoolInfo(uniqueQids);

  return {
    sessionCount: sess.length,
    totalAnswers: h.length,
    uniqueSeen: uniqueQids.size,
    pool,
    accuracy: { byDomain, byType },
    wrongQids: [...new Set(wrongQids)].slice(-50),
    qidStats,
  };
}

function getPoolInfo(seenQids) {
  const dir = join(ROOT, 'public', 'packs');
  if (!existsSync(dir)) return { total: 0, byDomain: {}, unseen: 0 };
  let total = 0;
  const byDomain = {};

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.questions || !d.pack?.id) continue;
      for (const q of d.questions) {
        if (!q || typeof q.id !== 'string') continue;
        total++;
        const qid = d.pack.id + '::' + q.id;
        const domain = typeof q.domain === 'string' ? q.domain : 'unknown';
        if (!byDomain[domain]) byDomain[domain] = { total: 0, unseen: 0 };
        byDomain[domain].total++;
        if (!seenQids.has(qid)) byDomain[domain].unseen++;
      }
    } catch (e) { log(`getPoolInfo error reading ${f}: ${e.message}`); }
  }

  let unseen = 0;
  for (const d of Object.values(byDomain)) unseen += d.unseen;
  return { total, byDomain, unseen };
}

function getPoolMetadata() {
  const dir = join(ROOT, 'public', 'packs');
  if (!existsSync(dir)) return [];
  const pool = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.questions || !d.pack?.id) continue;
      for (const q of d.questions) {
        if (!q || typeof q.id !== 'string') continue;
        pool.push({
          qid: d.pack.id + '::' + q.id,
          domain: typeof q.domain === 'string' ? q.domain : 'unknown',
          type: typeof q.type === 'string' ? q.type : 'unknown',
          tags: Array.isArray(q.tags) ? q.tags : [],
        });
      }
    } catch (e) { log(`getPoolMetadata error reading ${f}: ${e.message}`); }
  }
  return pool;
}

// ---- Validate Sonnet selections + fill gaps ----
function validateAndFill(aiQuestions, poolMeta, validQidSet, stats) {
  const selected = [];
  const selectedSet = new Set();

  // Keep valid AI selections
  for (const item of aiQuestions) {
    const qid = (item && typeof item === 'object') ? item.qid : item;
    if (typeof qid !== 'string') continue;
    if (validQidSet.has(qid) && !selectedSet.has(qid)) {
      selected.push(qid);
      selectedSet.add(qid);
    }
  }

  if (selected.length >= SESSION_SIZE) return selected.slice(0, SESSION_SIZE);

  // Fill remaining with algorithmic scoring
  const remaining = SESSION_SIZE - selected.length;
  const candidates = poolMeta
    .filter(q => !selectedSet.has(q.qid))
    .map(q => ({ ...q, score: scoreQuestion(q, stats) }))
    .sort((a, b) => b.score - a.score);

  for (let i = 0; i < remaining && i < candidates.length; i++) {
    selected.push(candidates[i].qid);
  }

  return selected;
}

// ---- Pure algorithmic selection (fallback) ----
function algorithmicSelect(poolMeta, stats, count) {
  const scored = poolMeta
    .map(q => ({ ...q, score: scoreQuestion(q, stats) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, count).map(q => q.qid);
}

function scoreQuestion(q, stats) {
  let score = 1 + Math.random() * 0.3;

  // Unseen bonus
  const qs = stats.qidStats[q.qid];
  if (!qs) {
    score += 5; // Never seen
  } else {
    const accuracy = qs.c / qs.t;
    score += (1 - accuracy) * 3; // Lower accuracy = higher priority
    if (accuracy < 0.5) score += 2; // Extra boost for frequently wrong
  }

  // Domain weakness
  const ds = stats.accuracy.byDomain[q.domain];
  if (ds && ds.t > 0) {
    score += (1 - ds.c / ds.t) * 2;
  }

  // Type weakness
  const ts = stats.accuracy.byType[q.type];
  if (ts && ts.t > 0) {
    score += (1 - ts.c / ts.t) * 2;
  }

  return score;
}

// ---- Question generation trigger (quantitative) ----
function shouldGenerateQuestions(stats, poolSize) {
  if (poolSize >= POOL_MAX_SIZE) return false;
  // Unseen running low (< 2 sessions worth)
  if (stats.pool.unseen < SESSION_SIZE * 2) return true;
  // Any domain has < 10 unseen
  for (const d of Object.values(stats.pool.byDomain)) {
    if (d.unseen < 10) return true;
  }
  return false;
}

function findStarvedDomains(stats) {
  const starved = [];
  for (const [domain, d] of Object.entries(stats.pool.byDomain)) {
    if (d.unseen < 10) starved.push(domain);
  }
  return starved.length > 0 ? starved : DOMAINS;
}

// ---- Claude CLI wrapper (no shell, direct spawn, manual timeout) ----
function runClaude(model, prompt) {
  const TIMEOUT_MS = 600000; // 10 min
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    let child;
    try {
      child = spawn('claude', ['--model', model, '-p', '-'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      });
    } catch (e) {
      log(`Claude ${model} spawn failed: ${e.message}`);
      done(null);
      return;
    }

    // Manual timeout (spawn's timeout option is not reliable)
    const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB cap
    let outputCapKilled = false;
    const killOnCap = () => {
      if (!outputCapKilled) {
        outputCapKilled = true;
        log(`Claude ${model} output exceeded ${MAX_OUTPUT} bytes, killing`);
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        done(null);
      }
    };
    const timer = setTimeout(() => {
      log(`Claude ${model} timed out after ${TIMEOUT_MS / 1000}s, killing`);
      try { child.stdin.destroy(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      child.removeAllListeners();
      child.unref();
      done(null);
    }, TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    child.stdout.on('data', d => {
      if (stdoutLen >= MAX_OUTPUT) { killOnCap(); return; }
      const s = d.toString();
      const remaining = MAX_OUTPUT - stdoutLen;
      stdout += s.length <= remaining ? s : s.slice(0, remaining);
      stdoutLen += s.length;
      if (stdoutLen >= MAX_OUTPUT) killOnCap();
    });
    child.stderr.on('data', d => {
      if (stderrLen >= MAX_OUTPUT) { killOnCap(); return; }
      const s = d.toString();
      const remaining = MAX_OUTPUT - stderrLen;
      stderr += s.length <= remaining ? s : s.slice(0, remaining);
      stderrLen += s.length;
      if (stderrLen >= MAX_OUTPUT) killOnCap();
    });

    // Pipe prompt via stdin (no temp file, no shell)
    child.stdin.on('error', () => {}); // Prevent EPIPE crash
    try { child.stdin.write(prompt); child.stdin.end(); } catch {
      log(`Claude ${model} stdin write failed`);
      try { child.kill('SIGKILL'); } catch {}
      clearTimeout(timer);
      done(null);
      return;
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log(`Claude ${model} exited with code ${code}: ${stderr.slice(0, 200)}`);
        done(null);
        return;
      }

      let text = stdout;
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) text = fence[1];
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          JSON.parse(text.slice(start, end + 1));
          done(text.slice(start, end + 1));
        } catch {
          log(`JSON parse failed for ${model}`);
          done(null);
        }
      } else {
        log(`No JSON found in ${model} output`);
        done(null);
      }
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      log(`Claude ${model} spawn error: ${e.message}`);
      done(null);
    });
  });
}

// ---- Unified Sonnet prompt ----
function buildUnifiedPrompt(stats, poolMeta) {
  // Compact per-QID history: "qid:correct/total" (sorted by error rate desc, cap to 500)
  const qidHistory = Object.entries(stats.qidStats)
    .sort(([, a], [, b]) => (a.c / a.t) - (b.c / b.t)) // Worst accuracy first
    .slice(0, 500)
    .map(([q, s]) => `${q}:${s.c}/${s.t}`);

  // Compact pool: "qid|domain|type" (tags omitted to save tokens, capped for token safety)
  const poolForPrompt = poolMeta.length > POOL_MAX_SIZE ? poolMeta.slice(0, POOL_MAX_SIZE) : poolMeta;
  const poolCompact = poolForPrompt.map(q => `${q.qid}|${q.domain}|${q.type}`);

  return `あなたは${EXAM_NAME}試験対策の専門AIトレーナーです。学習統計と問題プールを分析し、次回セッション${SESSION_SIZE}問を選定してください。JSONのみ出力。

■ 学習統計:
セッション${stats.sessionCount}回, 総解答${stats.totalAnswers}, 解答済${stats.uniqueSeen}問, 未出題${stats.pool.unseen}問
ドメイン別(正答/解答): ${Object.entries(stats.accuracy.byDomain).map(([d,v]) => `${d}:${v.c}/${v.t}`).join(', ')}
タイプ別(正答/解答): ${Object.entries(stats.accuracy.byType).map(([t,v]) => `${t}:${v.c}/${v.t}`).join(', ')}
誤答QID: ${stats.wrongQids.join(', ')}
QID別成績: ${qidHistory.join(', ')}

■ 問題プール (qid|domain|type, ${poolForPrompt.length}問):
${poolCompact.join('\n')}

■ 出力JSON:
{"analysis":{"overallAccuracy":数値,"domainAccuracy":{"Responsible":数値,...},"typeAccuracy":{"single":数値,...},"weakPoints":["..."],"readiness":数値},"questions":[{"qid":"上のプールに実在するqid","reason":"unseen|weakness_drill|spaced_review|reinforcement"}],"sessionType":"balanced|weakness_drill|review|exploration","message":"セッションの狙い1文","coachMessage":"アドバイス2-3文"}

ルール:
- questionsは必ず${SESSION_SIZE}問。プール内の実在qidのみ使用
- 誤答QIDをspaced_reviewとして優先含める
- 未出題を60-70%含める
- 弱点ドメイン・タイプを重めに
- JSONのみ出力`;
}

// ---- Question Generation ----
async function generateQuestions(focusDomains, stats, subtopicGaps = []) {
  const count = 20;
  const packId = `${EXAM_ID}.coach.${Date.now()}`;
  const packFile = join(ROOT, 'public', 'packs', `${packId}_${new Date().toISOString().slice(0, 10)}.json`);

  const gapInfo = subtopicGaps.length > 0
    ? `\n特に以下のサブトピックでカバレッジが不足: ${subtopicGaps.join(', ')}`
    : '';

  const prompt = `${EXAM_NAME}試験対策の問題パックJSONを生成。JSONのみ出力。フェンス不要。
生成: ${focusDomains.join(', ')}ドメイン重点 / ${count}問${gapInfo}

フォーマット (schema: ${PACK_SCHEMA}):
{"schema":"${PACK_SCHEMA}","pack":{"id":"${packId}","version":"${new Date().toISOString().slice(0, 10)}","title":"コーチ生成 (${count}問)","description":"AIコーチ自動生成","language":"ja-JP","createdAt":"${new Date().toISOString()}","domains":${JSON.stringify(DOMAINS)}},"questions":[...]}

タイプ仕様: single(answer=[idx],choices=4), multi(answer=[idx,...],choices=4-6), dropdown(dropdowns=[{blank,options,answer}],prompt={{0}}), match(left,right,answerMap), order(items,answerOrder), hotarea(grid={cols,rows,cells},answer=[idx]), casestudy(scenario,subQuestions)
全問explanation付与、重点ドメイン: ${focusDomains.join(', ')}`;

  const result = await runClaude('opus', prompt);
  if (!result) { log('Question generation failed.'); return; }

  try {
    const parsed = JSON.parse(result);

    // Validate generated pack structure
    if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      log('Generated pack has no valid questions array');
      return;
    }
    // Force correct pack id (don't trust LLM)
    if (!parsed.pack || parsed.pack.id !== packId) {
      log(`Pack id mismatch, forcing correct id`);
      parsed.pack = { ...(parsed.pack || {}), id: packId };
    }
    // Check unique question ids
    const qids = new Set(parsed.questions.map(q => q.id));
    if (qids.size < parsed.questions.length) {
      log(`Warning: ${parsed.questions.length - qids.size} duplicate question ids in generated pack`);
    }

    const tmpPackFile = packFile + '.tmp';
    writeFileSync(tmpPackFile, JSON.stringify(parsed, null, 2), { mode: 0o644 });
    renameSync(tmpPackFile, packFile);
    log(`Pack written: ${packFile} (${parsed.questions.length} questions)`);

    execFileSync('node', ['tools/validate_packs.mjs'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
    execFileSync('node', ['tools/build_index.mjs'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
    execFileSync('node', ['tools/dedupe.mjs'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });

    execFileSync('git', ['add', 'public/packs/', 'public/meta/'], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
    // Check if there are staged changes before committing
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT, stdio: 'pipe', timeout: 10000 });
      log('No changes staged after generation, skipping commit/deploy.');
    } catch {
      // Changes exist — commit and deploy
      const commitMsg = `Coach: ${packId} (${parsed.questions.length} questions)\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;
      execFileSync('git', ['commit', '-m', commitMsg], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
      execFileSync('npx', ['wrangler', 'pages', 'deploy', 'public', '--project-name', `${EXAM_ID}-pwa`, '--commit-dirty=true'], { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
      log(`Deployed: ${packId}`);
    }
  } catch (e) {
    log(`Generation/deploy error: ${e.message}`);
    if (e.stderr) log(`  stderr: ${e.stderr.toString().slice(0, 500)}`);
    if (e.stdout) log(`  stdout: ${e.stdout.toString().slice(0, 500)}`);
    try { unlinkSync(packFile); } catch {}
    try { unlinkSync(packFile + '.tmp'); } catch {}
    // Restore tracked file changes to prevent dirty state
    try { execFileSync('git', ['checkout', '--', 'public/packs/', 'public/meta/'], { cwd: ROOT, stdio: 'pipe', timeout: 30000 }); } catch {}
    // Remove any untracked files left by the failed generation (e.g., new pack file after rename)
    try { execFileSync('git', ['clean', '-f', 'public/packs/', 'public/meta/'], { cwd: ROOT, stdio: 'pipe', timeout: 30000 }); } catch {}
  }
}

// ---- Trainer State Persistence ----
function loadTrainerState() {
  try {
    if (existsSync(TRAINER_STATE_FILE)) return JSON.parse(readFileSync(TRAINER_STATE_FILE, 'utf8'));
  } catch (e) { log('loadTrainerState error: ' + e.message); }
  return { cycleCount: 0, lastEvalAt: null };
}
function saveTrainerState(state) {
  const tmpFile = TRAINER_STATE_FILE + '.tmp';
  try {
    writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpFile, TRAINER_STATE_FILE);
  } catch (e) {
    try { unlinkSync(tmpFile); } catch {}
    throw e;
  }
}

// ---- Quality File I/O ----
function loadQualityFile() {
  let data;
  try {
    if (existsSync(QUALITY_FILE)) data = JSON.parse(readFileSync(QUALITY_FILE, 'utf8'));
  } catch (e) { log('loadQualityFile error: ' + e.message); }
  if (!data || typeof data !== 'object') data = {};
  if (!data.questions || typeof data.questions !== 'object' || Array.isArray(data.questions)) {
    data.questions = {};
  }
  // Normalize: drop non-object entries, ensure issues is always an array
  for (const [key, val] of Object.entries(data.questions)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      delete data.questions[key];
      continue;
    }
    if (!Array.isArray(val.issues)) val.issues = [];
  }
  data.schema = data.schema || 'quality-metadata-v1';
  return data;
}
async function saveQualityFile(data) {
  data.updatedAt = new Date().toISOString();
  const json = JSON.stringify(data, null, 2);
  const tmpFile = QUALITY_FILE + '.tmp';
  try {
    writeFileSync(tmpFile, json, { mode: 0o600 });
    renameSync(tmpFile, QUALITY_FILE);
  } catch (e) {
    try { unlinkSync(tmpFile); } catch {}
    log(`saveQualityFile failed: ${e.message}`);
    return; // Degrade gracefully — skip KV upload too
  }
  // Upload to KV (awaited for consistency)
  const qResp = await fetchWithTimeout(`${APP_URL}/api/quality`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  }).catch(e => { log('Quality KV upload failed: ' + e.message); return null; });
  if (qResp && !qResp.ok) log(`Quality KV upload HTTP ${qResp.status}`);
}

function qualityLog(msg) {
  try { appendFileSync(QUALITY_LOG_FILE, `[${new Date().toISOString().slice(5, 19)}] ${msg}\n`); } catch (e) { console.error('qualityLog write failed:', e.message); }
}

// ---- Fetch User Flags ----
async function fetchUserFlags() {
  try {
    const res = await fetchWithTimeout(`${APP_URL}/api/flags`);
    if (!res.ok) { log(`fetchUserFlags HTTP ${res.status}`); return []; }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.flags)) return [];
    // Validate and cap flags
    return data.flags
      .filter(f => f && typeof f === 'object' && typeof f.qid === 'string' && f.qid.length <= 200)
      .map(f => ({ qid: f.qid, reason: typeof f.reason === 'string' ? f.reason.slice(0, 500) : 'unknown' }))
      .slice(0, 100);
  } catch (e) { log('fetchUserFlags error: ' + e.message); return []; }
}

// ---- Static Quality Checks ----
function runStaticChecks(questions) {
  const issues = [];
  for (const { qid, packId, q } of questions) {
    const qIssues = [];

    // Explanation check
    if (typeof q.explanation !== 'string' || q.explanation.length < 20) {
      qIssues.push({ type: 'missing_explanation', severity: 'major', detail: 'explanation欠如または20文字未満' });
    }

    // Sources check
    if (!q.sources || !Array.isArray(q.sources) || q.sources.length === 0) {
      qIssues.push({ type: 'missing_sources', severity: 'minor', detail: '参照URLなし' });
    }

    // Difficulty check
    if (q.difficulty !== undefined && (q.difficulty < 1 || q.difficulty > 3)) {
      qIssues.push({ type: 'invalid_difficulty', severity: 'minor', detail: `difficulty=${q.difficulty} (範囲外)` });
    }

    // Tags check
    if (!q.tags || !Array.isArray(q.tags) || q.tags.length === 0) {
      qIssues.push({ type: 'missing_tags', severity: 'minor', detail: 'タグなし' });
    }

    // Prompt too short
    if (typeof q.prompt !== 'string' || q.prompt.length < 20) {
      qIssues.push({ type: 'short_prompt', severity: 'major', detail: 'prompt短すぎ(20文字未満)' });
    }

    // Duplicate choices (single/multi)
    if ((q.type === 'single' || q.type === 'multi') && Array.isArray(q.choices)) {
      const unique = new Set(q.choices.map(c => (typeof c === 'string' ? c : String(c)).trim().toLowerCase()));
      if (unique.size < q.choices.length) {
        qIssues.push({ type: 'duplicate_choices', severity: 'critical', detail: '重複する選択肢あり' });
      }
    }

    // Answer consistency
    if ((q.type === 'single' || q.type === 'multi') && Array.isArray(q.answer) && Array.isArray(q.choices)) {
      for (const a of q.answer) {
        if (!Number.isInteger(a) || a < 0 || a >= q.choices.length) {
          qIssues.push({ type: 'invalid_answer', severity: 'critical', detail: `answer index ${a} invalid (not integer or out of range)` });
        }
      }
    }

    if (qIssues.length > 0) {
      issues.push({ qid, issues: qIssues });
    }
  }
  return issues;
}

// ---- Sonnet Red-Team Evaluation ----
async function runSemanticEval(batch) {
  const qSummaries = batch.map(({ qid, q }) => {
    const prompt = typeof q.prompt === 'string' ? q.prompt.slice(0, 1000) : '';
    let summary = `QID: ${qid}\nType: ${q.type}\nPrompt: ${prompt}`;
    if (Array.isArray(q.choices)) summary += `\nChoices: ${q.choices.slice(0, 10).map((c, i) => `${i}:${String(c).slice(0, 200)}`).join(', ')}`;
    if (q.answer) summary += `\nAnswer: ${JSON.stringify(q.answer).slice(0, 200)}`;
    if (typeof q.explanation === 'string') summary += `\nExplanation: ${q.explanation.slice(0, 300)}`;
    return summary;
  }).join('\n---\n');

  const prompt = `あなたは${EXAM_NAME}試験の品質レッドチーム評価者です。以下の問題を厳しく評価してください。

評価観点:
1. 正答が本当に正しいか（別解が成立しないか検証）
2. 公式ドキュメントとの整合性
3. 選択肢の質（弱すぎるdistractorがないか）
4. 試験スコープ内か
5. 曖昧さや誤解を招く表現がないか

問題（${batch.length}問）:
${qSummaries}

出力JSON（フェンス不要）:
{"evaluations":[{"qid":"...","verdict":"ok|needs_review|invalid","issues":[{"type":"wrong_answer|ambiguous|poor_distractors|out_of_scope|inaccurate_explanation|outdated","severity":"critical|major|minor","detail":"...","suggestedFix":"..."}]}]}`;

  const result = await runClaude('sonnet', prompt);
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    // Validate expected structure
    if (!parsed.evaluations || !Array.isArray(parsed.evaluations)) {
      log('Semantic eval: missing or non-array evaluations field');
      return null;
    }
    const validVerdicts = new Set(['ok', 'needs_review', 'invalid']);
    for (const ev of parsed.evaluations) {
      if (typeof ev.qid !== 'string' || !validVerdicts.has(ev.verdict)) {
        log(`Semantic eval: invalid evaluation entry (qid=${ev.qid}, verdict=${ev.verdict})`);
        return null;
      }
    }
    return parsed;
  } catch { return null; }
}

// ---- Quality Evaluation Orchestrator ----
async function runQualityEvaluation(poolMeta, userFlags, trainerState, allQuestions) {
  const qualityData = loadQualityFile();

  // Determine which questions to evaluate
  let toEvaluate;
  if (!trainerState.lastEvalAt) {
    // First run: evaluate all
    toEvaluate = allQuestions;
  } else {
    // Subsequent: unevaluated + flagged + not recently evaluated (>7 days)
    const flaggedQids = new Set(userFlags.map(f => f.qid));
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    toEvaluate = allQuestions.filter(item => {
      const existing = qualityData.questions[item.qid];
      if (!existing) return true; // Never evaluated
      if (flaggedQids.has(item.qid)) return true; // User flagged
      const evalTime = existing.lastEvaluatedAt ? new Date(existing.lastEvaluatedAt).getTime() : NaN;
      if (!isNaN(evalTime) && evalTime > sevenDaysAgo) return false; // Recently evaluated → skip
      return true; // Older than 7 days → re-evaluate
    });
  }

  log(`Quality eval: ${toEvaluate.length} questions to evaluate`);

  // Step A: Static checks on all — replace static issues (don't accumulate)
  const staticIssues = runStaticChecks(toEvaluate);
  let staticCount = 0;
  // Clear old static issues for all evaluated questions
  for (const item of toEvaluate) {
    const entry = qualityData.questions[item.qid];
    if (entry && typeof entry === 'object') {
      entry.issues = Array.isArray(entry.issues) ? entry.issues.filter(i => i.source !== 'static') : [];
    }
  }
  for (const { qid, issues } of staticIssues) {
    if (!qualityData.questions[qid]) {
      qualityData.questions[qid] = { quality_state: 'ok', issues: [], version: 1 };
    }
    const entry = qualityData.questions[qid];
    const hasDataCorruption = issues.some(i => i.type === 'invalid_answer' || i.type === 'duplicate_choices');
    for (const issue of issues) {
      entry.issues.push({ ...issue, source: 'static' });
    }
    if (hasDataCorruption) {
      entry.quality_state = 'invalid';
    } else if (issues.some(i => i.severity === 'critical') && entry.quality_state === 'ok') {
      entry.quality_state = 'needs_review';
    }
    // lastEvaluatedAt is set once at the end for all toEvaluate questions
    staticCount++;
  }
  log(`Static checks: ${staticCount} questions with issues`);

  // Step B: Semantic evaluation (batches of 10)
  // Only for flagged and questions with static issues
  const flaggedQids = new Set(userFlags.map(f => f.qid));
  const semanticCandidates = toEvaluate.filter(item => {
    const entry = qualityData.questions[item.qid];
    return flaggedQids.has(item.qid) ||
           (entry && typeof entry === 'object' && Array.isArray(entry.issues) && entry.issues.some(i => i.severity === 'critical' || i.severity === 'major'));
  });

  if (semanticCandidates.length > 0) {
    log(`Semantic eval: ${semanticCandidates.length} candidates`);
    for (let i = 0; i < semanticCandidates.length; i += 10) {
      const batch = semanticCandidates.slice(i, i + 10);
      const batchQids = new Set(batch.map(b => b.qid));
      const result = await runSemanticEval(batch);
      if (result?.evaluations) {
        for (const ev of result.evaluations) {
          // Only accept qids that were in this batch
          if (!batchQids.has(ev.qid)) {
            qualityLog(`[EVAL_SKIP] ${ev.qid}: not in batch, ignoring`);
            continue;
          }
          if (!qualityData.questions[ev.qid]) {
            qualityData.questions[ev.qid] = { quality_state: 'ok', issues: [], version: 1 };
          }
          const entry = qualityData.questions[ev.qid];
          if (ev.verdict === 'invalid') {
            entry.quality_state = 'invalid';
          } else if (ev.verdict === 'needs_review' && entry.quality_state !== 'invalid') {
            entry.quality_state = 'needs_review';
          }
          // Replace semantic issues (not accumulate)
          const nonSemanticIssues = (entry.issues || []).filter(i => i.source !== 'semantic');
          entry.issues = nonSemanticIssues;
          if (ev.issues && Array.isArray(ev.issues)) {
            for (const issue of ev.issues) {
              // Validate issue schema
              if (typeof issue.type === 'string' && typeof issue.severity === 'string' && typeof issue.detail === 'string') {
                entry.issues.push({ type: issue.type, severity: issue.severity, detail: issue.detail.slice(0, 500), suggestedFix: issue.suggestedFix || null, source: 'semantic' });
              }
            }
          }
          // lastEvaluatedAt is set once at the end for all toEvaluate questions
          qualityLog(`[EVAL] ${ev.qid}: ${ev.verdict} ${ev.issues ? ev.issues.map(i => i.type).join(',') : ''}`);
        }
      }
    }
  }

  // Step C: Integrate user flags (deduplicate by reason)
  for (const flag of userFlags) {
    if (!qualityData.questions[flag.qid]) {
      qualityData.questions[flag.qid] = { quality_state: 'ok', issues: [], version: 1 };
    }
    const entry = qualityData.questions[flag.qid];
    entry.issues = entry.issues || [];
    const alreadyFlagged = entry.issues.some(i => i.source === 'user' && i.detail === `ユーザーフラグ: ${flag.reason}`);
    if (!alreadyFlagged) {
      entry.issues.push({ type: 'user_flag', severity: 'major', detail: `ユーザーフラグ: ${flag.reason}`, source: 'user' });
    }
    if (entry.quality_state === 'ok') entry.quality_state = 'needs_review';
  }

  // Update lastEvaluatedAt for ALL evaluated questions (including those with no issues)
  const evalNow = new Date().toISOString();
  for (const item of toEvaluate) {
    const entry = qualityData.questions[item.qid];
    if (entry && typeof entry === 'object') {
      entry.lastEvaluatedAt = evalNow;
    }
  }

  // Ensure all questions have entries + persist subtopic
  const toEvaluateSet = new Set(toEvaluate.map(item => item.qid));
  for (const item of allQuestions) {
    if (!qualityData.questions[item.qid]) {
      qualityData.questions[item.qid] = {
        quality_state: 'ok',
        issues: [],
        version: 1,
        // Only mark as evaluated if this question was actually in toEvaluate
        ...(toEvaluateSet.has(item.qid) ? { lastEvaluatedAt: evalNow } : {})
      };
    }
    // Always update subtopic from current question data
    qualityData.questions[item.qid].subtopic = guessSubtopic(item.q);
  }

  await saveQualityFile(qualityData);
  trainerState.lastEvalAt = new Date().toISOString();

  // Clear processed flags
  if (userFlags.length > 0) {
    await fetchWithTimeout(`${APP_URL}/api/flags`, { method: 'DELETE' }).then(r => {
      if (!r.ok) log(`Flag clear HTTP ${r.status}`);
    }).catch(e => log('Flag clear failed: ' + e.message));
  }

  log(`Quality eval complete: ${Object.keys(qualityData.questions).length} entries`);
}

// ---- Get All Questions Flat ----
function getAllQuestionsFlat() {
  const dir = join(ROOT, 'public', 'packs');
  if (!existsSync(dir)) return [];
  const questions = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.questions || !d.pack?.id) continue;
      for (const q of d.questions) {
        if (!q || typeof q.id !== 'string') continue;
        questions.push({ qid: d.pack.id + '::' + q.id, packId: d.pack.id, q, file: f });
      }
    } catch (e) { log(`getAllQuestionsFlat error reading ${f}: ${e.message}`); }
  }
  return questions;
}

// ---- Repair Pipeline ----
async function runRepairPipeline(needsRepair, qualityData, allQuestions) {
  let repairCount = 0;
  const qidMap = new Map(allQuestions.map(q => [q.qid, q]));

  const { validateQuestionStruct } = await import('./validate_packs.mjs');

  for (const [qid, qMeta] of needsRepair) {
    const item = qidMap.get(qid);
    if (!item) continue;

    const issues = qMeta.issues || [];
    const hasOutOfScope = issues.some(i => i.type === 'out_of_scope');

    if (hasOutOfScope) {
      // Retire — but only with coverage protection
      const subtopic = qMeta.subtopic || guessSubtopic(item.q);
      const activeInSubtopic = Object.entries(qualityData.questions)
        .filter(([id, m]) => id !== qid && m.subtopic === subtopic && (m.quality_state === 'ok' || m.quality_state === 'repaired'))
        .length;
      if (activeInSubtopic >= 2) {
        qMeta.quality_state = 'retired';
        qualityLog(`[RETIRE] ${qid}: out_of_scope (${activeInSubtopic} others in subtopic)`);
      } else {
        qualityLog(`[KEEP] ${qid}: out_of_scope but only ${activeInSubtopic} others in subtopic — keeping as needs_review`);
      }
      continue;
    }

    // Attempt Opus repair
    const issueDesc = issues.map(i => `- ${i.type}: ${i.detail}${i.suggestedFix ? ' (修正案: ' + i.suggestedFix + ')' : ''}`).join('\n');
    const repairPrompt = `以下の${EXAM_NAME}試験問題に品質問題が検出されました。修正してください。

元の問題（JSON）:
${JSON.stringify(item.q, null, 2)}

検出された問題:
${issueDesc}

修正した問題をJSON形式で出力してください（フェンス不要）。
修正方針:
- 正答が間違っている場合は正しい正答に修正
- 曖昧な場合は明確化
- 選択肢が弱い場合は改善
- 解説が不正確な場合は書き直し
- sourcesがない場合は関連URLを追加
出力はJSON1つのみ（配列不可）。元のid, type, domainは維持。`;

    const repairResult = await runClaude('opus', repairPrompt);
    if (!repairResult) {
      qualityLog(`[REPAIR_FAIL] ${qid}: Opus returned null`);
      continue;
    }

    let repairedQ;
    try { repairedQ = JSON.parse(repairResult); } catch {
      qualityLog(`[REPAIR_FAIL] ${qid}: JSON parse failed`);
      continue;
    }

    // Verify id/type/domain preservation (C5: don't trust LLM to preserve these)
    if (repairedQ.id !== item.q.id || repairedQ.type !== item.q.type || repairedQ.domain !== item.q.domain) {
      qualityLog(`[REPAIR_FAIL] ${qid}: id/type/domain mismatch (expected ${item.q.id}/${item.q.type}/${item.q.domain}, got ${repairedQ.id}/${repairedQ.type}/${repairedQ.domain})`);
      continue;
    }

    // Structure validation
    const structErrors = validateQuestionStruct(repairedQ, item.packId);
    if (structErrors.length > 0) {
      qualityLog(`[REPAIR_FAIL] ${qid}: struct validation failed: ${structErrors.join(', ')}`);
      continue;
    }

    // Re-verify with Sonnet (different session)
    const verifyResult = await runSemanticEval([{ qid, q: repairedQ }]);
    if (verifyResult?.evaluations?.[0]?.verdict === 'ok') {
      // Apply repair — update pack file
      try {
        applyRepair(item, repairedQ);
      } catch (e) {
        qualityLog(`[REPAIR_FAIL] ${qid}: apply failed: ${e.message}`);
        continue;
      }
      qMeta.quality_state = 'repaired';
      qMeta.issues = [];
      qMeta.version = (qMeta.version || 1) + 1;
      qMeta.lastEvaluatedAt = new Date().toISOString();
      repairCount++;
      qualityLog(`[REPAIRED] ${qid}`);
    } else {
      qualityLog(`[REPAIR_REJECTED] ${qid}: Sonnet still found issues`);
    }
  }

  if (repairCount > 0) {
    await saveQualityFile(qualityData);
    // Commit and deploy
    try {
      execFileSync('node', ['tools/validate_packs.mjs'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
      execFileSync('node', ['tools/build_index.mjs'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
      execFileSync('git', ['add', 'public/packs/', 'public/meta/'], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
      try {
        execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT, stdio: 'pipe', timeout: 10000 });
        log('No changes staged after repair, skipping commit/deploy.');
      } catch {
        const commitMsg = `Quality: repaired ${repairCount} question(s)\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;
        execFileSync('git', ['commit', '-m', commitMsg], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        execFileSync('npx', ['wrangler', 'pages', 'deploy', 'public', '--project-name', `${EXAM_ID}-pwa`, '--commit-dirty=true'], { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
        log(`Deployed ${repairCount} repaired question(s)`);
      }
    } catch (e) {
      log(`Repair deploy error: ${e.message}`);
      if (e.stderr) log(`  stderr: ${e.stderr.toString().slice(0, 500)}`);
      if (e.stdout) log(`  stdout: ${e.stdout.toString().slice(0, 500)}`);
    }
  }
}

// ---- Apply repair to pack file ----
function applyRepair(item, repairedQ) {
  const filePath = join(ROOT, 'public', 'packs', item.file);
  const packData = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(packData.questions)) {
    throw new Error(`Pack ${item.file} has no valid questions array`);
  }
  const idx = packData.questions.findIndex(q => q.id === item.q.id);
  if (idx < 0) {
    throw new Error(`Question ${item.q.id} not found in ${item.file}`);
  }
  packData.questions[idx] = repairedQ;
  const tmpFile = filePath + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(packData, null, 2), { mode: 0o644 });
  renameSync(tmpFile, filePath);
}

// ---- Taxonomy helpers ----
function loadTaxonomy() {
  try {
    if (existsSync(TAXONOMY_FILE)) return JSON.parse(readFileSync(TAXONOMY_FILE, 'utf8'));
  } catch (e) { log('loadTaxonomy error: ' + e.message); }
  return { domains: {} };
}

function guessSubtopic(q) {
  // Best-effort subtopic from tags (with type guard)
  return (Array.isArray(q.tags) && q.tags.length > 0) ? q.tags[0] : 'unknown';
}

function findSubtopicGaps(qualityData) {
  const taxonomy = loadTaxonomy();
  const gaps = [];
  const subtopicCounts = {};

  // Count active questions per subtopic
  for (const [, meta] of Object.entries(qualityData.questions || {})) {
    if (!meta || typeof meta !== 'object') continue;
    if (meta.quality_state === 'retired') continue;
    const st = meta.subtopic || 'unknown';
    subtopicCounts[st] = (subtopicCounts[st] || 0) + 1;
  }

  // Check all subtopics from taxonomy
  for (const [, domain] of Object.entries(taxonomy.domains || {})) {
    for (const st of (domain.subtopics || [])) {
      if (!st || typeof st.id !== 'string') continue;
      if ((subtopicCounts[st.id] || 0) < 2) {
        gaps.push(st.id);
      }
    }
  }
  return gaps;
}

// ---- Cloudflare Tunnel ----
let currentTunnel = null;

function startTunnel() {
  // Kill previous tunnel if still alive
  if (currentTunnel) {
    try { currentTunnel.removeAllListeners(); currentTunnel.kill('SIGKILL'); } catch {}
    currentTunnel = null;
  }

  log(`Starting Cloudflare Tunnel (retry delay: ${tunnelRetryDelay / 1000}s)...`);

  let tunnel;
  try {
    tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`Tunnel spawn failed: ${e.message}`);
    if (!tunnelRestarting) {
      tunnelRestarting = true;
      log(`Tunnel spawn failed. Restarting in ${tunnelRetryDelay / 1000}s...`);
      if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
      tunnelRestartTimer = setTimeout(() => { tunnelRestarting = false; tunnelRestartTimer = null; startTunnel(); }, tunnelRetryDelay);
      tunnelRetryDelay = Math.min(tunnelRetryDelay * 2, MAX_TUNNEL_RETRY);
    }
    return;
  }
  currentTunnel = tunnel;

  function onTunnelOutput(data) {
    const line = data.toString();
    const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[1];
      tunnelRetryDelay = 10000; // Reset backoff on success
      log(`Tunnel URL: ${tunnelUrl}`);

      fetchWithTimeout(`${APP_URL}/api/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelUrl }),
      }).then(r => {
        if (!r.ok) log(`Tunnel URL store HTTP ${r.status}`);
        else log('Tunnel URL stored in KV.');
      }).catch(e => log('Failed to store tunnel URL: ' + e.message));
    }
  }
  tunnel.stderr.on('data', onTunnelOutput);
  tunnel.stdout.on('data', onTunnelOutput);

  function scheduleRestart(reason) {
    tunnelUrl = null;
    if (currentTunnel === tunnel) currentTunnel = null;
    try { tunnel.removeAllListeners(); tunnel.kill('SIGKILL'); } catch {}
    if (tunnelRestarting) return; // Prevent double-schedule from close+error
    tunnelRestarting = true;
    log(`Tunnel ${reason}. Restarting in ${tunnelRetryDelay / 1000}s...`);
    if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
    tunnelRestartTimer = setTimeout(() => { tunnelRestarting = false; tunnelRestartTimer = null; startTunnel(); }, tunnelRetryDelay);
    tunnelRetryDelay = Math.min(tunnelRetryDelay * 2, MAX_TUNNEL_RETRY);
  }

  tunnel.on('close', (code) => scheduleRestart(`exited (code ${code})`));
  tunnel.on('error', (e) => scheduleRestart(`error: ${e.message}`));
}

// ---- Graceful Shutdown ----
function gracefulShutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  shuttingDown = true;
  // If trainer is running, let runTrainer()'s finally block release the lock
  if (!isRunning) releaseLock();
  if (currentTunnel) {
    try { currentTunnel.removeAllListeners(); currentTunnel.kill('SIGKILL'); } catch {}
  }
  if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
  server.close(() => process.exit(0));
  // Force exit after 5s if server.close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ---- Start ----
server.headersTimeout = 30000;
server.requestTimeout = 30000;
server.on('error', (e) => {
  log(`Server error: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  log('==============================================');
  log(` ${EXAM_NAME} Personal Trainer Server`);
  log(` Listening on http://localhost:${PORT}`);
  log('==============================================');

  if (!IS_LOCAL && !TRAINER_SECRET) {
    log('WARNING: TRAINER_SECRET not set. /trigger will reject requests. Set TRAINER_SECRET env or use --local.');
  }

  if (!IS_LOCAL) {
    startTunnel();
  } else {
    log('Local mode (no tunnel, no auth required).');
  }
});
