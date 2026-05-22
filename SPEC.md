# luckrig — Technical Specification

Status: **v1/POC implemented / current technical spec**  
Source of truth: [`CONCEPT.md`](./CONCEPT.md)  
Related docs: [`README.md`](./README.md), [`docs/poc.md`](./docs/poc.md), [`docs/tracker-api.md`](./docs/tracker-api.md), [`docs/metrics-schema.md`](./docs/metrics-schema.md)

---

## 1. Purpose

luckrig is an **on-premises LLM inference API sharing platform**.

It lets users discover and try OpenAI-compatible text-generation APIs currently running on other people's local machines. Access is contribution-based, not SLA-based. The platform is designed as a real-time map of local LLM infrastructure rather than a model leaderboard.

The POC proves this path:

```text
tracker
  → public node list
  → health / telemetry collection
  → tasting token
  → node proxy
  → prompt hiding
  → buffered generation
  → pseudo SSE response
  → local replay record
```

---

## 2. Product Scope

### 2.1 In scope for v1

- Text generation only
- OpenAI-compatible Chat Completions style API as the baseline transport (**plain mode**), so vanilla OpenAI clients work without subtext-aware code
- Optional **subtext mode** that wraps prompt / response in AES-GCM + Unicode variation selectors, opt-in per request
- Public node listing
- Liveness monitoring
- Basic telemetry collection
- Queue depth/active visibility
- Environment filters and comparison table
- Node registration CLI
- Node-side proxy layer
- Contribution-aware tasting token issuance
- Multi-axis node contribution scoring
- Auto-generated Showcase categories
- Browser identity persistence for repeated tastings
- Optional out-of-band fingerprint URL verification
- IP-based token rate limiting
- Buffered generation with pseudo SSE playback (subtext mode only)
- Local replay persistence
- Opt-in timing-metadata upload from client to tracker (no prompt / response body)

### 2.2 Out of scope for v1

- Image generation / ComfyUI
- Voice synthesis / RVC
- Speech recognition / Whisper
- Guaranteed SLA
- Payment / credit marketplace
- Attestation / canary prompts / output verification
- Image/audio modality filtering beyond text prompt policy
- Strong key-substitution mitigation beyond optional fingerprint self-checks

### 2.3 Non-negotiable product constraints

The following are intentional design decisions from `CONCEPT.md` and must not be silently changed:

1. **No attestation or canary prompt verification**  
   False listings are addressed structurally, not through hard verification.

2. **Contribution score is status-like, not a tradable asset**  
   Do not implement transferable credits as the primary model.

3. **Default discovery is rarity / Showcase oriented**  
   Do not sort default lists by highest GPU performance.

4. **tok/s is not node self-report**  
   In plain mode it is measured client-side from real SSE chunk timestamps. In subtext mode it is measured by the node proxy (because pseudo SSE chunk timestamps reflect replay rate, not generation rate) and surfaced inside the response envelope; the client persists that value verbatim into replay. In both cases the listing-level self-report is not the source of truth.

5. **Replay is local-first**  
   Prompt and response body always live locally only. Timing-only metadata may be uploaded to tracker **explicitly per request by the user**, never automatically.

6. **Privacy is limited and must be stated honestly**  
   Use the phrase “頑張らなければ見えない” carefully: tcpdump/logs should not reveal plaintext, but a node operator who instruments the process can still see plaintext.

---

## 3. Architecture

```text
┌──────────────────┐
│ Public Web UI     │
│ /                 │
└─────────┬────────┘
          │ GET /api/nodes
          ▼
┌──────────────────┐
│ Tracker           │
│ - registry        │
│ - liveness        │
│ - telemetry JSONL │
│ - tasting token   │
└─────────┬────────┘
          │ health probe / token
          ▼
┌──────────────────┐        OpenAI-compatible API
│ Node Proxy        │ ─────────────────────────────▶ ollama / llama.cpp / mock
│ - /health         │
│ - token verify    │
│ - subtext decode  │
│ - buffer output   │
│ - subtext encode  │
└─────────┬────────┘
          │ pseudo SSE
          ▼
┌──────────────────┐
│ Client / Replay   │
│ ~/.luckrig/history│
└──────────────────┘
```

