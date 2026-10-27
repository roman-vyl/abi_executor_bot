import { createHmac } from "node:crypto";

import WebSocket from "ws";

import type { BybitEnvironment } from "../exchangeFacts/exchangeFactsStore.js";
import {
  ExchangeFactsWriteError,
  type ConnectionLogEvent,
  type ConnectionLogInput,
  type FactInput,
  type SnapshotInput,
  type StreamBatch,
  type StreamBatchResult,
} from "../exchangeFacts/exchangeFactsStore.js";
import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";

// Records ABI's private Bybit WebSocket stream into the exchange facts store
// (abi-exchange-stream-recorder-v1). Read-only: it only authenticates,
// subscribes and pings. Nothing in order execution uses it, and no failure
// leaves it: every socket, parse and store error is caught here, emitted and
// shown in /health.

export const PRIVATE_STREAM_URLS: Record<BybitEnvironment, string> = {
  demo: "wss://stream-demo.bybit.com/v5/private",
  testnet: "wss://stream-testnet.bybit.com/v5/private",
  mainnet: "wss://stream.bybit.com/v5/private",
};

export const STREAM_TOPICS = ["order", "execution", "position", "wallet"] as const;

export type ExchangeStreamState = "disabled" | "connecting" | "subscribed" | "backoff" | "stopped";

export type ExchangeStreamStatus = {
  state: ExchangeStreamState;
  reason?: string;
  connectedSinceMs?: number;
  lastMessageAtMs?: number;
  reconnects: number;
  bufferedRecords: number;
  droppedRecords: number;
  lastWriteError?: string;
};

export function disabledStreamStatus(reason: string): ExchangeStreamStatus {
  return { state: "disabled", reason, reconnects: 0, bufferedRecords: 0, droppedRecords: 0 };
}

// What the recorder needs from the store: one transaction per flush.
export type StreamBatchSink = { writeStreamBatch(batch: StreamBatch): StreamBatchResult };

// The part of a ws client socket the recorder uses; tests may pass their own.
export type StreamSocket = {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: WebSocket.RawData) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send(data: string): void;
  terminate(): void;
  readonly readyState: number;
};

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export type ExchangeStreamRecorderOptions = {
  url: string;
  apiKey: string;
  apiSecret: string;
  sink: StreamBatchSink;
  emit?: EmitLike;
  now?: () => number;
  createSocket?: (url: string) => StreamSocket;
  // Defaults are the spec values (design D2, D3, D5).
  pingIntervalMs?: number;
  staleAfterMs?: number;
  backoffMs?: readonly number[];
  backoffResetAfterMs?: number;
  flushIntervalMs?: number;
  maxBatchRecords?: number;
  maxBufferedRecords?: number;
};

type BufferedRecord =
  | { type: "fact"; topic: string; input: FactInput }
  | { type: "snapshot"; topic: string; input: SnapshotInput };

const AUTH_EXPIRES_IN_MS = 10_000;
const MAX_BUFFERED_LOG_ROWS = 1_000;

export class ExchangeStreamRecorder {
  private readonly emit: EmitLike;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => StreamSocket;
  private readonly pingIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly backoffMs: readonly number[];
  private readonly backoffResetAfterMs: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchRecords: number;
  private readonly maxBufferedRecords: number;

  private socket: StreamSocket | undefined;
  private connId: string | null = null;
  private state: ExchangeStreamState = "stopped";
  private started = false;
  private stopped = false;
  private attempt = 0;
  private reconnects = 0;
  private connectedSinceMs: number | undefined;
  private lastMessageAtMs: number | undefined;
  private lastFrameAtMs = 0;
  private staleClose = false;

