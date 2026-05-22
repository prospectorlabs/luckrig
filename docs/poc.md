# luckrig POC

このPOCは、CONCEPT.mdの「最小実装の順序」を一通りつなぎ、**tracker → token → node proxy → subtext → pseudo SSE → replay** の最短E2Eを検証するためのものです。

## 実装済みの流れ

1. **公開リスト + 死活監視**
   - `src/tracker/server.js`
   - `GET /api/nodes`
   - `health_url` を定期probe

2. **health/telemetry履歴**
   - `data/metrics.jsonl` にappend-only保存
   - memory/gpu/engine/queue/error_rateをbest-effortで正規化
   - `tok_per_sec` / `ttft_ms` はここでは扱わない

3. **ノード登録CLI**
   - `src/cli/luckrig.js`
   - `luckrig register ...`
   - POCでは `LUCKRIG_DEV=1` のtrackerに登録

4. **トークン発行**
   - `POST /api/tokens`
   - HMAC署名付きPOC token
   - contribution scoreにより `limited` / `contributor` tierを返す

5. **luckrig proxy層**
   - `src/proxy/server.js`
   - `/health`
   - `/v1/chat/completions`
   - Bearer token検証、subtext復号、upstream呼び出し、レスポンスbuffer、一括暗号化、pseudo SSE返却

6. **subtext**
   - `src/subtext/index.js`
   - Unicode variation selectorにAES-GCM envelopeを埋め込む
   - X25519 + HKDF + AES-GCMの公開鍵envelopeに対応
   - 後方互換のlegacy session-secret modeも残す

7. **replay**
   - `src/client/replay.js`
   - pseudo SSEから暗号化レスポンスを取り出して復号
   - `~/.luckrig/history/` 互換のschema_version付きJSONを保存

## 重要なPOC caveat

初期POCのtokenは、ローカルE2Eテストを成立させるために `session_secret` を含んでいました。現在は `user_public_key` / `node_public_key` を使う **public-key POC mode** を実装済みで、`sha256:` 公開鍵fingerprintも返します。legacy session-secret modeは後方互換として残っています。

CONCEPT上の最終形：

- 利用者公開鍵をtracker経由でnode proxyへ渡す
- promptはnode公開鍵で暗号化
- responseは利用者公開鍵で暗号化
- tracker単独では平文を読めない
- tracker + nodeが共謀すれば公開鍵すり替えが可能、というtrust modelを明示

現在のPOC上の簡略化：

- tracker/proxyが共有するHMAC secretでtoken検証
- token payloadには利用者公開鍵とノード公開鍵を含める（秘密鍵は含めない）
- promptはノード公開鍵で暗号化し、proxyがノード秘密鍵で復号
- responseは利用者公開鍵で暗号化し、clientが利用者秘密鍵で復号
- tracker + nodeの共謀による公開鍵すり替えリスクはCONCEPT通り残る（POCはfingerprintを露出するが、検証UXは未実装）

## ローカル起動例

Codexサンドボックス外の通常shell想定です。

### key generation

```bash
node src/cli/luckrig.js keygen --out-prefix node
node src/cli/luckrig.js keygen --out-prefix user
```

### tracker

```bash
LUCKRIG_DEV=1 \
LUCKRIG_TRACKER_SECRET=dev-secret \
npm start
```

### node proxy

```bash
LUCKRIG_NODE_ID=first-5090-qwen3 \
LUCKRIG_TRACKER_SECRET=dev-secret \
LUCKRIG_NODE_PRIVATE_KEY="$(cat node-private.pem)" \
node src/proxy/server.js
```

`LUCKRIG_UPSTREAM_URL` を設定しない場合、proxyはmock upstreamとして `mock:<prompt>` を返します。

llama.cpp / ollama等へforwardする場合：

```bash
LUCKRIG_UPSTREAM_URL=http://127.0.0.1:8088/v1 node src/proxy/server.js
```

### register

```bash
node src/cli/luckrig.js register \
  --tracker http://127.0.0.1:8787 \
  --id first-5090-qwen3 \
  --endpoint-url http://127.0.0.1:8788/v1 \
  --health-url http://127.0.0.1:8788/health \
  --model-name Qwen3-35B-A3B \
  --quantization Q4_K_XL \
  --gpu RTX_5090 \
  --vram-gb 32 \
  --context-length 65536 \
  --node-public-key "$(cat node-public.pem)"
```

### token

```bash
node src/cli/luckrig.js token \
  --tracker http://127.0.0.1:8787 \
  --node-id first-5090-qwen3 \
  --user-id alice \
  --contribution-score 1 \
  --user-public-key "$(cat user-public.pem)"
```

### tests

CodexサンドボックスではlistenがEPERMになるため、E2E testはHTTP listenを使わず、tracker/proxy handlerを直接呼びます。

```bash
npm test
```

検証されること：

- tracker registry読み込み
- health/telemetry metrics JSONL生成
- token発行API
- contribution tier判定
- X25519公開鍵ペア生成
- subtext public-key encrypt/decrypt
- proxy token検証
- prompt復号 → mock upstream → response暗号化
- pseudo SSE生成
- replay record作成・保存・読み戻し
- invalid token拒否

## Browser tasting POC

Public UIの各ノードカードには `試食する / browser POC` パネルがあります。現時点のブラウザ実装は、WebCrypto互換性を優先してlegacy `session-secret` token modeを使います。流れは以下です。

1. trust checkboxを確認
2. `POST /api/tokens` で短命tokenを取得
3. browser WebCrypto AES-GCMでpromptをsubtext化
4. node proxyへOpenAI互換リクエスト
5. pseudo SSEを復号
6. replay JSONをdownload

Node/CLI E2Eではpublic-key modeを検証済みです。ブラウザのproduction public-key flowはfingerprint確認UXと合わせて後続です。

## まだPOC外のこと

- production-grade公開鍵フィンガープリント検証 / 鍵すり替え対策
- 永続DB
- durable quota enforcement（POCはlimited出力truncateのみ）
- NSFW filter
- 実tokenizerによるtok/s算出
- production public-key browser tasting（現ブラウザPOCはlegacy session-secret mode）
- contribution scoreの本採点
