import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer, type WebSocket } from "ws";

import {
  ExchangeFactsStore,
  type StreamBatch,
  type StreamBatchResult,
} from "../../src/exchangeFacts/exchangeFactsStore.js";
import {
  ExchangeStreamRecorder,
  PRIVATE_STREAM_URLS,
  type ExchangeStreamRecorderOptions,
} from "../../src/exchangeStream/exchangeStreamRecorder.js";
import { createExchangeStreamRecorder } from "../../src/exchangeStream/exchangeStreamStartup.js";
import type { EventLevel } from "../../src/observability/events.js";
import { makeTestConfig } from "../fixtures/config.js";
import {
  ENTRY_CANCELLED_FRAME,
  ENTRY_PLACED_FRAME,
  ENTRY_REPLACED_FRAME,
  POSITION_FRAME,
  SL_EXEC_ID,
  SL_EXECUTION_FRAME,
  SL_FILLED_AND_TP_DEACTIVATED_FRAME,
  SL_ORDER_ID,
  SL_TRIGGERED_FRAME,
  TP_ORDER_ID,
  WALLET_FRAME,
} from "../fixtures/exchangeStreamStage0.js";

type Emitted = { level: EventLevel; event: string; fields?: Record<string, unknown> };

type FakeBybitOptions = {
  authOk?: boolean;
  subscribeOk?: boolean;
  answerPings?: boolean;
};

// A local stand-in for Bybit's private stream: answers auth, subscribe and
// ping like Bybit and lets a test push frames to the connected client.
class FakeBybit {
  readonly server: WebSocketServer;
  readonly received: Record<string, unknown>[] = [];
  readonly clients: WebSocket[] = [];
  connections = 0;

