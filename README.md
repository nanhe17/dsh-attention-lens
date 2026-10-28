# Attention Lens

> See attention before it dilutes.

Attention Lens is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that estimates how a long session's attention budget is distributed across the context window. It shows a U-shaped attention curve, a segment-by-turn heatmap, user-pinned anchors, a dilution forecast, and a per-segment factor breakdown.

**Important:** model APIs do not expose attention weights. Attention Lens is an explicit, configurable **estimate** — a positional prior plus content salience, lexical relevance, age, and anchors — not a measurement of the provider's internal attention. Read [METHODOLOGY.md](METHODOLOGY.md) before treating any number as ground truth.

![Attention Lens](docs/attention-lens.png)

## Why

Long contexts are not used uniformly. Models tend to over-attend to the beginning and the end of a prompt, lose material in the middle, and dilute the relative weight of older facts as new turns pile up. In an agent session this looks like the model "forgetting" the original requirement while it is still sitting in the context.

Existing context tools usually show token composition. Attention Lens asks a different question: **where is the limited attention budget going, and how will the next turns change it?**

## Features

- **Attention curve** — estimated density per token across context position, with a dashed positional prior and a shaded cold zone.
- **Segment × turn heatmap** — watch a requirement cool down while tool output heats up.
- **Dilution forecast** — project the next N turns and get a countdown for each anchor: `below 5% in 6 turns`.
- **Anchors** — pin the original requirement, a design decision, or a constraint, then track its share. With no pins, the first real user message becomes an auto anchor.
- **Explainable shares** — click any segment to see position, type, relevance, salience, age, and pin factors.
- **Segment semantics** — runtime context, time snapshots, and skill catalogs are classified as `context`, not user intent, so infrastructure does not crowd out the actual request.
- **Composer sparkline** — a compact `AL` sparkline in the composer dock.
- **Bilingual UI** — English and Chinese, following the host locale.
- **Local-only** — no network calls, no telemetry, no prompt or session mutation.

![Attention Lens heatmap, anchors, and forecast](docs/attention-lens-detail.png)

## Install

Attention Lens targets DeepSeek Harness `0.2.1-rc.3`.

From npm (once published):

```bash
dsh plugin --profile <profile> add dsh-attention-lens
```

From a local checkout:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-attention-lens
```

The DSH Desktop profile is managed by the Electron application, so the CLI refuses to edit it. In Desktop, install through **Settings → Plugins** (or the `plugin_manager` tool) instead.

After installation, open a session and select the **Attention** tab next to Chat and Trajectory. The `AL` sparkline appears in the composer dock when the session has context.

## Usage

1. Open a session with a few turns and at least one tool call.
2. Open **Attention**.
3. Pin the requirement or constraint you care about. The anchor card shows its estimated share and forecast countdown.
4. Adjust the preset, threshold, and forecast horizon in **Settings → Attention Lens**.
5. Use the curve and heatmap to decide whether to restate, compact, reorder, or split the context.

Everything is an estimate. The UI labels it as such and exposes the factors behind each share.

## How it works

```text
session events
     │
     ▼
host projection (attentionLens)
  surface segments · token estimates · tools · usage · context window
     │  wire.view
     ▼
client scoring
  position prior × type × relevance × salience × age × anchor
     │
     ├── curve / heatmap / anchors
     ├── dilution forecast
     └── factor breakdown
```

- The **host** half folds committed session events into model-visible segments. It does not call a model, edit the prompt, or append session events.
- The **client** half scores those segments, renders the charts, stores anchors and preferences in `localStorage`, and simulates future turns.
- Token counts come from `ctx.tokenMeter.estimateMessage()` when available, with a CJK-aware fallback. Counts are labeled approximate when the exact provider tokenizer is not available.
- The difference between the latest provider-reported prompt size and the observed segments becomes an `unobserved` bucket, so the budget does not pretend to see hidden system or tool content.

See [METHODOLOGY.md](METHODOLOGY.md) for the formula, defaults, metrics, and limitations.

## Privacy

- All computation is local to the DSH process and the browser.
- No session content is sent anywhere.
- Anchors and settings are stored in this browser's `localStorage`.
- The host projection exposes short previews and keyword bags, not full tool output.

## Limitations

- **This is not raw attention.** No API exposes attention matrices, KV cache, or per-layer weights. The model is a transparent estimate.
- Positional bias differs by model and route; the defaults are a prior from published long-context research, not a DeepSeek measurement.
- Token counts are approximate unless the host token meter provides them.
- The assembled system prompt and tool schemas may be partially unobservable; those tokens appear in the `unobserved` bucket.
- Compaction boundaries are reconstructed from events; an unknown boundary degrades to an approximation.
- DeepSeek Harness is a developer preview. The plugin targets stable seams (session projections, slots, locale) and declares `engines.dsh`.

## Development

```bash
npm install
npm test
```

The plugin is plain JavaScript: the host is ESM (`.mjs`), the browser half is a classic script compatible with the DSH client module loader. There is no build step.

To try a local checkout in an isolated profile:

```bash
dsh --profile attention-dev --from-default-profile web --dump-config
dsh plugin --profile attention-dev add link:/absolute/path/to/dsh-attention-lens
dsh --profile attention-dev
```

The second command creates a web-based test profile; the third boots it.

## Roadmap

- **0.2** — what-if lab (pin / compact / reorder / split comparison), anchor alerts, compaction integration.
- **0.3** — calibration lab: needle probes and fitted model profiles.
- **0.4** — optional local measured-attention mode for open-weight models, used only as a comparison.
- **1.0** — attention-preserving compaction and portfolio-level context health.

## License

MIT. See [LICENSE](LICENSE).
