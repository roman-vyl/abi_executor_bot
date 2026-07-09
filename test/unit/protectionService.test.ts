import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../../src/journal/journal.js";
import type { ProtectionCheckContext } from "../../src/services/protection/protectionTypes.js";
import { verifyPostCreateProtection } from "../../src/services/protection/verifyPostCreateProtection.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

test("post-create verification reports pending order verified without requiring TP/SL echo", async () => {
  const { journal, cleanup } = await makeJournal();
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { list: [{ orderLinkId: "abi-entry-001" }] } };

  try {
    const result = await verifyPostCreateProtection({
      config: makeTestConfig({ dryRun: false, liveTradingEnabled: true, bybitApiKey: "k", bybitApiSecret: "s" }),
      bybit,
      journal,
      context: makeContext(),
      getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "abi-entry-001", limit: "1" },
      preCreatePosition: { queryOk: true, found: false },
    });

    assert.equal(result.status, "pending_order_verified");
    assert.equal(result.orderFound, true);
    assert.equal(bybit.getMarketPriceCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("post-create verification covers open-position states and price failure", async () => {
  assert.equal(
    await verifyStatus({ protection: { mode: "none" }, positionSide: "Buy", price: "61000.0" }),
    "position_open_no_stop_requested",
  );
  assert.equal(await verifyStatus({ positionSide: "Buy", price: "60899.0" }), "emergency_close_sent");
  assert.equal(await verifyStatus({ side: "short", positionSide: "Sell", price: "60901.0" }), "emergency_close_sent");
  assert.equal(await verifyStatus({ positionSide: "Buy", price: "61000.0" }), "position_open_stop_not_breached");
  assert.equal(await verifyStatus({ positionSide: "Buy", priceFailure: true }), "exchange_query_failed");
});

test("emergency close reports failure when the live guard blocks writes", async () => {
  const { journal, cleanup } = await makeJournal();
  const bybit = new FakeBybitAdapter();
  bybit.position = { symbol: "BTCUSDT", side: "Buy", size: "0.001" };
  bybit.marketPrice = "60899.0";

  try {
    const result = await verifyPostCreateProtection({
      config: makeTestConfig({ dryRun: false, liveTradingEnabled: false, bybitApiKey: "k", bybitApiSecret: "s" }),
      bybit,
      journal,
      context: makeContext(),
      getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "abi-entry-001", limit: "1" },
      preCreatePosition: { queryOk: true, found: false },
    });

    assert.equal(result.status, "emergency_close_failed");
    assert.equal(result.error?.source, "live_guard");
    assert.equal(bybit.createOrderCalls.length, 0);
  } finally {
    await cleanup();
  }
});

async function verifyStatus(options: {
  side?: "long" | "short";
  protection?: ProtectionCheckContext["protection"];
  positionSide: "Buy" | "Sell";
  price?: string;
  priceFailure?: boolean;
}): Promise<string> {
  const { journal, cleanup } = await makeJournal();
  const bybit =
    options.priceFailure === true
      ? new PriceFailingBybitAdapter()
      : new FakeBybitAdapter();
  bybit.position = { symbol: "BTCUSDT", side: options.positionSide, size: "0.001", positionIdx: 1 };
  bybit.marketPrice = options.price ?? "61000.0";

  try {
    const result = await verifyPostCreateProtection({
      config: makeTestConfig({ dryRun: false, liveTradingEnabled: true, bybitApiKey: "k", bybitApiSecret: "s" }),
      bybit,
      journal,
      context: makeContext({ side: options.side, protection: options.protection }),
      getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "abi-entry-001", limit: "1" },
      preCreatePosition: { queryOk: true, found: false },
    });
    return result.status;
  } finally {
    await cleanup();
  }
}

function makeContext(options: {
  side?: "long" | "short";
  protection?: ProtectionCheckContext["protection"];
} = {}): ProtectionCheckContext {
  return {
    signalId: "sig-001",
    instanceId: "inst-001",
    symbol: "BTCUSDT",
    side: options.side ?? "long",
    orderLinkId: "abi-entry-001",
    protection:
      options.protection ?? {
        mode: "attached_full_position_market",
        stopLoss: { triggerPrice: "60900.0", triggerBy: "LastPrice", orderType: "Market" },
      },
    dryRun: false,
  };
}

async function makeJournal(): Promise<{ journal: Journal; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "abi-protection-service-"));
  return {
    journal: new Journal(join(directory, "journal.jsonl")),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class PriceFailingBybitAdapter extends FakeBybitAdapter {
  override async getMarketPrice(symbol: string): Promise<string> {
    this.getMarketPriceCalls.push(symbol);
    throw new Error("ticker down");
  }
}
