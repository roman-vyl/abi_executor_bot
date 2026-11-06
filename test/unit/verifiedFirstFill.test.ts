import assert from "node:assert/strict";
import test from "node:test";
import { verifyLocalFirstFill, captureFirstFill, FIRST_FILL_READ_LIMIT, type EntryFillProof } from "../../src/services/firstFill/verifiedFirstFill.js";
import { firstFillRecord, executionFact, factsReader } from "../fixtures/firstFillFacts.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
const record = firstFillRecord();
const proof: EntryFillProof = { entryTerminal: true, cumulativeFilledQty: "0.001", entryOrderId: "order-1" };

test("complete terminal single fill and out-of-order partial executions give true min time", () => {
  assert.deepEqual(verifyLocalFirstFill(record, proof, factsReader()), { kind: "verified", firstFillAtMs: 1000 });
  const facts = [executionFact("0.0007", 2000, "late"), executionFact("0.0003", 500, "early")];
  assert.deepEqual(verifyLocalFirstFill(record, proof, factsReader(record, facts)), { kind: "verified", firstFillAtMs: 500 });
});
test("matching WS/REST duplicates count once; decimal arithmetic is exact", () => {
  const a = executionFact("0.1", 1000, "a");
  const b = executionFact("0.2", 2000, "b");
  assert.deepEqual(verifyLocalFirstFill(record, { ...proof, cumulativeFilledQty: "0.3" }, factsReader(record, [a, { ...a, source: "rest" }, b])), { kind: "verified", firstFillAtMs: 1000 });
});
test("live partial snapshot race and unknown proof perform zero SQLite reads", () => {
  const r = factsReader(record, [executionFact("2", 2000)]);
  for (const p of [undefined, { ...proof, entryTerminal: false, cumulativeFilledQty: "2" }]) {
    assert.equal(verifyLocalFirstFill(record, p, r).kind, "unavailable");
  }
  assert.equal(r.reads, 0);
});
test("terminal cancelled remainder uses final cumulative quantity, not planned qty", () => {
  assert.deepEqual(verifyLocalFirstFill(record, { ...proof, cumulativeFilledQty: "0.0004" }, factsReader(record, [executionFact("0.0004")])), { kind: "verified", firstFillAtMs: 1000 });
});
for (const [name, facts] of [
  ["missing early fill", [executionFact("0.0004")]],
  ["overcount", [executionFact("0.002")]],
  ["conflicting execId qty", [executionFact(), executionFact("0.002")]],
  ["conflicting execId time", [executionFact(), executionFact("0.001", 2000)]],
  ["read limit despite matching visible prefix", Array.from({ length: FIRST_FILL_READ_LIMIT }, () => executionFact())],
] as const) test(name, () => {
  assert.equal(verifyLocalFirstFill(record, proof, factsReader(record, [...facts])).kind, "unavailable");
});
for (const key of ["orderId", "orderLinkId", "strategyInstanceId", "tradeCycleId", "generation", "role", "parentOrderLinkId"] as const) test(`link conflict ${key}`, () => {
  const r = factsReader(); Object.assign(r.link, { [key]: key === "generation" ? 2 : "foreign" });
  assert.equal(verifyLocalFirstFill(record, proof, r).kind, "unavailable");
});
for (const [key, value] of Object.entries({ symbol: "ETHUSDT", orderId: "foreign", orderLinkId: "foreign", side: "Sell", category: "spot", execId: "foreign", execType: "Funding", execTime: "invalid", execQty: "-1", positionIdx: 2 })) test(`raw mismatch ${key}`, () => {
  const f = executionFact();f.rawJson = JSON.stringify({ ...JSON.parse(f.rawJson), [key]: value });
  assert.equal(verifyLocalFirstFill(record, proof, factsReader(record, [f])).kind, "unavailable");
});
test("malformed data, missing link/id, disabled or throwing store stay unavailable", () => {
  assert.equal(verifyLocalFirstFill(record, proof, undefined).kind, "unavailable");
  const r = factsReader();r.readLinkForOrder = () => { throw Error("db"); };
  assert.equal(verifyLocalFirstFill(record, proof, r).kind, "unavailable");
  assert.equal(verifyLocalFirstFill(record, { ...proof, entryOrderId: null }, factsReader()).kind, "unavailable");
  const r2 = factsReader();r2.readLinkForOrder = () => null;
  assert.equal(verifyLocalFirstFill(record, proof, r2).kind, "unavailable");
  assert.equal(verifyLocalFirstFill(record, proof, factsReader(record, [{ ...executionFact(), rawJson: "bad" }])).kind, "unavailable");
});
test("REST success and saved timestamp bypass all local reads; empty REST permits terminal proof only", async () => {
  const bybit = new FakeBybitAdapter();const reader = factsReader();
  bybit.executionListResponse = { result: { category: "linear", list: [{ symbol: "BTCUSDT", execType: "Trade", execTime: "900", execQty: "0.001" }], nextPageCursor: "" } };
  assert.deepEqual(await captureFirstFill({ record, proof, reader, bybit }), { kind: "found", firstFillAtMs: 900 });
  assert.equal(reader.reads, 0);
  const calls = bybit.getExecutionListCalls.length;
  assert.deepEqual(await captureFirstFill({ record: { ...record, first_fill_at_ms: 100 }, proof, reader, bybit }), { kind: "found", firstFillAtMs: 100 });
  assert.equal(bybit.getExecutionListCalls.length, calls);assert.equal(reader.reads, 0);
  bybit.executionListResponse = { result: { category: "linear", list: [], nextPageCursor: "" } };
  assert.deepEqual(await captureFirstFill({ record, proof, reader, bybit }), { kind: "found", firstFillAtMs: 1000 });
  const reads = reader.reads;
  assert.deepEqual(await captureFirstFill({ record, proof: { ...proof, entryTerminal: false }, reader, bybit }), { kind: "no_executions_found" });
  assert.equal(reader.reads, reads);
});

test("execution without positionIdx is tied through confirmed hedge order/link", () => {
  for (const side of ["long", "short"] as const) {
    const r = { ...firstFillRecord({ side }), position_binding_mode: "hedge" as const };
    const f = executionFact("0.001", 1000, "hedge-exec", r);
    const raw = JSON.parse(f.rawJson);delete raw.positionIdx;f.rawJson = JSON.stringify(raw);
    assert.deepEqual(verifyLocalFirstFill(r, proof, factsReader(r, [f])), { kind: "verified", firstFillAtMs: 1000 });
    raw.positionIdx = side === "long" ? 2 : 1;f.rawJson = JSON.stringify(raw);
    assert.equal(verifyLocalFirstFill(r, proof, factsReader(r, [f])).kind, "unavailable");
  }
});
test("ambiguous REST falls back once; unavailable local proof preserves REST outcome", async () => {
  const bybit = new FakeBybitAdapter();let calls = 0;
  bybit.getExecutionList = async () => { calls++;throw Error("temporary REST failure"); };
  assert.deepEqual(await captureFirstFill({ record, proof, reader: factsReader(), bybit }), { kind: "found", firstFillAtMs: 1000 });
  assert.equal(calls, 1);
  assert.deepEqual(await captureFirstFill({ record, proof, bybit }), { kind: "ambiguous" });assert.equal(calls, 2);
});

test("store category mismatch rejects before SQLite reads", () => {
  const reader = { ...factsReader(), category: "spot" };
  assert.equal(verifyLocalFirstFill(record, proof, reader).kind, "unavailable");assert.equal(reader.reads, 0);
});