  constructor(private readonly options: FakeBybitOptions = {}) {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket) => {
      this.connections += 1;
      const connId = `conn-${this.connections}`;
      this.clients.push(socket);
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        this.received.push(message);
        if (message.op === "auth") {
          const ok = this.options.authOk ?? true;
          socket.send(JSON.stringify({ success: ok, ret_msg: ok ? "" : "Invalid apikey", op: "auth", conn_id: connId }));
        } else if (message.op === "subscribe") {
          const ok = this.options.subscribeOk ?? true;
          socket.send(JSON.stringify({ success: ok, ret_msg: ok ? "" : "error:topic", op: "subscribe", conn_id: connId }));
        } else if (message.op === "ping" && (this.options.answerPings ?? true)) {
          socket.send(JSON.stringify({ op: "pong", args: [String(Date.now())], conn_id: connId }));
        }
      });
    });
  }

  static async start(options: FakeBybitOptions = {}): Promise<FakeBybit> {
    const bybit = new FakeBybit(options);
    await new Promise<void>((resolve) => bybit.server.once("listening", () => resolve()));
    return bybit;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get current(): WebSocket {
    return this.clients[this.clients.length - 1];
  }

  push(frame: unknown): void {
    this.current.send(JSON.stringify(frame));
  }

  close(): Promise<void> {
    for (const client of this.clients) {
      client.terminate();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function tempStore(t: test.TestContext): ExchangeFactsStore {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-stream-"));
  const store = ExchangeFactsStore.open({
    path: path.join(dir, "facts.sqlite3"),
    bybitEnvironment: "demo",
    category: "linear",
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const FAST = {
  pingIntervalMs: 40,
  staleAfterMs: 150,
  backoffMs: [20, 40],
  backoffResetAfterMs: 10_000,
  flushIntervalMs: 20,
} as const;

function recorder(
  t: test.TestContext,
  options: Partial<ExchangeStreamRecorderOptions> & Pick<ExchangeStreamRecorderOptions, "url" | "sink">,
  emitted: Emitted[] = [],
): ExchangeStreamRecorder {
  const instance = new ExchangeStreamRecorder({
    apiKey: "test-key",
    apiSecret: "test-secret",
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
    ...FAST,
    ...options,
  });
  t.after(() => instance.stop());
  return instance;
}

test("private stream URLs follow ABI's Bybit environment", () => {
  assert.equal(PRIVATE_STREAM_URLS.demo, "wss://stream-demo.bybit.com/v5/private");
  assert.equal(PRIVATE_STREAM_URLS.testnet, "wss://stream-testnet.bybit.com/v5/private");
  assert.equal(PRIVATE_STREAM_URLS.mainnet, "wss://stream.bybit.com/v5/private");
});

test("the recorder authenticates with a valid signature and subscribes to the four topics only", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store });
  rec.start();

  await waitFor(() => rec.status().state === "subscribed");
  const auth = bybit.received.find((m) => m.op === "auth")!;
  const [key, expires, signature] = auth.args as [string, number, string];
  assert.equal(key, "test-key");
  assert.equal(signature, createHmac("sha256", "test-secret").update(`GET/realtime${expires}`).digest("hex"));
  assert.ok(expires > Date.now());
  assert.deepEqual(bybit.received.find((m) => m.op === "subscribe")!.args, ["order", "execution", "position", "wallet"]);
  assert.deepEqual(
    [...new Set(bybit.received.map((m) => m.op))].sort(),
    bybit.received.some((m) => m.op === "ping") ? ["auth", "ping", "subscribe"] : ["auth", "subscribe"],
  );
});

test("the stage 0 stop loss, position and wallet frames are stored as received", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store });
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  for (const frame of [SL_TRIGGERED_FRAME, SL_EXECUTION_FRAME, SL_FILLED_AND_TP_DEACTIVATED_FRAME, POSITION_FRAME, WALLET_FRAME]) {
    bybit.push(frame);
  }
  await waitFor(() => store.readSnapshotsAfter(0, 10).length === 2 && store.readFactsAfter(0, 10).length === 4);

  const facts = store.readFactsAfter(0, 10);
  const slStates = facts.filter((f) => f.kind === "order_state" && f.orderId === SL_ORDER_ID);
  assert.deepEqual(
    slStates.map((f) => f.orderStatus),
    ["Triggered", "Filled"],
  );
  const execution = facts.find((f) => f.kind === "execution")!;
  assert.equal(execution.execId, SL_EXEC_ID);
  assert.equal(execution.execType, "Trade");
  assert.equal(execution.source, "ws");
  assert.equal(execution.sourceEndpoint, "ws:execution");
  assert.equal(execution.rawJson, JSON.stringify(SL_EXECUTION_FRAME.data[0]));
  const tp = facts.find((f) => f.orderId === TP_ORDER_ID)!;
  assert.equal(tp.orderStatus, "Deactivated");
  assert.equal(tp.parentOrderLinkId, "abi-ep-eb7c6a056f7831a4a6a8");

  const snapshots = store.readSnapshotsAfter(0, 10);
  assert.deepEqual(
    snapshots.map((s) => [s.kind, s.symbol, s.sourceEndpoint]),
    [
      ["position", "XRPUSDT", "ws:position"],
      ["wallet", null, "ws:wallet"],
    ],
  );
  assert.equal(snapshots[1].exchangeTimeMs, WALLET_FRAME.creationTime);
  assert.ok(rec.status().lastMessageAtMs !== undefined);
  const status = rec.status();
  assert.equal(status.receivedRecords, 6);
  assert.equal(status.writtenFacts, 4);
  assert.equal(status.writtenSnapshots, 2);
  assert.equal(status.duplicateRecords, 0);
  assert.ok(status.lastWriteAtMs !== undefined);
  assert.equal(status.lastWriteError, undefined);
});

test("the stage 0 entry placement, cancel and replacement are stored as three order states", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store });
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  bybit.push(ENTRY_PLACED_FRAME);
  bybit.push(ENTRY_CANCELLED_FRAME);
  bybit.push(ENTRY_REPLACED_FRAME);
  await waitFor(() => store.readFactsAfter(0, 10).length === 3);

  assert.deepEqual(
    store.readFactsAfter(0, 10).map((f) => [f.orderLinkId, f.orderStatus]),
    [
      ["abi-ep-83cad3aac49ae65dd040", "Untriggered"],
      ["abi-ep-83cad3aac49ae65dd040", "Deactivated"],
      ["abi-ep-a27fe7e24358bf883925", "Untriggered"],
    ],
  );
});

