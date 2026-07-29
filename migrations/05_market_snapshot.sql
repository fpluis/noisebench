-- =============================================================================
-- noisebench — orderbook snapshot per {run, market}
-- =============================================================================
--
-- The dataset carries the Polymarket orderbook state at the moment the dataset
-- was prepared — `midpoint`, `spread`, `yesLiquidity`, `noLiquidity`,
-- `orderbookSnapshotAt` — and nothing in the schema stored any of it. The run
-- finished, the numbers stayed in the JSON file, and every analysis that wants
-- to ask "where did the models land relative to what the crowd thought" had to
-- re-open the dataset and join on slug.
--
-- Run-scoped rather than a column on `market`, for the same reason
-- `event_research` is run-scoped: the price is a property of WHEN the dataset
-- was prepared, not of the market. Benchmark the same market from a dataset cut
-- a month later and the midpoint is different; a column on `market` would let
-- the second run silently overwrite the first run's baseline and quietly
-- invalidate its published analysis.
--
-- The midpoint is a snapshot INPUT — what the market thought at prompt time,
-- alongside the research blob. It is not an outcome and carries no information
-- about how the market resolved. Nothing here scores a forecast.
--
-- Idempotent, so it can be applied to an already-migrated database.

BEGIN;

CREATE TABLE IF NOT EXISTS public.benchmark_run_market_snapshot (
    benchmark_run_id INTEGER NOT NULL REFERENCES public.benchmark_run(id) ON DELETE CASCADE,
    market_id        INTEGER NOT NULL REFERENCES public.market(id),
    -- Orderbook midpoint in [0,1], the crowd's implied P(Yes) at snapshot time.
    midpoint         NUMERIC,
    spread           NUMERIC,
    yes_liquidity    NUMERIC,
    no_liquidity     NUMERIC,
    -- When the orderbook was read (dataset `orderbookSnapshotAt`), which is not
    -- the same instant the run started.
    snapshot_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (benchmark_run_id, market_id),
    CONSTRAINT snapshot_midpoint_range
        CHECK (midpoint IS NULL OR (midpoint >= 0 AND midpoint <= 1)),
    CONSTRAINT snapshot_spread_range
        CHECK (spread IS NULL OR (spread >= 0 AND spread <= 1))
);

COMMIT;
