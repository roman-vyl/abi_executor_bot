import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("age delivery rejects failed partial decryption and cleans buffers on every exit", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test/tools", "-p", "test_abi_authorize.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
