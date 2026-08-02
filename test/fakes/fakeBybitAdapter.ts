import type {
  BybitAdapter,
  BybitPosition,
  GetActiveOrdersInput,
  GetOpenPositionsInput,
  GetWalletBalanceInput,
  PlaceMarketOrderInput,
  PositionQueryInput,
  PositionQueryResult,
  SetTradingStopInput,
} from "../../src/exchange/bybitAdapter.js";
import { evaluatePositionQueryResponse } from "../../src/exchange/bybitAdapter.js";
import type {
  BybitAmendOrderPayload,
  BybitCancelAllOrdersPayload,
  BybitCancelOrderPayload,
  BybitCreateOrderPayload,
  BybitGetOrderByLinkIdPayload,
  BybitGetOrderHistoryPayload,
  BybitMarketCloseOrderPayload,
} from "../../src/exchange/bybitOrderMapper.js";

export class FakeBybitAdapter implements BybitAdapter {
  readonly createOrderCalls: Array<BybitCreateOrderPayload | BybitMarketCloseOrderPayload> = [];
  readonly amendOrderCalls: BybitAmendOrderPayload[] = [];
  readonly cancelOrderCalls: BybitCancelOrderPayload[] = [];
  readonly cancelAllOrdersCalls: BybitCancelAllOrdersPayload[] = [];
  readonly getOrderByLinkIdCalls: BybitGetOrderByLinkIdPayload[] = [];
  readonly getOrderHistoryCalls: BybitGetOrderHistoryPayload[] = [];
  // Recorded as "category:symbol" so tests can assert the exact category a
  // call used, not just the symbol.
  readonly getInstrumentInfoCalls: string[] = [];
  readonly getPositionCalls: string[] = [];
  readonly getMarketPriceCalls: string[] = [];
  readonly getOpenPositionsCalls: GetOpenPositionsInput[] = [];

  walletBalanceResponse: unknown = { retCode: 0, result: {} };
  activeOrdersResponse: unknown = { retCode: 0, result: { list: [] } };
  openPositionsResponse: unknown = { retCode: 0, result: { list: [] } };
  // When set, getOpenPositions (and therefore queryPositionForInstrument)
  // throws this instead of returning openPositionsResponse, simulating a
  // transport failure or timeout.
  openPositionsError: Error | null = null;
  orderByLinkIdResponse: unknown = { retCode: 0, result: { list: [] } };
  orderHistoryResponse: unknown = { retCode: 0, result: { list: [] } };
  instrumentInfoResponse: unknown = { retCode: 0, result: { list: [] } };
  // Optional per-orderLinkId overrides, checked before the flat default
  // responses above — lets a test express "this specific order looks like
  // X while every other query still uses the shared default."
  orderByLinkIdResponseByLinkId = new Map<string, unknown>();
  orderHistoryResponseByLinkId = new Map<string, unknown>();
  position: BybitPosition | null = null;
  marketPrice = "61000.0";

  async getServerTime(): Promise<unknown> {
    return { retCode: 0, result: { timeSecond: "0" } };
  }

  async getWalletBalance(input: GetWalletBalanceInput = {}): Promise<unknown> {
    void input;
    return this.walletBalanceResponse;
  }

  async getActiveOrders(input: GetActiveOrdersInput = {}): Promise<unknown> {
    void input;
    return this.activeOrdersResponse;
  }

  async getOpenPositions(input: GetOpenPositionsInput = {}): Promise<unknown> {
    this.getOpenPositionsCalls.push(input);
    if (this.openPositionsError !== null) {
      throw this.openPositionsError;
    }
    return this.openPositionsResponse;
  }

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
    this.createOrderCalls.push(payload);
    return { retCode: 0, result: { orderLinkId: "fake-create" } };
  }

  async amendOrder(payload: BybitAmendOrderPayload): Promise<unknown> {
    this.amendOrderCalls.push(payload);
    return { retCode: 0, result: { orderLinkId: payload.orderLinkId } };
  }

  async cancelOrder(payload: BybitCancelOrderPayload): Promise<unknown> {
    this.cancelOrderCalls.push(payload);
    return { retCode: 0, result: { orderLinkId: payload.orderLinkId } };
  }

  async cancelAllOrders(payload: BybitCancelAllOrdersPayload): Promise<unknown> {
    this.cancelAllOrdersCalls.push(payload);
    return { retCode: 0, result: {} };
  }

  async getOrderByLinkId(payload: BybitGetOrderByLinkIdPayload): Promise<unknown> {
    this.getOrderByLinkIdCalls.push(payload);
    return this.orderByLinkIdResponseByLinkId.get(payload.orderLinkId) ?? this.orderByLinkIdResponse;
  }

  async getOrderHistory(payload: BybitGetOrderHistoryPayload): Promise<unknown> {
    this.getOrderHistoryCalls.push(payload);
    return this.orderHistoryResponseByLinkId.get(payload.orderLinkId) ?? this.orderHistoryResponse;
  }

  async getInstrumentInfo(category: string, symbol: string): Promise<unknown> {
    this.getInstrumentInfoCalls.push(`${category}:${symbol}`);
    return this.instrumentInfoResponse;
  }

  async getPosition(symbol: string): Promise<BybitPosition | null> {
    this.getPositionCalls.push(symbol);
    return this.position;
  }

  async getMarketPrice(symbol: string): Promise<string> {
    this.getMarketPriceCalls.push(symbol);
    return this.marketPrice;
  }

  async placeMarketOrder(input: PlaceMarketOrderInput): Promise<unknown> {
    void input;
    return { retCode: 0, result: {} };
  }

  async setTradingStop(input: SetTradingStopInput): Promise<unknown> {
    void input;
    return { retCode: 0, result: {} };
  }
}
