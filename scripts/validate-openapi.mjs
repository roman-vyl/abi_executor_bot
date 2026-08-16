import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const openapiDir = new URL("../docs/openapi/", import.meta.url);

const routePrefix = "/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}";

const expectedDocuments = [
  {
    file: "abi-entry-package-api-v1.json",
    title: "ABI Entry Package API",
    operations: [
      {
        method: "put",
        httpMethod: "PUT",
        path: `${routePrefix}/entry-package`,
        responses: ["200", "400", "415", "422", "500"],
        requestBody: "required",
      },
    ],
    validate: validateEntryPackageDocument,
  },
  {
    file: "abi-open-position-lookup-api-v1.json",
    title: "ABI Open Position Lookup API",
    operations: [
      {
        method: "get",
        httpMethod: "GET",
        path: `${routePrefix}/open-position`,
        responses: ["200", "422", "500"],
        requestBody: "absent",
      },
    ],
    validate: validateOpenPositionDocument,
  },
  {
    file: "abi-entry-cycle-recovery-api-v1.json",
    title: "ABI Entry Cycle Recovery API",
    operations: [
      {
        method: "get",
        httpMethod: "GET",
        path: `${routePrefix}/recovery-state`,
        responses: ["200", "422", "500"],
        requestBody: "absent",
      },
    ],
    validate: validateEntryCycleRecoveryDocument,
  },
  {
    file: "abi-position-management-api-v1.json",
    title: "ABI Position Management API",
    operations: [
      {
        method: "put",
        httpMethod: "PUT",
        path: `${routePrefix}/protection`,
        responses: ["200", "400", "415", "422", "500"],
        requestBody: "required",
      },
      {
        method: "delete",
        httpMethod: "DELETE",
        path: `${routePrefix}/open-position`,
        responses: ["200", "422", "500"],
        requestBody: "absent",
      },
    ],
    validate: validatePositionManagementDocument,
  },
];

const actualFiles = (await readdir(openapiDir)).filter((name) => name.endsWith(".json")).sort();
const expectedFiles = expectedDocuments.map((document) => document.file).sort();
assert.deepEqual(actualFiles, expectedFiles, "validate:openapi must cover every current docs/openapi JSON document");

for (const expected of expectedDocuments) {
  const document = await readJson(new URL(expected.file, openapiDir));
  validateDocumentInventory(document, expected);
  expected.validate(document);
}

console.log(
  `ABI OpenAPI contracts are valid (${expectedDocuments.length} documents, ${expectedDocuments.flatMap((document) => document.operations).length} operations)`,
);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function validateDocumentInventory(document, expected) {
  assert.equal(document.openapi, "3.1.0", `${expected.file}: OpenAPI version`);
  assert.equal(document.info?.title, expected.title, `${expected.file}: info.title`);
  assert.equal(document.info?.version, "1.0.0", `${expected.file}: info.version`);
  assert.ok(document.components?.schemas, `${expected.file}: components.schemas is required`);

  const expectedPaths = [...new Set(expected.operations.map((operation) => operation.path))].sort();
  assert.deepEqual(Object.keys(document.paths ?? {}).sort(), expectedPaths, `${expected.file}: documented paths`);

  for (const path of expectedPaths) {
    const pathItem = document.paths[path];
    const expectedMethods = expected.operations
      .filter((operation) => operation.path === path)
      .map((operation) => operation.method)
      .sort();
    assert.deepEqual(Object.keys(pathItem).sort(), expectedMethods, `${expected.file}: methods for ${path}`);
  }

  for (const operationSpec of expected.operations) {
    const operation = document.paths[operationSpec.path]?.[operationSpec.method];
    assert.ok(operation, `${expected.file}: ${operationSpec.httpMethod} ${operationSpec.path} is required`);
    assert.equal(typeof operation.operationId, "string", `${expected.file}: operationId is required`);
    assertSharedPathParameters(operation, `${expected.file}: ${operationSpec.httpMethod} ${operationSpec.path}`);
    assert.deepEqual(Object.keys(operation.responses).sort(), operationSpec.responses, `${expected.file}: responses`);

    if (operationSpec.requestBody === "required") {
      assert.equal(operation.requestBody?.required, true, `${expected.file}: requestBody.required`);
      assert.ok(operation.requestBody.content?.["application/json"], `${expected.file}: JSON requestBody content`);
    } else {
      assert.equal("requestBody" in operation, false, `${expected.file}: requestBody must be absent`);
    }

    for (const [status, response] of Object.entries(operation.responses)) {
      assert.ok(response.content?.["application/json"], `${expected.file}: ${status} JSON response content`);
    }
  }
}

