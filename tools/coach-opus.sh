#!/bin/bash
# =============================================================================
# AI-900 Personal Trainer: Opus Coach
# =============================================================================
#
# Role: Deep analysis, strategy planning, question generation
# Model: Claude Opus (heavy, high-quality, runs less frequently)
#
# What it does:
#   1. Pulls user's full learning history from /api/backup
#   2. Analyzes accuracy patterns, weaknesses, learning velocity
#   3. Creates a study strategy → PUT /api/strategy
#   4. Generates targeted questions when pool runs low → git push → deploy
#
# Usage:
#   bash tools/coach-opus.sh              # Analyze once
#   bash tools/coach-opus.sh --watch      # Persistent daemon (every 10 min)
#
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/.."

APP_URL="https://ai900-pwa.pages.dev"
PACKS_DIR="public/packs"
LOG_DIR="logs"
LOCK_FILE="/tmp/ai900-coach.lock"
POLL_INTERVAL=600  # 10 minutes
MAX_RETRIES=2

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [COACH] $*" | tee -a "$LOG_DIR/coach.log"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [COACH] ERROR: $*" | tee -a "$LOG_DIR/coach.log" >&2; }

cleanup() {
  rm -f "$LOCK_FILE"
  log "Coach stopped."
}

run_analysis() {
  # ---- Lock ----
  if [ -f "$LOCK_FILE" ]; then
    local pid; pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Already running (PID $pid). Skipping."
      return 0
    fi
    rm -f "$LOCK_FILE"
  fi
  echo $$ > "$LOCK_FILE"

  log "=== Starting analysis cycle ==="

  # ---- 1. Fetch learning history ----
  log "Fetching learning history..."
  local backup_resp
  backup_resp=$(curl -sf --max-time 15 "${APP_URL}/api/backup" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$backup_resp" ]; then
    log "API unreachable. Skipping cycle."
    rm -f "$LOCK_FILE"; return 0
  fi

  local has_data
  has_data=$(echo "$backup_resp" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.ok && d.found && d.history && d.history.length > 0 ? 'yes' : 'no');
  " 2>/dev/null || echo "no")

  if [ "$has_data" != "yes" ]; then
    log "No learning history yet. Skipping analysis."
    rm -f "$LOCK_FILE"; return 0
  fi

  # Save history to temp file for claude to read
  local history_file="/tmp/ai900-history-$$.json"
  echo "$backup_resp" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    const out = {
      sessions: d.sessions || [],
      history: d.history || [],
      sessionCount: (d.sessions||[]).length,
      historyCount: (d.history||[]).length
    };
    // Pre-compute stats for the AI
    const h = out.history;
    const byDomain = {};
    const byType = {};
    const uniqueQids = new Set();
    const recentWrong = [];
    for (const r of h) {
      uniqueQids.add(r.qid);
      const d = r.domain || 'unknown';
      const t = r.type || 'unknown';
      if (!byDomain[d]) byDomain[d] = {correct:0, total:0};
      if (!byType[t]) byType[t] = {correct:0, total:0};
      byDomain[d].total++;
      byType[t].total++;
      if (r.correct) { byDomain[d].correct++; byType[t].correct++; }
      else { recentWrong.push({qid:r.qid, domain:d, type:t}); }
    }
    out.stats = {
      uniqueQuestionsSeen: uniqueQids.size,
      totalAnswers: h.length,
      byDomain, byType,
      recentWrongCount: recentWrong.length,
      recentWrongSample: recentWrong.slice(-20)
    };
    require('fs').writeFileSync('${history_file}', JSON.stringify(out, null, 2));
    console.log('History: ' + h.length + ' answers, ' + uniqueQids.size + ' unique questions');
  " 2>/dev/null
  log "$(cat "$history_file" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('Sessions: '+d.sessionCount+', Answers: '+d.historyCount+', Unique: '+d.stats.uniqueQuestionsSeen);" 2>/dev/null)"

  # ---- 2. Get current question pool info ----
  local pool_info
  pool_info=$(node -e "
    const fs = require('fs');
    const dir = '${PACKS_DIR}';
    let total = 0;
    const byDomain = {};
    const byType = {};
    const allQids = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const d = JSON.parse(fs.readFileSync(dir+'/'+f, 'utf8'));
        if (!d.questions) continue;
        for (const q of d.questions) {
          total++;
          const qid = d.pack.id + '::' + q.id;
          allQids.push(qid);
          byDomain[q.domain] = (byDomain[q.domain]||0) + 1;
          byType[q.type] = (byType[q.type]||0) + 1;
        }
      } catch {}
    }
    console.log(JSON.stringify({total, byDomain, byType, qidCount: allQids.length}));
  " 2>/dev/null)
  log "Pool: $pool_info"

  # ---- 3. Run deep analysis with Opus ----
  log "Running deep analysis with Claude Opus..."
  local analysis_file="/tmp/ai900-analysis-$$.json"
  local history_content
  history_content=$(cat "$history_file")

  claude --model opus -p "あなたはAI-900試験対策の専門AIコーチです。
