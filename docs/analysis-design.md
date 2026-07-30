# noisebench — analysis design

Spec for the analysis layer and static site built on benchmark run **1**
(`noisebench-production`, dataset `production-28-07-26.json`).

Scope: **noise and internal consistency only**. No outcome scoring, no Brier,
no accuracy. Where the market midpoint appears it is treated as an _input
feature of the question_ (what the crowd thought at snapshot time), never as
ground truth.

---

## 0. What is actually in the run

Verified against the database, not assumed.

|                    |                                                   |
| ------------------ | ------------------------------------------------- |
| Models             | 20                                                |
| Events / markets   | 72 / 100                                          |
| Pairs              | 50                                                |
| Direct forecasts   | 16,000 rows — **15,862 parsed** (138 null, 0.86%) |
| Pairwise forecasts | 8,000 rows — **7,953 decided** (47 null, 0.59%)   |
| Traces             | 24,000, $437.41 total, 1,304 retries              |
| Wall clock         | 2026-07-28 17:44 → 20:51 UTC                      |

### Five facts that change the design

**F1 — the pair fixture is not a perfect matching.**
`will-there-be-two-uk-prime-ministers-by-end-of-2027-...` (market 8) appears in
**two** pairs; `will-giorgia-meloni-be-the-next-prime-minister-of-italy`
(market 104) appears in **none**. So "160 pairwise forecasts per market" holds
for 98 markets, is 320 for one and 0 for another. Anything per-market on the
pairwise side must handle this rather than dividing by a constant.

**F2 — there are zero reversed pairs.** No `(B, A)` exists for any `(A, B)`.
The README motivates reversed pairs as the only probe of **position bias**, but
the production fixture has none, so _position bias is not measurable in this
run_. Do not put it on the site; note it as a gap and add reversed pairs to the
next fixture.

**F3 — midpoints are not in the database.** `market` has no price column and
`grep midpoint` over `src/` and `migrations/` finds nothing. `midpoint`,
`spread`, `yesLiquidity`, `noLiquidity`, `orderbookSnapshotAt` exist only in
the dataset JSON. Goal 6 needs them. See §5 for the fix.

**F4 — missingness is concentrated, not random.** Null parses by model:
`claude-sonnet-5` 11.0% (88 rows), `kimi-k3` 4.0%, `fable-5` 1.0%, everyone
else ≤0.9%. Sonnet also averages 3.0 s and 110 output tokens per call against
a 10–47 s field, and carries 213 of the 723 traces with recorded errors — it
was failing, not thinking fast. Dropping incomplete cells therefore changes
_which markets each model is scored on_, which biases the cross-model level
comparison. Subsetting policy in §2.3.

**F5 — negation sub-additivity is the largest effect in the dataset, and it is
real.** Holding the description, rules and research constant while varying only
the question phrasing is the correct experimental control: the rules describe
the _event and its resolution mechanics_, which are identical whichever
direction the question points. A model that fails to re-orient to the negated
question is failing at the thing the benchmark exists to measure.

Tested rather than assumed. 42 of the 100 descriptions explicitly state a
"resolves to Yes/No" mapping, which is the only place a genuine text-level
tension with a negated question could arise. Within midpoint bands the negation
gap for those markets versus the other 58 differs by +0.058, −0.312, −0.069 and
−0.105 — small and inconsistent in sign. The −0.261 overall difference is a
confound with midpoint (mean 0.199 for the hardcoded set versus 0.376 for the
rest), and midpoint is the dominant driver. Description wording does not
moderate the effect. See §4.

---

## 1. Common representation

Every direct forecast is folded onto the **market's Yes scale** once, at load:

```
p_yes = is_negated ? 1 - parsed_odds : parsed_odds
```

Phrasing is then kept as an explicit factor rather than being averaged away, so
the Yes/No effect is a _named term_ instead of contaminating the noise terms.

### 1.1 Two scales, always both

The dataset is heavily skewed low — midpoints run 0.011 to 0.962, **median
0.1935**, 36 of 100 markets below 0.10, only 3 above 0.90. 41% of all parsed
forecasts fall in the bottom decile. On the probability scale a cell of
`{0.05, 0.01, 0.03, 0.01}` looks quieter than `{0.55, 0.50, 0.53, 0.51}`, when
it is in fact a 5× swing in the odds of the event. Every noise measure is
therefore computed twice:

