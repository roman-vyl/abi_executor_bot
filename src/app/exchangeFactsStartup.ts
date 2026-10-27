import type { AbiConfig } from "../config/config.js";
import { ExchangeFactsOpenError, ExchangeFactsStore } from "../exchangeFacts/exchangeFactsStore.js";
import type { ExchangeFactsOpenFailureReason } from "../exchangeFacts/exchangeFactsStore.js";
import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export type ExchangeFactsStoreState =
  | { status: "disabled" }
  | { status: "enabled"; store: ExchangeFactsStore }
  | { status: "unavailable"; reason: ExchangeFactsOpenFailureReason };

// Opens the exchange facts store when it is enabled; otherwise opens nothing
// (abi-exchange-facts-trading-isolation-v1 D1). A store that cannot open is
// reported and left unavailable: the journal never stops trading.
export function openExchangeFactsStore(
  config: AbiConfig,
  deps: { emit?: EmitLike; open?: typeof ExchangeFactsStore.open } = {},
): ExchangeFactsStoreState {
  if (!config.exchangeFactsEnabled) {
    return { status: "disabled" };
  }

  const emit = deps.emit ?? emitEvent;
  const open = deps.open ?? ((input) => ExchangeFactsStore.open(input));

  try {
    const store = open({
      path: config.exchangeFactsDbPath,
      bybitEnvironment: config.bybitEnvironment,
      category: config.bybitCategory,
    });
    return { status: "enabled", store };
  } catch (error) {
    const reason = error instanceof ExchangeFactsOpenError ? error.reason : "open_failed";
    emit("error", "exchange_facts_store_failed", { reason });
    return { status: "unavailable", reason };
  }
}
