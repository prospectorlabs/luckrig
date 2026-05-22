# Tracker API prototype

このAPIは、CONCEPT.md §「最小実装の順序」に沿ったv1/POC trackerです。無登録者向け公開リスト、死活監視、health/telemetry履歴、token発行、SQLite永続化、limited quotaを担当します。

このAPIはprompt/response本文を保存しません。tok/s / TTFTはtracker health metricsではなく、replay側のchunk timestampやノードプロキシ計測値を一次ソースにします。さらに利用者が明示的にopt-inしたタイミングメタデータのみ `POST /api/replay/timing` で受け付け、ノード単位でp50集計します（§/api/replay/timing 参照）。現在はtoken、public-key handoff、fingerprint、SQLite永続化、limited quota、prompt filter、opt-in timing集計まで実装済みです。

## 起動

```bash
npm start
# http://127.0.0.1:8787
```

開発用（watch + 書き込みAPI有効化）：

```bash
LUCKRIG_DEV=1 npm run dev
```

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `LUCKRIG_HOST` | `127.0.0.1` | trackerのbind host |
| `LUCKRIG_PORT` | `8787` | trackerのport |
| `LUCKRIG_REGISTRY_PATH` | `data/nodes.seed.json` | ノードregistry JSON |
| `LUCKRIG_METRICS_PATH` | `data/metrics.jsonl` | health/telemetry JSONL mirror（runtime生成、git管理外） |
| `LUCKRIG_TOKEN_USAGE_PATH` | `data/token-usage.jsonl` | token usage JSONL mirror（runtime生成、git管理外） |
| `LUCKRIG_TIMING_PATH` | `data/timing.jsonl` | opt-in timing JSONL mirror（runtime生成、git管理外） |
| `LUCKRIG_BANS_PATH` | `data/bans.jsonl` | bans JSONL mirror（runtime生成、git管理外） |
| `LUCKRIG_ABUSE_REPORTS_PATH` | `data/abuse-reports.jsonl` | 通報JSONL mirror（runtime生成、git管理外） |
| `LUCKRIG_ABUSE_CONTACT` | `mailto:abuse@example.invalid` | 公開する通報先（UI上にも表示される） |
| `LUCKRIG_ABUSE_REPORT_IP_LIMIT_PER_DAY` | `10` | 通報endpointのIP単位/日上限 |
| `LUCKRIG_DB_PATH` | `data/luckrig.sqlite` | SQLite DB（runtime生成、git管理外） |
| `LUCKRIG_USE_SQLITE` | enabled | `0`でSQLiteを無効化 |
| `LUCKRIG_LIMITED_TOKENS_PER_DAY` | `5` | limited tierの1日あたりtoken発行上限 |
| `LUCKRIG_TOKEN_USAGE_RETENTION_DAYS` | `7` | 当日越え古い使用量キーの自動purge日数 |
| `LUCKRIG_TOKEN_IP_LIMIT_PER_DAY` | `100` | IP単位の1日あたりtoken発行上限 |
| `LUCKRIG_HEALTH_INTERVAL_MS` | `30000` | 死活監視間隔 |
| `LUCKRIG_HEALTH_TIMEOUT_MS` | `2000` | 1ノードあたりのhealth check timeout |
| `LUCKRIG_DEV` | unset | `1` のとき `POST /api/nodes` と `POST /api/probe` を有効化 |

## Public endpoints

### `GET /`

無登録者向けの公開リストUI。

CONCEPT.mdの方針に従い、デフォルト表示は高スペック順ではありません。APIの返却順は `rarity_score_desc_then_vram_asc` です。

### `GET /api/health`

tracker自身のhealth。

```json
{
  "ok": true,
  "service": "luckrig-tracker",
  "node_count": 3
}
```

### `GET /api/nodes?status=all|available|unavailable|unknown`

公開ノードリスト。`schema_version` を必ず持ちます。

