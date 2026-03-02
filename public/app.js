/* ===== AI-900 Practice App (app.js) ===== */
'use strict';

/* ---------- Constants & Config ---------- */
const APP_VERSION = '1.0.0';
const DOMAINS = ['Workloads','ML','CV','NLP','GenAI'];
const DOMAIN_LABELS = {Workloads:'AIワークロード/責任あるAI',ML:'機械学習',CV:'Computer Vision',NLP:'自然言語処理',GenAI:'生成AI'};
const TYPES = ['single','multi','dropdown','match','order','hotarea','casestudy'];
const TYPE_LABELS = {single:'単一選択',multi:'複数選択',dropdown:'穴埋め',match:'マッチング',order:'並べ替え',hotarea:'ホットエリア',casestudy:'ケーススタディ'};

const DEFAULT_SETTINGS = {
  questionCount: 50,
  timeLimit: 45,
  domainWeights: {Workloads:19.5,ML:19.5,CV:19.5,NLP:19.5,GenAI:22},
  typeMinimums: {match:6,order:4,dropdown:6,hotarea:3,casestudy:2},
  recentExclude: 100,
  weaknessBoostMax: 0.3,
  weaknessDays: 7,
  autoNext: true,
  autoNextDelay: 600
};

/* ---------- Settings (localStorage) ---------- */
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('ai900_settings'))); }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem('ai900_settings', JSON.stringify(s)); }
let settings = loadSettings();

/* ---------- State ---------- */
let state = {
  route: 'home',
  session: null,       // current session
  currentQ: 0,
  showExplanation: false,
  reviewMode: null,    // null | 'flagged' | 'wrong' | 'unanswered'
  reviewIndices: null,
  domainFilter: null   // null | 'Workloads' | 'ML' | 'CV' | 'NLP' | 'GenAI'
};

/* ---------- Router ---------- */
function navigate(route, params) {
  state.route = route;
  if (params) Object.assign(state, params);
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1) || 'home';
  if (h !== state.route) navigate(h);
});

/* ---------- Utility ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'disabled' || k === 'readonly' || k === 'checked') { if (v) e.setAttribute(k, ''); }
    else if (v === false || v === null || v === undefined) { /* skip falsy attrs */ }
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(c));
    else if (Array.isArray(c)) c.forEach(cc => cc && e.appendChild(cc));
    else e.appendChild(c);
  }
  return e;
}

