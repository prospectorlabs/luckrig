# luckrig — User Stories

Status: **draft aligned with CONCEPT v5.2 and current POC**  
Source of truth: [`CONCEPT.md`](./CONCEPT.md)  
Technical spec: [`SPEC.md`](./SPEC.md)  
POC guide: [`docs/poc.md`](./docs/poc.md)

---

## 1. Purpose

This document translates the luckrig concept and current POC into user-facing stories and acceptance criteria.

The primary target is **engineers who can evaluate local LLM risk and operate their own tooling**. General consumer UX is intentionally not the target.

The main narrative is:

> I can discover a real on-prem LLM rig, understand its environment, safely-enough try it with my own prompt, replay the result locally, and decide whether to reproduce or contribute a rig myself.

---

## 2. Personas

### P1. Visitor / Window Shopper

A technically curious engineer who has not registered or contributed yet.

Goals:

- See what rigs are currently online or recently observed.
- Compare models, quantization, GPU, context length, and tuning notes.
- Understand that luckrig is experimental and not SLA-backed.
- Decide whether it is worth registering or contributing.

Non-goals:

- Run arbitrary private business-critical workloads.
- Receive consumer-grade trust guarantees.

### P2. Taster / Non-contributing Registered User

A registered engineer with little or no contribution score.

Goals:

- Get limited tasting access.
- Try a prompt against a chosen node.
- Experience the queue / pseudo SSE flow.
- Save a local replay.
- Understand the privacy/trust caveats before use.

Non-goals:

- Unlimited usage.
- Business-critical availability.

### P3. Contributor / Node Provider

An engineer with a local LLM environment, e.g. llama.cpp or ollama, who wants to make a rig available.

Goals:

- Register a node with one command.
- Keep control over their machine.
- Expose a proxy rather than the raw inference server.
- See health/telemetry and whether the rig is used.
- Earn contribution status and Showcase visibility.

Non-goals:

- Be penalized for going offline.
- Become responsible for output quality or uptime.

### P4. Reproducer / Hardware Evaluator

An engineer deciding how to configure or buy local hardware.

Goals:

- Filter for rigs close to their own setup.
- Read tuning notes tied to live nodes.
- Try prompts on hardware they do not own.
- Use replay data to compare practical performance.

### P5. Tracker Operator / Maintainer

A maintainer running the central tracker.

Goals:

- Keep registry, health, telemetry, and tokens lightweight.
- Avoid storing prompts/responses.
- Make trust boundaries explicit.
- Preserve Showcase diversity.

---

## 3. Epic Overview

| Epic | Title | Current POC status |
| --- | --- | --- |
| E1 | Public discovery | Implemented as public node list UI/API |
| E2 | Node registration | POC CLI + dev registration implemented |
| E3 | Health and telemetry | Implemented via JSONL metrics |
| E4 | Contribution-aware access | Token/tier, durable limited quota, truncation, and node contribution scoring implemented |
| E5 | Privacy-aware tasting | POC public-key subtext + proxy implemented |
| E6 | Queue UX / pseudo SSE | Implemented in proxy and browser tasting POC |
| E7 | Local replay | Implemented, including browser replay JSON download |
| E8 | Showcase and diversity | Auto Showcase categories, rarity visibility, environment filters, and comparison table implemented |
| E9 | Trust, disclaimers, and safety | Trust notice, fingerprint confirmation, and prompt filter implemented |
| E10 | Hardening | SQLite persistence, token quota, prompt filter, fingerprint gate implemented; optional hardening remains |

---

## 4. User Stories

### E1. Public Discovery

#### US-1.1 — Browse rigs without registering

As a **Visitor**, I want to browse a public list of available and observed nodes, so that I can understand what kinds of local LLM environments are active.

Acceptance criteria:

- Given I open the public UI, when the tracker is running, then I see a list of nodes.
- Each node shows at least:
  - model name
  - quantization
  - GPU / accelerator
  - VRAM when known
  - context length when known
  - tuning note
  - health status
  - availability note
- I do not need a token to view the list.
- The tracker does not expose prompt or response history.

Current evidence:

- `GET /`
- `GET /api/nodes`
- `public/index.html`
- `src/tracker/server.js`

#### US-1.2 — Default list is not a GPU leaderboard

