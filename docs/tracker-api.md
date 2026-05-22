# Tracker API prototype

このAPIは、CONCEPT.md §「最小実装の順序」に沿ったv1/POC trackerです。無登録者向け公開リスト、死活監視、health/telemetry履歴、token発行、SQLite永続化、limited quotaを担当します。

このAPIはprompt/response本文を保存しません。tok/s / TTFTはtracker health metricsではなく、replay側のchunk timestampを一次ソースにします。現在はtoken、public-key handoff、fingerprint、SQLite永続化、limited quota、prompt filterまで実装済みです。

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
| `LUCKRIG_DB_PATH` | `data/luckrig.sqlite` | SQLite DB（runtime生成、git管理外） |
| `LUCKRIG_USE_SQLITE` | enabled | `0`でSQLiteを無効化 |
| `LUCKRIG_LIMITED_TOKENS_PER_DAY` | `5` | limited tierの1日あたりtoken発行上限 |
| `LUCKRIG_TOKEN_USAGE_RETENTION_DAYS` | `7` | 当日越え古い使用量キーの自動purge日数 |
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

### `POST /api/tokens`

試食token発行。body:

```json
{
  "node_id": "first-5090-qwen3",
  "user_id": "alice",
  "contribution_score": 1,
  "ttl_sec": 900,
  "user_public_key": "-----BEGIN PUBLIC KEY-----...",
  "node_public_key": "-----BEGIN PUBLIC KEY-----..."
}
```

レスポンスはBearer token、期限、`crypto_mode`、node public key、public key fingerprint、contribution tierを含みます。`user_public_key` を指定した場合はpublic-key modeになり、session secretは返りません。legacyとしてsession-secret modeも残っています。ブラウザ試食ではfingerprint一致入力を必須にしています。

### `GET /api/contribution/:user_id?score=1`

貢献tier判定。`score >= LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD` なら `contributor`。

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
- tok/sはここでは測らない。Step 2以降もノード自己申告ではなく、利用者側chunk timestamp由来に寄せる
