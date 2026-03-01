#!/bin/bash
# generate_weakness_pack.sh - Event-driven question generation
#
# Architecture:
#   1. App tracks user's seen/total question ratio
#   2. When ratio drops below threshold, app POSTs to /api/generate-request
#   3. This script polls KV for pending requests
#   4. Generates exactly the number of questions needed
#   5. Validates, deploys, marks request as fulfilled
#
# Usage (separate Claude Code session):
#   cd ~/ai900-pwa && bash tools/generate_weakness_pack.sh
#
# As a watch loop:
#   cd ~/ai900-pwa && bash tools/generate_weakness_pack.sh --watch

set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="https://ai900-pwa.pages.dev"
PACKS_DIR="public/packs"
LOCK_FILE="/tmp/ai900-gen.lock"
WATCH_MODE=false

if [ "${1:-}" = "--watch" ]; then
  WATCH_MODE=true
fi

run_once() {
  # Prevent concurrent runs
  if [ -f "$LOCK_FILE" ]; then
    echo "$(date): Another generation is running. Skipping."
    return 1
  fi
  trap "rm -f $LOCK_FILE" EXIT
  touch "$LOCK_FILE"

  echo "$(date): Checking for generation requests..."

  # Poll the generate-request endpoint for pending tasks
  RESPONSE=$(curl -sf "${APP_URL}/api/generate-request" 2>/dev/null || echo '{"ok":false}')

  HAS_REQUEST=$(echo "$RESPONSE" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const j=JSON.parse(d);
    console.log(j.ok && j.pending ? 'yes' : 'no');
  " 2>/dev/null || echo "no")

  if [ "$HAS_REQUEST" != "yes" ]; then
    echo "$(date): No pending generation requests."
    rm -f "$LOCK_FILE"
    trap - EXIT
    return 0
  fi

  # Extract request details
  REQUEST_DATA=$(echo "$RESPONSE" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const j=JSON.parse(d);
    console.log(JSON.stringify(j.request));
  ")

  NEEDED=$(echo "$REQUEST_DATA" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const r=JSON.parse(d);
    console.log(Math.min(Math.max(r.needed || 15, 10), 50));
  ")
  UNSEEN_RATIO=$(echo "$REQUEST_DATA" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const r=JSON.parse(d);
    console.log(Math.round((r.unseenRatio || 0) * 100));
  ")
  TOTAL_Q=$(echo "$REQUEST_DATA" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const r=JSON.parse(d);
    console.log(r.totalQuestions || 0);
  ")
  SEEN_Q=$(echo "$REQUEST_DATA" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const r=JSON.parse(d);
    console.log(r.uniqueSeen || 0);
  ")

  echo "$(date): Request found! Pool: ${SEEN_Q}/${TOTAL_Q} seen (${UNSEEN_RATIO}% unseen), need ${NEEDED} questions"

  # Get weakness data for targeting
  WEAKNESS=$(curl -sf "${APP_URL}/api/weakness" 2>/dev/null || echo '{"ok":false}')
  WEAKNESS_DATA=$(echo "$WEAKNESS" | node -e "
    const d=require('fs').readFileSync(0,'utf8');
    const j=JSON.parse(d);
    console.log(j.ok && j.data ? JSON.stringify(j.data, null, 2) : 'null');
  " 2>/dev/null || echo "null")

  # Generate pack
  PACK_ID="ai900.auto.$(date +%Y%m%d%H%M)"
  PACK_FILE="${PACKS_DIR}/${PACK_ID}_$(date +%Y-%m-%d).json"
  TIMESTAMP=$(date -Iseconds)

  # Build prompt with context
  WEAKNESS_SECTION=""
  if [ "$WEAKNESS_DATA" != "null" ]; then
    WEAKNESS_SECTION="
苦手データ（重点出題対象）:
${WEAKNESS_DATA}"
  fi

  echo "$(date): Generating ${NEEDED} questions with Claude..."
  claude -p "AI-900試験対策の問題パックJSONを生成してください。JSONのみ出力してください。

■ 背景
ユーザーが${TOTAL_Q}問中${SEEN_Q}問を既に解いています（未解答率${UNSEEN_RATIO}%）。
新しい問題を${NEEDED}問追加して、問題プールを補充する必要があります。
${WEAKNESS_SECTION}

■ 出力フォーマット (schema: ai900-pack-v1):
{
  \"schema\": \"ai900-pack-v1\",
  \"pack\": {
    \"id\": \"${PACK_ID}\",
    \"version\": \"$(date +%Y-%m-%d)\",
    \"title\": \"自動補充パック (${NEEDED}問)\",
    \"description\": \"プール補充のためClaude Codeが自動生成\",
    \"language\": \"ja-JP\",
    \"createdAt\": \"${TIMESTAMP}\",
    \"domains\": [\"Workloads\",\"ML\",\"CV\",\"NLP\",\"GenAI\"]
  },
  \"questions\": [... ${NEEDED}問 ...]
}

■ ルール:
- capabilities（機能・使い分け）を問う問題のみ
- 問題タイプ: single, multi, dropdown, match, order, hotarea, casestudy を混在
- answerのindexはchoices配列の0始まり範囲内
- ID: AG-001〜AG-$(printf '%03d' $NEEDED) (重複不可)
- domainは5分野に均等配分（苦手があれば重み付け）
- JSONのみ出力、説明文不要
- 既存問題と重複しない新しい切り口で出題" > /tmp/ai900-pack-raw.txt 2>&1

  # Extract JSON from output
  node -e "
    const fs = require('fs');
    const raw = fs.readFileSync('/tmp/ai900-pack-raw.txt', 'utf8');
    let json = raw;
    const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    if (m) json = m[1];
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start >= 0 && end > start) json = json.slice(start, end + 1);
    const parsed = JSON.parse(json.trim());
    fs.writeFileSync('${PACK_FILE}', JSON.stringify(parsed, null, 2));
    console.log('Pack written: ${PACK_FILE}');
  " || { echo "$(date): Failed to parse generated JSON"; rm -f "$LOCK_FILE"; trap - EXIT; return 1; }

  # Validate
  echo "$(date): Validating..."
  if node tools/validate_packs.mjs; then
    echo "$(date): Validation passed"
  else
    echo "$(date): Validation failed, removing bad pack"
    rm -f "${PACK_FILE}"
    rm -f "$LOCK_FILE"
    trap - EXIT
    return 1
  fi

  # Rebuild index + dedupe
  node tools/build_index.mjs
  node tools/dedupe.mjs || echo "$(date): Dedupe warnings (non-fatal)"

  # Commit and push
  git add public/packs/ public/meta/
  git commit -m "Auto-generated pool refill: ${PACK_ID} (${NEEDED} questions)

Pool was at ${UNSEEN_RATIO}% unseen (${SEEN_Q}/${TOTAL_Q} seen).
Event-driven generation triggered by app.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

  git push origin master

  # Deploy
  npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true

  # Mark request as fulfilled
  curl -sf -X DELETE "${APP_URL}/api/generate-request" 2>/dev/null || true

  echo "$(date): Done! Pack ${PACK_ID} deployed (${NEEDED} questions added)."
  rm -f "$LOCK_FILE"
  trap - EXIT
}

if [ "$WATCH_MODE" = true ]; then
  echo "$(date): Starting watch mode (checks every 5 minutes)..."
  while true; do
    run_once || true
    sleep 300
  done
else
  run_once
fi
