import type { IncomingMessage, ServerResponse } from "node:http";

import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import { writeJson } from "../app/http.js";
import type { EntryPackageValidationDetail } from "../domain/entryPackageApi.js";
import { decodeOpaquePathValue } from "../domain/openPositionApi.js";
import type { ExchangeFactsStore, StoredFact, StoredLink } from "../exchangeFacts/exchangeFactsStore.js";
import type { ExchangeLinkerStatus } from "../exchangeFacts/exchangeOrderLinker.js";
import type { ExchangeCompletenessStatus, ExchangeRestStatus } from "../exchangeFacts/exchangeRestReconciler.js";
import { SCHEMA_VERSION } from "../exchangeFacts/schema.js";
import type { ExchangeStreamStatus } from "../exchangeStream/exchangeStreamRecorder.js";
import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";

// Read-only HTTP API over the exchange facts store
// (abi-exchange-journal-read-api-v1). Only SELECTs: never writes the store,
// never calls Bybit, never touches trading state.

const DEFAULT_PAGE = 500;
const MAX_PAGE = 1000;
const MAX_ORDER_EVENTS = 1000;
const MAX_CYCLE_ORDERS = 200;

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export type ExchangeJournalHealth = {
  stream: ExchangeStreamStatus;
  linker: ExchangeLinkerStatus;
  rest: ExchangeRestStatus;
  completeness: ExchangeCompletenessStatus;
};

type Route =
  | { endpoint: "facts" | "order_links" | "status" }
  | { endpoint: "order"; orderId?: string }
  | { endpoint: "cycle"; strategyInstanceId?: string; tradeCycleId?: string };

type Result = { statusCode: number; body: object };

export async function handleExchangeJournalRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  exchangeFacts: ExchangeFactsStoreState;
  health: () => ExchangeJournalHealth;
  emit?: EmitLike;
}): Promise<boolean> {
  const { request, response, exchangeFacts, health } = input;
  const emit = input.emit ?? emitEvent;

  if (request.method !== "GET" || request.url === undefined) {
    return false;
  }

  const queryStart = request.url.indexOf("?");
  const pathname = queryStart === -1 ? request.url : request.url.slice(0, queryStart);
  const query = new URLSearchParams(queryStart === -1 ? "" : request.url.slice(queryStart + 1));
  const details: EntryPackageValidationDetail[] = [];
  const route = matchRoute(pathname, details);
  if (route === null) {
    return false;
  }

  let result: Result;
  try {
    result = answer(route, query, details, exchangeFacts, health);
  } catch (error) {
    emit("error", "exchange_journal_read_failed", { endpoint: route.endpoint, errorCode: errorCode(error) });
    result = errorResult(500, "internal_error", "internal error");
  }
  writeJson(response, result.statusCode, result.body);
  return true;
}

function matchRoute(pathname: string, details: EntryPackageValidationDetail[]): Route | null {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "v1") {
    return null;
  }

  if (segments[2] === "exchange-journal") {
    if (segments.length === 4 && segments[3] === "facts") {
      return { endpoint: "facts" };
    }
    if (segments.length === 4 && segments[3] === "order-links") {
      return { endpoint: "order_links" };
    }
    if (segments.length === 4 && segments[3] === "status") {
      return { endpoint: "status" };
    }
    if (segments.length === 5 && segments[3] === "orders") {
      return { endpoint: "order", orderId: decodeOpaquePathValue(segments[4], "/path/order_id", details) };
    }
    return null;
  }

  if (
    segments.length === 7 &&
    segments[2] === "strategy-instances" &&
    segments[4] === "trade-cycles" &&
    segments[6] === "exchange-journal"
  ) {
    return {
      endpoint: "cycle",
      strategyInstanceId: decodeOpaquePathValue(segments[3], "/path/strategy_instance_id", details),
      tradeCycleId: decodeOpaquePathValue(segments[5], "/path/trade_cycle_id", details),
    };
  }

  return null;
}

