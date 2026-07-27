// Translating between the two ways OpenRouter identifies a provider.
//
// A benchmark config pins routing by SLUG, optionally with a region shard
// suffix:
//
//     { "slug": "google/gemini-3.5-flash-lite", "provider": "google-vertex/global" }
//
// but a completion reports what it actually routed to by DISPLAY NAME:
//
//     completion.provider === "Google"
//
// Comparing those two strings directly reports a mismatch for every correctly
// pinned model. The catalog in the `llm_provider` table (seeded from
// providers.json) is what makes them comparable.

export interface ProviderRef {
  slug: string;
  name: string;
}

interface ProviderFileEntry {
  slug?: string;
  name?: string;
}

/**
 * Parse the OpenRouter provider listing
 * (https://openrouter.ai/api/v1/providers), accepting either the raw
 * `{ "data": [...] }` envelope or a bare array.
 */
export const parseProviderFile = (raw: unknown): ProviderRef[] => {
  const entries: ProviderFileEntry[] = Array.isArray(raw)
    ? raw
    : ((raw as { data?: ProviderFileEntry[] })?.data ?? []);

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      "Provider file must be a JSON array, or an object with a `data` array",
    );
  }

  const providers: ProviderRef[] = [];
  for (const entry of entries) {
    // Skip rather than fail: the endpoint carries fields we do not model, and
    // one malformed row should not block seeding the rest.
    if (!entry?.slug || !entry?.name) continue;
    providers.push({ slug: String(entry.slug), name: String(entry.name) });
  }
  if (providers.length === 0) {
    throw new Error("Provider file contained no usable {slug, name} entries");
  }
  return providers;
};

/**
 * Strip the region shard from a pinned provider.
 *
 * OpenRouter accepts `<slug>/<shard>` (e.g. "google-vertex/global",
 * "azure/eastus") to pin a specific deployment of a provider. No slug in the
 * catalog contains a slash, so everything from the first one on is the shard.
 */
export const providerBaseSlug = (pinned: string): string =>
  pinned.split("/")[0].trim();

/**
 * Resolve whatever a completion reported into a catalog slug.
 *
 * Accepts a display name ("Google"), a slug ("google-vertex"), or a slug with a
 * region shard, and matches case-insensitively — OpenRouter is not consistent
 * about which form it returns, and it is not worth a false alarm to assume.
 *
 * Returns null when the value is not in the catalog, which must be reported as
 * "cannot verify" rather than as a mismatch.
 */
export const resolveProviderSlug = (
  reported: string | undefined | null,
  catalog: ProviderRef[],
): string | null => {
  if (!reported) return null;
  const needle = reported.trim().toLowerCase();
  const bare = providerBaseSlug(reported).toLowerCase();

  for (const p of catalog) {
    if (p.name.toLowerCase() === needle) return p.slug;
    if (p.slug.toLowerCase() === needle) return p.slug;
    if (p.slug.toLowerCase() === bare) return p.slug;
  }
  return null;
};

/**
 * Whether a completion's reported provider satisfies the configured pin.
 *
 * `pinnedOrder` is the config's provider list, each entry possibly carrying a
 * region shard. The comparison is on catalog slugs, so the pin is honored when
 * the routed provider is any of the pinned ones.
 *
 * The three outcomes are deliberately distinct: an unknown provider is NOT a
 * mismatch, it is a gap in the catalog, and reporting it as a failure is the
 * false alarm this module exists to prevent.
 */
export type PinVerdict = "honored" | "violated" | "unverifiable";

export const checkProviderPin = (
  pinnedOrder: string[] | undefined,
  reported: string | undefined | null,
  catalog: ProviderRef[],
): { verdict: PinVerdict; resolvedSlug: string | null } => {
  const resolvedSlug = resolveProviderSlug(reported, catalog);
  if (!pinnedOrder || pinnedOrder.length === 0) {
    return { verdict: "unverifiable", resolvedSlug };
  }
  if (!reported) return { verdict: "unverifiable", resolvedSlug };
  if (!resolvedSlug) return { verdict: "unverifiable", resolvedSlug };

  const pinnedSlugs = pinnedOrder.map((p) => providerBaseSlug(p).toLowerCase());
  return {
    verdict: pinnedSlugs.includes(resolvedSlug.toLowerCase())
      ? "honored"
      : "violated",
    resolvedSlug,
  };
};