As a **Visitor**, I want the default list to surface rare and interesting rigs, so that the platform feels like an infrastructure map rather than a highest-GPU ranking.

Acceptance criteria:

- Default sorting is rarity-oriented.
- Low-spec or unusual nodes can appear prominently.
- The sort order is documented.
- The UI must not call this a leaderboard.

Current evidence:

- `sort: rarity_score_desc_then_vram_asc`
- `SPEC.md` §6.3

#### US-1.3 — Filter by health status

As a **Visitor**, I want to filter nodes by health status, so that I can distinguish available nodes from offline experiments.

Acceptance criteria:

- Filter supports at least `all`, `available`, `unavailable`, `unknown`.
- Health status is based on tracker probe results, not node self-assertion alone.

Current evidence:

- `GET /api/nodes?status=...`
- public UI status filter

---

### E2. Node Registration

#### US-2.1 — Generate node keys

As a **Node Provider**, I want to generate a node key pair, so that users can encrypt prompts for my node proxy.

Acceptance criteria:

- CLI can generate an X25519 key pair.
- Public key can be shared with tracker.
- Private key remains local to node provider.
- Generated private key file should be written with restrictive permissions when file output is used.

Current evidence:

- `luckrig keygen --out-prefix node`
- `src/shared/keyhandshake.js`
- `src/cli/luckrig.js`

#### US-2.2 — Register a node

As a **Node Provider**, I want to register my node metadata and endpoint, so that it appears in the public list.

Acceptance criteria:

- CLI accepts endpoint URL, health URL, model name, quantization, GPU, VRAM, context length, tuning note, tags, and node public key.
- Registration stores a stable node record.
- Public node response includes public key fingerprint when a node key exists.
- Registration can be dry-run for inspection.

Current evidence:

- `luckrig register ...`
- `POST /api/nodes` with `LUCKRIG_DEV=1`
- `node_public_key`
- `node_public_key_fingerprint`

#### US-2.3 — Start proxy in front of local inference server

As a **Node Provider**, I want to run a proxy in front of llama.cpp/ollama, so that luckrig can handle tokens, subtext, and buffering without modifying my inference server.

Acceptance criteria:

- Proxy exposes `/health`.
- Proxy exposes `/v1/chat/completions`.
- Proxy accepts a node private key.
- Proxy can forward to an OpenAI-compatible upstream.
- If no upstream is configured, POC mock mode works for testing.

Current evidence:

- `src/proxy/server.js`
- `LUCKRIG_UPSTREAM_URL`
- `LUCKRIG_NODE_PRIVATE_KEY`

---

### E3. Health and Telemetry

#### US-3.1 — Track node liveness

As a **Tracker Operator**, I want the tracker to probe node health endpoints, so that unavailable nodes can be marked without punishing providers.

Acceptance criteria:

- Tracker probes `health_url` periodically.
- Available/unavailable state is updated.
- Node going offline does not delete the node or apply a penalty.
- Probe timeout is configurable.

Current evidence:

- `LUCKRIG_HEALTH_INTERVAL_MS`
- `LUCKRIG_HEALTH_TIMEOUT_MS`
- `probeNode()` in `src/tracker/server.js`

#### US-3.2 — Store telemetry history

As a **Tracker Operator**, I want health and telemetry samples stored separately from node registry, so that observation history survives registry edits and can later move to a database.

Acceptance criteria:

- Samples are append-only JSONL.
- Runtime JSONL is gitignored.
- Telemetry may include memory, GPU, engine, queue, error rate.
- Metrics summary API aggregates samples.

Current evidence:

- `data/metrics.jsonl`
- `.gitignore` includes `data/*.jsonl`
- `GET /api/metrics`
- `docs/metrics-schema.md`

#### US-3.3 — Avoid fake benchmark authority

As a **Reproducer**, I want performance numbers to come from replay evidence, so that node self-reporting cannot define tok/s.

Acceptance criteria:

- Tracker health telemetry does not treat node-reported tok/s as authoritative.
- Replay schema includes `tok_per_sec` and `ttft_ms` fields.
- Documentation states current token estimation is approximate.

Current evidence:

- `SPEC.md` §9
- `src/client/replay.js`

---

### E4. Contribution-aware Access

#### US-4.1 — View contribution tier

