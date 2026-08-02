import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { openPositionClosedResult, openPositionOpenResult } from "../../src/domain/openPositionApi.js";

test("OpenAPI examples conform to runtime response contracts", async () => {
  const document = await readDocument();
  const operation = openPositionOperation(document);
  const examples = operation.responses["200"].content["application/json"].examples;

  assert.deepEqual(
    openPositionOpenResult({
      firstFillAtMs: examples.open.value.first_fill_at_ms,
      averageEntryPrice: examples.open.value.average_entry_price,
    }).body,
    examples.open.value,
  );
  assert.deepEqual(openPositionClosedResult().body, examples.closed.value);
});

test("OpenAPI owns transport shape without constraining Runtime value formats", async () => {
  const document = await readDocument();
  const operation = openPositionOperation(document);
  const schemas = document.components.schemas;

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "422", "500"]);
  assert.equal(operation.parameters.length, 2);

  for (const parameter of operation.parameters) {
    assert.equal(parameter.schema.type, "string");
    assert.equal(parameter.schema.minLength, 1);
    assert.equal("pattern" in parameter.schema, false);
    assert.equal("maxLength" in parameter.schema, false);
  }

  const responseSchema = schemas.OpenPositionResponse;
  assert.equal(responseSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(responseSchema.properties).sort(), [
    "average_entry_price",
    "first_fill_at_ms",
    "position_open",
  ]);

  assert.deepEqual(schemas.OpenPositionBusinessError.properties.error.properties.code.enum, [
    "validation_failed",
    "unknown_trade_cycle_binding",
    "unsupported_exchange_scope",
  ]);
  assert.equal(schemas.InternalError.properties.error.properties.code.const, "internal_error");

  const serialized = JSON.stringify(document);
  for (const forbidden of [
    "pending_create",
    "pending_replace",
    "pending_cancel",
    "terminal_unfilled",
    "early_execution_observation",
    "entry_bar_open_time_ms",
    "positionIdx",
    "queryPositionForInstrument",
    "OpenPositionResolutionServicePort",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `OpenAPI contains forbidden ${forbidden}`);
  }
});

async function readDocument(): Promise<Record<string, any>> {
  const documentUrl = new URL("../../docs/openapi/abi-open-position-lookup-api-v1.json", import.meta.url);
  return JSON.parse(await readFile(documentUrl, "utf8")) as Record<string, any>;
}

function openPositionOperation(document: Record<string, any>): Record<string, any> {
  return document.paths[
    "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position"
  ].get as Record<string, any>;
}
