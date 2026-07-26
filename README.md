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

# 3. Bring up Postgres and apply the schema
npm run db:setup          # docker compose up -d + apply migrations/01_init.sql
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

# Local dry-run without touching the chain
SKIP_ONCHAIN=true npm run benchmark -- --config configs/benchmark.example.json --dataset datasets/19-07-2026.json

# Resume an interrupted run (skips tasks already completed successfully)
npm run benchmark -- --config configs/benchmark.example.json --resume <benchmarkRunId>
```

On startup the benchmark: initializes a forecaster per model, derives/checks/funds
its wallet and records its model on-chain (new forecasters only), upserts the
dataset's events/markets, creates (or loads) the `benchmark_run` and its state,
then runs each model's tasks in parallel — persisting to the DB and submitting
batched forecasts on-chain as results come back. When a forecaster finishes, its
final batch is flushed immediately instead of waiting for the batch timeout.

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

| Table                                                              | Purpose                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `llm_model` / `llm_provider`                                       | Interned model slugs and routed provider names, referenced by id everywhere.            |
| `forecaster`                                                       | One LLM model; links to its wallet and to its `llm_model`.                              |
| `feature_key` / `feature_value` / `feature` / `forecaster_feature` | Generic key/value tags on forecasters (model, provider, …).                             |
| `wallet` / `wallet_predictor_derivation_index`                     | Derived on-chain identities and their BIP-44 indices.                                   |
| `transaction`                                                      | Interned on-chain tx hashes referenced by forecasts.                                    |
| `llm_trace`                                                        | One row per inference call: prompts, response, reasoning, tokens, cost, timing, errors. |
| `event` / `market`                                                 | Trimmed Polymarket event/market surface.                                                |
| `forecast`                                                         | The atomic data point: one row per `{run, forecaster, market, isNegated, iteration}`.   |
| `benchmark_run`                                                    | Run metadata (config, dataset, status, start/end).                                      |
| `benchmark_run_model`                                              | Which models a run benchmarks.                                                          |
| `benchmark_run_market`                                             | Which markets are in scope for a run.                                                   |
| `event_research`                                                   | The research context a run fed to the model for an event (`{run, event}` → blob).       |
| `benchmark_predictor_state`                                        | Per-forecaster progress within a run.                                                   |
| `benchmark_status` / `predictor_status`                            | Seeded lifecycle states for runs and per-forecaster progress.                           |

Research is deliberately **not** a column on `event`: it comes from the run's
dataset, so the same event benchmarked from a later dataset carries different
(fresher) context. It lives on `event_research`, keyed by `{benchmark_run, event}`.

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
src/
  llm.ts                 all OpenRouter inference + prompt building
  forecast-registry-abi.ts
  forecast-registry-client.ts   batched on-chain submission
  db.ts                  all database access
  types.ts  utils.ts  logger.ts
docker-compose.yml       local Postgres
```

## License

MIT.
