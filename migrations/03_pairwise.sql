-- =============================================================================
-- noisebench — pairwise rank forecasts
-- =============================================================================
--
-- A second modality alongside the direct probability assessment: instead of
-- asking how likely one market is, ask which of TWO markets is likelier, with
-- no probability attached to either.
--
-- Every pair is asked in all four phrasing combinations — (A, B), (¬A, B),
-- (A, ¬B), (¬A, ¬B) — because flipping BOTH sides must invert the answer for
-- any coherent forecaster: P(A) > P(B) iff 1-P(A) < 1-P(B). That identity holds
-- whatever the model believes, so the rate at which it is violated is a noise
-- measurement rather than an accuracy judgment, exactly as |Yes + No - 1| is on
-- the direct side.
--
-- Idempotent, so it can be applied to an already-migrated database.

BEGIN;

-- Pairs are repeated fewer times than direct prompts (each pair already costs
-- four calls per iteration), so the run records its own dial rather than
-- reusing prompt_iterations.
ALTER TABLE public.benchmark_run
    ADD COLUMN IF NOT EXISTS pairwise_iterations INTEGER NOT NULL DEFAULT 0;

-- Which pairs are in scope for a run, mirroring `benchmark_run_market`.
-- Ordered: (A, B) and (B, A) are different tasks, since the four combinations
-- always present market A first and only an explicit reversed pair probes
-- position bias.
CREATE TABLE IF NOT EXISTS public.benchmark_run_pair (
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    market_a_id      INTEGER NOT NULL REFERENCES public.market(id),
    market_b_id      INTEGER NOT NULL REFERENCES public.market(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (benchmark_run_id, market_a_id, market_b_id),
    CONSTRAINT benchmark_run_pair_distinct CHECK (market_a_id <> market_b_id)
);

-- =============================================================================
-- The atomic pairwise data point
-- =============================================================================
--
-- One row per {run, forecaster, ordered pair, phrasing combination, iteration}.
--
-- `is_a_likelier` is the judgment: true when the model picked the side derived
-- from market A. It is NULL when no usable choice came back after all retries —
-- including when the model insisted the two were equally likely, which the
-- registry deliberately cannot represent.
--
-- `outcome_a` / `outcome_b` are what was published on-chain for each side:
-- "Yes" for a side asked in its base phrasing, "No" for one asked negated,
-- since the negated question resolving Yes IS that market's No. They are stored
-- rather than derived so the on-chain log can be reconciled against the DB
-- without re-deriving the mapping — a re-derivation that could itself be the
-- thing that broke.
CREATE TABLE IF NOT EXISTS public.pairwise_forecast (
    id               SERIAL PRIMARY KEY,
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    forecaster_id    INTEGER NOT NULL REFERENCES public.forecaster(id),
    market_a_id      INTEGER NOT NULL REFERENCES public.market(id),
    market_b_id      INTEGER NOT NULL REFERENCES public.market(id),
    llm_trace_id     INTEGER REFERENCES public.llm_trace(id),
    is_a_negated     BOOLEAN NOT NULL,
    is_b_negated     BOOLEAN NOT NULL,
    prompt_iteration INTEGER NOT NULL,
    is_a_likelier    BOOLEAN,
    outcome_a        TEXT NOT NULL,
    outcome_b        TEXT NOT NULL,
    -- On-chain linkage, filled once the batch containing this row confirms.
    transaction_id   INTEGER REFERENCES public.transaction(id),
    published_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pairwise_forecast_task_uniq
        UNIQUE (benchmark_run_id, forecaster_id, market_a_id, market_b_id,
                is_a_negated, is_b_negated, prompt_iteration),
    -- The contract reverts with IdenticalMarkets on a self-comparison; catch it
    -- here rather than by burning gas to discover it.
    CONSTRAINT pairwise_forecast_distinct_markets CHECK (market_a_id <> market_b_id)
);

CREATE INDEX IF NOT EXISTS pairwise_forecast_run_forecaster_idx
    ON public.pairwise_forecast (benchmark_run_id, forecaster_id);
CREATE INDEX IF NOT EXISTS pairwise_forecast_markets_idx
    ON public.pairwise_forecast (market_a_id, market_b_id);

COMMIT;
