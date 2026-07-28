// On-chain encoding. These values are written to an append-only public log, so
// a rounding or clamping change is not recoverable after the fact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  FORECAST_REGISTRY_ABI,
  attributeKey,
  toBasisPoints,
  toPairwiseTuple,
} from "../src/forecast-registry-abi";
import { parseForecastProbability } from "../src/utils";
import { PendingPairwiseForecastRecord } from "../src/types";

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

// ---------------------------------------------------------------------------
// Pairwise. The ABI here is hand-maintained against the deployed contract, so
// these tests encode through ethers rather than merely inspecting the literal:
// a wrong type or a missing tuple component produces calldata the contract
// cannot decode, and there is no way to un-send that.
// ---------------------------------------------------------------------------

const iface = new ethers.Interface(
  FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
);

const pairwiseRecord: PendingPairwiseForecastRecord = {
  pairwiseForecastId: 1,
  forecasterName: "model-x",
  platformIdA: 1,
  marketAId: "2430327",
  marketAOutcome: "Yes",
  platformIdB: 1,
  marketBId: "9910011",
  marketBOutcome: "No",
  isALikelier: true,
};

test("the pairwise ABI signatures match the deployed contract", () => {
  // Pinned against ../forecast-registry/contracts/ForecastRegistry.sol. These
  // strings are what the selector and the log topic are derived from, so any
  // reordering or retyping of a field changes them — and calldata built from a
  // drifted ABI is either undecodable or, worse, decodes into the wrong fields.
  assert.equal(
    iface.getEvent("PairwiseForecastRecorded")!.format("sighash"),
    "PairwiseForecastRecorded(address,uint32,string,string,uint32,string,string,bool)",
  );
  assert.equal(
    iface.getFunction("recordPairwiseForecast")!.format("sighash"),
    "recordPairwiseForecast(uint32,string,string,uint32,string,string,bool)",
  );
  assert.equal(
    iface.getFunction("recordPairwiseForecastBatch")!.format("sighash"),
    "recordPairwiseForecastBatch((uint32,string,string,uint32,string,string,bool)[])",
  );
});

test("a single pairwise forecast round-trips through the ABI", () => {
  const data = iface.encodeFunctionData(
    "recordPairwiseForecast",
    toPairwiseTuple(pairwiseRecord),
  );
  const decoded = iface.decodeFunctionData("recordPairwiseForecast", data);
  assert.equal(Number(decoded[0]), 1);
  assert.equal(decoded[1], "2430327");
  assert.equal(decoded[2], "Yes");
  assert.equal(Number(decoded[3]), 1);
  assert.equal(decoded[4], "9910011");
  assert.equal(decoded[5], "No");
  assert.equal(decoded[6], true);
});

test("a pairwise batch round-trips as a struct array", () => {
  // The batch takes ONE struct array rather than seven parallel arrays, so a
  // judgment cannot be split across misaligned columns. Encoding two items with
  // opposite verdicts proves each row stays whole.
  const second: PendingPairwiseForecastRecord = {
    ...pairwiseRecord,
    marketAOutcome: "No",
    marketBOutcome: "Yes",
    isALikelier: false,
  };
  const data = iface.encodeFunctionData("recordPairwiseForecastBatch", [
    [pairwiseRecord, second].map(toPairwiseTuple),
  ]);
  const [items] = iface.decodeFunctionData("recordPairwiseForecastBatch", data);

  assert.equal(items.length, 2);
  assert.equal(items[0].marketAOutcome, "Yes");
  assert.equal(items[0].marketBOutcome, "No");
  assert.equal(items[0].isALikelier, true);
  assert.equal(items[1].marketAOutcome, "No");
  assert.equal(items[1].marketBOutcome, "Yes");
  assert.equal(items[1].isALikelier, false);
});

test("PairwiseForecastRecorded is filterable by submitter and both platforms", () => {
  // verify-run.ts and republish.ts both read the log back by submitter address.
  // If `submitter` were not indexed, those queries would return nothing and the
  // silent-drop detectors would report a clean run while dropping everything.
  const event = iface.getEvent("PairwiseForecastRecorded")!;
  const indexed = event.inputs.filter((i) => i.indexed).map((i) => i.name);
  assert.deepEqual(indexed, ["submitter", "platformIdA", "platformIdB"]);
  // Solidity allows at most three indexed args on a non-anonymous event.
  assert.ok(indexed.length <= 3);
});

test("the pairwise event carries no odds", () => {
  // A rank judgment commits to no probability for either side. If odds ever
  // appeared here, a reader could mistake a relative judgment for an absolute
  // forecast and mix the two modalities in one score.
  const event = iface.getEvent("PairwiseForecastRecorded")!;
  assert.ok(!event.inputs.some((i) => i.name.toLowerCase().includes("odds")));
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
