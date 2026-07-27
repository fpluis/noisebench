// Config normalization, task identity, and the chain-selection guards.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  createForecastRegistryConfigFromEnv,
  forecasterNameFromModel,
  normalizeModel,
  parseArgs,
  resolveChainId,
} from "../src/utils";
import { taskKey } from "../src/db";
import { buildUserPrompt } from "../src/llm";

const CHAIN_ENV = [
  "CHAIN_ID",
  "ALLOW_MAINNET",
  "RPC_URLS",
  "BASE_RPC_URLS",
  "BASE_RPC_URL",
  "FORECAST_REGISTRY_ADDRESS",
];

beforeEach(() => {
  for (const key of CHAIN_ENV) delete process.env[key];
});

test("normalizeModel accepts a bare slug or a provider pin", () => {
  assert.deepEqual(normalizeModel("anthropic/claude-opus-4.8"), {
    slug: "anthropic/claude-opus-4.8",
  });
  assert.deepEqual(
    normalizeModel({ slug: "openai/gpt-5.6-luna", provider: "openai" }),
    { slug: "openai/gpt-5.6-luna", providerOrder: ["openai"] },
  );
  assert.deepEqual(normalizeModel({ slug: "x/y", provider: ["a", "b"] }), {
    slug: "x/y",
    providerOrder: ["a", "b"],
  });
});

test("forecasterNameFromModel is filesystem/identifier safe", () => {
  assert.equal(
    forecasterNameFromModel("openai/gpt-5.6-luna"),
    "openai-gpt-5.6-luna",
  );
  assert.equal(forecasterNameFromModel("a/b:free"), "a-b-free");
});

test("taskKey uniquely identifies one unit of work", () => {
  // --resume compares these strings against the DB, so base/negated and
  // successive iterations must never collide.
  assert.notEqual(taskKey(1, 2, false, 0), taskKey(1, 2, true, 0));
  assert.notEqual(taskKey(1, 2, false, 0), taskKey(1, 2, false, 1));
  assert.notEqual(taskKey(1, 2, false, 0), taskKey(2, 1, false, 0));
  assert.equal(taskKey(1, 2, true, 3), "1:2:1:3");
});

test("parseArgs handles the three supported flag forms", () => {
  assert.deepEqual(parseArgs(["--config", "a.json", "--negated"]), {
    config: "a.json",
    negated: true,
  });
  assert.deepEqual(parseArgs(["--dataset=b.json"]), { dataset: "b.json" });
  assert.deepEqual(parseArgs(["--resume", "42"]), { resume: "42" });
});

test("buildUserPrompt swaps in the negated phrasing", () => {
  const event = {
    externalId: "1",
    title: "T",
    slug: "t",
    description: "event rules",
    markets: [],
    research: "RESEARCH",
  };
  const market = {
    externalId: "2",
    slug: "m",
    question: "Will X happen?",
    negatedQuestion: "Will X fail to happen?",
  };

  const base = buildUserPrompt(event, market, false);
  const negated = buildUserPrompt(event, market, true);

  assert.ok(base.includes("Will X happen?"));
  assert.ok(negated.includes("Will X fail to happen?"));
  // Only the question differs — same rules, same research context, so the two
  // phrasings are genuinely comparable.
  assert.ok(base.includes("RESEARCH") && negated.includes("RESEARCH"));
  assert.ok(base.includes("event rules") && negated.includes("event rules"));
});

test("buildUserPrompt falls back to the base question without a negation", () => {
  const event = { externalId: "1", title: "T", slug: "t", markets: [] };
  const market = { externalId: "2", slug: "m", question: "Will X happen?" };
  assert.ok(buildUserPrompt(event, market, true).includes("Will X happen?"));
});

// ---------------------------------------------------------------------------
// Chain selection — the guards that keep a rehearsal off mainnet.
// ---------------------------------------------------------------------------

test("resolveChainId refuses Base mainnet without ALLOW_MAINNET", () => {
  assert.throws(() => resolveChainId(), /ALLOW_MAINNET/);
  process.env.CHAIN_ID = String(BASE_CHAIN_ID);
  assert.throws(() => resolveChainId(), /ALLOW_MAINNET/);
});

test("resolveChainId allows mainnet only when explicitly opted in", () => {
  process.env.CHAIN_ID = String(BASE_CHAIN_ID);
  process.env.ALLOW_MAINNET = "true";
  assert.equal(resolveChainId(), BASE_CHAIN_ID);
});

test("resolveChainId needs no ceremony for testnets or local chains", () => {
  process.env.CHAIN_ID = String(BASE_SEPOLIA_CHAIN_ID);
  assert.equal(resolveChainId(), BASE_SEPOLIA_CHAIN_ID);
  process.env.CHAIN_ID = "31337";
  assert.equal(resolveChainId(), 31337);
});

test("resolveChainId rejects a malformed CHAIN_ID", () => {
  process.env.CHAIN_ID = "not-a-number";
  assert.throws(() => resolveChainId(), /Invalid CHAIN_ID/);
});

test("mainnet RPC fallbacks never leak into a testnet rotation", () => {
  // The regression this exists for: public mainnet endpoints used to be
  // appended unconditionally, so one RPC hiccup during a Sepolia run rotated
  // onto mainnet and submitted for real.
  process.env.CHAIN_ID = String(BASE_SEPOLIA_CHAIN_ID);
  process.env.RPC_URLS = "https://sepolia.base.org";
  process.env.FORECAST_REGISTRY_ADDRESS =
    "0x0000000000000000000000000000000000000001";

  const config = createForecastRegistryConfigFromEnv();

  assert.equal(config.chainId, BASE_SEPOLIA_CHAIN_ID);
  assert.ok(config.rpcUrls.length > 0);
  for (const url of config.rpcUrls) {
    assert.ok(
      !url.includes("mainnet.base.org"),
      `mainnet endpoint ${url} leaked into a Sepolia rotation`,
    );
    assert.ok(url.includes("sepolia"), `${url} is not a Sepolia endpoint`);
  }
});

test("an unknown chain gets no public fallbacks at all", () => {
  // A local node must talk only to the URL it was given.
  process.env.CHAIN_ID = "31337";
  process.env.RPC_URLS = "http://127.0.0.1:8545";
  process.env.FORECAST_REGISTRY_ADDRESS =
    "0x0000000000000000000000000000000000000001";

  const config = createForecastRegistryConfigFromEnv();
  assert.deepEqual(config.rpcUrls, ["http://127.0.0.1:8545"]);
});

test("a chain with no configured and no known endpoints fails loudly", () => {
  process.env.CHAIN_ID = "31337";
  process.env.FORECAST_REGISTRY_ADDRESS =
    "0x0000000000000000000000000000000000000001";
  assert.throws(
    () => createForecastRegistryConfigFromEnv(),
    /No RPC endpoints/,
  );
});
