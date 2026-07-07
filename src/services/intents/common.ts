import type { AbiConfig } from "../../config/config.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { Journal } from "../../journal/journal.js";

export type ServiceResponse = {
  statusCode: number;
  body: object;
};

export type IntentServiceInput = {
  signalId: string;
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
};

export function badSignalId(): ServiceResponse {
  return {
    statusCode: 400,
    body: {
      error: "signal_id is required",
    },
  };
}
