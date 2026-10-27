import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config/config.js";
import { RestBybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

type FetchCall = { url: string; method: string; timestamp: string | undefined; signal: AbortSignal | undefined };
type Step = "hang" | "ok" | "fail";

// Replaces global fetch with a scripted sequence. "hang" never answers and
// rejects only when the request's own AbortSignal fires.
function scriptFetch(steps: Step[]): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  // AbortSignal.timeout timers do not keep the event loop alive on their own
  // (a running server does); hold it open while a scripted request hangs.
  const keepAlive = setInterval(() => undefined, 1_000);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      timestamp: headers["X-BAPI-TIMESTAMP"],
      signal: init?.signal ?? undefined,
    });
    const step = steps[calls.length - 1] ?? "ok";
    if (step === "fail") {
      throw new TypeError("fetch failed");
    }
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: [] } }), { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      clearInterval(keepAlive);
      globalThis.fetch = original;
    },
  };
}

function adapter(readTimeoutMs = 50): RestBybitAdapter {
  return new RestBybitAdapter(
    makeTestConfig({ bybitApiKey: "key", bybitApiSecret: "secret", bybitReadTimeoutMs: readTimeoutMs }),
  );
}

test("ABI_BYBIT_READ_TIMEOUT_MS defaults to 1500 and is configurable", () => {
  assert.equal(loadConfig({}).bybitReadTimeoutMs, 1_500);
  assert.equal(loadConfig({ ABI_BYBIT_READ_TIMEOUT_MS: "2500" }).bybitReadTimeoutMs, 2_500);
  assert.equal(loadConfig({}).bybitRequestTimeoutMs, 10_000);
});

test("a GET that hangs past the read timeout is retried once and its answer returned", async () => {
  const fake = scriptFetch(["hang", "ok"]);
  try {
    const started = Date.now();
    const body = await adapter().getActiveOrders({ symbol: "BTCUSDT" });
    assert.deepEqual(body, { retCode: 0, retMsg: "OK", result: { list: [] } });
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls.every((call) => call.method === "GET" && call.url.includes("/v5/order/realtime")));
    assert.ok(Date.now() - started < 1_000);
  } finally {
    fake.restore();
  }
});

test("each signed GET attempt carries its own fresh timestamp and signal", async () => {
  const fake = scriptFetch(["hang", "ok"]);
  try {
    await adapter(30).getActiveOrders({ symbol: "BTCUSDT" });
    assert.equal(fake.calls.length, 2);
    assert.notEqual(fake.calls[0]?.signal, fake.calls[1]?.signal);
    assert.ok(Number(fake.calls[1]?.timestamp) >= Number(fake.calls[0]?.timestamp) + 30);
  } finally {
    fake.restore();
  }
});

test("a GET that times out twice fails with the timeout error after exactly two attempts", async () => {
  const fake = scriptFetch(["hang", "hang", "ok"]);
  try {
    await assert.rejects(adapter().getActiveOrders({ symbol: "BTCUSDT" }), (error: Error) => error.name === "TimeoutError");
    assert.equal(fake.calls.length, 2);
  } finally {
    fake.restore();
  }
});

test("a GET that fails for a reason other than a timeout is not retried", async () => {
  const fake = scriptFetch(["fail", "ok"]);
  try {
    await assert.rejects(adapter().getActiveOrders({ symbol: "BTCUSDT" }), /fetch failed/);
    assert.equal(fake.calls.length, 1);
  } finally {
    fake.restore();
  }
});

test("public GETs use the same read timeout and single retry", async () => {
  const fake = scriptFetch(["hang", "ok"]);
  try {
    await adapter().getInstrumentInfo("linear", "BTCUSDT");
    assert.equal(fake.calls.length, 2);
  } finally {
    fake.restore();
  }
});

test("a POST is never retried and keeps the long request timeout", async () => {
  const fake = scriptFetch(["fail", "ok"]);
  try {
    await assert.rejects(
      adapter().cancelOrder({ category: "linear", symbol: "BTCUSDT", orderLinkId: "x" } as never),
      /fetch failed/,
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.method, "POST");
  } finally {
    fake.restore();
  }
});

test("a POST that takes longer than the read timeout is not cut by it", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 120);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
    return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const body = await adapter(50).cancelOrder({ category: "linear", symbol: "BTCUSDT", orderLinkId: "x" } as never);
    assert.deepEqual(body, { retCode: 0, retMsg: "OK", result: {} });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
