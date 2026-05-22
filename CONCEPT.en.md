# luckrig — Product Concept (draft v5)

[日本語](./CONCEPT.md) | **English**

---

## In one sentence

"A place to try, right now, the LLM inference API running on someone else's on-prem rig — access earned through contribution."

---

## Product name

**luckrig**

luck (drawing a lucky pick) + rig (your own environment / gear). It reads both ways: "you draw a lucky rig" and "your rig becomes someone's luck." It is consistent with the no-SLA stance — if you're lucky you land on a fast node, if you're lucky it's up right now. Like Craigslist, it aims to be chosen for usefulness rather than slickness.

---

## Category definition

**An on-premises LLM inference API sharing platform**

- On-premises: not the cloud — running on an individual's machine
- LLM inference API: specialized in text generation, spoken as an OpenAI-compatible API
- Sharing: contribution-based mutual aid
- Platform: a tracker binds the community together

This combination is new — AI Horde and Petals are prior art, but luckrig differentiates from both (see §Competitive definition).

If LMSys Arena is a map of model evaluation, luckrig is a real-time map of infrastructure evaluation. Not which model is better, but how a specific configuration / environment / tuning is running at this very moment — made observable.

---

## Scope definition

v1 is limited to text generation (OpenAI-compatible API).

OpenAI-compatible request/response is the baseline, and the node-side proxy layer carries only minimal responsibilities (token verification, tier control, the no-plaintext-logging convention). The subtext scheme (described below) is offered as an optional layer on top of the baseline, never mandatory.

ComfyUI (image generation), RVC (voice synthesis), Whisper (speech recognition), etc. are out of scope — before any subtext consistency question, they need a separate design for the tasting UX as a whole (queue / replay / contribution score).

We recognize the reach is broad, but we finish the design on one protocol first.

---

## Problem statement

To benefit from AI, you either pay a big platform or provision a high-end GPU yourself. Things have collapsed into this binary.

But in the local-LLM world there is an RTX 3080 idling overnight, there are individually tuned configurations, and there is know-how nobody else has, asleep in someone's hands.

No existing service satisfies "right now, free, **naming a specific configuration / environment / tuning**, with your own prompt."

- HuggingFace Spaces: only paid GPUs or sleeping CPUs. No reference for your own environment
- CivitAI: an exhibition of weight files. You can't touch them
- LMSys Arena: you can choose neither the model nor the environment
- Vast.ai / SaladCloud: commercial models premised on money
- AI Horde (formerly Stable Horde / KoboldAI Horde): a direct predecessor that shares text/image generation APIs through contribution (kudos). But it is **designed to abstract away which worker you land on**, hiding the hardware and configuration. luckrig does the opposite — it **makes the hardware the star** (environment metadata, tuning notes, naming a specific rig).
- Petals: a mutual-aid project for distributed inference of large models across nodes. luckrig is one-node-one-inference, so distributed inference is out of scope.

This differentiation holds because luckrig treats "reproducible configuration information" as first-class data. Enjoying "landing on a lucky rig" while the configuration of the rig you landed on remains in your hands as reproducible information — that is the core of the product.

---

## Target definition

**Engineers who can stand up a local LLM on their own.**

General consumers are not the target. This is not an exclusionary decision but a positive design decision.

Narrowing the target solves several things at once.

Privacy asymmetry — a node operator is, in principle, positioned to see other people's prompts and outputs. If the audience is highly technical engineers, only people capable of self-assessing the risk flow in. The grounds for the disclaimer get one notch stronger.

Erasing the motive for false listings — claims that exceed the laws of physics are seen through immediately by the community. The community's gaze doubles as a verification function.

Community density — the overlap between node operators and users gets higher, so the contribution-based cycle turns more easily. Hotline worked because participants were highly technical; we intentionally reproduce that structural similarity.

Design consistency — "port Hotline Connect's philosophy," "attract hacker-minded early adopters," and "contribution-based access rights" line up in a straight line.

---

## The concept's prototype

In the early 2000s there was software called Hotline Connect. A P2P community tool for the Mac that combined file sharing, chat, and message boards in one. Servers were addressed by IP and port number alone, and once you made a certain contribution you were granted a full-access account. Early adopters who had pulled ADSL naturally became server operators, and the platform stayed fresh because they offered new files. A bot monitored each individual's transfer ratio and kicked download-heavy users.