function toast(msg, dur = 2500) {
  const t = el('div', { className: 'toast' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pct(n, d) { return d === 0 ? 0 : Math.round(n / d * 100); }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function shuffleIndices(len) { return shuffle(Array.from({ length: len }, (_, i) => i)); }

/* ---------- Fingerprint (SHA-256) ---------- */
async function fingerprint(q) {
  const normalize = s => (s || '').trim().replace(/\s+/g, ' ').replace(/\r\n/g, '\n');
  let raw = normalize(q.prompt);
  if (q.choices) raw += '|' + q.choices.map(normalize).join(',');
  if (q.left) raw += '|L:' + q.left.map(normalize).join(',');
  if (q.right) raw += '|R:' + q.right.map(normalize).join(',');
  if (q.items) raw += '|I:' + q.items.map(normalize).join(',');
  if (q.dropdowns) raw += '|D:' + q.dropdowns.map(d => d.options.map(normalize).join(',')).join(';');
  if (q.grid) raw += '|G:' + q.grid.cells.map(normalize).join(',');
  if (q.subQuestions) raw += '|SQ:' + q.subQuestions.map(sq => normalize(sq.prompt)).join(';');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Pack Validation ---------- */
function validateQuestion(q, packId) {
  const errors = [];
  if (!q.id || !q.type || !q.prompt || !q.domain) errors.push(`Missing required field in ${q.id || 'unknown'}`);
  if (!TYPES.includes(q.type)) errors.push(`Unknown type: ${q.type}`);
  if (!DOMAINS.includes(q.domain)) errors.push(`Unknown domain: ${q.domain}`);

  switch (q.type) {
    case 'single':
    case 'multi':
      if (!Array.isArray(q.choices) || q.choices.length < 2) errors.push(`${q.id}: choices must have >=2 items`);
      if (!Array.isArray(q.answer)) errors.push(`${q.id}: answer must be array`);
      else q.answer.forEach(a => { if (a < 0 || a >= (q.choices||[]).length) errors.push(`${q.id}: answer index ${a} out of range`); });
      if (q.type === 'single' && q.answer && q.answer.length !== 1) errors.push(`${q.id}: single must have exactly 1 answer`);
      break;
    case 'dropdown':
      if (!Array.isArray(q.dropdowns)) errors.push(`${q.id}: missing dropdowns`);
      else {
        q.dropdowns.forEach((d, i) => {
          if (!Array.isArray(d.options) || d.options.length < 2) errors.push(`${q.id}: dropdown[${i}] needs >=2 options`);
          if (typeof d.answer !== 'number' || d.answer < 0 || d.answer >= (d.options||[]).length) errors.push(`${q.id}: dropdown[${i}] answer out of range`);
          if (!q.prompt.includes(`{{${i}}}`)) errors.push(`${q.id}: prompt missing {{${i}}}`);
        });
      }
      break;
    case 'match':
      if (!Array.isArray(q.left) || !Array.isArray(q.right) || !q.answerMap) errors.push(`${q.id}: match needs left, right, answerMap`);
      else {
        q.left.forEach(l => { if (!(l in q.answerMap)) errors.push(`${q.id}: answerMap missing key "${l}"`); });
        Object.values(q.answerMap).forEach(v => { if (!q.right.includes(v)) errors.push(`${q.id}: answerMap value "${v}" not in right`); });
      }
      break;
    case 'order':
      if (!Array.isArray(q.items) || !Array.isArray(q.answerOrder)) errors.push(`${q.id}: order needs items, answerOrder`);
      else {
        if (q.answerOrder.length !== q.items.length) errors.push(`${q.id}: answerOrder length mismatch`);
        const sorted1 = [...q.answerOrder].sort();
        const expected = q.items.map((_, i) => i).sort();
        if (JSON.stringify(sorted1) !== JSON.stringify(expected)) errors.push(`${q.id}: answerOrder indices invalid`);
      }
      break;
    case 'hotarea':
      if (!q.grid || !Array.isArray(q.grid.cells) || !Array.isArray(q.answer)) errors.push(`${q.id}: hotarea needs grid.cells and answer`);
      else q.answer.forEach(a => { if (a < 0 || a >= q.grid.cells.length) errors.push(`${q.id}: hotarea answer ${a} out of range`); });
      break;
    case 'casestudy':
      if (!Array.isArray(q.subQuestions) || q.subQuestions.length === 0) errors.push(`${q.id}: casestudy needs subQuestions`);
      else {
        const subIds = new Set();
        q.subQuestions.forEach(sq => {
          if (subIds.has(sq.id)) errors.push(`${q.id}: duplicate subQuestion id ${sq.id}`);
          subIds.add(sq.id);
          const subErrs = validateQuestion({ ...sq, domain: q.domain }, packId);
          errors.push(...subErrs.map(e => `${q.id}>${e}`));
        });
      }
      break;
  }
  return errors;
}

/* ---------- Import Pack ---------- */
async function importPack(json) {
  if (json.schema !== 'ai900-pack-v1') throw new Error('Invalid pack schema');
  const pack = json.pack;
  const questions = json.questions;
  if (!pack || !pack.id || !questions) throw new Error('Invalid pack structure');

  let added = 0, skipped = 0, invalid = 0;
  const allErrors = [];

  for (const q of questions) {
    const errs = validateQuestion(q, pack.id);
    if (errs.length > 0) {
      allErrors.push(...errs);
      invalid++;
      continue;
    }
    const fp = await fingerprint(q);
    const exists = await IDB.hasFingerprint(fp);
    if (exists) { skipped++; continue; }

    const qid = pack.id + '::' + q.id;
    await IDB.saveQuestion({
      qid,
      packId: pack.id,
      domain: q.domain,
      type: q.type,
      difficulty: q.difficulty || 2,
      data: q,
      fingerprint: fp,
      tags: q.tags || []
    });
    await IDB.saveFingerprint(fp, qid);
    added++;
  }

  await IDB.savePack({
    id: pack.id,
    title: pack.title,
    version: pack.version,
    description: pack.description || '',
    language: pack.language || 'ja-JP',
    domains: pack.domains || [],
    questionCount: added,
    enabled: true,
    importedAt: Date.now()
  });

  return { added, skipped, invalid, errors: allErrors };
}

/* ---------- Recent QIDs ---------- */
function getRecentQids() {
  try {
    const r = JSON.parse(localStorage.getItem('ai900_recent') || '[]');
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}
function pushRecentQids(qids) {
  let recent = getRecentQids();
  recent = [...qids, ...recent].slice(0, settings.recentExclude);
  localStorage.setItem('ai900_recent', JSON.stringify(recent));
}

/* ---------- Question Selection Engine ---------- */
async function selectQuestions(domainFilter = null) {
  const allQ = await IDB.getAllQuestions();
  let pool = allQ;

  // Apply domain filter
  if (domainFilter) pool = pool.filter(q => q.domain === domainFilter);

  if (pool.length === 0) return [];

  // Try AI-curated session first (skip if domain filter is active)
  if (domainFilter) { /* skip curated for domain-specific */ }
  else try {
    const res = await fetch('/api/next-session');
    const data = await res.json();
    if (data.ok && data.session && !data.session.consumed && data.session.questions) {
      const age = Date.now() - new Date(data.session.updatedAt).getTime();
      if (age < 7200000) { // Use if less than 2 hours old
        const curated = [];
        for (const item of data.session.questions) {
          const q = pool.find(p => p.qid === item.qid);
          if (q) curated.push(q);
        }
        if (curated.length >= settings.questionCount * 0.7) {
          console.log(`Using AI-curated session: ${curated.length} questions (${data.session.sessionType})`);
          // Mark as consumed
          fetch('/api/next-session', { method: 'POST' }).catch(() => {});
          return curated;
        }
      }
    }
  } catch { /* fall through to weighted random */ }

  // Build set of ALL question IDs the user has ever answered (not just recent)
  const allHistory = await IDB.getAllHistory();
  const everSeenQids = new Set(allHistory.map(h => h.qid));
  const recentSet = new Set(getRecentQids());

  // Weakness from recent history
  const recentHistory = await IDB.getRecentHistory(settings.weaknessDays);
  const domainStats = {}, typeStats = {}, tagStats = {};
  for (const d of DOMAINS) domainStats[d] = { correct: 0, total: 0 };
  for (const t of TYPES) typeStats[t] = { correct: 0, total: 0 };

  for (const h of recentHistory) {
    if (domainStats[h.domain]) { domainStats[h.domain].total++; if (h.correct) domainStats[h.domain].correct++; }
    if (typeStats[h.type]) { typeStats[h.type].total++; if (h.correct) typeStats[h.type].correct++; }
    if (h.tags) for (const tag of h.tags) {
      if (!tagStats[tag]) tagStats[tag] = { correct: 0, total: 0 };
      tagStats[tag].total++; if (h.correct) tagStats[tag].correct++;
    }
  }

  function weakness(stats) {
    if (!stats || stats.total === 0) return 0;
    const rate = stats.correct / stats.total;
    return Math.min(settings.weaknessBoostMax, (1 - rate) * 0.5);
  }

  // Separate pool into unseen and seen
  const unseenPool = pool.filter(q => !everSeenQids.has(q.qid));
  const seenPool = pool.filter(q => everSeenQids.has(q.qid));
  console.log(`Question pool: ${unseenPool.length} unseen / ${seenPool.length} seen / ${pool.length} total`);

  // Score each question
  function scoreQ(q) {
    let s = 1;
    s *= (1 + weakness(domainStats[q.domain]));
    s *= (1 + weakness(typeStats[q.type]));
    const topTag = (q.tags || [])[0];
    if (topTag && tagStats[topTag]) s *= (1 + weakness(tagStats[topTag]));
    // Strongly prefer unseen questions, then penalize very recent ones
    if (!everSeenQids.has(q.qid)) s *= 5;
    else if (recentSet.has(q.qid)) s *= 0.01;
    return s + Math.random() * 0.3;
  }

  // Target counts per domain
  const total = settings.questionCount;
  const domainCounts = {};
  let assigned = 0;
  for (const d of DOMAINS) {
    domainCounts[d] = Math.floor(total * (settings.domainWeights[d] || 20) / 100);
    assigned += domainCounts[d];
  }
  let remainder = total - assigned;
  for (const d of DOMAINS) { if (remainder <= 0) break; domainCounts[d]++; remainder--; }

  // Type minimums
  const typeMins = { ...settings.typeMinimums };

  // Group pool by domain
  const byDomain = {};
  for (const d of DOMAINS) byDomain[d] = [];
  for (const q of pool) { if (byDomain[q.domain]) byDomain[q.domain].push(q); }

  // Select
  const selected = [];
  const typeCount = {};
  for (const t of TYPES) typeCount[t] = 0;

  // Phase 1: satisfy type minimums
  for (const t of TYPES) {
    const min = typeMins[t] || 0;
    if (min <= 0) continue;
    const ofType = pool.filter(q => q.type === t && !selected.includes(q)).sort((a, b) => scoreQ(b) - scoreQ(a));
    for (let i = 0; i < min && i < ofType.length; i++) {
      selected.push(ofType[i]);
      typeCount[t]++;
    }
  }

  // Phase 2: fill per domain
  for (const d of DOMAINS) {
    const need = domainCounts[d] - selected.filter(q => q.domain === d).length;
    if (need <= 0) continue;
    const candidates = byDomain[d].filter(q => !selected.includes(q)).sort((a, b) => scoreQ(b) - scoreQ(a));
    for (let i = 0; i < need && i < candidates.length; i++) {
      selected.push(candidates[i]);
      typeCount[candidates[i].type] = (typeCount[candidates[i].type] || 0) + 1;
    }
  }

  // Phase 3: if still short, fill from any remaining
  while (selected.length < total) {
    const rest = pool.filter(q => !selected.includes(q));
    if (rest.length === 0) break;
    rest.sort((a, b) => scoreQ(b) - scoreQ(a));
    selected.push(rest[0]);
  }

  // Shuffle
  for (let i = selected.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }

  return selected;
}

/* ---------- Scoring ---------- */
function gradeAnswer(q, userAnswer) {
  const data = q.data || q;
  switch (data.type) {
    case 'single':
      return Array.isArray(userAnswer) && userAnswer.length === 1 && userAnswer[0] === data.answer[0];
    case 'multi':
      if (!Array.isArray(userAnswer)) return false;
      const sa = [...userAnswer].sort();
      const ea = [...data.answer].sort();
      return JSON.stringify(sa) === JSON.stringify(ea);
    case 'dropdown':
      if (!Array.isArray(userAnswer)) return false;
      return data.dropdowns.every((d, i) => userAnswer[i] === d.answer);
    case 'match':
      if (!userAnswer || typeof userAnswer !== 'object') return false;
      return data.left.every(l => userAnswer[l] === data.answerMap[l]);
    case 'order':
      if (!Array.isArray(userAnswer)) return false;
      return JSON.stringify(userAnswer) === JSON.stringify(data.answerOrder);
    case 'hotarea':
      if (!Array.isArray(userAnswer)) return false;
      const sh = [...userAnswer].sort();
      const eh = [...data.answer].sort();
      return JSON.stringify(sh) === JSON.stringify(eh);
    case 'casestudy':
      if (!userAnswer || typeof userAnswer !== 'object') return false;
      return data.subQuestions.every(sq => {
        const ua = userAnswer[sq.id];
        return gradeAnswer({ data: sq }, ua);
      });
    default:
      return false;
  }
}

/* ---------- Timer ---------- */
let timerInterval = null;
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!state.session || state.session.finished) { clearInterval(timerInterval); return; }
    state.session.elapsed++;
    const timerEl = document.getElementById('timer');
    if (timerEl) {
      const remaining = Math.max(0, state.session.timeLimit * 60 - state.session.elapsed);
      timerEl.textContent = formatTime(remaining);
      if (remaining <= 0 && !state.session.finished) {
        finishSession();
      }
    }
  }, 1000);
}
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

/* ---------- Session Management ---------- */
async function startSession(mode = 'practice', domainFilter = null) {
  const questions = await selectQuestions(domainFilter);
  if (questions.length === 0) { toast('問題がありません。'); return; }

  // Pre-compute shuffle mappings for ALL question types
  // Each mapping stores original indices in display order.
  // User answers always use original indices → grading unaffected.
  const shuffles = {};
  questions.forEach((q, i) => {
    const d = q.data || q;
    const s = {};
    switch (d.type) {
      case 'single':
      case 'multi':
        s.choices = shuffleIndices(d.choices.length);
        break;
      case 'dropdown':
        s.dropdowns = d.dropdowns.map(dd => shuffleIndices(dd.options.length));
        break;
      case 'match':
        s.left = shuffleIndices(d.left.length);
        s.right = shuffle(d.right);
        break;
      case 'order':
        s.init = shuffleIndices(d.items.length);
        break;
      case 'hotarea':
        s.cells = shuffleIndices(d.grid.cells.length);
        break;
      case 'casestudy':
        if (d.subQuestions) {
          s.subs = {};
          d.subQuestions.forEach(sq => {
            if ((sq.type === 'single' || sq.type === 'multi') && sq.choices) {
              s.subs[sq.id] = { choices: shuffleIndices(sq.choices.length) };
            } else if (sq.type === 'dropdown' && sq.dropdowns) {
              s.subs[sq.id] = { dropdowns: sq.dropdowns.map(dd => shuffleIndices(dd.options.length)) };
            }
          });
        }
        break;
    }
    shuffles[i] = s;
  });

  state.session = {
    id: 'sess_' + Date.now(),
    mode,
    questions,
    answers: {},
    flags: new Set(),
    finished: false,
    graded: {},
    shuffles,
    elapsed: 0,
    timeLimit: mode === 'exam' ? settings.timeLimit : 0,
    startedAt: Date.now()
  };
  state.currentQ = 0;
  state.showExplanation = false;
  state.reviewMode = null;
  state.reviewIndices = null;

  if (mode === 'exam') startTimer();
  navigate('session');
}

async function finishSession() {
  if (!state.session || state.session.finished) return;
  state.session.finished = true;
  stopTimer();

  // Grade all
  for (let i = 0; i < state.session.questions.length; i++) {
    const q = state.session.questions[i];
    const ua = state.session.answers[i];
    const correct = gradeAnswer(q, ua);
    state.session.graded[i] = correct;

    // Save history
    await IDB.addHistory({
      qid: q.qid,
      domain: q.domain,
      type: q.type,
      tags: q.tags || [],
      correct,
      ts: Date.now()
    });
  }

  // Push recent
  pushRecentQids(state.session.questions.map(q => q.qid));

  // Save session
  await IDB.saveSession({
    id: state.session.id,
    mode: state.session.mode,
    questionCount: state.session.questions.length,
    correctCount: Object.values(state.session.graded).filter(Boolean).length,
    elapsed: state.session.elapsed,
    startedAt: state.session.startedAt,
    finishedAt: Date.now(),
    domainStats: computeDomainStats(),
    typeStats: computeTypeStats(),
    tagStats: computeTagStats()
  });

  // Background: sync weakness, check pool health, backup progress
  syncWeaknessToServer().catch(e => console.warn('Weakness sync failed:', e));
  checkPoolHealth().catch(e => console.warn('Pool health check failed:', e));
  backupProgress().catch(e => console.warn('Backup failed:', e));

  navigate('result');
}

/* -- Sync weakness data to Cloudflare KV for Claude Code -- */
async function syncWeaknessToServer() {
  const data = await exportWeaknessData();
  if (!data) return;
  try {
    await fetch('/api/weakness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data
    });
  } catch { /* silent fail - offline is fine */ }
}

