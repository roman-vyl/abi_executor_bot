import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { runBybitGetAttempt } from "../../src/exchange/bybitGetAttempt.js";
import { RestBybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

for (const stall of ["headers", "body"] as const) {
  test(`localhost ${stall} stall times out twice through the real GET adapter`, async t => {
    let calls = 0;
    const server = createServer((_q, r) => {
      calls++;
      if (stall === "body") { r.writeHead(200, { "content-type": "application/json" }); r.flushHeaders(); r.write("{"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const adapter = new RestBybitAdapter(makeTestConfig({ bybitReadTimeoutMs: 150 }), {
      credentialsSource: { credentials: () => undefined }, baseUrl: `http://127.0.0.1:${port}`,
    });
    t.after(async () => { adapter.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
    await assert.rejects(adapter.getServerTime(), (e: Error) => e.name === "TimeoutError");
    assert.equal(calls, 2);
    assert.equal(adapter.takeConnectionCounters().getRetriesTimeout, 1);
  });
}

test("a GET waiting for a pooled connection still expires without disturbing the holder", async t => {
  let dispatched = 0;
  const server = createServer((_q, r) => { dispatched++; r.writeHead(200); r.flushHeaders(); r.write("{"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const agent = new Agent({ connections: 1 });
  const holder = new AbortController();
  t.after(async () => { holder.abort(); await agent.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  await undiciFetch(url, { dispatcher: agent, signal: holder.signal });
  await assert.rejects(runBybitGetAttempt(async signal => await undiciFetch(url, { dispatcher: agent, signal }) as unknown as Response, 50, () => ({})), (e: Error) => e.name === "TimeoutError");
  assert.equal(dispatched, 1); assert.equal(holder.signal.aborted, false);
});
