import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { firstFillRecord, executionFact, factsReader } from "../fixtures/firstFillFacts.js";

for (const Service of [OpenPositionResolutionService, EntryCycleRecoveryResolutionService]) {
  for (const mode of ["filled", "cancelled_partial", "live", "rest_success", "incomplete", "store_error", "missing_store", "closed", "generation", "saved", "write_error", "state_veto", "missing_order_id"] as const) {
    test(`${Service.name}: REST-first ${mode}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "first-fill-integration-"));
      try {
        const record = firstFillRecord();
        if (mode === "closed") record.status = "terminal_closed";
        if (mode === "saved") record.first_fill_at_ms = 777;
        const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));await repo.save(record);
        const bybit = new FakeBybitAdapter();
        const qty = ["cancelled_partial", "live"].includes(mode) ? "0.0004" : "0.001";
        const status = mode === "live" ? "PartiallyFilled" : mode === "cancelled_partial" ? "Cancelled" : "Filled";
        bybit.orderByLinkIdResponse = bybit.orderHistoryResponse = {
          retCode: 0, result: { category: "linear", list: [{ symbol: "BTCUSDT", orderId: mode === "missing_order_id" ? undefined : "order-1", orderLinkId: "link-1", positionIdx: 0,
            orderStatus: status, qty: "0.001", cumExecQty: qty, avgPrice: "100000", triggerPrice: "0", stopLoss: "0", takeProfit: "0" }] },
        };
        bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [{ symbol: "BTCUSDT", side: mode === "state_veto" ? "Sell" : "Buy", size: qty, positionIdx: 0, avgPrice: "100000", openTime: 1000 }] } };
        bybit.executionListResponse = { result: { category: "linear", list: mode === "rest_success" ? [{ symbol: "BTCUSDT", execType: "Trade", execTime: "900", execQty: qty }] : [], nextPageCursor: "" } };
        const reader = factsReader(record, [executionFact(mode === "incomplete" ? "0.0002" : qty)]);
        if (mode === "store_error") reader.readFactsForOrder = () => { throw Error("unavailable"); };
        if (mode === "generation") reader.link.generation++;
        if (mode === "write_error") repo.save = async () => { throw Error("disk failure"); };
        const service = new Service({ correlationRepository: repo, bybit, mutex: new KeyedMutex(), firstFillFacts: mode === "missing_store" ? undefined : reader });
        const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
        const success = ["filled", "cancelled_partial", "rest_success", "closed", "saved", "write_error"].includes(mode);
        assert.equal(result.statusCode, success ? 200 : 500);
        if (success && mode !== "closed") {
          assert.equal(result.body.first_fill_at_ms, mode === "rest_success" ? 900 : mode === "saved" ? 777 : 1000);
          assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, mode === "write_error" ? null : result.body.first_fill_at_ms);
        }
        if (["live", "rest_success", "closed", "saved", "state_veto", "missing_order_id"].includes(mode)) assert.equal(reader.reads, 0);
        assert.equal(bybit.getExecutionListCalls.length, ["closed", "saved", "state_veto"].includes(mode) ? 0 : 1);
        assert.equal(bybit.createOrderCalls.length + bybit.cancelOrderCalls.length + bybit.amendOrderCalls.length, 0);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}

test("recovery terminal_after_fill uses shared proof best-effort and never reopens cycle", async () => {
  for (const local of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), "first-fill-terminal-"));
    try {
      const record = { ...firstFillRecord(), close_order_link_id: "close-1", close_order_id: "close-order" };
      const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));await repo.save(record);
      const bybit = new FakeBybitAdapter();
      const row = (link: string, id: string) => ({ retCode: 0, result: { category: "linear", list: [{ symbol: "BTCUSDT", orderLinkId: link, orderId: id,
        positionIdx: 0, orderStatus: "Filled", qty: "0.001", cumExecQty: "0.001", avgPrice: "100000", triggerPrice: "0", stopLoss: "0", takeProfit: "0" }] } });
      bybit.orderByLinkIdResponseByLinkId.set("link-1", row("link-1", "order-1"));
      bybit.orderByLinkIdResponseByLinkId.set("close-1", row("close-1", "close-order"));
      bybit.executionListResponse = { result: { category: "linear", list: [], nextPageCursor: "" } };
      const service = new EntryCycleRecoveryResolutionService({ correlationRepository: repo, bybit, mutex: new KeyedMutex(), firstFillFacts: local ? factsReader(record) : undefined });
      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
      assert.equal(result.statusCode, 200);assert.equal(result.body.recovery_state, "terminal_after_fill");
      assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
      assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, local ? 1000 : null);
      assert.equal(bybit.createOrderCalls.length, 0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
