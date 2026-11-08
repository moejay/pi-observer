import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewScheduler } from "../src/scheduler.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const fail = (error: unknown) => assert.fail(String(error));
function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout> | number) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [key, timer] of timers)
        if (timer.at <= now) {
          timers.delete(key);
          timer.fn();
        }
    },
  };
}

test("periodic cadence, settled tail, cooldown and no duplicate settled review", async () => {
  const time = clock();
  const seen: string[] = [];
  const scheduler = new ReviewScheduler(
    { everyTurns: 5, minIntervalSeconds: 30 },
    async (c) => {
      seen.push(c.anchor);
    },
    fail,
    undefined,
    {},
    time,
  );
  scheduler.request({ anchor: "4", turns: 4 }, "periodic");
  await tick();
  assert.deepEqual(seen, []);
  scheduler.request({ anchor: "5", turns: 5 }, "periodic");
  await tick();
  assert.deepEqual(seen, ["5"]);
  scheduler.request({ anchor: "6", turns: 6 }, "settled");
  await tick();
  assert.deepEqual(seen, ["5"]);
  time.advance(30_000);
  await tick();
  assert.deepEqual(seen, ["5", "6"]);
  scheduler.request({ anchor: "6", turns: 6 }, "settled");
  time.advance(30_000);
  await tick();
  assert.deepEqual(seen, ["5", "6"]);
  scheduler.stop();
});

test("single flight coalesces to latest pending checkpoint", async () => {
  let finish: (() => void) | undefined;
  const seen: string[] = [];
  const scheduler = new ReviewScheduler(
    { everyTurns: 1, minIntervalSeconds: 0 },
    async (c) => {
      seen.push(c.anchor);
      if (c.anchor === "1")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    },
    fail,
  );
  scheduler.request({ anchor: "1", turns: 1 }, "periodic");
  await tick();
  scheduler.request({ anchor: "2", turns: 2 }, "periodic");
  scheduler.request({ anchor: "3", turns: 3 }, "settled");
  assert.deepEqual(seen, ["1"]);
  finish!();
  await tick();
  assert.deepEqual(seen, ["1", "3"]);
  scheduler.stop();
});

test("manual bypasses cooldown; failures are handled without retry loops", async () => {
  const time = clock();
  let attempts = 0;
  let errors = 0;
  const scheduler = new ReviewScheduler(
    { everyTurns: 1, minIntervalSeconds: 30 },
    async () => {
      attempts++;
      throw Error("bad");
    },
    () => {
      errors++;
    },
    undefined,
    {},
    time,
  );
  scheduler.request({ anchor: "1", turns: 1 }, "settled");
  await tick();
  scheduler.request({ anchor: "1", turns: 1 }, "settled");
  await tick();
  assert.equal(attempts, 1);
  scheduler.request({ anchor: "1", turns: 1 }, "manual");
  await tick();
  assert.equal(attempts, 2);
  assert.equal(errors, 2);
  scheduler.stop();
});

test("stop aborts in-flight and drops pending timers/work", async () => {
  const time = clock();
  let signal: AbortSignal | undefined;
  const scheduler = new ReviewScheduler(
    { everyTurns: 1, minIntervalSeconds: 30 },
    async (_c, s) => {
      signal = s;
    },
    fail,
    undefined,
    {},
    time,
  );
  scheduler.request({ anchor: "1", turns: 1 }, "settled");
  await tick();
  scheduler.request({ anchor: "2", turns: 2 }, "settled");
  scheduler.stop();
  time.advance(30_000);
  await tick();
  assert.equal(signal?.aborted, false); // first completed request has already released its controller
  assert.equal(scheduler.running, false);
});

test("stop cancels an active request without reporting an error", async () => {
  let aborted = false;
  const scheduler = new ReviewScheduler(
    { everyTurns: 1, minIntervalSeconds: 0 },
    async (_c, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
    fail,
  );
  scheduler.request({ anchor: "1", turns: 1 }, "manual");
  await tick();
  scheduler.stop();
  await tick();
  assert.equal(aborted, true);
});