/* -- Pool health: queue generation request for local daemon -- */
async function checkPoolHealth() {
  const UNSEEN_THRESHOLD = 0.4;

  const allQuestions = await IDB.getAllQuestions();
  const totalQuestions = allQuestions.length;
  if (totalQuestions === 0) return;

  const allHistory = await IDB.getAllHistory();
  const seenQids = new Set(allHistory.map(h => h.qid));
  const uniqueSeen = seenQids.size;
  const unseenRatio = (totalQuestions - uniqueSeen) / totalQuestions;

  console.log(`Pool health: ${uniqueSeen}/${totalQuestions} seen, unseen: ${Math.round(unseenRatio * 100)}%`);

  if (unseenRatio >= UNSEEN_THRESHOLD) return;

  const needed = Math.min(Math.max(Math.ceil(uniqueSeen * 0.5) - (totalQuestions - uniqueSeen), 15), 50);
  const weaknessJson = await exportWeaknessData();
  const weakness = weaknessJson ? JSON.parse(weaknessJson) : null;

  try {
    await fetch('/api/generate-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unseenRatio, totalQuestions, uniqueSeen, needed, weakness, domains: DOMAINS })
    });
    console.log(`Generation request queued: ${needed} questions needed`);
  } catch { /* offline is fine */ }
}

/* -- Backup learning progress to KV (survives browser data clear) -- */
async function backupProgress() {
  const sessions = await IDB.getAllSessions();
  const history = await IDB.getAllHistory();
  if (sessions.length === 0 && history.length === 0) return;
  try {
    await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions, history, backedUpAt: new Date().toISOString() })
    });
  } catch { /* silent */ }
}

async function restoreProgress() {
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.ok || !data.found) return false;
    let restored = 0;
    if (data.history) {
      for (const h of data.history) {
        try { await IDB.addHistory(h); restored++; } catch { /* dupe */ }
      }
    }
    if (data.sessions) {
      for (const s of data.sessions) {
        try { await IDB.saveSession(s); } catch { /* dupe */ }
      }
    }
    if (restored > 0) toast(`${restored}件の学習記録を復元しました`);
    return restored > 0;
  } catch { return false; }
}

function computeDomainStats() {
  const s = {};
  for (const d of DOMAINS) s[d] = { correct: 0, total: 0 };
  state.session.questions.forEach((q, i) => {
    if (s[q.domain]) { s[q.domain].total++; if (state.session.graded[i]) s[q.domain].correct++; }
  });
  return s;
}
function computeTypeStats() {
  const s = {};
  for (const t of TYPES) s[t] = { correct: 0, total: 0 };
  state.session.questions.forEach((q, i) => {
    const type = q.data ? q.data.type : q.type;
    if (s[type]) { s[type].total++; if (state.session.graded[i]) s[type].correct++; }
  });
  return s;
}
function computeTagStats() {
  const s = {};
  state.session.questions.forEach((q, i) => {
    for (const tag of (q.tags || [])) {
      if (!s[tag]) s[tag] = { correct: 0, total: 0 };
      s[tag].total++;
      if (state.session.graded[i]) s[tag].correct++;
    }
  });
  return s;
}

/* ---------- Weakness Prompt Generator ---------- */
function generateWeaknessPrompt(weakDomains, weakTags, weakTypes, numQ) {
  const domainStr = weakDomains.length > 0 ? weakDomains.map(d => `${d}(${DOMAIN_LABELS[d]||d})`).join(', ') : '全分野均等';
  const tagStr = weakTags.length > 0 ? weakTags.join(', ') : '一般';
  const typeStr = weakTypes.length > 0 ? weakTypes.map(t => `${t}(${TYPE_LABELS[t]||t})`).join(', ') : 'single, multi';
  const packId = `ai900.weak.${Date.now().toString(36)}`;

  return `以下の仕様でAI-900試験対策の問題パックJSON（schema: ai900-pack-v1）を生成してください。

■ 目的
苦手分野を重点的に強化するための追加問題パックです。

■ 苦手分析結果
- 弱い分野: ${domainStr}
- 弱いタグ: ${tagStr}
- 弱い形式: ${typeStr}

■ 問題数: ${numQ}問
- 上記の苦手分野・タグを重点的に出題
- 形式は ${typeStr} を中心に、他の形式も混ぜる

■ 出力JSONフォーマット（これを厳密に守ること）:
{
  "schema": "ai900-pack-v1",
  "pack": {
    "id": "${packId}",
    "version": "${new Date().toISOString().slice(0,10)}",
    "title": "苦手克服パック",
    "description": "苦手分析に基づいて生成された問題パック",
    "language": "ja-JP",
    "createdAt": "${new Date().toISOString()}",
    "domains": ${JSON.stringify(weakDomains.length > 0 ? weakDomains : DOMAINS)}
  },
  "questions": [...]
}

■ 問題タイプ別スキーマ:
- single: { id, domain, type:"single", difficulty:1-3, prompt, choices:["A","B","C","D"], answer:[正解index], explanation, tags:[], sources:[] }
- multi: { id, domain, type:"multi", difficulty:1-3, prompt, choices:["A","B","C","D"], answer:[正解index1,正解index2], explanation, tags:[], sources:[] }
- dropdown: { id, domain, type:"dropdown", difficulty:1-3, prompt:"text {{0}} more {{1}}", dropdowns:[{options:["a","b","c"],answer:0},{options:["x","y"],answer:1}], explanation, tags:[], sources:[] }
- match: { id, domain, type:"match", difficulty:1-3, prompt, left:["A","B","C"], right:["1","2","3"], answerMap:{"A":"1","B":"2","C":"3"}, explanation, tags:[], sources:[] }
- order: { id, domain, type:"order", difficulty:1-3, prompt, items:["s1","s2","s3"], answerOrder:[2,0,1], explanation, tags:[], sources:[] }
- hotarea: { id, domain, type:"hotarea", difficulty:1-3, prompt, grid:{cols:N,rows:M,cells:["c1","c2",...]}, answer:[正解cellIndex], explanation, tags:[], sources:[] }
- casestudy: { id, domain, type:"casestudy", difficulty:1-3, prompt:"シナリオ", subQuestions:[{id:"xx-1", type:"single", prompt, choices, answer, explanation},...], explanation, tags:[], sources:[] }

■ ルール:
- capabilities（機能・使い分け）を問う問題のみ。UI手順暗記は禁止。
- answerのindexはchoices配列の0始まり範囲内であること。
- ID命名: WK-001, ML-001, CV-001, NL-001, GA-001 等（重複不可）
- domains: Workloads, ML, CV, NLP, GenAI のいずれか
- JSON全文のみ出力（コードブロックで囲む）。説明文不要。`;
}

