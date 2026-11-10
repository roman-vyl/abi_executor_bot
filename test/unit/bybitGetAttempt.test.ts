import assert from "node:assert/strict";
import test from "node:test";
import { runBybitGetAttempt } from "../../src/exchange/bybitGetAttempt.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const isTimeout = (e: Error) => e.name === "TimeoutError";

for (const late of ["success", "rejection"] as const) {
  test(`a fetch ignoring abort settles at deadline; late ${late} is isolated`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fetch = deferred<Response>();
    let signal: AbortSignal | undefined;
    let reads = 0; let parses = 0; let cancelled = 0;
    const p = runBybitGetAttempt(s => { signal = s; return fetch.promise; }, 1500, () => { parses++; });
    const failed = assert.rejects(p, isTimeout);
    t.mock.timers.tick(1500);
    await failed;
    assert.equal(signal?.aborted, true);
    if (late === "success") fetch.resolve({ text: async () => { reads++; return "{}"; }, body: { cancel: async () => { cancelled++; } } } as unknown as Response);
    else fetch.reject(new Error("late transport failure"));
    await turn();
    assert.equal(reads, 0); assert.equal(parses, 0);
    assert.equal(cancelled, late === "success" ? 1 : 0);
  });
}

for (const late of ["success", "rejection"] as const) {
  test(`body ignoring abort cannot publish a late ${late}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const body = deferred<string>(); let parses = 0;
    const p = runBybitGetAttempt(async () => ({ text: () => body.promise, body: { cancel: () => new Promise(() => {}) } } as unknown as Response), 1500, () => { parses++; });
    await turn();
    const failed = assert.rejects(p, isTimeout);
    t.mock.timers.tick(1500); await failed;
    if (late === "success") body.resolve("{}"); else body.reject(new Error("late body failure"));
    await turn(); assert.equal(parses, 0);
  });
}

for (const cleanup of ["throws", "rejects", "hangs"] as const) {
  test(`body cancellation that ${cleanup} cannot retain the expired caller`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = runBybitGetAttempt(async () => ({ text: () => new Promise(() => {}), body: { cancel: () => {
      if (cleanup === "throws") throw Error("cancel failed");
      if (cleanup === "rejects") return Promise.reject(Error("cancel failed"));
      return new Promise(() => {});
    } } } as unknown as Response), 1500, () => assert.fail("late decode"));
    await turn(); const failed = assert.rejects(p, isTimeout);
    t.mock.timers.tick(1500); await failed; await turn();
  });
}

test("a late body is rejected even if the timeout callback has not run", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = deferred<string>(); let parses = 0;
  const p = runBybitGetAttempt(async () => ({ text: () => body.promise } as Response), 1500, () => { parses++; });
  const failed = assert.rejects(p, isTimeout); await turn();
  now = 1500; body.resolve("{}"); await failed; assert.equal(parses, 0);
});

test("success just before deadline wins once, clears its timer and is never aborted", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal; const body = deferred<string>();
  const p = runBybitGetAttempt(async s => { signal = s; return { text: () => body.promise } as Response; }, 1500, (_r, text) => JSON.parse(text));
  await turn(); now = 1499; body.resolve('{"answer":42}');
  assert.deepEqual(await p, { answer: 42 });
  t.mock.timers.tick(5000); assert.equal(signal.aborted, false);
});

test("expiry during synchronous decode rejects the result", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  await assert.rejects(runBybitGetAttempt(async () => ({ text: async () => "{}" } as Response), 1500, () => { now = 1500; return {}; }), isTimeout);
});

test("transport and decoder errors remain the original errors", async () => {
  const error = Error("original failure");
  await assert.rejects(runBybitGetAttempt(async () => { throw error; }, 1500, () => ({})), e => e === error);
  await assert.rejects(runBybitGetAttempt(async () => ({ text: async () => "{}" } as Response), 1500, () => { throw error; }), e => e === error);
});
