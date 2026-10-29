import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";
import type { BybitConnectionCounters } from "./bybitAdapter.js";

// Keeps the adapter's pooled Bybit connection in use between bars with a
// public GET /v5/market/time, and reports connection health
// (abi-bybit-connection-keepalive-v1 D3, D6). Nothing in trading waits for
// it or reads its result; a failed heartbeat is only reported.

export const CONNECTION_SUMMARY_INTERVAL_MS = 10 * 60 * 1000;

export type BybitHeartbeatState = "off" | "ok" | "failing";

export type BybitConnectionStatus = {
  heartbeat: BybitHeartbeatState;
  lastHeartbeatOkAtMs?: number;
  consecutiveHeartbeatFailures: number;
};

export type HeartbeatAdapter = {
  getServerTime(): Promise<unknown>;
  takeConnectionCounters(): BybitConnectionCounters;
};

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

type Timers = {
  setInterval(callback: () => void, ms: number): { unref?: () => unknown };
  clearInterval(handle: unknown): void;
};

export class BybitConnectionHeartbeat {
  private readonly adapter: HeartbeatAdapter;
  private readonly intervalMs: number;
  private readonly summaryIntervalMs: number;
  private readonly emit: EmitLike;
  private readonly now: () => number;
  private readonly timers: Timers;

  private heartbeatTimer: unknown;
  private summaryTimer: unknown;
  private inFlight = false;
  private stopped = false;
  private lastOkAtMs: number | undefined;
  private consecutiveFailures = 0;
  private windowOk = 0;
  private windowFailed = 0;

  constructor(input: {
    adapter: HeartbeatAdapter;
    // 0 = no heartbeat requests; the summary still runs.
    intervalMs: number;
    summaryIntervalMs?: number;
    emit?: EmitLike;
    now?: () => number;
    timers?: Timers;
  }) {
    this.adapter = input.adapter;
    this.intervalMs = input.intervalMs;
    this.summaryIntervalMs = input.summaryIntervalMs ?? CONNECTION_SUMMARY_INTERVAL_MS;
    this.emit = input.emit ?? emitEvent;
    this.now = input.now ?? Date.now;
    this.timers = input.timers ?? { setInterval, clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout) };
  }

  start(): void {
    if (this.intervalMs > 0) {
      void this.tick();
      this.heartbeatTimer = this.schedule(() => void this.tick(), this.intervalMs);
    }
    this.summaryTimer = this.schedule(() => this.summarize(), this.summaryIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.summaryTimer !== undefined) {
      this.timers.clearInterval(this.summaryTimer);
      this.summaryTimer = undefined;
    }
  }

  status(): BybitConnectionStatus {
    if (this.intervalMs === 0) {
      return { heartbeat: "off", consecutiveHeartbeatFailures: 0 };
    }
    return {
      heartbeat: this.consecutiveFailures > 0 ? "failing" : "ok",
      ...(this.lastOkAtMs !== undefined ? { lastHeartbeatOkAtMs: this.lastOkAtMs } : {}),
      consecutiveHeartbeatFailures: this.consecutiveFailures,
    };
  }

  // Never throws; a tick still running when the next one is due is not doubled.
  async tick(): Promise<void> {
    if (this.inFlight || this.stopped) {
      return;
    }
    this.inFlight = true;
    const startedAtMs = this.now();
    try {
      await this.adapter.getServerTime();
      this.lastOkAtMs = this.now();
      this.consecutiveFailures = 0;
      this.windowOk += 1;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.windowFailed += 1;
      this.emit("warn", "bybit_heartbeat_failed", {
        reason: describe(error),
        duration_ms: this.now() - startedAtMs,
        consecutive_failures: this.consecutiveFailures,
      });
    } finally {
      this.inFlight = false;
    }
  }

  summarize(): void {
    const counters = this.adapter.takeConnectionCounters();
    this.emit("info", "bybit_connection_summary", {
      window_ms: this.summaryIntervalMs,
      heartbeats_ok: this.windowOk,
      heartbeats_failed: this.windowFailed,
      new_connections: counters.newConnections,
      connect_errors: counters.connectErrors,
      get_retries_timeout: counters.getRetriesTimeout,
      get_retries_connection_closed: counters.getRetriesConnectionClosed,
    });
    this.windowOk = 0;
    this.windowFailed = 0;
  }

  private schedule(callback: () => void, ms: number): unknown {
    const handle = this.timers.setInterval(callback, ms);
    handle.unref?.();
    return handle;
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name}: ${error.message} (${code})` : `${error.name}: ${error.message}`;
}
