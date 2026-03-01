# AI-900 練習アプリ (PWA)

Microsoft AI-900 資格試験対策用のスマホPWAアプリです。

## 機能

- 7つの問題形式に対応 (単一選択/複数選択/穴埋め/マッチング/並べ替え/ホットエリア/ケーススタディ)
- 練習モード・模試モード (45分タイマー)
- 苦手補正による出題最適化
- 分野別・形式別・タグ別の統計
- パック方式による問題追加・更新
- オフライン対応 (PWA)
- ダークテーマ・スマホ最適化

## Cloudflare Pages へのデプロイ

1. このリポジトリを GitHub にプッシュ
2. Cloudflare Pages で新しいプロジェクトを作成
3. ビルド設定：
   - **ビルドコマンド**: (空 / なし)
   - **ビルド出力ディレクトリ**: `public`
4. デプロイ

## ローカル起動

```bash
npm run serve
# → http://localhost:3000 で確認
```

## ツール (開発用)

```bash
# パック検証
npm run validate

# index.json 再生成
npm run build-index

# 重複チェック
npm run dedupe
```

## パック追加方法

### 1. リポジトリに追加
`public/packs/` に `ai900-pack-v1` スキーマのJSONファイルを配置し、`npm run build-index` で index.json を更新。

### 2. アプリ内追加
パック管理画面から以下の方法で追加可能：
- **リポジトリ購読**: index.json のURLを登録
- **Pack URL**: pack.json のURLを直接追加
- **クリップボード**: pack.json の全文を貼り付け
- **ファイル選択**: ローカルの pack.json を読み込み

## パックスキーマ

```json
{
  "schema": "ai900-pack-v1",
  "pack": {
    "id": "unique.pack.id",
    "version": "2026-03-01",
    "title": "パック名",
    "description": "説明",
    "language": "ja-JP",
    "createdAt": "2026-03-01T00:00:00Z",
    "domains": ["Workloads", "ML", "CV", "NLP", "GenAI"]
  },
  "questions": [...]
}
```

## 仮定・制約

- 初期パックは capabilities（機能・使い分け）のみを問う内容に限定
- 問題の正確性は Microsoft Learn を参照して手動レビューを推奨
- Service Worker は stale-while-revalidate 戦略で更新
