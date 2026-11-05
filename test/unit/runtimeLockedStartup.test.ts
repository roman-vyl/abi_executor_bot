import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";

test("runtime-locked ABI serves HTTP and the local journal without exchange or execution side effects", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "abi-locked-startup-"));
  const correlationPath = join(directory, "correlation.jsonl");
  const repository = new EntryPackageCorrelationRepository(correlationPath);
  await repository.save(activeHedgeRecord());
  const originalJournal = await readFile(correlationPath, "utf8");

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  // A startup regression must not send a real Bybit request from this test.
  const guard = join(directory, "forbid-exchange.mjs");
  await writeFile(guard, 'globalThis.fetch = async () => { process.stderr.write("UNEXPECTED_EXCHANGE_REQUEST"); throw new Error("exchange disabled by test"); };');
  const env = {
    ...process.env,
    ABI_AUTHORIZATION_MODE: "runtime",
    ABI_HOST: "127.0.0.1",
    ABI_PORT: String(port),
    ABI_DRY_RUN: "false",
    ABI_LIVE_TRADING_ENABLED: "true",
    ABI_POSITION_SIZING_MODE: "risk",
    ABI_BYBIT_LINEAR_POSITION_BINDING_MODE: "hedge",
    ABI_BYBIT_HEARTBEAT_INTERVAL_MS: "1",
    ABI_ENTRY_PACKAGE_CORRELATION_PATH: correlationPath,
    ABI_EXCHANGE_FACTS_ENABLED: "true",
    ABI_EXCHANGE_FACTS_DB_PATH: join(directory, "facts.sqlite3"),
    BYBIT_ENV: "demo",
  };
  delete env.BYBIT_API_KEY;
  delete env.BYBIT_API_SECRET;
  delete env.ABI_CONFIG_PATH;
  delete env.ABI_DIAGNOSTICS_PATH;
  const child = spawn(process.execPath, ["--import", "tsx", "--import", guard, "src/app/index.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let live = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      live = (await fetch(base + "/health/live")).status === 200;
    } catch {}
    if (live) break;
    if (child.exitCode !== null) assert.fail(output);
    await delay(25);
  }
  assert.equal(live, true, output);
  for (let attempt = 0; attempt < 100 && !output.includes("correlation_replay_succeeded"); attempt++) {
    await delay(10);
  }
  assert.ok(output.includes("correlation_replay_succeeded"), output);
  const mode = await (await fetch(base + "/execution/mode")).json();
  assert.equal(mode.authorizationState, "LOCKED");
  assert.equal(mode.canExecuteLive, false);
  for (const path of ["/health", "/health/ready"]) {
    assert.equal((await fetch(base + path)).status, 503);
  }
  const journal = await fetch(base + "/v1/exchange-journal/status");
  assert.equal(journal.status, 200);

  const cycle = "/v1/strategy-instances/instance/trade-cycles/cycle";
  const attempts: [string, string, object?][] = [
    ["GET", "/account/balance"],
    ["GET", "/account/orders/active?symbol=BTCUSDT"],
    ["GET", "/account/positions/open?symbol=BTCUSDT"],
    ["POST", "/account/orders/cancel-all?symbol=BTCUSDT", {}],
    ["POST", "/account/positions/close-all?symbol=BTCUSDT", {}],
    ["PUT", cycle + "/entry-package", { ticker: "BTCUSDT.P", desired_entry: null, risk_multiplier: "1" }],
    ["GET", cycle + "/open-position"],
    ["GET", cycle + "/recovery-state"],
    ["PUT", cycle + "/protection", { stop_price: "99000", take_price: "103000" }],
    ["POST", cycle + "/close", { exposure_fraction: "1" }],
    ["POST", cycle + "/entry-remainder/cancel", {}],
  ];
  for (const [method, path, body] of attempts) {
    const result = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(result.status, 503, path);
    assert.deepEqual(await result.json(), {
      error: { code: "execution_not_ready", message: "ABI execution is not ready" },
    });
  }
  await delay(50);
  assert.equal(output.includes("UNEXPECTED_EXCHANGE_REQUEST"), false, output);
  assert.equal(await readFile(correlationPath, "utf8"), originalJournal);
});

function activeHedgeRecord(): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance", trade_cycle_id: "cycle",
    ticker: "BTCUSDT.P", exchange_symbol: "BTCUSDT", exchange_category: "linear",
    position_binding_mode: "hedge",
    created_at: "2026-08-29T00:00:00.000Z", updated_at: "2026-08-29T00:00:00.000Z",
    desired_entry: {
      side: "long", source_plan_bar_open_time_ms: 1, planned_entry_price: "100000",
      initial_stop_price: "99000", initial_take_price: "103000", locked_exit_profile: "profile",
    },
    risk_multiplier: "1", calculated_quantity: "0.001", order_link_id: "entry-instance", order_id: "order-instance",
    close_order_link_id: null, close_order_id: null, closure_reason: null, closure_order_id: null,
    closure_order_link_id: null, closure_parent_order_link_id: null, first_fill_at_ms: null,
    generation: 1, status: "applied", early_execution_observation: null, binding_history: [],
    pending_action: null, current_binding_started_at: "2026-08-29T00:00:00.000Z",
  };
}
