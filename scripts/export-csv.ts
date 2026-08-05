// Export every forecast a run produced to CSV — one file per modality.
//
//   npx tsx scripts/export-csv.ts --run 1
//   npx tsx scripts/export-csv.ts --run 1 --out benchmark_results
//   npx tsx scripts/export-csv.ts --run 1 --with-text
//
// Writes `single.csv` (the `forecast` table — one probability per market) and
// `pairs.csv` (the `pairwise_forecast` table — one head-to-head judgment per
// ordered pair). Each row carries everything needed to trace that one answer
// back to its sources without a database: the market and event slugs, the
// platform, the forecaster's model and wallet, the transaction that recorded it
// on-chain, and the LLM trace it came from.
//
// Unlike `analyze.ts` this aggregates nothing. Rows that never parsed are
// exported too, with an empty `parsed_odds` / `is_a_likelier` — they are part of
// what the run produced, and dropping them would quietly make the export
// disagree with `verify-run.ts` about how big the run was.
//
// The trace's prompts and responses are left out by default: the prompt carries
// the event's research blob, so including all four text columns takes the
// 28-07-26 run's export from 17 MB to 342 MB. `--with-text` appends them for the
// cases that want the full record.

import fs from "fs";
import path from "path";
import { once } from "events";
import { Client } from "pg";
import * as dotenv from "dotenv";
import { parseArgs } from "../src/utils";

dotenv.config();

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://noisebench:noisebench@localhost:5433/noisebench";

// How many rows to hold in memory at once. Keyset-paginated on the primary key
// rather than OFFSET, so the cost of the last page matches the cost of the
// first. Small with text, because those four columns dwarf everything else.
const CHUNK = 2000;
const CHUNK_WITH_TEXT = 250;

// The trace columns every row carries, whichever modality it belongs to. `cost`
// is stored in nano-USD; both forms are written, since the nano value is the
// exact stored integer and the USD one is what a reader actually wants.
const TRACE_COLUMNS = `
       x.llm_trace_id,
       t.identifier                AS trace_identifier,
       tm.name                     AS trace_model,
       tp.name                     AS trace_provider,
       tp.slug                     AS trace_provider_slug,
       t.finish_reason,
       t.attempts,
       t.errors,
       t.tokens_in,
       t.tokens_out,
       t.reasoning_tokens,
       t.time_ms,
       t.cost                      AS cost_nano_usd,
       (t.cost::numeric / 1e9)     AS cost_usd,
       t.created_at                AS trace_created_at`;

// Appended last, so a text-free export is a strict column prefix of a text-heavy
// one and both can be read by the same consumer.
const TEXT_COLUMNS = `
       t.system_prompt,
       t.prompt,
       t.response,
       t.reasoning`;

const traceJoins = (table: string) => `
  LEFT JOIN public.llm_trace t     ON t.id = ${table}.llm_trace_id
  LEFT JOIN public.llm_model tm    ON tm.id = t.llm_model_id
  LEFT JOIN public.llm_provider tp ON tp.id = t.llm_provider_id`;

// The forecaster's identity and its on-chain one. `wallet_predictor_derivation_index`
// is what makes the wallet reproducible from the master mnemonic, so the index
// travels with the address.
const FORECASTER_JOINS = `
  JOIN public.forecaster fc            ON fc.id = x.forecaster_id
  JOIN public.llm_model lm             ON lm.id = fc.forecasting_model_id
  LEFT JOIN public.wallet w            ON w.id = fc.wallet_id
  LEFT JOIN public.wallet_predictor_derivation_index wpdi
         ON wpdi.wallet_id = fc.wallet_id AND wpdi.predictor_id = fc.id`;

const FORECASTER_COLUMNS = `
       x.forecaster_id,
       fc.name                     AS forecaster,
       lm.name                     AS model,
       fc.wallet_id,
       w.address                   AS wallet_address,
       wpdi.derivation_index`;

const TRANSACTION_COLUMNS = `
       x.transaction_id,
       tx.hash                     AS tx_hash,
       tx.block_number             AS tx_block_number,
       tx.chain_id                 AS tx_chain_id,
       x.published_at`;

/**
 * One direct forecast per row: what one model answered about one market in one
 * phrasing on one repetition.
 */
