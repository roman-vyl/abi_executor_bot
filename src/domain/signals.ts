import type { AbiConfig } from "../config/config.js";

export type SignalIntent = {
  signalId: string;
  instanceId: string;
  strategyId: string;
  symbol: string;
  side: "long" | "short";
  entry: EntryIntent;
  stopLoss: StopLossIntent;
  takeProfit: TakeProfitIntent;
};

export type EntryIntent = {
  type: "stop_market";
  triggerPrice: string;
  triggerDirection: "rises_to" | "falls_to";
};

export type StopLossIntent = {
  type: "stop_market";
  triggerPrice: string;
};

export type TakeProfitIntent = {
  type: "take_profit_market";
  triggerPrice: string;
};

export type SignalParseResult =
  | {
      ok: true;
      intent: SignalIntent;
    }
  | {
      ok: false;
      error: string;
    };

export function parseSignalIntent(payload: unknown, config: AbiConfig): SignalParseResult {
  if (!isRecord(payload)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const signalId = readString(payload.signal_id);
  if (!signalId) {
    return { ok: false, error: "signal_id is required" };
  }

  const instanceId = readString(payload.instance_id);
  if (!instanceId) {
    return { ok: false, error: "instance_id is required" };
  }

  const strategyId = readString(payload.strategy_id);
  if (!strategyId) {
    return { ok: false, error: "strategy_id is required" };
  }

  const symbol = readString(payload.symbol).toUpperCase();
  if (!config.allowedSymbols.includes(symbol)) {
    return { ok: false, error: `symbol ${symbol || "<empty>"} is not allowed` };
  }

  const side = readString(payload.side).toLowerCase();
  if (side !== "long" && side !== "short") {
    return { ok: false, error: "side must be long or short" };
  }

  const entry = parseEntry(payload.entry);
  if (!entry.ok) {
    return { ok: false, error: entry.error };
  }

  const stopLoss = parseStopLoss(payload.stop_loss);
  if (!stopLoss.ok) {
    return { ok: false, error: stopLoss.error };
  }

  const takeProfit = parseTakeProfit(payload.take_profit);
  if (!takeProfit.ok) {
    return { ok: false, error: takeProfit.error };
  }

  return {
    ok: true,
    intent: {
      signalId,
      instanceId,
      strategyId,
      symbol,
      side,
      entry: entry.value,
      stopLoss: stopLoss.value,
      takeProfit: takeProfit.value,
    },
  };
}

function parseEntry(value: unknown):
  | {
      ok: true;
      value: EntryIntent;
    }
  | {
      ok: false;
      error: string;
    } {
  if (!isRecord(value)) {
    return { ok: false, error: "entry is required" };
  }

  const type = readString(value.type).toLowerCase();
  if (type !== "stop_market") {
    return { ok: false, error: "entry.type must be stop_market" };
  }

  const triggerPrice = readPositiveNumberString(value.trigger_price);
  if (!triggerPrice) {
    return { ok: false, error: "entry.trigger_price must be a positive number" };
  }

  const triggerDirection = readString(value.trigger_direction).toLowerCase();
  if (triggerDirection !== "rises_to" && triggerDirection !== "falls_to") {
    return { ok: false, error: "entry.trigger_direction must be rises_to or falls_to" };
  }

  return {
    ok: true,
    value: {
      type: "stop_market",
      triggerPrice,
      triggerDirection,
    },
  };
}

function parseStopLoss(value: unknown):
  | {
      ok: true;
      value: StopLossIntent;
    }
  | {
      ok: false;
      error: string;
    } {
  if (!isRecord(value)) {
    return { ok: false, error: "stop_loss is required" };
  }

  const type = readString(value.type).toLowerCase();
  if (type !== "stop_market") {
    return { ok: false, error: "stop_loss.type must be stop_market" };
  }

  const triggerPrice = readPositiveNumberString(value.trigger_price);
  if (!triggerPrice) {
    return { ok: false, error: "stop_loss.trigger_price must be a positive number" };
  }

  return {
    ok: true,
    value: {
      type: "stop_market",
      triggerPrice,
    },
  };
}

function parseTakeProfit(value: unknown):
  | {
      ok: true;
      value: TakeProfitIntent;
    }
  | {
      ok: false;
      error: string;
    } {
  if (!isRecord(value)) {
    return { ok: false, error: "take_profit is required" };
  }

  const type = readString(value.type).toLowerCase();
  if (type !== "take_profit_market") {
    return { ok: false, error: "take_profit.type must be take_profit_market" };
  }

  const triggerPrice = readPositiveNumberString(value.trigger_price);
  if (!triggerPrice) {
    return { ok: false, error: "take_profit.trigger_price must be a positive number" };
  }

  return {
    ok: true,
    value: {
      type: "take_profit_market",
      triggerPrice,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function readPositiveNumberString(value: unknown): string {
  const asString = readString(value);
  const parsed = Number(asString);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }

  return asString;
}
