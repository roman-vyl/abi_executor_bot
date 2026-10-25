import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openExchangeFactsStoreOrExit } from "../../src/app/exchangeFactsStartup.js";
import { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";
import type { EventLevel } from "../../src/observability/events.js";
import { makeTestConfig } from "../fixtures/config.js";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

type EmittedEvent = { level: EventLevel; event: string; fields?: Record<string, unknown> };

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-facts-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const exit = (code: number): never => {
  throw new ExitCalled(code);
};

test("a disabled store opens nothing and creates no file", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const store = openExchangeFactsStoreOrExit(makeTestConfig({ exchangeFactsDbPath: dbPath }), { exit });
  assert.equal(store, undefined);
  assert.equal(existsSync(dbPath), false);
});

test("an enabled store opens the database of the configured environment", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const store = openExchangeFactsStoreOrExit(
    makeTestConfig({ exchangeFactsEnabled: true, exchangeFactsDbPath: dbPath, bybitEnvironment: "demo" }),
    { exit },
  );
  assert.ok(store instanceof ExchangeFactsStore);
  store.close();
  assert.equal(existsSync(dbPath), true);
});

test("an enabled store that cannot open emits exchange_facts_store_failed and exits 1", (t) => {
  const dir = tempDir(t);
  const dbPath = path.join(dir, "facts.sqlite3");
  ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "linear" }).close();

  for (const [overrides, reason] of [
    [{ exchangeFactsDbPath: dbPath, bybitEnvironment: "mainnet" as const }, "exchange_facts_environment_mismatch"],
    [{ exchangeFactsDbPath: path.join(dir, "missing", "facts.sqlite3") }, "open_failed"],
  ] as const) {
    const emitted: EmittedEvent[] = [];
    assert.throws(
      () =>
        openExchangeFactsStoreOrExit(makeTestConfig({ exchangeFactsEnabled: true, ...overrides }), {
          exit,
          emit: (level, event, fields) => emitted.push({ level, event, fields }),
        }),
      (error: unknown) => error instanceof ExitCalled && error.code === 1,
    );
    assert.deepEqual(emitted, [{ level: "error", event: "exchange_facts_store_failed", fields: { reason } }]);
  }
});
