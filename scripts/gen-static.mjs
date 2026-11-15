// Writes the results into the HTML, so search engines and AI crawlers that do
// not run JavaScript still read them, and writes site/llms.txt.
//
//   npm run static
//
// The charts still draw from site/data/*.json in the browser; this only fills
// the blocks between <!-- static:NAME --> and <!-- /static:NAME --> markers:
//
//   index.html   summary   one-paragraph answer plus the ranking table
//                faq       questions people ask, answered from the data
//                faq-ld    the same questions as FAQPage JSON-LD
//   markets.html markets   every question as a plain table (the sortable
//                          table replaces it once the script runs)
//
// It also sets the Dataset's dateModified and temporalCoverage from the run. Plain Node,
// no dependencies, so the deploy workflow runs it before every upload and the
// pages can never ship out of step with the data. Running it twice changes
// nothing.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SITE = path.resolve("site");
const ORIGIN = "https://noisebench.com";

// The labels and number formats the charts use, so the text matches them.
const viz = await import(
  pathToFileURL(path.join(SITE, "assets", "viz.js")).href
);
const { shortModel, vendorName, pct, usd } = viz;

const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(SITE, "data", name), "utf8"));
const metrics = read("metrics.json");
const run = read("run.json");

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const day = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const models = [...metrics.models].sort((a, b) => a.noise - b.noise);
const vendorOf = (m) => vendorName(m.model.split("/")[0]);
const label = (m) => `${shortModel(m.model)} (${vendorOf(m)})`;
const answers = models.reduce((s, m) => s + m.forecasts + m.judgments, 0);
const best = models[0];
const worst = models[models.length - 1];
const cheapest = [...models]
  .filter((m) => m.priced)
  .sort((a, b) => a.costPerAnswer - b.costPerAnswer)[0];
const ended = day(run.endedAt);
const scope = `${models.length} AI models, ${metrics.byMarket.length} Polymarket questions and ${answers.toLocaleString("en-US")} answers`;

const summaryText =
  `In the latest run (finished ${ended}; ${scope}), the least noisy forecaster was ${label(best)} ` +
  `with a noise score of ${pct(best.noise, 1)}, and the noisiest was ${label(worst)} at ${pct(worst.noise, 1)}. ` +
  `The average across all models was ${pct(metrics.field.noise, 1)}. Lower is better: 0% means a model ` +
  `gave the same answer every time it was asked, in every wording.`;

// ------------------------------------------------------------------ blocks --

const summary = `
      <section>
        <h2>Results at a glance</h2>
        <p class="lede">${esc(summaryText)}</p>
        <div class="table-wrap">
          <table class="prose">
            <caption class="sr-only">Noise score per model, least noisy first</caption>
            <thead><tr><th class="num">Rank</th><th>Model</th><th>Maker</th><th class="num">Noise</th><th class="num">Cost per answer</th></tr></thead>
            <tbody>
${models
  .map(
    (m, i) =>
      `              <tr><td class="num">${i + 1}</td><td>${esc(shortModel(m.model))}</td><td>${esc(vendorOf(m))}</td><td class="num">${pct(m.noise, 1)}</td><td class="num">${!m.priced ? "—" : usd(m.costPerAnswer)}</td></tr>`,
  )
  .join("\n")}
            </tbody>
          </table>
        </div>
      </section>
      `;

const faqItems = [
  {
    q: "What is noisebench?",
    a: `An open benchmark that measures judgment noise in AI forecasters. Every model answers the same live Polymarket questions several times, in the Yes and the No wording, and ranks pairs of markets in all four negation combinations. Noise is whatever changes when nothing should.`,
  },
  {
    q: "Which AI model is the least noisy forecaster?",
    a: `${label(best)}, with a noise score of ${pct(best.noise, 1)} in the run that finished ${ended}. The next two were ${label(models[1])} (${pct(models[1].noise, 1)}) and ${label(models[2])} (${pct(models[2].noise, 1)}).`,
  },
  {
    q: "Which AI model is the noisiest forecaster?",
    a: `${label(worst)}, at ${pct(worst.noise, 1)}, ahead of ${label(models[models.length - 2])} (${pct(models[models.length - 2].noise, 1)}).`,
  },
  {
    q: "How is the noise score calculated?",
    a: `It is the simple average of five measures: ${metrics.components.map((c) => c.label.toLowerCase()).join(", ")}. None of them needs to know the right answer: each one checks whether a model contradicts itself.`,
  },
  {
    q: "Does a low noise score mean a model forecasts accurately?",
    a: "No. A model can give the same wrong answer every time and score 0% noise. Noise measures internal consistency, not accuracy; the Markets page compares the panel's odds with the market price.",
  },
  {
    q: "Which model gives the most consistency for the money?",
    a: `${label(cheapest)} was the cheapest, at ${usd(cheapest.costPerAnswer)} per answer, with a noise score of ${pct(cheapest.noise, 1)}. The Compare page plots noise against cost for every model.`,
  },
];