/* ---------- Export weakness data for Claude Code ---------- */
async function exportWeaknessData() {
  const history = await IDB.getRecentHistory(settings.weaknessDays);
  if (history.length === 0) {
    toast('まだ学習履歴がありません。先に何問か解いてください。');
    return null;
  }
  const domainAgg = {}, typeAgg = {}, tagAgg = {};
  for (const d of DOMAINS) domainAgg[d] = { correct: 0, total: 0 };
  for (const t of TYPES) typeAgg[t] = { correct: 0, total: 0 };
  for (const h of history) {
    if (domainAgg[h.domain]) { domainAgg[h.domain].total++; if (h.correct) domainAgg[h.domain].correct++; }
    if (typeAgg[h.type]) { typeAgg[h.type].total++; if (h.correct) typeAgg[h.type].correct++; }
    for (const tag of (h.tags || [])) {
      if (!tagAgg[tag]) tagAgg[tag] = { correct: 0, total: 0 };
      tagAgg[tag].total++; if (h.correct) tagAgg[tag].correct++;
    }
  }
  const data = {
    exportedAt: new Date().toISOString(),
    totalAnswered: history.length,
    domain: Object.fromEntries(Object.entries(domainAgg).filter(([,v]) => v.total > 0).map(([k,v]) => [k, `${v.correct}/${v.total} (${Math.round(v.correct/v.total*100)}%)`])),
    type: Object.fromEntries(Object.entries(typeAgg).filter(([,v]) => v.total > 0).map(([k,v]) => [k, `${v.correct}/${v.total} (${Math.round(v.correct/v.total*100)}%)`])),
    weakTags: Object.entries(tagAgg).filter(([,v]) => v.total >= 2).sort((a,b) => (a[1].correct/a[1].total) - (b[1].correct/b[1].total)).slice(0, 10).map(([t,v]) => `${t}: ${v.correct}/${v.total} (${Math.round(v.correct/v.total*100)}%)`)
  };
  return JSON.stringify(data, null, 2);
}

