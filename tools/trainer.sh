#!/bin/bash
# =============================================================================
# AI-900 Personal Trainer (Unified Daemon)
# =============================================================================
#
# Event-driven: only works when the user actually finishes a session.
# Idle cost: 1 tiny GET /api/status per poll (~144/day = essentially free)
#
# Flow:
#   1. Poll /api/status (few bytes)
#   2. If lastBackupAt > lastAnalyzedAt → user finished a session
#   3. Opus: deep analysis + strategy + question generation
#   4. Sonnet: compute optimal next session
#   5. Mark as analyzed → go back to sleep
#
# Usage:
#   bash tools/trainer.sh              # Run one cycle
#   bash tools/trainer.sh --watch      # Persistent daemon
#
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/.."

APP_URL="https://ai900-pwa.pages.dev"
PACKS_DIR="public/packs"
LOG_DIR="logs"
LOCK_FILE="/tmp/ai900-trainer.lock"
POLL_INTERVAL=600  # 10 minutes

mkdir -p "$LOG_DIR"

log()     { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/trainer.log"; }
log_err() { echo "[$(date '+%m-%d %H:%M:%S')] ERR $*" | tee -a "$LOG_DIR/trainer.log" >&2; }

cleanup() { rm -f "$LOCK_FILE"; log "Trainer stopped."; }

# ---- Lightweight status check (few bytes) ----
check_needed() {
  local resp
  resp=$(curl -sf --max-time 5 "${APP_URL}/api/status" 2>/dev/null || echo "")
  if [ -z "$resp" ]; then echo "offline"; return; fi
  echo "$resp" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.needsAnalysis ? 'yes' : 'no');
  " 2>/dev/null || echo "error"
}

# ---- Main cycle ----
run_cycle() {
  # Lock
  if [ -f "$LOCK_FILE" ]; then
    local pid; pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
    rm -f "$LOCK_FILE"
  fi
  echo $$ > "$LOCK_FILE"

  local needed
  needed=$(check_needed)

  if [ "$needed" != "yes" ]; then
    [ "$needed" = "offline" ] && log "API offline. Skipping." || log "No new sessions. Idle."
    rm -f "$LOCK_FILE"; return 0
  fi

  log "========================================"
  log " New session detected! Starting analysis"
  log "========================================"

  # ---- 1. Fetch full history ----
  local backup_resp
  backup_resp=$(curl -sf --max-time 15 "${APP_URL}/api/backup" 2>/dev/null)
  if [ -z "$backup_resp" ]; then
    log_err "Failed to fetch backup."; rm -f "$LOCK_FILE"; return 1
  fi

  # Pre-compute stats locally (fast, no AI needed)
  local stats_file="/tmp/ai900-stats-$$.json"
  echo "$backup_resp" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    if (!d.ok || !d.found) { console.log('{}'); process.exit(0); }
    const h = d.history || [];
    const sess = d.sessions || [];
    const uniqueQids = new Set();
    const byDomain = {}, byType = {};
    const wrongQids = [];

    for (const r of h) {
      uniqueQids.add(r.qid);
      const dom = r.domain || 'unknown', typ = r.type || 'unknown';
      if (!byDomain[dom]) byDomain[dom] = {c:0, t:0};
      if (!byType[typ]) byType[typ] = {c:0, t:0};
      byDomain[dom].t++; byType[typ].t++;
      if (r.correct) { byDomain[dom].c++; byType[typ].c++; }
      else wrongQids.push(r.qid);
    }

    // Pool info from packs on disk
    const fs = require('fs');
    let poolTotal = 0;
    const poolDomain = {}, allQids = [];
    for (const f of fs.readdirSync('${PACKS_DIR}')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const p = JSON.parse(fs.readFileSync('${PACKS_DIR}/'+f, 'utf8'));
        if (!p.questions) continue;
        for (const q of p.questions) {
          poolTotal++;
          allQids.push(p.pack.id + '::' + q.id);
          poolDomain[q.domain] = (poolDomain[q.domain]||0)+1;
        }
      } catch {}
    }

    const unseenCount = allQids.filter(id => !uniqueQids.has(id)).length;

    const out = {
      sessionCount: sess.length,
      totalAnswers: h.length,
      uniqueSeen: uniqueQids.size,
      pool: { total: poolTotal, byDomain: poolDomain, unseen: unseenCount },
      accuracy: { byDomain, byType },
      wrongQids: [...new Set(wrongQids)].slice(-30),
      allQids: allQids.slice(0, 100) // sample for sonnet
    };
    require('fs').writeFileSync('${stats_file}', JSON.stringify(out, null, 2));
    console.log(JSON.stringify({
      sessions: out.sessionCount,
      answers: out.totalAnswers,
      seen: out.uniqueSeen,
      pool: out.pool.total,
      unseen: out.pool.unseen
    }));
  " 2>/dev/null | while read line; do log "Stats: $line"; done

  local stats_content
  stats_content=$(cat "$stats_file")

  # ---- 2. Opus: Deep analysis + strategy ----
  log "Opus: Analyzing learning patterns..."
  local strategy_file="/tmp/ai900-strategy-$$.json"

  claude --model opus -p "あなたはAI-900試験対策の専門AIコーチです。