### 3.1 Tracker

Implementation: `src/tracker/server.js`

Responsibilities:

- Serve public node list
- Serve static prototype UI
- Load node registry
- Probe node `health_url`
- Append health / telemetry samples to JSONL
- Aggregate metrics summaries
- Issue POC tasting tokens
- Expose dev-only manual registration / probe endpoints

Tracker must not:

- Store prompts or responses
- Perform generation requests as part of liveness probing
- Treat node-reported tok/s as authoritative

### 3.2 Node Proxy

Implementation: `src/proxy/server.js`

Responsibilities:

- Expose `/health`
- Expose OpenAI-compatible `/v1/chat/completions`
- Verify tasting token
- Extract subtext prompt from `messages[].content`
- Decrypt prompt envelope
- Forward plaintext prompt to upstream OpenAI-compatible endpoint
- Buffer upstream response completely
- Encrypt response envelope
- Return encrypted response as pseudo SSE or JSON completion

Node Proxy must not:

- Log plaintext prompt / response
- Pretend plaintext is impossible to observe inside the process
- Stream raw upstream chunks directly to user in the subtext path

### 3.3 CLI

Implementation: `src/cli/luckrig.js`

Commands:

```bash
luckrig register ...
luckrig token ...
luckrig proxy ...
luckrig keygen ...
```

POC command examples are documented in [`docs/poc.md`](./docs/poc.md).

### 3.4 subtext

Implementation: `src/subtext/index.js`

subtext is the **optional defense-in-depth layer**, not the baseline. The POC encodes encrypted bytes into Unicode variation selectors.

- AES-256-GCM provides confidentiality / integrity for the payload envelope.
- Variation selectors provide invisible embedding inside a cover string.
- Cover text has no security meaning.

Implementation note:

- Current POC supports public-key envelopes using X25519 + HKDF-SHA256 + AES-256-GCM and exposes `sha256:` SPKI fingerprints for public keys.
- Legacy session-secret mode remains only for compatibility tests and should not be used as the preferred path.
- subtext mode forces full-buffered generation and pseudo SSE. Plain mode is the baseline and should be used whenever true SSE streaming or vanilla OpenAI compatibility is needed.

### 3.5 Replay

Implementation: `src/client/replay.js`

Responsibilities:

- Parse pseudo SSE chunks
- Extract encrypted subtext content
- Decrypt response envelope
- Build replay record
- Save replay JSON locally

Default local history path:

```text
~/.luckrig/history/
```

---

## 4. Runtime Configuration

### 4.1 Tracker environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `LUCKRIG_HOST` | `127.0.0.1` | Tracker bind host |
| `LUCKRIG_PORT` | `8787` | Tracker bind port |
| `LUCKRIG_REGISTRY_PATH` | `data/nodes.seed.json` | Node registry JSON path |
| `LUCKRIG_METRICS_PATH` | `data/metrics.jsonl` | Runtime health/telemetry JSONL mirror path |
| `LUCKRIG_TOKEN_USAGE_PATH` | `data/token-usage.jsonl` | Runtime token-usage JSONL mirror path |
| `LUCKRIG_DB_PATH` | `data/luckrig.sqlite` | SQLite DB for registry, metrics, token usage, contribution state |
| `LUCKRIG_USE_SQLITE` | enabled | Set `0` to disable SQLite and use JSON/JSONL only |
| `LUCKRIG_HEALTH_INTERVAL_MS` | `30000` | Health probe interval |
| `LUCKRIG_HEALTH_TIMEOUT_MS` | `2000` | Health probe timeout per node |
| `LUCKRIG_DEV` | unset | Enables dev-only write endpoints when `1` |
| `LUCKRIG_TRACKER_SECRET` | dev default | HMAC secret for token signing |
| `LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD` | `1` | POC threshold for `contributor` tier |