async function copyWeaknessForClaude() {
  const data = await exportWeaknessData();
  if (!data) return;
  const text = `AI-900アプリの苦手データです。これに基づいて問題パックを生成・デプロイしてください。\n\n${data}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('苦手データをコピーしました。Claude Codeに貼り付けてください。');
  } catch {
    // fallback: show overlay
    const overlay = el('div', {
      style: { position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,.85)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:'16px' },
      onClick: e => { if (e.target === overlay) overlay.remove(); }
    });
    const box = el('div', { className: 'card', style: { width: '100%', maxWidth: '400px' } },
      el('h2', null, 'Claude Codeに貼り付けてください'),
      el('textarea', { readonly: 'true', style: { minHeight: '200px', fontSize: '12px' }, value: text, onClick: e => e.target.select() }),
      el('button', { className: 'btn btn-primary btn-block mt-8', onClick: () => overlay.remove() }, '閉じる')
    );
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }
}

/* ========== RENDER ========== */
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  switch (state.route) {
    case 'home': renderHome(app); break;
    case 'session': renderSession(app); break;
    case 'result': renderResult(app); break;
    case 'stats': renderStats(app); break;
    case 'settings': renderSettings(app); break;
    default: renderHome(app);
  }
}

/* ---------- SVG Icons ---------- */
const icons = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58-1.97-3.4-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.8 4h-3.6l-.38 2.1c-.59.24-1.13.56-1.62.94L6.8 6.08l-1.97 3.4 2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58 1.97 3.4 2.39-.96c.5.38 1.03.7 1.62.94L9.2 20h3.6l.38-2.1c.59-.24 1.13-.56 1.62-.94l2.39.96 1.97-3.4-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  explain: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
};

/* ---------- Home Page ---------- */
function renderHome(app) {
  const header = el('div', { className: 'header' },
    el('h1', null, 'AI-900 練習')
  );
  const page = el('div', { className: 'page' });

  // Domain filter
  const domainChips = el('div', { className: 'domain-chips' },
    el('button', { className: `chip ${!state.domainFilter ? 'active' : ''}`, onClick: () => { state.domainFilter = null; render(); } }, '全分野'),
    ...DOMAINS.map(d => el('button', {
      className: `chip ${state.domainFilter === d ? 'active' : ''}`,
      onClick: () => { state.domainFilter = d; render(); }
    }, DOMAIN_LABELS[d].split('/')[0]))
  );
  page.appendChild(domainChips);

  // Start buttons
  const startCard = el('div', { className: 'card' },
    el('div', { className: 'grid-2' },
      el('button', { className: 'btn btn-primary btn-block', onClick: () => startSession('practice', state.domainFilter), 'aria-label': '練習モード開始' }, '練習モード'),
      el('button', { className: 'btn btn-warn btn-block', onClick: () => startSession('exam', state.domainFilter), 'aria-label': '模試モード開始' }, `模試 (${settings.timeLimit}分)`)
    )
  );
  page.appendChild(startCard);

  // Pool status + coach message (loaded async)
  IDB.getAllQuestions().then(async qs => {
    let activeQ = qs;
    if (state.domainFilter) activeQ = activeQ.filter(q => q.domain === state.domainFilter);
    const allHistory = await IDB.getAllHistory();
    const seenQids = new Set(allHistory.map(h => h.qid));
    const unseenCount = activeQ.filter(q => !seenQids.has(q.qid)).length;

    const poolCard = el('div', { className: 'card' },
      el('div', { className: 'stat-row' }, el('span', { className: 'label' }, '問題数'), el('span', { className: 'value' }, activeQ.length)),
      el('div', { className: 'stat-row' }, el('span', { className: 'label' }, '未解答'), el('span', { className: `value ${unseenCount > 50 ? 'good' : unseenCount > 20 ? 'mid' : 'bad'}` }, unseenCount))
    );
    page.appendChild(poolCard);

    // Fetch AI coach strategy
    try {
      const res = await fetch('/api/strategy');
      const data = await res.json();
      if (data.ok && data.strategy) {
        const s = data.strategy;
        const coachCard = el('div', { className: 'card' });
        coachCard.appendChild(el('h2', null, 'AI Coach'));

        if (s.coachMessage) {
          coachCard.appendChild(el('p', { style: { fontSize: '14px', lineHeight: '1.6', marginBottom: '8px' } }, s.coachMessage));
        }

        if (s.analysis) {
          const a = s.analysis;
          if (a.readiness !== undefined) {
            coachCard.appendChild(el('div', { className: 'stat-row' },
              el('span', { className: 'label' }, '合格推定'),
              el('span', { className: `value ${a.readiness >= 70 ? 'good' : a.readiness >= 50 ? 'mid' : 'bad'}` }, `${a.readiness}%`)
            ));
          }
          if (a.overallAccuracy !== undefined) {
            coachCard.appendChild(el('div', { className: 'stat-row' },
              el('span', { className: 'label' }, '正答率'),
              el('span', { className: `value ${a.overallAccuracy >= 70 ? 'good' : a.overallAccuracy >= 50 ? 'mid' : 'bad'}` }, `${a.overallAccuracy}%`)
            ));
          }
          if (a.weakPoints && a.weakPoints.length > 0) {
            coachCard.appendChild(el('div', { style: { marginTop: '6px' } },
              ...a.weakPoints.slice(0, 3).map(w => el('div', { className: 'tag-chip' }, w))
            ));
          }
        }

        page.appendChild(coachCard);
      }
    } catch { /* coach data not available yet */ }
  });

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(renderBottomNav('home'));
}

function navBtn(route, label, icon, active = false) {
  return el('button', { className: active ? 'active' : '', onClick: () => navigate(route), 'aria-label': label },
    el('span', { html: icon }),
    el('span', null, label)
  );
}

/* ---------- Session Page ---------- */
function renderSession(app) {
  if (!state.session) { navigate('home'); return; }
  const sess = state.session;
  const indices = state.reviewIndices || sess.questions.map((_, i) => i);
  const currentIndex = state.currentQ;
  const qIndex = indices[currentIndex];
  if (qIndex === undefined) { navigate('home'); return; }
  const qItem = sess.questions[qIndex];
  const qData = qItem.data || qItem;

  // Header
  const remaining = sess.timeLimit > 0 ? Math.max(0, sess.timeLimit * 60 - sess.elapsed) : -1;
  const header = el('div', { className: 'header' },
    el('button', { className: 'back-btn', onClick: () => confirmLeave(), 'aria-label': '戻る' }, '\u2190'),
    el('h1', null, state.reviewMode ? `見直し (${currentIndex + 1}/${indices.length})` : `${currentIndex + 1}/${indices.length}`),
    remaining >= 0 ? el('span', { className: 'timer', id: 'timer' }, formatTime(remaining)) : null
  );

  // Progress
  const progress = el('div', { className: 'progress-bar' },
    el('div', { className: 'fill', style: { width: `${pct(currentIndex + 1, indices.length)}%` } })
  );

  const page = el('div', { className: 'page' });
  page.appendChild(progress);

  // Question number & flag
  const qNum = el('div', { className: 'flex-between mb-8' },
    el('span', { className: 'q-number' }, `Q${qIndex + 1} [${TYPE_LABELS[qData.type]}] ${DOMAIN_LABELS[qData.domain] || qData.domain}`),
    sess.flags.has(qIndex) ? el('span', { className: 'flag-indicator' }, '\u2691') : null
  );
  page.appendChild(qNum);

  // Render question body by type
  if (qData.type === 'casestudy') {
    renderCasestudy(page, qData, qIndex);
  } else if (qData.type === 'dropdown') {
    // Dropdown renders its own prompt (with placeholders replaced)
    renderQuestionBody(page, qData, qIndex);
  } else {
    page.appendChild(el('div', { className: 'q-prompt' }, qData.prompt));
    renderQuestionBody(page, qData, qIndex);
  }

  // Explanation
  if (state.showExplanation || sess.finished) {
    renderExplanation(page, qData, qIndex);
  }

  app.appendChild(header);
  app.appendChild(page);

  // Session bottom bar - simplified, prominent next button
  const isLast = currentIndex >= indices.length - 1;
  const bar = el('div', { className: 'session-bar' });

  bar.appendChild(el('button', { onClick: () => sessionNav(-1), disabled: currentIndex === 0, 'aria-label': '前の問題' },
    el('span', { html: icons.prev }), el('span', null, '前へ')));

  bar.appendChild(el('button', { className: sess.flags.has(qIndex) ? 'flag-on' : '', onClick: () => toggleFlag(qIndex), 'aria-label': 'フラグ切替' },
    el('span', { html: icons.flag }), el('span', null, 'フラグ')));

  if (!sess.finished) {
    bar.appendChild(el('button', { onClick: () => {
      state.showExplanation = !state.showExplanation;
      // Instant-grade current question when showing explanation
      if (state.showExplanation) {
        const correct = gradeAnswer(qItem, sess.answers[qIndex]);
        sess.graded[qIndex] = correct;
        sess._revealed = sess._revealed || new Set();
        sess._revealed.add(qIndex);
      }
      render();
    }, 'aria-label': '解説表示' },
      el('span', { html: icons.explain }), el('span', null, '解説')));
  } else {
    bar.appendChild(el('button', { onClick: () => showReviewMenu(), 'aria-label': '見直しメニュー' },
      el('span', { html: icons.list }), el('span', null, '見直し')));
  }

  if (!sess.finished && isLast) {
    bar.appendChild(el('button', { className: 'active finish-btn', onClick: () => finishSession(), 'aria-label': '採点' },
      el('span', { html: icons.check }), el('span', null, '採点')));
  } else if (sess.finished) {
    bar.appendChild(el('button', { className: 'active', onClick: () => navigate('result'), 'aria-label': '結果' },
      el('span', { html: icons.chart }), el('span', null, '結果')));
  } else {
    bar.appendChild(el('button', { className: 'active next-btn', onClick: () => sessionNav(1), 'aria-label': '次の問題' },
      el('span', { html: icons.next }), el('span', null, '次へ')));
  }

  app.appendChild(bar);

  // Swipe gesture support
  setupSwipe(page);
}

function sessionNav(dir) {
  const indices = state.reviewIndices || state.session.questions.map((_, i) => i);
  const next = state.currentQ + dir;
  if (next >= 0 && next < indices.length) {
    state.currentQ = next;
    state.showExplanation = false;
    render();
    window.scrollTo(0, 0);
  }
}

/* -- Swipe gesture for session page -- */
function setupSwipe(el) {
  let startX = 0, startY = 0, tracking = false;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return; // too short or too vertical
    if (dx < 0) sessionNav(1);   // swipe left = next
    else sessionNav(-1);         // swipe right = prev
  }, { passive: true });
}

/* -- Auto-next after answering (single choice only, practice mode) -- */
let _autoNextTimer = null;
function triggerAutoNext() {
  if (!settings.autoNext) return;
  if (!state.session || state.session.finished) return;
  if (state.session.mode === 'exam') return; // don't auto-next in exam
  const indices = state.reviewIndices || state.session.questions.map((_, i) => i);
  if (state.currentQ >= indices.length - 1) return;
  clearTimeout(_autoNextTimer);
  _autoNextTimer = setTimeout(() => sessionNav(1), settings.autoNextDelay);
}

function toggleFlag(qIndex) {
  if (state.session.flags.has(qIndex)) state.session.flags.delete(qIndex);
  else state.session.flags.add(qIndex);
  render();
}

async function confirmLeave() {
  if (state.session && !state.session.finished) {
    const answered = state.session.questions.map((_, i) => i).filter(i => state.session.answers[i] !== undefined);
    const msg = answered.length > 0
      ? `セッションを中断しますか？\n解答済み ${answered.length}問 は記録されます。`
      : 'セッションを中断しますか？';
    if (confirm(msg)) {
      stopTimer();
      const sess = state.session;
      // Grade and save answered questions
      if (answered.length > 0) {
        for (const i of answered) {
          const q = sess.questions[i];
          const correct = gradeAnswer(q, sess.answers[i]);
          sess.graded[i] = correct;
          await IDB.addHistory({
            qid: q.qid, domain: q.domain, type: q.type,
            tags: q.tags || [], correct, ts: Date.now()
          });
        }
        pushRecentQids(answered.map(i => sess.questions[i].qid));
        await IDB.saveSession({
          id: sess.id, mode: sess.mode,
          questionCount: answered.length,
          correctCount: Object.values(sess.graded).filter(Boolean).length,
          elapsed: sess.elapsed,
          startedAt: sess.startedAt, finishedAt: Date.now(),
          partial: true,
          domainStats: computeDomainStats(),
          typeStats: computeTypeStats(),
          tagStats: computeTagStats()
        });
        backupProgress().catch(() => {});
        toast(`${answered.length}問の解答を保存しました`);
      }
      state.session = null;
      navigate('home');
    }
  } else {
    state.session = null;
    navigate('home');
  }
}

function showReviewMenu() {
  const sess = state.session;
  const flagged = [...sess.flags].sort((a, b) => a - b);
  const wrong = Object.entries(sess.graded).filter(([, v]) => !v).map(([k]) => parseInt(k)).sort((a, b) => a - b);
  const unanswered = sess.questions.map((_, i) => i).filter(i => sess.answers[i] === undefined);

  const overlay = el('div', {
    style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
    onClick: e => { if (e.target === overlay) overlay.remove(); }
  });
  const menu = el('div', { className: 'card', style: { width: '100%', maxWidth: '360px' } },
    el('h2', null, '見直し'),
    el('button', { className: 'btn btn-block mb-8', onClick: () => { overlay.remove(); setReview(null); } }, `全問 (${sess.questions.length})`),
    el('button', { className: 'btn btn-block mb-8', onClick: () => { overlay.remove(); setReview('flagged', flagged); } }, `フラグ付き (${flagged.length})`),
    el('button', { className: 'btn btn-block mb-8', onClick: () => { overlay.remove(); setReview('wrong', wrong); } }, `不正解 (${wrong.length})`),
    el('button', { className: 'btn btn-block', onClick: () => { overlay.remove(); setReview('unanswered', unanswered); } }, `未解答 (${unanswered.length})`)
  );
  overlay.appendChild(menu);
  document.body.appendChild(overlay);
}

function setReview(mode, indices) {
  state.reviewMode = mode;
  state.reviewIndices = indices || null;
  state.currentQ = 0;
  state.showExplanation = false;
  render();
}

/* ---------- Question Body Renderers ---------- */
function renderQuestionBody(container, qData, qIndex) {
  switch (qData.type) {
    case 'single': renderSingleMulti(container, qData, qIndex, false); break;
    case 'multi': renderSingleMulti(container, qData, qIndex, true); break;
    case 'dropdown': renderDropdown(container, qData, qIndex); break;
    case 'match': renderMatch(container, qData, qIndex); break;
    case 'order': renderOrder(container, qData, qIndex); break;
    case 'hotarea': renderHotarea(container, qData, qIndex); break;
  }
}

function getAnswer(qIndex) {
  return state.session.answers[qIndex];
}
function setAnswer(qIndex, val) {
  state.session.answers[qIndex] = val;
}

function renderSingleMulti(container, qData, qIndex, isMulti) {
  const current = getAnswer(qIndex) || [];
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;
  const locked = finished || (revealed && state.showExplanation);
  const list = el('div', { className: 'choice-list' });

  const shuf = sess.shuffles && sess.shuffles[qIndex];
  const choiceOrder = (shuf && shuf.choices) || qData.choices.map((_, i) => i);

  choiceOrder.forEach(origIdx => {
    const choice = qData.choices[origIdx];
    const selected = current.includes(origIdx);
    let cls = 'choice-item';
    if (selected) cls += ' selected';
    if (showResult) {
      if (qData.answer.includes(origIdx)) cls += ' correct';
      else if (selected) cls += ' wrong';
    }

    const item = el('div', { className: cls, onClick: () => {
      if (locked) return;
      let ans = [...(getAnswer(qIndex) || [])];
      if (isMulti) {
        if (ans.includes(origIdx)) ans = ans.filter(x => x !== origIdx);
        else ans.push(origIdx);
      } else {
        ans = [origIdx];
      }
      setAnswer(qIndex, ans);
      // Clear revealed state if user changes answer
      if (sess._revealed) sess._revealed.delete(qIndex);
      delete sess.graded[qIndex];
      state.showExplanation = false;
      render();
      if (!isMulti) triggerAutoNext();
    }},
      el('div', { className: 'indicator' + (isMulti ? ' check' : '') }),
      el('div', { className: 'choice-text' }, choice)
    );
    list.appendChild(item);
  });
  container.appendChild(list);
}

function renderDropdown(container, qData, qIndex) {
  const current = getAnswer(qIndex) || qData.dropdowns.map(() => -1);
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;

  const shuf = sess.shuffles && sess.shuffles[qIndex];
  const ddShuffles = (shuf && shuf.dropdowns) || null;

  // Split prompt by {{i}}
  let promptHtml = qData.prompt;
  qData.dropdowns.forEach((dd, i) => {
    const placeholder = `{{${i}}}`;
    const selectId = `dd-${qIndex}-${i}`;
    let selectHtml;
    if (showResult) {
      const userVal = current[i];
      const correctVal = dd.answer;
      const isCorrect = userVal === correctVal;
      const userText = userVal >= 0 && userVal < dd.options.length ? dd.options[userVal] : '(未選択)';
      const color = isCorrect ? 'var(--ok)' : 'var(--err)';
      selectHtml = `<span style="color:${color};font-weight:600;border-bottom:2px solid ${color};padding:2px 6px">${userText}</span>`;
      if (!isCorrect) {
        selectHtml += ` <span style="color:var(--ok);font-size:13px">[正解: ${dd.options[correctVal]}]</span>`;
      }
    } else {
      const optOrder = (ddShuffles && ddShuffles[i]) || dd.options.map((_, oi) => oi);
      const opts = optOrder.map(origOi => `<option value="${origOi}" ${current[i] === origOi ? 'selected' : ''}>${dd.options[origOi]}</option>`).join('');
      selectHtml = `<span class="dropdown-blank"><select id="${selectId}" data-dd="${i}"><option value="-1">-- 選択 --</option>${opts}</select></span>`;
    }
    promptHtml = promptHtml.replace(placeholder, selectHtml);
  });

  const promptEl = el('div', { className: 'q-prompt', html: promptHtml });
  container.appendChild(promptEl);

  if (!showResult) {
    // Attach event listeners after render
    setTimeout(() => {
      qData.dropdowns.forEach((_, i) => {
        const sel = document.getElementById(`dd-${qIndex}-${i}`);
        if (sel) sel.addEventListener('change', () => {
          const ans = [...(getAnswer(qIndex) || qData.dropdowns.map(() => -1))];
          ans[i] = parseInt(sel.value);
          setAnswer(qIndex, ans);
        });
      });
    }, 0);
  }
}

function renderMatch(container, qData, qIndex) {
  const current = getAnswer(qIndex) || {};
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;

  // Use shuffled orders from session.shuffles
  const shuf = sess.shuffles && sess.shuffles[qIndex];
  const leftOrder = (shuf && shuf.left) || qData.left.map((_, i) => i);
  const rightOptions = (shuf && shuf.right) || qData.right;

  const area = el('div', { className: 'match-area' });

  // Use select-based matching for mobile
  leftOrder.forEach(origLeftIdx => {
    const leftItem = qData.left[origLeftIdx];
    const row = el('div', { className: 'match-row' });
    const leftEl = el('div', { className: 'match-left' }, leftItem);
    const rightEl = el('div', { className: 'match-right' });

    if (showResult) {
      const userVal = current[leftItem];
      const correctVal = qData.answerMap[leftItem];
      const isCorrect = userVal === correctVal;
      const color = isCorrect ? 'var(--ok)' : 'var(--err)';
      const display = el('div', { style: { color, fontWeight: '600', padding: '8px', fontSize: '14px' } },
        userVal || '(未選択)');
      if (!isCorrect) {
        display.appendChild(el('div', { style: { color: 'var(--ok)', fontSize: '12px' } }, `正解: ${correctVal}`));
      }
      rightEl.appendChild(display);
    } else {
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;min-height:44px;background:var(--bg);color:var(--fg);border:1px solid rgba(255,255,255,.15);border-radius:var(--radius);padding:8px;font-size:14px';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '-- 選択 --';
      sel.appendChild(emptyOpt);
      rightOptions.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        if (current[leftItem] === r) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        const ans = { ...(getAnswer(qIndex) || {}) };
        if (sel.value) ans[leftItem] = sel.value;
        else delete ans[leftItem];
        setAnswer(qIndex, ans);
      });
      rightEl.appendChild(sel);
    }

    row.appendChild(leftEl);
    row.appendChild(rightEl);
    area.appendChild(row);
  });
  container.appendChild(area);
}

function renderOrder(container, qData, qIndex) {
  const shuf = state.session.shuffles && state.session.shuffles[qIndex];
  const current = getAnswer(qIndex) || (shuf && shuf.init) || qData.items.map((_, i) => i);
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;

  const wrap = el('div');
  current.forEach((itemIdx, pos) => {
    const item = qData.items[itemIdx];
    let cls = 'order-item';
    if (showResult) {
      const correctAtPos = qData.answerOrder[pos];
      if (itemIdx === correctAtPos) cls += ' correct';
      else cls += ' wrong';
    }

    const row = el('div', { className: cls },
      el('span', { style: { color: 'var(--accent)', fontWeight: '600', minWidth: '24px' } }, `${pos + 1}.`),
      el('div', { className: 'order-text' }, item)
    );

    if (!showResult) {
      const btns = el('div', { className: 'order-btns' },
        el('button', { disabled: pos === 0, onClick: () => moveOrder(qIndex, current, pos, -1), 'aria-label': '上へ移動' }, '\u25B2'),
        el('button', { disabled: pos === current.length - 1, onClick: () => moveOrder(qIndex, current, pos, 1), 'aria-label': '下へ移動' }, '\u25BC')
      );
      row.appendChild(btns);
    }
    wrap.appendChild(row);
  });

  if (showResult) {
    const correctOrder = qData.answerOrder.map(i => qData.items[i]);
    wrap.appendChild(el('div', { className: 'text-muted mt-8' }, '正しい順序: ' + correctOrder.join(' → ')));
  }
  container.appendChild(wrap);
}

function moveOrder(qIndex, current, pos, dir) {
  const arr = [...current];
  const newPos = pos + dir;
  [arr[pos], arr[newPos]] = [arr[newPos], arr[pos]];
  setAnswer(qIndex, arr);
  render();
}

function renderHotarea(container, qData, qIndex) {
  const current = getAnswer(qIndex) || [];
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;
  const locked = finished || (revealed && state.showExplanation);
  const grid = qData.grid;

  const shuf = sess.shuffles && sess.shuffles[qIndex];
  const cellOrder = (shuf && shuf.cells) || grid.cells.map((_, i) => i);

  const gridEl = el('div', {
    className: 'hotarea-grid',
    style: { gridTemplateColumns: `repeat(${grid.cols}, 1fr)` }
  });

  cellOrder.forEach(origCi => {
    const cell = grid.cells[origCi];
    let cls = 'hotarea-cell';
    const selected = current.includes(origCi);
    if (selected) cls += ' selected';
    if (showResult) {
      if (qData.answer.includes(origCi)) cls += ' correct';
      else if (selected) cls += ' wrong';
    }

    const cellEl = el('div', { className: cls, onClick: () => {
      if (locked) return;
      let ans = [...(getAnswer(qIndex) || [])];
      if (ans.includes(origCi)) ans = ans.filter(x => x !== origCi);
      else ans.push(origCi);
      setAnswer(qIndex, ans);
      if (sess._revealed) sess._revealed.delete(qIndex);
      delete sess.graded[qIndex];
      state.showExplanation = false;
      render();
    }}, cell);
    gridEl.appendChild(cellEl);
  });
  container.appendChild(gridEl);
  if (!locked) {
    container.appendChild(el('p', { className: 'text-muted mt-8' }, '正しいセルをタップして選択してください。'));
  }
}

function renderCasestudy(container, qData, qIndex) {
  const sess = state.session;
  const finished = sess.finished;
  const revealed = sess._revealed && sess._revealed.has(qIndex);
  const showResult = finished || revealed;

  // Scenario
  container.appendChild(el('div', { className: 'cs-scenario' }, qData.prompt));

  // Sub-question tabs
  const subs = qData.subQuestions;
  const currentSub = state._csSub || 0;

  const tabs = el('div', { className: 'cs-tabs' });
  subs.forEach((sq, si) => {
    // Show per-sub grade indicator in tab
    let tabLabel = `設問${si + 1}`;
    if (showResult) {
      const parentAnswer = getAnswer(qIndex) || {};
      const subCorrect = gradeAnswer({ data: sq }, parentAnswer[sq.id]);
      tabLabel += subCorrect ? ' ○' : ' ×';
    }
    tabs.appendChild(el('button', {
      className: si === currentSub ? 'active' : '',
      onClick: () => { state._csSub = si; render(); }
    }, tabLabel));
  });
  container.appendChild(tabs);

  // Current sub-question
  const sq = subs[currentSub];
  const parentAnswer = getAnswer(qIndex) || {};

  container.appendChild(el('div', { className: 'q-prompt' }, sq.prompt));

  // Create a mini-render context
  const subContainer = el('div');
  renderSubQuestion(subContainer, sq, qIndex, currentSub, showResult);
  container.appendChild(subContainer);

  // Explanation for current sub
  if ((state.showExplanation || finished) && sq.explanation) {
    const subCorrect = gradeAnswer({ data: sq }, parentAnswer[sq.id]);
    const expEl = el('div', { className: 'explanation' },
      el('h4', { style: { color: showResult ? (subCorrect ? 'var(--ok)' : 'var(--err)') : 'var(--accent)' } },
        showResult ? (subCorrect ? `設問${currentSub + 1} 正解!` : `設問${currentSub + 1} 不正解`) : `設問${currentSub + 1} 解説`),
      el('p', null, sq.explanation)
    );
    container.appendChild(expEl);
  }
}

function renderSubQuestion(container, sq, parentQIndex, subIndex, showResult) {
  const sess = state.session;
  const finished = sess.finished;
  const locked = finished || (showResult && state.showExplanation);
  const parentAnswer = getAnswer(parentQIndex) || {};
  const current = parentAnswer[sq.id];

  const parentShuf = sess.shuffles && sess.shuffles[parentQIndex];
  const subShuf = parentShuf && parentShuf.subs && parentShuf.subs[sq.id];

  switch (sq.type) {
    case 'single':
    case 'multi': {
      const isMulti = sq.type === 'multi';
      const cur = current || [];
      const list = el('div', { className: 'choice-list' });
      const choiceOrder = (subShuf && subShuf.choices) || sq.choices.map((_, i) => i);
      choiceOrder.forEach(origIdx => {
        const choice = sq.choices[origIdx];
        const selected = cur.includes(origIdx);
        let cls = 'choice-item';
        if (selected) cls += ' selected';
        if (showResult) {
          if (sq.answer.includes(origIdx)) cls += ' correct';
          else if (selected) cls += ' wrong';
        }
        list.appendChild(el('div', { className: cls, onClick: () => {
          if (locked) return;
          const ans = { ...(getAnswer(parentQIndex) || {}) };
          let arr = [...(ans[sq.id] || [])];
          if (isMulti) {
            if (arr.includes(origIdx)) arr = arr.filter(x => x !== origIdx);
            else arr.push(origIdx);
          } else {
            arr = [origIdx];
          }
          ans[sq.id] = arr;
          setAnswer(parentQIndex, ans);
          // Clear revealed state on answer change
          if (sess._revealed) sess._revealed.delete(parentQIndex);
          delete sess.graded[parentQIndex];
          state.showExplanation = false;
          render();
        }},
          el('div', { className: 'indicator' + (isMulti ? ' check' : '') }),
          el('div', { className: 'choice-text' }, choice)
        ));
      });
      container.appendChild(list);
      break;
    }
    case 'dropdown': {
      const cur = current || sq.dropdowns.map(() => -1);
      const ddShuffles = (subShuf && subShuf.dropdowns) || null;
      let html = sq.prompt;
      sq.dropdowns.forEach((dd, i) => {
        const selectId = `csdd-${parentQIndex}-${sq.id}-${i}`;
        if (showResult) {
          const uv = cur[i];
          const cv = dd.answer;
          const ok = uv === cv;
          const ut = uv >= 0 ? dd.options[uv] : '(未選択)';
          const color = ok ? 'var(--ok)' : 'var(--err)';
          let h = `<span style="color:${color};font-weight:600">${ut}</span>`;
          if (!ok) h += ` <span style="color:var(--ok);font-size:12px">[正解: ${dd.options[cv]}]</span>`;
          html = html.replace(`{{${i}}}`, h);
        } else {
          const optOrder = (ddShuffles && ddShuffles[i]) || dd.options.map((_, oi) => oi);
          const opts = optOrder.map(origOi => `<option value="${origOi}" ${cur[i] === origOi ? 'selected' : ''}>${dd.options[origOi]}</option>`).join('');
          html = html.replace(`{{${i}}}`, `<span class="dropdown-blank"><select id="${selectId}"><option value="-1">-- 選択 --</option>${opts}</select></span>`);
        }
      });
      container.appendChild(el('div', { html }));
      if (!showResult) {
        setTimeout(() => {
          sq.dropdowns.forEach((_, i) => {
            const s = document.getElementById(`csdd-${parentQIndex}-${sq.id}-${i}`);
            if (s) s.addEventListener('change', () => {
              const ans = { ...(getAnswer(parentQIndex) || {}) };
              const arr = [...(ans[sq.id] || sq.dropdowns.map(() => -1))];
              arr[i] = parseInt(s.value);
              ans[sq.id] = arr;
              setAnswer(parentQIndex, ans);
            });
          });
        }, 0);
      }
      break;
    }
    default:
      container.appendChild(el('p', { className: 'text-muted' }, `(${TYPE_LABELS[sq.type] || sq.type})`));
  }
}

function renderExplanation(container, qData, qIndex) {
  if (qData.type === 'casestudy') return; // handled in casestudy renderer

  const sess = state.session;
  const graded = sess.graded[qIndex] !== undefined;
  const correct = graded ? sess.graded[qIndex] : undefined;

  const expEl = el('div', { className: 'explanation' });
  if (graded) {
    expEl.appendChild(el('h4', { style: { color: correct ? 'var(--ok)' : 'var(--err)' } }, correct ? '正解!' : '不正解'));
  } else {
    expEl.appendChild(el('h4', null, '解説'));
  }
  expEl.appendChild(el('p', null, qData.explanation));

  if (qData.sources && qData.sources.length > 0) {
    const srcDiv = el('div', { className: 'sources' });
    srcDiv.appendChild(el('strong', null, '参考: '));
    qData.sources.forEach((s, i) => {
      if (i > 0) srcDiv.appendChild(document.createTextNode(' | '));
      srcDiv.appendChild(el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title));
    });
    expEl.appendChild(srcDiv);
  }
  container.appendChild(expEl);
}

/* ---------- Result Page ---------- */
function renderResult(app) {
  if (!state.session || !state.session.finished) { navigate('home'); return; }
  const sess = state.session;
  const total = sess.questions.length;
  const correct = Object.values(sess.graded).filter(Boolean).length;
  const score = pct(correct, total);

  const header = el('div', { className: 'header' },
    el('button', { className: 'back-btn', onClick: () => navigate('home'), 'aria-label': '戻る' }, '\u2190'),
    el('h1', null, '結果')
  );

  const page = el('div', { className: 'page' });

  // Score
  const scoreCard = el('div', { className: 'card text-center' },
    el('div', { className: 'score-big' }, `${score}%`, el('small', null, ` (${correct}/${total})`)),
    el('p', { className: 'text-muted' }, `所要時間: ${formatTime(sess.elapsed)} / ${sess.mode === 'exam' ? `制限: ${sess.timeLimit}分` : '練習モード'}`),
    score >= 70
      ? el('p', { style: { color: 'var(--ok)', fontWeight: '600', marginTop: '8px' } }, '合格ライン到達!')
      : el('p', { style: { color: 'var(--err)', fontWeight: '600', marginTop: '8px' } }, '合格ラインは70%です')
  );
  page.appendChild(scoreCard);

  // Domain stats
  const ds = computeDomainStats();
  const domainCard = el('div', { className: 'card' }, el('h2', null, '分野別'));
  for (const d of DOMAINS) {
    const r = pct(ds[d].correct, ds[d].total);
    domainCard.appendChild(el('div', { className: 'stat-row' },
      el('span', { className: 'label' }, DOMAIN_LABELS[d] || d),
      el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}% (${ds[d].correct}/${ds[d].total})`)
    ));
  }
  page.appendChild(domainCard);

  // Type stats
  const ts = computeTypeStats();
  const typeCard = el('div', { className: 'card' }, el('h2', null, '形式別'));
  for (const t of TYPES) {
    if (ts[t].total === 0) continue;
    const r = pct(ts[t].correct, ts[t].total);
    typeCard.appendChild(el('div', { className: 'stat-row' },
      el('span', { className: 'label' }, TYPE_LABELS[t] || t),
      el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}% (${ts[t].correct}/${ts[t].total})`)
    ));
  }
  page.appendChild(typeCard);

  // Tag stats
  const tgs = computeTagStats();
  const tagEntries = Object.entries(tgs).filter(([, v]) => v.total > 0).sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));
  if (tagEntries.length > 0) {
    const tagCard = el('div', { className: 'card' }, el('h2', null, 'タグ別'));
    tagEntries.slice(0, 10).forEach(([tag, v]) => {
      const r = pct(v.correct, v.total);
      tagCard.appendChild(el('div', { className: 'stat-row' },
        el('span', { className: 'label' }, tag),
        el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}%`)
      ));
    });
    page.appendChild(tagCard);
  }

  // Weakness
  const weakDomains = DOMAINS.map(d => ({ name: DOMAIN_LABELS[d], rate: ds[d].total > 0 ? ds[d].correct / ds[d].total : 1 })).sort((a, b) => a.rate - b.rate).slice(0, 3);
  const weakTypes = TYPES.map(t => ({ name: TYPE_LABELS[t], rate: ts[t].total > 0 ? ts[t].correct / ts[t].total : 1 })).sort((a, b) => a.rate - b.rate).slice(0, 3);

  const weakCard = el('div', { className: 'card' },
    el('h2', null, '苦手ポイント'),
    el('h3', null, '弱い分野'),
    ...weakDomains.map(w => el('div', { className: 'stat-row' }, el('span', { className: 'label' }, w.name), el('span', { className: 'value bad' }, `${Math.round(w.rate * 100)}%`))),
    el('h3', { className: 'mt-8' }, '弱い形式'),
    ...weakTypes.map(w => el('div', { className: 'stat-row' }, el('span', { className: 'label' }, w.name), el('span', { className: 'value bad' }, `${Math.round(w.rate * 100)}%`)))
  );
  page.appendChild(weakCard);

  // Actions
  const actCard = el('div', { className: 'card grid-2' },
    el('button', { className: 'btn btn-block', onClick: () => { state.currentQ = 0; state.reviewMode = null; state.reviewIndices = null; navigate('session'); } }, '全問見直し'),
    el('button', { className: 'btn btn-primary btn-block', onClick: () => { state.session = null; navigate('home'); } }, 'ホームへ')
  );
  page.appendChild(actCard);

  app.appendChild(header);
  app.appendChild(page);
}