| scale           | definition                         | reads as          | answers                                                      |
| --------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------ |
| **probability** | `p_yes`                            | percentage points | "how far does this wander in absolute terms"                 |
| **log-odds**    | `logit(clip(p_yes, 0.001, 0.999))` | logits            | "how far does this wander relative to how rare the event is" |

Clipping bites on 393 of 15,862 observations (2.5%); the raw range is
[0.0001, 0.9999] with no exact 0 or 1, so clipping is a tail-tamer, not a
correctness fix.

`src/analysis.ts` still computes both scales. The **site shows only the
probability scale** — the log-odds readout went with the cross-model comparisons
(§10) — so the skew it was there to correct for is now stated in the captions
instead: both probability-scale measures in §9 rise with the market price, which
is what a points-scale measure does when long shots leave it no room to move.

A third, purely presentational readout for cell-level tooltips: **spread ratio**
`max(p)/min(p)` within the cell, which is what makes the "this model's forecast
for a rare event varied 5×" claim legible without teaching the reader logits.

---

## 2. The noise decomposition

### 2.1 One model, both the noise split and the Yes/No effect

Rather than three separate calculations, fit a single fully-crossed
decomposition per scale. Indices: model _i_ (20), market _j_, phrasing _k_
(base/negated), iteration _r_ (4).

```
value(i,j,k,r) = μ
               + α_i          model main effect
               + β_j          market main effect
               + γ_k          phrasing main effect
               + (αγ)_ik      model × phrasing
               + (αβ)_ij      model × market
               + (αβγ)_ijk    model × market × phrasing
               + ε_ijkr       within-cell residual
```

Every quantity asked for falls out of this one fit:

| term                         | statistic                                                                                             | goal              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `SD_i(α_i)`                  | **level noise**                                                                                       | 1.1               |
| `α_i` itself                 | that model's level, signed, vs the grand mean                                                         | 1.1               |
| `RMS((αβ)_ij)`               | **stable pattern noise**                                                                              | 1.2               |
| `SD_r(ε)` pooled within cell | **occasion noise**                                                                                    | 1.3               |
| `γ_base − γ_neg`             | **global Yes/No bias**                                                                                | 2                 |
| `(αγ)_ik`                    | **per-model Yes/No bias**                                                                             | 2                 |
| `SD_j(β_j)`                  | case spread — **signal, not noise**; the y-axis of the whole exercise                                 | context           |
| `RMS((αβγ)_ijk)`             | phrasing-specific pattern noise — the part of a model's idiosyncrasy that only appears under negation | new, worth having |

System noise = `sqrt(level² + stable_pattern² + occasion²)`, matching Kahneman's
`system² = level² + pattern²` with `pattern² = stable² + occasion²`.

**Terminology fix:** goals 1.1/1.2 say "event". The judged unit is the
**market** (100), not the event (72). Events group markets — neg-risk events
hold several mutually exclusive markets — so they are a _nesting_ level, not the
case level. Recommend fixing the wording and adding event as an optional
grouping for a secondary breakdown, since a model that is idiosyncratic on one
Russian-election market is probably idiosyncratic on all of them.

### 2.2 Prototype output

Already computed against the real data, 89-market subset, means-of-means:

|                      | probability | log-odds  |
| -------------------- | ----------- | --------- |
| level noise          | 0.042       | 0.316     |
| stable pattern       | 0.102       | 0.800     |
| **occasion noise**   | **0.146**   | **1.156** |
| system noise         | 0.183       | 1.441     |
| case spread (signal) | 0.158       | 1.217     |

Two things to note. Occasion noise is the **largest** component on both
scales — models disagree with themselves across identical repeated prompts more
than they differ from each other. And system noise **exceeds case spread** on
both scales: there is more noise in the panel than there is real signal
distinguishing one market from another.

### 2.3 Subsetting policy

Because of F4, three nested populations, all reported:

1. **Primary — "complete cells" (89 markets).** Every one of the 40
   model×phrasing cells has ≥1 parsed observation. Effects computed as
   _unweighted means of cell means_ at each level, which is unbiased under
   unequal _n_ and does not let a model with more surviving rows drag a
   marginal mean. Occasion noise pooled only over cells with ≥2 observations
   (each contributing `n−1` df).
2. **Robustness — "strict balance" (62 markets).** Every cell has all 4
   iterations. Same code path, harder filter. If the headline numbers move
   materially between 1 and 2, missingness is driving them and the site must
   say so.
3. **Per-model detail — all available data.** For single-model pages where no
   cross-model comparison is being made, use everything that parsed.

