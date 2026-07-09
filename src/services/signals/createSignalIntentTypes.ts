import type { AbiConfig } from "../../config/config.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { Journal } from "../../journal/journal.js";

export type CreateSignalIntentInput = {
  payload: unknown;
};

export type CreateSignalIntentDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
};

export type CreateSignalIntentResult = {
  statusCode: number;
  body: Record<string, unknown>;
};
