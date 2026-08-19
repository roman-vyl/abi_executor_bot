export type CurrentOrderPriceLimitsInput = {
  category: string;
  symbol: string;
};

export type CurrentOrderPriceLimits = {
  buyLimit: string;
  sellLimit: string;
  observedAtMs: number;
};

export type OrderPriceLimitsProtocolFailureReason =
  | "malformed_envelope"
  | "symbol_mismatch"
  | "invalid_buy_limit"
  | "invalid_sell_limit"
  | "invalid_timestamp";

export type OrderPriceLimitsFailure =
  | { kind: "unsupported_category"; category: string }
  | { kind: "transport_failure" }
  | { kind: "protocol_failure"; reason: OrderPriceLimitsProtocolFailureReason };

export type CurrentOrderPriceLimitsResult =
  | { kind: "success"; limits: CurrentOrderPriceLimits }
  | { kind: "failure"; failure: OrderPriceLimitsFailure };

export interface CurrentOrderPriceLimitsProvider {
  getCurrent(input: CurrentOrderPriceLimitsInput): Promise<CurrentOrderPriceLimitsResult>;
}

