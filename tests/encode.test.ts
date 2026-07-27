// On-chain encoding. These values are written to an append-only public log, so
// a rounding or clamping change is not recoverable after the fact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { attributeKey, toBasisPoints } from "../src/forecast-registry-abi";
import { parseForecastProbability } from "../src/utils";

test("toBasisPoints converts probability to basis points", () => {
  assert.equal(toBasisPoints(0), 0);
  assert.equal(toBasisPoints(1), 10000);
  assert.equal(toBasisPoints(0.725), 7250);
  assert.equal(toBasisPoints(0.0001), 1);
});

test("toBasisPoints rounds to nearest, and clamps to the contract's range", () => {
  // ForecastRegistry reverts with OddsOutOfRange above ODDS_DENOMINATOR, so
  // the clamp is what keeps a bad probability from reverting a whole batch of
  // 50 forecasts.
  assert.equal(toBasisPoints(0.00005), 1);
  assert.equal(toBasisPoints(0.000049), 0);
  assert.equal(toBasisPoints(1.5), 10000);
  assert.equal(toBasisPoints(-0.2), 0);
});

test("the parse -> encode path stays inside the contract's range", () => {
  // Whatever the parser emits must be a legal uint32 odds value.
  const responses = [
    "Probability: 0%",
    "Probability: 100%",
    "Probability: 150%",
    "Probability: 33.33%",
  ];
  for (const response of responses) {
    const parsed = parseForecastProbability(response);
    assert.notEqual(parsed, null, `expected ${response} to parse`);
    const bps = toBasisPoints(parsed!);
    assert.ok(
      Number.isInteger(bps) && bps >= 0 && bps <= 10000,
      `${response} -> ${bps} is not valid odds`,
    );
  }
});

test("attributeKey is keccak256 of the key name", () => {
  assert.equal(
    attributeKey("forecastingModel"),
    ethers.keccak256(ethers.toUtf8Bytes("forecastingModel")),
  );
  // Readers filter logs on this exact topic, so the two keys the benchmark
  // writes are pinned here against accidental renames.
  assert.equal(
    attributeKey("forecastingModel"),
    "0x1b5a97795a15a4b58b0badd25522916e8ccbeaae9ec40ec26ba12c04c9e323c8",
  );
  assert.equal(
    attributeKey("researchModel"),
    "0x2289f85bc1cfd133c459a50f299656a30a762214d7b1a4a606cdc618d583bd90",
  );
});

test("the base/negated -> Yes/No mapping is complementary", () => {
  // The benchmark's whole premise: a coherent model's two on-chain odds for one
  // market sum to ~10000. If this inverts, every published number is wrong.
  const baseAnswer = parseForecastProbability("Probability: 70%")!;
  const negatedAnswer = parseForecastProbability("Probability: 30%")!;
  const yesOdds = toBasisPoints(baseAnswer); // base question   -> "Yes"
  const noOdds = toBasisPoints(negatedAnswer); // negated question -> "No"
  assert.equal(yesOdds + noOdds, 10000);
});