const singleQuery = (withText: boolean): string => `
SELECT x.id                        AS forecast_id,
       x.benchmark_run_id,
       x.created_at,
${FORECASTER_COLUMNS},
       e.id                        AS event_id,
       e.slug                      AS event_slug,
       e.external_id               AS event_external_id,
       e.title                     AS event_title,
       m.id                        AS market_id,
       m.slug                      AS market_slug,
       m.external_id               AS market_external_id,
       m.platform_id,
       m.question                  AS market_question,
       x.prompt_iteration,
       x.is_negated,
       x.outcome,
       x.parsed_odds,
${TRANSACTION_COLUMNS},
${TRACE_COLUMNS}${withText ? `,${TEXT_COLUMNS}` : ""}
  FROM public.forecast x
  JOIN public.market m                 ON m.id = x.market_id
  JOIN public.event e                  ON e.id = x.event_id
${FORECASTER_JOINS}
  LEFT JOIN public.transaction tx      ON tx.id = x.transaction_id
${traceJoins("x")}
 WHERE x.benchmark_run_id = $1 AND x.id > $2
 ORDER BY x.id
 LIMIT $3`;

/**
 * One head-to-head judgment per row. Both sides are spelled out in full — the
 * pair is the unit of analysis here, and a reader that has to join back to a
 * market table to learn what "A" was cannot check the row on its own.
 *
 * `choice` is `is_a_likelier` in the form the prompt used ("A"/"B"), left empty
 * when no usable answer came back — including a refusal to choose, which the
 * registry has no encoding for.
 */
const pairsQuery = (withText: boolean): string => `
SELECT x.id                        AS pairwise_forecast_id,
       x.benchmark_run_id,
       x.created_at,
${FORECASTER_COLUMNS},
       ea.id                       AS event_a_id,
       ea.slug                     AS event_a_slug,
       ea.title                    AS event_a_title,
       ma.id                       AS market_a_id,
       ma.slug                     AS market_a_slug,
       ma.external_id              AS market_a_external_id,
       ma.platform_id              AS market_a_platform_id,
       ma.question                 AS market_a_question,
       eb.id                       AS event_b_id,
       eb.slug                     AS event_b_slug,
       eb.title                    AS event_b_title,
       mb.id                       AS market_b_id,
       mb.slug                     AS market_b_slug,
       mb.external_id              AS market_b_external_id,
       mb.platform_id              AS market_b_platform_id,
       mb.question                 AS market_b_question,
       x.prompt_iteration,
       x.is_a_negated,
       x.is_b_negated,
       x.outcome_a,
       x.outcome_b,
       x.is_a_likelier,
       CASE WHEN x.is_a_likelier IS TRUE THEN 'A'
            WHEN x.is_a_likelier IS FALSE THEN 'B' END AS choice,
${TRANSACTION_COLUMNS},
${TRACE_COLUMNS}${withText ? `,${TEXT_COLUMNS}` : ""}
  FROM public.pairwise_forecast x
  JOIN public.market ma                ON ma.id = x.market_a_id
  JOIN public.event ea                 ON ea.id = ma.event_id
  JOIN public.market mb                ON mb.id = x.market_b_id
  JOIN public.event eb                 ON eb.id = mb.event_id
${FORECASTER_JOINS}
  LEFT JOIN public.transaction tx      ON tx.id = x.transaction_id
${traceJoins("x")}
 WHERE x.benchmark_run_id = $1 AND x.id > $2
 ORDER BY x.id
 LIMIT $3`;

// RFC 4180: quote a field only when it needs it, and double any quote inside.
const escapeField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * Render one value as a CSV field.
 *
 * NUMERIC and BIGINT arrive from pg as strings and are passed through verbatim,
 * so `parsed_odds` and `cost_nano_usd` keep their exact stored precision rather
 * than making a round trip through a float. `errors` is jsonb and stays JSON, so
 * a row that failed several attempts carries all of them in one field.
 */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const writeChunk = async (
  stream: fs.WriteStream,
  text: string,
): Promise<void> => {
  if (!stream.write(text)) await once(stream, "drain");
};

/**
 * Stream one modality to one file, paginating so a run's worth of rows never
 * has to fit in memory at once.
 *
 * Headers come from the result's own field names rather than a hand-maintained
 * list, which is the only way the header line cannot drift out of step with the
 * columns underneath it.
 */