It was a structure where contribution, not money, became access rights, and the community ran itself autonomously.

luckrig is an attempt to port Hotline's design philosophy to mutual aid for on-premises LLM inference APIs.

---

## Design skeleton

### Tracker

A lightweight tracker sits in the center. It has three roles — accepting node endpoint registration, periodic liveness monitoring, and issuing short-lived tokens according to contribution score.

The tracker holds no content. It holds no infrastructure. It manages only the list and the permissions.

### Node

An individual with an on-prem environment registers their machine as a node. Because llama.cpp and ollama already speak an OpenAI-compatible API, no extra implementation is needed in principle. Registration is just sending the endpoint URL.

A node going down carries no penalty. The tracker simply drops it from the available list automatically.

### Three tiers of access

Anonymous users get list browsing only. They can see what environments are running which models. Window shopping that builds interest.

Registered-but-non-contributing users get limited access. Lousy models, harsh quota, or only the head of the output. By design, this creates the "I want to use it a bit more" frustration.

Contributing users can, in principle, access all models.

---

## Design of node registration info

```
Model name   : Qwen3-35B-A3B
Quantization : Q4_K_XL
LoRA         : none / yes (type)
GPU          : RTX 5090 / 32GB VRAM
Context      : 65536
tok/s        : 267 (computed from client-side replay data)
Uptime       : weekday nights to morning
Tuning note  : (free text)
```

Example tuning note:

```
MTP n_max=2 is fastest. 3+ backfires (accept rate collapses).
For long-context RAG, SPEC=none recommended (prefill 3.4x faster).
n-gram is for code editing only; backfires for creative writing / summarization.
ctx=131072 is the limit that fits in 32GB VRAM.
```

These notes accumulate in the community. Not someone's blog post, but living know-how tied to a node that is running right now.

---

## Design of the contribution score

### Basic principle

If "number of times used" were the only value, only popular models would survive and the list would converge. Because preserving diversity is the community's value, we design the score along multiple axes.

### Score composition

Existence score — duration of continuous list registration (a base point, kept small).

Rarity score — the fewer the matching GPU × model × quantization combination, the higher. The motivation to dive into a blue ocean is woven into the design. A Raspberry Pi node maxes out the rarity score.

Usage score — actual API call count.

Discovery score — the number of users who "tried for the first time" on that node. Pioneers who opened up a new combination are rewarded.

Note score — tuning-note reference count × node-selection rate after the reference.

### Resistance to gamification

Post-hoc evaluation is the basis. A node that "stays connected but nobody uses" doesn't grow its score. Being "used" and "referenced" is the substance of evaluation.

### Score model

We adopt a status model (once you exceed a certain score, you permanently gain full-access rights). As long as we keep the design where contribution score does not become a tradable asset, there is no point in faking your way to a higher score.

The rights system (permanent rights) and the game system (rarity score / Showcase ranking) are designed separately. Permanent rights function as a Hotline-style "promise to contributors," while motivation for newcomers is sustained on a separate layer of rarity score and discovery score.

---

## Forms and gradations of contribution

- Providing a node (GPU + endpoint) → maximum contribution
- Posting a tuning note → moderate
- Publishing generation results → light contribution
- Sharing prompts / workflows → light contribution
- Just using it (generation results auto-published) → minimum contribution

---

## A design where tasting leads directly to a purchase — value in two directions

### Direction 1: Confirm a configuration reproducible at home

"I tried RTX 3080, Q4_K_M and it was good" becomes information directly reproducible for a user with the same configuration. Enter your own environment spec and you can filter for nearby nodes.

Taste → read the tuning note → gain confidence you can reproduce it yourself → take the plunge and install.

### Direction 2: Make an investment decision about a machine you can't buy

Being able to try, with your own prompt, how much tok/s an RTX 5090 actually delivers is worth more than reading 100 magazine reviews or other people's blogs. You can decide "whether to buy with the next bonus" by tasting.

This is also a benefit of providing for high-end GPU operators: the satisfaction of your rig contributing to someone else's purchase decision.

---

## As a real-time map of infrastructure evaluation

In the course of the tracker's liveness monitoring, memory usage and error rate accumulate automatically.

For aggregating tok/s and TTFT, we provide a path where **the user explicitly opts in to upload** the timing metadata on the replay side (no prompt/response body, only the timing numbers). The coexistence of privacy (local-first) and the headline (a real-time map of infrastructure evaluation) is achieved through this opt-in.