test("a network drop is logged, the recorder reconnects and a replayed execId is stored once", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store });
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");
  bybit.push(SL_EXECUTION_FRAME);
  await waitFor(() => store.readFactsAfter(0, 10).length === 1);

  bybit.current.terminate();
  await waitFor(() => bybit.connections === 2 && rec.status().state === "subscribed");
  bybit.push(SL_EXECUTION_FRAME);
  await waitFor(() => store.readConnectionLogAfter(0, 100).filter((l) => l.event === "subscribed").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(store.readFactsAfter(0, 10).length, 1);
  const events = store.readConnectionLogAfter(0, 100).map((l) => l.event);
  assert.deepEqual(events, [
    "connecting",
    "connected",
    "auth_ok",
    "subscribed",
    "disconnected",
    "connecting",
    "connected",
    "auth_ok",
    "subscribed",
  ]);
  const disconnected = store.readConnectionLogAfter(0, 100).find((l) => l.event === "disconnected")!;
  assert.match(disconnected.detail ?? "", /^code=1006/);
  assert.equal(disconnected.connId, "conn-1");
  assert.equal(rec.status().reconnects, 1);
  assert.equal(rec.status().receivedRecords, 2);
  assert.equal(rec.status().writtenFacts, 1);
  assert.equal(rec.status().duplicateRecords, 1);
});

test("a silent connection is closed as stale and reopened", async (t) => {
  const bybit = await FakeBybit.start({ answerPings: false });
  t.after(() => bybit.close());
  const store = tempStore(t);
  const emitted: Emitted[] = [];
  const rec = recorder(t, { url: bybit.url, sink: store }, emitted);
  rec.start();

  await waitFor(() => bybit.connections >= 2, 3_000);
  await waitFor(() => store.readConnectionLogAfter(0, 100).some((l) => l.event === "disconnected"));
  const disconnected = store.readConnectionLogAfter(0, 100).find((l) => l.event === "disconnected")!;
  assert.equal(disconnected.detail, "stale");
  assert.ok(emitted.some((e) => e.event === "exchange_stream_disconnected" && e.fields?.reason === "stale"));
});

test("a rejected auth is logged and retried with backoff without stopping", async (t) => {
  const bybit = await FakeBybit.start({ authOk: false });
  t.after(() => bybit.close());
  const store = tempStore(t);
  const emitted: Emitted[] = [];
  const rec = recorder(t, { url: bybit.url, sink: store }, emitted);
  rec.start();

  await waitFor(() => bybit.connections >= 3);
  await waitFor(() => store.readConnectionLogAfter(0, 100).filter((l) => l.event === "auth_failed").length >= 2);
  assert.ok(emitted.some((e) => e.event === "exchange_stream_auth_failed" && e.fields?.reason === "Invalid apikey"));
  assert.notEqual(rec.status().state, "subscribed");
  assert.equal(
    bybit.received.some((m) => m.op === "subscribe"),
    false,
  );
});

test("a rejected subscribe is logged and the connection is reopened", async (t) => {
  const bybit = await FakeBybit.start({ subscribeOk: false });
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store });
  rec.start();

  await waitFor(() => bybit.connections >= 2);
  await waitFor(() => store.readConnectionLogAfter(0, 100).some((l) => l.event === "subscribe_failed"));
  assert.equal(store.readConnectionLogAfter(0, 100).find((l) => l.event === "subscribe_failed")!.detail, "error:topic");
});

test("an unreachable server only leads to backoff", async (t) => {
  const store = tempStore(t);
  const rec = recorder(t, { url: "ws://127.0.0.1:1", sink: store });
  rec.start();
  await waitFor(() => rec.status().reconnects >= 2);
  assert.notEqual(rec.status().state, "subscribed");
});

test("an invalid record does not cost the rest of its batch", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const emitted: Emitted[] = [];
  const rec = recorder(t, { url: bybit.url, sink: store, flushIntervalMs: 200 }, emitted);
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  const broken = { ...SL_EXECUTION_FRAME.data[0], execId: "" };
  bybit.push({ ...SL_EXECUTION_FRAME, data: [broken, SL_EXECUTION_FRAME.data[0]] });
  bybit.push(SL_TRIGGERED_FRAME);
  await waitFor(() => store.readFactsAfter(0, 10).length === 2);

  assert.deepEqual(
    store
      .readFactsAfter(0, 10)
      .map((f) => f.kind)
      .sort(),
    ["execution", "order_state"],
  );
  assert.ok(emitted.some((e) => e.event === "exchange_stream_record_rejected" && e.fields?.topic === "execution"));
  assert.equal(
    emitted.some((e) => JSON.stringify(e).includes("1.3181")),
    false,
    "events carry no record payload",
  );
});