Cell completeness overall: 3,938 of 4,000 direct cells have all 4 iterations;
17 are empty, 45 partial. Pairwise: 3,973 of 4,000 combos complete, 20 empty.

---

## 3. Question-level noise

Per market, on both scales:

- **Total spread** — SD of all ~160 direct observations on the Yes scale.
- **Between-model** — SD of the 20 model means. Genuine disagreement.
- **Within-model** — pooled within-model SD. Irreproducibility.
- **Consensus** — unweighted mean of model means (not the raw mean, so a model
  with more surviving rows does not get extra vote weight).
- **Negation gap** — `mean_base + mean_neg − 1`, per §4.

Pairwise side, per **pair** (50 units, not per market — F1 makes per-market
ill-defined): couple-violation rate and repetition flip rate from §6, plus the
share of the 160 judgments that went to A.

The site's market table is therefore sortable on "most contested" (between-model)
vs "most irreproducible" (within-model), which are different questions and, on
this data, probably different markets.

---

## 4. The Yes/No result

### 4.1 The measure

Per model × market, from **cell means** (base and negated iterations are
independent calls; pairing them by iteration index would be meaningless):

```
gap = mean_base(p) + mean_neg(p) − 1
```

`gap = 0` is coherence. `gap < 0` is **sub-additivity** — the model assigns less
than unit mass across a question and its negation. On the Yes scale this is
identical to `γ_base − γ_neg` from §2.1, which is a useful internal check that
the two code paths agree. Log-odds analogue: `logit(p_base) + logit(p_neg)`,
which should be 0.

### 4.2 What the data says

Numbers below are from the re-run of the No wording (2026-07-30). The first
version of this section reported a **sum of 0.617** and a gap of −0.725 in the
lowest midpoint band; that was an artifact of the prompt, not a property of the
models — see §4.3.

Global: mean Yes-wording parse 0.264, mean No-wording parse 0.740, **sum 1.004**
against the 1.000 that coherence forces. Mean signed gap +0.004, mean absolute
gap 0.018. Broken out by market midpoint (n = 100 markets, 20 models each):

| midpoint band | n   | mean midpoint | Yes wording | No wording | sum   | gap    |
| ------------- | --- | ------------- | ----------- | ---------- | ----- | ------ |
| 0.00–0.05     | 18  | 0.032         | 0.056       | 0.942      | 0.998 | −0.002 |
| 0.05–0.10     | 18  | 0.071         | 0.067       | 0.920      | 0.987 | −0.013 |
| 0.10–0.25     | 20  | 0.158         | 0.146       | 0.847      | 0.994 | −0.006 |
| 0.25–0.50     | 17  | 0.365         | 0.378       | 0.637      | 1.015 | +0.015 |
| 0.50–0.75     | 17  | 0.601         | 0.466       | 0.545      | 1.012 | +0.012 |
| 0.75–1.00     | 10  | 0.869         | 0.692       | 0.343      | 1.034 | +0.034 |

Both arms now track the midpoint, and the residual gap runs the other way: it is
near zero on long shots (where both answers are nearly forced) and largest on
questions the market puts near or above even money, where a model is free to
answer both sides high. Per-question negation error rises the same way, 0.018 in
the lowest band to 0.054 in the highest.

### 4.3 Interpretation

The original result was a prompt bug. The No wording was built by negating the
question text (`negatedQuestion` — "Will X _not_ happen?") while the rest of the
prompt still described the market's Yes/No mapping, so the two halves of the
prompt disagreed about what a probability referred to. Models answered the
salient event's base rate because that is what the prompt, read as a whole,
mostly asked for. Fixing the phrasing to **ask the outcome directly** — the No
wording asks for the probability of the No outcome of the unmodified market —
removed the effect almost entirely.

That reframes the finding rather than deleting it. What run 1 measured was
sensitivity to a self-contradictory prompt, which is a real failure mode but not
the one the section claimed. What survives is the smaller, opposite-signed
pattern in §4.2: negation error is a mid-range phenomenon, not a long-shot one.

F5 (text-level tension between a negated question and a description hardcoding
the Yes/No mapping) was originally ruled out on the grounds that it does not
moderate the gap once midpoint is controlled. That test was too weak: the tension
was present in **every** cell of the negated arm, so it had no contrast to show
up against. It was the cause.

