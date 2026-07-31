import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";

test("serializes concurrent calls for the same key", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];

  const task = (name: string, delayMs: number) =>
    mutex.withKeyLock("cycle-1", async () => {
      events.push(`${name}-start`);
      await sleep(delayMs);
      events.push(`${name}-end`);
      return name;
    });

  const [a, b] = await Promise.all([task("a", 30), task("b", 0)]);

  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
});

test("different keys run without waiting on each other", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];

  const task = (key: string, delayMs: number) =>
    mutex.withKeyLock(key, async () => {
      events.push(`${key}-start`);
      await sleep(delayMs);
      events.push(`${key}-end`);
    });

  await Promise.all([task("cycle-1", 30), task("cycle-2", 0)]);

  assert.deepEqual(events, ["cycle-1-start", "cycle-2-start", "cycle-2-end", "cycle-1-end"]);
});

test("a rejected task releases the lock for the next request on the same key", async () => {
  const mutex = new KeyedMutex();

  await assert.rejects(
    mutex.withKeyLock("cycle-1", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  const result = await mutex.withKeyLock("cycle-1", async () => "ok-after-failure");
  assert.equal(result, "ok-after-failure");
});
