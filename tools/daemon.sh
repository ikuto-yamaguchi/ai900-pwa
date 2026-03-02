#!/bin/bash
# =============================================================================
# AI-900 Question Pool Auto-Generation Daemon
# =============================================================================
#
# Runs on local PC, polls the app's API for generation requests,
# generates high-quality questions using Claude Code (MAX plan),
# validates, commits, pushes → Cloudflare auto-deploys.
#
# Usage:
#   bash tools/daemon.sh              # Run once
#   bash tools/daemon.sh --watch      # Run as persistent daemon
#
# Setup as systemd user service:
#   systemctl --user enable ai900-daemon
#   systemctl --user start ai900-daemon
#
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/.."

APP_URL="https://ai900-pwa.pages.dev"
PACKS_DIR="public/packs"
LOG_DIR="logs"
LOCK_FILE="/tmp/ai900-daemon.lock"
POLL_INTERVAL=300  # 5 minutes
MAX_RETRIES=2

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG_DIR/daemon.log" >&2; }

# Parse JSON field (avoids repeated node invocations)
json_field() {
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const keys = '${1}'.split('.');
    let v = d;
    for (const k of keys) v = v?.[k];
    console.log(v ?? '');
  " 2>/dev/null
}

cleanup() {
  rm -f "$LOCK_FILE"
  log "Daemon stopped."
}

