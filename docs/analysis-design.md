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
correctness fix. The site reports the clipped count next to every log-odds
figure.

A third, purely presentational readout for cell-level tooltips: **spread ratio**
`max(p)/min(p)` within the cell, which is what makes the "this model's forecast
for a rare event varied 5×" claim legible without teaching the reader logits.

---

## 2. Goal 1 — the noise decomposition

### 2.1 One model, all of goals 1 and 2

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

## 3. Goal 3 — market-level noise

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

## 4. Goal 2 — the Yes/No result, and its confound

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

Global: mean base parse 0.2648, mean negated parse 0.3518, **sum 0.617**. The
grand mean on the Yes scale is 0.46 where coherence forces 0.50. Broken out by
market midpoint:

| midpoint band | n   | mean midpoint | base  | negated | sum   | gap        |
| ------------- | --- | ------------- | ----- | ------- | ----- | ---------- |
| 0.00–0.05     | 18  | 0.032         | 0.056 | 0.219   | 0.275 | **−0.725** |
| 0.05–0.10     | 18  | 0.071         | 0.067 | 0.234   | 0.301 | **−0.699** |
| 0.10–0.25     | 20  | 0.158         | 0.146 | 0.369   | 0.515 | −0.485     |
| 0.25–0.50     | 17  | 0.365         | 0.378 | 0.448   | 0.826 | −0.174     |
| 0.50–0.75     | 17  | 0.601         | 0.466 | 0.530   | 0.996 | −0.004     |
| 0.75–1.00     | 10  | 0.869         | 0.692 | 0.299   | 0.991 | −0.009     |

The effect is **entirely concentrated in low-probability markets** and vanishes
above 0.50. Asked "Will Trump fail to acquire Greenland before 2027?" the panel
says 0.193. Asked "Will Jesus Christ not return before 2027?" it says 0.049.

### 4.3 Interpretation

The effect is a genuine failure to re-orient to a negated frame: models retrieve
the salient event's base rate and report it, largely regardless of which
direction the question points. It is strongest exactly where the base rate is
most lopsided and therefore where getting the direction right matters most.

Ruled out as an explanation (F5): text-level tension between a negated question
and a description that hardcodes a Yes/No mapping. Measured, and it does not
moderate the gap once midpoint is controlled.

Worth showing alongside, because it is the same question asked without any
absolute probability at all: the pairwise couple identities (§6), which are
violated at 42.4% and 47.2% against a 50% chance baseline. Two independent
modalities agreeing that negation handling collapses is a far stronger result
than either alone, and the site should present them as a pair.

A useful secondary cut: the gap is the _sum_ deviating from 1, so split it into
which arm moves. §4.2's base column tracks midpoints closely (0.056 vs 0.032,
0.146 vs 0.158) while the negated arm is far off (0.219 where ~0.97 is implied).
The failure is almost entirely in the negated arm, not shared between them —
which is itself the evidence for the base-rate-retrieval reading.

---

## 5. Goal 6 — ranking vs the market snapshot

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

## 6. Goal 4 — pairwise consistency

### 6.1 A correction to the stated goal

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
   vs 1. Pure occasion noise in the ranking modality. Measured: **15.1%** flip
   rate over 3,973 comparable cells.
2. **Couple violation** — the §6.1 identities. Measured: **42.4%** on
   (A,B)/(¬A,¬B) and **47.2%** on (¬A,B)/(A,¬B), n = 1,986 each. Chance is 50%.
   Models are close to **indistinguishable from coin-flipping** on the one
   identity that holds regardless of what they believe.
3. **Position bias** — not measurable, F2. Report as a known gap.

Both 1 and 2 break down per model and per pair. Guard against the trap: a model
that always answers "A" scores 0% repetition instability and 100% couple
violation, so the two must be shown together, with the A-rate alongside.

---

## 7. Goal 5 — direct vs pairwise agreement

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

## 8. Goal 7 — inference properties

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

## 9. Build plan

```
migrations/05_market_snapshot.sql   run-scoped midpoint/spread/liquidity (§5)
scripts/backfill-snapshot.ts        populate it from the dataset JSON
scripts/analyze.ts                  SQL → TS → site/data/*.json
site/index.html + one page per goal
site/data/*.json                    committed, so the site opens with no DB
```

`analyze.ts` does the SQL in Postgres for aggregation that SQL is good at
(counts, joins, per-cell means) and the decomposition arithmetic in TypeScript,
where the means-of-means and unbalanced-cell handling stay readable. It writes
static JSON; the site is plain HTML with inline JS and no build step, served by
`npx serve site` or opened from disk. That keeps the eventual hosting step to a
file copy.

Everything above is derived per-model **and** globally, per goal 1–7.

## 10. Open gaps to fix in the next run

- Reversed pairs, so position bias becomes measurable (F2).
- A complete pair matching, or an explicit note that it is not one (F1).
- Snapshot prices written to the DB at run time (F3).
- Investigate `claude-sonnet-5`'s 11% failure rate before it is compared to
  models with 0% (F4).
