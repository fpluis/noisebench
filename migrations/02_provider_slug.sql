-- =============================================================================
-- noisebench — provider slugs
-- =============================================================================
--
-- OpenRouter identifies a provider two different ways, and the benchmark meets
-- both:
--
--   * a config pins routing by SLUG      ("google-vertex", optionally with a
--     region shard suffix such as "google-vertex/global");
--   * a completion reports what it routed to by DISPLAY NAME ("Google").
--
-- Comparing one against the other reports a mismatch where none exists, so the
-- catalog of {slug, name} pairs is stored here (seeded from providers.json) and
-- used to translate between them.
--
-- Idempotent, so it can be applied to an already-migrated database.

BEGIN;

ALTER TABLE public.llm_provider
    ADD COLUMN IF NOT EXISTS slug TEXT;

-- Nullable-unique: a provider first seen in a completion is interned by name
-- alone and only acquires its slug when the catalog is seeded. Postgres unique
-- indexes ignore NULLs, so unseeded rows do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS llm_provider_slug_unique
    ON public.llm_provider (slug)
    WHERE slug IS NOT NULL;

COMMIT;