check_and_generate() {
  # ---- 1. Acquire lock ----
  if [ -f "$LOCK_FILE" ]; then
    local pid
    pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Another instance running (PID $pid). Skipping."
      return 0
    fi
    log "Stale lock found, removing."
    rm -f "$LOCK_FILE"
  fi
  echo $$ > "$LOCK_FILE"

  # ---- 2. Poll for pending requests ----
  log "Checking for generation requests..."

  local response
  response=$(curl -sf --max-time 10 "${APP_URL}/api/generate-request" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$response" ]; then
    log "API unreachable or empty response."
    rm -f "$LOCK_FILE"
    return 0
  fi

  local has_request
  has_request=$(echo "$response" | json_field "pending")
  if [ "$has_request" != "true" ]; then
    log "No pending requests. Pool is healthy."
    rm -f "$LOCK_FILE"
    return 0
  fi

  # ---- 3. Extract request details ----
  local needed unseen_ratio total_q seen_q
  needed=$(echo "$response" | json_field "request.needed")
  unseen_ratio=$(echo "$response" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(Math.round((d.request?.unseenRatio || 0) * 100));
  " 2>/dev/null)
  total_q=$(echo "$response" | json_field "request.totalQuestions")
  seen_q=$(echo "$response" | json_field "request.uniqueSeen")

  # Clamp needed between 15 and 50
  needed=$(node -e "console.log(Math.min(Math.max(parseInt('${needed}')||15, 15), 50))")

  log "===== GENERATION TRIGGERED ====="
  log "Pool: ${seen_q}/${total_q} seen (${unseen_ratio}% unseen)"
  log "Generating ${needed} new questions..."

  # ---- 4. Get weakness data ----
  local weakness_section=""
  local weakness_resp
  weakness_resp=$(curl -sf --max-time 10 "${APP_URL}/api/weakness" 2>/dev/null || echo '{"ok":false}')
  local weakness_data
  weakness_data=$(echo "$weakness_resp" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    if (d.ok && d.data) console.log(JSON.stringify(d.data, null, 2));
    else console.log('');
  " 2>/dev/null)

  if [ -n "$weakness_data" ]; then
    weakness_section="
苦手データ（重点的に出題すべき分野）:
${weakness_data}"
  fi

  # ---- 5. Get existing question IDs to avoid duplicates ----
  local existing_ids
  existing_ids=$(node -e "
    const fs = require('fs');
    const dir = '${PACKS_DIR}';
    const ids = new Set();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const d = JSON.parse(fs.readFileSync(dir+'/'+f, 'utf8'));
        if (d.questions) d.questions.forEach(q => ids.add(q.id));
      } catch {}
    }
    console.log([...ids].slice(-50).join(', '));
  " 2>/dev/null)

  # ---- 6. Generate with Claude Code ----
  local pack_id="ai900.auto.$(date +%Y%m%d%H%M%S)"
  local pack_file="${PACKS_DIR}/${pack_id}_$(date +%Y-%m-%d).json"
  local timestamp
  timestamp=$(date -Iseconds)
  local raw_file="/tmp/ai900-gen-raw-$$.txt"

  local attempt=0
  local success=false

  while [ $attempt -lt $MAX_RETRIES ] && [ "$success" = "false" ]; do
    attempt=$((attempt + 1))
    log "Generation attempt ${attempt}/${MAX_RETRIES}..."

    claude -p "AI-900試験対策の問題パックJSONを生成してください。JSONのみ出力。マークダウンフェンスも不要。

■ 背景
ユーザーが${total_q}問中${seen_q}問を解答済み（未解答率${unseen_ratio}%）。
問題プールを${needed}問で補充する必要があります。
${weakness_section}

■ 出力フォーマット (schema: ai900-pack-v1):
{
  \"schema\": \"ai900-pack-v1\",
  \"pack\": {
    \"id\": \"${pack_id}\",
    \"version\": \"$(date +%Y-%m-%d)\",
    \"title\": \"自動補充パック (${needed}問)\",
    \"description\": \"Claude Code自動生成\",
    \"language\": \"ja-JP\",
    \"createdAt\": \"${timestamp}\",
    \"domains\": [\"Workloads\",\"ML\",\"CV\",\"NLP\",\"GenAI\"]
  },
  \"questions\": [${needed}問の配列]
}

■ 既存ID（重複禁止）: ${existing_ids}

■ ルール:
- Azure AI capabilities（機能・使い分け・実務的な判断）を問う実践問題のみ
- 問題タイプの混在: single(40%), multi(20%), dropdown(15%), match(10%), order(5%), hotarea(5%), casestudy(5%)
- single: answer=[正解index], choices=4個
- multi: answer=[正解indices], choices=4-6個, 正解2個以上
- dropdown: dropdowns=[{blank:0, options:[...], answer:index}], promptに{{0}}等
- match: left=[...], right=[...], answerMap={left:right}
- order: items=[...], answerOrder=[正しい並び順のindex]
- hotarea: grid={cols,rows,cells:[...]}, answer=[正解cellのindex]
- casestudy: scenario=文, subQuestions=[single/multi/dropdown問題]
- answerのindexはchoices/options配列の0始まり範囲内
- ID: AG-$(printf '%04d' $((RANDOM%9000+1000)))〜（重複不可）
- domainは5分野に均等配分（苦手分野は多め）
- 各問に explanation（解説） を付与
- 出力はJSON本体のみ、説明文やフェンス不要" > "$raw_file" 2>&1

    # Parse output
    if node -e "
      const fs = require('fs');
      const raw = fs.readFileSync('${raw_file}', 'utf8');
      let json = raw;
      // Strip markdown fences
      const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
      if (m) json = m[1];
      // Find JSON object
      const start = json.indexOf('{');
      const end = json.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('No JSON object found');
      const parsed = JSON.parse(json.slice(start, end + 1));
      if (!parsed.questions || parsed.questions.length === 0) throw new Error('No questions');
      fs.writeFileSync('${pack_file}', JSON.stringify(parsed, null, 2));
      console.log('Parsed ' + parsed.questions.length + ' questions');
    " 2>/dev/null; then
      # Validate
      if node tools/validate_packs.mjs 2>&1 | tee -a "$LOG_DIR/daemon.log"; then
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
    log_err "All generation attempts failed. Will retry next cycle."
    rm -f "$LOCK_FILE"
    return 1
  fi

  # ---- 7. Rebuild index + dedupe ----
  log "Rebuilding index..."
  node tools/build_index.mjs 2>&1 | tee -a "$LOG_DIR/daemon.log"
  node tools/dedupe.mjs 2>&1 | tee -a "$LOG_DIR/daemon.log" || true

  # ---- 8. Commit and push ----
  log "Committing and pushing..."
  git add public/packs/ public/meta/
  git commit -m "$(cat <<EOF
Auto-generate: ${pack_id} (${needed} questions)

Pool: ${seen_q}/${total_q} seen (${unseen_ratio}% unseen).
Daemon auto-generated ${needed} questions via Claude Code.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
  )"

  if git push origin master 2>&1 | tee -a "$LOG_DIR/daemon.log"; then
    log "Git push succeeded. Cloudflare will auto-deploy."
  else
    log_err "Git push failed. Will retry next cycle."
    rm -f "$LOCK_FILE"
    return 1
  fi

  # ---- 9. Also deploy manually for immediate effect ----
  log "Deploying to Cloudflare..."
  npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true 2>&1 | tee -a "$LOG_DIR/daemon.log" || true

  # ---- 10. Mark request as fulfilled ----
  curl -sf -X DELETE "${APP_URL}/api/generate-request" --max-time 10 2>/dev/null || true

  local final_count
  final_count=$(node -e "
    const fs = require('fs');
    const idx = JSON.parse(fs.readFileSync('public/packs/index.json','utf8'));
    console.log(idx.totalQuestions || idx.packs.reduce((s,p) => s + p.questionCount, 0));
  " 2>/dev/null || echo "?")

  log "===== GENERATION COMPLETE ====="
  log "Pack: ${pack_id} (${needed} questions)"
  log "Total questions in pool: ${final_count}"
  log "================================"

  rm -f "$LOCK_FILE"
}

# ---- Main ----
if [ "${1:-}" = "--watch" ]; then
  trap cleanup EXIT INT TERM
  log "=========================================="
  log " AI-900 Auto-Generation Daemon Started"
  log " Polling every ${POLL_INTERVAL}s"
  log " App: ${APP_URL}"
  log "=========================================="

  while true; do
    check_and_generate || true
    log "Next check in ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
  done
else
  check_and_generate
fi