以下の学習統計を分析し、学習戦略をJSON形式で出力してください。JSONのみ出力。

■ 学習統計:
${stats_content}

■ 出力 (JSON):
{
  \"analysis\": {
    \"overallAccuracy\": (全体正答率%),
    \"domainAccuracy\": {\"Workloads\":%, \"ML\":%, \"CV\":%, \"NLP\":%, \"GenAI\":%},
    \"typeAccuracy\": {\"single\":%, \"multi\":%, ...},
    \"weakPoints\": [\"弱点1\", ...],
    \"strongPoints\": [\"強み1\", ...],
    \"trend\": \"improving|stable|declining\",
    \"readiness\": (合格推定%)
  },
  \"nextSession\": {
    \"domainWeights\": {\"Workloads\":0-100, ...各ドメインの出題比重},
    \"preferTypes\": [\"優先タイプ\"],
    \"targetDifficulty\": 1-5,
    \"unseenRatio\": 0.0-1.0,
    \"reviewQids\": [\"再出題すべきqid\"],
    \"sessionSize\": 15-25
  },
  \"generation\": {
    \"needed\": true/false,
    \"count\": 0-50,
    \"focusDomains\": [],
    \"focusTypes\": [],
    \"reason\": \"\"
  },
  \"coachMessage\": \"ユーザーへの具体的アドバイス（日本語2-3文）\"
}" > "$strategy_file" 2>&1

  local strategy
  strategy=$(node -e "
    const raw = require('fs').readFileSync('${strategy_file}','utf8');
    let j = raw;
    const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    if (m) j = m[1];
    const s = j.indexOf('{'), e = j.lastIndexOf('}');
    if (s>=0 && e>s) j = j.slice(s, e+1);
    console.log(JSON.stringify(JSON.parse(j.trim())));
  " 2>/dev/null || echo "")

  if [ -z "$strategy" ]; then
    log_err "Opus analysis failed to parse."
    rm -f "$stats_file" "$strategy_file" "$LOCK_FILE"; return 1
  fi

  # Upload strategy
  curl -sf --max-time 10 -X PUT -H "Content-Type: application/json" \
    -d "$strategy" "${APP_URL}/api/strategy" 2>/dev/null
  log "Strategy uploaded."

  # Log coach message
  local msg
  msg=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.coachMessage||'');" 2>/dev/null)
  [ -n "$msg" ] && log "Coach: $msg"

  # ---- 3. Sonnet: Compute optimal next session ----
  log "Sonnet: Computing optimal next session..."
  local session_file="/tmp/ai900-session-$$.json"

  # Build list of all qids for sonnet
  local all_qids_file="/tmp/ai900-allqids-$$.json"
  node -e "
    const fs = require('fs');
    const qids = [];
    for (const f of fs.readdirSync('${PACKS_DIR}')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const p = JSON.parse(fs.readFileSync('${PACKS_DIR}/'+f,'utf8'));
        if (!p.questions) continue;
        for (const q of p.questions) {
          qids.push({qid: p.pack.id+'::'+q.id, domain:q.domain, type:q.type, tags:q.tags||[]});
        }
      } catch {}
    }
    fs.writeFileSync('${all_qids_file}', JSON.stringify(qids));
    console.log(qids.length + ' questions available');
  " 2>/dev/null | while read line; do log "Pool: $line"; done

  local all_qids
  all_qids=$(cat "$all_qids_file")

  claude --model sonnet -p "あなたはAI-900出題最適化エンジンです。
