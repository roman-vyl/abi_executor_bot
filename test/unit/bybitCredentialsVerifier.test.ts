import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AuthorizationService } from "../../src/authorization/authorizationService.js";
import { createBybitCredentialsVerifier, type VerificationPolicy } from "../../src/authorization/bybitCredentialsVerifier.js";
const policy: VerificationPolicy = { environment: "demo", expectedUid: "123", category: "linear", recvWindow: "5000" };
const pair = { apiKey: "key", apiSecret: "secret" };
const good = () => ({ retCode: 0, result: { apiKey: "key", userID: 123, readOnly: 0, permissions: { ContractTrade: ["Order", "Position"], Spot: ["SpotTrade"] } } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function transport(body: unknown, status = 200): typeof fetch { return async () => response(body, status); }

test("verifier uses one fixed read-only signed request and real validation for linear and spot", async () => {
  for (const environment of ["demo", "testnet", "mainnet"] as const) {
  for (const category of ["linear", "spot"] as const) {
    let calls = 0;
    const verifier = createBybitCredentialsVerifier({ ...policy, category, environment }, { fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), `https://${{ demo: "api-demo.bybit.com", testnet: "api-testnet.bybit.com", mainnet: "api.bybit.com" }[environment]}/v5/user/query-api`);
      assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); assert.equal(init?.redirect, "error");
      const h = new Headers(init?.headers);
      assert.equal(h.get("X-BAPI-SIGN"), createHmac("sha256", pair.apiSecret).update(`${h.get("X-BAPI-TIMESTAMP")}key5000`).digest("hex"));
      return response(good());
    } });
    const service = new AuthorizationService(verifier.verify);
    assert.equal(await service.authorize(pair), "accepted");
    assert.deepEqual(service.credentials(), pair);
    assert.equal(calls, 1); verifier.close();
  }
  }
});

for (const [name, mutate, expected] of [
  ["UID mismatch", (b: any) => { b.result.userID = 124; }, "rejected"],
  ["read-only", (b: any) => { b.result.readOnly = 1; }, "rejected"],
  ["missing right", (b: any) => { b.result.permissions.ContractTrade = ["Order"]; }, "rejected"],
  ["missing group", (b: any) => { delete b.result.permissions.ContractTrade; }, "temporary_failure"],
  ["unsafe UID", (b: any) => { b.result.userID = Number.MAX_SAFE_INTEGER + 1; }, "temporary_failure"],
  ["string UID", (b: any) => { b.result.userID = "123"; }, "temporary_failure"],
  ["string readOnly", (b: any) => { b.result.readOnly = "0"; }, "temporary_failure"],
  ["inconsistent key", (b: any) => { b.result.apiKey = "other"; }, "temporary_failure"],
  ["malformed rights", (b: any) => { b.result.permissions.ContractTrade = ["Order", 1]; }, "temporary_failure"],
  ["missing result", (b: any) => { delete b.result; }, "temporary_failure"],
] as const) {
  test(`verifier classifies ${name}`, async () => {
    const body = good(); mutate(body);
    const verifier = createBybitCredentialsVerifier({ ...policy, environment: "mainnet" }, { fetch: transport(body) });
    try { assert.equal(await verifier.verify(pair), expected); } finally { verifier.close(); }
  });
}

for (const code of [10003, 10005, 10007, -2015, 33004, 10004, 10002, -1, 10010, 10000, 10006, 10016, 99999]) {
  test(`Bybit retCode ${code} has deterministic classification`, async () => {
    const verifier = createBybitCredentialsVerifier(policy, { fetch: transport({ retCode: code }) });
    try { assert.equal(await verifier.verify(pair), [10003, 10005, 10007, -2015, 33004].includes(code) ? "rejected" : "temporary_failure"); }
    finally { verifier.close(); }
  });
}
for (const status of [403, 429, 500, 503, 302]) {
  test(`HTTP ${status} cannot reject the pair based on a misleading body`, async () => {
    const verifier = createBybitCredentialsVerifier(policy, { fetch: transport({ retCode: 10003 }, status) });
    try { assert.equal(await verifier.verify(pair), "temporary_failure"); }
    finally { verifier.close(); }
  });
}

test("malformed, oversized and invalid UTF8 responses fail closed", async () => {
  for (const body of ["not-json", " ".repeat(65537), new Uint8Array([255])]) {
    const verifier = createBybitCredentialsVerifier(policy, { fetch: async () => new Response(body) });
    try { assert.equal(await verifier.verify(pair), "temporary_failure"); } finally { verifier.close(); }
  }
});
test("invalid policy fails before any network call", () => {
  for (const override of [{ expectedUid: "" }, { expectedUid: "01" }, { environment: "invalid" }, { category: "option" }, { recvWindow: "" }]) {
    assert.throws(() => createBybitCredentialsVerifier({ ...policy, ...override } as VerificationPolicy), /policy/);
  }
});
test("timeout frees VERIFYING, preserves candidate and explicit retry succeeds; late response is ignored", async () => {
  let late: (value: Response) => void = () => undefined;
  let calls = 0;
  let signal: AbortSignal | undefined;
  const verifier = createBybitCredentialsVerifier(policy, { timeoutMs: 15, fetch: async (_url, init) => {
    signal = init?.signal ?? undefined;
    calls++;
    return calls === 1 ? new Promise(resolve => { late = resolve; }) : response(good());
  } });
  const auth = new AuthorizationService(verifier.verify);
  assert.equal(await auth.authorize(pair), "temporary_failure");
  assert.equal(signal?.aborted, true);
  assert.equal(auth.status(), "RETRY_PENDING"); assert.equal(auth.credentials(), undefined);
  late(response(good())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(auth.status(), "RETRY_PENDING");
  assert.equal(await auth.retry(), "accepted"); verifier.close();
});
test("shutdown cancels a hung verification and consumes late success and failure", async () => {
  for (const rejectLate of [false, true]) {
    let resolveLate: (value: Response) => void = () => undefined;
    let failLate: (error: Error) => void = () => undefined;
    const stop = new AbortController();
    const verifier = createBybitCredentialsVerifier(policy, { signal: stop.signal, fetch: async () => new Promise((resolve, reject) => { resolveLate = resolve; failLate = reject; }) });
    const auth = new AuthorizationService(verifier.verify);
    const pending = auth.authorize(pair); stop.abort();
    assert.equal(await pending, "temporary_failure");
    if (rejectLate) failLate(new Error("secret must not escape")); else resolveLate(response(good()));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(auth.status(), "RETRY_PENDING"); assert.equal(auth.credentials(), undefined);
    assert.equal(await auth.retry(), "temporary_failure"); verifier.close();
  }
});
test("deadline includes a hung response body and cancels its reader", async () => {
  let cancelled = false;
  const verifier = createBybitCredentialsVerifier(policy, { timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  assert.equal(await verifier.verify(pair), "temporary_failure");
  assert.equal(cancelled, true); verifier.close();
});
test("testnet host is fixed; transport failure is temporary and never retried", async () => {
  let calls = 0;
  const verifier = createBybitCredentialsVerifier({ ...policy, environment: "testnet" }, { fetch: async url => {
    assert.equal(url, "https://api-testnet.bybit.com/v5/user/query-api"); calls++; throw new Error("VPN secret");
  } });
  assert.equal(await verifier.verify(pair), "temporary_failure"); assert.equal(calls, 1); verifier.close();
});
