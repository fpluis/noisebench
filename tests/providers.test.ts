// Translating between OpenRouter's two provider identifiers.
//
// The regression these lock in: a config pins a provider by SLUG with a region
// shard ("google-vertex/global"), a completion reports a DISPLAY NAME
// ("Google"), and comparing the two strings directly reported every correctly
// pinned model as a violation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRef,
  checkProviderPin,
  parseProviderFile,
  providerBaseSlug,
  resolveProviderSlug,
} from "../src/providers";

// A slice of the real catalog.
const CATALOG: ProviderRef[] = [
  { slug: "google-vertex", name: "Google" },
  { slug: "google-ai-studio", name: "Google AI Studio" },
  { slug: "cerebras", name: "Cerebras" },
  { slug: "openai", name: "OpenAI" },
  { slug: "voyageai", name: "VoyageAI by MongoDB" },
];

test("providerBaseSlug strips the region shard", () => {
  assert.equal(providerBaseSlug("google-vertex/global"), "google-vertex");
  assert.equal(providerBaseSlug("azure/eastus"), "azure");
  assert.equal(providerBaseSlug("cerebras"), "cerebras");
});

test("resolveProviderSlug maps a display name to its slug", () => {
  assert.equal(resolveProviderSlug("Google", CATALOG), "google-vertex");
  assert.equal(
    resolveProviderSlug("Google AI Studio", CATALOG),
    "google-ai-studio",
  );
  assert.equal(resolveProviderSlug("VoyageAI by MongoDB", CATALOG), "voyageai");
});

test("resolveProviderSlug also accepts a slug, with or without a shard", () => {
  // OpenRouter is not consistent about which form it returns.
  assert.equal(resolveProviderSlug("google-vertex", CATALOG), "google-vertex");
  assert.equal(
    resolveProviderSlug("google-vertex/global", CATALOG),
    "google-vertex",
  );
});

test("resolveProviderSlug is case-insensitive", () => {
  assert.equal(resolveProviderSlug("google", CATALOG), "google-vertex");
  assert.equal(resolveProviderSlug("CEREBRAS", CATALOG), "cerebras");
});

test("resolveProviderSlug returns null for an unknown provider", () => {
  assert.equal(resolveProviderSlug("Some New Provider", CATALOG), null);
  assert.equal(resolveProviderSlug(undefined, CATALOG), null);
  assert.equal(resolveProviderSlug("", CATALOG), null);
});

test("REGRESSION: a pin honored via a display name is not a violation", () => {
  // The exact reported case: pinned "google-vertex/global", routed to "Google".
  const { verdict, resolvedSlug } = checkProviderPin(
    ["google-vertex/global"],
    "Google",
    CATALOG,
  );
  assert.equal(verdict, "honored");
  assert.equal(resolvedSlug, "google-vertex");
});

test("a genuinely violated pin is still caught", () => {
  // Pinned to Vertex, routed to AI Studio — a different backend, and exactly
  // the drift the check exists to detect.
  const { verdict, resolvedSlug } = checkProviderPin(
    ["google-vertex/global"],
    "Google AI Studio",
    CATALOG,
  );
  assert.equal(verdict, "violated");
  assert.equal(resolvedSlug, "google-ai-studio");
});

test("any provider in the pinned order satisfies the pin", () => {
  assert.equal(
    checkProviderPin(["openai", "cerebras"], "Cerebras", CATALOG).verdict,
    "honored",
  );
});

test("an unknown provider is unverifiable, never a violation", () => {
  // Reporting a catalog gap as a failure is the false alarm being fixed.
  assert.equal(
    checkProviderPin(["google-vertex"], "Brand New Provider", CATALOG).verdict,
    "unverifiable",
  );
  assert.equal(
    checkProviderPin(["google-vertex"], "Google", []).verdict,
    "unverifiable",
  );
});

test("no pin means nothing to verify", () => {
  assert.equal(
    checkProviderPin(undefined, "Google", CATALOG).verdict,
    "unverifiable",
  );
  assert.equal(checkProviderPin([], "Google", CATALOG).verdict, "unverifiable");
});

// ---------------------------------------------------------------------------
// Parsing the catalog file
// ---------------------------------------------------------------------------

test("parseProviderFile accepts the API envelope and a bare array", () => {
  const entries = [
    { slug: "a", name: "A" },
    { slug: "b", name: "B" },
  ];
  assert.deepEqual(parseProviderFile({ data: entries }), entries);
  assert.deepEqual(parseProviderFile(entries), entries);
});

test("parseProviderFile ignores rows missing a slug or name", () => {
  const parsed = parseProviderFile({
    data: [
      { slug: "a", name: "A" },
      { slug: "b" },
      { name: "C" },
      { slug: "d", name: "D", extra_field: 1 },
    ],
  });
  assert.deepEqual(parsed, [
    { slug: "a", name: "A" },
    { slug: "d", name: "D" },
  ]);
});

test("parseProviderFile rejects input with nothing usable", () => {
  assert.throws(() => parseProviderFile({ data: [] }), /array/);
  assert.throws(() => parseProviderFile({ data: [{ slug: "a" }] }), /usable/);
});