### 4.2 Proxy environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `LUCKRIG_PROXY_HOST` | `127.0.0.1` | Proxy bind host |
| `LUCKRIG_PROXY_PORT` | `8788` | Proxy bind port |
| `LUCKRIG_NODE_ID` | `local-poc-node` | Node ID expected in tasting token |
| `LUCKRIG_TRACKER_SECRET` | dev default | HMAC secret shared with tracker in POC |
| `LUCKRIG_UPSTREAM_URL` | unset | OpenAI-compatible upstream base URL. If unset, proxy uses mock generation |
| `LUCKRIG_NODE_PRIVATE_KEY` | unset | PEM private key used to decrypt public-key subtext prompts |
| `LUCKRIG_MAX_ACTIVE_REQUESTS` | `1` | Max concurrent upstream generations per proxy; extra requests wait in queue |
| `LUCKRIG_LIMITED_OUTPUT_CHARS` | `240` | POC truncation length for limited-tier output |
| `LUCKRIG_LIMITED_TOKENS_PER_DAY` | `5` | Daily token quota for limited-tier users |
| `LUCKRIG_TOKEN_USAGE_RETENTION_DAYS` | `7` | Days to keep token usage entries in-memory before purging |
| `LUCKRIG_TOKEN_IP_LIMIT_PER_DAY` | `100` | IP-level daily token issuance limit |

---

## 5. Data Model

### 5.1 Node registry

Runtime file:

```text
data/nodes.seed.json
```

Shape: array of node records.

Required fields:

| Field | Type | Description |
| --- | --- | --- |
| `endpoint_url` | string | OpenAI-compatible API base URL |
| `model_name` | string | Model name shown in public list |
| `quantization` | string | Quantization label |
| `gpu` | string | GPU / accelerator / CPU description |

Optional fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Stable node ID. Auto-derived if omitted |
| `display_name` | string | Public display name |
| `health_url` | string | Health endpoint. Defaults to `${endpoint_url without /v1}/health` |
| `node_public_key` | string | PEM X25519 public key for prompt encryption |
| `lora` | string | LoRA information |
| `vram_gb` | number/null | VRAM amount |
| `context_length` | number/null | Context window |
| `availability_note` | string | Human-readable uptime note |
| `tuning_note` | string | Freeform tuning note |
| `tags` | string[] | Tags such as `showcase`, `cpu`, `apple-silicon` |

### 5.2 Health state

Attached to public node response at runtime:

```json
{
  "status": "available",
  "last_checked_at": "2026-05-22T07:00:00.000Z",
  "last_seen_at": "2026-05-22T07:00:00.000Z",
  "latency_ms": 18,
  "consecutive_failures": 0,
  "last_error": null
}
```

Allowed statuses:

- `unknown`
- `available`
- `unavailable`

### 5.3 Metrics JSONL

Runtime file:

```text
data/metrics.jsonl
```

This file is append-only runtime mirror data and must not be committed. SQLite is the durable store by default in the current implementation.

One line per health probe:

```json
{
  "schema_version": 1,
  "type": "health_probe",
  "observed_at": "2026-05-22T07:00:00.000Z",
  "node_id": "first-5090-qwen3",
  "status": "available",
  "latency_ms": 18,
  "health_url": "http://127.0.0.1:8788/health",
  "telemetry": {
    "memory": { "used_mb": 21000, "total_mb": 32768 },
    "gpu": { "utilization_pct": 12 },
    "engine": { "name": "luckrig-proxy" },
    "queue": { "depth": 0, "active": 0 },
    "error_rate": 0,
    "active_requests": 0
  },
  "error": null
}
```

Detailed schema: [`docs/metrics-schema.md`](./docs/metrics-schema.md)