function answer(
  route: Route,
  query: URLSearchParams,
  details: EntryPackageValidationDetail[],
  exchangeFacts: ExchangeFactsStoreState,
  health: () => ExchangeJournalHealth,
): Result {
  const allowed = route.endpoint === "facts"
    ? ["after_seq", "limit", "symbol", "strategy_instance_id", "from_ms", "to_ms"]
    : route.endpoint === "order_links"
      ? ["after_seq", "limit"]
      : [];
  const params = readParams(query, allowed, details);

  if (details.length > 0) {
    return validationFailed(details);
  }

  if (route.endpoint === "status") {
    return { statusCode: 200, body: statusBody(exchangeFacts, health()) };
  }

  if (exchangeFacts.status !== "enabled") {
    return errorResult(503, "exchange_journal_unavailable", `exchange facts store is ${exchangeFacts.status}`);
  }
  const store = exchangeFacts.store;

  switch (route.endpoint) {
    case "facts":
      return factsPage(store, params, details);
    case "order_links":
      return linksPage(store, params, details);
    case "order":
      return orderView(store, route.orderId!);
    case "cycle":
      return cycleView(store, route.strategyInstanceId!, route.tradeCycleId!);
  }
}

function readParams(
  query: URLSearchParams,
  allowed: readonly string[],
  details: EntryPackageValidationDetail[],
): Map<string, string> {
  const params = new Map<string, string>();
  for (const name of new Set(query.keys())) {
    const path = `/query/${name}`;
    if (!allowed.includes(name)) {
      details.push({ path, message: "unknown query parameter" });
      continue;
    }
    const values = query.getAll(name);
    if (values.length !== 1) {
      details.push({ path, message: "query parameter must appear once" });
      continue;
    }
    if (values[0] === "") {
      details.push({ path, message: "query parameter must be non-empty" });
      continue;
    }
    params.set(name, values[0]);
  }
  return params;
}

function integerParam(
  params: Map<string, string>,
  name: string,
  min: number,
  max: number,
  details: EntryPackageValidationDetail[],
): number | undefined {
  const raw = params.get(name);
  if (raw === undefined) {
    return undefined;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    details.push({ path: `/query/${name}`, message: `must be an integer from ${min} to ${max}` });
    return undefined;
  }
  return value;
}

function cursorParams(
  params: Map<string, string>,
  details: EntryPackageValidationDetail[],
): { afterSeq: number; limit: number } {
  return {
    afterSeq: integerParam(params, "after_seq", 0, Number.MAX_SAFE_INTEGER, details) ?? 0,
    limit: integerParam(params, "limit", 1, MAX_PAGE, details) ?? DEFAULT_PAGE,
  };
}

function factsPage(store: ExchangeFactsStore, params: Map<string, string>, details: EntryPackageValidationDetail[]): Result {
  const { afterSeq, limit } = cursorParams(params, details);
  const fromMs = integerParam(params, "from_ms", 0, Number.MAX_SAFE_INTEGER, details);
  const toMs = integerParam(params, "to_ms", 0, Number.MAX_SAFE_INTEGER, details);
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
    details.push({ path: "/query/from_ms", message: "from_ms must be less than to_ms" });
  }
  if (details.length > 0) {
    return validationFailed(details);
  }

  const rows = store.readJournalFacts({
    afterSeq,
    limit: limit + 1,
    symbol: params.get("symbol"),
    strategyInstanceId: params.get("strategy_instance_id"),
    fromMs,
    toMs,
  });
  const items = rows.slice(0, limit);
  return {
    statusCode: 200,
    body: {
      items: items.map((row) => ({ ...eventBody(row.fact), link: row.link === null ? null : linkBody(row.link) })),
      next_after_seq: items.length === 0 ? afterSeq : items[items.length - 1].fact.eventSeq,
      has_more: rows.length > limit,
    },
  };
}

