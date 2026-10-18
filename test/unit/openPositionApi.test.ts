import assert from "node:assert/strict";
import test from "node:test";

import type { EntryPackageValidationDetail } from "../../src/domain/entryPackageApi.js";
import {
  decodeOpaquePathValue,
  internalErrorResult,
  openPositionClosedResult,
  openPositionOpenResult,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
  validationFailedResult,
} from "../../src/domain/openPositionApi.js";

test("open result enforces the cross-field invariant at construction time", () => {
  const result = openPositionOpenResult({
    firstFillAtMs: 1785000012345,
    averageEntryPrice: "100000",
    entryOrderLinkId: "abi-ep-link",
    entryOrderId: "bybit-order-1",
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    position_open: true,
    first_fill_at_ms: 1785000012345,
    average_entry_price: "100000",
    closure: null,
    entry_order_link_id: "abi-ep-link",
    entry_order_id: "bybit-order-1",
  });
  assert.deepEqual(Object.keys(result.body).sort(), [
    "average_entry_price",
    "closure",
    "entry_order_id",
    "entry_order_link_id",
    "first_fill_at_ms",
    "position_open",
  ]);
});

test("open result reports a missing exchange order id as null, never a substitute", () => {
  const result = openPositionOpenResult({
    firstFillAtMs: 1785000012345,
    averageEntryPrice: "100000",
    entryOrderLinkId: "abi-ep-link",
    entryOrderId: null,
  });

  assert.equal(result.statusCode, 200);
  assert.equal((result.body as { entry_order_link_id: unknown }).entry_order_link_id, "abi-ep-link");
  assert.equal((result.body as { entry_order_id: unknown }).entry_order_id, null);
});

test("open result fails closed rather than serializing an invalid open shape", () => {
  const ids = { entryOrderLinkId: "abi-ep-link", entryOrderId: "bybit-order-1" };
  for (const input of [
    { firstFillAtMs: 0, averageEntryPrice: "100000", ...ids },
    { firstFillAtMs: -1, averageEntryPrice: "100000", ...ids },
    { firstFillAtMs: 1.5, averageEntryPrice: "100000", ...ids },
    { firstFillAtMs: 1785000012345, averageEntryPrice: "0", ...ids },
    { firstFillAtMs: 1785000012345, averageEntryPrice: "-1", ...ids },
    { firstFillAtMs: 1785000012345, averageEntryPrice: "not-a-number", ...ids },
    { firstFillAtMs: 1785000012345, averageEntryPrice: "100000", entryOrderLinkId: "", entryOrderId: null },
    { firstFillAtMs: 1785000012345, averageEntryPrice: "100000", entryOrderLinkId: "abi-ep-link", entryOrderId: "" },
  ]) {
    assert.deepEqual(openPositionOpenResult(input), internalErrorResult(), JSON.stringify(input));
  }
});

test("closed result nulls both facts", () => {
  assert.deepEqual(openPositionClosedResult(), {
    statusCode: 200,
    body: {
      position_open: false,
      first_fill_at_ms: null,
      average_entry_price: null,
      closure: null,
      entry_order_link_id: null,
      entry_order_id: null,
    },
  });
});

test("business and internal error results use the closed envelope", () => {
  assert.deepEqual(unknownTradeCycleBindingResult(), {
    statusCode: 422,
    body: {
      error: {
        code: "unknown_trade_cycle_binding",
        message: "no correlation record exists for the requested pair",
      },
    },
  });

  assert.deepEqual(unsupportedExchangeScopeResult(), {
    statusCode: 422,
    body: {
      error: {
        code: "unsupported_exchange_scope",
        message: "record's exchange category is not supported",
      },
    },
  });

  assert.deepEqual(internalErrorResult(), {
    statusCode: 500,
    body: {
      error: {
        code: "internal_error",
        message: "internal error",
      },
    },
  });

  assert.deepEqual(validationFailedResult([{ path: "/path/trade_cycle_id", message: "required" }]), {
    statusCode: 422,
    body: {
      error: {
        code: "validation_failed",
        message: "request validation failed",
        details: [{ path: "/path/trade_cycle_id", message: "required" }],
      },
    },
  });
});

test("validation result without details fails closed instead of an empty-details 422", () => {
  assert.deepEqual(validationFailedResult([]), internalErrorResult());
});

test("decodeOpaquePathValue accepts a non-empty decoded value", () => {
  const details: EntryPackageValidationDetail[] = [];
  const value = decodeOpaquePathValue("instance%2Ffuture", "/path/strategy_instance_id", details);

  assert.equal(value, "instance/future");
  assert.equal(details.length, 0);
});

test("decodeOpaquePathValue rejects empty-after-decoding values", () => {
  const details: EntryPackageValidationDetail[] = [];
  const value = decodeOpaquePathValue("", "/path/trade_cycle_id", details);

  assert.equal(value, undefined);
  assert.deepEqual(details, [
    { path: "/path/trade_cycle_id", message: "path value must be a non-empty string" },
  ]);
});

test("decodeOpaquePathValue rejects malformed percent-encoding", () => {
  const details: EntryPackageValidationDetail[] = [];
  const value = decodeOpaquePathValue("%ZZ", "/path/strategy_instance_id", details);

  assert.equal(value, undefined);
  assert.deepEqual(details, [
    { path: "/path/strategy_instance_id", message: "path value must use valid percent encoding" },
  ]);
});