### 5.4 Replay record

Local-only file:

```text
~/.luckrig/history/YYYY-MM-DD_HHMMSS_{node_id}.json
```

Shape:

```json
{
  "schema_version": 1,
  "created_at": "2026-05-22T07:00:00.000Z",
  "prompt": "hello",
  "response": "mock:hello",
  "node_id": "first-5090-qwen3",
  "queue_wait_sec": 0,
  "generation_sec": 0.012,
  "tok_per_sec": 250,
  "ttft_ms": 0,
  "chunk_timestamps": [1779430000000]
}
```

Rules:

- Replay must include `schema_version`.
- Replay is local-first and must not be uploaded to tracker by default.
- Current token estimation uses an approximate character-based token count. Model/tokenizer-aware counting can be added later for more accurate benchmarking.

---

## 6. HTTP API

### 6.1 Public UI

```http
GET /
```

Serves static prototype node-list UI.

### 6.2 Tracker health

```http
GET /api/health
```

Response includes tracker service status, registry path, metrics path, node count, and health probe configuration.

### 6.3 List nodes

```http
GET /api/nodes?status=all|available|unavailable|unknown
```

Response:

```json
{
  "schema_version": 1,
  "sort": "rarity_score_desc_then_vram_asc",
  "nodes": []
}
```

Sorting rule:

1. `rarity_score` descending
2. `vram_gb` ascending
3. `created_at` ascending

This intentionally prevents the default list from becoming a high-end GPU leaderboard.

### 6.4 Get node

```http
GET /api/nodes/:id
```

Returns one public node record.

### 6.5 Metrics summary

```http
GET /api/metrics
GET /api/metrics/:id
```

Returns aggregated health probe summaries from JSONL.

### 6.6 Issue tasting token

```http
POST /api/tokens
Content-Type: application/json

{
  "node_id": "first-5090-qwen3",
  "user_id": "alice",
  "contribution_score": 1,
  "ttl_sec": 900,
  "user_public_key": "-----BEGIN PUBLIC KEY-----...",
  "node_public_key": "-----BEGIN PUBLIC KEY-----..."
}
```

POC response:

```json
{
  "schema_version": 1,
  "token_type": "Bearer",
  "token": "...",
  "expires_at": "2026-05-22T07:15:00.000Z",
  "crypto_mode": "public-key",
  "session_secret": null,
  "node_public_key": "-----BEGIN PUBLIC KEY-----...",
  "node_public_key_fingerprint": "sha256:...",
  "user_public_key_fingerprint": "sha256:...",
  "contribution": {
    "user_id": "alice",
    "contribution_score": 1,
    "tier": "contributor"
  },
  "node": {},
  "caveat": "Public-key POC mode: prompt is encrypted for node key and response is encrypted for user key. Tracker still signs and transports public keys."
}
```

Implementation note:

- Default token mode is `crypto_mode: plain` (OpenAI-compatible baseline) when the client does not supply `user_public_key` and does not explicitly request another mode.
- `crypto_mode: public-key` (subtext mode with X25519 / HKDF / AES-GCM) is selected when the client supplies `user_public_key` or explicitly requests `"crypto_mode": "public-key"`.
- `crypto_mode: session-secret` (subtext mode with shared secret) remains for compatibility only and must be requested explicitly.
- Current UI displays/copies fingerprints and offers exact fingerprint input or URL verification as optional self-checks. Stronger alternate trust channels can be added later to further mitigate tracker/node key substitution.

### 6.7 Contribution status

```http
GET /api/contribution/:user_id?score=1
```

POC tier rule:

```text
score >= LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD → contributor
otherwise                                      → limited
```

### 6.8 Dev-only node registration

Enabled only when `LUCKRIG_DEV=1`:

```http
POST /api/nodes
```

Used by CLI/dev registration flow in the current implementation.

### 6.9 Dev-only manual probe