**How measurement trustworthiness is positioned**

The real distinction in the source is not plain/subtext but **streamed vs buffered**.

- **streamed**: plain mode + `stream:true`, with output moderation in `record` mode (default) or `off`. The proxy passes upstream SSE chunks straight through. The client's chunk_timestamps and TTFT correspond to the real generation speed.
- **buffered**: any of the following.
  - subtext mode (whether plain or public-key, subtext hides the completed payload as one block)
  - non-streaming calls (`stream:false`)
  - plain mode + output moderation `block` mode (must fully buffer before sending to wait for the classifier)
  - in all these cases, the client-side chunk_timestamps are "the rate the proxy replayed," not the real generation speed. tok/s is treated with the node-proxy-measured value (inside the response envelope) as the primary source.

The replay record and the `luckrig.timing` frame carry `streamed: true|false` and `proxy_ttft_is_true_first_byte: true|false`. The user can distinguish, every time, whether the numbers they see are "true measurement" or "replay rate."

In all modes, we maintain the principle that tok/s is treated as a **measured value tied to the measurement path**, not "a self-reported value the node wrote into its listing."

Examples of know-how auto-generated from operating data:
- On an RTX 4070Ti, Q4_K_M is the practical limit
- This LoRA works better at Q8_0
- The M3 Max has unified VRAM, so this model is surprisingly fast
- On a Raspberry Pi 5, llama3.2-1B / Q4_K_M runs at 2.3 tok/s

### Treating low-spec listings as a Showcase

Showcase categories auto-generated on the tracker side:
- Nodes running on the lowest spec
- The oldest GPU node
- The node running on the lowest power

Visualizing diversity rather than ranking. Not a Leaderboard — a Showcase.

In the new-user tasting UI, the default is ordered by rarity score, not by top spec. The philosophy is expressed in the UI.

## Replay feature — persistence to your own hands

Because of the queue design, a user may step away during the wait. There are cases where they can't watch the pseudo-SSE response stream in real time. The replay feature solves this.

At the buffering stage, the following information is already gathered in hand. The extra measurement cost is zero.

```json
{
  "schema_version": 1,
  "prompt": "the actual prompt (plaintext)",
  "response": "the actual response (decrypted plaintext)",
  "node_id": "xxx",
  "queue_wait_sec": 12,
  "generation_sec": 8.3,
  "tok_per_sec": 267,
  "ttft_ms": 842,
  "chunk_timestamps": [...]
}
```

The primary source of `tok_per_sec` and `ttft_ms` differs by mode (see §As a real-time map of infrastructure evaluation). In plain mode the client-side chunk_timestamps correspond to the real generation speed; in subtext mode the node-proxy-measured value (inside the response envelope) is the primary source. In neither case is the node's own "self-reported value posted to its listing" the primary source.

The replay body (including the prompt/response body) is persisted locally. It is not sent to the server.

**Opt-in timing-metadata sharing**

To make the "real-time map of infrastructure evaluation" real, the user can opt in per tasting to upload **only the timing metadata** to the tracker (`tok_per_sec` / `ttft_ms` / `generation_sec` / `queue_wait_sec` / `output_tokens` / `tokenizer` / `created_at` / `mode`). **The prompt and response body are never sent.** The upload happens only when the user clicks an explicit button in the tasting UI, and the default is off.

Without this opt-in, the headline "real-time map of infrastructure evaluation" cannot display the number people most want (tok/s). It is positioned as a path by which the user, keeping local-first-by-default, can contribute to the collective knowledge of their own will.

```
~/.luckrig/history/
  2026-05-22_143022_{node_id}.json
```

Carrying `schema_version` leaves room to add auto-deletion, size caps, a simplified mode, and so on later.

On replay, chunk_timestamps are used to reproduce the generation speed at the time. The user can re-experience "queue wait 12s, generation 267 tok/s, TTFT 842ms" exactly as it was.

**Replay TTFT is more accurate than the real-time experience**

The TTFT felt over real-time SSE has network latency from the user's device to the node mixed in. Because location, ISP, and route to the node introduce 100ms–500ms of jitter, it is not pure as an infrastructure evaluation.

The TTFT recorded in replay, on the other hand, is the value at which the node-side proxy recorded the arrival of the first SSE chunk — a number close to the inference engine's performance alone. Having excluded network variables, you can more accurately evaluate "TTFT for this GPU, this model, this tuning."

