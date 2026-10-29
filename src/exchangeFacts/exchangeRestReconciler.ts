import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import type { AbiConfig } from "../config/config.js";
import type { BybitHistoryWindowInput, BybitHistoryWindowReader } from "../exchange/bybitAdapter.js";
import { emitEvent, type EventLevel } from "../observability/events.js";
import type { ExchangeFactsStore, FactInput, FactKind, RestEndpoint } from "./exchangeFactsStore.js";

// Fills gaps of the private stream from Bybit REST history and reports what
// is still missing (abi-exchange-rest-reconciliation-v1). Read only: it never
// creates, amends or cancels an order. Nobody in trading calls it and it calls
// nobody: it meets the recorder and the linker only in the store (design D9).

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Design D8. Constants, not configuration.
export const REST_HISTORY_MS = 30 * DAY_MS;
export const REST_WINDOW_MS = 7 * DAY_MS;
export const REST_SWEEP_INTERVAL_MS = 10 * MINUTE_MS;
export const REST_SWEEP_SPAN_MS = 60 * MINUTE_MS;
export const REST_RECONNECT_MARGIN_MS = 2 * MINUTE_MS;
export const REST_PACE_MS = 500;
export const REST_BAR_MS = 5 * MINUTE_MS;
export const REST_QUIET_MS = 30_000;
export const REST_BACKOFF_MS: readonly number[] = [5_000, 30_000, 60_000];

const MAX_PAGES_PER_SLICE = 1_000;
const COMPLETENESS_IDS = 20;
const COMPLETENESS_ORDER_LIMIT = 100_000;
const TERMINAL_CLOSED = "terminal_closed";
// Bybit "params error": the request needs a symbol on this account (D1).
const PARAMS_ERROR = /retCode 10001\b/;

const ENDPOINTS: Readonly<
  Record<RestEndpoint, { path: string; kind: FactKind; read: (reader: BybitHistoryWindowReader, input: BybitHistoryWindowInput) => Promise<unknown> }>
> = {
  order_history: {
    path: "/v5/order/history",
    kind: "order_state",
    read: (reader, input) => reader.getOrderHistoryWindow(input),
  },
  execution_list: {
    path: "/v5/execution/list",
    kind: "execution",
    read: (reader, input) => reader.getExecutionWindow(input),
  },
};
const ENDPOINT_NAMES = Object.keys(ENDPOINTS) as RestEndpoint[];

export type ExchangeRestState = "disabled" | "backfilling" | "idle" | "fetching" | "stopped";

export type ExchangeRestStatus = {
  state: ExchangeRestState;
  reason?: string;
  coveredFromMs?: number;
  backfillDone: boolean;
  queueWindows: number;
  requests: number;
  recordsFetched: number;
  recordsNew: number;
  lastSweepAtMs?: number;
  lastError?: string;
};

export type ExchangeCompletenessStatus = {
  checkedAtMs?: number;
  execMismatchOrders: number;
  uncoveredGaps: number;
  closedCyclesWithoutCloseFill: number;
  unlabeledRestOrders: number;
};

export function disabledRestStatus(reason: string): ExchangeRestStatus {
  return { state: "disabled", reason, backfillDone: false, queueWindows: 0, requests: 0, recordsFetched: 0, recordsNew: 0 };
}

export function emptyCompletenessStatus(): ExchangeCompletenessStatus {
  return { execMismatchOrders: 0, uncoveredGaps: 0, closedCyclesWithoutCloseFill: 0, unlabeledRestOrders: 0 };
}

// The fields of a correlation record the reconciler needs.
export type CycleSourceRecord = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  exchange_symbol: string;
  status: string;
  first_fill_at_ms: number | null;
};

export type ReconcilerFactsStore = Pick<
  ExchangeFactsStore,
  | "writeRestPage"
  | "readRestWindows"
  | "listFactSymbols"
  | "readConnectionLogAfter"
  | "readTerminalOrderFills"
  | "readUnlabeledRestOrders"
  | "hasLinkedCloseFill"
