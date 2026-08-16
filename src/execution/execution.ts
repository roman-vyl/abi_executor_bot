import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter, SetTradingStopInput } from "../exchange/bybitAdapter.js";
import type {
  BybitCancelOrderPayload,
  BybitCreateOrderPayload,
  BybitMarketCloseOrderPayload,
} from "../exchange/bybitOrderMapper.js";
import { getLiveExecutionMode, type LiveExecutionMode } from "./liveGuard.js";

export type EntryOrderExecutionResult =
  | {
      status: "skipped_live_execution";
      mode: LiveExecutionMode;
    }
  | {
      status: "bybit_entry_order_create_accepted";
      mode: LiveExecutionMode;
      bybitResponse: unknown;
    };

export type EntryOrderCancelExecutionResult =
  | {
      status: "skipped_live_execution";
      mode: LiveExecutionMode;
    }
  | {
      status: "bybit_entry_order_cancel_accepted";
      mode: LiveExecutionMode;
      bybitResponse: unknown;
    };

export type MarketCloseOrderExecutionResult =
  | {
      status: "skipped_live_execution";
      mode: LiveExecutionMode;
    }
  | {
      status: "bybit_market_close_order_accepted";
      mode: LiveExecutionMode;
      bybitResponse: unknown;
    };

export async function executeEntryOrder(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  payload: BybitCreateOrderPayload;
}): Promise<EntryOrderExecutionResult> {
  const mode = getLiveExecutionMode(input.config);

  if (!mode.canExecuteLive) {
    return {
      status: "skipped_live_execution",
      mode,
    };
  }

  const bybitResponse = await input.bybit.createOrder(input.payload);

  return {
    status: "bybit_entry_order_create_accepted",
    mode,
    bybitResponse,
  };
}

export async function cancelEntryOrder(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  payload: BybitCancelOrderPayload;
}): Promise<EntryOrderCancelExecutionResult> {
  const mode = getLiveExecutionMode(input.config);

  if (!mode.canExecuteLive) {
    return {
      status: "skipped_live_execution",
      mode,
    };
  }

  const bybitResponse = await input.bybit.cancelOrder(input.payload);

  return {
    status: "bybit_entry_order_cancel_accepted",
    mode,
    bybitResponse,
  };
}

export type ProtectionUpdateExecutionResult =
  | {
      status: "skipped_live_execution";
      mode: LiveExecutionMode;
    }
  | {
      status: "bybit_protection_update_accepted";
      mode: LiveExecutionMode;
      bybitResponse: unknown;
    };

export async function executeProtectionUpdate(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  payload: SetTradingStopInput;
}): Promise<ProtectionUpdateExecutionResult> {
  const mode = getLiveExecutionMode(input.config);

  if (!mode.canExecuteLive) {
    return {
      status: "skipped_live_execution",
      mode,
    };
  }

  const bybitResponse = await input.bybit.setTradingStop(input.payload);

  return {
    status: "bybit_protection_update_accepted",
    mode,
    bybitResponse,
  };
}

export async function executeMarketCloseOrder(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  payload: BybitMarketCloseOrderPayload;
}): Promise<MarketCloseOrderExecutionResult> {
  const mode = getLiveExecutionMode(input.config);

  if (!mode.canExecuteLive) {
    return {
      status: "skipped_live_execution",
      mode,
    };
  }

  const bybitResponse = await input.bybit.createOrder(input.payload);

  return {
    status: "bybit_market_close_order_accepted",
    mode,
    bybitResponse,
  };
}
