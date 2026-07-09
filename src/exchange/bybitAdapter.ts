import { createHmac } from "node:crypto";

import type { AbiConfig } from "../config/config.js";
import type {
  BybitAmendOrderPayload,
  BybitCancelOrderPayload,
  BybitCancelAllOrdersPayload,
  BybitCreateOrderPayload,
  BybitGetOrderByLinkIdPayload,
  BybitMarketCloseOrderPayload,
} from "./bybitOrderMapper.js";

export type BybitOrderSide = "Buy" | "Sell";

export type BybitPosition = {
  symbol: string;
  side: BybitOrderSide | "None";
  size: string;
  positionIdx?: number;
};

export type PlaceMarketOrderInput = {
  symbol: string;
  side: BybitOrderSide;
  qty: string;
  orderLinkId: string;
};

export type SetTradingStopInput = {
  symbol: string;
  stopLoss?: string;
  takeProfit?: string;
};

export interface BybitAdapter {
  getServerTime(): Promise<unknown>;
  getWalletBalance(input?: GetWalletBalanceInput): Promise<unknown>;
  getActiveOrders(input?: GetActiveOrdersInput): Promise<unknown>;
  getOpenPositions(input?: GetOpenPositionsInput): Promise<unknown>;
  createOrder(payload: BybitCreateOrderPayload | BybitMarketCloseOrderPayload): Promise<unknown>;
  amendOrder(payload: BybitAmendOrderPayload): Promise<unknown>;
  cancelOrder(payload: BybitCancelOrderPayload): Promise<unknown>;
  cancelAllOrders(payload: BybitCancelAllOrdersPayload): Promise<unknown>;
  getOrderByLinkId(payload: BybitGetOrderByLinkIdPayload): Promise<unknown>;
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
    const response = await fetch(`${this.baseUrl}/v5/market/time`);
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
      category: this.config.bybitCategory,
    });

    setSymbolOrSettleCoin(params, input.symbol, input.settleCoin ?? this.config.bybitSettleCoin);

    return this.signedGet("/v5/position/list", params);
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

  async setTradingStop(input: SetTradingStopInput): Promise<unknown> {
    return stub("setTradingStop", input);
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
    });

    return readBybitResponse(response);
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
    };
  }

  return null;
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