const faq = `
      <section>
        <h2>Questions</h2>
        <dl class="faq">
${faqItems.map((f) => `          <dt>${esc(f.q)}</dt>\n          <dd>${esc(f.a)}</dd>`).join("\n")}
        </dl>
      </section>
      `;

const faqLd = `
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "@id": `${ORIGIN}/#faq`,
        mainEntity: faqItems.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      })}
    </script>
    `;

const markets = `
            <table>
              <thead><tr><th>Question</th><th class="num">Market midpoint</th><th class="num">Panel estimate</th><th class="num">Odds spread</th></tr></thead>
              <tbody>
${[...metrics.byMarket]
  .sort((a, b) => (b.midpoint ?? -1) - (a.midpoint ?? -1))
  .map(
    (m) =>
      `                <tr><td>${esc(m.question || m.slug)}</td><td class="num">${m.midpoint === null ? "—" : pct(m.midpoint, 1)}</td><td class="num">${pct(m.modelEstimate, 1)}</td><td class="num">${pct(m.averageError, 1)}</td></tr>`,
  )
  .join("\n")}
              </tbody>
            </table>
          `;

// ------------------------------------------------------------------- write --

const fill = (file, blocks) => {
  const full = path.join(SITE, file);
  let html = fs.readFileSync(full, "utf8");
  for (const [name, content] of Object.entries(blocks)) {
    const re = new RegExp(
      `(<!-- static:${name} -->)[\\s\\S]*?(<!-- /static:${name} -->)`,
    );
    if (!re.test(html))
      throw new Error(`${file}: no <!-- static:${name} --> marker`);
    html = html.replace(re, (_, open, close) => `${open}${content}${close}`);
  }
  // The Dataset's last change is the end of the run it describes.
  html = html.replace(
    /("dateModified":\s*")[^"]*(")/,
    `$1${run.endedAt.slice(0, 10)}$2`,
  );
  html = html.replace(
    /("temporalCoverage":\s*")[^"]*(")/,
    `$1${run.startedAt.slice(0, 10)}/${run.endedAt.slice(0, 10)}$2`,
  );
  fs.writeFileSync(full, html);
  console.log(`wrote ${file}`);
};

fill("index.html", { summary, faq, "faq-ld": faqLd });
fill("markets.html", { markets });

// llms.txt: a plain-text map of the site for AI assistants (llmstxt.org).
const llms = `# noisebench

> ${summaryText}

noisebench is an open benchmark of judgment noise in large language models used as forecasters. Each model is asked the same live Polymarket questions repeatedly, in both the Yes and the No wording, and is asked which of two markets is likelier in all four negation combinations of the pair. Made by Luis Fominaya Parra (https://luisfominaya.com/). MIT licensed.

## Pages

- [Overview](${ORIGIN}/): the Noise Index, its five parts, and noise against cost.
- [Compare](${ORIGIN}/compare): two models side by side.
- [Markets](${ORIGIN}/markets): every question, the panel's odds against the market price.
- [Details](${ORIGIN}/details): methodology and the five measures.

## Ranking (least noisy first)

${models.map((m, i) => `${i + 1}. ${shortModel(m.model)} (${vendorOf(m)}): noise ${pct(m.noise, 1)}, ${!m.priced ? "cost unknown" : `${usd(m.costPerAnswer)} per answer`}`).join("\n")}

## Data

- [metrics.json](${ORIGIN}/data/metrics.json): per-model and per-question metrics.
- [negation.json](${ORIGIN}/data/negation.json): negation breakdown.
- [noise.json](${ORIGIN}/data/noise.json): noise scales and subsets.
- [run.json](${ORIGIN}/data/run.json): run configuration.
- [Hugging Face dataset](https://huggingface.co/datasets/fpluis/noisebench): the same data as a Hugging Face dataset.
- [Source code](https://github.com/fpluis/noisebench): the benchmark and this site.
`;
fs.writeFileSync(path.join(SITE, "llms.txt"), llms);
console.log("wrote llms.txt");
