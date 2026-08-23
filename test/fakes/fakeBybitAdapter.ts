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
  BybitCancelAllOrdersPayload,
  BybitCancelOrderPayload,
  BybitCreateOrderPayload,
  BybitGetExecutionListPayload,
  BybitGetOrderByLinkIdPayload,
  BybitGetOrderHistoryPayload,
  BybitGetOrderHistoryForSymbolPayload,
  BybitMarketCloseOrderPayload,
} from "../../src/exchange/bybitOrderMapper.js";

export class FakeBybitAdapter implements BybitAdapter {
  readonly createOrderCalls: Array<BybitCreateOrderPayload | BybitMarketCloseOrderPayload> = [];
  readonly cancelOrderCalls: BybitCancelOrderPayload[] = [];
  readonly cancelAllOrdersCalls: BybitCancelAllOrdersPayload[] = [];
  readonly getOrderByLinkIdCalls: BybitGetOrderByLinkIdPayload[] = [];
  readonly getOrderHistoryCalls: BybitGetOrderHistoryPayload[] = [];
  readonly getOrderHistoryForSymbolCalls: BybitGetOrderHistoryForSymbolPayload[] = [];
  readonly getExecutionListCalls: BybitGetExecutionListPayload[] = [];
  // Recorded as "category:symbol" so tests can assert the exact category a
  // call used, not just the symbol.
  readonly getInstrumentInfoCalls: string[] = [];
  readonly getPositionCalls: string[] = [];
  readonly getMarketPriceCalls: string[] = [];
  readonly getOpenPositionsCalls: GetOpenPositionsInput[] = [];
  readonly setTradingStopCalls: SetTradingStopInput[] = [];

  walletBalanceResponse: unknown = { retCode: 0, result: {} };
  activeOrdersResponse: unknown = { retCode: 0, result: { list: [] } };
  openPositionsResponse: unknown = { retCode: 0, result: { list: [] } };
  // When set, getOpenPositions (and therefore queryPositionForInstrument)
  // throws this instead of returning openPositionsResponse, simulating a
  // transport failure or timeout.
  openPositionsError: Error | null = null;
  orderByLinkIdResponse: unknown = { retCode: 0, result: { list: [] } };
  orderHistoryResponse: unknown = { retCode: 0, result: { list: [] } };
  orderHistoryForSymbolResponse: unknown = { retCode: 0, result: { list: [] } };
  instrumentInfoResponse: unknown = { retCode: 0, result: { list: [] } };
  // Optional per-orderLinkId overrides, checked before the flat default
  // responses above — lets a test express "this specific order looks like
  // X while every other query still uses the shared default."
  orderByLinkIdResponseByLinkId = new Map<string, unknown>();
  orderHistoryResponseByLinkId = new Map<string, unknown>();
  position: BybitPosition | null = null;
  marketPrice = "61000.0";
  setTradingStopResponse: unknown = { retCode: 0, result: {} };
  setTradingStopError: Error | null = null;
  // Queue of responses returned in call order (shifted on each call); when
  // exhausted, falls back to executionListResponse — lets a test express an
  // exact multi-page sequence (pagination) or a single steady-state answer.
  executionListResponses: unknown[] = [];
  executionListResponse: unknown = { retCode: 0, result: { category: "linear", list: [], nextPageCursor: "" } };
  executionListError: Error | null = null;

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
    const response = this.orderByLinkIdResponseByLinkId.get(payload.orderLinkId) ?? this.orderByLinkIdResponse;
    return withDefaultOrderIdentity(response, payload);
  }

  async getOrderHistory(payload: BybitGetOrderHistoryPayload): Promise<unknown> {
    this.getOrderHistoryCalls.push(payload);
    const response = this.orderHistoryResponseByLinkId.get(payload.orderLinkId) ?? this.orderHistoryResponse;
    return withDefaultOrderIdentity(response, payload);
  }

  async getOrderHistoryForSymbol(payload: BybitGetOrderHistoryForSymbolPayload): Promise<unknown> {
    this.getOrderHistoryForSymbolCalls.push(payload);
    return withDefaultCategoryAndSymbol(this.orderHistoryForSymbolResponse, payload);
  }

  async getExecutionList(payload: BybitGetExecutionListPayload): Promise<unknown> {
    this.getExecutionListCalls.push(payload);
    if (this.executionListError !== null) {
      throw this.executionListError;
    }
    if (this.executionListResponses.length > 0) {
      return this.executionListResponses.shift();
    }
    return this.executionListResponse;
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
    this.setTradingStopCalls.push(input);
    if (this.setTradingStopError !== null) {
      throw this.setTradingStopError;
    }
    return this.setTradingStopResponse;
  }
}

// Same category/symbol defaulting as withDefaultOrderIdentity below, for a
// symbol-scoped query that has no single orderLinkId to default rows to —
// a test fixture is expected to set each row's own orderLinkId/orderId/
// parentOrderLinkId explicitly (abi-native-partial-protection-attribution-v1).
function withDefaultCategoryAndSymbol(
  response: unknown,
  payload: { category: string; symbol: string },
): unknown {
  if (typeof response !== "object" || response === null) {
    return response;
  }
  const responseRecord = response as Record<string, unknown>;
  const result = responseRecord.result;
  if (typeof result !== "object" || result === null) {
    return response;
  }

  const resultRecord = result as Record<string, unknown>;
  const nextResult: Record<string, unknown> = { ...resultRecord };
  if (!("category" in resultRecord)) {
    nextResult.category = payload.category;
  }

  const list = resultRecord.list;
  if (Array.isArray(list)) {
    nextResult.list = list.map((row) => {
      if (typeof row !== "object" || row === null) {
        return row;
      }
      const rowRecord = row as Record<string, unknown>;
      if ("symbol" in rowRecord) {
        return rowRecord;
      }
      return { ...rowRecord, symbol: payload.symbol };
    });
  }

  return { ...responseRecord, result: nextResult };
}

// Fills in `result.category` and each row's `symbol`/`orderLinkId` from the
// request payload wherever the test's response object left them unset,
// so existing tests that only assert on orderStatus/qty/etc. keep decoding
// as a clean found/not_found result under the strict decoder. A test that
// wants to exercise a category/symbol/orderLinkId mismatch sets that field
// explicitly on its response, which this never overrides.
function withDefaultOrderIdentity(
  response: unknown,
  payload: { category: string; symbol: string; orderLinkId: string },
): unknown {
  if (typeof response !== "object" || response === null) {
    return response;
  }
  const responseRecord = response as Record<string, unknown>;
  const result = responseRecord.result;
  if (typeof result !== "object" || result === null) {
    return response;
  }

  const resultRecord = result as Record<string, unknown>;
  const nextResult: Record<string, unknown> = { ...resultRecord };
  if (!("category" in resultRecord)) {
    nextResult.category = payload.category;
  }

  const list = resultRecord.list;
  if (Array.isArray(list)) {
    nextResult.list = list.map((row) => {
      if (typeof row !== "object" || row === null) {
        return row;
      }
      const rowRecord = row as Record<string, unknown>;
      const nextRow: Record<string, unknown> = { ...rowRecord };
      if (!("symbol" in rowRecord)) {
        nextRow.symbol = payload.symbol;
      }
      if (!("orderLinkId" in rowRecord)) {
        nextRow.orderLinkId = payload.orderLinkId;
      }
      return nextRow;
    });
  }

  return { ...responseRecord, result: nextResult };
}