```json
{
  "schema_version": 1,
  "sort": "rarity_score_desc_then_vram_asc",
  "nodes": [
    {
      "id": "showcase-rpi5-llama32-1b",
      "display_name": "Showcase / Raspberry Pi 5",
      "endpoint_url": "http://127.0.0.1:18088/v1",
      "model_name": "llama3.2-1B",
      "quantization": "Q4_K_M",
      "lora": "なし",
      "gpu": "Raspberry Pi 5 / CPU",
      "vram_gb": 0,
      "context_length": 8192,
      "availability_note": "実験用・不定期",
      "tuning_note": "低スペックShowcase枠。速度ではなく『最低スペックで動いている』ことに価値がある。",
      "tags": ["showcase", "low-power", "cpu"],
      "rarity_score": 1.2,
      "health": {
        "status": "unavailable",
        "last_checked_at": "2026-05-22T00:00:00.000Z",
        "last_seen_at": null,
        "latency_ms": null,
        "consecutive_failures": 1,
        "last_error": "fetch failed"
      },
      "observations": {
        "samples_count": 1,
        "availability_ratio": 0,
        "last_observed_at": "2026-05-22T00:00:00.000Z"
      }
    }
  ]
}
```

### `GET /api/nodes/:id`

1ノードの公開情報。

### `GET /api/metrics`

health probeのJSONLを集約したサマリ。詳細schemaは [`metrics-schema.md`](./metrics-schema.md) を参照。

### `GET /api/metrics/:id`

1ノード分のmetrics summary。

### `GET /api/contributions`

ノードごとの多軸貢献スコアを返します。現在のPOC components:

- existence score
- rarity score
- usage score（token発行数をproxy）
- discovery score（distinct tasting users）
- note score

### `GET /api/showcase`

trackerが自動生成したShowcaseカテゴリと該当ノードを返します。

- lowest-vram
- cpu-rig
- apple-silicon
- largest-context

### `POST /api/tokens`

試食token発行。body:

```json
{
  "node_id": "first-5090-qwen3",
  "user_id": "alice",
  "contribution_score": 1,
  "ttl_sec": 900,
  "crypto_mode": "plain",
  "user_public_key": "-----BEGIN PUBLIC KEY-----...",
  "node_public_key": "-----BEGIN PUBLIC KEY-----..."
}
```

レスポンスはBearer token、期限、`crypto_mode`、node public key、public key fingerprint、contribution tierを含みます。

`crypto_mode` の決定ルール:

- `user_public_key` を指定 → `public-key`（subtext mode / X25519+AES-GCM）
- `crypto_mode: "plain"` を指定 → `plain`（OpenAI互換の基線）
- `crypto_mode: "session-secret"` を指定 → `session-secret`（legacy subtext mode、後方互換のみ）
- 何も指定なし → `plain`（基線がデフォルト）

ブラウザ試食ではfingerprint表示・コピー・URL照合を任意の自己検証として提供します。

### `GET /api/contribution/:user_id?score=1`

貢献tier判定。`score >= LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD` なら `contributor`。

### `POST /api/fingerprint/verify`

node public key fingerprintを別経路URLから取得して照合します。

```json
{
  "node_id": "first-5090-qwen3",
  "url": "https://example.com/luckrig-fingerprint.txt"
}
```

### `POST /api/replay/timing`

リプレイの**タイミングメタデータのみ**をトラッカーに送るopt-inエンドポイントです。デフォルトでは試食UIから送信されません。利用者が明示的にUI上の「公開タイミングを共有する」ボタンを押した場合のみ呼ばれます。

受け付けるフィールドは厳格な許可リストのみで、`prompt` / `response` / `messages` / `chunk_timestamps` などの本文系は混入してもサーバが拒否します。

```json
{
  "schema_version": 1,
  "node_id": "first-5090-qwen3",
  "mode": "plain",
  "user_id": "alice",
  "created_at": "2026-05-22T07:12:34.000Z",
  "tok_per_sec": 267.0,
  "ttft_ms": 842,
  "proxy_ttft_ms": 712,
  "network_ttft_ms": 842,
  "generation_sec": 8.3,
  "queue_wait_sec": 12.1,
  "output_tokens": 2215,
  "tokenizer": "luckrig-heuristic-v1",
  "tokenizer_model_family": "qwen"
}
```

レスポンス:

```json
{
  "ok": true,
  "schema_version": 1,
  "node_id": "first-5090-qwen3",
  "stored_at": "2026-05-22T07:12:34.500Z"
}
```

受信したサンプルは `data/timing.jsonl` に append-only で記録し、ノード単位の p50 を集計します。`GET /api/nodes` の各ノードに `community_timing` として `samples_count` / `tok_per_sec_p50` / `ttft_ms_p50` / `last_uploaded_at` を含めて返します。