Worth showing alongside, because it is the same question asked without any
absolute probability at all: the pairwise couple identities (§6), violated at
16.0% (rank) and 7.2% (sum) against a 50% chance baseline. Both modalities now
agree that negation handling is broadly intact, which is the same kind of
cross-check the pre-fix version relied on — it simply points the other way.

---

## 5. Ranking vs the market snapshot

Needs midpoints, which are not in the DB (F3). **Fix: a migration adding
`midpoint`, `spread`, `yes_liquidity`, `no_liquidity`, `orderbook_snapshot_at`
to `market`, backfilled from the dataset JSON.** Snapshot-time price is a
property of `{run, market}` strictly speaking — a later dataset re-snapshots
it — so if runs will ever share markets, it belongs in a
`benchmark_run_market_snapshot` table alongside `event_research`, which already
uses that pattern for exactly this reason. Recommend the run-scoped table.

Measures, per model and for the consensus:

- Markets ranked by consensus `p_yes`, against rank by midpoint.
- **Spearman ρ** per model vs the midpoint ordering — one number for "does this
  model order the world the way the market does".
- Signed deviation on both scales: `p̄ − midpoint`, and
  `logit(p̄) − logit(midpoint)`. Given §4.2's base column tracking midpoints
  closely (0.056 vs 0.032, 0.146 vs 0.158), expect the interesting deviation to
  be in the tails and to be much larger in logits than in points.
- Framed as **disagreement with the market**, never as error.

---

## 6. Head-to-head consistency

### 6.1 A correction to the original brief

The goal text gives as an example of logical inconsistency: "if they say A is
likelier than B when both are positive, but that A is likelier than not_B".
That is **not** a contradiction. `P(A) > P(B)` and `P(A) > 1 − P(B)` are jointly
satisfiable — e.g. `A = 0.9, B = 0.4`. The four combinations probe two
independent binary facts:

```
X ≡ P(A) > P(B)          Y ≡ P(A) + P(B) > 1

(A, B)    picks A  ⟺  X          (¬A, ¬B)  picks A  ⟺  ¬X
(A, ¬B)   picks A  ⟺  Y          (¬A, B)   picks A  ⟺  ¬Y
```

So the only forced constraints are that **(A,B) must oppose (¬A,¬B)** and
**(A,¬B) must oppose (¬A,B)**. All four `(X, Y)` quadrants are realizable, so
4 of the 16 answer patterns are coherent — and those two couple-checks are
therefore **jointly necessary _and_ sufficient** for logical coherence of the
quadruple. That is a tidy result to state on the site: two comparisons fully
audit the set.

### 6.2 The three measures

1. **Repetition instability** — same model, pair, phrasing combo, iteration 0
   vs 1. Pure occasion noise in the ranking modality. Measured: **9.2%** flip
   rate over 3,966 comparable cells. On the site this is
   _pairwise disagreement_ (§9).
2. **Couple violation** — the §6.1 identities. Measured (post-fix): **16.0%** on
   (A,B)/(¬A,¬B) and **7.2%** on (¬A,B)/(A,¬B), 3,965 checks in total. Chance is
   50%, so both are well clear of coin-flipping; the pre-fix run measured 42.4%
   and 47.2%, i.e. no better than chance (§4.3). The rank couple stays twice as
   often violated as the sum couple. On the site the two are averaged into
   _negation disagreement_ and also charted separately.
3. **Position bias** — not measurable, F2. Report as a known gap. `aRate` (share
   of picks going to side A) spans 0.475–0.525 across the field, so nothing is
   degenerate.

Both 1 and 2 break down per model and per pair. Guard against the trap: a model
that always answers "A" scores 0% repetition instability and 100% couple
violation, so the two must be shown together, with the A-rate alongside.

---

## 7. Direct vs head-to-head agreement

For each model × pair, take the model's own direct means `P̄(A)`, `P̄(B)` on the
Yes scale (8 observations each), then split the check the way §6.1 splits the
combinations:

- **Rank agreement** — do combos `(A,B)` and `(¬A,¬B)` agree with
  `sign(P̄(A) − P̄(B))`?
- **Sum agreement** — do combos `(A,¬B)` and `(¬A,B)` agree with
  `sign(P̄(A) + P̄(B) − 1)`?

A single blended "agreement rate" would mix these and mean nothing, since the
two speak to different facts.

