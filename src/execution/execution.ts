import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import type {
  BybitAmendOrderPayload,
  BybitCancelOrderPayload,
  BybitCreateOrderPayload,
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

export type EntryOrderAmendExecutionResult =
  | {
      status: "skipped_live_execution";
      mode: LiveExecutionMode;
    }
  | {
      status: "bybit_entry_order_amend_accepted";
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

export async function amendEntryOrder(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  payload: BybitAmendOrderPayload;
}): Promise<EntryOrderAmendExecutionResult> {
  const mode = getLiveExecutionMode(input.config);

  if (!mode.canExecuteLive) {
    return {
      status: "skipped_live_execution",
      mode,
    };
  }

  const bybitResponse = await input.bybit.amendOrder(input.payload);

  return {
    status: "bybit_entry_order_amend_accepted",
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