  private records: BufferedRecord[] = [];
  private logs: ConnectionLogInput[] = [];
  private droppedRecords = 0;
  private droppedSinceLastLog = 0;
  private lastWriteError: string | undefined;
  private flushScheduled = false;
  private finalFlushDone = false;

  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffResetTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ExchangeStreamRecorderOptions) {
    this.emit = options.emit ?? emitEvent;
    this.now = options.now ?? Date.now;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.backoffMs = options.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    this.backoffResetAfterMs = options.backoffResetAfterMs ?? 60_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.maxBatchRecords = options.maxBatchRecords ?? 500;
    this.maxBufferedRecords = options.maxBufferedRecords ?? 10_000;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref?.();
    this.connect();
  }

  // Closes the socket and writes what is buffered once (design D1).
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearConnectionTimers();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.flushTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      this.log("disconnected", "shutdown");
      this.safely(() => socket.terminate());
    }
    this.state = "stopped";
    this.flush();
    // The store closes right after stop(); a flush still queued must not
    // touch it.
    this.finalFlushDone = true;
  }

  status(): ExchangeStreamStatus {
    return {
      state: this.state,
      ...(this.connectedSinceMs !== undefined ? { connectedSinceMs: this.connectedSinceMs } : {}),
      ...(this.lastMessageAtMs !== undefined ? { lastMessageAtMs: this.lastMessageAtMs } : {}),
      reconnects: this.reconnects,
      bufferedRecords: this.records.length,
      droppedRecords: this.droppedRecords,
      ...(this.lastWriteError !== undefined ? { lastWriteError: this.lastWriteError } : {}),
    };
  }

  // Writes buffered records and log rows: one transaction per call
  // (design D5, D6). Never throws.
  flush(): void {
    this.flushScheduled = false;
    if (this.finalFlushDone) {
      return;
    }
    if (this.droppedSinceLastLog > 0 && this.records.length < this.maxBufferedRecords) {
      this.log("buffer_overflow", `dropped=${this.droppedSinceLastLog}`);
      this.droppedSinceLastLog = 0;
    }
    while (this.records.length > 0 || this.logs.length > 0) {
      const records = this.records.slice(0, this.maxBatchRecords);
      const logs = this.logs.slice();
      if (!this.writeOrRecover(records, logs)) {
        return;
      }
      this.records.splice(0, records.length);
      this.logs.splice(0, logs.length);
      if (this.stopped && this.records.length === 0) {
        return;
      }
    }
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.state = "connecting";
    this.connId = null;
    this.staleClose = false;
    this.log("connecting", null);

    let socket: StreamSocket;
    try {
      socket = this.createSocket(this.options.url);
    } catch (error) {
      this.emit("error", "exchange_stream_disconnected", { code: null, reason: describe(error) });
      this.log("disconnected", `connect_error=${describe(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => this.safely(() => this.onOpen(socket)));
    socket.on("message", (data) => this.safely(() => this.onMessage(socket, data)));
    socket.on("close", (code, reason) => this.safely(() => this.onClose(socket, code, reason.toString("utf8"))));
    // A close always follows an error; the close handler reconnects.
    socket.on("error", () => undefined);
  }

  private onOpen(socket: StreamSocket): void {
    if (socket !== this.socket) {
      return;
    }
    this.lastFrameAtMs = this.now();
    this.log("connected", null);
    const expires = this.now() + AUTH_EXPIRES_IN_MS;
    const signature = createHmac("sha256", this.options.apiSecret).update(`GET/realtime${expires}`).digest("hex");
    socket.send(JSON.stringify({ op: "auth", args: [this.options.apiKey, expires, signature] }));
    this.pingTimer = setInterval(() => this.safely(() => this.onPingTick(socket)), this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private onPingTick(socket: StreamSocket): void {
    if (socket !== this.socket) {
      return;
    }
    if (this.now() - this.lastFrameAtMs >= this.staleAfterMs) {
      this.staleClose = true;
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify({ op: "ping" }));
  }

  private onMessage(socket: StreamSocket, data: WebSocket.RawData): void {
    if (socket !== this.socket) {
      return;
    }
    const receivedAtMs = this.now();
    this.lastFrameAtMs = receivedAtMs;

    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawDataToString(data));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("frame is not a JSON object");
      }
      frame = parsed as Record<string, unknown>;
    } catch (error) {
      this.emit("warn", "exchange_stream_frame_invalid", { reason: describe(error) });
      return;
    }

    if (typeof frame.conn_id === "string" && frame.conn_id !== "") {
      this.connId = frame.conn_id;
    }

    if (frame.op === "auth") {
      if (frame.success === true) {
        this.log("auth_ok", null);
        socket.send(JSON.stringify({ op: "subscribe", args: [...STREAM_TOPICS] }));
      } else {
        const detail = String(frame.ret_msg ?? "auth rejected");
        this.log("auth_failed", detail);
        this.emit("error", "exchange_stream_auth_failed", { reason: detail });
        socket.terminate();
      }
      return;
    }

    if (frame.op === "subscribe") {
      if (frame.success === true) {
        this.state = "subscribed";
        this.connectedSinceMs = receivedAtMs;
        this.log("subscribed", STREAM_TOPICS.join(","));
        this.emit("info", "exchange_stream_connected", { connId: this.connId });
        this.backoffResetTimer = setTimeout(() => {
          if (socket === this.socket && this.state === "subscribed") {
            this.attempt = 0;
          }
        }, this.backoffResetAfterMs);
        this.backoffResetTimer.unref?.();
      } else {
        const detail = String(frame.ret_msg ?? "subscribe rejected");
        this.log("subscribe_failed", detail);
        this.emit("error", "exchange_stream_subscribe_failed", { reason: detail });
        socket.terminate();
      }
      return;
    }

    if (typeof frame.topic !== "string" || !Array.isArray(frame.data)) {
      // pong and other control frames only keep the connection alive.
      return;
    }

    const topic = frame.topic;
    if (!(STREAM_TOPICS as readonly string[]).includes(topic)) {
      return;
    }
    this.lastMessageAtMs = receivedAtMs;
    const frameCreationTimeMs = typeof frame.creationTime === "number" ? frame.creationTime : undefined;
    for (const element of frame.data) {
      this.enqueue(toRecord(topic, JSON.stringify(element), receivedAtMs, frameCreationTimeMs));
    }
  }

  private onClose(socket: StreamSocket, code: number, reason: string): void {
    if (socket !== this.socket) {
      return;
    }
    this.socket = undefined;
    this.clearConnectionTimers();
    this.connectedSinceMs = undefined;
    const detail = this.staleClose ? "stale" : `code=${code}${reason !== "" ? ` reason=${reason}` : ""}`;
    this.log("disconnected", detail);
    this.emit("warn", "exchange_stream_disconnected", { code, reason: this.staleClose ? "stale" : reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this.state = "backoff";
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => this.safely(() => this.connect()), delay);
    this.reconnectTimer.unref?.();
  }

  private clearConnectionTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.backoffResetTimer);
    this.pingTimer = undefined;
    this.backoffResetTimer = undefined;
  }

  private enqueue(record: BufferedRecord): void {
    if (this.records.length >= this.maxBufferedRecords) {
      this.droppedRecords += 1;
      this.droppedSinceLastLog += 1;
      return;
    }
    this.records.push(record);
    if (this.records.length >= this.maxBatchRecords && !this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private log(event: ConnectionLogEvent, detail: string | null): void {
    if (this.logs.length >= MAX_BUFFERED_LOG_ROWS) {
      return;
    }
    this.logs.push({ atMs: this.now(), event, connId: this.connId, detail });
  }

  // Returns false when the store failed and the rows must stay buffered.
  private writeOrRecover(records: readonly BufferedRecord[], logs: readonly ConnectionLogInput[]): boolean {
    try {
      this.options.sink.writeStreamBatch(toBatch(records, logs));
      this.lastWriteError = undefined;
      return true;
    } catch (error) {
      if (!isValidationError(error)) {
        this.lastWriteError = describe(error);
        this.emit("error", "exchange_stream_write_failed", { reason: this.lastWriteError });
        return false;
      }
    }

    // One invalid record must not cost the batch: write one by one (design D6).
    try {
      this.options.sink.writeStreamBatch(toBatch([], logs));
    } catch (error) {
      if (!isValidationError(error)) {
        this.lastWriteError = describe(error);
        this.emit("error", "exchange_stream_write_failed", { reason: this.lastWriteError });
        return false;
      }
      this.emit("error", "exchange_stream_record_rejected", { topic: "connection_log", reason: describe(error) });
    }
    for (const record of records) {
      try {
        this.options.sink.writeStreamBatch(toBatch([record], []));
      } catch (error) {
        if (!isValidationError(error)) {
          this.lastWriteError = describe(error);
          this.emit("error", "exchange_stream_write_failed", { reason: this.lastWriteError });
          // Keep only what was not written yet.
          this.records.splice(0, records.indexOf(record));
          this.logs.splice(0, logs.length);
          return false;
        }
        this.emit("warn", "exchange_stream_record_rejected", { topic: record.topic, reason: describe(error) });
      }
    }
    this.lastWriteError = undefined;
    return true;
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.emit("error", "exchange_stream_internal_error", { reason: describe(error) });
    }
  }
}

function toRecord(
  topic: string,
  rawJson: string,
  receivedAtMs: number,
  frameCreationTimeMs: number | undefined,
): BufferedRecord {
  const sourceEndpoint = `ws:${topic}`;
  if (topic === "order" || topic === "execution") {
    return {
      type: "fact",
      topic,
      input: { kind: topic === "order" ? "order_state" : "execution", source: "ws", sourceEndpoint, rawJson, receivedAtMs },
    };
  }
  return {
    type: "snapshot",
    topic,
    input: {
      kind: topic === "position" ? "position" : "wallet",
      source: "ws",
      sourceEndpoint,
      rawJson,
      receivedAtMs,
      ...(frameCreationTimeMs !== undefined ? { frameCreationTimeMs } : {}),
    },
  };
}

function toBatch(records: readonly BufferedRecord[], logs: readonly ConnectionLogInput[]): StreamBatch {
  const facts: FactInput[] = [];
  const snapshots: SnapshotInput[] = [];
  for (const record of records) {
    if (record.type === "fact") {
      facts.push(record.input);
    } else {
      snapshots.push(record.input);
    }
  }
  return { facts, snapshots, logs };
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof ExchangeFactsWriteError &&
    (error.code === "invalid_fact" || error.code === "invalid_snapshot" || error.code === "invalid_log")
  );
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
