import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const documentUrl = new URL("../docs/openapi/abi-entry-package-api-v1.json", import.meta.url);
const document = JSON.parse(await readFile(documentUrl, "utf8"));

assert.equal(document.openapi, "3.1.0");

const route =
  "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package";
const operation = document.paths?.[route]?.put;
assert.ok(operation, "entry-package PUT operation is required");
assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "415", "422", "500"]);

const schemas = document.components?.schemas;
assert.ok(schemas, "components.schemas is required");
assert.deepEqual(schemas.EntryPackageRequest.oneOf, [
  { $ref: "#/components/schemas/PackagePresentRequest" },
  { $ref: "#/components/schemas/PackageAbsentRequest" },
]);

for (const name of ["PackagePresentRequest", "PackageAbsentRequest", "DesiredEntry"]) {
  assert.equal(schemas[name].additionalProperties, false, `${name} must be closed`);
}

for (const parameter of operation.parameters) {
  assert.equal(parameter.schema.type, "string");
  assert.equal(parameter.schema.minLength, 1);
  assert.equal("pattern" in parameter.schema, false);
  assert.equal("maxLength" in parameter.schema, false);
}

for (const name of ["PackagePresentRequest", "PackageAbsentRequest"]) {
  const ticker = schemas[name].properties.ticker;
  assert.equal(ticker.type, "string");
  assert.equal(ticker.minLength, 1);
  assert.equal("pattern" in ticker, false);
  assert.equal("maxLength" in ticker, false);
  assert.deepEqual(schemas[name].properties.risk_multiplier, {
    type: "string",
    format: "positive-exact-decimal",
  });
}

const desiredEntry = schemas.DesiredEntry;
assert.equal(desiredEntry.properties.source_plan_bar_open_time_ms.type, "integer");
assert.equal("minimum" in desiredEntry.properties.source_plan_bar_open_time_ms, false);
assert.equal("maximum" in desiredEntry.properties.source_plan_bar_open_time_ms, false);
assert.equal(desiredEntry.properties.planned_entry_price.format, "exact-decimal");
assert.equal(desiredEntry.properties.initial_stop_price.format, "exact-decimal");
assert.equal(desiredEntry.properties.initial_take_price.format, "positive-exact-decimal");
assert.deepEqual(desiredEntry.properties.side.enum, ["long", "short"]);
assert.deepEqual(desiredEntry.properties.locked_exit_profile, { type: "string" });

const appliedProperties = schemas.EntryPackageAppliedResponse.properties;
assert.deepEqual(Object.keys(appliedProperties).sort(), [
  "accepted_risk_multiplier",
  "applied_desired_entry",
  "calculated_quantity",
  "status",
  "strategy_instance_id",
  "trade_cycle_id",
]);
assert.equal(appliedProperties.status.const, "entry_package_applied");
assert.equal(
  schemas.EntryPackageAbsentResponse.properties.status.const,
  "entry_package_absent",
);

assert.ok(operation.requestBody.content["application/json"].examples.package);
assert.ok(operation.requestBody.content["application/json"].examples.absence);
assert.ok(operation.responses["200"].content["application/json"].examples.applied);
assert.ok(operation.responses["200"].content["application/json"].examples.absent);
assert.ok(operation.responses["422"].content["application/json"].example);
assert.ok(operation.responses["500"].content["application/json"].example);

const serialized = JSON.stringify(document);
for (const forbidden of [
  "ReconcileEntryPackagePort",
  "entry_package_conflict",
  "entry_package_processing_failed",
  "entry_package_timeout",
  "entry_order_reference",
  "initial_stop_reference",
  "initial_take_reference",
  "execution_status",
]) {
  assert.equal(serialized.includes(forbidden), false, `OpenAPI contains forbidden ${forbidden}`);
}

console.log("ABI entry-package OpenAPI contract is valid");