/* ---------- Stats Page ---------- */
function renderStats(app) {
  const header = el('div', { className: 'header' }, el('h1', null, '統計'));
  const page = el('div', { className: 'page' });

  IDB.getAllSessions().then(sessions => {
    sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    if (sessions.length === 0) {
      page.appendChild(el('p', { className: 'text-muted text-center mt-16' }, 'まだセッション履歴がありません。'));
    } else {
      // Overall
      const totalQ = sessions.reduce((s, x) => s + x.questionCount, 0);
      const totalC = sessions.reduce((s, x) => s + x.correctCount, 0);
      const overallCard = el('div', { className: 'card' },
        el('h2', null, '全体統計'),
        el('div', { className: 'stat-row' }, el('span', { className: 'label' }, 'セッション数'), el('span', { className: 'value' }, sessions.length)),
        el('div', { className: 'stat-row' }, el('span', { className: 'label' }, '解答数'), el('span', { className: 'value' }, totalQ)),
        el('div', { className: 'stat-row' }, el('span', { className: 'label' }, '正答率'), el('span', { className: 'value' }, `${pct(totalC, totalQ)}%`))
      );
      page.appendChild(overallCard);

      // Domain weakness (aggregated from recent 7 days)
      IDB.getRecentHistory(7).then(history => {
        if (history.length === 0) return;
        const domainAgg = {};
        const tagAgg = {};
        for (const h of history) {
          if (!domainAgg[h.domain]) domainAgg[h.domain] = { correct: 0, total: 0 };
          domainAgg[h.domain].total++;
          if (h.correct) domainAgg[h.domain].correct++;
          for (const tag of (h.tags || [])) {
            if (!tagAgg[tag]) tagAgg[tag] = { correct: 0, total: 0 };
            tagAgg[tag].total++;
            if (h.correct) tagAgg[tag].correct++;
          }
        }

        const weakCard = el('div', { className: 'card' },
          el('h2', null, '直近7日の傾向')
        );
        const sortedDomains = Object.entries(domainAgg).sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));
        sortedDomains.forEach(([d, v]) => {
          const r = pct(v.correct, v.total);
          weakCard.appendChild(el('div', { className: 'stat-row' },
            el('span', { className: 'label' }, DOMAIN_LABELS[d] || d),
            el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}% (${v.total}問)`)
          ));
        });

        // Worst tags
        const sortedTags = Object.entries(tagAgg).filter(([, v]) => v.total >= 2).sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));
        if (sortedTags.length > 0) {
          weakCard.appendChild(el('h3', { className: 'mt-8' }, 'ミスの多いタグ (Top 5)'));
          sortedTags.slice(0, 5).forEach(([tag, v]) => {
            const r = pct(v.correct, v.total);
            weakCard.appendChild(el('div', { className: 'stat-row' },
              el('span', { className: 'label' }, tag),
              el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}% (${v.total}問)`)
            ));
          });
        }
        page.appendChild(weakCard);

      });

      // Session history
      const histCard = el('div', { className: 'card' }, el('h2', null, 'セッション履歴'));
      sessions.slice(0, 20).forEach(s => {
        const date = new Date(s.startedAt).toLocaleDateString('ja-JP');
        const r = pct(s.correctCount, s.questionCount);
        histCard.appendChild(el('div', { className: 'stat-row' },
          el('span', { className: 'label' }, `${date} (${s.mode === 'exam' ? '模試' : '練習'})`),
          el('span', { className: `value ${r >= 70 ? 'good' : r >= 50 ? 'mid' : 'bad'}` }, `${r}% (${s.correctCount}/${s.questionCount})`)
        ));
      });
      page.appendChild(histCard);
    }
  });

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(renderBottomNav('stats'));
}

