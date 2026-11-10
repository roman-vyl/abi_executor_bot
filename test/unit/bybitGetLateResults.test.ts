import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationService } from "../../src/authorization/authorizationService.js";
import { RestBybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

const payload = { retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lastPrice: "100" }] } };
const reads: [string, (a: RestBybitAdapter) => Promise<unknown>][] = [
  ["server time", a => a.getServerTime()],
  ["instrument info", a => a.getInstrumentInfo("linear", "BTCUSDT")],
  ["price limit", a => a.getOrderPriceLimit("linear", "BTCUSDT")],
  ["market price", a => a.getMarketPrice("BTCUSDT")],
  ["signed active orders", a => a.getActiveOrders({ symbol: "BTCUSDT" })],
];
for (const [name, read] of reads) {
  test(`${name}: retry success is final even when the first fetch later succeeds`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const credentialsSource = new AuthorizationService(async () => "accepted");
    await credentialsSource.authorize({ apiKey: "fake", apiSecret: "fake" });
    const adapter = new RestBybitAdapter(makeTestConfig(), { credentialsSource });
    t.after(() => adapter.close());
    let calls = 0; let lateReads = 0; let cancelled = 0; let late!: (r: Response) => void;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return new Promise<Response>(resolve => { late = resolve; });
      return new Response(JSON.stringify(payload));
    });
    const p = read(adapter);
    t.mock.timers.tick(1500);
    const result = await p;
    assert.deepEqual(result, name === "market price" ? "100" : payload);
    assert.equal(calls, 2);
    late({ text: async () => { lateReads++; return "invalid late payload"; }, body: { cancel: async () => { cancelled++; } } } as unknown as Response);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lateReads, 0); assert.equal(cancelled, 1);
    t.mock.timers.tick(5000); assert.equal(calls, 2);
  });
}

test("a body ignoring abort cannot replace the retry's answer when it later completes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = new RestBybitAdapter(makeTestConfig(), { credentialsSource: { credentials: () => undefined } });
  t.after(() => adapter.close());
  let calls = 0; let releaseBody!: (s: string) => void;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return { text: () => new Promise<string>(r => { releaseBody = r; }), body: { cancel: () => Promise.reject(Error("reader locked")) } } as unknown as Response;
    return new Response(JSON.stringify(payload));
  });
  const p = adapter.getServerTime();
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1500);
  const result = await p;
  assert.deepEqual(result, payload);
  releaseBody("not JSON: parsing this would fail");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(result, payload); assert.equal(calls, 2);
});