function assertSharedPathParameters(operation, label) {
  assert.equal(operation.parameters?.length, 2, `${label}: exactly two path parameters`);
  assert.deepEqual(
    operation.parameters.map((parameter) => parameter.name),
    ["strategy_instance_id", "trade_cycle_id"],
    `${label}: path parameter names`,
  );

  for (const parameter of operation.parameters) {
    assert.equal(parameter.in, "path", `${label}: ${parameter.name} parameter location`);
    assert.equal(parameter.required, true, `${label}: ${parameter.name} required`);
    assert.equal(parameter.schema.type, "string", `${label}: ${parameter.name} type`);
    assert.equal(parameter.schema.minLength, 1, `${label}: ${parameter.name} minLength`);
    assert.equal("pattern" in parameter.schema, false, `${label}: ${parameter.name} must stay opaque`);
    assert.equal("maxLength" in parameter.schema, false, `${label}: ${parameter.name} must stay unconstrained`);
  }
}

function validateEntryPackageDocument(document) {
  const operation = document.paths[`${routePrefix}/entry-package`].put;
  const schemas = document.components.schemas;

  assert.deepEqual(schemas.EntryPackageRequest.oneOf, [
    { $ref: "#/components/schemas/PackagePresentRequest" },
    { $ref: "#/components/schemas/PackageAbsentRequest" },
  ]);

  for (const name of ["PackagePresentRequest", "PackageAbsentRequest", "DesiredEntry"]) {
    assert.equal(schemas[name].additionalProperties, false, `${name} must be closed`);
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
    "applied_desired_entry",
    "calculated_quantity",
    "status",
    "strategy_instance_id",
    "trade_cycle_id",
  ]);
  assert.equal(appliedProperties.status.const, "entry_package_applied");
  assert.equal(schemas.EntryPackageAbsentResponse.properties.status.const, "entry_package_absent");

  assert.ok(operation.requestBody.content["application/json"].examples.package);
  assert.ok(operation.requestBody.content["application/json"].examples.absence);
  assert.ok(operation.responses["200"].content["application/json"].examples.applied);
  assert.ok(operation.responses["200"].content["application/json"].examples.absent);
  assert.ok(operation.responses["422"].content["application/json"].example);
  assert.ok(operation.responses["500"].content["application/json"].example);

  assertForbiddenText(document, [
    "ReconcileEntryPackagePort",
    "accepted_risk_multiplier",
    "entry_package_conflict",
    "entry_package_processing_failed",
    "entry_package_timeout",
    "entry_order_reference",
    "initial_stop_reference",
    "initial_take_reference",
    "execution_status",
  ]);
}

function validateOpenPositionDocument(document) {
  const schemas = document.components.schemas;

  assert.equal(schemas.OpenPositionResponse.oneOf.length, 2);
  assert.equal(schemas.OpenPositionBusinessError.oneOf.length, 3);
  assert.equal(schemas.InternalError.properties.error.properties.code.const, "internal_error");

  assertForbiddenText(document, [
    "pending_create",
    "pending_replace",
    "pending_cancel",
    "terminal_unfilled",
    "early_execution_observation",
    "entry_bar_open_time_ms",
    "positionIdx",
    "queryPositionForInstrument",
    "OpenPositionResolutionServicePort",
  ]);
}