以下の学習データを分析し、JSONで戦略を出力してください。JSONのみ出力。

■ 学習履歴データ:
${history_content}

■ 問題プール情報:
${pool_info}

■ 出力フォーマット (JSONのみ):
{
  \"analysis\": {
    \"overallAccuracy\": (全体正答率%),
    \"domainAccuracy\": {\"Workloads\": %, \"ML\": %, \"CV\": %, \"NLP\": %, \"GenAI\": %},
    \"typeAccuracy\": {\"single\": %, \"multi\": %, \"dropdown\": %, \"match\": %, \"order\": %, \"hotarea\": %, \"casestudy\": %},
    \"weakPoints\": [\"弱点の説明1\", ...],
    \"strongPoints\": [\"強み1\", ...],
    \"trend\": \"improving\" or \"stable\" or \"declining\",
    \"estimatedReadiness\": (試験合格推定確率%)
  },
  \"nextSessionPlan\": {
    \"domainWeights\": {\"Workloads\": 0-100, ...},
    \"typePreference\": [優先すべきタイプ],
    \"difficultyTarget\": 1-5,
    \"unseenRatio\": 0.0-1.0,
    \"focusAreas\": [\"重点分野の説明\"],
    \"reviewQids\": [\"再出題すべきqid (間違えた問題)\"],
    \"sessionSize\": 15-25
  },
  \"generationNeeded\": true/false,
  \"generationPlan\": {
    \"count\": (必要数, 0 if不要),
    \"focusDomains\": [重点ドメイン],
    \"focusTypes\": [重点タイプ],
    \"reason\": \"理由\"
  },
  \"coachMessage\": \"ユーザーへの学習アドバイス（2-3文、日本語、具体的で励まし含む）\"
}" > "$analysis_file" 2>&1

  # Parse analysis
  local strategy
  strategy=$(node -e "
    const fs = require('fs');
    const raw = fs.readFileSync('${analysis_file}', 'utf8');
    let json = raw;
    const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    if (m) json = m[1];
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start >= 0 && end > start) json = json.slice(start, end + 1);
    const parsed = JSON.parse(json.trim());
    console.log(JSON.stringify(parsed));
  " 2>/dev/null)

  if [ -z "$strategy" ]; then
    log_err "Failed to parse analysis output"
    rm -f "$history_file" "$analysis_file" "$LOCK_FILE"
    return 1
  fi

  log "Analysis complete. Uploading strategy..."

  # ---- 4. Upload strategy to KV ----
  local upload_status
  upload_status=$(curl -sf --max-time 10 -X PUT \
    -H "Content-Type: application/json" \
    -d "$strategy" \
    "${APP_URL}/api/strategy" 2>/dev/null)
  log "Strategy upload: $upload_status"

  # ---- 5. Check if question generation is needed ----
  local gen_needed gen_count
  gen_needed=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.generationNeeded ? 'yes' : 'no');
  " 2>/dev/null || echo "no")
  gen_count=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.generationPlan?.count || 0);
  " 2>/dev/null || echo "0")

  # Also check the explicit generation request from the app
  local app_request
  app_request=$(curl -sf --max-time 10 "${APP_URL}/api/generate-request" 2>/dev/null || echo '{"ok":false}')
  local app_needs_gen
  app_needs_gen=$(echo "$app_request" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.ok && d.pending ? 'yes' : 'no');
  " 2>/dev/null || echo "no")

  if [ "$app_needs_gen" = "yes" ]; then
    local app_needed
    app_needed=$(echo "$app_request" | node -e "
      const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
      console.log(d.request?.needed || 30);
    " 2>/dev/null || echo "30")
    gen_needed="yes"
    gen_count=$(node -e "console.log(Math.max(${gen_count}, ${app_needed}))")
    log "App also requested generation: ${app_needed} questions"
  fi

  if [ "$gen_needed" = "yes" ] && [ "$gen_count" -gt 0 ]; then
    log "=== GENERATING ${gen_count} QUESTIONS ==="
    generate_questions "$strategy" "$gen_count"
  else
    log "No generation needed this cycle."
  fi

  # ---- 6. Log coach message ----
  local coach_msg
  coach_msg=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.coachMessage || '');
  " 2>/dev/null)
  if [ -n "$coach_msg" ]; then
    log "Coach says: $coach_msg"
  fi

  rm -f "$history_file" "$analysis_file" "$LOCK_FILE"
  log "=== Analysis cycle complete ==="
}

