-- =============================================================================
-- noisebench — initial schema
-- =============================================================================

-- Terminology: a "forecaster" is one LLM model configured in a benchmark run.
-- Each forecaster owns a wallet (derived from the master mnemonic) and every
-- forecast it makes is recorded on-chain from that wallet.

BEGIN;

-- =============================================================================
-- LLM models + providers (interned once, referenced by id everywhere)
-- =============================================================================

-- One row per OpenRouter model slug (e.g. "anthropic/claude-opus-4.8").
CREATE TABLE public.llm_model (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT llm_model_name_unique UNIQUE (name)
);

-- One row per backend OpenRouter can route to (e.g. "anthropic", "fireworks").
CREATE TABLE public.llm_provider (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT llm_provider_name_unique UNIQUE (name)
);

-- =============================================================================
-- Forecasters + their features (model, etc.)
-- =============================================================================

-- A forecaster is a single LLM model participating in benchmarks. `wallet_id`
-- links to the on-chain identity; the FK is added after `wallet` is defined.
CREATE TABLE public.forecaster (
    id                   SERIAL PRIMARY KEY,
    name                 TEXT NOT NULL,
    forecasting_model_id INTEGER NOT NULL REFERENCES public.llm_model(id),
    wallet_id            INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT forecaster_name_unique UNIQUE (name),
    CONSTRAINT forecaster_wallet_id_unique UNIQUE (wallet_id)
);