test("a failing store keeps records buffered, reports the error and recovers", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  let failing = true;
  const sink = {
    writeStreamBatch(batch: StreamBatch): StreamBatchResult {
      if (failing) {
        throw new Error("SQLITE_FULL: database or disk is full");
      }
      return store.writeStreamBatch(batch);
    },
  };
  const emitted: Emitted[] = [];
  const rec = recorder(t, { url: bybit.url, sink }, emitted);
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  bybit.push(SL_EXECUTION_FRAME);
  await waitFor(() => rec.status().lastWriteError !== undefined && rec.status().bufferedRecords === 1);
  assert.match(rec.status().lastWriteError!, /SQLITE_FULL/);
  assert.ok(emitted.some((e) => e.event === "exchange_stream_write_failed"));

  failing = false;
  await waitFor(() => store.readFactsAfter(0, 10).length === 1 && rec.status().bufferedRecords === 0);
  assert.equal(rec.status().lastWriteError, undefined);
  assert.ok(store.readConnectionLogAfter(0, 100).some((l) => l.event === "subscribed"));
});

test("records beyond the buffer bound are dropped, counted and logged once writing resumes", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  let failing = true;
  const sink = {
    writeStreamBatch(batch: StreamBatch): StreamBatchResult {
      if (failing) {
        throw new Error("disk I/O error");
      }
      return store.writeStreamBatch(batch);
    },
  };
  const rec = recorder(t, { url: bybit.url, sink, maxBufferedRecords: 2, maxBatchRecords: 2 });
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  bybit.push(SL_TRIGGERED_FRAME);
  bybit.push(SL_EXECUTION_FRAME);
  bybit.push(SL_FILLED_AND_TP_DEACTIVATED_FRAME);
  await waitFor(() => rec.status().droppedRecords === 2);
  assert.equal(rec.status().bufferedRecords, 2);

  failing = false;
  await waitFor(() => store.readConnectionLogAfter(0, 100).some((l) => l.event === "buffer_overflow"));
  assert.equal(store.readConnectionLogAfter(0, 100).find((l) => l.event === "buffer_overflow")!.detail, "dropped=2");
  assert.equal(store.readFactsAfter(0, 10).length, 2);
});

test("stop closes the socket and writes what is buffered", async (t) => {
  const bybit = await FakeBybit.start();
  t.after(() => bybit.close());
  const store = tempStore(t);
  const rec = recorder(t, { url: bybit.url, sink: store, flushIntervalMs: 60_000 });
  rec.start();
  await waitFor(() => rec.status().state === "subscribed");

  bybit.push(SL_EXECUTION_FRAME);
  await waitFor(() => rec.status().bufferedRecords === 1);
  rec.stop();

  assert.equal(store.readFactsAfter(0, 10).length, 1);
  assert.equal(rec.status().state, "stopped");
  const log = store.readConnectionLogAfter(0, 100);
  assert.equal(log[log.length - 1].detail, "shutdown");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(bybit.connections, 1, "no reconnect after stop");
});

test("the recorder is not created without an enabled store or without a key", () => {
  const disabled = createExchangeStreamRecorder(makeTestConfig({ bybitApiKey: "k", bybitApiSecret: "s" }), {
    status: "disabled",
  });
  assert.deepEqual(disabled.status(), {
    state: "disabled",
    reason: "store_not_enabled",
    reconnects: 0,
    bufferedRecords: 0,
    droppedRecords: 0,
    receivedRecords: 0,
    writtenFacts: 0,
    writtenSnapshots: 0,
    duplicateRecords: 0,
  });

  const unavailable = createExchangeStreamRecorder(makeTestConfig({ bybitApiKey: "k", bybitApiSecret: "s" }), {
    status: "unavailable",
    reason: "open_failed",
  });
  assert.equal(unavailable.status().reason, "store_not_enabled");

  const noKey = createExchangeStreamRecorder(makeTestConfig({ bybitApiKey: "", bybitApiSecret: "" }), {
    status: "enabled",
    store: {} as ExchangeFactsStore,
  });
  assert.equal(noKey.status().reason, "no_api_key");
  noKey.start();
  noKey.stop();
  assert.equal(noKey.status().state, "disabled");
});
