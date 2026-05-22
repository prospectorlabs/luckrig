# Metrics / telemetry schema

luckrig Step 1.5では、ノード登録情報と観測値を分離するため、死活監視の結果をappend-only JSONLに保存します。

- registry: `data/nodes.seed.json` — ノードが申告する静的情報
- metrics: SQLite `data/luckrig.sqlite` の `metrics` table + JSONL mirror `data/metrics.jsonl`（runtime生成、git管理対象外）

この分離により、ノード情報を編集しても観測履歴が壊れません。現実装ではSQLiteをdurable store、JSONLを互換mirrorとして使います。

## なぜtok/s / TTFTをここに入れないか

CONCEPT.mdの方針に従い、`tok_per_sec` と `ttft_ms` はノード自己申告ではなく、利用者側のchunk timestamps / replay dataを一次ソースにします。

そのためこのmetrics schemaでは以下を扱います：

- trackerから見た死活状態
- health check latency
- health endpointが返した任意telemetry
- health probe失敗によるエラー率の材料

health metrics JSONLの責務外（replay側で扱うもの）：

- `tok_per_sec`
- `ttft_ms`
- 生成品質
- 出力検証

## JSONL sample

1行1観測です。

```json
{
  "schema_version": 1,
  "type": "health_probe",
  "observed_at": "2026-05-22T07:00:00.000Z",
  "node_id": "first-5090-qwen3",
  "status": "available",
  "latency_ms": 18,
  "health_url": "http://127.0.0.1:8088/health",
  "telemetry": {
    "memory": {
      "used_mb": 21000,
      "total_mb": 32768,
      "free_mb": 11768
    },
    "gpu": {
      "name": "RTX 5090",
      "utilization_pct": 12,
      "memory_used_mb": 21000,
      "memory_total_mb": 32768,
      "temperature_c": 54,
      "power_w": 180
    },
    "engine": {
      "name": "llama.cpp",
      "version": "b9999",
      "backend": "cuda"
    },
    "queue": {
      "depth": 0,
      "active": 0
    },
    "error_rate": 0,
    "active_requests": 0
  },
  "error": null
}
```

失敗時：

```json
{
  "schema_version": 1,
  "type": "health_probe",
  "observed_at": "2026-05-22T07:00:00.000Z",
  "node_id": "first-5090-qwen3",
  "status": "unavailable",
  "latency_ms": null,
  "health_url": "http://127.0.0.1:8088/health",
  "telemetry": null,
  "error": "timeout after 2000ms"
}
```

## health endpointの任意レスポンス

ノード側の `health_url` はHTTP 2xxを返せばavailableとして扱われます。JSON bodyは任意です。

trackerは以下のようなキーをbest-effortで正規化します：

```json
{
  "memory": {
    "used_mb": 21000,
    "total_mb": 32768,
    "free_mb": 11768
  },
  "gpu": {
    "name": "RTX 5090",
    "utilization_pct": 12,
    "memory_used_mb": 21000,
    "memory_total_mb": 32768,
    "temperature_c": 54,
    "power_w": 180
  },
  "engine": {
    "name": "llama.cpp",
    "version": "b9999",
    "backend": "cuda"
  },
  "queue": {
    "depth": 0,
    "active": 0
  },
  "error_rate": 0,
  "active_requests": 0
}
```

互換エイリアス：

- `memory`, `mem`, `ram`, `vram`
- `gpu`, `cuda`, `accelerator`
- `engine`, `runtime`, `server`
- `used_mb`, `usedMiB`, `used_mib`, `used`
- `total_mb`, `totalMiB`, `total_mib`, `total`

## Summary API

`GET /api/metrics` はJSONLを集約したサマリを返します。

```json
{
  "schema_version": 1,
  "source": "health_probe_jsonl",
  "summaries": [
    {
      "node_id": "first-5090-qwen3",
      "samples_count": 10,
      "available_samples": 8,
      "unavailable_samples": 2,
      "unknown_samples": 0,
      "availability_ratio": 0.8,
      "last_observed_at": "2026-05-22T07:00:00.000Z",
      "last_status": "available",
      "last_latency_ms": 18,
      "last_memory": {
        "used_mb": 21000,
        "total_mb": 32768
      },
      "last_gpu": {
        "utilization_pct": 12
      },
      "last_engine": {
        "name": "llama.cpp"
      },
      "last_queue": {
        "depth": 0,
        "active": 0
      },
      "last_error_rate": 0,
      "last_error": null
    }
  ]
}
```

## Runtime file policy

`data/*.jsonl` はruntime dataなので `.gitignore` しています。リポジトリに入れるのはschemaとサンプルだけです。