function linksPage(store: ExchangeFactsStore, params: Map<string, string>, details: EntryPackageValidationDetail[]): Result {
  const { afterSeq, limit } = cursorParams(params, details);
  if (details.length > 0) {
    return validationFailed(details);
  }

  const rows = store.readLinksAfterForJournal(afterSeq, limit + 1);
  const items = rows.slice(0, limit);
  return {
    statusCode: 200,
    body: {
      items: items.map(linkBody),
      next_after_seq: items.length === 0 ? afterSeq : items[items.length - 1].linkSeq,
      has_more: rows.length > limit,
    },
  };
}

function orderView(store: ExchangeFactsStore, orderId: string): Result {
  const link = store.readLinkForOrder(orderId);
  const events = store.readFactsForOrder(orderId, MAX_ORDER_EVENTS + 1);
  if (link === null && events.length === 0) {
    return errorResult(404, "order_not_found", "no event and no link for this order_id");
  }
  return {
    statusCode: 200,
    body: {
      order_id: orderId,
      link: link === null ? null : linkBody(link),
      events: events.slice(0, MAX_ORDER_EVENTS).map(eventBody),
      truncated: events.length > MAX_ORDER_EVENTS,
    },
  };
}

function cycleView(store: ExchangeFactsStore, strategyInstanceId: string, tradeCycleId: string): Result {
  const links = store.readLinksForCycle(strategyInstanceId, tradeCycleId, MAX_CYCLE_ORDERS + 1);
  return {
    statusCode: 200,
    body: {
      strategy_instance_id: strategyInstanceId,
      trade_cycle_id: tradeCycleId,
      orders: links.slice(0, MAX_CYCLE_ORDERS).map((link) => {
        const events = store.readFactsForOrder(link.orderId, MAX_ORDER_EVENTS + 1);
        return {
          link: linkBody(link),
          events: events.slice(0, MAX_ORDER_EVENTS).map(eventBody),
          truncated: events.length > MAX_ORDER_EVENTS,
        };
      }),
      truncated: links.length > MAX_CYCLE_ORDERS,
    },
  };
}

function statusBody(exchangeFacts: ExchangeFactsStoreState, health: ExchangeJournalHealth): object {
  const sequences = exchangeFacts.status === "enabled" ? exchangeFacts.store.readLastSequences() : null;
  return {
    store: exchangeFacts.status,
    ...(exchangeFacts.status === "unavailable" ? { store_reason: exchangeFacts.reason } : {}),
    schema_version: SCHEMA_VERSION,
    last_event_seq: sequences === null ? null : sequences.lastEventSeq,
    last_link_seq: sequences === null ? null : sequences.lastLinkSeq,
    stream: health.stream,
    linker: health.linker,
    rest: health.rest,
    completeness: health.completeness,
  };
}

function eventBody(fact: StoredFact): object {
  return {
    event_seq: fact.eventSeq,
    fact_kind: fact.kind,
    source: fact.source,
    source_endpoint: fact.sourceEndpoint,
    symbol: fact.symbol,
    order_id: fact.orderId,
    order_link_id: fact.orderLinkId,
    parent_order_link_id: fact.parentOrderLinkId,
    exec_id: fact.execId,
    exec_type: fact.execType,
    order_status: fact.orderStatus,
    exchange_time_ms: fact.exchangeTimeMs,
    received_at_ms: fact.receivedAtMs,
    raw: JSON.parse(fact.rawJson) as unknown,
  };
}

function linkBody(link: StoredLink): object {
  return {
    link_seq: link.linkSeq,
    order_id: link.orderId,
    strategy_instance_id: link.strategyInstanceId,
    trade_cycle_id: link.tradeCycleId,
    role: link.role,
    generation: link.generation,
    order_link_id: link.orderLinkId,
    parent_order_link_id: link.parentOrderLinkId,
    evidence: link.evidence,
    established_at_ms: link.establishedAtMs,
  };
}

function validationFailed(details: EntryPackageValidationDetail[]): Result {
  return {
    statusCode: 422,
    body: { error: { code: "validation_failed", message: "request validation failed", details } },
  };
}

function errorResult(statusCode: number, code: string, message: string): Result {
  return { statusCode, body: { error: { code, message } } };
}

// A stable code, never a message: no payloads in events.
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
  }
  return error instanceof Error ? error.name : "unknown";
}
