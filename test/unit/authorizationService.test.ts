import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AuthorizationService,
  type Credentials,
  type VerificationResult,
} from "../../src/authorization/authorizationService.js";

const first = { apiKey: "first-key", apiSecret: "first-secret" };
const second = { apiKey: "second-key", apiSecret: "second-secret" };

function deferredCheck() {
  let finish!: (result: VerificationResult) => void;
  const result = new Promise<VerificationResult>((resolve) => { finish = resolve; });
  return { result, finish };
}

test("starts locked without exposing credentials or invoking the verifier", async () => {
  let calls = 0;
  const service = new AuthorizationService(async () => { calls++; return "accepted"; });
  assert.equal(service.status(), "LOCKED");
  assert.equal(service.credentials(), undefined);
  assert.equal(await service.retry(), "no_candidate");
  assert.equal(calls, 0);
});

test("accepted verification authorizes exactly the immutable copied candidate", async () => {
  const original = { ...first };
  let received: Credentials | undefined;
  const check = deferredCheck();
  const service = new AuthorizationService(async (pair) => {
    received = pair;
    return check.result;
  });

  const attempt = service.authorize(original);
  assert.equal(service.status(), "VERIFYING");
  assert.equal(service.credentials(), undefined);
  assert.notEqual(received, original);
  assert.equal(Object.isFrozen(received), true);
  original.apiKey = "changed-by-caller";
  original.apiSecret = "changed-by-caller";
  assert.deepEqual(received, first);

  check.finish("accepted");
  assert.equal(await attempt, "accepted");
  assert.equal(service.status(), "AUTHORIZED");
  assert.equal(service.credentials(), received);
  assert.deepEqual(service.credentials(), first);

  const confirmed = service.credentials()!;
  assert.equal(Reflect.set(confirmed, "apiKey", "changed"), false);
  assert.equal(Reflect.set(confirmed, "apiSecret", "changed"), false);
  assert.equal(Reflect.deleteProperty(confirmed, "apiSecret"), false);
  assert.deepEqual(service.credentials(), first);
});

test("rejection discards the candidate and permits a different attempt", async () => {
  const received: Credentials[] = [];
  const service = new AuthorizationService(async (pair) => {
    received.push(pair);
    return received.length === 1 ? "rejected" : "accepted";
  });
  assert.equal(await service.authorize(first), "rejected");
  assert.equal(service.status(), "LOCKED");
  assert.equal(service.credentials(), undefined);
  assert.equal(await service.retry(), "no_candidate");
  assert.equal(received.length, 1);

  assert.equal(await service.authorize(second), "accepted");
  assert.deepEqual(received, [first, second]);
  assert.deepEqual(service.credentials(), second);
});

test("temporary failure retains one candidate exclusively for retry", async () => {
  const received: Credentials[] = [];
  const service = new AuthorizationService(async (pair) => {
    received.push(pair);
    return received.length === 1 ? "temporary_failure" : "accepted";
  });
  assert.equal(await service.authorize(first), "temporary_failure");
  assert.equal(service.status(), "RETRY_PENDING");
  assert.equal(service.credentials(), undefined);
  assert.equal(await service.authorize(second), "retry_required");
  assert.equal(received.length, 1);
  assert.equal(await service.retry(), "accepted");
  assert.equal(received[0], received[1]);
  assert.deepEqual(service.credentials(), first);
});

test("concurrent authorize and retry calls never replace the active candidate", async () => {
  const firstCheck = deferredCheck();
  const retryCheck = deferredCheck();
  const received: Credentials[] = [];
  const service = new AuthorizationService(async (pair) => {
    received.push(pair);
    return received.length === 1 ? firstCheck.result : retryCheck.result;
  });

  const attempt = service.authorize(first);
  assert.equal(await service.authorize(second), "busy");
  assert.equal(await service.retry(), "busy");
  assert.equal(received.length, 1);

  firstCheck.finish("temporary_failure");
  assert.equal(await attempt, "temporary_failure");
  assert.equal(await service.authorize(second), "retry_required");

  const retry = service.retry();
  assert.equal(service.status(), "VERIFYING");
  assert.equal(await service.retry(), "busy");
  assert.equal(await service.authorize(second), "busy");
  assert.equal(received[0], received[1]);

  retryCheck.finish("accepted");
  assert.equal(await retry, "accepted");
  assert.deepEqual(service.credentials(), first);
});

test("authorized credentials cannot be replaced by authorize or retry", async () => {
  let calls = 0;
  const service = new AuthorizationService(async () => { calls++; return "accepted"; });
  await service.authorize(first);
  const confirmed = service.credentials();
  assert.equal(await service.authorize(second), "already_authorized");
  assert.equal(await service.retry(), "already_authorized");
  assert.equal(service.credentials(), confirmed);
  assert.equal(calls, 1);
});

test("a rejected retry discards the saved candidate", async () => {
  let calls = 0;
  const service = new AuthorizationService(async () => {
    calls++;
    return calls === 1 ? "temporary_failure" : "rejected";
  });
  await service.authorize(first);
  assert.equal(await service.retry(), "rejected");
  assert.equal(service.status(), "LOCKED");
  assert.equal(service.credentials(), undefined);
  assert.equal(await service.retry(), "no_candidate");
  assert.equal(calls, 2);
});

test("a throwing verifier retains the candidate without exposing its error", async () => {
  let calls = 0;
  const service = new AuthorizationService(async () => {
    calls++;
    if (calls === 1) throw new Error("possibly secret error");
    return "accepted";
  });
  assert.equal(await service.authorize(first), "temporary_failure");
  assert.equal(service.status(), "RETRY_PENDING");
  assert.equal(service.credentials(), undefined);
  assert.equal(await service.retry(), "accepted");
  assert.deepEqual(service.credentials(), first);
});

test("a synchronously throwing verifier leaves no stuck active attempt", async () => {
  const service = new AuthorizationService(() => { throw new Error("failure"); });
  assert.equal(await service.authorize(first), "temporary_failure");
  assert.equal(await service.retry(), "temporary_failure");
  assert.equal(service.status(), "RETRY_PENDING");
});

test("reentrant verification observes the in-flight check", async () => {
  let service: AuthorizationService;
  service = new AuthorizationService(async () => {
    assert.equal(await service.authorize(second), "busy");
    assert.equal(await service.retry(), "busy");
    return "accepted";
  });
  assert.equal(await service.authorize(first), "accepted");
  assert.deepEqual(service.credentials(), first);
});

test("unexpected verifier results cannot authorize a candidate", async () => {
  const service = new AuthorizationService(async () => "unexpected" as VerificationResult);
  assert.equal(await service.authorize(first), "temporary_failure");
  assert.equal(service.credentials(), undefined);
  assert.equal(service.status(), "RETRY_PENDING");
});

test("invalid credential fields fail before calling the verifier", async () => {
  let calls = 0;
  const service = new AuthorizationService(async () => { calls++; return "accepted"; });
  for (const candidate of [
    { apiKey: "", apiSecret: "secret" },
    { apiKey: "key", apiSecret: "" },
    { apiKey: 123, apiSecret: "secret" } as unknown as Credentials,
  ]) {
    await assert.rejects(service.authorize(candidate), TypeError);
    assert.equal(service.status(), "LOCKED");
    assert.equal(await service.retry(), "no_candidate");
  }
  assert.equal(calls, 0);
});

test("AuthorizationService has no runtime, network or trading subsystem imports", async () => {
  const source = await readFile(new URL("../../src/authorization/authorizationService.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:import|require)\s*(?:\(|[{*'"])/);
  assert.doesNotMatch(source, /process\.env/);
});
