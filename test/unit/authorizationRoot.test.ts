import { openExchangeFactsStore } from "../../src/app/exchangeFactsStartup.js";
import { ExchangeStreamRecorder } from "../../src/exchangeStream/exchangeStreamRecorder.js";
import { ExchangeRestReconciler } from "../../src/exchangeFacts/exchangeRestReconciler.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { startServer } from "../../src/app/server.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import { relayCredentials } from "../../src/authorization/credentialRelay.js";
import { makeTestConfig } from "../fixtures/config.js";

const reply = (result: unknown) => new Response(JSON.stringify({ retCode: 0, result }));
const keyInfo = () => reply({ apiKey: "key", userID: 123, readOnly: 0, permissions: { ContractTrade: ["Order", "Position"] } });
const geometry = () => reply({ category: "linear", list: [{ symbol: "BTCUSDT", positionIdx: 1 }, { symbol: "BTCUSDT", positionIdx: 2 }] });
const until = async (predicate: () => Promise<boolean>) => {
  for (let n = 0; n < 100; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("condition did not converge");
};
async function fixture(t: test.TestContext, transport: typeof fetch, observers = false) {
  const directory = await mkdtemp(join(tmpdir(), "abi-root-"));
  const config = makeTestConfig({ port: 0, bybitEnvironment: "demo", positionSizingMode: "risk",
    bybitLinearPositionBindingMode: "hedge", authorizationSocketPath: join(directory, "auth/control.sock"),
    entryPackageCorrelationPath: join(directory, "correlation.jsonl"), bybitHeartbeatIntervalMs: 0,
    exchangeFactsEnabled: observers, exchangeFactsDbPath: join(directory, "facts.sqlite3") });
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => String(url).startsWith("http://127.0.0.1:")
    ? original(url, init) : transport(url, init));
  const root = await startServer(config, openExchangeFactsStore(config));
  const base = `http://127.0.0.1:${(root.server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await root.close(); } };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const health = async () => (await original(`${base}/health/ready`)).json();
  const control = async (op: string) => {
    const frame = Buffer.from(JSON.stringify({ v: 1, op, ...(op === "authorize" ? { credentials: ["key", "secret"] } : {}) }) + "\n");
    async function* input() { yield frame; }
    return JSON.parse(await relayCredentials(input(), config.authorizationSocketPath));
  };
  return { root, base, health, control, close, request: original, config };
}

test("actual root starts LOCKED with risk sizing; authorization opens account and trading without restart", async t => {
  const calls: string[] = [];
  const f = await fixture(t, async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, "GET");
    if (String(url).endsWith("/v5/user/query-api")) return keyInfo();
    return reply({ list: [] });
  });
  assert.equal((await f.request(`${f.base}/health/live`)).status, 200);
  assert.equal((await f.request(`${f.base}/health/ready`)).status, 503);
  assert.equal((await f.health()).authorization, "LOCKED");
  assert.equal((await f.request(`${f.base}/account/balance`)).status, 503);
  assert.equal((await f.request(`${f.base}/v1/strategy-instances/i/trade-cycles/c/open-position`)).status, 503);
  assert.equal(calls.length, 0);
  assert.equal((await f.control("authorize")).result, "accepted");
  await until(async () => (await f.health()).ok);
  assert.equal((await f.health()).authorization, "AUTHORIZED");
  assert.equal((await f.request(`${f.base}/account/balance`)).status, 200);
  assert.equal((await f.control("retry")).result, "already_authorized");
  assert.equal(calls.filter(path => path.endsWith("query-api")).length, 1);
});

test("AUTHORIZED remains independent from failed local replay; account works and trading stays closed", async t => {
  let cleanup = 0;
  t.mock.method(EntryPackageCorrelationRepository.prototype, "replay", async () => ({ ok: false, reason: "corrupt" }));
  t.mock.method(EntryPackageCorrelationRepository.prototype, "closeLeftoverAdmissionIntents", async () => { cleanup++; return []; });
  let calls = 0;
  const f = await fixture(t, async url => { calls++; return String(url).endsWith("query-api") ? keyInfo() : reply({ list: [] }); });
  assert.equal((await f.control("authorize")).result, "accepted");
  assert.equal((await f.health()).authorization, "AUTHORIZED");
  assert.equal((await f.health()).localRecoveryReady, false);
  assert.equal((await f.request(`${f.base}/account/positions/open`)).status, 200);
  assert.equal((await f.request(`${f.base}/v1/strategy-instances/i/trade-cycles/c/open-position`)).status, 503);
  assert.equal(cleanup, 0); assert.equal(calls, 2);
});

test("auth may finish before replay; bindings retry never replays or closes admissions twice", async t => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let replays = 0; let cleanup = 0; let bindingCalls = 0;
  t.mock.method(EntryPackageCorrelationRepository.prototype, "replay", async () => { replays++; await gate; return { ok: true }; });
  t.mock.method(EntryPackageCorrelationRepository.prototype, "closeLeftoverAdmissionIntents", async () => { cleanup++; return []; });
  t.mock.method(EntryPackageCorrelationRepository.prototype, "findAllActiveRecords", () => [{ exchange_category: "linear", exchange_symbol: "BTCUSDT", position_binding_mode: "hedge", desired_entry: { side: "long" } }]);
  const f = await fixture(t, async url => {
    if (String(url).endsWith("query-api")) return keyInfo();
    bindingCalls++; return bindingCalls === 1 ? reply({ category: "linear", list: [] }) : geometry();
  });
  assert.equal((await f.control("authorize")).result, "accepted");
  assert.equal((await f.health()).authorization, "AUTHORIZED");
  assert.equal((await f.health()).ok, false); assert.equal(bindingCalls, 0);
  release();
  await until(async () => Boolean((await f.health()).activationReason));
  assert.equal((await f.health()).localRecoveryReady, true);
  assert.equal((await f.health()).ok, false);
  await f.control("retry");
  await until(async () => (await f.health()).ok);
  assert.equal(replays, 1); assert.equal(cleanup, 1); assert.equal(bindingCalls, 2);
});

test("shutdown during bindings assurance prevents late READY", async t => {
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(EntryPackageCorrelationRepository.prototype, "findAllActiveRecords", () => [{ exchange_category: "linear", exchange_symbol: "BTCUSDT", position_binding_mode: "hedge", desired_entry: { side: "long" } }]);
  const f = await fixture(t, async url => {
    if (String(url).endsWith("query-api")) return keyInfo();
    started(); return new Promise(resolve => { release = resolve; });
  });
  await f.control("authorize"); await began;
  const closing = f.close();
  await assert.rejects(f.control("status"));
  release(geometry()); await closing;
  assert.equal(f.root.server.listening, false);
});

test("shutdown preserves drain of an already admitted account operation", async t => {
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async url => {
    if (String(url).endsWith("query-api")) return keyInfo();
    started(); return new Promise(resolve => { release = resolve; });
  });
  await f.control("authorize");
  const balance = f.request(`${f.base}/account/balance`); await began;
  const closing = f.close();
  release(reply({ balance: "1" }));
  assert.equal((await balance).status, 200); await closing;
});

test("root shutdown cancels verifier and ignores accepted arriving afterwards", async t => {
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.control("authorize").catch(() => undefined);
  await began; await f.close(); await pending;
  release(keyInfo()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.root.authorization.status(), "RETRY_PENDING");
  assert.equal(f.root.authorization.credentials(), undefined);
});

test("observers are created and started once after authorization, independently from failed trading recovery", async t => {
  const streamStart = t.mock.method(ExchangeStreamRecorder.prototype, "start", () => undefined);
  const restStart = t.mock.method(ExchangeRestReconciler.prototype, "start", () => undefined);
  t.mock.method(EntryPackageCorrelationRepository.prototype, "replay", async () => ({ ok: false, reason: "corrupt" }));
  const f = await fixture(t, async () => keyInfo(), true);
  assert.equal(streamStart.mock.callCount(), 0); assert.equal(restStart.mock.callCount(), 0);
  await f.control("authorize");
  assert.equal(streamStart.mock.callCount(), 1); assert.equal(restStart.mock.callCount(), 1);
  await f.control("retry");
  assert.equal(streamStart.mock.callCount(), 1); assert.equal(restStart.mock.callCount(), 1);
  assert.equal((await f.health()).authorization, "AUTHORIZED");
  assert.equal((await f.health()).ok, false);
});