### `GET /api/abuse-contact`

通報先（mailto:またはURL）を返します。試食UIの違法コンテンツ通知ブロックがこれを取得して表示します。

```json
{ "schema_version": 1, "contact": "mailto:abuse@example.invalid" }
```

### `POST /api/abuse/report`

通報を受け付けるエンドポイント。**自動banは行いません**。`data/abuse-reports.jsonl` に蓄積され、運営者の人間レビュー前提です。IP単位で1日あたり `LUCKRIG_ABUSE_REPORT_IP_LIMIT_PER_DAY` 件（既定10件）に制限されます。reporter IPはraw保存せず、tracker secretでHMACしたhash断片だけを残します。

```json
{
  "subject_kind": "node_id",
  "subject_id": "first-5090-qwen3",
  "reason": "違反内容の説明（最大2000文字）",
  "evidence": "URLや該当replayの参照（最大4000文字、任意）"
}
```

成功時:

```json
{
  "ok": true,
  "schema_version": 1,
  "report_id": "abcdef0123",
  "stored_at": "2026-05-22T07:00:00.000Z",
  "contact": "mailto:abuse@example.invalid",
  "note": "Report queued for human review. No automatic ban or content takedown is performed."
}
```

### `POST /api/bans`（dev-only）

`LUCKRIG_DEV=1` のときだけ有効。通報を人間がレビューした後に運営者が手動でbanを適用するためのエンドポイントです。

```json
{
  "kind": "node_id",
  "value": "first-5090-qwen3",
  "reason": "CSAM 生成への加担",
  "expires_at": null
}
```

効果:

- `user_id` / `ip` ban → `POST /api/tokens` と `POST /api/replay/timing` が 403 で拒否される
- `node_id` ban → 公開リストから除外、token発行は 404、`GET /api/nodes/:id` も 404

banは `data/bans.jsonl` に append-only で永続化され、起動時に再読込されます。`expires_at` が過去なら無効として扱います。

### `GET /api/bans`（dev-only）

現在有効なbanの一覧を返します。

レスポンス:

```json
{
  "ok": true,
  "expected": "sha256:...",
  "found": "sha256:..."
}
```

## Dev-only endpoints

### `POST /api/nodes`

`LUCKRIG_DEV=1` のときだけ有効。CLI実装前の手動登録用です。

```bash
curl -X POST http://127.0.0.1:8787/api/nodes \
  -H 'content-type: application/json' \
  -d '{
    "display_name": "local llama.cpp",
    "endpoint_url": "http://127.0.0.1:8088/v1",
    "model_name": "Qwen3-35B-A3B",
    "quantization": "Q4_K_XL",
    "gpu": "RTX 5090",
    "vram_gb": 32,
    "context_length": 65536,
    "tuning_note": "MTP n_max=2が最速。"
  }'
```

### `POST /api/probe`

`LUCKRIG_DEV=1` のときだけ有効。全ノードの死活監視を即時実行します。

## registry schema

`data/nodes.seed.json` は初期seedです。起動後はSQLite (`LUCKRIG_DB_PATH`) に取り込まれ、dev登録もSQLiteへ保存されます。

必須：

- `endpoint_url`
- `model_name`
- `quantization`
- `gpu`

任意：

- `id`
- `display_name`
- `health_url`
- `lora`
- `vram_gb`
- `context_length`
- `availability_note`
- `tuning_note`
- `tags`

## 設計メモ

- 死活監視は `health_url` をGETするだけ。生成リクエストは投げない
- `health_url` がJSONを返す場合はmemory/gpu/engine/queue等をbest-effortで正規化し、`data/metrics.jsonl` に追記する
- この段階の `rarity_score` は公開リストの初期ソート用の簡易値。CONCEPT.mdの貢献スコアとは別物
- ノードが落ちてもペナルティなし。`unavailable` 表示になるだけ
- tok/sはここでは測らない。集計値は opt-in `POST /api/replay/timing` 経由のサンプルから算出する。ノード自己申告は一次ソースとして使わない。
- モデレーションはノード側プロキシ（`LUCKRIG_MODERATION_ENDPOINT`）が担当する。出力モデレーションは `record`（既定・ストリーミング維持・事後記録）と `block`（送信前ブロック・全バッファ）の切り替え可能。trackerはban / 通報受付 / Abuse contact公開を担当する。
