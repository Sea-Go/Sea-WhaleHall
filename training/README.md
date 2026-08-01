# WhaleHall Teacher–Student Training

This directory is a self-contained, versioned pipeline for turning WhaleHall
`EventWindow` JSONL into Qwen teacher labels and a ModernBERT multi-task
student. It does not change the Electrobun, Bun, TypeScript, or Rust dependency
graphs.

The standard-library stages run with the repository's Python 3 installation.
`torch` and `transformers` are imported only by the two GPU training commands;
install them in a separate 16–24 GiB CUDA environment, not in the desktop app.

## Fixed product contract

[`config/product_v1.json`](config/product_v1.json) pins:

- 1,000,000 deduplicated unlabeled windows;
- 300,000 Qwen candidates and 250,000 accepted/balanced weak labels;
- 10,000 gold labels: 2,000 initial train, four 1,000-example active-learning
  rounds, 1,500 calibration, and 2,500 permanently frozen test;
- local Ollama `qwen3:4b`, `num_ctx=4096`, concurrency 1, 4–8 windows per
  request, `think=false`, and a 30-minute keep-alive;
- Ollama `0.24.0`, model digest
  `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`,
  `4.0B`, and `Q4_K_M`;
- 12 activity labels, four goal-relevance labels, and the three ModernBERT
  losses (0.45 hard CE, 0.40 KD, 0.15 supervised contrastive);
- 256-dimensional normalized embeddings and the launch acceptance thresholds.

The authoritative taxonomy is
[`taxonomy/activity.v1.json`](taxonomy/activity.v1.json). The wire schemas are
[`event-window.v1.schema.json`](schemas/event-window.v1.schema.json) and
[`teacher-label.v1.schema.json`](schemas/teacher-label.v1.schema.json).
Runtime validation is intentionally stricter than generic JSON Schema: it
checks trigger invariants, runtime cursor/ingestion ordering, goal/relevance
consistency, unique IDs, and rejects raw key names, secrets, clipboard content,
and absolute pointer coordinates.

An `event_count` window contains exactly 64 merged semantic events and seals no
later than five minutes after its first event. A `max_wait` window contains
1–63 events and spans at least five minutes. `contextOnly` events are never
counted as evidence.

## Verify the dependency-free pipeline

Run from this directory:

```bash
cd training
PYTHONPATH=. python3 -m unittest discover -s tests -v
PYTHONPATH=. python3 -m whalehall_training --help
```

No model, private activity database, browser history, or real event export is
included in this repository.

## Dataset preparation

Export sealed runtime windows directly from the ReflectionJournal database
without opening it for writes:

```bash
PYTHONPATH=. python3 -m whalehall_training dataset export-runtime \
  /absolute/path/to/reflections.sqlite3 data/runtime-windows.jsonl \
  --manifest runs/runtime-export-manifest.json \
  --participant-id participant-pseudonym-001 \
  --session-timezone Asia/Shanghai
```

The exporter reads `reflection_windows.window_json` through SQLite
`mode=ro`/`query_only`, checks the immutable runtime `inputHash`, sorts by
binary `windowId`, and validates every converted `event-window.v1` row. Within
each window it preserves the immutable EventJournal cursor/array order; it
does not sort by producer `occurredAtMs`, which need not be globally monotonic
across asynchronous sensors. The
original runtime `modelInput` is never copied by default: it is rebuilt from
sanitized goal, context, and event structures. Content-bearing payload fields
such as text, title, URL, query, and relative path are removed, while raw key
names, clipboard values, credentials, and absolute coordinates are rejected
in every mode. The manifest records the source-row hash, database/WAL hashes,
export hash, transform version, timezone, participant pseudonym, and redaction
policy. `--include-content` is an explicit consent boundary for approved
offline datasets; it still does not permit the always-forbidden fields.
The rebuilt input uses the runtime's deterministic 3,000-token estimate and
32 KiB hard byte budget. If rich payloads exceed it, all event kind/timestamp
skeletons remain and bounded details are added newest-primary-first. This keeps
the immutable training export aligned with the online window builder. Before
student training or inference, the exact locked ModernBERT fast tokenizer
verifies that input again. If necessary, the shared
`all-skeletons-latest-primary-first.v1` crop starts from every context and
primary kind/timestamp skeleton, spends remaining tokens on newest primary
details first, and then on context details. Generic tokenizer truncation is
forbidden; a sequence that cannot retain every skeleton fails explicitly.