コーチの戦略と問題プールから、最適な次回セッションの出題リストをJSON配列で出力してください。

■ コーチの戦略:
${strategy}

■ 学習統計:
${stats_content}

■ 利用可能な問題（全qidリスト）:
${all_qids}

■ 出力 (JSON):
{
  \"questions\": [
    {\"qid\": \"packId::questionId\", \"reason\": \"unseen|weakness_drill|spaced_review|reinforcement\"},
    ...
  ],
  \"sessionType\": \"balanced|weakness_drill|review|exploration\",
  \"message\": \"今回のセッションの狙い（1文、日本語）\"
}

ルール:
- コーチの nextSession.sessionSize に従った問題数（デフォルト15）
- unseenRatio に従い未解答問題を優先的に含める
- reviewQids は必ず含める（間違えた問題の復習）
- domainWeights に従いドメイン配分を調整
- preferTypes があればそのタイプを多めに
- 出力はJSONのみ" > "$session_file" 2>&1

  local next_session
  next_session=$(node -e "
    const raw = require('fs').readFileSync('${session_file}','utf8');
    let j = raw;
    const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    if (m) j = m[1];
    const s = j.indexOf('{'), e = j.lastIndexOf('}');
    if (s>=0 && e>s) j = j.slice(s, e+1);
    console.log(JSON.stringify(JSON.parse(j.trim())));
  " 2>/dev/null || echo "")

  if [ -n "$next_session" ]; then
    curl -sf --max-time 10 -X PUT -H "Content-Type: application/json" \
      -d "$next_session" "${APP_URL}/api/next-session" 2>/dev/null
    local q_count
    q_count=$(echo "$next_session" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log((d.questions||[]).length);" 2>/dev/null)
    log "Next session: ${q_count} questions curated."
    local sess_msg
    sess_msg=$(echo "$next_session" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.message||'');" 2>/dev/null)
    [ -n "$sess_msg" ] && log "Session plan: $sess_msg"
  else
    log_err "Sonnet session planning failed."
  fi

  # ---- 4. Question generation (if needed) ----
  local gen_needed gen_count
  gen_needed=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.generation?.needed?'yes':'no');" 2>/dev/null || echo "no")
  gen_count=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.generation?.count||0);" 2>/dev/null || echo "0")

  if [ "$gen_needed" = "yes" ] && [ "$gen_count" -gt 0 ]; then
    log "Generating ${gen_count} new questions..."
    generate_questions "$strategy" "$gen_count"
  fi

  # ---- 5. Mark analysis complete ----
  curl -sf --max-time 5 -X PUT "${APP_URL}/api/status" 2>/dev/null
  log "Marked analysis complete."

  rm -f "$stats_file" "$strategy_file" "$session_file" "$all_qids_file" "$LOCK_FILE"
  log "========================================"
  log " Cycle complete. Back to idle."
  log "========================================"
}

