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

  assert.equal(schemas.OpenPositionResponse.oneOf.length, 2);
  assert.equal(schemas.OpenPositionBusinessError.oneOf.length, 3);
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

test("the success oneOf declaratively enforces the cross-field invariant: only the two valid shapes match", async () => {
  const document = await readDocument();
  const schema = document.components.schemas.OpenPositionResponse;

  assert.equal(
    matchesSchema(document, schema, { position_open: true, first_fill_at_ms: 111, average_entry_price: "100000" }),
    true,
  );
  assert.equal(
    matchesSchema(document, schema, { position_open: false, first_fill_at_ms: null, average_entry_price: null }),
    true,
  );
});

test("the success oneOf rejects every mixed or malformed shape (negative)", async () => {
  const document = await readDocument();
  const schema = document.components.schemas.OpenPositionResponse;

  const invalidShapes = [
    // open flag with closed (null) facts
    { position_open: true, first_fill_at_ms: null, average_entry_price: null },
    // closed flag with open (non-null) facts
    { position_open: false, first_fill_at_ms: 111, average_entry_price: "100000" },
    // open flag with only one fact null
    { position_open: true, first_fill_at_ms: 111, average_entry_price: null },
    { position_open: true, first_fill_at_ms: null, average_entry_price: "100000" },
    // extra field beyond the closed object
    { position_open: true, first_fill_at_ms: 111, average_entry_price: "100000", extra: "x" },
    // missing a required field
    { position_open: false, first_fill_at_ms: null },
    // non-positive first_fill_at_ms on the open branch
    { position_open: true, first_fill_at_ms: 0, average_entry_price: "100000" },
    { position_open: true, first_fill_at_ms: -1, average_entry_price: "100000" },
  ];

  for (const shape of invalidShapes) {
    assert.equal(matchesSchema(document, schema, shape), false, JSON.stringify(shape));
  }
});

test("the 422 error oneOf requires details only for validation_failed (positive)", async () => {
  const document = await readDocument();
  const schema = document.components.schemas.OpenPositionBusinessError;

  assert.equal(
    matchesSchema(document, schema, {
      error: { code: "validation_failed", message: "m", details: [{ path: "/x", message: "m" }] },
    }),
    true,
  );
  assert.equal(matchesSchema(document, schema, { error: { code: "unknown_trade_cycle_binding", message: "m" } }), true);
  assert.equal(matchesSchema(document, schema, { error: { code: "unsupported_exchange_scope", message: "m" } }), true);
});

test("the 422 error oneOf rejects details on non-validation_failed codes and validation_failed without details (negative)", async () => {
  const document = await readDocument();
  const schema = document.components.schemas.OpenPositionBusinessError;

  const invalidShapes = [
    // details present on a code whose schema has no details property at all
    { error: { code: "unknown_trade_cycle_binding", message: "m", details: [] } },
    { error: { code: "unsupported_exchange_scope", message: "m", details: [{ path: "/x", message: "m" }] } },
    // validation_failed missing required details
    { error: { code: "validation_failed", message: "m" } },
    // validation_failed with an empty details array (minItems: 1)
    { error: { code: "validation_failed", message: "m", details: [] } },
    // a code not in any branch's enum
    { error: { code: "internal_error", message: "m" } },
    { error: { code: "not_a_real_code", message: "m" } },
  ];

  for (const shape of invalidShapes) {
    assert.equal(matchesSchema(document, schema, shape), false, JSON.stringify(shape));
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

// A minimal, purpose-built structural matcher covering exactly the JSON
// Schema subset this document uses (oneOf, $ref, const, type, required,
// additionalProperties, minLength, minItems, exclusiveMinimum, items). Not a
// general-purpose validator — just enough to make "negative" schema tests
// genuine (does this value actually fail to satisfy the schema?) rather than
// a hand-picked field-by-field assertion.
function matchesSchema(document: Record<string, any>, schema: Record<string, any>, value: unknown): boolean {
  if (schema.$ref !== undefined) {
    return matchesSchema(document, resolveRef(document, schema.$ref), value);
  }

  if (schema.oneOf !== undefined) {
    const matchCount = schema.oneOf.filter((sub: Record<string, any>) => matchesSchema(document, sub, value)).length;
    return matchCount === 1;
  }

  if (schema.const !== undefined) {
    return value === schema.const;
  }

  if (schema.type === "null") {
    return value === null;
  }

  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return false;
    }
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) {
      return false;
    }
    return true;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      return false;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return false;
    }
    return true;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return false;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return false;
    }
    if (schema.items !== undefined) {
      return value.every((item) => matchesSchema(document, schema.items, item));
    }
    return true;
  }

  if (schema.type === "object" || schema.properties !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!Object.hasOwn(record, key)) {
        return false;
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) {
          return false;
        }
      }
    }

    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(record, key) && !matchesSchema(document, subSchema as Record<string, any>, record[key])) {
        return false;
      }
    }

    return true;
  }

  return true;
}

function resolveRef(document: Record<string, any>, ref: string): Record<string, any> {
  const name = ref.split("/").pop() as string;
  return document.components.schemas[name];
}