Enabled only when `LUCKRIG_DEV=1`:

```http
POST /api/probe
```

Runs health probes immediately.

### 6.10 Proxy health

```http
GET /health
```

Returns node proxy health and optional telemetry.

### 6.11 Proxy chat completions

```http
POST /v1/chat/completions
Authorization: Bearer {tasting_token}
Content-Type: application/json

{
  "model": "luckrig-poc",
  "stream": true,
  "messages": [
    { "role": "user", "content": "plain prompt (plain mode) OR cover text + invisible subtext (subtext mode)" }
  ]
}
```

Behavior (plain mode, default baseline):

1. Verify Bearer token.
2. Verify token `node_id` matches proxy node ID.
3. Reject any non-`user` message.
4. Forward the plaintext user prompt to upstream (or mock).
5. Stream upstream SSE chunks back as they arrive (or emit a single chunk for non-streaming upstream / mock).
6. Apply limited-tier truncation when token tier is `limited`.
7. Tag the final SSE event with a `luckrig.timing` payload containing measured proxy-side timing.

Behavior (subtext mode, opt-in):

1. Verify Bearer token.
2. Verify token `node_id` matches proxy node ID.
3. Reject any non-`user` message and any plaintext (subtext-less) message.
4. Extract invisible subtext payload.
5. Decrypt prompt envelope.
6. Forward only the decrypted user prompt to upstream (or mock).
7. Buffer complete response.
8. Encrypt response envelope.
9. Apply limited-tier truncation when token tier is `limited`.
10. Return pseudo SSE chunks when `stream: true`.

### 6.12 Opt-in timing-metadata upload

