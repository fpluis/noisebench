import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskError, runPool } from "../src/task-pool";

const tick = (ms = 1): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("runPool", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 40 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      },
    );
    assert.equal(peak, 4);
  });

  it("processes every item", async () => {
    const seen: number[] = [];
    await runPool(
      Array.from({ length: 25 }, (_, i) => i),
      6,
      async (i) => {
        await tick();
        seen.push(i);
      },
    );
    assert.deepEqual(
      seen.sort((a, b) => a - b),
      Array.from({ length: 25 }, (_, i) => i),
    );
  });

  it("steals work rather than partitioning it up front", async () => {
    // One very slow item must not hold back the other runners: with a static
    // split, the pool would idle behind whichever chunk drew the slow one.
    const done: string[] = [];
    const items = ["slow", "a", "b", "c", "d"];
    await runPool(items, 2, async (item) => {
      await tick(item === "slow" ? 60 : 1);
      done.push(item);
    });
    assert.equal(done[done.length - 1], "slow");
    assert.equal(done.length, 5);
  });

  it("stops claiming new items once shouldStop flips", async () => {
    let processed = 0;
    let stop = false;
    await runPool(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      async () => {
        processed++;
        if (processed >= 5) stop = true;
        await tick();
      },
      () => stop,
    );
    // The runners already in flight finish their current item, so allow slack —
    // the point is that it stopped early, not that it stopped instantly.
    assert.ok(
      processed < 100,
      `expected an early stop, processed ${processed}`,
    );
    assert.ok(processed >= 5);
  });

  it("does not run anything when shouldStop is already true", async () => {
    let processed = 0;
    await runPool(
      [1, 2, 3],
      2,
      async () => {
        processed++;
      },
      () => true,
    );
    assert.equal(processed, 0);
  });

  it("handles an empty item list", async () => {
    let processed = 0;
    await runPool([], 4, async () => {
      processed++;
    });
    assert.equal(processed, 0);
  });
});

describe("classifyTaskError", () => {
  it("treats a check-constraint violation as fatal", () => {
    // 23514 means a forecast whose outcome contradicts its own phrasing reached
    // the insert. Retrying that is 20 models racing to write the same bad row.
    assert.equal(
      classifyTaskError(
        Object.assign(new Error("violates check constraint"), {
          code: "23514",
        }),
      ),
      "fatal",
    );
  });

  it("treats every integrity violation class as fatal", () => {
    for (const code of ["23502", "23503", "23505", "23514"]) {
      assert.equal(
        classifyTaskError(Object.assign(new Error("nope"), { code })),
        "fatal",
        `expected ${code} to be fatal`,
      );
    }
  });

  it("does not mistake an unrelated 2xxxx code for an integrity violation", () => {
    assert.equal(
      classifyTaskError(Object.assign(new Error("x"), { code: "22001" })),
      "unknown",
    );
  });

  it("treats dropped connections as transient", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]) {
      assert.equal(
        classifyTaskError(Object.assign(new Error("socket"), { code })),
        "transient",
        `expected ${code} to be transient`,
      );
    }
  });

  it("recognises pool exhaustion by message", () => {
    assert.equal(
      classifyTaskError(new Error("timeout exceeded when trying to connect")),
      "transient",
    );
    assert.equal(
      classifyTaskError(new Error("Connection terminated unexpectedly")),
      "transient",
    );
  });

  it("falls back to unknown for anything unrecognised", () => {
    assert.equal(classifyTaskError(new Error("something new")), "unknown");
    assert.equal(classifyTaskError("a bare string"), "unknown");
    assert.equal(classifyTaskError(null), "unknown");
    assert.equal(classifyTaskError(undefined), "unknown");
  });
});
