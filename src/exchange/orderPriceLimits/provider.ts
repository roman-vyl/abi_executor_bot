import type { BybitAdapter } from "../bybitAdapter.js";
import { decodeOrderPriceLimitsResponse } from "./decoder.js";
import type {
  CurrentOrderPriceLimitsInput,
  CurrentOrderPriceLimitsProvider,
  CurrentOrderPriceLimitsResult,
} from "./types.js";

export class BybitCurrentOrderPriceLimitsProvider implements CurrentOrderPriceLimitsProvider {
  constructor(private readonly bybit: BybitAdapter) {}

  async getCurrent(input: CurrentOrderPriceLimitsInput): Promise<CurrentOrderPriceLimitsResult> {
    if (input.category !== "linear") {
      return {
        kind: "failure",
        failure: { kind: "unsupported_category", category: input.category },
      };
    }

    let response: unknown;
    try {
      response = await this.bybit.getOrderPriceLimit(input.category, input.symbol);
    } catch {
      return { kind: "failure", failure: { kind: "transport_failure" } };
    }

    const decoded = decodeOrderPriceLimitsResponse({ response, expectedSymbol: input.symbol });
    if (!decoded.ok) {
      return {
        kind: "failure",
        failure: { kind: "protocol_failure", reason: decoded.reason },
      };
    }

    return { kind: "success", limits: decoded.limits };
  }
}

