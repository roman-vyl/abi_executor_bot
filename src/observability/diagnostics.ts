// Temporary timing diagnostics, off unless ABI_DIAGNOSTICS_PATH is set.
// Appends one JSON line per finished Runtime-facing operation (with every
// Bybit request it made and the reason of any internal_error) to a local
// file that survives container recreation. Write-only side channel: nothing
// here is read back, and no call site's return value, thrown error or
// timing depends on it. Every write failure is swallowed.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs";

type BybitCallRecord = {
  method: string;
  path: string;
  started_at: string;
  duration_ms: number;
  http_status?: number;
  error_name?: string;
  error_message?: string;
};

type OperationContext = {
  bybitCalls: BybitCallRecord[];
  notes: string[];
};

const MAX_MESSAGE_LENGTH = 500;

let diagnosticsPath: string | null = null;
const operationContext = new AsyncLocalStorage<OperationContext>();

export function configureDiagnostics(path: string | undefined): void {
  const trimmed = path?.trim() ?? "";
  diagnosticsPath = trimmed === "" ? null : trimmed;
  if (diagnosticsPath !== null) {
    writeLine({ event: "diagnostics_started", pid: process.pid });
  }
}

export function diagnosticsEnabled(): boolean {
  return diagnosticsPath !== null;
}

// Runs `run` inside a fresh operation context and writes one summary line
// when it settles. When diagnostics are off this is exactly `run()`.
export async function withDiagnosticsOperation<T>(
  fields: Record<string, unknown>,
  run: () => Promise<T>,
  summarize: (result: T) => Record<string, unknown>,
): Promise<T> {
  if (diagnosticsPath === null) {
    return run();
  }

  const context: OperationContext = { bybitCalls: [], notes: [] };
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  let result: T;
  try {
    result = await operationContext.run(context, run);
  } catch (error) {
    writeOperation(fields, context, startedAt, startedNs, { ...errorFields(error), outcome: "thrown" });
    throw error;
  }
  writeOperation(fields, context, startedAt, startedNs, safeSummary(summarize, result));
  return result;
}

// Times one Bybit HTTP request (fetch + response read). The request itself
// is untouched: its result or error passes through unchanged.
export async function timeBybitRequest<T>(method: string, path: string, request: () => Promise<T>): Promise<T> {
  if (diagnosticsPath === null) {
    return request();
  }

  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  try {
    const result = await request();
    recordBybitCall({ method, path, started_at: startedAt.toISOString(), duration_ms: elapsedMs(startedNs) });
    return result;
  } catch (error) {
    recordBybitCall({
      method,
      path,
      started_at: startedAt.toISOString(),
      duration_ms: elapsedMs(startedNs),
      ...errorFields(error),
    });
    throw error;
  }
}

// Names the reason an operation is about to answer internal_error.
export function noteDiagnostic(note: string, error?: unknown): void {
  if (diagnosticsPath === null) {
    return;
  }
  const context = operationContext.getStore();
  const text = error === undefined ? note : `${note}: ${describeError(error)}`;
  if (context === undefined) {
    writeLine({ event: "note_outside_operation", note: text });
    return;
  }
  context.notes.push(text);
}

function recordBybitCall(call: BybitCallRecord): void {
  const context = operationContext.getStore();
  if (context === undefined) {
    writeLine({ event: "bybit_request_outside_operation", ...call });
    return;
  }
  context.bybitCalls.push(call);
}

function writeOperation(
  fields: Record<string, unknown>,
  context: OperationContext,
  startedAt: Date,
  startedNs: bigint,
  summary: Record<string, unknown>,
): void {
  const bybitTotalMs = context.bybitCalls.reduce((total, call) => total + call.duration_ms, 0);
  writeLine({
    event: "operation",
    ...fields,
    ...summary,
    started_at: startedAt.toISOString(),
    duration_ms: elapsedMs(startedNs),
    bybit_request_count: context.bybitCalls.length,
    bybit_total_ms: round(bybitTotalMs),
    bybit_max_ms: round(Math.max(0, ...context.bybitCalls.map((call) => call.duration_ms))),
    notes: context.notes,
    bybit_requests: context.bybitCalls,
  });
}

function safeSummary<T>(summarize: (result: T) => Record<string, unknown>, result: T): Record<string, unknown> {
  try {
    return summarize(result);
  } catch {
    return {};
  }
}

function writeLine(fields: Record<string, unknown>): void {
  const path = diagnosticsPath;
  if (path === null) {
    return;
  }
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...fields });
    appendFile(path, `${line}\n`, () => {
      // Diagnostics never affect the service: write errors are dropped.
    });
  } catch {
    // Same: serialization or path errors are dropped.
  }
}

function errorFields(error: unknown): { error_name: string; error_message: string } {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: truncate(describeError(error)) };
  }
  return { error_name: typeof error, error_message: truncate(String(error)) };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? ` (cause: ${error.cause.name}: ${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}...` : text;
}

function elapsedMs(startedNs: bigint): number {
  return round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