The chart that matters is **agreement rate as a function of the model's own
margin** `|P̄(A) − P̄(B)|`, binned. A coherent forecaster traces a psychometric
curve: ~50% at zero margin (genuinely indifferent, so flipping is correct) rising
to ~100% at large margins. **Where the curve tops out at large margins is the
real measure** — a model that only reaches 70% when it privately believes A is
30 points likelier than B is contradicting itself across modalities, not merely
being uncertain.

Bin by the **model's own** margin, not by the midpoint gap: pairs were built
from midpoint-sorted neighbours so the market's gap is small by construction,
but the models' internal gaps vary a lot.

---

## 8. Inference properties

Straight aggregation over `llm_trace`, joined to `forecast` / `pairwise_forecast`
on `llm_trace_id` so the direct and pairwise modalities can be split (the
`identifier` prefix `m…`/`p…` also works but the join is authoritative).

Per model: USD per forecast (`cost / 1e9`), output tokens, reasoning tokens,
seconds, retry rate, share of traces carrying an error payload, and **parse
failure rate** — which is the one that belongs next to the noise numbers, since
it is the rate at which the model produced nothing usable.

Measured spread is wide: **$0.083/call (gpt-5.6-sol-pro) to $0.0004/call
(deepseek-v4-flash)**, a 195× range; 3.0 s to 46.9 s; 0 to 2,158 reasoning
tokens. `mistral-large-2512` reports 0 reasoning tokens throughout. 58 traces
have null cost/token fields.

The cross-cut worth charting: **cost per forecast against occasion noise**.
If they are uncorrelated — and the §2.2 numbers hint they might be — that is a
genuinely useful result for anyone choosing a forecasting model.

---

## 9. The noise score

The site's headline number, and the only place the two modalities are combined.
It replaced an earlier "consistency score" built from five reliability-style
sub-scores (intraclass correlation, coherence rates); that version is retired
because none of its components had a formula a reader could check by hand, and
the whole framing inverted the thing being measured. **Lower is better
throughout**: every component is an error or a disagreement rate, so the score
is noise, not skill. `src/metrics.ts` is the implementation; `tests/metrics.test.ts`
carries each worked example.

Five components, **equally weighted** (plain mean, no rescaling), each in [0,1].
Two are distances in probability, three are shares of judgments. None needs to
know how a market resolved.

| Component                  | Formula                                                        | Random | Field avg |
| -------------------------- | -------------------------------------------------------------- | ------ | --------- |
| Average error              | mean over cells of MAD of the 4 repeats                        | 5/24 = 20.8% | 2.5%  |
| Negation error             | mean over {model, market} of \|avg(Yes) − (1 − avg(No))\|      | 59/360 = 16.4% | 3.6% |
| Pairwise disagreement      | share of repeat comparisons (iteration 0 vs 1) that flip       | 50%    | 9.2%      |
| Negation disagreement      | share of §6.1 couple checks violated                           | 50%    | 11.6%     |
| Individual-pair disagreement | share of pairs where the folded 8-forecast ranking differs from the model's own majority pick | 50% | 16.4% |

Composite range: **4.3%** (gpt-5.6-sol-pro) up to **16.5%**
(mistral-large-2512). Field average **8.7%**; a model answering uniformly at
random scores **37.4%**.

Four decisions worth recording:

**Both probability-scale components use absolute distance, not a ratio.** The
retired repeat-reliability sub-score was an intraclass correlation, which needs
no tolerance and no choice of scale — attractive on a dataset this skewed — but
it cannot be stated as a formula a reader will follow, and it scores a
perfectly-steady model with no discrimination at 0. Mean absolute deviation
costs the scale-invariance and buys a number in the same units as the answers:
"the four repeats landed 2.5 points apart" is directly readable. The cost is
visible in the data and stated on the site — both components correlate
_positively_ with the market price (+0.31 for average error), because long shots
leave a points-scale measure no room to move.

**The random baselines are derived, not asserted, and never baked into the
scaling.** Average error's 5/24 is the MAD of four iid U(0,1) draws; negation
error's 59/360 is E|S₈ − 4|/4 under Irwin–Hall(8); the three judgment shares are
50% by symmetry. Details on the site carries the derivations, and
`tests/metrics.test.ts` checks both closed forms against a seeded Monte Carlo.
Charts state the baseline in the caption rather than drawing it, since a 50%
reference line would flatten a field spanning 3–29%.

**Random is not the worst case, and not a floor for gaming.** A wording-blind
model — one that answers the same number regardless of direction — scores
**67.6%**, computed from the run as mean |2·avg(Yes) − 1|. In the other
direction, a model that always answers 50% and always picks the first option
scores 0/0/0/100/50 → composite **30%**, better than random. Both are stated on
the site so the score is not read as a skill measure.

