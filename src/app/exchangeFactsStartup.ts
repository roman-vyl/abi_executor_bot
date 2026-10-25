import type { AbiConfig } from "../config/config.js";
import { ExchangeFactsOpenError, ExchangeFactsStore } from "../exchangeFacts/exchangeFactsStore.js";
import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

// Opens the exchange facts store when it is enabled; otherwise opens nothing
// (abi-exchange-facts-sqlite-foundation-v1 D8). An enabled store that cannot
// open stops startup: ABI never runs silently without its journal.
export function openExchangeFactsStoreOrExit(
  config: AbiConfig,
  deps: { emit?: EmitLike; exit?: (code: number) => never; open?: typeof ExchangeFactsStore.open } = {},
): ExchangeFactsStore | undefined {
  if (!config.exchangeFactsEnabled) {
    return undefined;
  }

  const emit = deps.emit ?? emitEvent;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const open = deps.open ?? ExchangeFactsStore.open;

  try {
    return open({
      path: config.exchangeFactsDbPath,
      bybitEnvironment: config.bybitEnvironment,
      category: config.bybitCategory,
    });
  } catch (error) {
    const reason = error instanceof ExchangeFactsOpenError ? error.reason : "open_failed";
    emit("error", "exchange_facts_store_failed", { reason });
    return exit(1);
  }
}