>;

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export type ExchangeRestReconcilerOptions = {
  store: ReconcilerFactsStore;
  reader: BybitHistoryWindowReader;
  category: string;
  listRecords: () => readonly CycleSourceRecord[];
  isCorrelationReady: () => boolean;
  emit?: EmitLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickIntervalMs?: number;
};

type WindowKind = "backfill" | "reconnect" | "sweep";

type QueuedWindow = {
  endpoint: RestEndpoint;
  startMs: number;
  endMs: number;
  parts: Record<WindowKind, number>;
};

type Interval = { startMs: number; endMs: number };

class StoppedError extends Error {}

export class ExchangeRestReconciler {
  private readonly emit: EmitLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tickIntervalMs: number;

  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private initialized = false;

  private logCursor = 0;
  private disconnectedAtMs: number | undefined;
  private readonly gaps: Interval[] = [];

  private readonly queue: QueuedWindow[] = [];
  private current: QueuedWindow | undefined;
  private wake: (() => void) | undefined;
  private worker: Promise<void> | undefined;

  private readonly symbolMode: Record<RestEndpoint, boolean> = { order_history: false, execution_list: false };
  private lastRequestAtMs: number | undefined;
  private lastSweepEnqueuedAtMs = 0;
  private backfillRemaining = 0;
  private backfillDone = false;
  private checkPending = false;
  private failures = 0;

  private coveredFromMs: number | undefined;
  private requests = 0;
  private recordsFetched = 0;
  private recordsNew = 0;
  private lastSweepAtMs: number | undefined;
  private lastError: string | undefined;
  private completeness: ExchangeCompletenessStatus = emptyCompletenessStatus();