**The head-to-head repeat check is gameable** — a model that always picks the
left option scores 0% disagreement. The negation check catches exactly that
failure, so the two are always reported together, and `aRate` (share of picks
going to side A) rides along in the tooltip. A-rates span 0.475–0.525, so
nothing is degenerate.

**Ties in the individual-pair check count as half.** The folded direct belief can
sit exactly level, or the majority vote across the four wording combos can split
2–2; 96 of 996 model-pairs tie. Counting them as 0.5 keeps the measure at 50%
under a coin-flip model, and `ties` is reported alongside.

### 9.1 The margin curve

Pre-fix numbers (§4.3). The site no longer shows this chart — it is a cross-model
cut, and note 2 of the site rework dropped those — but the design decision is
worth keeping.

Cross-modal agreement bucketed by the model's **own** margin, pooled across all
twenty models (one model supplies ~200 rank comparisons, too thin to bucket):

| Model's own margin | Agreement | n     |
| ------------------ | --------- | ----- |
| 0–5 pts            | 50.9%     | 1,480 |
| 5–15 pts           | 63.6%     | 970   |
| 15–30 pts          | 71.5%     | 880   |
| 30–50 pts          | 70.4%     | 594   |
| 50+ pts            | 92.3%     | 52    |

Textbook shape — 50% where the model is genuinely indifferent, which is correct
behaviour — but it tops out around 71%. **A model that has already said one
outcome is 15 to 30 points likelier still contradicts itself in three of every
ten comparisons.**

Restricted to the **rank** comparisons. Pooling the sum comparisons in would
flatter every model: the dataset is skewed to long shots, so a pair usually sums
far below 1, landing its sum check in the widest margin bucket while being
trivially easy ("is 95% more likely than 10%?"). Field rank agreement is 62.0%
against sum agreement of 70.4% — the gap is the whole reason to separate them.

---

## 10. Build plan

```
migrations/05_market_snapshot.sql   run-scoped midpoint/spread/liquidity (§5)
scripts/backfill-snapshot.ts        populate it from the dataset JSON
src/analysis.ts                     the decomposition + Yes/No statistics (§2, §4)
src/metrics.ts                      the five site measures + composite (§9)
scripts/analyze.ts                  SQL → TS → site/data/*.json
site/index.html                     the noise score and its five parts (§9)
site/noise.html                     the five measures in depth (§9)
site/markets.html                   per-question analysis (§3, §5)
site/details.html                   method, formulas, baselines, coverage
site/data/*.json                    committed, so the site opens with no DB
```

`analyze.ts` still emits `noise.json` and `negation.json` — the §2 decomposition
and the §4 arms — but the site reads only `run.json` and `metrics.json`. Keeping
them written costs nothing and means the decomposition is one page away from
being shown again.

### Vocabulary on the site

The site is written for a reader who has not read _Noise_. It used to rename
Kahneman's terms (baseline tilt / idiosyncrasy / repeat drift / total noise /
real spread between questions for level, stable pattern, occasion and system
noise, and case spread); the current site drops that vocabulary altogether, since
the five measures in §9 are defined by their formulas and need no analogy. The
mapping stays here for anyone reading `src/analysis.ts`, which still computes the
decomposition.

Units are never bare numbers, and there is one scale: probability, written as a
percentage (`14.6%`). The log-odds view and its `×3.18` odds-multiple toggle are
gone with the cross-model comparisons. Every chart names its formula and its
random baseline next to it, so a reader can tell an absolute distance from a
share of judgments without inferring it from the axis.

`analyze.ts` does the SQL in Postgres for aggregation that SQL is good at
(counts, joins, per-cell means) and the decomposition arithmetic in TypeScript,
where the means-of-means and unbalanced-cell handling stay readable. It writes
static JSON; the site is plain HTML with inline JS and no build step, served by
`npx serve site` or opened from disk. That keeps the eventual hosting step to a
file copy.

Everything above is derived per-model **and** globally, per goal 1–7.

## 11. Open gaps to fix in the next run

- Reversed pairs, so position bias becomes measurable (F2).
- A complete pair matching, or an explicit note that it is not one (F1).
- Snapshot prices written to the DB at run time (F3).
- Investigate `claude-sonnet-5`'s 11% failure rate before it is compared to
  models with 0% (F4).