Validate every JSONL row before using it:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  dataset validate data/raw-windows.jsonl
```

Deduplicate normalized model inputs. Exact hashes are checked first; SimHash
banding proposes near-duplicate candidates and exact character-shingle Jaccard
similarity makes the final decision:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  dataset dedupe data/raw-windows.jsonl data/unlabeled-1m.jsonl \
  --report runs/dedup-report.jsonl
```

Group splitting is deterministic and overlap-aware. Windows sharing more than
50% of the smaller underlying event set remain together. The default keeps an
entire participant in one partition, then records the complete
`participant → device → project/goal → session/day → window` hierarchy in the
manifest:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  dataset split data/gold-10k.jsonl data/gold-splits
```

The command refuses to write a nominally exact split when indivisible
participant groups cannot satisfy the fixed counts. Curate participant/group
sizes and rerun. `--allow-quota-drift` exists only to inspect a diagnostic
split. A single-participant personal model can explicitly use
`--grouping-level session_day`; the resulting manifest records that weaker
isolation and must not be presented as cross-user evaluation.

The frozen test and calibration JSONL must never be passed to DAPT, prompt
tuning, teacher selection, candidate selection, or student training.

## Qwen3 4B teacher

Confirm the local model before starting:

```bash
ollama list
curl -s http://127.0.0.1:11434/api/version
```

The labeling client calls only `POST /api/chat`. Before the first batch it
reads `/api/version` and `/api/tags`, then pins the Ollama version and exact
model digest, parameter size, and quantization in the SQLite checkpoint. Every
value must equal the fixed config or labeling fails before `/api/chat`; a
version, digest, or configuration change cannot silently resume an existing
run. No token or credential is stored in the config. The request uses Ollama
JSON Schema structured output, `think:false`, `num_ctx:4096`, `temperature:0`,
and one concurrent request. The conservative 2,600-token window budget leaves
context space for the pinned rubric/schema and structured response. Transport
failures use bounded backoff; a schema-invalid response is retried once.

First validate Qwen on at least 1,000 representative gold windows:

```bash
PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/teacher-gate-1k.jsonl runs/gate-votes.jsonl \
  --pass A --checkpoint runs/gate.sqlite3

PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/teacher-gate-1k.jsonl runs/gate-votes.jsonl \
  --pass B --checkpoint runs/gate.sqlite3

PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/teacher-gate-1k.jsonl runs/gate-votes.jsonl \
  --pass C --checkpoint runs/gate.sqlite3

PYTHONPATH=. python3 -m whalehall_training teacher gate \
  data/teacher-gate-1k.jsonl runs/teacher-gate.json \
  --votes runs/gate-votes.jsonl --attempted 1000 --invalid-schema 0

PYTHONPATH=. python3 -m whalehall_training teacher benchmark \
  runs/gate.sqlite3 runs/teacher-throughput.json --pass A
```

The gate exits non-zero unless every configured threshold passes. Do not start
the 300,000-window run by merely increasing weak-label volume after a failed
gate; revise label definitions/few-shot prompt or choose a stronger teacher.
The benchmark also exits non-zero below 1,000 measured labels and reports p50,
p95, output tokens/second, and projected labels/day from checkpointed batches.

Select diverse candidates, then execute Pass A:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  candidates data/unlabeled-1m.jsonl data/candidates-300k.jsonl

PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/candidates-300k.jsonl runs/teacher-votes.jsonl \
  --pass A --checkpoint runs/teacher.sqlite3
```

The high-risk selector builds exactly 100,000 unique windows using the fixed
mix: 35% student entropy/low margin, 25% teacher–student disagreement, 20%
rare/sparse/no-goal evidence, 10% OOD novelty, and 10% stable random audit.
Optional window metadata fields are `studentEntropy`, `studentMargin`,
`studentActivity`, `studentGoalRelevance`, `oodScore`, and `noveltyScore`.
Missing scores are treated as zero, not fabricated:

```bash
PYTHONPATH=. python3 -m whalehall_training teacher high-risk \
  data/candidates-300k.jsonl data/high-risk-100k.jsonl \
  --votes runs/teacher-votes.jsonl \
  --manifest runs/high-risk-manifest.json

PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/high-risk-100k.jsonl runs/teacher-votes.jsonl \
  --pass B --checkpoint runs/teacher.sqlite3

PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/high-risk-100k.jsonl runs/teacher-votes.jsonl \
  --pass C --checkpoint runs/teacher.sqlite3
```

Normal A/B/C labeling keeps thinking disabled. Each pass uses a pinned,
different rubric (evidence-first, goal-first, and ambiguity-audit) so the
three deterministic calls are not identical prompt replays. `--thinking` is
available only for a separately approved, high-risk arbitration run; no
reasoning text is stored.

Create an empty file named by `--pause-file` to stop cleanly between batches.
Remove the file and rerun the identical command to resume. SQLite is the source
of truth; the JSONL export is regenerated deterministically. `--dry-run`
validates all batch sizes/token budgets and makes no network or checkpoint
write:

```bash
PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/candidates-300k.jsonl runs/teacher-votes.jsonl \
  --pass A --checkpoint runs/teacher.sqlite3 \
  --pause-file runs/PAUSE --dry-run
```

Long local runs can be restricted to a local-time interval. Overnight ranges
are supported:

```bash
PYTHONPATH=. python3 -m whalehall_training teacher label \
  data/candidates-300k.jsonl runs/teacher-votes.jsonl \
  --pass A --checkpoint runs/teacher.sqlite3 \
  --allowed-hours 22:00-07:00
```

The macOS thermal guard is enabled by default in the CLI and probes only at
batch boundaries. `serious`/`critical` pressure causes one bounded cool-down
and recheck; persistent pressure pauses the run. An unrecognized probe emits a
warning and pauses fail-safe by default. The checkpoint and command result
record `pauseReason`, so the same command resumes without duplicate labels.
Tune only the bounded wait with `--thermal-backoff-seconds` and
`--thermal-maximum-sleep-seconds`. `--thermal-unknown-policy continue` and
`--no-thermal-guard` are explicit operator overrides.

Aggregate Pass A and the B/C arbitration votes. A single non-ambiguous label
has weight 0.35, an ambiguous single label 0.25, and a three-pass majority has
weight 0.8. Three different votes are excluded and written to the human queue:

```bash
PYTHONPATH=. python3 -m whalehall_training teacher aggregate \
  data/candidates-300k.jsonl runs/weak-all.jsonl \
  --votes runs/teacher-votes.jsonl \
  --high-risk data/high-risk-100k.jsonl \
  --human-queue runs/human-review.jsonl

PYTHONPATH=. python3 -m whalehall_training teacher select-weak \
  runs/weak-all.jsonl data/weak-250k.jsonl
```

The final selector requires the fixed 250,000 total, 10,000–35,000 examples
per activity, at least 25,000 per non-null relevance label, and a maximum
3.5:1 activity ratio. It fails rather than silently weakening a quota.

## ModernBERT training

Create student examples only from the allowed training partitions. Gold labels
receive weight 1.0 and one-hot distributions; weak examples keep the empirical
A/B/C vote distribution and accepted weight:

```bash
PYTHONPATH=. python3 -m whalehall_training materialize \
  data/unlabeled-candidate-windows.jsonl data/weak-examples.jsonl \
  --weak-labels data/weak-250k.jsonl

PYTHONPATH=. python3 -m whalehall_training materialize \
  data/gold-splits/initial_train.jsonl data/gold-initial-examples.jsonl
```

Concatenate only training example files in the intended 3 weak : 1 repeated
gold batch schedule. Keep a manifest recording source hashes. The current
streaming loader uses a deterministic 4,096-example shuffle buffer; the job
scheduler is responsible for constructing the 3:1 stream.

Run one DAPT epoch on the one million unlabeled windows with an independent
development JSONL. Formal runs refuse to start without `--validation`. The
pre-DAPT validation loss is epoch zero; epoch one must improve it before epoch
two is allowed. The best state is restored before artifact creation:

```bash
PYTHONPATH=. python3 -m whalehall_training train dapt \
  data/unlabeled-1m.jsonl artifacts/modernbert-dapt \
  --validation data/dapt-development.jsonl \
  --epochs 2 --batch-size 8 --device cuda
```

Train a gold-only baseline first, then the weak+gold distillation job for each
configured seed (`17`, `29`, `43`). Point `--base-model` at the immutable DAPT
checkpoint when DAPT wins its ablation:

```bash
PYTHONPATH=. python3 -m whalehall_training train student \
  data/gold-train.jsonl artifacts/gold-only-seed-17 \
  --validation data/student-development.jsonl \
  --base-model artifacts/modernbert-dapt \
  --hard-only --seed 17 --batch-size 4 --device cuda

PYTHONPATH=. python3 -m whalehall_training train student \
  data/student-train.jsonl artifacts/student-seed-17 \
  --validation data/student-development.jsonl \
  --base-model artifacts/modernbert-dapt \
  --epochs 2 --seed 17 --batch-size 4 --device cuda
```

Gold-only defaults to at most five epochs with patience two. Weak-label
distillation defaults to and is capped at two epochs. Both evaluate validation
loss after every epoch, persist the best epoch, restore its weights, and write
`validationLosses`, `bestEpoch`, and `stopReason` to metrics. A bounded
`--maximum-steps` run is a smoke-test exception: validation/early stopping may
be omitted, and its metrics explicitly say
`smoke_maximum_steps_no_early_stopping`; such output is not a formal model.

The model shares one ModernBERT encoder and returns:

- 12-class activity logits pooled only over primary event tokens;
- four-class goal-relevance logits pooled over goal and event tokens, with
  relevance loss masked for no-goal windows;
- a 256-dimensional L2-normalized event embedding.