  constructor(private readonly options: ExchangeRestReconcilerOptions) {
    this.emit = options.emit ?? emitEvent;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
  }

  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref();
    this.worker = this.runWorker();
  }

  // Stops before the store closes: an answer that arrives later is dropped.
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.wake?.();
  }

  // Resolves when the worker has left its loop (tests).
  async idle(): Promise<void> {
    await this.worker;
  }

  status(): ExchangeRestStatus {
    let state: ExchangeRestState = "idle";
    if (this.stopped) {
      state = "stopped";
    } else if (!this.backfillDone) {
      state = "backfilling";
    } else if (this.current !== undefined) {
      state = "fetching";
    }
    return {
      state,
      ...(this.coveredFromMs !== undefined ? { coveredFromMs: this.coveredFromMs } : {}),
      backfillDone: this.backfillDone,
      queueWindows: this.queue.length,
      requests: this.requests,
      recordsFetched: this.recordsFetched,
      recordsNew: this.recordsNew,
      ...(this.lastSweepAtMs !== undefined ? { lastSweepAtMs: this.lastSweepAtMs } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  completenessStatus(): ExchangeCompletenessStatus {
    return { ...this.completeness };
  }

  // Triggers (design D3): the startup backfill once correlation is ready,
  // reconnects from the connection log, the sweep timer. Never throws.
  tick(): void {
    if (this.stopped) {
      return;
    }
    try {
      if (!this.options.isCorrelationReady()) {
        return;
      }
      if (!this.initialized) {
        this.initialize();
        return;
      }
      this.readConnectionLog(true);
      const now = this.now();
      if (now - this.lastSweepEnqueuedAtMs >= REST_SWEEP_INTERVAL_MS) {
        this.lastSweepEnqueuedAtMs = now;
        for (const endpoint of ENDPOINT_NAMES) {
          this.enqueue(endpoint, now - REST_SWEEP_SPAN_MS, now, "sweep");
        }
      }
    } catch (error) {
      this.recordError(errorCode(error), null);
    }
  }

  private initialize(): void {
    // Reconnects before this start are inside the backfill.
    this.readConnectionLog(false);
    const now = this.now();
    const from = now - REST_HISTORY_MS;
    const windows: QueuedWindow[] = [];
    for (const endpoint of ENDPOINT_NAMES) {
      const covered = this.coveredIntervals(endpoint, from);
      for (const gap of subtract({ startMs: from, endMs: now }, covered)) {
        for (const chunk of chunksNewestFirst(gap)) {
          windows.push({ endpoint, ...chunk, parts: { backfill: 1, reconnect: 0, sweep: 0 } });
        }
      }
    }
    // Newest first over both endpoints, so recent cycles link early.
    windows.sort((a, b) => b.endMs - a.endMs);
    this.queue.push(...windows);
    this.backfillRemaining = windows.length;
    this.backfillDone = windows.length === 0;
    this.lastSweepEnqueuedAtMs = now;
    this.refreshCoveredFrom();
    this.initialized = true;
    this.emit("info", "exchange_rest_reconciler_started", { backfillWindows: windows.length });
    if (this.backfillDone) {
      this.checkPending = true;
    }
    this.wake?.();
  }

  // A subscribed after a disconnected is one stream gap: it is fetched from
  // the disconnect time minus the margin to now (design D3).
  private readConnectionLog(enqueueGaps: boolean): void {
    for (;;) {
      const rows = this.options.store.readConnectionLogAfter(this.logCursor, 1_000);
      for (const row of rows) {
        if (row.event === "disconnected") {
          this.disconnectedAtMs ??= row.atMs;
        } else if (row.event === "subscribed" && this.disconnectedAtMs !== undefined) {
          this.gaps.push({ startMs: this.disconnectedAtMs, endMs: row.atMs });
          if (enqueueGaps) {
            const now = this.now();
            for (const endpoint of ENDPOINT_NAMES) {
              this.enqueue(endpoint, this.disconnectedAtMs - REST_RECONNECT_MARGIN_MS, Math.max(now, row.atMs), "reconnect");
            }
          }
          this.disconnectedAtMs = undefined;
        }
      }
      if (rows.length > 0) {
        this.logCursor = rows[rows.length - 1].logSeq;
      }
      if (rows.length < 1_000) {
        break;
      }
    }
    const oldest = this.now() - REST_HISTORY_MS;
    while (this.gaps.length > 0 && this.gaps[0].endMs < oldest) {
      this.gaps.shift();
    }
  }

  // Overlapping windows of one endpoint are merged while the union stays
  // within one window; the window being fetched is never changed.
  private enqueue(endpoint: RestEndpoint, startMs: number, endMs: number, kind: WindowKind): void {
    for (const chunk of chunksNewestFirst({ startMs, endMs }).reverse()) {
      const merged = this.queue.find(
        (queued) =>
          queued !== this.current &&
          queued.endpoint === endpoint &&
          queued.startMs <= chunk.endMs &&
          chunk.startMs <= queued.endMs &&
          Math.max(queued.endMs, chunk.endMs) - Math.min(queued.startMs, chunk.startMs) <= REST_WINDOW_MS,
      );
      if (merged !== undefined) {
        merged.startMs = Math.min(merged.startMs, chunk.startMs);
        merged.endMs = Math.max(merged.endMs, chunk.endMs);
        merged.parts[kind] += 1;
      } else {
        const parts = { backfill: 0, reconnect: 0, sweep: 0 };
        parts[kind] = 1;
        this.queue.push({ endpoint, ...chunk, parts });
      }
    }
    this.wake?.();
  }

  // One request at a time, FIFO; a failed window stays first in the queue and
  // is fetched again after a backoff, without deadline (design D3).
  private async runWorker(): Promise<void> {
    while (!this.stopped) {
      let endpoint: RestEndpoint | null = null;
      try {
        const next = this.queue[0];
        if (next === undefined) {
          if (this.checkPending) {
            this.checkCompleteness();
          }
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          this.wake = undefined;
          continue;
        }
        this.current = next;
        endpoint = next.endpoint;
        try {
          const counts = await this.fetchWindow(next);
          this.queue.shift();
          this.windowDone(next, counts);
        } finally {
          this.current = undefined;
        }
      } catch (error) {
        if (this.stopped || error instanceof StoppedError) {
          return;
        }
        this.recordError(errorCode(error), endpoint);
        const delay = REST_BACKOFF_MS[Math.min(this.failures, REST_BACKOFF_MS.length - 1)];
        this.failures += 1;
        await this.sleep(delay);
      }
    }
  }

  private async fetchWindow(window: QueuedWindow): Promise<{ records: number; newRecords: number }> {
    const endpoint = ENDPOINTS[window.endpoint];
    const symbolMode = this.symbolMode[window.endpoint];
    const slices: (string | undefined)[] = symbolMode ? this.symbols() : [undefined];
    let records = 0;
    let newRecords = 0;
    const completedWindow = () => ({
      endpoint: window.endpoint,
      startMs: window.startMs,
      endMs: window.endMs,
      completedAtMs: this.now(),
      records,
      newRecords,
    });

    if (slices.length === 0) {
      this.options.store.writeRestPage({ facts: [], window: completedWindow() });
      return { records, newRecords };
    }

    for (let slice = 0; slice < slices.length; slice += 1) {
      let cursor: string | undefined;
      for (let pageNumber = 0; ; pageNumber += 1) {
        let response: unknown;
        try {
          response = await this.request(window.endpoint, {
            category: this.options.category,
            ...(slices[slice] !== undefined ? { symbol: slices[slice] } : {}),
            startTime: window.startMs,
            endTime: window.endMs,
            ...(cursor !== undefined ? { cursor } : {}),
          });
        } catch (error) {
          if (!symbolMode && error instanceof Error && PARAMS_ERROR.test(error.message)) {
            this.symbolMode[window.endpoint] = true;
            this.emit("warn", "exchange_rest_symbol_required", { endpoint: window.endpoint });
            return this.fetchWindow(window);
          }
          throw error;
        }
        const page = readPage(response);
        const nextCursor = page.nextCursor !== undefined && page.nextCursor !== cursor ? page.nextCursor : undefined;
        const last = slice === slices.length - 1 && (nextCursor === undefined || pageNumber + 1 >= MAX_PAGES_PER_SLICE);
        const receivedAtMs = this.now();
        const facts: FactInput[] = page.list.map((record) => ({
          kind: endpoint.kind,
          source: "rest",
          sourceEndpoint: `rest:${endpoint.path}`,
          rawJson: JSON.stringify(record),
          receivedAtMs,
        }));
        const result = this.options.store.writeRestPage({ facts, ...(last ? { window: completedWindow() } : {}) });
        records += facts.length;
        newRecords += result.inserted;
        if (last) {
          return { records, newRecords };
        }
        if (nextCursor === undefined || pageNumber + 1 >= MAX_PAGES_PER_SLICE) {
          break;
        }
        cursor = nextCursor;
      }
    }
    return { records, newRecords };
  }

  // Pace and bar-close quiet period before every request (design D3).
  private async request(endpoint: RestEndpoint, input: BybitHistoryWindowInput): Promise<unknown> {
    for (;;) {
      if (this.stopped) {
        throw new StoppedError();
      }
      const now = this.now();
      const paceWait = this.lastRequestAtMs === undefined ? 0 : this.lastRequestAtMs + REST_PACE_MS - now;
      const phase = ((now % REST_BAR_MS) + REST_BAR_MS) % REST_BAR_MS;
      const quietWait = phase < REST_QUIET_MS ? REST_QUIET_MS - phase : 0;
      const wait = Math.max(paceWait, quietWait);
      if (wait <= 0) {
        break;
      }
      await this.sleep(wait);
    }
    this.lastRequestAtMs = this.now();
    this.requests += 1;
    const response = await ENDPOINTS[endpoint].read(this.options.reader, input);
    if (this.stopped) {
      throw new StoppedError();
    }
    return response;
  }

  private windowDone(window: QueuedWindow, counts: { records: number; newRecords: number }): void {
    this.failures = 0;
    this.lastError = undefined;
    this.recordsFetched += counts.records;
    this.recordsNew += counts.newRecords;
    this.refreshCoveredFrom();
    if (window.parts.backfill > 0) {
      this.backfillRemaining -= window.parts.backfill;
      if (this.backfillRemaining <= 0 && !this.backfillDone) {
        this.backfillDone = true;
        this.checkPending = true;
        this.emit("info", "exchange_rest_backfill_done", { coveredFromMs: this.coveredFromMs });
      }
    }
    if (window.parts.sweep > 0) {
      this.lastSweepAtMs = this.now();
      this.checkPending = true;
    }
  }

  // Bounded read of the store only; changes no data (design D6). Runs when
  // the queue drains after a sweep or the backfill; never throws.
  checkCompleteness(): void {
    try {
      this.computeCompleteness();
    } catch (error) {
      this.recordError(errorCode(error), null);
    }
  }

  private computeCompleteness(): void {
    this.checkPending = false;
    const store = this.options.store;
    const now = this.now();
    const from = this.coveredFromMs ?? now;

    const execMismatch = store
      .readTerminalOrderFills(from, COMPLETENESS_ORDER_LIMIT)
      .filter((order) => !decimalSumEquals(order.execQtys, order.cumExecQty ?? "0"))
      .map((order) => order.orderId);

    const coverage = ENDPOINT_NAMES.map((endpoint) => this.coveredIntervals(endpoint, now - REST_HISTORY_MS));
    const uncovered = this.gaps
      .filter((gap) => !coverage.every((intervals) => intervals.some((covered) => covered.startMs <= gap.startMs && gap.endMs <= covered.endMs)))
      .map((gap) => `${gap.startMs}-${gap.endMs}`);

    const withoutCloseFill = this.options
      .listRecords()
      .filter(
        (record) =>
          record.status === TERMINAL_CLOSED &&
          record.first_fill_at_ms !== null &&
          record.first_fill_at_ms >= from &&
          !store.hasLinkedCloseFill(record.strategy_instance_id, record.trade_cycle_id),
      )
      .map((record) => `${record.strategy_instance_id}/${record.trade_cycle_id}`);

    const unlabeled = store.readUnlabeledRestOrders(COMPLETENESS_IDS);

    this.completeness = {
      checkedAtMs: now,
      execMismatchOrders: execMismatch.length,
      uncoveredGaps: uncovered.length,
      closedCyclesWithoutCloseFill: withoutCloseFill.length,
      unlabeledRestOrders: unlabeled.count,
    };
    const complete = execMismatch.length + uncovered.length + withoutCloseFill.length + unlabeled.count === 0;
    this.emit(complete ? "info" : "warn", "exchange_completeness_checked", {
      ...this.completeness,
      execMismatchOrderIds: execMismatch.slice(0, COMPLETENESS_IDS),
      uncoveredGapRanges: uncovered.slice(0, COMPLETENESS_IDS),
      closedCyclesWithoutCloseFillIds: withoutCloseFill.slice(0, COMPLETENESS_IDS),
      unlabeledRestOrderIds: unlabeled.orderIds,
    });
  }

  private coveredIntervals(endpoint: RestEndpoint, fromMs: number): Interval[] {
    return union(this.options.store.readRestWindows(endpoint, fromMs));
  }

  // The start of the coverage that reaches the latest covered time, on both
  // endpoints.
  private refreshCoveredFrom(): void {
    let from: number | undefined;
    for (const endpoint of ENDPOINT_NAMES) {
      const intervals = this.coveredIntervals(endpoint, this.now() - REST_HISTORY_MS);
      const latest = intervals[intervals.length - 1];
      if (latest === undefined) {
        this.coveredFromMs = undefined;
        return;
      }
      from = from === undefined ? latest.startMs : Math.max(from, latest.startMs);
    }
    this.coveredFromMs = from;
  }

  private symbols(): string[] {
    const symbols = new Set(this.options.store.listFactSymbols());
    for (const record of this.options.listRecords()) {
      if (record.exchange_symbol !== "") {
        symbols.add(record.exchange_symbol);
      }
    }
    return [...symbols].sort();
  }

  private recordError(code: string, endpoint: RestEndpoint | null): void {
    if (this.lastError !== code) {
      this.emit("error", "exchange_rest_request_failed", { endpoint, errorCode: code });
    }
    this.lastError = code;
  }
}

export type ExchangeRestReconcilerHandle = {
  start(): void;
  stop(): void;
  status(): ExchangeRestStatus;
  completenessStatus(): ExchangeCompletenessStatus;
};

// Created only with an enabled store and a key; otherwise a no-op handle
// reports why (design D7).
export function createExchangeRestReconciler(
  config: AbiConfig,
  exchangeFacts: ExchangeFactsStoreState,
  deps: Omit<ExchangeRestReconcilerOptions, "store" | "category">,
): ExchangeRestReconcilerHandle {
  if (exchangeFacts.status !== "enabled") {
    return disabledHandle("store_not_enabled");
  }
  if (config.bybitApiKey === "" || config.bybitApiSecret === "") {
    return disabledHandle("no_api_key");
  }
  return new ExchangeRestReconciler({ ...deps, store: exchangeFacts.store, category: config.bybitCategory });
}

function disabledHandle(reason: string): ExchangeRestReconcilerHandle {
  const status = disabledRestStatus(reason);
  const completeness = emptyCompletenessStatus();
  return { start: () => undefined, stop: () => undefined, status: () => status, completenessStatus: () => completeness };
}

function readPage(response: unknown): { list: Record<string, unknown>[]; nextCursor?: string } {
  const result = isObject(response) ? response.result : undefined;
  if (!isObject(result) || !Array.isArray(result.list) || !result.list.every(isObject)) {
    throw codedError("malformed_response");
  }
  const cursor = result.nextPageCursor;
  return {
    list: result.list,
    ...(typeof cursor === "string" && cursor !== "" ? { nextCursor: cursor } : {}),
  };
}

// Union of windows as sorted, non-overlapping intervals; touching windows join.
export function union(windows: readonly Interval[]): Interval[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const result: Interval[] = [];
  for (const window of sorted) {
    const last = result[result.length - 1];
    if (last !== undefined && window.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, window.endMs);
    } else {
      result.push({ startMs: window.startMs, endMs: window.endMs });
    }
  }
  return result;
}

// The parts of a range not inside sorted covered intervals.
export function subtract(range: Interval, covered: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let start = range.startMs;
  for (const interval of covered) {
    if (interval.endMs <= start || interval.startMs >= range.endMs) {
      continue;
    }
    if (interval.startMs > start) {
      result.push({ startMs: start, endMs: interval.startMs });
    }
    start = Math.max(start, interval.endMs);
  }
  if (start < range.endMs) {
    result.push({ startMs: start, endMs: range.endMs });
  }
  return result;
}

function chunksNewestFirst(range: Interval): Interval[] {
  const chunks: Interval[] = [];
  for (let end = range.endMs; end > range.startMs; end -= REST_WINDOW_MS) {
    chunks.push({ startMs: Math.max(range.startMs, end - REST_WINDOW_MS), endMs: end });
  }
  return chunks;
}

// Exact decimal comparison of a sum of execQty with cumExecQty.
export function decimalSumEquals(parts: readonly string[], total: string): boolean {
  const all = [...parts, total];
  if (!all.every((text) => /^\d+(\.\d+)?$/.test(text))) {
    return false;
  }
  const scale = Math.max(...all.map((text) => (text.split(".")[1] ?? "").length));
  const scaled = (text: string) => {
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole + fraction.padEnd(scale, "0"));
  };
  return parts.reduce((sum, part) => sum + scaled(part), 0n) === scaled(total);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// A stable code, never a message: no payloads in events (design D7).
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return "timeout";
    }
    const retCode = /retCode (\d+)/.exec(error.message);
    if (retCode !== null) {
      return `retCode_${retCode[1]}`;
    }
    const http = /Bybit HTTP (\d+)/.exec(error.message);
    if (http !== null) {
      return `http_${http[1]}`;
    }
    return error.name;
  }
  return "unknown_error";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
