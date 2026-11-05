import assert from "node:assert/strict";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { createAuthorizationSocket } from "../../src/authorization/authorizationSocket.js";
import { decodeControlFrame } from "../../src/authorization/credentialProtocol.js";
import { relayCredentials } from "../../src/authorization/credentialRelay.js";
const policy = { environment: "demo", expectedUid: "123", category: "linear", recvWindow: "5000" } as const;
const good = () => new Response(JSON.stringify({ retCode: 0, result: { apiKey: "key", userID: 123, readOnly: 0, permissions: { ContractTrade: ["Order", "Position"] } } }));
const frame = (op: string, extra = {}) => Buffer.from(JSON.stringify({ v: 1, op, ...extra }) + "\n");
async function* input(buffer: Buffer) { yield buffer; }
async function fixture(options: Parameters<typeof createAuthorizationSocket>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "abi-auth-"));
  const path = join(directory, "control.sock");
  const handle = await createAuthorizationSocket({ path, policy }, { fetch: async () => good(), ...options });
  return { path, directory, ...handle, cleanup: async () => { await handle.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function raw(path: string, chunks: Buffer[], end = true) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(path); let text = "";
    socket.on("error", reject); socket.on("data", value => { text += value; }); socket.on("close", () => resolve(text));
    socket.once("connect", () => { for (const chunk of chunks) socket.write(chunk); if (end) socket.end(); });
  });
}

test("socket authorizes with real verifier, handles retry/status and protects confirmed pair", async () => {
  let calls = 0;
  const f = await fixture({ fetch: async () => { calls++; if (calls === 1) throw new Error("secret"); return good(); } });
  const send = async (request: Buffer) => JSON.parse(await relayCredentials(input(request), f.path));
  try {
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    assert.equal((await send(frame("status"))).state, "LOCKED");
    const secretFrame = frame("authorize", { credentials: ["key", "secret"] });
    assert.equal((await send(secretFrame)).result, "temporary_failure");
    assert.ok(secretFrame.every(byte => byte === 0));
    assert.equal((await send(frame("retry"))).result, "accepted");
    assert.equal((await send(frame("authorize", { credentials: ["other", "other"] }))).result, "already_authorized");
    assert.deepEqual(f.authorization.credentials(), { apiKey: "key", apiSecret: "secret" });
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

for (const bad of [
  Buffer.from('{"v":1,"op":"authorize","credentials":["key"]}\n'),
  Buffer.from('{"v":1,"op":"retry","credentials":["key","secret"]}\n'),
  Buffer.from('{"v":1,"op":"status","unknown":true}\n'),
  Buffer.from('{"v":1,"op":"status"}'),
  Buffer.from('{"v":1,"op":"status"}\n{}\n'),
  Buffer.from([255, 10]), Buffer.alloc(4097, 65),
]) {
  test(`invalid frame fails before verifier (${bad.toString("hex").slice(0, 20)}, ${bad.length})`, async () => {
    assert.throws(() => decodeControlFrame(bad));
    let calls = 0;
    const f = await fixture({ fetch: async () => { calls++; return good(); } });
    try { await raw(f.path, [bad]); assert.equal(calls, 0); assert.equal(f.authorization.status(), "LOCKED"); }
    finally { await f.cleanup(); }
  });
}

test("split chunks are accepted only after LF and EOF", async () => {
  let calls = 0;
  const f = await fixture({ fetch: async () => { calls++; return good(); } });
  const request = frame("authorize", { credentials: ["key", "secret"] });
  try {
    const socket = connect(f.path);
    await new Promise<void>(resolve => socket.once("connect", resolve));
    let text = ""; socket.on("data", data => { text += data; });
    socket.write(request.subarray(0, 12)); socket.write(request.subarray(12));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    socket.end(); await new Promise(resolve => socket.once("close", resolve));
    assert.equal(JSON.parse(text).result, "accepted"); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});
test("slow sender has absolute deadline and competing connection receives busy", async () => {
  const f = await fixture({ frameTimeoutMs: 30 });
  const first = connect(f.path);
  try {
    await new Promise<void>(resolve => first.once("connect", resolve));
    first.write("{");
    assert.equal(JSON.parse(await raw(f.path, [frame("status")])).result, "busy");
    await new Promise(resolve => first.once("close", resolve));
    assert.equal(f.authorization.status(), "LOCKED");
  } finally { first.destroy(); await f.cleanup(); }
});
test("shutdown cancels in-flight verification and a late accepted response cannot authorize", async () => {
  let late: (value: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture({ fetch: async () => { started(); return new Promise(resolve => { late = resolve; }); } });
  try {
    const pending = raw(f.path, [frame("authorize", { credentials: ["key", "secret"] })]);
    await began; await f.close(); await pending;
    late(good()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.authorization.status(), "RETRY_PENDING"); assert.equal(f.authorization.credentials(), undefined);
  } finally { await f.cleanup(); }
});
test("lost response does not rollback or resubmit a completed candidate", async () => {
  let late: (value: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  let calls = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture({ fetch: async () => { calls++; started(); return new Promise(resolve => { late = resolve; }); } });
  const socket = connect(f.path);
  try {
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.end(frame("authorize", { credentials: ["key", "secret"] }));
    await began; socket.destroy(); late(good());
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.authorization.status(), "AUTHORIZED"); assert.equal(calls, 1);
  } finally { socket.destroy(); await f.cleanup(); }
});
test("existing socket is never replaced", async () => {
  const f = await fixture();
  try {
    await assert.rejects(createAuthorizationSocket({ path: f.path, policy }));
    assert.equal(JSON.parse(await raw(f.path, [frame("status")])).state, "LOCKED");
  } finally { await f.cleanup(); }
});

test("disconnect before EOF never calls verifier", async () => {
  let calls = 0;
  const f = await fixture({ fetch: async () => { calls++; return good(); } });
  const socket = connect(f.path);
  try {
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write('{"v":1,"op":"authorize",');
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 0); assert.equal(f.authorization.status(), "LOCKED");
  } finally { socket.destroy(); await f.cleanup(); }
});
test("relay wipes invalid input and never sends it", async () => {
  const bad = Buffer.from("bad-frame\n");
  await assert.rejects(relayCredentials(input(bad), "/nonexistent/socket"));
  assert.ok(bad.every(byte => byte === 0));
});