/* ---------- Settings Page ---------- */
function renderSettings(app) {
  const header = el('div', { className: 'header' }, el('h1', null, '設定'));
  const page = el('div', { className: 'page' });

  // Exam settings
  const examCard = el('div', { className: 'card' },
    el('h2', null, '出題設定'),
    el('label', null, '問題数'),
    el('input', { type: 'number', id: 'set-count', value: settings.questionCount, min: '5', max: '200' }),
    el('label', null, '模試制限時間 (分)'),
    el('input', { type: 'number', id: 'set-time', value: settings.timeLimit, min: '1', max: '180' })
  );
  page.appendChild(examCard);

  // Save
  page.appendChild(el('button', { className: 'btn btn-primary btn-block mb-16', onClick: saveSettingsUI }, '保存'));

  // Data management
  const dataCard = el('div', { className: 'card' },
    el('h2', null, 'データ'),
    el('button', { className: 'btn btn-danger btn-block mt-8', onClick: async () => {
      if (confirm('全データを削除しますか？（パック・履歴すべて）')) {
        indexedDB.deleteDatabase('ai900app');
        localStorage.clear();
        location.reload();
      }
    }}, '全データリセット')
  );
  page.appendChild(dataCard);

  page.appendChild(el('p', { className: 'text-muted text-center mt-16' }, `AI-900 練習アプリ v${APP_VERSION}`));

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(renderBottomNav('settings'));
}