As a **Taster**, I want to know whether I am limited or contributor-tier, so that I understand what access to expect.

Acceptance criteria:

- Tracker can return contribution status for a user/score.
- Score threshold is configurable.
- Current POC distinguishes `limited` and `contributor`.

Current evidence:

- `GET /api/contribution/:user_id?score=...`
- `LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD`

#### US-4.2 — Request tasting token

As a **Taster**, I want to request a tasting token for a specific node, so that I can try that node through its proxy.

Acceptance criteria:

- Token is bound to node ID.
- Token has expiry.
- Token has user ID and tier.
- Token includes public-key mode metadata when user/node public keys are provided.
- Invalid node ID is rejected.

Current evidence:

- `POST /api/tokens`
- `src/shared/token.js`
- E2E token tests

#### US-4.3 — Preserve non-transferable status model

As a **Maintainer**, I want access to be based on contribution status rather than transferable credits, so that the system does not become a token marketplace.

Acceptance criteria:

- POC has no transferable balance or credit ledger.
- Docs distinguish contribution status from Showcase scoring.
- Future scoring must not silently introduce tradable credits.

Current evidence:

- `CONCEPT.md` §スコアモデル
- `SPEC.md` §8

---

### E5. Privacy-aware Tasting

#### US-5.1 — Encrypt prompt for selected node

As a **Taster**, I want my prompt encrypted for the selected node, so that ordinary network capture and naive logs do not expose plaintext.

Acceptance criteria:

- Client can encrypt prompt using node public key.
- Encrypted prompt is embedded into text using subtext.
- Proxy decrypts using node private key.
- Plaintext prompt is forwarded only after proxy decryption.

Current evidence:

- `encryptJsonToSubtextForPublicKey()`
- `decryptJsonFromSubtextWithPrivateKey()`
- E2E public-key test

#### US-5.2 — Encrypt response for user

As a **Taster**, I want the response encrypted for my key, so that the returned pseudo SSE payload does not expose plaintext to ordinary intermediaries.

Acceptance criteria:

- Token carries user public key in public-key mode.
- Proxy encrypts response for user public key.
- Client decrypts response with user private key.
- Replay is built after local decryption.

Current evidence:

- `processChatCompletion()` public-key path
- `replayFromProxyResult(... userPrivateKey ...)`

#### US-5.3 — Understand trust limits

As a **Taster**, I want the UI/docs to clearly state privacy limits, so that I do not mistake luckrig for malicious-node-proof E2E encryption.

Acceptance criteria:

- Docs state node operator can inspect process internals.
- Docs state tracker + node can collude via key substitution.
- Public key fingerprints are exposed.
- UI now requires fingerprint confirmation before browser tasting; alternate trust channels remain future hardening.

Current evidence:

- `CONCEPT.md` trust model
- `SPEC.md` §7
- `docs/poc.md`

---

### E6. Queue UX and Pseudo SSE

#### US-6.1 — Buffer generation before pseudo streaming

As a **Taster**, I want the product to frame waiting as queue time, so that I do not interpret subtext buffering as a slow model.

Acceptance criteria:

- Proxy buffers upstream response before sending encrypted result.
- Response envelope contains queue/generation timings.
- Pseudo SSE sends encrypted content after buffering.
- UI should eventually show queue state before playback.

Current evidence:

- `processChatCompletion()`
- `buildPseudoSseChunks()`
- Browser tasting panel requests a token, encrypts prompt, calls proxy, decrypts pseudo SSE, and offers replay JSON download
- Browser POC uses public-key mode when node public key exists, with legacy session-secret fallback for keyless nodes

#### US-6.2 — Preserve OpenAI-compatible shape

As a **Client Integrator**, I want the proxy endpoint to resemble OpenAI Chat Completions, so that integration remains familiar.

Acceptance criteria:

- Endpoint path supports `/v1/chat/completions`.
- Request accepts `model`, `stream`, and `messages`.
- Streaming path emits SSE `data:` chunks and `[DONE]`.

Current evidence:

- `src/proxy/server.js`
- E2E pseudo SSE assertion

---

### E7. Local Replay

#### US-7.1 — Save replay locally

As a **Taster**, I want the result saved locally, so that I can inspect it after waiting or leaving the screen.

Acceptance criteria:

- Replay record includes `schema_version`.
- Replay record includes prompt, response, node ID, queue wait, generation time, tok/s, TTFT, chunk timestamps.
- Replay is written under a local history directory.
- Tracker does not receive replay content by default.

Current evidence:

- `src/client/replay.js`
- E2E save/load test

#### US-7.2 — Replay generation timing

As a **Reproducer**, I want replay timing to approximate the original generation experience, so that I can compare rigs later.

Acceptance criteria:

- Chunk timestamps are captured.
- Replay schema can drive playback.
- POC documents approximate token estimation.
- Current tok/s is approximate; tokenizer-aware counting is optional future improvement.

Current evidence:

- `parsePseudoSseChunks()`
- `buildReplayRecord()`
- `SPEC.md` §9

---

### E8. Showcase and Diversity

#### US-8.1 — Highlight low-spec and rare rigs

As a **Visitor**, I want unusual nodes like Raspberry Pi, old GPUs, and Apple Silicon to be visible, so that luckrig shows diversity rather than only expensive hardware.

Acceptance criteria:

- Node tags can include `showcase`.
- Rarity score gives Showcase/low-spec visibility.
- Default sort can place Showcase nodes near top.

Current evidence:

- `data/nodes.seed.json`
- `computeRarityScores()`

#### US-8.2 — Preserve tuning notes as live knowledge

As a **Reproducer**, I want tuning notes attached to nodes, so that I can learn from configurations that are currently running.

Acceptance criteria:

- Node records include `tuning_note`.
- Public list displays tuning note.
- Future note score should reward useful notes without becoming a leaderboard.

Current evidence:

- `data/nodes.seed.json`
- public UI cards

---

### E9. Safety, Filtering, and Disclaimers

#### US-9.1 — Present experimental disclaimer

As a **Maintainer**, I want users to see that luckrig has no quality, availability, or security guarantee, so that expectations match the project.

Acceptance criteria:

- Docs state no SLA and no warranty.
- UI should state experimental status.
- Token/tasting flow requires users to understand trust limits before browser tasting.

Current evidence:

- `CONCEPT.md` §免責の設計
- README / SPEC docs
- Public UI trust notice
- Browser tasting checkbox gate

#### US-9.2 — Keep NSFW and heavy creative use out of scope

As a **Maintainer**, I want luckrig positioned as a technical exploration space, so that node providers are not pulled into unwanted content categories.

Acceptance criteria:

- Product stance says NSFW is not allowed.
- Prompt filter is implemented in proxy and can be tuned as examples appear.
- Implementation details can evolve after real examples appear.

Current evidence:

- `CONCEPT.md` §フィルタリング方針
- Basic prompt filter implemented in proxy; rules will need operational tuning

---

### E10. Hardening

#### US-10.1 — Verify public key fingerprints

As a **Taster**, I want to compare the node public key fingerprint against an alternate channel, so that tracker/node key substitution is harder.

Acceptance criteria:

- Node public key fingerprint is exposed.
- UI displays fingerprint before token use.
- Node owner can publish fingerprint elsewhere.
- User can confirm/deny key before sending prompt.

Current evidence:

- Fingerprint generation implemented
- Public node cards display/copy fingerprint when present
- Trust notice tells users to verify out-of-band before tasting
- Browser tasting requires trust checkbox and exact fingerprint confirmation when a node key exists

#### US-10.2 — Persist data durably

As a **Tracker Operator**, I want durable storage for registry, metrics, token state, and contribution state, so that restart and growth do not depend on seed JSON files.

Acceptance criteria:

- Registry is stored in DB.
- Metrics summaries are queryable without replaying unbounded JSONL.
- Token/session metadata is auditable without storing prompt/response.
- Migration path exists.

Current evidence:

- JSON/JSONL POC only
- SQLite persistence implemented for nodes, metrics, token usage, and contribution-state table; migration tooling remains future hardening

#### US-10.3 — Enforce real quota

As a **Contributor**, I want limited users constrained fairly, so that contribution status remains meaningful.

Acceptance criteria:

- Limited tier has explicit quota/output limit.
- Contributor tier has broader access.
- Quota enforcement cannot be bypassed by repeated token requests.

Current evidence:

- Tier label implemented
- Proxy truncates limited-tier output using `LUCKRIG_LIMITED_OUTPUT_CHARS`
- Durable daily token quota is enforced for limited users; quota admin UI remains future hardening

---

## 5. Critical User Journeys

### Journey A — Visitor decides whether luckrig is worth trying

1. Open public UI.
2. See node list sorted by rarity/Showcase rather than GPU leaderboard.
3. Inspect a node's model, quantization, GPU, context length, health, and tuning note.
4. Read no-SLA / trust caveat.
5. Decide to register or contribute.

Success indicators:

- Visitor understands available rigs.
- Visitor does not think luckrig guarantees uptime/privacy.
- Visitor sees value in rare configurations.

### Journey B — Contributor brings a node online

1. Generate node key pair.
2. Start local llama.cpp/ollama.
3. Start luckrig proxy with node private key and upstream URL.
4. Register node metadata and node public key.
5. Tracker probes `/health`.
6. Node appears in public list with fingerprint and health status.

Success indicators:

- Node provider does not modify inference server.
- Node can go offline without penalty.
- Public list shows node's tuning context.

### Journey C — Taster tries a node and saves replay

1. Generate user key pair.
2. Select node.
3. Request token with user public key.
4. Confirm node fingerprint/trust caveat.
5. Encrypt prompt for node public key.
6. Send request to node proxy with Bearer token.
7. Wait through queue/buffer phase.
8. Receive pseudo SSE encrypted response.
9. Decrypt with user private key.
10. Save replay locally.

Success indicators:

- Prompt and response are not visible in ordinary transport/log text.
- Replay record exists locally.
- User understands node-process inspection remains possible.

### Journey D — Reproducer evaluates a hardware decision

1. Filter/select a node close to target hardware.
2. Read tuning note.
3. Try representative prompt.
4. Inspect replay timings and response.
5. Compare against other nodes or local rig.
6. Decide whether to reproduce config or buy hardware.

Success indicators:

- Replay data helps practical decision-making.
- tok/s is understood as replay-derived, not node self-report.

---

## 6. Story Map by Implementation Priority

### Already implemented in POC

- US-1.1 Browse rigs
- US-1.2 Rarity-oriented default list
- US-1.3 Filter by health status
- US-2.1 Generate node keys
- US-2.2 Register node via POC/dev path
- US-2.3 Start proxy
- US-3.1 Track liveness
- US-3.2 Store telemetry history
- US-4.1 View contribution tier
- US-4.2 Request tasting token
- US-5.1 Encrypt prompt for selected node
- US-5.2 Encrypt response for user
- US-6.1 Buffer before pseudo streaming
- US-6.2 Preserve OpenAI-compatible shape
- US-7.1 Save replay locally
- US-7.2 Replay generation timing schema
- Proxy queue depth/active visibility
- Environment filter and visible rigs comparison table
- Heuristic tokenizer-based replay tok/s estimate
- US-8.1 Initial Showcase visibility
- US-8.2 Tuning notes in node list
- US-10.1 Public key fingerprint display/copy in UI
- Browser tasting flow for Journey C using public-key mode when node key exists
- US-9.1 Trust/disclaimer checkbox gate in browser tasting panel
- US-10.3 Basic limited-tier output truncation in proxy
- US-9.2 Basic prompt filtering in proxy
- US-10.2 SQLite persistence for registry/metrics/token usage
- Durable daily token quota for limited users
- Browser public-key tasting when node key exists
- Multi-axis node contribution score
- Auto-generated Showcase categories
- Persistent browser identity for repeated tastings
- Out-of-band fingerprint URL verification
- IP-level token rate limiting

### Next recommended hardening stories

1. **SQLite migration/admin tooling**
2. **Quota management UI**
3. **Full tokenizer integration for replay benchmarks**
4. **Real llama.cpp / ollama integration test profile**
5. **Additional alternate-channel fingerprint publication guide**

---

## 7. Definition of Done for Story Implementation

A user story is done only when:

- Code path exists or docs explicitly mark it pending.
- Acceptance criteria are covered by tests or manual verification notes.
- Trust/privacy caveats are not weakened.
- The story does not introduce node self-reported benchmark authority.
- Runtime prompt/response data is not uploaded to tracker by default.
- `npm test` passes when implementation changes code.

