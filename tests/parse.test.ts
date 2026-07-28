// Golden tests for `parseForecastProbability` — the point where a paid-for
// model response becomes a number in the benchmark. Everything downstream (the
// DB row, the basis points written on-chain, the noise metric itself) is
// derived from it, and a silent regression here corrupts a run that costs real
// money to reproduce.
//
// Cases marked SHARP EDGE lock in behaviour that is defensible but surprising;
// they exist so a change to it shows up as a failing test rather than as a
// mysterious spike in unparseable responses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForecastProbability, parsePairwiseChoice } from "../src/utils";

test("parses the documented output format", () => {
  assert.equal(parseForecastProbability("Probability: 72.5%"), 0.725);
  assert.equal(parseForecastProbability("Probability: 44%"), 0.44);
  assert.equal(parseForecastProbability("Probability: 0.01%"), 0.0001);
});

test("tolerates the formatting models actually emit", () => {
  // Markdown bolding, `=` instead of `:`, stray whitespace, any casing.
  assert.equal(parseForecastProbability("**Probability:** 5%"), 0.05);
  assert.equal(parseForecastProbability("probability = 72.5 %"), 0.725);
  assert.equal(parseForecastProbability("Probability:  8.25  %"), 0.0825);
  assert.equal(parseForecastProbability("PROBABILITY: 44%"), 0.44);
  assert.equal(parseForecastProbability("Probability:72.5%"), 0.725);
});

test("takes the LAST occurrence — the final answer, not the working", () => {
  const reasoning = [
    "Base rate suggests Probability: 30%",
    "but the recent news is decisive.",
    "Probability: 80%",
  ].join("\n");
  assert.equal(parseForecastProbability(reasoning), 0.8);
});

test("prose mentioning a probability does not hijack the answer", () => {
  // The separator between the keyword and the number is tight
  // (`\s*[:=]?\s*\*{0,2}\s*`), so " was ", " of ", " is " cannot match. A
  // trailing caveat therefore leaves the real answer intact.
  assert.equal(
    parseForecastProbability(
      "Analysis. Probability: 65%. Though historically the probability was 20%.",
    ),
    0.65,
  );
  assert.equal(
    parseForecastProbability(
      "The probability of rain is 30% but Probability: 80%",
    ),
    0.8,
  );
});

test("clamps into the open interval the system prompt asks for", () => {
  // 0 and 1 are excluded so a forecast is never infinitely wrong under a log
  // score; the DB CHECK constraint accepts [0,1], so both bounds are legal.
  assert.equal(parseForecastProbability("Probability: 0%"), 0.0001);
  assert.equal(parseForecastProbability("Probability: 100%"), 0.9999);
});

test("returns null when there is no usable forecast", () => {
  assert.equal(parseForecastProbability("I think it is likely."), null);
  assert.equal(parseForecastProbability(""), null);
  assert.equal(parseForecastProbability(null), null);
  assert.equal(parseForecastProbability(undefined), null);
});

test("SHARP EDGE: a missing % sign is unparseable", () => {
  // The system prompt demands `Probability: X%`, and a model that drops the
  // percent sign costs a full retry cycle. If probe-models.ts reports a model
  // doing this consistently, relax the regex rather than pay 4x for it.
  assert.equal(parseForecastProbability("Probability: 12"), null);
});

test("SHARP EDGE: a bare decimal point is unparseable", () => {
  // `[0-9]+(\.[0-9]+)?` requires a leading digit, so ".5%" does not match.
  assert.equal(parseForecastProbability("Probability: .5%"), null);
  assert.equal(parseForecastProbability("Probability: 0.5%"), 0.005);
});

test("SHARP EDGE: an out-of-range percentage is clamped, not rejected", () => {
  // 150% means the model misunderstood the task, but it is recorded as a
  // confident 99.99% rather than as a parse failure. Worth knowing when a
  // model's odds look suspiciously saturated.
  assert.equal(parseForecastProbability("Probability: 150%"), 0.9999);
});

test("SHARP EDGE: the plural 'Probabilities:' also matches", () => {
  // Intended to catch a model that pluralises its final line, but it means a
  // table of probabilities is read as a forecast — first value here, since the
  // later numbers are not preceded by the keyword.
  assert.equal(parseForecastProbability("Probabilities: 30% and 70%"), 0.3);
});

test("scientific notation is not accepted", () => {
  assert.equal(parseForecastProbability("Probability: 1e2%"), null);
});

// ---------------------------------------------------------------------------
// parsePairwiseChoice — the same point, for the ranking modality. A misparse
// here does not merely lose a data point: it publishes a judgment about the
// wrong side of the comparison to an append-only log.
// ---------------------------------------------------------------------------

test("parses the documented pairwise output format", () => {
  assert.equal(parsePairwiseChoice("More likely: A"), "A");
  assert.equal(parsePairwiseChoice("More likely: B"), "B");
});

test("tolerates the formatting models actually emit", () => {
  assert.equal(parsePairwiseChoice("**More likely:** A"), "A");
  assert.equal(parsePairwiseChoice("more likely = b"), "B");
  assert.equal(parsePairwiseChoice("More likely:  Market  B"), "B");
  assert.equal(parsePairwiseChoice("MORE LIKELY: A"), "A");
  assert.equal(parsePairwiseChoice("More   likely:\nB"), "B");
});

test("takes the LAST occurrence — the final answer, not the working", () => {
  const reasoning = [
    "On base rates alone A is more likely: A has happened twice before.",
    "But the scheduled announcement changes things.",
    "More likely: B",
  ].join("\n");
  assert.equal(parsePairwiseChoice(reasoning), "B");
});

test("a refusal to rank is not a choice", () => {
  // The registry has no encoding for a tie, so a model that declines must
  // produce no data point rather than an arbitrary side. This is the case the
  // whole null path exists for.
  assert.equal(
    parsePairwiseChoice(
      "These two outcomes are equally likely; I cannot rank them.",
    ),
    null,
  );
  assert.equal(parsePairwiseChoice("More likely: neither"), null);
  assert.equal(parsePairwiseChoice("It depends on your assumptions."), null);
  assert.equal(parsePairwiseChoice(""), null);
  assert.equal(parsePairwiseChoice(null), null);
  assert.equal(parsePairwiseChoice(undefined), null);
});

test("a probability instead of a choice is unparseable", () => {
  // The pairwise prompt asks for a rank, not a number. A model that answers
  // with odds has not done the task, and must burn its retries rather than
  // have a choice inferred from a number the modality does not collect.
  assert.equal(parsePairwiseChoice("Probability: 72%"), null);
});

test("SHARP EDGE: the letter must stand alone", () => {
  // `\b` after the letter means a word starting with A or B does not match, so
  // prose like "more likely, Anthropic wins" cannot hijack the answer — but it
  // also means a model answering "More likely: Alpha" parses as nothing.
  assert.equal(parsePairwiseChoice("More likely: Alpha"), null);
  assert.equal(parsePairwiseChoice("More likely: A."), "A");
  assert.equal(parsePairwiseChoice("More likely: B)"), "B");
});

test("SHARP EDGE: prose using the keyword loosely can be read as an answer", () => {
  // The separator is tight (`\s*[:=]?\s*`), so " is " or " than " cannot match
  // — but a bare "more likely A" can, and being the last occurrence it wins.
  assert.equal(parsePairwiseChoice("Outcome B is more likely than A"), null);
  assert.equal(parsePairwiseChoice("I judge this more likely A"), "A");
});
