# Attention Lens — Methodology

Attention Lens estimates a **context attention budget**. It does not read the provider's attention weights. This document defines exactly what is computed, what is assumed, and where the estimate stops being trustworthy.

## 1. What cannot be measured

The DeepSeek API exposes tokens, usage, logprobs where available, tool calls, and session events. It does not expose:

- attention matrices or per-head weights,
- KV-cache state,
- per-layer activations,
- the exact assembled system prompt and tool schemas in every deployment.

Any product that claims to show the model's real attention from an API is guessing. Attention Lens instead makes its guess explicit, configurable, and falsifiable.

The behavioral phenomenon is real: long-context models tend to use the beginning and the end of a prompt more reliably than the middle, and the relative weight of an old fact falls as new material is appended. See the research references at the end.

## 2. Context reconstruction

The host projection (`attentionLens`) folds committed session events into ordered, model-visible segments:

| Source event | Segment kind | Notes |
|---|---|---|
| `system/message` | `system` | Rendered system prompt |
| `developer/message` | `developer` | Tool additions/removals and developer instructions |
| `user/message` with `source.kind === "user"` | `user` | Real user intent |
| `user/message` with another source kind | `context` | Runtime context, time snapshots, skill catalogs — model-visible but not user intent |
| `assistant/message` | `assistant` | Includes reasoning and text blocks |
| `tool/result` (read/grep/edit/…) | `file` | `tool` keeps the tool name |
| `tool/result` (web/browser) | `web` | |
| `tool/result` (subagent) | `subagent` | |
| `tool/result` (other) | `tool_result` | |
| `compaction/summary` | `summary` | When the event carries a message or summary text |

Surface replacements (`surfaceOp: { op: "replace", startSeq, endSeq }`) remove the replaced range and insert the replacement at the same surface position. The projection never appends a new event type.

Two synthetic segments complete the budget:

- **`tools`** — the tool schemas from the latest `request/header`, priced from their JSON size. It represents the beginning-of-context tool block.
- **`unobserved`** — `max(0, latestInputTokens − observedTokens)`. `latestInputTokens` is the newest provider-reported prompt size from `assistant/message.usage.inputTokens`. This bucket absorbs hidden system/tool content and keeps the budget honest.

Token counts use `ctx.tokenMeter.estimateMessage(message)` when the service is mounted. Otherwise the plugin uses a CJK-aware fallback (`CJK chars ≈ 1 token`, other text `≈ 1 token / 3.2 chars`). Segments are marked `approx: true` when the fallback is used.

## 3. The score

For each segment `i`:

```text
w_i = P(pos_i) · T(kind_i) · R(query, text_i) · S(text_i) · D(age_i) · A_i
share_i = w_i / Σ_j w_j
```

`share_i` is the estimated attention budget fraction. As new segments are appended, the denominator grows; unchanged old segments therefore lose share. That is the dilution effect the plugin visualizes.

### 3.1 Position prior `P`

```text
P(x) = 0.2 + 0.55·exp(−x / 0.18) + 0.45·exp(−(1 − x) / 0.12)
```

`x` is the segment's midpoint position in `[0, 1]`. The shape encodes primacy and recency; the middle is the cold zone. The constants are a research-informed prior, not a fitted DeepSeek curve.

### 3.2 Type weight `T`

Balanced preset:

| Kind | Weight | Kind | Weight |
|---|---:|---|---:|
| `system` | 1.60 | `tools` | 1.20 |
| `user` | 1.30 | `context` | 0.55 |
| `goal` | 1.40 | `todo` | 1.40 |
| `developer` | 1.20 | `assistant` | 0.90 |
| `file` | 0.80 | `web` | 0.50 |
| `subagent` | 0.70 | `tool_result` | 0.55 |
| `summary` | 0.90 | `attachment` | 0.70 |
| `unobserved` | 1.00 | `other` | 0.40 |

Presets: `balanced`, `recency` (higher assistant/tool weights, lower system), `instruction` (higher system/user/goal, lower tools). Presets can be changed in Settings.

### 3.3 Lexical relevance `R`

The host stores up to 12 keyword/bigram terms per segment. The client builds document frequency over the current segment set and computes a BM25-like IDF sum for the terms shared with the current query (the latest real user message, or the session title when no user message exists).

`R` is normalized to `[0.5, 1.5]` by dividing by the maximum raw score in the set. This is a lexical proxy, not an embedding. It prevents a recent but off-topic tool log from being treated as highly relevant.

### 3.4 Salience `S`

Multiplicative heuristics over the preview:

- error/`isError`: ×1.30
- code-like text: ×1.10
- explicit constraint words (`must`, `never`, `only`, `必须`, `不要`, `禁止`, …): ×1.20
- repeated preview: ×1.15
- filesystem path: ×1.05

These are intentionally small. They nudge the ranking; they do not define it.

### 3.5 Age `D`

```text
D = exp(−turns_since_segment / 20)
```

Age is separate from position: a recent segment near the middle still loses to the position valley, while an old segment near the very end keeps a recency boost.

### 3.6 Anchors `A`

A pinned segment gets ×1.80. Pins are stored in the browser (`localStorage`) and never mutate the session or prompt.

**Critical set and auto anchor:**

- If any segment is pinned, only pinned segments are critical.
- Otherwise, constraint-bearing segments of kind `user`, `system`, `developer`, `goal`, or `todo` are critical.
- If neither exists, the **first real user message** becomes an auto anchor. Injected context (`runtime-context`, `time-context`, `skill-catalog`) is deliberately excluded.

## 4. Metrics

- **Critical share** — sum of `share` over the critical set. This is the headline number.
- **Coverage 80** — fraction of tokens needed to cover 80% of the estimated attention. A low value means attention is concentrated.
- **Cold-zone share** — share held by segments whose midpoint is in `[0.30, 0.70]`.
- **Context used** — total estimated tokens ÷ provider context window (fallback 128k when unknown).
- **Attention density** — `share ÷ (tokens / 1000)`, shown per segment as `density /1k`. A 9-token anchor can have high density but low mass; a 10k-token log can have high mass but low density. Both matter.
- **Dilution risk** — `high` when an anchor falls below the threshold within 3 projected turns, critical share < 4%, or context usage > 85%; `medium` below 8% critical share, cold-zone share > 70%, or context usage > 65%; otherwise `low`.

The UI shows the components rather than hiding them in a single score.

## 5. Dilution forecast

`forecast` estimates `avgTurnTokens` from the last five turns (minimum 400; default 2000 when no turn data exists). For each future turn it appends synthetic segments:

- assistant: 30% of the average,
- tool result: 70% of the average.

It re-scores the full set with the same anchors and computes the critical share. For each anchor, `timeToThreshold` is the first projected turn where its share falls below the configured threshold (default 5%).

The chart also runs the simulation at 0.7× and 1.3× token scale to show a band. The card displays the assumptions: tokens per turn, horizon, threshold, and “no compaction”. This is a projection, not a prophecy.

## 6. Phase strip

The heatmap's phase band classifies each turn by its tools and results:

| Phase | Rule |
|---|---|
| `debug` | error result, or test/error text with a write/command tool |
| `implement` | write/edit/apply_patch/bash/powershell |
| `explore` | read/grep/glob/list/search/web, or a `file`/`web` segment |
| `plan` | todo/plan/goal tool |
| `review` | diff/git/review tool |
| `handoff` | summary segment |
| `respond` | assistant content only |
| `idle` | no matching signal |

Phases are a narrative aid, not a judgment about productivity.

## 7. What the numbers are not

- They are **not** raw attention, per-head weights, or a measurement of DeepSeek internals.
- They are **not** a causal explanation of a specific answer.
- They are **not** billing-grade token counts. The token meter is a heuristic; CJK and JSON schemas are underpriced by the fixed 4-char heuristic.
- They are **not** calibrated to a specific DeepSeek checkpoint by default.

The UI labels every estimate and exposes the factor multipliers. The `unobserved` bucket is visible precisely because pretending to see hidden context would be worse than admitting it.

## 8. Calibration roadmap

1. **Needle probes (0.3)** — place a unique fact at 10/30/50/70/90% of a controlled context, ask the model to recall it, and fit the positional prior and age decay to the observed curve.
2. **Local measured mode (0.4)** — run an open-weight model with `output_attentions` and compare its measured attention distribution to the estimate. This is a research comparison, not a measurement of the API model.
3. **Attention-preserving compaction (1.0)** — use estimated share to decide which segments to summarize first and which to keep verbatim.

## 9. Research references

- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024. arXiv:2307.03172.
- Xiao et al., *Efficient Streaming Language Models with Attention Sinks*, 2023. arXiv:2309.17453.
- The long-context “distraction” and context-dilution literature surveyed by those lines of work.

## 10. Privacy

The projection computes locally. It sends the browser short previews and keyword bags, not full tool output. Anchors and settings live in `localStorage`. The plugin makes no network requests and has no telemetry.
