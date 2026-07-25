import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  serializeAbsentEntryPackage,
  serializeAppliedEntryPackage,
  validateEntryPackageCommand,
} from "../../src/domain/entryPackageApi.js";

test("OpenAPI examples conform to runtime request and response contracts", async () => {
  const document = await readDocument();
  const operation = entryPackageOperation(document);
  const requestExamples = operation.requestBody.content["application/json"].examples;

  for (const name of ["package", "absence"]) {
    const result = validateEntryPackageCommand(
      {
        strategyInstanceId: "runtime-owned-instance-id",
        tradeCycleId: "runtime-owned-cycle-id",
      },
      requestExamples[name].value,
    );
    assert.equal(result.ok, true, name);
  }

  const responseExamples = operation.responses["200"].content["application/json"].examples;
  const applied = responseExamples.applied.value;
  assert.deepEqual(
    serializeAppliedEntryPackage({
      strategyInstanceId: applied.strategy_instance_id,
      tradeCycleId: applied.trade_cycle_id,
      completePackageApplied: true,
      appliedDesiredEntry: applied.applied_desired_entry,
      acceptedRiskMultiplier: applied.accepted_risk_multiplier,
      calculatedQuantity: applied.calculated_quantity,
    }).body,
    applied,
  );

  const absent = responseExamples.absent.value;
  assert.deepEqual(
    serializeAbsentEntryPackage({
      strategyInstanceId: absent.strategy_instance_id,
      tradeCycleId: absent.trade_cycle_id,
    }).body,
    absent,
  );
});

test("OpenAPI owns transport shape without constraining Runtime value formats", async () => {
  const document = await readDocument();
  const operation = entryPackageOperation(document);
  const schemas = document.components.schemas;

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "415", "422", "500"]);

  for (const parameter of operation.parameters) {
    assert.equal(parameter.schema.minLength, 1);
    assert.equal("pattern" in parameter.schema, false);
    assert.equal("maxLength" in parameter.schema, false);
  }

  for (const name of ["PackagePresentRequest", "PackageAbsentRequest"]) {
    const ticker = schemas[name].properties.ticker;
    assert.equal(ticker.minLength, 1);
    assert.equal("pattern" in ticker, false);
    assert.equal("maxLength" in ticker, false);
    assert.deepEqual(schemas[name].properties.risk_multiplier, {
      type: "string",
      format: "positive-exact-decimal",
    });
  }

  const desiredEntry = schemas.DesiredEntry.properties;
  assert.equal("minimum" in desiredEntry.source_plan_bar_open_time_ms, false);
  assert.equal("maximum" in desiredEntry.source_plan_bar_open_time_ms, false);
  assert.deepEqual(desiredEntry.locked_exit_profile, { type: "string" });
  assert.equal(desiredEntry.planned_entry_price.format, "exact-decimal");
  assert.equal(desiredEntry.initial_stop_price.format, "exact-decimal");
  assert.equal(desiredEntry.initial_take_price.format, "positive-exact-decimal");

  const serialized = JSON.stringify(document);
  for (const forbidden of [
    "entry_package_conflict",
    "entry_package_processing_failed",
    "entry_package_timeout",
    "entry_order_reference",
    "initial_stop_reference",
    "initial_take_reference",
    "execution_status",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

async function readDocument(): Promise<Record<string, any>> {
  const documentUrl = new URL(
    "../../docs/openapi/abi-entry-package-api-v1.json",
    import.meta.url,
  );
  return JSON.parse(await readFile(documentUrl, "utf8")) as Record<string, any>;
}

function entryPackageOperation(document: Record<string, any>): Record<string, any> {
  return document.paths[
    "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package"
  ].put as Record<string, any>;
}