function saveSettingsUI() {
  const count = parseInt(document.getElementById('set-count')?.value) || 50;
  const time = parseInt(document.getElementById('set-time')?.value) || 45;
  settings = { ...settings, questionCount: count, timeLimit: time };
  saveSettings(settings);
  toast('保存しました');
}

/* ---------- Bottom Nav ---------- */
function renderBottomNav(active) {
  return el('div', { className: 'bottom-bar' },
    navBtn('home', 'ホーム', icons.home, active === 'home'),
    navBtn('stats', '統計', icons.chart, active === 'stats'),
    navBtn('settings', '設定', icons.gear, active === 'settings')
  );
}

/* ========== INIT ========== */
async function init() {
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW registration failed:', e));
  }

  await IDB.open();

  // Restore progress from cloud backup if local data is empty
  const existingHistory = await IDB.getAllHistory();
  if (existingHistory.length === 0) {
    await restoreProgress();
  }

  // Check for new packs on every launch (auto-import missing packs)
  try {
    const idxResp = await fetch('/packs/index.json');
    if (idxResp.ok) {
      const idx = await idxResp.json();
      const packs = await IDB.getAllPacks();
      const installedIds = new Set(packs.map(p => p.id));
      const newPacks = idx.packs.filter(e => !installedIds.has(e.id));
      if (newPacks.length > 0) {
        if (packs.length === 0) toast('初期パックを読み込み中...');
        else toast(`新しいパック ${newPacks.length}件 を追加中...`);
        await IDB.saveRepo({ url: '/packs/index.json', addedAt: Date.now() });
        for (const entry of newPacks) {
          const packResp = await fetch(entry.url);
          if (packResp.ok) {
            const packJson = await packResp.json();
            const result = await importPack(packJson);
            console.log('Loaded pack:', entry.id, result);
          }
        }
      }
    }
  } catch (e) { console.error('Failed to check packs:', e); }

  navigate(location.hash.slice(1) || 'home');
}

init();
