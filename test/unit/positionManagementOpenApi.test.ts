import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  serializeProtectionApplied,
  serializeTradeCycleClosed,
  validateCloseCommand,
  validateProtectionCommand,
} from "../../src/domain/positionManagementApi.js";

test("protection OpenAPI examples conform to runtime request and response contracts", async () => {
  const document = await readDocument();
  const operation = protectionOperation(document);
  const requestExamples = operation.requestBody.content["application/json"].examples;

  for (const name of ["withTake", "stopOnly"]) {
    const result = validateProtectionCommand(
      { strategyInstanceId: "runtime-owned-instance-id", tradeCycleId: "runtime-owned-cycle-id" },
      requestExamples[name].value,
    );
    assert.equal(result.ok, true, name);
  }

  const applied = operation.responses["200"].content["application/json"].examples.applied.value;
  assert.deepEqual(
    serializeProtectionApplied({
      strategyInstanceId: applied.strategy_instance_id,
      tradeCycleId: applied.trade_cycle_id,
      acceptedStopPrice: applied.stop_price,
      acceptedTakePrice: applied.take_price,
      confirmedStopPrice: applied.stop_price,
      confirmedTakePrice: applied.take_price,
      verificationSucceeded: true,
    }).body,
    applied,
  );
});

test("close OpenAPI examples conform to runtime request and response contracts", async () => {
  const document = await readDocument();
  const operation = closeOperation(document);
  const requestExamples = operation.requestBody.content["application/json"].examples;

  const result = validateCloseCommand(
    { strategyInstanceId: "runtime-owned-instance-id", tradeCycleId: "runtime-owned-cycle-id" },
    requestExamples.fullClose.value,
  );
  assert.equal(result.ok, true);

  const closed = operation.responses["200"].content["application/json"].examples.closed.value;
  assert.deepEqual(
    serializeTradeCycleClosed({
      strategyInstanceId: closed.strategy_instance_id,
      tradeCycleId: closed.trade_cycle_id,
      positionZeroVerified: true,
      noAttributedActiveOrdersVerified: true,
      correlationCompleteAndConsistent: true,
    }).body,
    closed,
  );
});

test("protection operation owns transport shape and the documented error codes", async () => {
  const document = await readDocument();
  const operation = protectionOperation(document);
  const schemas = document.components.schemas;

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "415", "422", "500"]);

  for (const parameter of operation.parameters) {
    assert.equal(parameter.schema.minLength, 1);
    assert.equal("pattern" in parameter.schema, false);
  }

  assert.deepEqual(schemas.ProtectionRequest.required, ["stop_price", "take_price"]);
  assert.equal(schemas.ProtectionRequest.additionalProperties, false);
  assert.equal(schemas.ProtectionAppliedResponse.additionalProperties, false);
  assert.equal(schemas.ProtectionAppliedResponse.properties.status.const, "protection_applied");

  const businessErrorRefs = schemas.ProtectionBusinessError.oneOf.map((entry: { $ref: string }) => entry.$ref);
  assert.deepEqual(businessErrorRefs, [
    "#/components/schemas/ValidationFailedError",
    "#/components/schemas/UnknownTradeCycleBindingError",
    "#/components/schemas/UnsupportedExchangeScopeError",
    "#/components/schemas/PositionNotOpenError",
  ]);
});

test("close operation requires exposure_fraction and owns the documented error codes", async () => {
  const document = await readDocument();
  const operation = closeOperation(document);
  const schemas = document.components.schemas;

  assert.deepEqual(operation.requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/CloseRequest",
  });
  assert.deepEqual(schemas.CloseRequest.required, ["exposure_fraction"]);
  assert.equal(schemas.CloseRequest.additionalProperties, false);
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "415", "422", "500"]);
  assert.equal(schemas.TradeCycleClosedResponse.additionalProperties, false);
  assert.equal(schemas.TradeCycleClosedResponse.properties.status.const, "trade_cycle_closed");

  const businessErrorRefs = schemas.CloseBusinessError.oneOf.map((entry: { $ref: string }) => entry.$ref);
  assert.deepEqual(businessErrorRefs, [
    "#/components/schemas/ValidationFailedError",
    "#/components/schemas/UnknownTradeCycleBindingError",
    "#/components/schemas/UnsupportedExchangeScopeError",
    "#/components/schemas/CloseExecutionIncompleteError",
  ]);

  const serializedCloseErrors = JSON.stringify(schemas.CloseBusinessError);
  assert.equal(serializedCloseErrors.includes("PositionNotOpenError"), false);
});

test("the retired DELETE .../open-position path is not documented", async () => {
  const document = await readDocument();
  assert.equal(
    "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position" in document.paths,
    false,
  );
});

test("OpenAPI introduces no internal ABI workflow or exchange detail", async () => {
  const document = await readDocument();
  const serialized = JSON.stringify(document);

  for (const forbidden of ["bybit", "Bybit", "adapter", "positionIdx", "orderLinkId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

async function readDocument(): Promise<Record<string, any>> {
  const documentUrl = new URL(
    "../../docs/openapi/abi-position-management-api-v1.json",
    import.meta.url,
  );
  return JSON.parse(await readFile(documentUrl, "utf8")) as Record<string, any>;
}

function protectionOperation(document: Record<string, any>): Record<string, any> {
  return document.paths[
    "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection"
  ].put as Record<string, any>;
}

function closeOperation(document: Record<string, any>): Record<string, any> {
  return document.paths[
    "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close"
  ].post as Record<string, any>;
}