```http
POST /api/replay/timing
Content-Type: application/json

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

Behavior:

1. Reject any payload that contains `prompt`, `response`, `chunk_timestamps`, `messages`, or other body fields. Only allow the timing-only allowlist.
2. Append to `data/timing.jsonl` (JSONL append-only).
3. Update an in-memory aggregate per node (`samples_count`, `tok_per_sec` p50, `ttft_ms` p50, last upload at).
4. Aggregates are surfaced in `GET /api/nodes` so the public list shows community-measured tok/s.

Privacy guarantees:

- This endpoint is only ever hit when the client UI / CLI explicitly invokes it; default is off.
- The endpoint rejects any oversized body and any non-allowlisted field as a defense against accidental upload of prompt or response body.
- Aggregates are exposed; raw per-upload rows are not exposed via public APIs.

---

## 7. Security and Privacy Model

### 7.1 Intended protection

subtext + AES-GCM is intended as an operational privacy courtesy: plaintext prompt / response should not appear in ordinary network capture or naive logs. It is not the main product promise, and users must not send secrets.

### 7.2 Explicit limits

Node operators can still see plaintext if they instrument:

- the proxy process
- the upstream inference process
- memory
- debugger hooks
- modified llama.cpp / ollama input path

Therefore, luckrig must not claim malicious-node-proof end-to-end privacy.

### 7.3 Tracker trust model

Target trust model from `CONCEPT.md`:

- Tracker alone cannot read plaintext.
- Node alone cannot decrypt response intended for user private key.
- Tracker + node can collude by swapping public keys.
- This trust model must be documented clearly in UI and docs.

POC simplification:

- Tracker/proxy share HMAC secret for token verification.
- Token carries user/node public keys, and the proxy decrypts with the node private key.
- The client decrypts response with the user private key.
- Tracker + node key-substitution risk remains. The current UI displays fingerprints and offers exact fingerprint input or URL verification as optional self-checks; alternate trust channels remain optional hardening.

### 7.4 Token requirements

Current token:

- HMAC-SHA256 signed
- Includes `node_id`, `user_id`, `tier`, `iat`, `exp`, `jti`, `crypto_mode`; public-key mode also includes `user_public_key` and optionally `node_public_key`; plain mode carries no key material
- Must reject invalid signature
- Must reject expired token
- Must reject node mismatch

Hardening target for token/key trust:

- Must prefer public-key mode.
- Must expose public-key fingerprint and allow optional user confirmation before browser tasting; stronger alternate trust channels are future hardening.

---

## 8. Contribution and Access Model

### 8.1 Access tiers

Conceptual model:

1. Anonymous users can view public list.
2. Registered but non-contributing users get limited tasting access.
3. Contributors get broad/full access.

POC implementation:

- Anonymous list viewing is implemented.
- Token issuance accepts `contribution_score` input.
- `score >= threshold` gives `contributor` tier.
- POC implements limited-tier durable token quota and output truncation; full multi-axis contribution scoring remains future work.

### 8.2 Contribution score principles

Current node contribution score includes the following POC components; future scoring can refine weights and add note reference analytics:

- Existence score
- Rarity score
- Usage score (token-issued count as current proxy)
- Discovery score (distinct tasting users)
- Tuning-note score

Permanent access rights and Showcase ranking must remain separate systems.

---

## 9. Benchmarking and Observability

### 9.1 Implemented now

- Proxy queue snapshot (`active`, `waiting/depth`, `max_active`)
- Proxy-side TTFT approximation (`proxy_ttft_ms`) captured before pseudo SSE
- Replay `network_ttft_ms` separated from proxy-side TTFT
- `luckrig-heuristic-v1` output token estimate with model-family hint

- Health status
- Probe latency
- Consecutive failures
- Availability ratio
- Optional memory / GPU / engine / queue telemetry
- JSONL append-only metrics

### 9.2 Not authoritative yet

- `tok_per_sec` in POC replay uses approximate token estimation (`luckrig-heuristic-v1`).
- In plain mode, `chunk_timestamps` reflect true upstream SSE chunk arrival, so `tok_per_sec` is a real client-side measurement (modulo token-count approximation).
- In subtext mode, `chunk_timestamps` reflect pseudo SSE replay rate, not real generation rate. The authoritative tok/s in subtext mode is the proxy-measured value carried inside the response envelope.
- `ttft_ms` in subtext mode is the proxy-measured upstream TTFT; in plain mode it is the client-observed first-chunk time (network-inclusive).

### 9.3 Benchmark rule

Benchmark fields must be derived from client / proxy timestamp evidence, not from listing-level node self-report. Aggregate community tok/s requires opt-in timing upload (§6.12).

---

## 10. POC Test Specification

### 10.1 Commands

```bash
npm run check
npm run test:smoke
npm run test:e2e
npm test
```

### 10.2 `npm run check`

Must syntax-check:

- tracker
- proxy
- CLI
- subtext
- replay
- tasting client helper

### 10.3 `npm run test:smoke`

Must verify:

- registry can load
- health probes run without crashing
- public node list contains seed nodes
- metrics summary is produced
- static UI marker exists

### 10.4 `npm run test:e2e`

Must verify:

- tracker registry and metrics initialization
- `POST /api/tokens`
- contribution tier calculation
- CLI register request construction
- tasting token signature verification
- subtext public-key prompt encryption/decryption
- proxy token validation
- prompt decryption
- mock upstream generation
- encrypted response envelope
- pseudo SSE output
- replay creation
- replay save/load
- invalid token rejection

### 10.5 Current known Codex sandbox constraint

In the Codex sandbox, binding local ports may fail with `EPERM`. Tests therefore call tracker/proxy handlers directly instead of relying on listening sockets.

---

## 11. Local Development

### 11.1 Install / run

No external dependencies are required for the current POC.

```bash
npm test
```

### 11.2 Generate keys

```bash
node src/cli/luckrig.js keygen --out-prefix node
node src/cli/luckrig.js keygen --out-prefix user
```

### 11.3 Start tracker

```bash
LUCKRIG_DEV=1 \
LUCKRIG_TRACKER_SECRET=dev-secret \
npm start
```

### 11.4 Start proxy

```bash
LUCKRIG_NODE_ID=first-5090-qwen3 \
LUCKRIG_TRACKER_SECRET=dev-secret \
LUCKRIG_NODE_PRIVATE_KEY="$(cat node-private.pem)" \
node src/proxy/server.js
```

Mock mode is used when `LUCKRIG_UPSTREAM_URL` is unset.

Forwarding mode:

```bash
LUCKRIG_NODE_PRIVATE_KEY="$(cat node-private.pem)" \
LUCKRIG_UPSTREAM_URL=http://127.0.0.1:8088/v1 \
node src/proxy/server.js
```

### 11.5 CLI examples

```bash
node src/cli/luckrig.js register \
  --tracker http://127.0.0.1:8787 \
  --endpoint-url http://127.0.0.1:8788/v1 \
  --health-url http://127.0.0.1:8788/health \
  --model-name Qwen3-35B-A3B \
  --quantization Q4_K_XL \
  --gpu RTX_5090 \
  --vram-gb 32 \
  --node-public-key "$(cat node-public.pem)"
