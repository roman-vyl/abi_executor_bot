export type BybitExecutionView = {
  execTimeMs: number;
};

export type ExecutionListProtocolFailureReason =
  | "malformed_envelope"
  | "category_mismatch"
  | "list_not_array"
  | "malformed_item"
  | "symbol_mismatch"
  | "invalid_exec_type"
  | "invalid_exec_time";

export type DecodedExecutionListPage =
  | { kind: "ok"; executions: BybitExecutionView[]; nextCursor: string }
  | { kind: "protocol_failure"; reason: ExecutionListProtocolFailureReason };

// Pure decoder for a single /v5/execution/list page, scoped to exactly what
// resolveFirstAttributableFillAtMs needs: each item's own execTime, and the
// page's own cursor. Attribution rests on the query's own orderLinkId filter
// (a deterministic, durable identity this cycle's own record already
// carries) — this decoder does not re-validate a per-item orderLinkId echo,
// the same trust level this codebase's other own-order queries already
// place in their own orderLinkId filters. Only genuine trade-fill executions
// are accepted: execType must be exactly "Trade", since ABI's entry orders
// are plain triggered market orders no ADL/delivery/block-trade mechanism
// ever legitimately produces an execution against.
export function decodeExecutionListResponsePage(input: {
  response: unknown;
  expected: { category: string; symbol: string };
}): DecodedExecutionListPage {
  const { response, expected } = input;

  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.category !== expected.category) {
    return { kind: "protocol_failure", reason: "category_mismatch" };
  }

  const list = resultRecord.list;
  if (!Array.isArray(list)) {
    return { kind: "protocol_failure", reason: "list_not_array" };
  }

  // A missing nextPageCursor key is a malformed envelope, not a silent
  // empty string — an empty string is only ever a legitimate value when the
  // key is genuinely present and empty (the documented "last page" signal).
  const nextPageCursor = resultRecord.nextPageCursor;
  if (typeof nextPageCursor !== "string") {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const executions: BybitExecutionView[] = [];

  for (const item of list) {
    if (typeof item !== "object" || item === null) {
      return { kind: "protocol_failure", reason: "malformed_item" };
    }

    const record = item as Record<string, unknown>;

    if (record.symbol !== expected.symbol) {
      return { kind: "protocol_failure", reason: "symbol_mismatch" };
    }

    if (record.execType !== "Trade") {
      return { kind: "protocol_failure", reason: "invalid_exec_type" };
    }

    const execTime = record.execTime;
    if (typeof execTime !== "string" || execTime === "") {
      return { kind: "protocol_failure", reason: "invalid_exec_time" };
    }

    const execTimeMs = Number(execTime);
    if (!Number.isInteger(execTimeMs) || execTimeMs < 0) {
      return { kind: "protocol_failure", reason: "invalid_exec_time" };
    }

    executions.push({ execTimeMs });
  }

  return { kind: "ok", executions, nextCursor: nextPageCursor };
}
