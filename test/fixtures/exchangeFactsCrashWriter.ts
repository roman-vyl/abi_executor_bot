// Child process for the exchange facts crash test: writes batches of facts in
// a loop and prints "acked <batch>" only after each batch's commit returned.
// The parent kills it with SIGKILL at a random moment.
import { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";

const [dbPath, firstBatchArg, batchSizeArg] = process.argv.slice(2);
const batchSize = Number(batchSizeArg);
const store = ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "linear" });

for (let batch = Number(firstBatchArg); ; batch += 1) {
  const facts = Array.from({ length: batchSize }, (_, index) => ({
    kind: "execution" as const,
    source: "rest" as const,
    sourceEndpoint: "rest:/v5/execution/list",
    rawJson: JSON.stringify({
      symbol: "BTCUSDT",
      orderId: `crash-order-${batch}`,
      execId: `crash-${batch}-${index}`,
      execType: "Trade",
      execTime: String(1_792_939_843_422 + batch),
      padding: "x".repeat(512),
    }),
    receivedAtMs: 1_792_950_000_000 + batch,
  }));
  store.writeFacts(facts);
  process.stdout.write(`acked ${batch}\n`);
}
