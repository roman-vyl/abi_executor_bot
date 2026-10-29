import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";

import { loadConfig } from "../../src/config/config.js";
import { RestBybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { BybitConnectionHeartbeat } from "../../src/exchange/bybitConnectionHeartbeat.js";
import { makeTestConfig } from "../fixtures/config.js";

const OK_BODY = { retCode: 0, retMsg: "OK", result: {} };

function keyedConfig(overrides: Parameters<typeof makeTestConfig>[0] = {}) {
  return makeTestConfig({ bybitApiKey: "key", bybitApiSecret: "secret", bybitReadTimeoutMs: 500, ...overrides });
}

// Scripted global fetch: each step either answers or throws a fetch failure
// whose cause carries the given socket error code.
function scriptFetch(steps: Array<"ok" | { code?: string }>): {
  calls: Array<{ method: string; dispatcher: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; dispatcher: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher });
    const step = steps[calls.length - 1] ?? "ok";
    if (step !== "ok") {
      const cause = step.code === undefined ? new Error("boom") : Object.assign(new Error("socket"), { code: step.code });
      throw new TypeError("fetch failed", { cause });
    }
    return new Response(JSON.stringify(OK_BODY), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const cancelPayload = { category: "linear", symbol: "BTCUSDT", orderLinkId: "x" } as never;

test("keep-alive and heartbeat settings default to 200 s and 60 s and are validated", () => {
  assert.equal(loadConfig({}).bybitKeepAliveTimeoutMs, 200_000);
  assert.equal(loadConfig({}).bybitHeartbeatIntervalMs, 60_000);
  assert.equal(loadConfig({ ABI_BYBIT_KEEPALIVE_TIMEOUT_MS: "150000" }).bybitKeepAliveTimeoutMs, 150_000);
  assert.equal(loadConfig({ ABI_BYBIT_HEARTBEAT_INTERVAL_MS: "0" }).bybitHeartbeatIntervalMs, 0);
  assert.throws(() => loadConfig({ ABI_BYBIT_KEEPALIVE_TIMEOUT_MS: "0" }), /ABI_BYBIT_KEEPALIVE_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ABI_BYBIT_KEEPALIVE_TIMEOUT_MS: "abc" }), /ABI_BYBIT_KEEPALIVE_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ABI_BYBIT_HEARTBEAT_INTERVAL_MS: "-1" }), /ABI_BYBIT_HEARTBEAT_INTERVAL_MS/);
  assert.throws(() => loadConfig({ ABI_BYBIT_HEARTBEAT_INTERVAL_MS: "1m" }), /ABI_BYBIT_HEARTBEAT_INTERVAL_MS/);
});

test("every GET and POST of the adapter goes through the same pool", async () => {
  const fake = scriptFetch(["ok", "ok", "ok", "ok"]);
  const adapter = new RestBybitAdapter(keyedConfig());
  try {
    await adapter.getServerTime();
    await adapter.getActiveOrders({ symbol: "BTCUSDT" });
    await adapter.getInstrumentInfo("linear", "BTCUSDT");
    await adapter.cancelOrder(cancelPayload);
    assert.equal(fake.calls.length, 4);
    assert.ok(fake.calls[0]?.dispatcher !== undefined);
    assert.ok(fake.calls.every((call) => call.dispatcher === fake.calls[0]?.dispatcher));
  } finally {
    fake.restore();
    adapter.close();
  }
});

for (const code of ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]) {
  test(`a GET whose connection broke (${code}) is retried once`, async () => {
    const fake = scriptFetch([{ code }, "ok"]);
    const adapter = new RestBybitAdapter(keyedConfig());
    try {
      assert.deepEqual(await adapter.getActiveOrders({ symbol: "BTCUSDT" }), OK_BODY);
      assert.equal(fake.calls.length, 2);
      assert.equal(adapter.takeConnectionCounters().getRetriesConnectionClosed, 1);
    } finally {
      fake.restore();
      adapter.close();
    }
  });
}

