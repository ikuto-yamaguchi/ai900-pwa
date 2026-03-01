#!/bin/bash
# generate_weakness_pack.sh
# Claude Code が実行するスクリプト。
# 1. Cloudflare KVから最新の苦手データを取得
# 2. Claude Code (claude CLI) に問題生成を依頼
# 3. 生成されたパックを検証
# 4. git push → Cloudflare Pages 自動デプロイ
#
# 使い方:
#   別のClaude Codeセッションで以下を実行:
#   cd ~/ai900-pwa && bash tools/generate_weakness_pack.sh
#
# または cron で定期実行:
#   */30 * * * * cd ~/ai900-pwa && bash tools/generate_weakness_pack.sh >> /tmp/ai900-gen.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="https://ai900-pwa.pages.dev"
PACKS_DIR="public/packs"
LOCK_FILE="/tmp/ai900-gen.lock"

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  echo "$(date): Another generation is running. Exiting."
  exit 0
fi
trap "rm -f $LOCK_FILE" EXIT
touch "$LOCK_FILE"

echo "$(date): Fetching weakness data..."
WEAKNESS=$(curl -sf "${APP_URL}/api/weakness" 2>/dev/null || echo '{"ok":false}')
HAS_DATA=$(echo "$WEAKNESS" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);console.log(j.ok && j.data ? 'yes' : 'no')" 2>/dev/null || echo "no")

if [ "$HAS_DATA" != "yes" ]; then
  echo "$(date): No weakness data available yet. User hasn't completed any sessions."
  exit 0
fi

# Extract weakness summary
WEAKNESS_DATA=$(echo "$WEAKNESS" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.stringify(JSON.parse(d).data,null,2))")
echo "$(date): Weakness data: $WEAKNESS_DATA"

# Check if we already generated recently (within last 2 hours)
LAST_GEN=$(cat /tmp/ai900-last-gen 2>/dev/null || echo "0")
NOW=$(date +%s)
DIFF=$(( NOW - LAST_GEN ))
if [ "$DIFF" -lt 7200 ]; then
  echo "$(date): Generated less than 2 hours ago. Skipping."
  exit 0
fi

# Generate pack using Claude CLI (headless)
PACK_ID="ai900.auto.$(date +%Y%m%d%H%M)"
PACK_FILE="${PACKS_DIR}/${PACK_ID}_$(date +%Y-%m-%d).json"
TIMESTAMP=$(date -Iseconds)

echo "$(date): Generating questions with Claude..."
claude -p "以下の苦手データに基づいて、AI-900試験対策の問題パックJSONを生成してください。JSONのみ出力してください。

苦手データ:
${WEAKNESS_DATA}

出力フォーマット (schema: ai900-pack-v1):
{
  \"schema\": \"ai900-pack-v1\",
  \"pack\": {
    \"id\": \"${PACK_ID}\",
    \"version\": \"$(date +%Y-%m-%d)\",
    \"title\": \"苦手克服パック (自動生成)\",
    \"description\": \"苦手分析に基づいてClaude Codeが自動生成した問題パック\",
    \"language\": \"ja-JP\",
    \"createdAt\": \"${TIMESTAMP}\",
    \"domains\": [\"Workloads\",\"ML\",\"CV\",\"NLP\",\"GenAI\"]
  },
  \"questions\": [... 10-15問 ...]
}

問題タイプ: single, multi, dropdown, match, order, hotarea, casestudy
ルール:
- capabilities（機能・使い分け）を問う問題のみ
- answerのindexはchoices配列の0始まり範囲内
- ID: AW-001等 (重複不可)
- domainは Workloads/ML/CV/NLP/GenAI
- 苦手の分野・タグを重点的に出題
- JSONのみ出力、説明文不要" > /tmp/ai900-pack-raw.txt 2>&1

# Extract JSON from output
node -e "
const fs = require('fs');
const raw = fs.readFileSync('/tmp/ai900-pack-raw.txt', 'utf8');
let json = raw;
const m = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
if (m) json = m[1];
// Try to find JSON object
const start = json.indexOf('{');
const end = json.lastIndexOf('}');
if (start >= 0 && end > start) json = json.slice(start, end + 1);
const parsed = JSON.parse(json.trim());
fs.writeFileSync('${PACK_FILE}', JSON.stringify(parsed, null, 2));
console.log('Pack written: ${PACK_FILE}');
" || { echo "$(date): Failed to parse generated JSON"; exit 1; }

# Validate
echo "$(date): Validating..."
if node tools/validate_packs.mjs; then
  echo "$(date): Validation passed"
else
  echo "$(date): Validation failed, removing bad pack"
  rm -f "${PACK_FILE}"
  exit 1
fi

# Rebuild index
node tools/build_index.mjs

# Dedupe check
node tools/dedupe.mjs || {
  echo "$(date): Deduplication found issues but continuing"
}

# Commit and push
git add public/packs/ public/meta/
git commit -m "Auto-generated weakness pack: ${PACK_ID}

Based on user weakness analysis.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git push origin master

# Deploy
npx wrangler pages deploy public --project-name ai900-pwa --commit-dirty=true

echo "$NOW" > /tmp/ai900-last-gen
echo "$(date): Done! Pack ${PACK_ID} deployed."
