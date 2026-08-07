import { createHmac } from "node:crypto";

import type { AbiConfig } from "../config/config.js";
import { classifyExactDecimalText, isExactDecimalText, isPositiveExactDecimalText } from "../domain/entryPackageApi.js";
import type {
  BybitAmendOrderPayload,
  BybitCancelOrderPayload,
  BybitCancelAllOrdersPayload,
  BybitCreateOrderPayload,
  BybitGetOrderByLinkIdPayload,
  BybitGetOrderHistoryPayload,
  BybitMarketCloseOrderPayload,
} from "./bybitOrderMapper.js";

export type BybitOrderSide = "Buy" | "Sell";

export type BybitPosition = {
  symbol: string;
  side: BybitOrderSide | "None";
  size: string;
  positionIdx?: number;
  avgPrice?: string;
  openTime?: number;
};

export type PositionQueryInput = {
  category: string;
  symbol: string;
};

export type ValidatedOpenPositionRow = {
  symbol: string;
  side: BybitOrderSide;
  size: string;
  positionIdx: 0;
  avgPrice: string;
  openTime: number;
  // Raw exact-decimal strings, present only when Bybit's response carries a
  // syntactically valid value — never required, and never validated for
  // sign/positivity the way avgPrice is: an unset protection leg is
  // legitimately reported as a numeric zero (e.g. "0.00"), so a strict
  // positivity check here would wrongly fail this query for any position
  // without protection set. A missing or malformed value is simply omitted
  // rather than failing the whole row; only protection-execution's own
  // read-back reads these fields today (protection-execution design.md
  // Decision 6).
  stopLoss?: string;
  takeProfit?: string;
};

export type PositionQueryFailureReason =
  | "transport_error"
  | "malformed_envelope"
  | "category_mismatch"
  | "no_row_returned"
  | "multiple_rows_returned"
  | "malformed_item"
  | "symbol_mismatch"
  | "invalid_position_idx"
  | "invalid_size"
  | "invalid_side"
  | "invalid_avg_price"
  | "invalid_open_time";

export type PositionQueryResult =
  | { kind: "no_position" }
  | { kind: "position"; row: ValidatedOpenPositionRow }
  | { kind: "failure"; reason: PositionQueryFailureReason };

export type PlaceMarketOrderInput = {
  symbol: string;
  side: BybitOrderSide;
  qty: string;
  orderLinkId: string;
};

// Both legs are always present: a protection write is a full-state replace,
// never a partial patch (position-management-api's contract requires
// stop_price on every request and take_price null-or-positive). "0" is
// Bybit's own convention on this endpoint for "remove this leg" — callers
// pass it explicitly rather than an optional/absent field (protection-
// execution design.md Decision 5).
export type SetTradingStopInput = {
  category: string;
  symbol: string;
  stopLoss: string;
  takeProfit: string;
};

export interface BybitAdapter {
  getServerTime(): Promise<unknown>;
  getWalletBalance(input?: GetWalletBalanceInput): Promise<unknown>;
  getActiveOrders(input?: GetActiveOrdersInput): Promise<unknown>;
  getOpenPositions(input?: GetOpenPositionsInput): Promise<unknown>;
  queryPositionForInstrument(input: PositionQueryInput): Promise<PositionQueryResult>;
  createOrder(payload: BybitCreateOrderPayload | BybitMarketCloseOrderPayload): Promise<unknown>;
  amendOrder(payload: BybitAmendOrderPayload): Promise<unknown>;
  cancelOrder(payload: BybitCancelOrderPayload): Promise<unknown>;
  cancelAllOrders(payload: BybitCancelAllOrdersPayload): Promise<unknown>;
  getOrderByLinkId(payload: BybitGetOrderByLinkIdPayload): Promise<unknown>;
  getOrderHistory(payload: BybitGetOrderHistoryPayload): Promise<unknown>;
  getInstrumentInfo(category: string, symbol: string): Promise<unknown>;
  getPosition(symbol: string): Promise<BybitPosition | null>;
  getMarketPrice(symbol: string): Promise<string>;
  placeMarketOrder(input: PlaceMarketOrderInput): Promise<unknown>;
  setTradingStop(input: SetTradingStopInput): Promise<unknown>;
}

