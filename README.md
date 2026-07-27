# noisebench

An open benchmark that measures the **forecasting noise** of LLMs on
[Polymarket](https://polymarket.com) markets.

For each market we prompt a model repeatedly on both the market's real
`question` **and** its logical `negatedQuestion`. A perfectly coherent forecaster
would assign complementary probabilities to the two phrasings (`P(Yes) + P(Yes on
the negation) ≈ 1`) and would return the same answer every time. Real models
don't — they drift between repetitions and contradict themselves between a
question and its negation. That gap is the noise this benchmark quantifies.

Every forecast is:

- **produced** through [OpenRouter](https://openrouter.ai) with pinned,
  reproducible sampling parameters,
- **persisted** to PostgreSQL with the full trace (prompts, raw response,
  reasoning, tokens, cost, timing, and any error/refusal payloads), and
- **recorded on-chain** to the [`ForecastRegistry`](../forecast-registry)
  contract on [Base](https://base.org), one wallet per model, so the record is
  tamper-evident and independently auditable.

## How it works

The benchmark runs over a **dataset** of `M` events, each with `N` markets. For
every combination of

```
{ event, market } × model × { base, negated } × iteration (T = 4)
```

it calls the model once, parses the probability off the end of the plain-text
answer (`Probability: X%`), and writes one `forecast` row. The unit of work is a
single market — there is no cross-market/event aggregation.

### Prompt structure

- **System prompt** — the generic task framing, resolution conventions, and the
  required `Probability: X%` output format. See `SYSTEM_PROMPT` in
  [`src/llm.ts`](src/llm.ts).
- **User prompt** — the specifics of the one market being forecast (title,
  question or negated question, rules, dates, and the event's research context).

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
visible directly in the event log. Each forecaster wallet also records its model
on-chain once via `setAttribute("forecastingModel", <slug>)` /
`setAttribute("researchModel", "local-research-v1")` before it starts.

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

Runs one market through one model and prints everything captured — no DB, no
chain, only `OPENROUTER_API_KEY`:

```bash
npm run test-inference -- \
  --dataset datasets/19-07-2026.json \
  --config configs/benchmark.example.json \
  [--event <event-slug>] [--model <openrouter-slug>] [--negated]
```

`--event` defaults to the first event, `--model` to the first configured model,
and the first market of the event is used.

### Run the benchmark

```bash
# Fresh run
npm run benchmark -- --config configs/benchmark.example.json --dataset datasets/19-07-2026.json

# Local dry-run without touching the chain — set SKIP_ONCHAIN=true in .env
npm run benchmark -- --config configs/benchmark.example.json --dataset datasets/19-07-2026.json

# Resume an interrupted run (skips tasks already completed successfully)
npm run benchmark -- --config configs/benchmark.example.json --resume <benchmarkRunId>
```

Set options in `.env` rather than as command-line prefixes: `VAR=value cmd` is
bash-only, and does nothing on PowerShell.

On startup the benchmark: initializes a forecaster per model, derives its wallet,
funds it if it is below `THRESHOLD_BALANCE`, then declares its model on-chain if
the chain does not already show that claim, upserts the
dataset's events/markets, creates (or loads) the `benchmark_run` and its state,
then runs each model's tasks in parallel — persisting to the DB and submitting
batched forecasts on-chain as results come back. When a forecaster finishes, its
final batch is flushed immediately instead of waiting for the batch timeout.

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
4. Generate the synthetic dataset        → 20 models x 100 markets x 2 x 4
5. Benchmark run (fake, no chain)        → ~10 seconds
6. Verify run
7. Resume run
```

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
16,000 forecasts survive the whole orchestration — every DB mapping, 120-way
concurrency, progress bookkeeping, and the resume path — at production volume.

**What it does not prove:** anything on-chain. Submission is skipped entirely.

### On-chain validation

Not covered by the suite. Validate it with a **small real run** — a handful of
markets and one or two cheap models against the real registry — then reconcile
with the same tool the suite uses:

```bash
npm run benchmark -- --config configs/benchmark.smoke.json --dataset <small dataset>
npx tsx scripts/verify-run.ts --run <id> --onchain
```

Check **C** is the one to watch: it reports usable forecasts that never reached
the chain. Two things to confirm on that run, because neither can be observed
offline: the gas a full `recordForecastBatch` actually costs, which is what
`THRESHOLD_BALANCE` must cover for every batch a wallet will submit, and that
each wallet declared its model (check **E3**).

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

`verify-run.ts` is the check that matters. Structural checks confirm the
plumbing; check **F** confirms the _meaning_ — for every
`{forecaster, market, iteration}` it asserts both phrasings exist and reports
`mean |Yes + No − 1|`. That number **is** the noise metric, and if the
base/negated → Yes/No mapping ever inverts it jumps from ~0.1 to ~1.0 while
every structural check still passes.

The fake is deliberately hostile: it injects unparseable responses, hard
failures, null costs, 100 KB reasoning blobs and non-ASCII text at fixed rates,
so a rehearsal exercises the failure paths rather than only the happy one. It is
also deterministic, which is what makes the resume leg meaningful — the same
tasks fail again, and the row count must not move.

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
(`datasets/DD-MM-YYYY.json`), containing an array of events:

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

See [`datasets/19-07-2026.json`](datasets/19-07-2026.json) for a complete example.

## Benchmark config

A JSON file (see [`configs/benchmark.example.json`](configs/benchmark.example.json)):

```jsonc
{
  "name": "noisebench-19-07-2026",
  "description": "…",
  "dataset": "datasets/19-07-2026.json", // optional; --dataset on the CLI wins
  "models": [
    { "slug": "openai/gpt-5.6-luna", "provider": "openai" }, // pin the provider
    "anthropic/claude-opus-4.8", // or a bare slug
  ],
  "promptIterations": 4, // repetitions per model per phrasing
  "concurrency": 6, // max concurrent inference calls per forecaster
}
```

## Database schema

One migration ([`migrations/01_init.sql`](migrations/01_init.sql)):

| Table                                                              | Purpose                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `llm_model` / `llm_provider`                                       | Interned model slugs and providers (`slug` + display `name`), referenced by id everywhere. |
| `schema_migration`                                                 | Which migrations have been applied, so a new one reaches an existing database.             |
| `forecaster`                                                       | One LLM model; links to its wallet and to its `llm_model`.                                 |
| `feature_key` / `feature_value` / `feature` / `forecaster_feature` | Generic key/value tags on forecasters (model, provider, …).                                |
| `wallet` / `wallet_predictor_derivation_index`                     | Derived on-chain identities and their BIP-44 indices.                                      |
| `transaction`                                                      | Interned on-chain tx hashes referenced by forecasts.                                       |
| `llm_trace`                                                        | One row per inference call: prompts, response, reasoning, tokens, cost, timing, errors.    |
| `event` / `market`                                                 | Trimmed Polymarket event/market surface.                                                   |
| `forecast`                                                         | The atomic data point: one row per `{run, forecaster, market, isNegated, iteration}`.      |
| `benchmark_run`                                                    | Run metadata (config, dataset, status, start/end).                                         |
| `benchmark_run_model`                                              | Which models a run benchmarks.                                                             |
| `benchmark_run_market`                                             | Which markets are in scope for a run.                                                      |
| `event_research`                                                   | The research context a run fed to the model for an event (`{run, event}` → blob).          |
| `benchmark_predictor_state`                                        | Per-forecaster progress within a run.                                                      |
| `benchmark_status` / `predictor_status`                            | Seeded lifecycle states for runs and per-forecaster progress.                              |

Research is deliberately **not** a column on `event`: it comes from the run's
dataset, so the same event benchmarked from a later dataset carries different
(fresher) context. It lives on `event_research`, keyed by `{benchmark_run, event}`.

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
datasets/                dated dataset files (DD-MM-YYYY.json)
migrations/01_init.sql   the schema
scripts/
  benchmark.ts           main entry point (fresh run / --resume)
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
  providers.ts           OpenRouter provider slug <-> display name
  types.ts  utils.ts  logger.ts
tests/                   unit tests (node:test, run via npm test)
docker-compose.yml       local Postgres (development)
docker-compose.test.yml  throwaway Postgres (npm run test:e2e)
```

## License

MIT.