A streamed plain-mode TTFT retains in replay both `proxy_ttft_ms` (the node proxy recording upstream first-byte arrival) and `network_ttft_ms` (the client device recording the `fetch` first-chunk arrival). The former is a pure infrastructure-evaluation value with network variables excluded; the latter is the user-felt value.

When buffered (subtext, non-stream, output moderation block), `proxy_ttft_ms` is the upstream round-trip time, not a true first-byte. The replay record makes this explicit with `proxy_ttft_is_true_first_byte: false`.

Replay is not a product of compromise; it is a design faithful to the concept that luckrig is "a real-time map of infrastructure evaluation." As a side benefit, replay data can also be used for time-series node evaluation.

---

## Risk handling

### Privacy design — "invisible unless you try hard"

Since the node operator is running inference, they are in principle positioned to see the prompt and output. This cannot be completely hidden.

luckrig offers two modes. **plain mode (baseline)** speaks the OpenAI-compatible API as-is. Privacy protection relies only on TLS path concealment and the node proxy's convention of "not writing raw plaintext to logs." Vanilla OpenAI clients work without any extra implementation.

**subtext mode (optional layer)** adds, on top of the base case, defense-in-depth that "only cover text remains in the node's proxy logs." subtext is a scheme that embeds the AES-GCM-encrypted payload as Unicode variation selectors, so even if the node operator sloppily copy-pastes the proxy log, no plaintext leaks. In exchange, because the response is fully buffered node-side and then hidden in one block, the SSE becomes pseudo SSE (described below).

This mechanism (subtext) is not the star of the value pitch. luckrig is not a security product, nor a place to entrust secrets. subtext is purely a "decorative courtesy," and its internals are disclosed honestly in the docs.

The user-facing explanation puts operational caution ahead of the mode differences — what you send is processed so it can't be easily read in ordinary logs or tcpdump, but a motivated node operator who steps into the process internals can in principle see it. Therefore do not send confidential information, personal data, or anything you must protect for work. This tone is kept consistent across UI and docs.

**Communication flow design (subtext mode)**

```
At application time:
  user ID + public key → tracker → stored in the node's proxy layer

When sending a prompt:
  the user AES-GCM-encrypts the prompt with the node's public key
  → hides it in cover text (a fixed string) via subtext and sends

When receiving a response:
  the node's proxy layer encrypts the response with the user's public key
  → hides it in cover text via subtext and returns
  the user decrypts with their private key
```

**How subtext works**

A scheme that embeds an encrypted payload invisibly into text using Unicode variation selectors. The cover text is a hardcoded fixed string, so generation cost is zero. Security is guaranteed on the AES-GCM side; the content of the cover text is irrelevant to security. Only the cover text flows over the wire, and no plaintext remains in the node's logs.

**The reach and limits of concealment**

We define the reach of "invisible unless you try hard" precisely.

A third party observing outside TLS (an on-path third party, tcpdump) sees only the cover text. No plaintext remains in the logs either.

But a node operator who steps inside the process — memory dump, llama.cpp input hook, process debugging — cannot be stopped. Because the inference engine needs the plaintext prompt, plaintext necessarily exists inside the process.

"Invisible unless you try hard" means "invisible to tcpdump but visible if you step into the process," and this limit is made an explicit design premise by combining it with an engineer-facing disclaimer.

**Key-distribution trust model**

When the user selects a node on the tracker and applies to use it, they send their user ID and public key to the tracker. The tracker forwards it to that node's proxy layer, where it is stored automatically.

We make the trust model explicit — the tracker alone cannot read plaintext. The node alone cannot decrypt either, because it lacks the user's private key. But if the tracker + node collude to swap the public key, the structure becomes one where plaintext can be read.

The answer to "must you trust the tracker operator (luckrig)?" is Yes. But conditionally: luckrig alone cannot read it, and collusion with a node operator is required. Making this explicit to the user prompts an appropriate risk assessment.

As an optional feature, we allow a pattern where the node owner publishes the public-key fingerprint via a separate channel (GitHub, etc.). We leave room for self-verification for engineers.

The public-key store is session-scoped. Because it is discarded at the same time the token expires, no user information accumulates on the node side. "It's not retained even if you try."

**Node-side implementation — the luckrig proxy layer**

With a one-line node registration command, the proxy layer is automatically inserted in front of ollama/llama.cpp.