async function exportTable(
  client: Client,
  options: {
    runId: number;
    file: string;
    query: (withText: boolean) => string;
    withText: boolean;
  },
): Promise<number> {
  const { runId, file, query, withText } = options;
  const sql = query(withText);
  const limit = withText ? CHUNK_WITH_TEXT : CHUNK;

  const stream = fs.createWriteStream(file, { encoding: "utf8" });
  let headerWritten = false;
  let lastId = 0;
  let rows = 0;

  try {
    for (;;) {
      const result = await client.query(sql, [runId, lastId, limit]);
      if (result.rows.length === 0) break;

      if (!headerWritten) {
        const headers = result.fields.map((f) => escapeField(f.name));
        await writeChunk(stream, `${headers.join(",")}\n`);
        headerWritten = true;
      }

      const columns = result.fields.map((f) => f.name);
      const lines = result.rows.map((row) =>
        columns.map((c) => escapeField(formatValue(row[c]))).join(","),
      );
      await writeChunk(stream, `${lines.join("\n")}\n`);

      rows += result.rows.length;
      // The first aliased column of both queries is the primary key.
      lastId = Number(result.rows[result.rows.length - 1][columns[0]]);
      if (result.rows.length < limit) break;
    }

    // A run with no rows of one modality still gets a file, but an empty one
    // with no header would be indistinguishable from a failed export.
    if (!headerWritten) {
      const empty = await client.query(sql, [runId, 0, 0]);
      await writeChunk(
        stream,
        `${empty.fields.map((f) => escapeField(f.name)).join(",")}\n`,
      );
    }
  } finally {
    stream.end();
    await once(stream, "close");
  }

  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = Number(args.run ?? 1);
  const outDir = (args.out as string) || "benchmark_results";
  const withText = Boolean(args["with-text"]);

  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(
      "Usage: export-csv.ts --run <id> [--out <dir>] [--with-text]",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const runResult = await client.query(
      `SELECT r.id, r.name, r.dataset_name, r.prompt_iterations,
              r.pairwise_iterations, r.started_at, r.ended_at, s.name AS status
         FROM public.benchmark_run r
         JOIN public.benchmark_status s ON s.id = r.status_id
        WHERE r.id = $1`,
      [runId],
    );
    if (runResult.rowCount === 0) {
      throw new Error(`No benchmark run with id ${runId}`);
    }
    const run = runResult.rows[0];
    console.log(
      `Run ${run.id} — "${run.name}" (${run.status})\n` +
        `  dataset: ${run.dataset_name}\n` +
        `  started: ${new Date(run.started_at).toISOString()}`,
    );

    fs.mkdirSync(outDir, { recursive: true });
    const singleFile = path.join(outDir, "single.csv");
    const pairsFile = path.join(outDir, "pairs.csv");

    const single = await exportTable(client, {
      runId,
      file: singleFile,
      query: singleQuery,
      withText,
    });
    const pairs = await exportTable(client, {
      runId,
      file: pairsFile,
      query: pairsQuery,
      withText,
    });

    // What a reader should know before treating the files as complete: how many
    // rows never produced an answer, and how many never reached the chain. Both
    // are exported; both are empty cells rather than missing rows.
    const gaps = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM public.forecast
                WHERE benchmark_run_id = $1 AND parsed_odds IS NULL) AS unparsed_single,
              (SELECT COUNT(*)::int FROM public.forecast
                WHERE benchmark_run_id = $1 AND transaction_id IS NULL) AS unpublished_single,
              (SELECT COUNT(*)::int FROM public.pairwise_forecast
                WHERE benchmark_run_id = $1 AND is_a_likelier IS NULL) AS unparsed_pairs,
              (SELECT COUNT(*)::int FROM public.pairwise_forecast
                WHERE benchmark_run_id = $1 AND transaction_id IS NULL) AS unpublished_pairs`,
      [runId],
    );
    const g = gaps.rows[0];
    const size = (file: string): string =>
      `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`;

    console.log(
      `\n${singleFile}  ${single} rows, ${size(singleFile)}\n` +
        `  ${g.unparsed_single} with no parsed probability, ` +
        `${g.unpublished_single} with no transaction\n` +
        `${pairsFile}  ${pairs} rows, ${size(pairsFile)}\n` +
        `  ${g.unparsed_pairs} with no judgment, ` +
        `${g.unpublished_pairs} with no transaction`,
    );
    if (!withText) {
      console.log(
        `\nPrompts and responses omitted; re-run with --with-text to include them.`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("\nExport failed:", error);
  process.exit(1);
});
