import type { CredentialsSource } from "../exchange/bybitAdapter.js";
import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import type { AbiConfig } from "../config/config.js";
import {
  disabledStreamStatus,
  ExchangeStreamRecorder,
  PRIVATE_STREAM_URLS,
  type ExchangeStreamStatus,
} from "./exchangeStreamRecorder.js";

export type ExchangeStreamHandle = {
  start(): void;
  stop(): void;
  status(): ExchangeStreamStatus;
};

// The recorder runs only with an enabled store and a configured key
// (abi-exchange-stream-recorder-v1 D1); otherwise a no-op handle reports why.
export function createExchangeStreamRecorder(
  config: AbiConfig,
  exchangeFacts: ExchangeFactsStoreState,
  credentialsSource: CredentialsSource,
): ExchangeStreamHandle {
  if (exchangeFacts.status !== "enabled") {
    return disabledHandle("store_not_enabled");
  }
  if (credentialsSource.credentials() === undefined) {
    return disabledHandle("no_api_key");
  }
  return new ExchangeStreamRecorder({
    url: PRIVATE_STREAM_URLS[config.bybitEnvironment],
    credentialsSource,
    sink: exchangeFacts.store,
  });
}

function disabledHandle(reason: string): ExchangeStreamHandle {
  const status = disabledStreamStatus(reason);
  return { start: () => undefined, stop: () => undefined, status: () => status };
}
