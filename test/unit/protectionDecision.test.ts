import assert from "node:assert/strict";
import test from "node:test";

import type { ProtectionCheckContext, ProtectionDecisionInput } from "../../src/services/protection/protectionTypes.js";
import { decideProtectionCheck } from "../../src/services/protection/protectionDecision.js";
import { emptyProtectionCheckAttempts } from "../../src/services/protection/protectionTypes.js";

test("protection decision covers pre-create and pending-order states", () => {
  assert.equal(decide(makeInput({ preFound: true, preSize: "0.001" })).status, "pre_existing_position_found");
  assert.equal(decide(makeInput({ preQueryOk: false })).status, "exchange_query_failed");
  assert.equal(decide(makeInput({ orderFound: true })).status, "pending_order_verified");
  assert.equal(decide(makeInput({ orderFound: false })).status, "pending_order_not_found");
});

test("protection decision covers open-position stop branches", () => {
  assert.equal(
    decide(makeInput({ protection: { mode: "none" }, postFound: true, postSize: "0.001" })).status,
    "position_open_no_stop_requested",
  );
  assert.deepEqual(
    pick(decide(makeInput({ postFound: true, postSize: "0.001", observedPrice: "60899.0" }))),
    {
      status: "position_open_stop_breached",
      action: "close_position_market_reduce_only",
    },
  );
  assert.deepEqual(
    pick(
      decide(
        makeInput({
          side: "short",
          postFound: true,
          postSide: "Sell",
          postSize: "0.001",
          observedPrice: "60901.0",
        }),
      ),
    ),
    {
      status: "position_open_stop_breached",
      action: "close_position_market_reduce_only",
    },
  );
  assert.equal(
    decide(makeInput({ postFound: true, postSize: "0.001", observedPrice: "61000.0" })).status,
    "position_open_stop_not_breached",
  );
});

test("protection decision never closes blindly on query or price failures", () => {
  assert.deepEqual(
    pick(decide(makeInput({ postFound: true, postSize: "0.001", priceError: "ticker down" }))),
    {
      status: "exchange_query_failed",
      action: "none",
    },
  );
  assert.deepEqual(
    pick(decide(makeInput({ postFound: true, postSize: "0.001" }))),
    {
      status: "unsafe_manual_required",
      action: "none",
    },
  );
});

test("protection decision records emergency close outcomes as final status", () => {
  assert.deepEqual(
    pick(
      decide(
        makeInput({
          postFound: true,
          postSize: "0.001",
          observedPrice: "60899.0",
          closeAccepted: true,
        }),
      ),
    ),
    {
      status: "emergency_close_sent",
      action: "close_position_market_reduce_only",
    },
  );
  assert.deepEqual(
    pick(
      decide(
        makeInput({
          postFound: true,
          postSize: "0.001",
          observedPrice: "60899.0",
          closeAccepted: false,
        }),
      ),
    ),
    {
      status: "emergency_close_failed",
      action: "close_position_market_reduce_only",
    },
  );
});

function decide(input: ProtectionDecisionInput): ReturnType<typeof decideProtectionCheck> {
  return decideProtectionCheck(input);
}

function pick(result: ReturnType<typeof decideProtectionCheck>): { status: string; action: string } {
  return {
    status: result.status,
    action: result.action,
  };
}

function makeInput(options: {
  side?: "long" | "short";
  protection?: ProtectionCheckContext["protection"];
  preQueryOk?: boolean;
  preFound?: boolean;
  preSize?: string;
  orderFound?: boolean;
  postFound?: boolean;
  postSide?: "Buy" | "Sell";
  postSize?: string;
  observedPrice?: string;
  priceError?: string;
  closeAccepted?: boolean;
}): ProtectionDecisionInput {
  const context: ProtectionCheckContext = {
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

  return {
    context,
    preCreatePosition: {
      queryOk: options.preQueryOk ?? true,
      found: options.preFound ?? false,
      size: options.preSize,
      side: options.preFound === true ? "Buy" : undefined,
      error: options.preQueryOk === false ? { message: "position down" } : undefined,
    },
    orderFound: options.orderFound,
    postCreatePosition:
      options.postFound === undefined
        ? undefined
        : {
            queryOk: true,
            found: options.postFound,
            size: options.postSize,
            side: options.postSide ?? "Buy",
          },
    observedPrice: options.observedPrice,
    priceError: options.priceError === undefined ? undefined : { message: options.priceError },
    attempts: emptyProtectionCheckAttempts(),
    emergencyClose:
      options.closeAccepted === undefined
        ? undefined
        : {
            attempted: true,
            accepted: options.closeAccepted,
          },
  };
}