for (const code of ["ENOTFOUND", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", undefined]) {
  test(`a GET failing with ${code ?? "a plain fetch failure"} is not retried`, async () => {
    const fake = scriptFetch([{ code }, "ok"]);
    const adapter = new RestBybitAdapter(keyedConfig());
    try {
      await assert.rejects(adapter.getActiveOrders({ symbol: "BTCUSDT" }), /fetch failed/);
      assert.equal(fake.calls.length, 1);
    } finally {
      fake.restore();
      adapter.close();
    }
  });
}

test("a GET answered with HTTP 403 or a Bybit error code is not retried", async () => {
  const original = globalThis.fetch;
  const adapter = new RestBybitAdapter(keyedConfig());
  let calls = 0;
  const answers = [
    new Response("forbidden", { status: 403 }),
    new Response(JSON.stringify({ retCode: 10002, retMsg: "bad", result: {} }), { status: 200 }),
  ];
  globalThis.fetch = (async () => {
    calls += 1;
    return answers.shift() ?? new Response(JSON.stringify(OK_BODY));
  }) as typeof fetch;
  try {
    await assert.rejects(adapter.getActiveOrders({ symbol: "BTCUSDT" }));
    assert.equal(calls, 1);
    await assert.rejects(adapter.getActiveOrders({ symbol: "BTCUSDT" }));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    adapter.close();
  }
});

test("a GET that breaks twice fails with the second error after exactly two attempts", async () => {
  const fake = scriptFetch([{ code: "ECONNRESET" }, { code: "UND_ERR_SOCKET" }, "ok"]);
  const adapter = new RestBybitAdapter(keyedConfig());
  try {
    await assert.rejects(
      adapter.getActiveOrders({ symbol: "BTCUSDT" }),
      (error: Error) => (error.cause as { code?: string }).code === "UND_ERR_SOCKET",
    );
    assert.equal(fake.calls.length, 2);
  } finally {
    fake.restore();
    adapter.close();
  }
});

test("a POST on a broken connection is sent exactly once", async () => {
  const fake = scriptFetch([{ code: "UND_ERR_SOCKET" }, "ok"]);
  const adapter = new RestBybitAdapter(keyedConfig());
  try {
    await assert.rejects(adapter.cancelOrder(cancelPayload), /fetch failed/);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.method, "POST");
  } finally {
    fake.restore();
    adapter.close();
  }
});

// A real local HTTP server, so the undici pool itself is exercised.
async function localServer(
  handle: (request: IncomingMessage, response: ServerResponse, requestOnSocket: number) => void,
): Promise<{ baseUrl: string; connections: () => number; requests: () => number; server: Server }> {
  let connections = 0;
  let requests = 0;
  const perSocket = new WeakMap<Socket, number>();
  const server = createServer((request, response) => {
    requests += 1;
    const n = (perSocket.get(request.socket) ?? 0) + 1;
    perSocket.set(request.socket, n);
    request.resume();
    request.on("end", () => handle(request, response, n));
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, connections: () => connections, requests: () => requests, server };
}

// undici returns a socket to the pool just after the body is read; a short
// pause keeps back-to-back test requests from racing a second connection open.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function answerOk(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(OK_BODY));
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("requests within the idle limit reuse one connection", async () => {
  const local = await localServer((_request, response) => answerOk(response));
  const adapter = new RestBybitAdapter(keyedConfig(), { baseUrl: local.baseUrl });
  try {
    await adapter.getServerTime();
    await settle();
    await adapter.getServerTime();
    await settle();
    await adapter.getActiveOrders({ symbol: "BTCUSDT" });
    assert.equal(local.requests(), 3);
    assert.equal(local.connections(), 1);
    assert.equal(adapter.takeConnectionCounters().newConnections, 1);
  } finally {
    adapter.close();
    await stopServer(local.server);
  }
});

test("after the server closes an idle connection the next request opens a new one", async () => {
  const local = await localServer((_request, response) => answerOk(response));
  local.server.keepAliveTimeout = 50;
  const adapter = new RestBybitAdapter(keyedConfig(), { baseUrl: local.baseUrl });
  try {
    await adapter.getServerTime();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await adapter.getServerTime(), OK_BODY);
    assert.equal(local.connections(), 2);
    assert.equal(local.requests(), 2);
  } finally {
    adapter.close();
    await stopServer(local.server);
  }
});

test("a GET whose reused connection is dropped succeeds on the retry; a POST fails once", async () => {
  // The server drops every connection on its second request.
  const local = await localServer((request, response, requestOnSocket) => {
    if (requestOnSocket >= 2) {
      request.socket.destroy();
      return;
    }
    answerOk(response);
  });
  const adapter = new RestBybitAdapter(keyedConfig(), { baseUrl: local.baseUrl });
  try {
    await adapter.getServerTime();
    await settle();
    assert.deepEqual(await adapter.getActiveOrders({ symbol: "BTCUSDT" }), OK_BODY);
    assert.equal(local.requests(), 3);
    assert.equal(adapter.takeConnectionCounters().getRetriesConnectionClosed, 1);

    await settle();
    await assert.rejects(adapter.cancelOrder(cancelPayload));
    assert.equal(local.requests(), 4);
  } finally {
    adapter.close();
    await stopServer(local.server);
  }
});