Student training and serving both pass the immutable deterministic
`modelInput` as one sequence. `goalText` remains in the HTTP/training record
only as an integrity invariant and is never appended to the encoder input a
second time. The fast tokenizer's offset mapping marks tokens after the
`[EVENTS]` marker for activity pooling. The product student budget is 8,192
tokens (ModernBERT's supported context); dynamic padding means short windows
do not pay that full length. DAPT remains independently capped at 1,024 tokens
because it is an MLM stage rather than the production classification input
contract; it deterministically emits every overflow chunk, so later evidence
is learned rather than discarded by a one-sided truncation.

The 8,192 value is a correctness ceiling, not a promise that micro-batch eight
fits a 16–24 GiB GPU. Padding is dynamic, but peak memory follows the longest
window in each batch. The CLI therefore defaults student micro-batches to four.
CUDA training defaults to `--mixed-precision auto`: BF16 on supported devices,
otherwise FP16 with GradScaler. Encoder gradient checkpointing is enabled by
default; `--no-gradient-checkpointing` is a diagnostic override, not a formal
long-context default. CPU and MPS smoke runs resolve `auto` to FP32, so local
artifact checks do not require CUDA autocast.
Before a formal run, measure peak allocated memory on the 1,000-window
representative benchmark and lower `--batch-size` for long-window buckets when
needed; never lower the token ceiling or enable tokenizer truncation to solve
an OOM. Supervised contrastive learning needs positives and negatives in the
same micro-batch, so a final run that must fall below micro-batch three should
move its long-window bucket to the 24 GiB node (or use a reviewed
cross-batch-memory implementation), rather than silently training a zero
contrastive term.

The loss implementation is the configured hard CE + temperature-scaled KL
distillation (`T=2`) + supervised contrastive loss. Run the planned
`T ∈ {1,2,4}` and KD weight `{0.25,0.40,0.55}` search only on development data.
The student command exposes `--distillation-temperature` and
`--distillation-weight`; it automatically gives the remaining weight to hard
CE. Use `--hard-only`, `--disable-kd`, and `--disable-contrastive` for the
declared ablations.
Repeat the full final fit from the fixed DAPT checkpoint after all four
active-learning rounds; do not continue from an order-dependent round model.

## Calibration, evaluation, and artifacts

Export calibration inference rows with `activityLogits`,
`activityTarget`, and nullable `relevanceLogits`/`relevanceTarget`, then fit
independent scalar temperatures:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  calibrate runs/calibration-logits.jsonl artifacts/calibration.json

PYTHONPATH=. python3 -m whalehall_training finalize-runtime \
  artifacts/student-final artifacts/calibration.json
```

Evaluation input contains `activityGold`, `activityPredicted`, 12
`activityLogits`, nullable goal-relevance gold/prediction/four logits,
`confidence`, `feedbackCode`, `triggerReason`, `hasGoal`,
`unseenParticipant`, and optionally the 256-value `embedding`. The command
reports ECE, high-confidence precision/coverage, refocus precision, embedding
Recall@10, and the required global, `event_count`, `max_wait`, no-goal, and
unseen-participant slices. Supply the independently measured gold-only
baseline:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  evaluate runs/frozen-test-predictions.jsonl runs/frozen-test-report.json \
  --gold-only-macro-f1 0.82
```

Evaluation exits non-zero if any launch threshold fails; `--allow-fail` writes
an explicitly diagnostic report during development. The pure metrics module
also provides ECE, per-class precision/recall/F1, temperature fitting, and
embedding Recall@K for the full evaluation harness.
Report all three seeds as mean and variance and retain ablations for raw
ModernBERT, gold-only, DAPT, KD, and contrastive loss. A stage that does not
improve its declared baseline is excluded from the final model.

Generate SHA-256 provenance for the finished model directory:

```bash
PYTHONPATH=. python3 -m whalehall_training \
  smoke artifacts/student-final

PYTHONPATH=. python3 -m whalehall_training manifest \
  artifacts/student-final artifacts/student-final/manifest.json \
  --model-version modernbert-whalehall-v1
```

The student artifact contains `student.pt`, `tokenizer.json`,
`tokenizer_config.json`, the encoder's local `config.json`, and runtime v2
metadata with taxonomy, architecture, model version, exact token/crop/pooling
contract, tokenizer SHA-256 fingerprint, and initially uncalibrated
temperature placeholders. It also records requested/resolved precision,
gradient checkpointing, and micro-batch size. `finalize-runtime` validates and
atomically installs the frozen calibration temperatures before smoke/manifest
generation.
`model-artifact.v2` refuses to materialize if any required file, the input
contract, or the tokenizer fingerprint is missing. The declared manifest
output and its atomic temporary file are excluded from the recursive file
inventory, so writing `manifest.json` inside the artifact remains idempotent
and never creates an invalid self-hash.
The smoke command uses `AutoConfig.from_pretrained(..., local_files_only=True)`
and `AutoModel.from_config`, strictly loads the complete `stateDict`, then
checks 12/4/256 output shapes and embedding normalization. It never follows
the DAPT path used on the training machine.

Start the executable, local-only `modernbert-inference.v1` adapter after
calibration and smoke validation:

```bash
export WHALEHALL_MODERNBERT_TOKEN='generate-a-local-secret'
PYTHONPATH=. python3 -m whalehall_training serve \
  artifacts/student-final --device cpu --port 8765
```

It binds only `127.0.0.1`, loads tokenizer/config/weights with
`local_files_only=True`, verifies the tokenizer graph against the training
fingerprint, and requires the frozen taxonomy, 12/4/256 architecture, runtime
v2 single-sequence input contract, OOD contract, and calibrated temperatures,
then serves
`POST /v1/reflections:infer` (plus `GET /healthz`). The default single
inference slot returns 429 under concurrent load instead of growing an
unbounded queue. Request/body/model-input/response sizes are bounded. If the
environment variable named by `--token-env` is set, bearer authorization is
mandatory; the token and `modelInput` are never logged. A no-goal request must
use null `goalText`, `goalVersion`, and goal relevance output.

Do not use the home cloud's 4 GiB GPU for full fine-tuning. It is suitable for
artifact storage and deployment verification. Until the real consented data,
1,000-example teacher benchmark, 10,000 human labels, multi-user frozen split,
GPU runs, calibration, ablations, and acceptance report exist, this directory
is an executable pipeline—not a trained production model.
