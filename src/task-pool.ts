// Bounded concurrency and task-failure classification.
//
// These live here rather than in `scripts/benchmark.ts` so they can be tested
// without importing an entry point that runs a benchmark on import.

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * Work is claimed by index rather than partitioned up front, so a fast item
 * finishing frees its slot immediately. That is the property that matters when
 * the items are models whose speeds differ by an order of magnitude: a static
 * split would leave the pool idle behind whichever chunk drew the slow ones.
 *
 * `shouldStop` is checked between items, so a pool can be abandoned without
 * waiting for everything already dispatched.
 *
 * Workers are expected NOT to throw. A rejection rejects the returned promise
 * while the sibling coroutines keep looping — which is how a benchmark run
 * could mark itself failed, close its connection pool, and then keep trying to
 * write rows through it. Callers absorb failure inside the worker instead.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (index < items.length) {
        if (shouldStop?.()) return;
        const current = items[index++];
        await worker(current);
      }
    },
  );
  await Promise.all(runners);
}

/**
 * What to do about a task that threw after inference had already returned.
 *
 * The distinction that matters is between "the database blinked" and "the
 * database refused the row". Retrying the first is free. Retrying the second is
 * every model in the run hammering a constraint that is telling us the code is
 * wrong — and an integrity violation on a forecast means a row whose outcome
 * contradicts its own phrasing reached the insert, which is exactly the
 * corruption the schema constraints exist to stop. That ends the run.
 *
 * Anything unrecognised is neither retried nor fatal: it is logged, counted
 * against the model's failure budget, and left for a later pass.
 */
export type TaskErrorKind = "transient" | "fatal" | "unknown";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

const TRANSIENT_MESSAGES = [
  "connection terminated",
  "connection reset",
  "timeout exceeded",
  "timeout expired",
  "too many clients",
  "server closed the connection",
];

export function classifyTaskError(error: unknown): TaskErrorKind {
  const e = error as { code?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";

  // Postgres integrity violations — 23514 check, 23502 not-null, 23503 foreign
  // key, 23505 unique. None of them survive a retry.
  if (/^23\d{3}$/.test(code)) return "fatal";

  if (TRANSIENT_CODES.has(code.toUpperCase())) return "transient";

  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  if (TRANSIENT_MESSAGES.some((m) => message.includes(m))) return "transient";

  return "unknown";
}