-- Generic key/value feature system: `feature_key` x `feature_value` are interned
-- once, combined into a `feature`, and attached to forecasters via
-- `forecaster_feature`. Lets us tag/query forecasters by model, provider, etc.
CREATE TABLE public.feature_key (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.feature_value (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.feature (
    id               SERIAL PRIMARY KEY,
    feature_key_id   INTEGER NOT NULL REFERENCES public.feature_key(id),
    feature_value_id INTEGER NOT NULL REFERENCES public.feature_value(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT feature_uniq UNIQUE (feature_key_id, feature_value_id)
);

CREATE TABLE public.forecaster_feature (
    id            SERIAL PRIMARY KEY,
    forecaster_id INTEGER NOT NULL REFERENCES public.forecaster(id),
    feature_id    INTEGER NOT NULL REFERENCES public.feature(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT forecaster_feature_uniq UNIQUE (forecaster_id, feature_id)
);

-- =============================================================================
-- Wallets + on-chain bookkeeping
-- =============================================================================

CREATE TABLE public.wallet (
    id          SERIAL PRIMARY KEY,
    address     CHAR(42) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wallet_address_length CHECK (char_length(address) = 42),
    CONSTRAINT wallet_address_prefix CHECK (LEFT(address::TEXT, 2) = '0x'::TEXT),
    CONSTRAINT wallet_address_unique UNIQUE (address)
);

ALTER TABLE public.forecaster
    ADD CONSTRAINT forecaster_wallet_id_fkey
    FOREIGN KEY (wallet_id) REFERENCES public.wallet(id);

-- Records which BIP-44 derivation index (m/44'/60'/0'/0/{index}) produced a
-- given wallet for a given forecaster, so wallets can be re-derived from the
-- master mnemonic without storing private keys.
CREATE TABLE public.wallet_predictor_derivation_index (
    wallet_id        INTEGER NOT NULL REFERENCES public.wallet(id),
    predictor_id     INTEGER NOT NULL REFERENCES public.forecaster(id),
    derivation_index INTEGER NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet_id, predictor_id),
    CONSTRAINT wallet_predictor_derivation_index_unique UNIQUE (derivation_index)
);

-- Interned on-chain transaction hashes referenced by forecasts.
CREATE TABLE public.transaction (
    id         SERIAL PRIMARY KEY,
    hash       TEXT NOT NULL UNIQUE,
    -- On-chain block/timestamp of the tx, filled once confirmed.
    block_number BIGINT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- LLM traces — one row per completed inference call to OpenRouter
-- =============================================================================
--
-- Captures everything we get back from a single call so a run is fully
-- reproducible/auditable: the exact prompts, the raw response and reasoning, the
-- token accounting, the resolved provider, cost, wall-clock time, and the
-- collected error payloads from any retries.
CREATE TABLE public.llm_trace (
    id               SERIAL PRIMARY KEY,
    forecaster_id    INTEGER REFERENCES public.forecaster(id),
    llm_model_id     INTEGER NOT NULL REFERENCES public.llm_model(id),
    -- The provider OpenRouter actually routed to (completion.provider).
    llm_provider_id  INTEGER REFERENCES public.llm_provider(id),
    identifier       TEXT,
    system_prompt    TEXT,
    prompt           TEXT,
    response         TEXT,
    reasoning        TEXT,
    finish_reason    TEXT,
    -- Cost in nano-USD (round(usd * 1e9)); null when the provider returns none.
    cost             BIGINT,
    tokens_in        INTEGER,
    tokens_out       INTEGER,
    reasoning_tokens INTEGER,
    -- Wall-clock time of the successful call, in milliseconds.
    time_ms          INTEGER,
    -- Number of attempts made (1 = succeeded first try).
    attempts         INTEGER NOT NULL DEFAULT 1,
    -- Array of { code, message } payloads for every failed attempt/refusal.
    errors           JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Full usage blob + call parameters for anything not broken out above.
    usage            JSONB,
    metadata         JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Events + markets (limited surface vs. a full Polymarket payload)
-- =============================================================================

CREATE TABLE public.event (
    id          SERIAL PRIMARY KEY,
    platform_id INTEGER NOT NULL DEFAULT 1,
    external_id TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    slug        TEXT NOT NULL,
    is_neg_risk BOOLEAN NOT NULL DEFAULT FALSE,
    start_date  TIMESTAMPTZ,
    end_date    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT event_external_id_unique UNIQUE (external_id, platform_id)
);

CREATE TABLE public.market (
    id               SERIAL PRIMARY KEY,
    event_id         INTEGER NOT NULL REFERENCES public.event(id),
    platform_id      INTEGER NOT NULL DEFAULT 1,
    external_id      TEXT NOT NULL,
    slug             TEXT NOT NULL,
    question         TEXT NOT NULL,
    negated_question TEXT,
    description      TEXT NOT NULL DEFAULT '',
    start_date       TIMESTAMPTZ,
    end_date         TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT market_external_id_unique UNIQUE (external_id, platform_id)
);

-- =============================================================================
-- Benchmark runs
-- =============================================================================

-- Closed set of run/forecaster lifecycle states, seeded below.
CREATE TABLE public.benchmark_status (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT benchmark_status_name_unique UNIQUE (name)
);

CREATE TABLE public.predictor_status (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT predictor_status_name_unique UNIQUE (name)
);

INSERT INTO public.benchmark_status (name)
VALUES ('running'), ('completed'), ('failed');

INSERT INTO public.predictor_status (name)
VALUES ('pending'), ('running'), ('completed'), ('failed');

CREATE TABLE public.benchmark_run (
    id               SERIAL PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT,
    dataset_name     TEXT NOT NULL,
    prompt_iterations INTEGER NOT NULL,
    -- The full config blob, copied from the config file so a run is
    -- self-describing even if the file later changes. The models themselves are
    -- normalized into `benchmark_run_model`.
    config           JSONB NOT NULL,
    status_id        INTEGER NOT NULL REFERENCES public.benchmark_status(id),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which models a run benchmarks.
CREATE TABLE public.benchmark_run_model (
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    llm_model_id     INTEGER NOT NULL REFERENCES public.llm_model(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (benchmark_run_id, llm_model_id)
);

-- Which markets are in scope for a run.
CREATE TABLE public.benchmark_run_market (
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    market_id        INTEGER NOT NULL REFERENCES public.market(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (benchmark_run_id, market_id)
);

-- The pre-gathered research blob fed to the model as context for an event.
-- Research is a property of the {run, event} pair rather than of the event
-- itself: it comes from the run's dataset, so the same event benchmarked from a
-- later dataset carries different (fresher) context.
CREATE TABLE public.event_research (
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    event_id         INTEGER NOT NULL REFERENCES public.event(id),
    research         TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (benchmark_run_id, event_id)
);

-- Coarse per-forecaster progress for a run. Fine-grained "which tasks are done"
-- is derivable from the `forecast` table (one row per completed task), which is
-- what --resume actually consults; this row is a fast progress summary.
CREATE TABLE public.benchmark_predictor_state (
    id               SERIAL PRIMARY KEY,
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    forecaster_id    INTEGER NOT NULL REFERENCES public.forecaster(id),
    status_id        INTEGER NOT NULL REFERENCES public.predictor_status(id),
    total_tasks      INTEGER NOT NULL DEFAULT 0,
    completed_tasks  INTEGER NOT NULL DEFAULT 0,
    error_count      INTEGER NOT NULL DEFAULT 0,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT benchmark_predictor_state_uniq UNIQUE (benchmark_run_id, forecaster_id)
);

-- =============================================================================
-- Forecasts — one row per {run, forecaster, market, isNegated, iteration}
-- =============================================================================
--
-- The atomic unit of the benchmark. `parsed_odds` is the probability (0..1) the
-- model assigned to the reference outcome of the presented (possibly negated)
-- question; it is null when parsing failed after all retries. `outcome` is the
-- outcome recorded on-chain: "Yes" for the base question, "No" for the negated
-- one (negated-Yes is logically the market's "No"), so a coherent model's Yes
-- and No odds for a market sum to ~1.
CREATE TABLE public.forecast (
    id               SERIAL PRIMARY KEY,
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    forecaster_id    INTEGER NOT NULL REFERENCES public.forecaster(id),
    event_id         INTEGER NOT NULL REFERENCES public.event(id),
    market_id        INTEGER NOT NULL REFERENCES public.market(id),
    llm_trace_id     INTEGER REFERENCES public.llm_trace(id),
    is_negated       BOOLEAN NOT NULL,
    prompt_iteration INTEGER NOT NULL,
    parsed_odds      NUMERIC CHECK (parsed_odds IS NULL OR (parsed_odds >= 0 AND parsed_odds <= 1)),
    outcome          TEXT NOT NULL,
    -- On-chain linkage, filled once the batch containing this forecast confirms.
    transaction_id   INTEGER REFERENCES public.transaction(id),
    published_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT forecast_task_uniq
        UNIQUE (benchmark_run_id, forecaster_id, market_id, is_negated, prompt_iteration)
);

CREATE INDEX forecast_run_forecaster_idx
    ON public.forecast (benchmark_run_id, forecaster_id);
CREATE INDEX forecast_market_idx ON public.forecast (market_id);
CREATE INDEX llm_trace_forecaster_idx ON public.llm_trace (forecaster_id);

COMMIT;
