import type {
  BybitAdapter,
  BybitPosition,
  GetActiveOrdersInput,
  GetOpenPositionsInput,
  GetWalletBalanceInput,
  PlaceMarketOrderInput,
  SetTradingStopInput,
} from "../../src/exchange/bybitAdapter.js";
import type {
  BybitAmendOrderPayload,
  BybitCancelAllOrdersPayload,
  BybitCancelOrderPayload,
  BybitCreateOrderPayload,
  BybitGetOrderByLinkIdPayload,
  BybitMarketCloseOrderPayload,
} from "../../src/exchange/bybitOrderMapper.js";

export class FakeBybitAdapter implements BybitAdapter {
  readonly createOrderCalls: Array<BybitCreateOrderPayload | BybitMarketCloseOrderPayload> = [];
  readonly amendOrderCalls: BybitAmendOrderPayload[] = [];
  readonly cancelOrderCalls: BybitCancelOrderPayload[] = [];
  readonly cancelAllOrdersCalls: BybitCancelAllOrdersPayload[] = [];
  readonly getOrderByLinkIdCalls: BybitGetOrderByLinkIdPayload[] = [];

  walletBalanceResponse: unknown = { retCode: 0, result: {} };
  activeOrdersResponse: unknown = { retCode: 0, result: { list: [] } };
  openPositionsResponse: unknown = { retCode: 0, result: { list: [] } };
  orderByLinkIdResponse: unknown = { retCode: 0, result: { list: [] } };

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
    void input;
    return this.openPositionsResponse;
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
    return this.orderByLinkIdResponse;
  }

  async getPosition(symbol: string): Promise<BybitPosition | null> {
    void symbol;
    return null;
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