generate_questions() {
  local strategy="$1"
  local count="$2"
  count=$(node -e "console.log(Math.min(Math.max(parseInt('${count}'),15),50))")

  local focus_domains focus_types gen_reason
  focus_domains=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log((d.generation?.focusDomains||['Workloads','ML','CV','NLP','GenAI']).join(', '));" 2>/dev/null)
  focus_types=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log((d.generation?.focusTypes||['single','multi','dropdown']).join(', '));" 2>/dev/null)
  gen_reason=$(echo "$strategy" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.generation?.reason||'pool replenishment');" 2>/dev/null)

  local existing_ids
  existing_ids=$(node -e "
    const fs=require('fs'), ids=new Set();
    for(const f of fs.readdirSync('${PACKS_DIR}')){
      if(!f.endsWith('.json')||f==='index.json') continue;
      try{const d=JSON.parse(fs.readFileSync('${PACKS_DIR}/'+f,'utf8'));
        if(d.questions) d.questions.forEach(q=>ids.add(q.id));
      }catch{}
    }
    console.log([...ids].slice(-30).join(', '));
  " 2>/dev/null)

  local pack_id="ai900.coach.$(date +%Y%m%d%H%M%S)"
  local pack_file="${PACKS_DIR}/${pack_id}_$(date +%Y-%m-%d).json"
  local raw_file="/tmp/ai900-gen-$$.txt"

  local attempt=0 success=false
  while [ $attempt -lt 2 ] && [ "$success" = "false" ]; do
    attempt=$((attempt + 1))

    claude --model opus -p "AI-900試験対策の問題パックJSONを生成。JSONのみ出力。フェンス不要。

■ 生成計画: ${gen_reason}
重点ドメイン: ${focus_domains} / 重点タイプ: ${focus_types} / ${count}問

■ フォーマット (schema: ai900-pack-v1):
{\"schema\":\"ai900-pack-v1\",\"pack\":{\"id\":\"${pack_id}\",\"version\":\"$(date +%Y-%m-%d)\",\"title\":\"コーチ生成 (${count}問)\",\"description\":\"AIコーチ分析に基づく自動生成\",\"language\":\"ja-JP\",\"createdAt\":\"$(date -Iseconds)\",\"domains\":[\"Workloads\",\"ML\",\"CV\",\"NLP\",\"GenAI\"]},\"questions\":[...]}

■ 既存ID: ${existing_ids}
■ タイプ仕様: single(answer=[idx],choices=4), multi(answer=[idx,...],choices=4-6), dropdown(dropdowns=[{blank,options,answer}],prompt={{0}}), match(left,right,answerMap), order(items,answerOrder), hotarea(grid={cols,rows,cells},answer=[idx]), casestudy(scenario,subQuestions)
■ 全問 explanation 付与、domain均等+弱点重み付け" > "$raw_file" 2>&1

    if node -e "
      const fs=require('fs'),raw=fs.readFileSync('${raw_file}','utf8');
      let j=raw;const m=raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);if(m)j=m[1];
      const s=j.indexOf('{'),e=j.lastIndexOf('}');
      if(s<0||e<=s)throw new Error('No JSON');
      const p=JSON.parse(j.slice(s,e+1));
      if(!p.questions||!p.questions.length)throw new Error('No questions');
      fs.writeFileSync('${pack_file}',JSON.stringify(p,null,2));
      console.log(p.questions.length+' questions');
    " 2>/dev/null; then
      if node tools/validate_packs.mjs 2>&1 | tail -1 | grep -q "0 error"; then
        success=true
      else
        log_err "Validation failed (attempt ${attempt})"; rm -f "$pack_file"
      fi
    else
      log_err "Parse failed (attempt ${attempt})"; rm -f "$pack_file"
    fi
  done

  rm -f "$raw_file"
  if [ "$success" = "false" ]; then log_err "Generation failed."; return 1; fi

  node tools/build_index.mjs 2>/dev/null
  node tools/dedupe.mjs 2>/dev/null || true

  git add public/packs/ public/meta/
  git commit -m "$(cat <<EOF
Coach: ${pack_id} (${count} questions)

${gen_reason}
Focus: ${focus_domains}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
  )" 2>&1 | tee -a "$LOG_DIR/trainer.log"

  git push origin master 2>&1 | tee -a "$LOG_DIR/trainer.log" && \
    npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true 2>&1 | tee -a "$LOG_DIR/trainer.log" || true

  log "Questions deployed: ${pack_id}"
}

# ---- Entry ----
if [ "${1:-}" = "--watch" ]; then
  trap cleanup EXIT INT TERM
  log "==========================================="
  log "  AI-900 Personal Trainer Started"
  log "  Poll: ${POLL_INTERVAL}s | App: ${APP_URL}"
  log "  Idle cost: ~144 tiny GETs/day"
  log "==========================================="
  while true; do
    run_cycle || true
    sleep "$POLL_INTERVAL"
  done
else
  run_cycle
fi