generate_questions() {
  local strategy="$1"
  local count="$2"

  # Clamp
  count=$(node -e "console.log(Math.min(Math.max(parseInt('${count}'), 15), 50))")

  # Extract focus areas from strategy
  local focus_domains focus_types
  focus_domains=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log((d.generationPlan?.focusDomains || ['Workloads','ML','CV','NLP','GenAI']).join(', '));
  " 2>/dev/null || echo "Workloads, ML, CV, NLP, GenAI")
  focus_types=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log((d.generationPlan?.focusTypes || ['single','multi','dropdown']).join(', '));
  " 2>/dev/null || echo "single, multi, dropdown")
  local gen_reason
  gen_reason=$(echo "$strategy" | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(d.generationPlan?.reason || 'pool replenishment');
  " 2>/dev/null)

  # Get existing IDs
  local existing_ids
  existing_ids=$(node -e "
    const fs = require('fs');
    const ids = new Set();
    for (const f of fs.readdirSync('${PACKS_DIR}')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const d = JSON.parse(fs.readFileSync('${PACKS_DIR}/'+f, 'utf8'));
        if (d.questions) d.questions.forEach(q => ids.add(q.id));
      } catch {}
    }
    console.log([...ids].slice(-30).join(', '));
  " 2>/dev/null)

  local pack_id="ai900.coach.$(date +%Y%m%d%H%M%S)"
  local pack_file="${PACKS_DIR}/${pack_id}_$(date +%Y-%m-%d).json"
  local timestamp; timestamp=$(date -Iseconds)
  local raw_file="/tmp/ai900-coachgen-$$.txt"

  local attempt=0
  local success=false

  while [ $attempt -lt $MAX_RETRIES ] && [ "$success" = "false" ]; do
    attempt=$((attempt + 1))
    log "Generation attempt ${attempt}/${MAX_RETRIES}..."

    claude --model opus -p "AI-900試験対策の問題パックJSONを生成してください。JSONのみ出力。

■ コーチの分析に基づく生成計画:
- 生成理由: ${gen_reason}
- 重点ドメイン: ${focus_domains}
- 重点タイプ: ${focus_types}
- 生成数: ${count}問

■ 出力フォーマット (schema: ai900-pack-v1):
{
  \"schema\": \"ai900-pack-v1\",
  \"pack\": {
    \"id\": \"${pack_id}\",
    \"version\": \"$(date +%Y-%m-%d)\",
    \"title\": \"コーチ生成パック (${count}問)\",
    \"description\": \"AIコーチの分析に基づき弱点対策として自動生成\",
    \"language\": \"ja-JP\",
    \"createdAt\": \"${timestamp}\",
    \"domains\": [\"Workloads\",\"ML\",\"CV\",\"NLP\",\"GenAI\"]
  },
  \"questions\": [${count}問]
}

■ 既存ID（重複禁止）: ${existing_ids}

■ ルール:
- Azure AI capabilities（機能・使い分け・実務判断）を問う実践問題
- 重点ドメイン/タイプを多めに配分しつつ、全分野をカバー
- 問題タイプ: single, multi, dropdown, match, order, hotarea, casestudy を混在
- single: answer=[正解index], choices=4個
- multi: answer=[正解indices], choices=4-6個, 正解2個以上
- dropdown: dropdowns=[{blank:0, options:[...], answer:index}], promptに{{0}}等
- match: left=[...], right=[...], answerMap={left:right}
- order: items=[...], answerOrder=[正しい並び順のindex]
- hotarea: grid={cols,rows,cells:[...]}, answer=[正解cellのindex]
- casestudy: scenario=文, subQuestions=[single/multi/dropdown問題]
- answerのindexは配列の0始まり範囲内
- 各問に explanation（解説）付与
- JSONのみ出力、フェンスや説明文不要" > "$raw_file" 2>&1

    if node -e "
      const fs = require('fs');
      const raw = fs.readFileSync('${raw_file}', 'utf8');
      let json = raw;
      const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
      if (m) json = m[1];
      const start = json.indexOf('{');
      const end = json.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('No JSON found');
      const parsed = JSON.parse(json.slice(start, end + 1));
      if (!parsed.questions || parsed.questions.length === 0) throw new Error('No questions');
      fs.writeFileSync('${pack_file}', JSON.stringify(parsed, null, 2));
      console.log('Parsed ' + parsed.questions.length + ' questions');
    " 2>/dev/null; then
      if node tools/validate_packs.mjs 2>&1 | tee -a "$LOG_DIR/coach.log"; then
        success=true
        log "Validation passed!"
      else
        log_err "Validation failed on attempt ${attempt}"
        rm -f "${pack_file}"
      fi
    else
      log_err "JSON parse failed on attempt ${attempt}"
      rm -f "${pack_file}"
    fi
  done

  rm -f "$raw_file"

  if [ "$success" = "false" ]; then
    log_err "Generation failed after ${MAX_RETRIES} attempts."
    return 1
  fi

  # Rebuild index + dedupe
  node tools/build_index.mjs 2>&1 | tee -a "$LOG_DIR/coach.log"
  node tools/dedupe.mjs 2>&1 | tee -a "$LOG_DIR/coach.log" || true

  # Commit and push
  git add public/packs/ public/meta/
  git commit -m "$(cat <<EOF
Coach-generated: ${pack_id} (${count} questions)

Focus: ${focus_domains}
Reason: ${gen_reason}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
  )"

  if git push origin master 2>&1 | tee -a "$LOG_DIR/coach.log"; then
    log "Pushed. Deploying..."
    npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true 2>&1 | tee -a "$LOG_DIR/coach.log" || true
    # Clear generation request
    curl -sf -X DELETE "${APP_URL}/api/generate-request" --max-time 10 2>/dev/null || true
    log "Deployed successfully."
  else
    log_err "Git push failed."
  fi
}

# ---- Main ----
if [ "${1:-}" = "--watch" ]; then
  trap cleanup EXIT INT TERM
  log "=========================================="
  log " AI-900 Opus Coach Started"
  log " Analysis every ${POLL_INTERVAL}s"
  log " App: ${APP_URL}"
  log "=========================================="
  while true; do
    run_analysis || true
    log "Next analysis in ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
  done
else
  run_analysis
fi
