-- =============================================================================
-- noisebench — integrity constraints, chain provenance, missing indexes
-- =============================================================================
--
-- Everything here exists because the benchmark is about to run against Base
-- mainnet with real money, and the failure we cannot afford is the one that
-- writes WRONG data rather than no data. `verify-run.ts` already detects most
-- of those after the fact; this makes the worst of them impossible to insert in
-- the first place.
--
-- The centrepiece is the negation/outcome consistency check. A negated phrasing
-- IS that market's "No" — the mapping lives in `outcomeForPhrasing` and both
-- modalities go through it, so the two can never drift. But nothing enforced
-- that at the storage layer, which meant a single inverted branch anywhere
-- upstream would publish every forecast on the wrong side of every market while
-- passing every structural check in the verifier. Now the row simply cannot be
-- written.
--
-- CHECK constraints are added NOT VALID and validated separately, inside an
-- exception handler. New writes are enforced either way; a pre-existing row
-- from a dev run that violates one produces a WARNING naming the constraint
-- rather than aborting the migration.
--
-- Idempotent, so it can be applied to an already-migrated database.

BEGIN;

-- =============================================================================
-- Chain provenance
-- =============================================================================
--
-- Nothing in the schema recorded WHICH chain a transaction was published to.
-- Dev, testnet and mainnet runs share one database, and `benchmark_run.config`
-- holds the config file blob — which carries no CHAIN_ID either. So a row
-- published to a testnet was indistinguishable from one published to mainnet,
-- and the only way to tell them apart was the wall clock.
ALTER TABLE public.transaction
    ADD COLUMN IF NOT EXISTS chain_id INTEGER;

CREATE INDEX IF NOT EXISTS transaction_chain_id_idx
    ON public.transaction (chain_id);

-- =============================================================================
-- Outcome constraints
-- =============================================================================

DO $$
BEGIN
    -- The only two outcomes the contract and the parser know about.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_outcome_valid') THEN
        ALTER TABLE public.forecast
            ADD CONSTRAINT forecast_outcome_valid
            CHECK (outcome IN ('Yes', 'No')) NOT VALID;
    END IF;

    -- The inversion guard: base phrasing is the market's Yes, negated is its No.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_negation_outcome') THEN
        ALTER TABLE public.forecast
            ADD CONSTRAINT forecast_negation_outcome
            CHECK ((is_negated AND outcome = 'No') OR (NOT is_negated AND outcome = 'Yes')) NOT VALID;
    END IF;

    -- A forecast with no trace is a number nobody can account for. Safe to
    -- require now that the trace and the forecast are written in one
    -- transaction rather than as two independent statements.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_trace_present') THEN
        ALTER TABLE public.forecast
            ADD CONSTRAINT forecast_trace_present
            CHECK (llm_trace_id IS NOT NULL) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairwise_forecast_outcomes_valid') THEN
        ALTER TABLE public.pairwise_forecast
            ADD CONSTRAINT pairwise_forecast_outcomes_valid
            CHECK (outcome_a IN ('Yes', 'No') AND outcome_b IN ('Yes', 'No')) NOT VALID;
    END IF;

    -- Same guard as the direct side, applied independently to each side of the
    -- comparison. Checking them separately matters: the realistic bug applies
    -- the negation to one side only, and a combined check would still pass on
    -- the combination where both sides happen to agree.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairwise_forecast_negation_outcome') THEN
        ALTER TABLE public.pairwise_forecast
            ADD CONSTRAINT pairwise_forecast_negation_outcome
            CHECK (
                ((is_a_negated AND outcome_a = 'No') OR (NOT is_a_negated AND outcome_a = 'Yes'))
                AND
                ((is_b_negated AND outcome_b = 'No') OR (NOT is_b_negated AND outcome_b = 'Yes'))
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairwise_forecast_trace_present') THEN
        ALTER TABLE public.pairwise_forecast
            ADD CONSTRAINT pairwise_forecast_trace_present
            CHECK (llm_trace_id IS NOT NULL) NOT VALID;
    END IF;
END $$;

-- Validate what can be validated. A failure here means legacy rows violate the
-- constraint; the constraint still governs every new write, so this warns
-- loudly and moves on rather than blocking the migration.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS tbl
        FROM pg_constraint c
        WHERE c.contype = 'c'
          AND NOT c.convalidated
          AND c.conrelid IN ('public.forecast'::regclass, 'public.pairwise_forecast'::regclass)
    LOOP
        BEGIN
            EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
        EXCEPTION WHEN check_violation THEN
            RAISE WARNING
                'Constraint % on % could not be validated: existing rows violate it. '
                'It IS enforced for all new writes. Inspect those rows, then run: '
                'ALTER TABLE % VALIDATE CONSTRAINT %;',
                r.conname, r.tbl, r.tbl, r.conname;
        END;
    END LOOP;
END $$;

-- =============================================================================
-- Feature interning uniqueness
-- =============================================================================
--
-- `intern`-style inserts use ON CONFLICT DO NOTHING on these tables, but with
-- no unique constraint there is no conflict to detect, so the clause never
-- fires. Under 20 concurrent forecasters the read-then-insert races and both
-- writers land a row. Harmless to forecasts, but it grows without bound.
--
-- Only created when the table is already clean: de-duplicating means repointing
-- `feature` rows, which can itself collide on feature_uniq, and silently
-- rewriting a production table during a migration is worse than the duplicates.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.feature_key GROUP BY name HAVING COUNT(*) > 1) THEN
        RAISE WARNING 'feature_key holds duplicate names; skipping unique index. De-duplicate, then create feature_key_name_uniq manually.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS feature_key_name_uniq ON public.feature_key (name);
    END IF;

    IF EXISTS (SELECT 1 FROM public.feature_value GROUP BY name HAVING COUNT(*) > 1) THEN
        RAISE WARNING 'feature_value holds duplicate names; skipping unique index. De-duplicate, then create feature_value_name_uniq manually.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS feature_value_name_uniq ON public.feature_value (name);
    END IF;
END $$;

-- =============================================================================
-- Indexes for the reconciliation scans
-- =============================================================================
--
-- verify-run's silent-drop detector and republish's repair scan both filter on
-- exactly `benchmark_run_id = ? AND transaction_id IS NULL`, with no index to
-- support it. Partial, because the rows that matter are a small and shrinking
-- minority of a 100-market run.
CREATE INDEX IF NOT EXISTS forecast_unpublished_idx
    ON public.forecast (benchmark_run_id)
    WHERE transaction_id IS NULL;

CREATE INDEX IF NOT EXISTS pairwise_forecast_unpublished_idx
    ON public.pairwise_forecast (benchmark_run_id)
    WHERE transaction_id IS NULL;

-- --resume reads every successfully-parsed row for a run on startup, which on a
-- widened run is the whole table for that run.
CREATE INDEX IF NOT EXISTS forecast_resume_idx
    ON public.forecast (benchmark_run_id)
    WHERE parsed_odds IS NOT NULL;

CREATE INDEX IF NOT EXISTS pairwise_forecast_resume_idx
    ON public.pairwise_forecast (benchmark_run_id)
    WHERE is_a_likelier IS NOT NULL;

COMMIT;
