# luckrig

> 今この瞬間、誰かのオンプレミス環境で動いているLLM推論APIを、貢献ベースで試せる場所

オンプレミスLLM推論APIシェアリングプラットフォーム。Hotline Connectの「貢献ベースのアクセス権」をローカルLLMの世界に移植し、OpenAI互換APIをコミュニティ間で共助する。

- **luck**（引き当てる）+ **rig**（自分の環境・装備）
- SLAは保証しない。ラッキーなら速いノードに当たる
- LMSys Arenaがモデル評価のマップなら、luckrigは**インフラ評価のリアルタイムマップ**

詳細なコンセプトは [`CONCEPT.md`](./CONCEPT.md) を参照。これがこのプロジェクトの正典 (source of truth) で、設計判断はすべてここに照らして行う。

技術仕様は [`SPEC.md`](./SPEC.md) を参照。POCの実装範囲、API、データモデル、テスト要件をまとめています。

ユーザーストーリーと受け入れ条件は [`USERSTORY.md`](./USERSTORY.md) を参照。

操作手順は [`MANUAL.md`](./MANUAL.md) を参照。

## 構成要素

| コンポーネント | 役割 |
| --- | --- |
| **Tracker** | ノード登録の受付、死活監視、貢献スコアに応じた一時トークン発行 |
| **Node Proxy** | ollama/llama.cppの前段に差し込む。OpenAI互換の真SSEを基線とし、subtext modeでは復号/暗号化・キューバッファ・擬似SSEを行う |
| **CLI** | コマンド一行でノード登録、プロキシ層の自動セットアップ |
| **Web (試食UI)** | 公開リスト閲覧、トークン取得、キューUX、リプレイ再生 |
| **subtext (任意)** | Unicode variation selectorで暗号化ペイロードを不可視に埋め込む方式。ノード側プロキシログにcovertextしか残さないためのdefense-in-depth。デフォルトでは使われない |

## スコープ (v1)

- テキスト生成（OpenAI互換API）に限定
- plain mode（基線）: 素のOpenAIクライアントがそのまま動く真SSE
- subtext mode（任意）: ノードのプロキシログに平文を残さないdefense-in-depth
- 画像生成 / 音声 / 認識は試食UX全般の整合性設計が確立してから (v6+)

## 近い先行事例との差別化

- **AI Horde**（kudosベースの貢献共助）: ワーカーを抽象化してハードウェアを隠す設計。luckrigは逆に**ハードウェアを主役**にする（環境メタデータ・チューニングノート・特定リグの指名・希少性ベースの並び）。
- **Petals**: 大規模モデルの分散推論。luckrigは1ノード1推論で射程外。

## 送信内容について

plain mode（基線）はTLS + ノードプロキシのログ非書き出し規約に依存します。subtext mode（任意）はそれに加えて、ノードのプロキシログに covertext しか残さないdefense-in-depthを足します。いずれにせよノード提供者がプロセス内部に踏み込めば平文を見られます。機密情報、個人情報、業務上守るべき内容は送らないでください。

## 最小実装の順序

CONCEPT.md §「最小実装の順序」より：

1. ノード情報の公開リスト（無登録者向け、死活監視込み）
2. ベンチマーク自動収集（メモリ使用量、エラー率）
3. ノード登録CLI + luckrigプロキシ層
4. トークン発行ロジック
5. 試食UI（トークン取得→キューUX→擬似SSE）
6. リプレイ機能（ローカル永続化、`~/.luckrig/history/`）
7. 貢献スコアと権限管理


## 現在のプロトタイプ

依存なしの **POC prototype** を実装済みです。tracker / token / proxy / subtext / pseudo SSE / replay までE2Eで検証できます。

```bash
source .tools/git-env.sh   # Codexサンドボックス内でgitを使う場合
npm start                  # http://127.0.0.1:8787
npm run check
npm run test:smoke
npm run test:e2e
npm test
```

- 公開リストUI: `GET /`
- tracker health: `GET /api/health`
- ノード一覧: `GET /api/nodes`
- 詳細: [`docs/tracker-api.md`](./docs/tracker-api.md)
- metrics schema: [`docs/metrics-schema.md`](./docs/metrics-schema.md)
- POC E2E: [`docs/poc.md`](./docs/poc.md)

現段階のv1/POCとして、公開リスト、fingerprint表示/任意照合、ブラウザpublic-key試食POC、privacy caveat checkbox、死活監視、SQLite/JSONL永続化、durable token quota、prompt filter、token、node proxy、subtext、擬似SSE、replay保存までを一通りつないでいます。

## Status

v1/POC実装完了。公開リスト、死活監視、SQLite/JSONL永続化、token、durable limited quota、prompt filter、node proxy、public-key subtext、browser public-key試食、queue可視化、環境フィルタ/比較ビュー、多軸貢献スコア、Showcase自動生成、browser identity永続化、別経路fingerprint任意照合、IP token rate limit、heuristic tokenizer replay、pseudo SSE、replay保存までをNode.js標準ライブラリのみで実装済み。コンセプト v5.3 確定。
