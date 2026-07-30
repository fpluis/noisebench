// Config normalization, task identity, and the chain-selection guards.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BASE_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  createForecastRegistryConfigFromEnv,
  forecasterNameFromModel,
  loadBenchmarkConfig,
  normalizeModel,
  parseArgs,
  resolveChainId,
} from "../src/utils";
import { taskKey } from "../src/db";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/llm";

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

test("loadBenchmarkConfig defaults both iteration dials", () => {
  // pairwiseIterations is separate from promptIterations because a pair already
  // costs four calls per iteration. A config written before the pairwise
  // modality existed must still load, and must get the documented default
  // rather than silently running zero pairwise tasks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noisebench-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ name: "legacy", models: ["a/b"] }),
    "utf8",
  );
  const config = loadBenchmarkConfig(file);
  assert.equal(config.promptIterations, 4);
  assert.equal(config.pairwiseIterations, 2);

  fs.writeFileSync(
    file,
    JSON.stringify({
      name: "explicit",
      models: ["a/b"],
      promptIterations: 6,
      pairwiseIterations: 3,
    }),
    "utf8",
  );
  const explicit = loadBenchmarkConfig(file);
  assert.equal(explicit.promptIterations, 6);
  assert.equal(explicit.pairwiseIterations, 3);
});

test("parseArgs handles the three supported flag forms", () => {
  assert.deepEqual(parseArgs(["--config", "a.json", "--negated"]), {
    config: "a.json",
    negated: true,
  });
  assert.deepEqual(parseArgs(["--dataset=b.json"]), { dataset: "b.json" });
  assert.deepEqual(parseArgs(["--resume", "42"]), { resume: "42" });
});

const promptFixture = () => ({
  event: {
    externalId: "1",
    title: "T",
    slug: "t",
    description: "event rules",
    markets: [],
    research: "RESEARCH",
  },
  market: {
    externalId: "2",
    slug: "m",
    question: "Will X happen?",
    negatedQuestion: "Will X fail to happen?",
  },
});

test("buildUserPrompt asks for the No outcome without rewriting the question", () => {
  // The bug this replaces: the "No" side substituted `negatedQuestion` while
  // the rules and research beside it still described the "Yes" outcome, so the
  // prompt contradicted itself — "Will X NOT happen?" above rules reading
  // "resolves Yes if X happens".
  const { event, market } = promptFixture();
  const base = buildUserPrompt(event, market, false);
  const negated = buildUserPrompt(event, market, true);

  assert.ok(base.includes("Will X happen?"));
  assert.ok(negated.includes("Will X happen?"));
  assert.ok(!negated.includes("Will X fail to happen?"));

  assert.ok(base.includes("Outcome you must forecast: Yes"));
  assert.ok(negated.includes("Outcome you must forecast: No"));
  assert.ok(base.includes('resolves to "Yes"'));
  assert.ok(negated.includes('resolves to "No"'));
});

test("only the requested outcome differs between the two sides", () => {
  // This is what makes |P(Yes) + P(No) - 1| a measurement rather than an
  // artifact: the two prompts must be identical apart from the outcome named.
  const { event, market } = promptFixture();
  const strip = (prompt: string): string =>
    prompt
      .replace(/(Outcome you must forecast: |resolves to ")(Yes|No)/g, "$1OUT")
      .replace(/Current timestamp: \S+/, "TIMESTAMP");

  assert.equal(
    strip(buildUserPrompt(event, market, false)),
    strip(buildUserPrompt(event, market, true)),
  );
});

test("buildUserPrompt never reads negatedQuestion", () => {
  // A dataset with no negation authored at all must produce the same prompt as
  // one that has it, since nothing consults the field.
  const { event, market } = promptFixture();
  const { negatedQuestion, ...without } = market;
  const strip = (p: string) => p.replace(/Current timestamp: \S+/, "T");
  for (const isNegated of [false, true]) {
    assert.equal(
      strip(buildUserPrompt(event, without, isNegated)),
      strip(buildUserPrompt(event, market, isNegated)),
    );
  }
});

test("the system prompt states that rules are never inverted for No", () => {
  // Without this the "No" request is ill-posed against Yes-shaped rules, and a
  // model's guess about which one is authoritative becomes noise we injected.
  assert.match(SYSTEM_PROMPT, /never rewritten or inverted/i);
  assert.match(SYSTEM_PROMPT, /does NOT resolve "Yes"/);
  assert.match(SYSTEM_PROMPT, /THE OUTCOME YOU WERE ASKED ABOUT/);
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