export type GetWalletBalanceInput = {
  coin?: string;
};

export type GetActiveOrdersInput = {
  symbol?: string;
  settleCoin?: string;
};

export type GetOpenPositionsInput = {
  category?: string;
  symbol?: string;
  settleCoin?: string;
};

export class RestBybitAdapter implements BybitAdapter {
  private readonly baseUrl: string;
  private readonly config: AbiConfig;

  constructor(config: AbiConfig) {
    this.config = config;
    this.baseUrl = getBybitBaseUrl(config);
  }

  async getServerTime(): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/v5/market/time`, { signal: this.timeoutSignal() });
    return readBybitResponse(response);
  }

  async getWalletBalance(input: GetWalletBalanceInput = {}): Promise<unknown> {
    const params = new URLSearchParams({
      accountType: this.config.bybitAccountType,
    });

    if (input.coin !== undefined && input.coin.trim() !== "") {
      params.set("coin", input.coin.trim().toUpperCase());
    }

    return this.signedGet("/v5/account/wallet-balance", params);
  }

  async getActiveOrders(input: GetActiveOrdersInput = {}): Promise<unknown> {
    const params = new URLSearchParams({
      category: this.config.bybitCategory,
      openOnly: "0",
      limit: "50",
    });

    setSymbolOrSettleCoin(params, input.symbol, input.settleCoin ?? this.config.bybitSettleCoin);

    return this.signedGet("/v5/order/realtime", params);
  }

  async getOpenPositions(input: GetOpenPositionsInput = {}): Promise<unknown> {
    const params = new URLSearchParams({
      category: input.category ?? this.config.bybitCategory,
    });

    setSymbolOrSettleCoin(params, input.symbol, input.settleCoin ?? this.config.bybitSettleCoin);

    return this.signedGet("/v5/position/list", params);
  }

  // Explicit { category, symbol } in, a structurally valid one-way row, "no
  // position", or a typed failure out — never `position_open: false` on a
  // query failure. Does not know or check any trade-specific desired side;
  // that plausibility check belongs to the caller (design.md Decision 4/5).
  async queryPositionForInstrument(input: PositionQueryInput): Promise<PositionQueryResult> {
    let response: unknown;
    try {
      response = await this.getOpenPositions({ category: input.category, symbol: input.symbol });
    } catch {
      return { kind: "failure", reason: "transport_error" };
    }

    return evaluatePositionQueryResponse(response, input);
  }

  async createOrder(payload: BybitCreateOrderPayload | BybitMarketCloseOrderPayload): Promise<unknown> {
    return this.signedPost("/v5/order/create", payload);
  }

  async amendOrder(payload: BybitAmendOrderPayload): Promise<unknown> {
    return this.signedPost("/v5/order/amend", payload);
  }

  async cancelOrder(payload: BybitCancelOrderPayload): Promise<unknown> {
    return this.signedPost("/v5/order/cancel", payload);
  }

  async cancelAllOrders(payload: BybitCancelAllOrdersPayload): Promise<unknown> {
    return this.signedPost("/v5/order/cancel-all", payload);
  }

  async getOrderByLinkId(payload: BybitGetOrderByLinkIdPayload): Promise<unknown> {
    return this.signedGet(
      "/v5/order/realtime",
      new URLSearchParams({
        category: payload.category,
        symbol: payload.symbol,
        orderLinkId: payload.orderLinkId,
        limit: payload.limit,
      }),
    );
  }

  // getOrderByLinkId's /v5/order/realtime cannot see an order that has
  // already fully filled and closed, been rejected, or been terminated by
  // the exchange — those leave the realtime set. This queries the durable
  // order-history endpoint instead (design.md §10).
  async getOrderHistory(payload: BybitGetOrderHistoryPayload): Promise<unknown> {
    return this.signedGet(
      "/v5/order/history",
      new URLSearchParams({
        category: payload.category,
        symbol: payload.symbol,
        orderLinkId: payload.orderLinkId,
        limit: payload.limit,
      }),
    );
  }

  // Public, unauthenticated — unlike every other bybitAdapter.ts method, this
  // one is intentionally not signed (design.md §7).
  async getInstrumentInfo(category: string, symbol: string): Promise<unknown> {
    const params = new URLSearchParams({
      category,
      symbol,
    });

    const response = await fetch(`${this.baseUrl}/v5/market/instruments-info?${params.toString()}`, {
      signal: this.timeoutSignal(),
    });
    return readBybitResponse(response);
  }

  async getPosition(symbol: string): Promise<BybitPosition | null> {
    return readOpenPosition(await this.getOpenPositions({ symbol }));
  }

  async getMarketPrice(symbol: string): Promise<string> {
    const response = await this.signedGet(
      "/v5/market/tickers",
      new URLSearchParams({
        category: this.config.bybitCategory,
        symbol,
      }),
    );

    return readTickerLastPrice(response);
  }

  async placeMarketOrder(input: PlaceMarketOrderInput): Promise<unknown> {
    return stub("placeMarketOrder", input);
  }

  // Position-level protection write, not an order amend — replaces the
  // whole current stop-loss/take-profit state for the position
  // (positionIdx=0, tpslMode=Full), never a delta (protection-execution
  // design.md Decision 5).
  async setTradingStop(input: SetTradingStopInput): Promise<unknown> {
    return this.signedPost("/v5/position/trading-stop", {
      category: input.category,
      symbol: input.symbol,
      positionIdx: 0,
      tpslMode: "Full",
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      tpTriggerBy: this.config.bybitTriggerBy,
      slTriggerBy: this.config.bybitTriggerBy,
    });
  }

  private async signedGet(path: string, params: URLSearchParams): Promise<unknown> {
    if (this.config.bybitApiKey === "" || this.config.bybitApiSecret === "") {
      throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET are required");
    }

    const timestamp = String(Date.now());
    const queryString = params.toString();
    const signaturePayload = `${timestamp}${this.config.bybitApiKey}${this.config.bybitRecvWindow}${queryString}`;
    const signature = createHmac("sha256", this.config.bybitApiSecret)
      .update(signaturePayload)
      .digest("hex");

    const response = await fetch(`${this.baseUrl}${path}?${queryString}`, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": this.config.bybitApiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": this.config.bybitRecvWindow,
        "X-BAPI-SIGN": signature,
      },
      signal: this.timeoutSignal(),
    });

    return readBybitResponse(response);
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.config.bybitRequestTimeoutMs);
  }

  private async signedPost(path: string, payload: object): Promise<unknown> {
    if (this.config.bybitApiKey === "" || this.config.bybitApiSecret === "") {
      throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET are required");
    }

    const timestamp = String(Date.now());
    const body = JSON.stringify(payload);
    const signaturePayload = `${timestamp}${this.config.bybitApiKey}${this.config.bybitRecvWindow}${body}`;
    const signature = createHmac("sha256", this.config.bybitApiSecret)
      .update(signaturePayload)
      .digest("hex");

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "X-BAPI-API-KEY": this.config.bybitApiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": this.config.bybitRecvWindow,
        "X-BAPI-SIGN": signature,
      },
      body,
      signal: this.timeoutSignal(),
    });

    return readBybitResponse(response);
  }
}

function getBybitBaseUrl(config: AbiConfig): string {
  if (config.bybitEnvironment === "demo") {
    return "https://api-demo.bybit.com";
  }

  if (config.bybitEnvironment === "testnet") {
    return "https://api-testnet.bybit.com";
  }

  return "https://api.bybit.com";
}

export class StubBybitAdapter implements BybitAdapter {
  async getServerTime(): Promise<unknown> {
    return stub("getServerTime");
  }

  async getWalletBalance(input: GetWalletBalanceInput = {}): Promise<unknown> {
    void input;
    return stub("getWalletBalance");
  }

  async getActiveOrders(input: GetActiveOrdersInput = {}): Promise<unknown> {
    return stub("getActiveOrders", input);
  }

  async getOpenPositions(input: GetOpenPositionsInput = {}): Promise<unknown> {
    return stub("getOpenPositions", input);
  }

  async queryPositionForInstrument(input: PositionQueryInput): Promise<PositionQueryResult> {
    return stub("queryPositionForInstrument", input);
  }

  async createOrder(payload: BybitCreateOrderPayload | BybitMarketCloseOrderPayload): Promise<unknown> {
    return stub("createOrder", payload);
  }

  async amendOrder(payload: BybitAmendOrderPayload): Promise<unknown> {
    return stub("amendOrder", payload);
  }

  async cancelOrder(payload: BybitCancelOrderPayload): Promise<unknown> {
    return stub("cancelOrder", payload);
  }

  async cancelAllOrders(payload: BybitCancelAllOrdersPayload): Promise<unknown> {
    return stub("cancelAllOrders", payload);
  }

  async getOrderByLinkId(payload: BybitGetOrderByLinkIdPayload): Promise<unknown> {
    return stub("getOrderByLinkId", payload);
  }

  async getOrderHistory(payload: BybitGetOrderHistoryPayload): Promise<unknown> {
    return stub("getOrderHistory", payload);
  }

  async getInstrumentInfo(category: string, symbol: string): Promise<unknown> {
    return stub("getInstrumentInfo", { category, symbol });
  }

  async getPosition(symbol: string): Promise<BybitPosition | null> {
    void symbol;
    return null;
  }

  async getMarketPrice(symbol: string): Promise<string> {
    void symbol;
    return stub("getMarketPrice");
  }

  async placeMarketOrder(input: PlaceMarketOrderInput): Promise<unknown> {
    return stub("placeMarketOrder", input);
  }

  async setTradingStop(input: SetTradingStopInput): Promise<unknown> {
    return stub("setTradingStop", input);
  }

}

function stub(method: string, payload: unknown = {}): never {
  throw new Error(`BybitAdapter.${method} is not implemented yet: ${JSON.stringify(payload)}`);
}

function setSymbolOrSettleCoin(params: URLSearchParams, symbol: string | undefined, settleCoin: string): void {
  if (symbol !== undefined && symbol.trim() !== "") {
    params.set("symbol", symbol.trim().toUpperCase());
    return;
  }

  params.set("settleCoin", settleCoin);
}

function readOpenPosition(response: unknown): BybitPosition | null {
  for (const item of readBybitList(response)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const symbol = readRecordString(record, "symbol");
    const side = readRecordString(record, "side");
    const size = readRecordString(record, "size");
    const positionIdx = readRecordNumber(record, "positionIdx");
    const avgPrice = readRecordString(record, "avgPrice");
    const openTime = readRecordNumber(record, "openTime");

    if (symbol === "" || size === "" || Number(size) <= 0) {
      continue;
    }

    if (side !== "Buy" && side !== "Sell" && side !== "None") {
      continue;
    }

    return {
      symbol,
      side,
      size,
      positionIdx,
      avgPrice: avgPrice === "" ? undefined : avgPrice,
      openTime,
    };
  }

  return null;
}

// Strictly validates Bybit's documented /v5/position/list envelope for
// queryPositionForInstrument (design.md Decision 4). Deliberately does not
// reuse readBybitList()'s lenient fallback-to-[] behavior, which would let a
// genuinely malformed response silently masquerade as "no position" — the
// exact failure mode this function exists to prevent.
//
// A symbol-scoped, one-way-mode V1 query is expected to return exactly one
// row for the queried instrument (Bybit's flat-position placeholder row when
// there is no exposure, or the single live row when there is). Zero rows is
// not trusted as "no position" — an empty list could equally mean the
// symbol was never queried correctly, a wrong/stale filter was applied, or a
// partial/truncated response — and more than one row is never a valid
// one-way-mode shape either; both fail closed rather than being filtered
// down to "no position" by size alone. Every branch here is total (no
// exceptions): sign/zero classification of `size` never does arithmetic
// that could throw on an out-of-range exponent (see
// classifyExactDecimalText).
export function evaluatePositionQueryResponse(response: unknown, input: PositionQueryInput): PositionQueryResult {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { kind: "failure", reason: "malformed_envelope" };
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return { kind: "failure", reason: "malformed_envelope" };
  }

  const resultRecord = result as Record<string, unknown>;
  const list = resultRecord.list;
  if (!Array.isArray(list)) {
    return { kind: "failure", reason: "malformed_envelope" };
  }

  const responseCategory = resultRecord.category;
  if (typeof responseCategory !== "string" || responseCategory !== input.category) {
    return { kind: "failure", reason: "category_mismatch" };
  }

  if (list.length === 0) {
    return { kind: "failure", reason: "no_row_returned" };
  }
  if (list.length > 1) {
    return { kind: "failure", reason: "multiple_rows_returned" };
  }

  const item = list[0];
  if (typeof item !== "object" || item === null) {
    return { kind: "failure", reason: "malformed_item" };
  }

  const record = item as Record<string, unknown>;

  const itemSymbol = record.symbol;
  if (typeof itemSymbol !== "string" || itemSymbol !== input.symbol) {
    return { kind: "failure", reason: "symbol_mismatch" };
  }

  const positionIdx = record.positionIdx;
  if (typeof positionIdx !== "number" || !Number.isInteger(positionIdx) || positionIdx !== 0) {
    return { kind: "failure", reason: "invalid_position_idx" };
  }

  const size = record.size;
  const sizeClassification = typeof size === "string" ? classifyExactDecimalText(size) : undefined;
  if (
    sizeClassification === undefined ||
    !sizeClassification.valid ||
    (sizeClassification.negative && !sizeClassification.zero)
  ) {
    return { kind: "failure", reason: "invalid_size" };
  }

  // Exactly-zero size, with positionIdx already confirmed 0: a flat row.
  // side/avgPrice/openTime are Bybit's documented empty/default values on
  // such a row and are not read or validated here.
  if (sizeClassification.zero) {
    return { kind: "no_position" };
  }

  const side = record.side;
  if (side !== "Buy" && side !== "Sell") {
    return { kind: "failure", reason: "invalid_side" };
  }

  const avgPrice = record.avgPrice;
  if (typeof avgPrice !== "string" || !isPositiveExactDecimalText(avgPrice)) {
    return { kind: "failure", reason: "invalid_avg_price" };
  }

  const openTime = record.openTime;
  if (typeof openTime !== "number" || !Number.isInteger(openTime) || openTime <= 0) {
    return { kind: "failure", reason: "invalid_open_time" };
  }

  const row: ValidatedOpenPositionRow = {
    symbol: itemSymbol,
    side,
    size: size as string,
    positionIdx: 0,
    avgPrice,
    openTime,
  };

  // Assigned only when present and syntactically valid, never as an
  // explicit `undefined` key — keeps every existing caller's exact-shape
  // comparison of a row without protection fields unaffected.
  if (typeof record.stopLoss === "string" && isExactDecimalText(record.stopLoss)) {
    row.stopLoss = record.stopLoss;
  }
  if (typeof record.takeProfit === "string" && isExactDecimalText(record.takeProfit)) {
    row.takeProfit = record.takeProfit;
  }

  return { kind: "position", row };
}

function readTickerLastPrice(response: unknown): string {
  const ticker = readBybitList(response)[0];
  if (typeof ticker !== "object" || ticker === null) {
    throw new Error("Bybit ticker response did not include a price");
  }

  const lastPrice = readRecordString(ticker as Record<string, unknown>, "lastPrice");
  if (lastPrice === "") {
    throw new Error("Bybit ticker response did not include lastPrice");
  }

  return lastPrice;
}

function readBybitList(response: unknown): unknown[] {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return [];
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return [];
  }

  const list = (result as Record<string, unknown>).list;
  return Array.isArray(list) ? list : [];
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

async function readBybitResponse(response: Response): Promise<unknown> {
  const bodyText = await response.text();
  let body: unknown;

  try {
    body = bodyText === "" ? null : JSON.parse(bodyText);
  } catch {
    throw new Error(`Bybit returned non-JSON response with HTTP ${response.status}: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  if (isBybitError(body)) {
    throw new Error(`Bybit retCode ${body.retCode}: ${body.retMsg}`);
  }

  return body;
}

function isBybitError(body: unknown): body is { retCode: number; retMsg: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "retCode" in body &&
    typeof body.retCode === "number" &&
    body.retCode !== 0 &&
    "retMsg" in body &&
    typeof body.retMsg === "string"
  );
}