function validateEntryCycleRecoveryDocument(document) {
  const schemas = document.components.schemas;

  assert.equal(schemas.RecoveryStateResponse.oneOf.length, 4);
  assert.equal(schemas.RecoveryStateBusinessError.oneOf.length, 2);
  assert.equal(schemas.InternalError.properties.error.properties.code.const, "internal_error");

  const stateConsts = ["EntryOrderLiveResponse", "PositionOpenResponse", "TerminalWithoutFillResponse", "TerminalAfterFillResponse"].map(
    (name) => schemas[name].properties.recovery_state.const,
  );
  assert.deepEqual(stateConsts, [
    "entry_order_live",
    "position_open",
    "terminal_without_fill",
    "terminal_after_fill",
  ]);

  for (const name of ["EntryOrderLiveResponse", "PositionOpenResponse"]) {
    assert.deepEqual(schemas[name].properties.applied_entry_package, {
      $ref: "#/components/schemas/AppliedEntryPackage",
    });
  }
  for (const name of ["TerminalWithoutFillResponse", "TerminalAfterFillResponse"]) {
    assert.equal(schemas[name].properties.applied_entry_package.type, "null");
  }

  assert.equal(schemas.PositionOpenResponse.properties.first_fill_at_ms.type, "integer");
  assert.equal(schemas.PositionOpenResponse.properties.average_entry_price.format, "positive-exact-decimal");
  assert.equal(schemas.EntryOrderLiveResponse.properties.first_fill_at_ms.type, "null");

  assertForbiddenText(document, [
    "pending_create",
    "pending_replace",
    "pending_cancel",
    "queryPositionForInstrument",
    "EntryCycleRecoveryResolutionServicePort",
    "unsupported_exchange_scope",
  ]);
}

function validatePositionManagementDocument(document) {
  const schemas = document.components.schemas;
  const protectionOperation = document.paths[`${routePrefix}/protection`].put;
  const closeOperation = document.paths[`${routePrefix}/open-position`].delete;

  assert.deepEqual(schemas.ProtectionRequest.required, ["stop_price", "take_price"]);
  assert.equal(schemas.ProtectionRequest.additionalProperties, false);
  assert.equal(schemas.ProtectionAppliedResponse.additionalProperties, false);
  assert.equal(schemas.ProtectionAppliedResponse.properties.status.const, "protection_applied");

  const protectionBusinessErrorRefs = schemas.ProtectionBusinessError.oneOf.map((entry) => entry.$ref);
  assert.deepEqual(protectionBusinessErrorRefs, [
    "#/components/schemas/ValidationFailedError",
    "#/components/schemas/UnknownTradeCycleBindingError",
    "#/components/schemas/UnsupportedExchangeScopeError",
    "#/components/schemas/PositionNotOpenError",
  ]);

  assert.equal("requestBody" in closeOperation, false);
  assert.equal(schemas.TradeCycleClosedResponse.additionalProperties, false);
  assert.equal(schemas.TradeCycleClosedResponse.properties.status.const, "trade_cycle_closed");

  const closeBusinessErrorRefs = schemas.CloseBusinessError.oneOf.map((entry) => entry.$ref);
  assert.deepEqual(closeBusinessErrorRefs, [
    "#/components/schemas/ValidationFailedError",
    "#/components/schemas/UnknownTradeCycleBindingError",
    "#/components/schemas/UnsupportedExchangeScopeError",
  ]);
  assert.equal(JSON.stringify(schemas.CloseBusinessError).includes("PositionNotOpenError"), false);

  assert.ok(protectionOperation.requestBody.content["application/json"].examples.withTake);
  assert.ok(protectionOperation.requestBody.content["application/json"].examples.stopOnly);
  assert.ok(protectionOperation.responses["200"].content["application/json"].examples.applied);
  assert.ok(closeOperation.responses["200"].content["application/json"].examples.closed);

  assertForbiddenText(document, ["bybit", "Bybit", "adapter", "positionIdx", "orderLinkId"]);
}

function assertForbiddenText(document, forbiddenValues) {
  const serialized = JSON.stringify(document);
  for (const forbidden of forbiddenValues) {
    assert.equal(serialized.includes(forbidden), false, `OpenAPI contains forbidden ${forbidden}`);
  }
}