// Manual timers: interval callbacks run only when the test fires them.
function manualTimers() {
  const handles: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  return {
    handles,
    timers: {
      setInterval: (callback: () => void, ms: number) => {
        const handle = { callback, ms, cleared: false };
        handles.push(handle);
        return handle;
      },
      clearInterval: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  };
}

function fakeAdapter(results: Array<"ok" | Error | Promise<unknown>>) {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      getServerTime: async () => {
        const next = results[calls] ?? "ok";
        calls += 1;
        if (next instanceof Error) {
          throw next;
        }
        return next === "ok" ? OK_BODY : next;
      },
      takeConnectionCounters: () => ({
        newConnections: 2,
        connectErrors: 1,
        getRetriesTimeout: 3,
        getRetriesConnectionClosed: 4,
      }),
    },
  };
}

test("heartbeat runs once at start and then on each interval", async () => {
  const fake = fakeAdapter([]);
  const clock = manualTimers();
  const heartbeat = new BybitConnectionHeartbeat({ adapter: fake.adapter, intervalMs: 60_000, timers: clock.timers, emit: () => undefined });
  heartbeat.start();
  await Promise.resolve();
  assert.equal(fake.calls(), 1);
  const beat = clock.handles.find((handle) => handle.ms === 60_000);
  assert.ok(beat);
  beat.callback();
  await Promise.resolve();
  assert.equal(fake.calls(), 2);
  assert.equal(heartbeat.status().heartbeat, "ok");
  heartbeat.stop();
});

test("a heartbeat still running is not doubled", async () => {
  let release: (value: unknown) => void = () => undefined;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fake = fakeAdapter([pending]);
  const heartbeat = new BybitConnectionHeartbeat({ adapter: fake.adapter, intervalMs: 60_000, timers: manualTimers().timers, emit: () => undefined });
  const first = heartbeat.tick();
  await heartbeat.tick();
  assert.equal(fake.calls(), 1);
  release(OK_BODY);
  await first;
  await heartbeat.tick();
  assert.equal(fake.calls(), 2);
});

test("a failed heartbeat is reported and the next one still runs", async () => {
  const events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  const fake = fakeAdapter([new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }), "ok"]);
  const heartbeat = new BybitConnectionHeartbeat({
    adapter: fake.adapter,
    intervalMs: 60_000,
    timers: manualTimers().timers,
    emit: (level, event, fields) => events.push({ level, event, fields }),
    now: () => 1_000,
  });
  await heartbeat.tick();
  assert.equal(events[0]?.event, "bybit_heartbeat_failed");
  assert.equal(events[0]?.level, "warn");
  assert.match(String(events[0]?.fields?.reason), /ECONNRESET/);
  assert.deepEqual(heartbeat.status(), { heartbeat: "failing", consecutiveHeartbeatFailures: 1 });
  await heartbeat.tick();
  assert.deepEqual(heartbeat.status(), { heartbeat: "ok", lastHeartbeatOkAtMs: 1_000, consecutiveHeartbeatFailures: 0 });
});

test("interval 0 sends no heartbeat but the summary still runs", () => {
  const events: string[] = [];
  const fake = fakeAdapter([]);
  const clock = manualTimers();
  const heartbeat = new BybitConnectionHeartbeat({
    adapter: fake.adapter,
    intervalMs: 0,
    timers: clock.timers,
    emit: (_level, event) => events.push(event),
  });
  heartbeat.start();
  assert.equal(fake.calls(), 0);
  assert.equal(clock.handles.length, 1);
  clock.handles[0]?.callback();
  assert.deepEqual(events, ["bybit_connection_summary"]);
  assert.equal(heartbeat.status().heartbeat, "off");
});

test("summary reports the window counters and resets the heartbeat counts", async () => {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const fake = fakeAdapter(["ok", new Error("down")]);
  const heartbeat = new BybitConnectionHeartbeat({
    adapter: fake.adapter,
    intervalMs: 60_000,
    timers: manualTimers().timers,
    emit: (_level, event, fields) => events.push({ event, fields }),
  });
  await heartbeat.tick();
  await heartbeat.tick();
  heartbeat.summarize();
  heartbeat.summarize();
  const summaries = events.filter((entry) => entry.event === "bybit_connection_summary");
  assert.deepEqual(summaries[0]?.fields, {
    window_ms: 600_000,
    heartbeats_ok: 1,
    heartbeats_failed: 1,
    new_connections: 2,
    connect_errors: 1,
    get_retries_timeout: 3,
    get_retries_connection_closed: 4,
  });
  assert.equal(summaries[1]?.fields?.heartbeats_ok, 0);
});

test("stop ends heartbeats and clears both timers", async () => {
  const fake = fakeAdapter([]);
  const clock = manualTimers();
  const heartbeat = new BybitConnectionHeartbeat({ adapter: fake.adapter, intervalMs: 60_000, timers: clock.timers, emit: () => undefined });
  heartbeat.start();
  await Promise.resolve();
  heartbeat.stop();
  assert.ok(clock.handles.every((handle) => handle.cleared));
  await heartbeat.tick();
  assert.equal(fake.calls(), 1);
});