```

```bash
node src/cli/luckrig.js token \
  --tracker http://127.0.0.1:8787 \
  --node-id first-5090-qwen3 \
  --user-id alice \
  --contribution-score 1 \
  --user-public-key "$(cat user-public.pem)"
```

---

## 12. Repository Layout

```text
CONCEPT.md                 Product concept / source of truth
SPEC.md                    This technical specification
README.md                  Human-facing overview
AGENTS.md                  Agent guardrails

data/nodes.seed.json       Seed node registry

docs/poc.md                POC guide
docs/tracker-api.md        Tracker API details
docs/metrics-schema.md     Metrics JSONL schema

public/                    Prototype public list UI
scripts/smoke-test.js      Smoke test
scripts/e2e-test.js        End-to-end POC test

src/tracker/               Tracker server
src/proxy/                 Node proxy
src/cli/                   CLI
src/subtext/               subtext + AES-GCM helpers
src/client/                Tasting/replay client helpers
src/shared/                shared token/base64url helpers
```

---

## 13. Future Hardening Backlog

The v1/POC path is implemented and tested. Remaining items below are hardening or v6+ scope, not incomplete current-scope implementation:

1. More alternate trust channels for node public-key fingerprint publication beyond the implemented optional fingerprint URL verifier.
2. SQLite schema migration/admin tooling.
3. Quota management UI and long-term abuse analytics.
4. Production account/registration workflow around the existing node registration API.
5. Optional real llama.cpp / ollama integration test profile when such endpoints are available.
6. Model-tokenizer integration for more accurate replay benchmark calculations.
7. Prompt filter rule tuning based on real community examples.
8. Expanded operational docs for node providers.
10. Migration/versioning tooling for metrics and replay schemas.

---

## 14. Acceptance Criteria for Current POC

The current POC is considered valid when all of the following hold:

- `npm test` passes.
- Public seed nodes load from registry.
- Health probes append metrics samples without committing runtime JSONL.
- Tracker can issue a POC tasting token for a node.
- Tracker default token mode is `plain` when no key material is provided.
- Proxy can validate the token and node binding.
- Proxy plain mode forwards a plaintext OpenAI-compatible request to upstream and streams real (per-chunk) SSE back.
- Prompt can be encrypted into subtext and decrypted by proxy.
- Proxy can generate or forward a response after buffering.
- Response can be encrypted into subtext and returned through pseudo SSE.
- Client can parse pseudo SSE and create a local replay record.
- Replay record can be saved and loaded.
- Client can opt-in upload timing-only metadata to tracker (no prompt / response body), and the tracker rejects any disallowed field.
- Public node list surfaces community-aggregated tok/s when timing uploads exist.
- Invalid token is rejected.
- Docs and UI require a privacy caveat acknowledgement, display optional fingerprint self-checks, and clearly state remaining trust limits.