```
user → [luckrig proxy layer] → ollama/llama.cpp
               ↑
  subtext decrypt / encrypt & subtext injection
  does not spit plaintext into logs
```

Structurally identical to VibeProxy. Instead of hiding API keys, it functions as a layer that hides the content of prompts and responses.

**Coexistence with SSE**

In plain mode, the node proxy forwards the upstream SSE chunks as-is. The user receives true SSE, and both tok/s and TTFT can be measured on the device. OpenAI-compatible clients work with no extra implementation.

In subtext mode, sequential reception via SSE and subtext concealment are inherently a poor fit. Because subtext is a mechanism that hides the entire completed payload as one block, it cannot hide the per-token SSE chunks as they stream. We solve this at the UX level.

```
user selects a node
  ↓
queue-wait display (during which the proxy layer buffers SSE chunks)
  ↓
generation complete → AES-GCM-encrypt in one block → embed via subtext
  ↓
"connected" → send to user via pseudo SSE
```

The same UX pattern as GeForce Now making you wait for a free game console. Because the user perceives themselves as queued for the node's usage rights, they don't interpret the wait as "slow generation." The experience becomes one where the response streams the moment you clear the queue. The queue UX itself also applies in plain mode (requests exceeding the node's `max_active` wait either way).

Displaying the number of people in the queue also produces a sense of platform liveliness.

**On the asymmetry between eavesdropping and tampering**

Introducing subtext raised the cost of eavesdropping — you can't see the prompt without stepping into the process. But the difficulty of tampering (swapping the output) is unchanged. It remains doable by modifying the proxy layer. We make explicit, as a design premise, that the asymmetry "eavesdropping got harder but tampering is the same difficulty" remains.

### Filtering policy

luckrig is a playground for technical exploration, not a playground for creative writing.

NSFW content does not pass. Detection at the prompt stage is the basis. For gray-zone creative work too (violent depiction, psychologically heavy creative writing, simulating derivative-work characters), we state from the start: "luckrig is not the place for that; if you want to do it, do it in your own local environment."

A declaration on a different axis from the disclaimer. It determines the character of the community.

**Three-stage moderation (built in v1)**

luckrig has an obligation to protect both node operators and the operator from the process of handling illegal content. The concrete criteria will be refined with real examples, but the mechanism itself is enabled from v1.

1. **Local regex filter (`src/shared/filter.js`)**: a first stage that reacts instantly to naive NSFW keywords or heavy-creative keywords. Low cost, low precision. Runs on every request in the proxy.
2. **External moderation hook (`LUCKRIG_MODERATION_ENDPOINT`)**: posts to an OpenAI-Moderation-API-compatible endpoint (OpenAI itself, a local Llama-Guard, Anthropic Moderation, etc.) for a flag decision.
   - **Input moderation**: always blocks before sending. If flagged, rejects with 451 and nothing reaches upstream. If the endpoint is unreachable, fail-closed (to prevent a bypass that exploits a connectivity failure).
   - **Output moderation**: behavior selectable via `LUCKRIG_MODERATE_OUTPUT`.
     - `record` (default): prioritizes streaming. Passes upstream SSE through to the user in true pass-through and runs the classifier after completion. If flagged, it is recorded to the response envelope and `data/moderation-flags.jsonl`, becoming the trigger for the operator's manual ban. Explicitly takes the tradeoff "the first time slips through, but the second time is stopped by a ban."
     - `block`: blocks before sending. Fully buffers upstream and returns only after the classifier passes. Even in plain mode, true SSE does not appear. Needed for an operation where, by legal requirement, "the user must never see illegal output."
     - `off`: skips output moderation.
   - The proxy's response envelope records `moderation.input.{checked,flagged,categories}` / `moderation.output.{checked,flagged,categories,mode}`.
3. **Notice-and-Takedown (the ban mechanism on the tracker side)**: users can report via `POST /api/abuse/report`. Reports accumulate in `data/abuse-reports.jsonl` on the premise of human review, and **no automatic ban** occurs (to avoid auto-collateral from false reports). The tracker operator can immediately cut off a `user_id` / `ip` / `node_id` via `POST /api/bans` (`LUCKRIG_DEV=1`). A banned `node_id` is hidden from the public list and token issuance is refused.

luckrig does not claim "completely safe." It treats "properly operating, by design, the three stages of **naive detection + third-party moderator + Notice-and-Takedown**" as one of the grounds for its disclaimer.

### Design-level handling of false listings

We choose structural erasure of the motive, not a verification implementation.

Faking for score farming — adopting the status model (full-access rights are non-transferable) means there's no point in faking your way to a higher score.

Faking for attention — claims that exceed the laws of physics are seen through immediately by the community.

Malicious output swapping — on a disclaimer-premised, public-premised platform, the prompts flowing through have low value, not worth the collection cost. And because tok/s is measured client-side, performance faking is also exposed in the replay data.

By this judgment, we positively choose to implement neither canary prompts nor attestation. "We justify not verifying through design."

### Barriers to entry for node providers, and their resolution

Security anxiety — you can hide your real IP via an overlay network like Tailscale.

Loss of sovereignty — you can set a cap on GPU usage. On/off at will.

Operational-continuity pressure — no penalty. The tracker simply drops you from the list.

Onboarding cost — if ollama is installed, registration is one command.

Unclear motivation — your contribution score grows, your node appears on the tasting list. A rare configuration ranks high on rarity score. Your tuning gets used in someone else's purchase decision.

### Design of the disclaimer

The "tasting" concept becomes the grounds for the disclaimer.

For users: no quality guarantee, no availability guarantee, no security guarantee (use it having understood the trust model), business use at your own risk.

For node operators: no responsibility if it goes down, no responsibility for output quality, no uptime guarantee.

"We don't guarantee, but you can try it" is more honest than "we guarantee" in this context, and it attracts hacker-minded early adopters. Being experimental itself becomes the brand.

---

## Minimum implementation order

To stand up value for early node providers first, we build the public list before the tasting UI.

1. Build the public node-info list (for anonymous visitors, liveness monitoring included)
2. Implement automatic benchmark collection (auto-recording memory usage, error rate)
3. Build the node registration CLI (one command, auto-insertion of the luckrig proxy layer)
4. Implement the token issuance logic
5. Build the tasting UI (obtain token → queue UX → pseudo SSE)
6. Implement the replay feature (local persistence)
7. Implement contribution score and access management

An existing llama.cpp environment (Qwen3.6-35B-A3B, RTX 5090, port 8088) can become the very first node as-is.

But the first node alone could give the impression "you need a 5090 after all." Pulling in collaborators who deliberately bring a Raspberry Pi, an M3 Max, an RTX 2080, etc. in the early phase determines the platform's first impression.

---

## Homework for v6 and beyond

The concrete backlog is separated into [`BACKLOG.md`](./BACKLOG.md), and legal topics into [`LEGALISSUE.md`](./LEGALISSUE.md). The below is a CONCEPT-level note of policy.

Concrete threshold design and operational structure for filtering — the three-stage framework (regex + external moderation + ban) is implemented in v1. Threshold and category tuning will be refined once the community scales up.

Long-term tier ossification of the status model — the design policy of separating the rights system (permanent rights) from the game system (rarity score / Showcase ranking) is settled. The concrete re-evaluation cycle is v6+.

Scope expansion beyond text generation — to be considered once the subtext consistency design is established.

Motivation design for continuous contribution (a consumable loop) — whether to run, alongside the Hotline-style permanent-rights model, an AI-Horde-kudos-style closed economy of "buying priority as a consumable" is undecided. Keeping permanent rights as-is, whether to place priority queue-shortening as a consumable in addition to rarity score / Showcase will be considered in v6.

Pulling in the "read-only audience" — tuning notes and published timing metadata have value even for people who don't build a rig themselves. Whether to separate the UI/permissions of "people who touch (engineers)" from "people who only read (readers)" will be considered in v6.

The tracker operator's formal legal standing (jurisdiction / privacy policy / terms of service / DMCA agent, etc.) — in v1 we implemented the technical underpinnings up to the abuse contact, the reporting path, and the ban mechanism. Incorporation and formal terms are carried over to v6+ (§Filtering policy).

---

*Last updated: 2026-05-22 (v5.6 — split output moderation into `record` (default, streaming preserved, post-hoc recording) and `block` (block before sending, full buffer). Restored true SSE in plain mode. Reorganized the source distinction from plain/subtext to streamed/buffered. Made `streamed` / `proxy_ttft_is_true_first_byte` explicit in `luckrig.timing` and the response envelope. Added `data/moderation-flags.jsonl` as the operator-facing ban-review path.)*
