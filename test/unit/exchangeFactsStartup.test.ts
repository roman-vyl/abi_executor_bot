import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openExchangeFactsStore } from "../../src/app/exchangeFactsStartup.js";
import { ExchangeFactsOpenError, ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";
import type { EventLevel } from "../../src/observability/events.js";
import { makeTestConfig } from "../fixtures/config.js";

type EmittedEvent = { level: EventLevel; event: string; fields?: Record<string, unknown> };

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-facts-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a disabled store opens nothing and creates no file", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  let openCalls = 0;
  const state = openExchangeFactsStore(makeTestConfig({ exchangeFactsDbPath: dbPath }), {
    open: () => {
      openCalls += 1;
      throw new Error("must not open");
    },
  });
  assert.deepEqual(state, { status: "disabled" });
  assert.equal(openCalls, 0);
  assert.equal(existsSync(dbPath), false);
});

test("an enabled store opens the database of the configured environment", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const state = openExchangeFactsStore(
    makeTestConfig({ exchangeFactsEnabled: true, exchangeFactsDbPath: dbPath, bybitEnvironment: "demo" }),
  );
  assert.equal(state.status, "enabled");
  assert.ok(state.status === "enabled" && state.store instanceof ExchangeFactsStore);
  state.store.close();
  assert.equal(existsSync(dbPath), true);
});

test("an enabled store that cannot open is reported and left unavailable without exiting", (t) => {
  const dir = tempDir(t);
  const dbPath = path.join(dir, "facts.sqlite3");
  ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "linear" }).close();

  for (const [overrides, reason] of [
    [{ exchangeFactsDbPath: dbPath, bybitEnvironment: "mainnet" as const }, "exchange_facts_environment_mismatch"],
    [{ exchangeFactsDbPath: path.join(dir, "missing", "facts.sqlite3") }, "open_failed"],
  ] as const) {
    const emitted: EmittedEvent[] = [];
    const state = openExchangeFactsStore(makeTestConfig({ exchangeFactsEnabled: true, ...overrides }), {
      emit: (level, event, fields) => emitted.push({ level, event, fields }),
    });
    assert.deepEqual(state, { status: "unavailable", reason });
    assert.deepEqual(emitted, [{ level: "error", event: "exchange_facts_store_failed", fields: { reason } }]);
  }
});

test("a SQLite driver that cannot load leaves the store unavailable", () => {
  const emitted: EmittedEvent[] = [];
  const state = openExchangeFactsStore(makeTestConfig({ exchangeFactsEnabled: true }), {
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
    open: (input) =>
      ExchangeFactsStore.open(input, {
        loadDriver: () => {
          throw new Error("native binding not found");
        },
      }),
  });
  assert.deepEqual(state, { status: "unavailable", reason: "exchange_facts_driver_unavailable" });
  assert.deepEqual(emitted, [
    { level: "error", event: "exchange_facts_store_failed", fields: { reason: "exchange_facts_driver_unavailable" } },
  ]);
});

test("an unexpected open error is reported as open_failed", () => {
  const state = openExchangeFactsStore(makeTestConfig({ exchangeFactsEnabled: true }), {
    emit: () => {},
    open: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(state, { status: "unavailable", reason: "open_failed" });
});

test("ExchangeFactsStore.open maps a driver load failure to exchange_facts_driver_unavailable", () => {
  assert.throws(
    () =>
      ExchangeFactsStore.open(
        { path: ":memory:", bybitEnvironment: "demo", category: "linear" },
        {
          loadDriver: () => {
            throw new Error("dlopen failed");
          },
        },
      ),
    (error: unknown) => error instanceof ExchangeFactsOpenError && error.reason === "exchange_facts_driver_unavailable",
  );
});

test("with the store disabled the SQLite native driver is never loaded", async () => {
  const probe = fileURLToPath(new URL("../fixtures/exchangeFactsDriverProbe.ts", import.meta.url));
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", probe], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`probe failed: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
  assert.deepEqual(JSON.parse(output.trim()), { status: "disabled", driverLoaded: false });
});
