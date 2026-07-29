# noisebench

An open benchmark that measures the **forecasting noise** of LLMs on
[Polymarket](https://polymarket.com) markets.

For each market we prompt a model repeatedly on both the market's real
`question` **and** its logical `negatedQuestion`. A perfectly coherent forecaster
would assign complementary probabilities to the two phrasings (`P(Yes) + P(Yes on
the negation) ≈ 1`) and would return the same answer every time. Real models
don't — they drift between repetitions and contradict themselves between a
question and its negation. That gap is the noise this benchmark quantifies.

The same question is asked a second way, without any numbers involved: given two
markets, **which outcome is more likely?** Ranking two markets needs no
probability from either, so it isolates whether a model's ordering is stable
under rephrasing — a coherent forecaster that ranks A above B must rank "not A"
below "not B".

Every forecast is:

- **produced** through [OpenRouter](https://openrouter.ai) with pinned,
  reproducible sampling parameters,
- **persisted** to PostgreSQL with the full trace (prompts, raw response,
  reasoning, tokens, cost, timing, and any error/refusal payloads), and
- **recorded on-chain** to the [`ForecastRegistry`](../forecast-registry)
  contract on [Base](https://base.org), one wallet per model, so the record is
  tamper-evident and independently auditable.

## How it works

The benchmark runs two modalities over one dataset.

### 1. Direct — how likely is this market?

For every combination of

```
{ event, market } × model × { base, negated } × iteration (T = 4)
```

it calls the model once, parses the probability off the end of the plain-text
answer (`Probability: X%`), and writes one `forecast` row.

### 2. Pairwise — which of these two markets is likelier?

The dataset also lists **pairs** of markets to rank against each other. For every
combination of

```
{ market A, market B } × model × { 4 phrasing combinations } × iteration (T = 2)
```

it asks only which of the two outcomes is more likely — **no probability for
either** — parses `More likely: A` / `More likely: B`, and writes one
`pairwise_forecast` row.

The four phrasing combinations are the two questions and their negations:
`(A, B)`, `(¬A, B)`, `(A, ¬B)`, `(¬A, ¬B)`. They exist because flipping **both**
sides must invert the answer for any coherent forecaster:

```
P(A) > P(B)   iff   1 - P(A) < 1 - P(B)
```

That identity holds whatever the model believes, so the rate at which it is
violated is a **noise** measurement and needs no ground truth — exactly like
`|Yes + No − 1|` on the direct side. The four combinations therefore form two
couples that must disagree: `(A,B)` against `(¬A,¬B)`, and `(¬A,B)` against
`(A,¬B)`.

Pairs may span events, and a market is never paired with itself. Listing the
**reversed** pair `[B, A]` is allowed and is genuinely different work: all four
combinations present market A first, so a reversed pair is the only way to probe
position bias.

### Prompt structure

- **System prompt** — the generic task framing, resolution conventions, and the
  required output format. `SYSTEM_PROMPT` for the direct modality,
  `PAIRWISE_SYSTEM_PROMPT` for the ranking one. See [`src/llm.ts`](src/llm.ts).
- **User prompt** — the specifics of what is being forecast: one market (title,
  question or negated question, rules, dates, research context), or both sides
  of a pair with the same treatment each. A pair whose markets share an event
  carries that event's research once rather than twice.

The pairwise prompt explicitly refuses a tie: the registry has no encoding for
"equally likely" — a coin-flip judgment is noise, not data — so a model that
declines to choose produces no data point at all.

### Sampling parameters (pinned for reproducibility)

| Parameter          | Value                                        |
| ------------------ | -------------------------------------------- |
| `temperature`      | `1`                                          |
| `top_p`            | `1`                                          |
| `reasoning.effort` | `medium`                                     |
| `verbosity`        | `medium`                                     |
| `provider`         | `{ order: [...], allow_fallbacks: false }`\* |

\* Pin the provider per model (config `{ "slug": "...", "provider": "..." }`) so
every call for a model routes to the same backend. Failed calls and refusals are
retried up to 3× with exponential backoff; each error payload (`code` +
`message`) is collected and stored on the trace.

### On-chain encoding

Each usable forecast is recorded via `recordForecast(platformId, marketId,
outcome, odds)` (batched with `recordForecastBatch`), where `odds` are basis
points `round(p * 10000)`. We encode the two phrasings as the two sides of the
same market:

- **base** question → `outcome = "Yes"`, `odds = P(question resolves Yes)`
- **negated** question → `outcome = "No"`, `odds = P(negation resolves Yes)`

Because negated-Yes is logically the market's "No", a coherent model's `Yes` and
`No` odds for a market sum to ~`10000` on-chain — the deviation is the noise,
visible directly in the event log.

Pairwise judgments go through `recordPairwiseForecast(platformIdA, marketAId,
marketAOutcome, platformIdB, marketBId, marketBOutcome, isALikelier)` (batched
with `recordPairwiseForecastBatch`). They carry **no odds at all** — only which
side won — and each side's phrasing maps to that market's outcome by the same
rule as above, so a side asked negated is published as its market's `"No"`.

The batch call takes a struct array rather than parallel arrays: with seven
columns, parallel arrays would let a caller pair market A of one judgment with
market B of the next and never notice.

Each forecaster wallet also records its model on-chain once via
`setAttribute("forecastingModel", <slug>)` /
`setAttribute("researchModel", "local-research-v1")` before it starts. Both
modalities publish from that same wallet, as two separate transactions issued
sequentially so they cannot race for the same nonce.

## Stack

- **Node.js + TypeScript** (run directly with [`tsx`](https://tsx.is)).
- **PostgreSQL** for durable storage (one migration, local Docker helper).
- **OpenRouter** for all inference (all LLM logic lives in
  [`src/llm.ts`](src/llm.ts)).
- **`ForecastRegistry`** on Base for the on-chain forecast log
  (see [`../forecast-registry`](../forecast-registry)).

## Prerequisites

- Node.js ≥ 18 (uses the global `fetch`).
- Docker (for the local PostgreSQL) — or your own reachable Postgres.
- An OpenRouter API key.
- For on-chain recording: a funded Base wallet to use as the funder, and the
  deployed `ForecastRegistry` address. On-chain recording can be disabled for
  local dry-runs (`SKIP_ONCHAIN=true`).

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env      # then fill in OPENROUTER_API_KEY, FORECAST_REGISTRY_ADDRESS, ...

# 3. Bring up Postgres, apply pending migrations, seed the provider catalog
npm run db:setup          # docker compose up -d + migrate + seed providers.json
#   npm run db:setup -- --reset      # wipe and recreate the schema (destructive)
#   npm run db:setup -- --no-docker  # use an already-running Postgres

# 4. (on-chain mode only) Create the wallet keys
npm run generate-master-mnemonic     # writes .master (derives every forecaster wallet)
#   put a funded Base private key (64 hex, optional 0x) in .funder.txt
```

`.master` and `.funder.txt` are gitignored secrets. Each model gets a wallet
derived from `.master` at `m/44'/60'/0'/0/{index}`; below `THRESHOLD_BALANCE`
ETH, a wallet is topped up from the funder before the run.

## Usage

### Smoke-test the inference path

No DB, no chain, nothing stored — only `OPENROUTER_API_KEY`.

`--all` runs a whole dataset through **one** model: every market in both
phrasings, every pair in all four phrasing combinations. It then reports both
coherence metrics for that model alone, which is the cheapest way to judge a
model before committing to a full run:

```bash
npm run test-inference -- \
  --dataset datasets/28-07-26.json \
  --config configs/benchmark.example.json \
  --model <openrouter-slug> --all [--verbose]
```

That costs `markets x 2 + pairs x 4` calls — it prints the plan before spending
anything, and exits non-zero if any call produced no usable answer. `--verbose`
adds a one-line excerpt of each raw response.

Without `--all` it makes a single call and prints everything captured — prompts,
reasoning, raw response, tokens, cost, timing:

```bash
npm run test-inference -- \
  --dataset <path> --config <path> \
  [--event <event-slug>] [--model <openrouter-slug>] [--negated]

# the pairwise prompt, for one pair in one phrasing combination
npm run test-inference -- \
  --dataset <path> --config <path> --pairwise \
  [--pair <index>] [--combination <00|10|01|11>]
```

`--event` defaults to the first event, `--model` to the first configured model,
and the first market of the event is used. In `--pairwise` mode, `--pair`
indexes the dataset's `pairs` array and `--combination` selects which phrasing
each side is asked in (A then B, `1` = negated).

### Run the benchmark

```bash
# Fresh run
npm run benchmark -- --config configs/benchmark.example.json --dataset datasets/28-07-26.json

# Local dry-run without touching the chain — set SKIP_ONCHAIN=true in .env
npm run benchmark -- --config configs/benchmark.example.json --dataset datasets/28-07-26.json

# Resume an interrupted run (skips tasks already completed successfully)
npm run benchmark -- --config configs/benchmark.example.json --resume <benchmarkRunId>
```

Set options in `.env` rather than as command-line prefixes: `VAR=value cmd` is
bash-only, and does nothing on PowerShell.

### Slice first, then widen

A production cycle is expensive and, once published, permanent — so start it
small and grow it in place rather than committing to the whole thing up front:

```bash
# 1. rehearse the entire pipeline on 2 markets and 1 pair, across every model
npm run benchmark -- --config configs/benchmark.production.json \
  --dataset datasets/<real>.json \
  --max-markets 2 --max-pairs 1 --prompt-iterations 1 --pairwise-iterations 1
npx tsx scripts/verify-run.ts --run <R> --onchain    # every check must be green

# 2. widen THE SAME RUN to everything, keeping what the slice produced
npm run benchmark -- --config configs/benchmark.production.json \
  --dataset datasets/<real>.json --resume <R>
npx tsx scripts/verify-run.ts --run <R> --onchain
```

The second invocation does **not** redo the first. Markets are upserted on their
external id and resume keys off the resulting market id, so slicing the _same
dataset file_ yields identical ids and the completed-task sets skip exactly the
work already paid for. `test:e2e` asserts this directly: it slices, widens, and
fails if a single completed row was rewritten.

Slice the real dataset with the flags rather than hand-authoring a smaller file.
A separate file gives no guarantee that its ids match, and one edited external id
silently turns the widened run into a partly duplicated one.

`--max-pairs` is applied first and the markets it names are mandatory, so
`--max-markets 2 --max-pairs 1` yields exactly the two markets of the first pair.
Asking for fewer markets than the selected pairs need is an error, not a silently
dropped pair.

Scope and reliability flags, all overriding the config file:

| Flag                      | Effect                                         |
| ------------------------- | ---------------------------------------------- |
| `--max-markets N`         | Cap markets (pairs' markets are kept first)    |
| `--max-pairs N`           | Cap pairs, taken from the top of the list      |
| `--prompt-iterations N`   | Override `promptIterations`                    |
| `--pairwise-iterations N` | Override `pairwiseIterations`                  |
| `--model-concurrency N`   | Max models running at once (default: all)      |
| `--retry-passes N`        | Extra sweeps over unfinished tasks (default 1) |

**Sizing `--model-concurrency`.** In-flight inference is
`modelConcurrency × concurrency`, so capping models without raising `concurrency`
cuts throughput proportionally — 20 models × 6 is 120 in flight, 4 × 6 is 24. For
a run that must finish in a day, raise `concurrency` to compensate, and raise
`PG_POOL_MAX` with it: it must exceed `modelConcurrency × concurrency`, or tasks
start failing on the pool's 10s acquisition timeout rather than on anything real.
The benchmark warns at startup when the numbers do not add up.

### When something fails

A task that throws after inference is retried (`taskMaxRetries`, default 2) if it
looks transient, then logged and left for a later pass. A model failing more than
`taskFailureAbortRate` (default 20%) of its tasks is abandoned so it cannot burn
the budget; its rows so far are kept and `--resume` picks it up once the cause is
fixed. A database _integrity_ violation is different: it means a row contradicting
its own schema constraints reached the insert, so it stops the run immediately
rather than being retried across every model.

The run exits non-zero if any model was abandoned or any batch never reached the
chain, and prints what to do about each.

On startup the benchmark: initializes a forecaster per model, derives its wallet,
funds it if it is below `THRESHOLD_BALANCE`, then declares its model on-chain if
the chain does not already show that claim, upserts the
dataset's events/markets, creates (or loads) the `benchmark_run` and its state,
then runs each model's tasks in parallel — persisting to the DB and submitting
batched forecasts on-chain as results come back. When a forecaster finishes, its
final batch is flushed immediately instead of waiting for the batch timeout.

## Analysis

Once a run is in the database, `analyze.ts` turns it into the static JSON the
site reads. It measures **noise and internal consistency only** — nothing is
scored against how a market resolved, and where a market price appears it is a
snapshot input describing what the crowd thought when the question was asked,
never an answer key.

```bash
npx tsx scripts/backfill-snapshot.ts --run 1   # orderbook prices from the dataset
npx tsx scripts/analyze.ts --run 1             # → site/data/*.json
npm run site                                   # → http://localhost:4321
```

The backfill is only needed for runs that finished before migration 05 added
`benchmark_run_market_snapshot`; it is idempotent and safe to re-run.

The statistics live in [`src/analysis.ts`](src/analysis.ts) as pure functions
over observations, unit-tested against synthetic panels with known variance
components, so the estimator can be checked without a database. A single crossed
decomposition over model × market × phrasing × iteration yields level, stable
pattern and occasion noise plus the Yes/No phrasing effect; every measure is
computed on both the probability and log-odds scales, because the dataset's
median midpoint is 0.19 and the two scales disagree about what "noisy" means at
the tails.

The measures, the subsetting policy, and the design decisions behind them are
specified in [`docs/analysis-design.md`](docs/analysis-design.md). Research goals
1 and 2 are built; 3–7 are specified but not yet implemented.

The site is plain HTML with inline SVG and no build step. It reads only
`site/data/*.json`, so once those are generated it needs no database — but it
does need a server, because `file://` blocks the fetch.

## Testing

A production cycle is ~16,000 inference calls across 20 models, so mistakes are
expensive and, once published, permanent. Two commands cover everything that can
be checked without spending money.

```bash
npm test          # unit tests only — no database, no Docker, ~1s
npm run test:e2e  # the whole pipeline against a throwaway database, ~10s
```

### `npm run test:e2e`

One self-contained command. It brings up its own PostgreSQL, applies the
migrations, seeds the provider catalog, runs the unit tests, drives the **real**
`benchmark.ts` over a production-shaped synthetic dataset with fake inference,
reconciles the result, resumes the run, and reconciles again — then destroys the
database.

```
1. Start a throwaway PostgreSQL          8. Re-verify after resume
2. Apply migrations + seed providers
3. Unit tests                            → 16,000 forecasts
4. Generate the synthetic dataset        →   4,000 pairwise judgments
5. Benchmark run (fake, no chain)        → 20 models, ~10 seconds
6. Verify run
7. Resume run
```

The generated dataset carries pairs, and a leftover dataset file without them is
regenerated rather than reused — otherwise the suite would either fail to load
it or report a pass for a pairwise path it never ran.

It is **isolated by construction**: its own Compose project, its own container,
port 5434 rather than the development database's 5433, and data on `tmpfs` so it
is destroyed with the container. Nothing it does can touch the database you keep
real runs in — and because the data is ephemeral, it runs with `fsync=off`,
which is why full production volume takes seconds.

```bash
npm run test:e2e -- --markets 20   # quicker smoke over fewer markets
npm run test:e2e -- --keep         # leave the database up to inspect it
```

**What it proves:** migrations apply from nothing; the dataset ingests; and
16,000 forecasts plus 4,000 pairwise judgments survive the whole orchestration —
every DB mapping, 120-way concurrency, progress bookkeeping, and the resume path
— at production volume.

**What it does not prove:** anything on-chain. Submission is skipped entirely.

### On-chain validation

Not covered by the suite. Validate it with a **small real run** — a handful of
markets and one or two cheap models against the real registry — then reconcile
with the same tool the suite uses:

```bash
npm run benchmark -- --config configs/benchmark.smoke.json --dataset <small dataset>
npx tsx scripts/verify-run.ts --run <id> --onchain
```

Checks **C** and **C2** are the ones to watch: they report usable forecasts and
pairwise judgments that never reached the chain. Three things to confirm on that
run, because none can be observed offline: the gas a full `recordForecastBatch`
**and** a full `recordPairwiseForecastBatch` actually cost — together they are
what `THRESHOLD_BALANCE` must cover for every batch a wallet will submit, and a
pairwise batch carries two market ids and two outcome strings per item, so it is
the more expensive of the two — and that each wallet declared its model
(check **E3**).

The dataset used for that run must list `pairs`, or the pairwise path is never
exercised on-chain and **A2**/**C2** report `SKIP`.

### Before spending on a full cycle

```bash
npx tsx scripts/probe-models.ts --config <your production config> --markets 100
```

Two real calls per model, roughly $1 for 20 models. It reports a projected
production bill and hard-fails on the per-model problems that are invisible
until they have already been paid for 800 times: an unhonored provider pin, a
truncated response (`finish_reason: "length"`), output that does not match the
required format, or a model reporting no cost.

### The tools

| Script                                                                 | Purpose                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`scripts/test-e2e.ts`](scripts/test-e2e.ts)                           | **The whole pipeline against a throwaway database.** `npm run test:e2e`.                           |
| [`scripts/verify-run.ts`](scripts/verify-run.ts)                       | **Reconciles a run across the DB and the chain.** Run it after a rehearsal _and_ after production. |
| [`scripts/probe-models.ts`](scripts/probe-models.ts)                   | Two real calls per model; catches unhonored provider pins, truncation, and format failures.        |
| [`scripts/republish.ts`](scripts/republish.ts)                         | Re-submits forecasts that never reached the chain.                                                 |
| [`scripts/gen-synthetic-dataset.ts`](scripts/gen-synthetic-dataset.ts) | Production-shaped dataset with hostile text, for offline rehearsals.                               |
| [`src/llm-fake.ts`](src/llm-fake.ts)                                   | Deterministic offline stand-in for inference (`NOISEBENCH_FAKE_INFERENCE=true`).                   |

`verify-run.ts` is the check that matters. Structural checks (**A**/**A2**,
**B**/**B2**, **C**/**C2**, **D**) confirm the plumbing; **F** and **G** confirm
the _meaning_, one per modality:

- **F** — for every `{forecaster, market, iteration}`, both phrasings exist and
  `mean |Yes + No − 1|` is reported. That number **is** the direct noise metric,
  and if the base/negated → Yes/No mapping ever inverts it jumps from ~0.1 to
  ~1.0 while every structural check still passes.
- **G** — for every `{forecaster, pair, iteration}`, the two combination couples
  disagree. The violation rate **is** the pairwise noise metric. The two couples
  are scored **separately** and either alone fails the check: the realistic bug
  wrecks one couple and leaves the other intact, so an averaged verdict would
  report ~50% and call a catastrophic run healthy.

The fake is deliberately hostile: it injects unparseable responses, hard
failures, null costs, 100 KB reasoning blobs and non-ASCII text at fixed rates,
so a rehearsal exercises the failure paths rather than only the happy one. On
the pairwise side it also injects declared ties (which must yield no data point
at all) and, at a fixed rate, judgments that contradict its own beliefs — so
check **G** has real violations to find. A fake that were perfectly coherent
would make **G** report 0.00%, which passes just as happily whether the check
measures anything or nothing.

It is also deterministic, which is what makes the resume leg meaningful — the
same tasks fail again, and the row count must not move.

### Safety rails

- Mainnet requires `CHAIN_ID=8453` **and** `ALLOW_MAINNET=true`. Anything else
  aborts before a transaction is signed.
- Public RPC fallbacks are filtered by chain, so a rotation on one network can
  never land on another.
- A wallet is funded **before** it declares its model, and the declaration is
  gated on what the chain actually reports — a claim that failed on an earlier
  run is repaired on the next one.
- A run whose forecasts came from the fake says so, loudly, on every start.

## Dataset format

A dataset is a single JSON file under `datasets/`, named by date
(`datasets/DD-MM-YY.json`), containing the events to forecast and the pairs of
markets to rank against each other:

```jsonc
{
  "events": [/* … see below … */],
  // Pairs of MARKET SLUGS. May span events; a market is never paired with
  // itself. Listing [B, A] as well is allowed and probes position bias.
  "pairs": [
    [
      "will-china-invade-taiwan-by-september-30-2026",
      "will-anthropic-ipo-by-september-15-2026-415",
    ],
  ],
}
```

Both keys are required. A dataset that runs no comparisons says so with
`"pairs": []` — inferring that from a missing key would make an authoring slip
indistinguishable from a deliberate direct-only run. Every pair is resolved
before the run writes anything: an unknown slug, an ambiguous one, a
self-comparison or a duplicated pair fails the run immediately rather than
surfacing later as a reverted transaction or a short run.

Each event looks like:

```jsonc
[
  {
    "externalId": "556131",
    "isNegRisk": true,
    "startDate": "2026-06-04T17:53:02.599Z",
    "endDate": "2026-07-31T00:00:00.000Z",
    "title": "Which company has best AI model end of July?",
    "description": "…event/resolution rules…",
    "slug": "which-company-has-best-ai-model-end-of-july-299",
    "tags": ["tech", "ai"],
    "markets": [
      {
        "externalId": "2430327",
        "startDate": "2026-06-04T17:53:03.848Z",
        "endDate": "2026-07-31T00:00:00.000Z",
        "slug": "will-anthropic-have-the-best-ai-model-at-the-end-of-july-2026",
        "question": "Will Anthropic have the best AI model at the end of July 2026?",
        "negatedQuestion": "Will Anthropic fail to have the best AI model at the end of July 2026?",
        "description": "…market resolution rules…",
      },
    ],
    "research": "# Deep Research Report… (context fed to the model)",
  },
]
```

See [`datasets/28-07-26.json`](datasets/28-07-26.json) for a complete example.

## Benchmark config

A JSON file (see [`configs/benchmark.example.json`](configs/benchmark.example.json)):

```jsonc
{
  "name": "noisebench-28-07-26",
  "description": "…",
  "dataset": "datasets/28-07-26.json", // optional; --dataset on the CLI wins
  "models": [
    { "slug": "openai/gpt-5.6-luna", "provider": "openai" }, // pin the provider
    "anthropic/claude-opus-4.8", // or a bare slug
  ],
  "promptIterations": 4, // repetitions per model per phrasing
  "pairwiseIterations": 2, // repetitions per model per phrasing combination
  "concurrency": 6, // max concurrent inference calls per forecaster
  "modelConcurrency": 4, // max models running at once (default: all)
  "taskMaxRetries": 2, // retries for a task that threw after inference
  "taskFailureAbortRate": 0.2, // give up on a model failing more than this share
  "retryPasses": 1, // extra sweeps over unfinished tasks before ending
}
```

`pairwiseIterations` is a separate dial from `promptIterations` because a pair
already costs four calls per iteration. It defaults to `2`; a config written
before the pairwise modality existed picks up that default rather than silently
running no pairwise tasks. Both modalities share the one `concurrency` budget
per forecaster.

`modelConcurrency` bounds how many models run at once; unset means all of them,
which is the historical behaviour. See
[Slice first, then widen](#slice-first-then-widen) for how it interacts with
`concurrency` and `PG_POOL_MAX` — the three have to be set together.

[`configs/benchmark.production.example.json`](configs/benchmark.production.example.json)
is a starting point for a real cycle: copy it to `benchmark.production.json` and
replace the model list and dataset.

## Database schema

Four migrations ([`migrations/`](migrations/); `npm run db:setup` applies any
that are pending, tracked in `schema_migration`):

| Table                                                              | Purpose                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `llm_model` / `llm_provider`                                       | Interned model slugs and providers (`slug` + display `name`), referenced by id everywhere.      |
| `schema_migration`                                                 | Which migrations have been applied, so a new one reaches an existing database.                  |
| `forecaster`                                                       | One LLM model; links to its wallet and to its `llm_model`.                                      |
| `feature_key` / `feature_value` / `feature` / `forecaster_feature` | Generic key/value tags on forecasters (model, provider, …).                                     |
| `wallet` / `wallet_predictor_derivation_index`                     | Derived on-chain identities and their BIP-44 indices.                                           |
| `transaction`                                                      | Interned on-chain tx hashes referenced by forecasts.                                            |
| `llm_trace`                                                        | One row per inference call: prompts, response, reasoning, tokens, cost, timing, errors.         |
| `event` / `market`                                                 | Trimmed Polymarket event/market surface.                                                        |
| `forecast`                                                         | The atomic data point: one row per `{run, forecaster, market, isNegated, iteration}`.           |
| `pairwise_forecast`                                                | The pairwise data point: one row per `{run, forecaster, ordered pair, combination, iteration}`. |
| `benchmark_run`                                                    | Run metadata (config, dataset, status, start/end).                                              |
| `benchmark_run_model`                                              | Which models a run benchmarks.                                                                  |
| `benchmark_run_market`                                             | Which markets are in scope for a run.                                                           |
| `benchmark_run_pair`                                               | Which ordered market pairs are in scope for a run.                                              |
| `event_research`                                                   | The research context a run fed to the model for an event (`{run, event}` → blob).               |
| `benchmark_predictor_state`                                        | Per-forecaster progress within a run.                                                           |
| `benchmark_status` / `predictor_status`                            | Seeded lifecycle states for runs and per-forecaster progress.                                   |

Research is deliberately **not** a column on `event`: it comes from the run's
dataset, so the same event benchmarked from a later dataset carries different
(fresher) context. It lives on `event_research`, keyed by `{benchmark_run, event}`.

### Integrity constraints

Migration `04_integrity.sql` makes the corruptions that matter most
unrepresentable rather than merely detectable:

- **Negation/outcome consistency** on `forecast` and `pairwise_forecast`. A
  negated phrasing IS that market's "No", and the row now cannot say otherwise.
  Previously an inverted branch anywhere upstream would publish every forecast on
  the wrong side of every market while passing every structural check — visible
  only as a coherence metric near 1.0, long after the money was spent.
- **`llm_trace_id IS NOT NULL`**, safe now that the trace and the forecast are
  written in one transaction. A forecast with no trace is a number nobody can
  account for.
- **`transaction.chain_id`**, because dev and mainnet rows share one database and
  a tx hash alone says nothing about which chain it landed on.

Checks are added `NOT VALID` and validated separately, so the migration cannot be
blocked by legacy rows: new writes are governed either way, and a row that
violates one produces a warning naming the constraint and the query to re-run.

### The provider catalog

OpenRouter identifies a provider two ways, and the benchmark meets both: a
config **pins** routing by slug (`"provider": "google-vertex/global"`, where
`/global` is an optional region shard), while a completion **reports** what it
routed to by display name (`"Google"`). Comparing those strings directly flags
every correctly pinned model as a violation.

`llm_provider` therefore carries both, seeded from `providers.json` (the body of
<https://openrouter.ai/api/v1/providers>). `npm run db:setup` seeds it
automatically; refresh it whenever OpenRouter adds providers:

```bash
npx tsx scripts/seed-providers.ts [--file providers.json]
```

Translation lives in [`src/providers.ts`](src/providers.ts). A provider absent
from the catalog yields **`unverifiable`**, never a violation — an unknown
provider says nothing about whether the pin was honored, and reporting it as a
failure is a false alarm.

`--resume` consults the `forecast` table (rows with a parsed probability) to skip
completed work; tasks that previously failed to parse are retried.

## Project layout

```
configs/                 benchmark config files
datasets/                dated dataset files (DD-MM-YY.json)
migrations/
  01_init.sql            the schema
  02_provider_slug.sql   provider slug <-> display name
  03_pairwise.sql        pairwise rank forecasts
  04_integrity.sql       constraints, chain provenance, indexes
  05_market_snapshot.sql per-run orderbook snapshot
docs/
  analysis-design.md     measures + statistical design for the analysis layer
site/                    static analysis site (no build step)
  index.html             overview + coverage
  goal1-noise.html       level / stable pattern / occasion noise
  goal2-negation.html    Yes/No phrasing bias
  assets/viz.{css,js}    chart primitives and theme
  data/                  generated by analyze.ts
scripts/
  benchmark.ts           main entry point (fresh run / --resume)
  analyze.ts             run → site/data/*.json
  backfill-snapshot.ts   dataset orderbook prices → DB
  serve-site.ts          static server for site/ (npm run site)
  test-inference.ts      single-market inference smoke test
  setup-db.ts            docker Postgres + apply migration
  generate-master-mnemonic.ts
  test-e2e.ts            self-contained end-to-end suite (npm run test:e2e)
  verify-run.ts          reconcile a run across DB + chain
  probe-models.ts        per-model pre-flight + cost projection
  seed-providers.ts      load the OpenRouter provider catalog
  gen-synthetic-dataset.ts   production-shaped dataset for rehearsals
  republish.ts           re-submit forecasts that never reached the chain
src/
  llm.ts                 all OpenRouter inference + prompt building
  llm-fake.ts            deterministic offline stand-in for llm.ts
  forecast-registry-abi.ts
  forecast-registry-client.ts   batched on-chain submission
  db.ts                  all database access
  analysis.ts            noise statistics (pure, no I/O)
  providers.ts           OpenRouter provider slug <-> display name
  types.ts  utils.ts  logger.ts
tests/                   unit tests (node:test, run via npm test)
docker-compose.yml       local Postgres (development)
docker-compose.test.yml  throwaway Postgres (npm run test:e2e)
```

## License

MIT.
