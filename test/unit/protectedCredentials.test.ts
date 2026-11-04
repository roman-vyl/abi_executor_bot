import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../../src/config/config.js";
import { getLiveExecutionMode } from "../../src/execution/liveGuard.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "abi-protected-"));
  const ready = join(root, "ready");
  mkdirSync(ready);
  t.after(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(ready, "key"), "dummy-key");
  return { root, ready, env: { ABI_PROTECTED_CREDENTIALS_DIR: root } };
}

test("loads a complete pair once and removes the files", (t) => {
  const { ready, env } = fixture(t);
  writeFileSync(join(ready, "secret"), "dummy-secret");
  const config = loadConfig({ ...env, ABI_POSITION_SIZING_MODE: "risk" });
  assert.equal(config.bybitApiKey, "dummy-key");
  assert.equal(config.bybitApiSecret, "dummy-secret");
  assert.equal(existsSync(ready), false);
  assert.throws(() => loadConfig(env), /Invalid or unreadable/);
});

for (const failure of ["missing", "empty", "unreadable"] as const) {
  test(`fails closed and cleans up a ${failure} credential`, (t) => {
    const { ready, env } = fixture(t);
    const secret = join(ready, "secret");
    if (failure === "empty") writeFileSync(secret, "");
    if (failure === "unreadable") symlinkSync(join(ready, "absent"), secret);
    assert.throws(() => loadConfig(env), /Invalid or unreadable/);
    assert.equal(existsSync(ready), false);
  });
}

test("rejects a complete pair when cleanup fails", { skip: process.getuid?.() === 0 }, (t) => {
  const { root, ready, env } = fixture(t);
  writeFileSync(join(ready, "secret"), "dummy-secret");
  chmodSync(root, 0o500);
  assert.throws(() => loadConfig(env), /Could not remove/);
});

test("rejects a mixed source and preserves the original environment mode", (t) => {
  const { env } = fixture(t);
  assert.throws(() => loadConfig({ ...env, BYBIT_API_SECRET: "" }), /Invalid protected credential configuration/);
  const config = loadConfig({ BYBIT_API_KEY: " old-key ", BYBIT_API_SECRET: " old-secret " });
  assert.equal(config.bybitApiKey, "old-key");
  assert.equal(config.bybitApiSecret, "old-secret");
});

test("protected credentials do not authorize Mainnet trading", (t) => {
  const { ready, env } = fixture(t);
  writeFileSync(join(ready, "secret"), "dummy-secret");
  const config = loadConfig({
    ...env, BYBIT_ENV: "mainnet", ABI_DRY_RUN: "false", ABI_LIVE_TRADING_ENABLED: "true",
  });
  assert.equal(getLiveExecutionMode(config).canExecuteLive, false);
});
