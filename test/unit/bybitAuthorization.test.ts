import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AuthorizationService } from "../../src/authorization/authorizationService.js";
import { RestBybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

const pair = { apiKey: "confirmed-key", apiSecret: "confirmed-secret" };
const cancel = { category: "linear", symbol: "BTCUSDT", orderLinkId: "x" } as never;
const response = () => new Response(JSON.stringify({ retCode: 0, result: { list: [{ lastPrice: "123" }] } }));

for (const state of ["LOCKED", "VERIFYING", "RETRY_PENDING", "rejected", "missing"] as const) {
  test(`signed GET and POST cannot reach fetch when ${state}`, async () => {
    const auth = new AuthorizationService(async () => state === "VERIFYING"
      ? new Promise<"accepted">(() => undefined)
      : state === "rejected" ? "rejected" : "temporary_failure");
    if (state !== "LOCKED" && state !== "missing") void auth.authorize(pair);
    await Promise.resolve();
    const adapter = new RestBybitAdapter(makeTestConfig({ bybitApiKey: "decoy", bybitApiSecret: "decoy" }),
      state === "missing" ? {} : { credentialsSource: auth });
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return response(); };
    try {
      await assert.rejects(adapter.getAccountInfo(), /authorization is required/);
      await assert.rejects(adapter.cancelOrder(cancel), /authorization is required/);
      assert.equal(calls, 0);
    } finally { globalThis.fetch = original; adapter.close(); }
  });
}

test("the same adapter signs GET and POST only after authorization, using the confirmed pair", async () => {
  const auth = new AuthorizationService(async () => "accepted");
  const adapter = new RestBybitAdapter(makeTestConfig({ bybitApiKey: "decoy", bybitApiSecret: "decoy" }), { credentialsSource: auth });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-BAPI-API-KEY"), pair.apiKey);
    const content = init?.method === "POST" ? String(init.body) : new URL(String(url)).search.slice(1);
    const expected = createHmac("sha256", pair.apiSecret).update(
      `${headers.get("X-BAPI-TIMESTAMP")}${pair.apiKey}${headers.get("X-BAPI-RECV-WINDOW")}${content}`,
    ).digest("hex");
    assert.equal(headers.get("X-BAPI-SIGN"), expected);
    return response();
  };
  try {
    await assert.rejects(adapter.getAccountInfo(), /authorization is required/);
    await auth.authorize(pair);
    await adapter.getActiveOrders({ symbol: "BTCUSDT" });
    await adapter.cancelOrder(cancel);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; adapter.close(); }
});

test("a logical GET snapshots credentials once across its retry", async () => {
  const auth = new AuthorizationService(async () => "accepted");
  await auth.authorize(pair);
  let reads = 0;
  const adapter = new RestBybitAdapter(makeTestConfig(), { credentialsSource: {
    credentials: () => { reads++; return reads === 1 ? auth.credentials() : undefined; },
  } });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("X-BAPI-API-KEY"), pair.apiKey);
    if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return response();
  };
  try {
    await adapter.getAccountInfo();
    assert.equal(calls, 2);
    assert.equal(reads, 1);
  } finally { globalThis.fetch = original; adapter.close(); }
});

test("all public market reads work without credentials and send no authentication headers", async () => {
  const adapter = new RestBybitAdapter(makeTestConfig());
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.ok([...new Headers(init?.headers).keys()].every(key => !key.startsWith("x-bapi-")));
    return response();
  };
  try {
    await adapter.getServerTime();
    await adapter.getInstrumentInfo("linear", "BTCUSDT");
    await adapter.getOrderPriceLimit("linear", "BTCUSDT");
    assert.equal(await adapter.getMarketPrice("BTCUSDT"), "123");
    assert.equal(calls, 4);
  } finally { globalThis.fetch = original; adapter.close(); }
});
