// No exchange connections/credentials. Run in the ABI runtime image with an
// isolated bind-mounted consistent snapshot. Never point at the working DB.
import { copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { ExchangeFactsStore } from '../../dist/exchangeFacts/exchangeFactsStore.js';
import { ExchangeStreamRecorder } from '../../dist/exchangeStream/exchangeStreamRecorder.js';
import { captureFirstFill, FIRST_FILL_READ_LIMIT } from '../../dist/services/firstFill/verifiedFirstFill.js';

const [snapshot, output, secondsText = '20', onlyPhase] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!snapshot || !output || !Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw Error('snapshot, output, seconds 1..120, optional phase required');
const phases = ['rest_success', 'fallback_small', 'fallback_near_limit', 'fallback_at_limit'];
if (onlyPhase && !phases.includes(onlyPhase)) throw Error('unknown phase');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = a => {
  a.sort((x, y) => x-y);
  return { samples: a.length, ...Object.fromEntries([['p50',.5],['p95',.95],['p99',.99],['max',1]].map(([k,p]) => [k, a.length ? +a[Math.min(a.length-1,Math.ceil(a.length*p)-1)].toFixed(4) : null])) };
};
const report = { runtime: process.version, arch: process.arch, snapshotBytes: statSync(snapshot).size,
  secondsPerPhase: seconds, requestRate: 20, wsFramesPerSecond: 20, executionsPerFrame: 5,
  readLimit: FIRST_FILL_READ_LIMIT, flushIntervalMs: 1000,
  caveat: 'First request is connection-cold; host/VM filesystem caches are not evicted. captureMs includes immediate fake REST and is a conservative upper bound on full verifier time, not WAN latency. Synthetic local WS; no WAN latency. No production database opened.', phases: [] };
for (const phase of onlyPhase ? [onlyPhase] : phases) {
  const dbPath = join(output, phase + '.sqlite3');
  copyFileSync(snapshot, dbPath);
  const store = ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: 'demo', category: 'linear' });
  const count = phase === 'fallback_near_limit' ? FIRST_FILL_READ_LIMIT-1 : phase === 'fallback_at_limit' ? FIRST_FILL_READ_LIMIT : 2;
  const id = 'benchmark-' + phase;
  const record = { strategy_instance_id: id, trade_cycle_id: 'cycle', generation: 1, exchange_category: 'linear', exchange_symbol: 'BTCUSDT',
    position_binding_mode: 'one_way', desired_entry: { side: 'long' }, order_link_id: id, first_fill_at_ms: null };
  const proof = { entryTerminal: true, entryOrderId: id, cumulativeFilledQty: String(count) };
  const makeExecution = (orderId, execId, time) => ({ category: 'linear', symbol: 'BTCUSDT', orderId, orderLinkId: orderId,
    side: 'Buy', execType: 'Trade', execId, execTime: String(time), execQty: '1', execPrice: '100000', positionIdx: 0 });
  store.writeLinks([{ kind: 'own', orderId: id, orderLinkId: id, strategyInstanceId: id, tradeCycleId: 'cycle', generation: 1, role: 'entry', evidence: 'own_order_link_id_lookup', establishedAtMs: Date.now() }]);
  store.writeFacts(Array.from({ length: count }, (_, i) => ({ kind: 'execution', source: 'ws', sourceEndpoint: 'ws:execution', receivedAtMs: Date.now(), rawJson: JSON.stringify(makeExecution(id, `${id}-${i}`, 1000+i)) })));
  const readMs=[], linkReadMs=[], factReadMs=[], captureMs=[], receiveMs=[], flushMs=[], writeMs=[];
  const reader = Object.fromEntries(['readLinkForOrder', 'readFactsForOrder'].map(method => [method, (...args) => {
    const start = performance.now();try { return store[method](...args); } finally { const elapsed = performance.now()-start;readMs.push(elapsed);(method === "readLinkForOrder" ? linkReadMs : factReadMs).push(elapsed); }
  }]));
  reader.category = 'linear';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  let peer;
  server.on('connection', socket => {
    peer=socket;socket.on('message', bytes => {
      const m=JSON.parse(bytes.toString());
      if (m.op==='auth' || m.op==='subscribe') socket.send(JSON.stringify({op:m.op,success:true}));
      if (m.op==='ping') socket.send(JSON.stringify({op:'pong'}));
    });
  });
  // Real recorder's dispatch + real store's write batch, with timing-only wrappers.
  const sink = { writeStreamBatch: batch => {
    const start=performance.now();const result=store.writeStreamBatch(batch);writeMs.push(performance.now()-start);
    for (const fact of batch.facts) { const r=JSON.parse(fact.rawJson);if (r.benchmarkSentAt !== undefined) flushMs.push(performance.now()-r.benchmarkSentAt); }
    return result;
  }};
  const recorder = new ExchangeStreamRecorder({ url:`ws://127.0.0.1:${server.address().port}`, credentialsSource:{credentials:()=>({apiKey:'dummy',apiSecret:'dummy'})}, sink, emit:()=>{} });
  recorder.start();
  const deadline=Date.now()+5000;
  while (recorder.status().state!=='subscribed') { if (Date.now()>deadline) throw Error('fake WS failed');await wait(10); }
  // Register after recorder's own handler; same-process monotonic clock.
  recorder.socket?.on('message', bytes => {
    const m=JSON.parse(bytes.toString());for (const r of m.data??[]) if (r.benchmarkSentAt!==undefined) receiveMs.push(performance.now()-r.benchmarkSentAt);
  });
  let seq=0, requests=0, failures=0;
  const wsTimer=setInterval(()=>peer.send(JSON.stringify({topic:'execution',data:Array.from({length:5},()=>({ ...makeExecution('benchmark-ws', `${id}-ws-${seq++}`, Date.now()), benchmarkSentAt:performance.now() }))})),50);
  const bybit={getExecutionList:async()=>({result:{category:'linear',list:phase==='rest_success' ? [{symbol:'BTCUSDT',execType:'Trade',execTime:'1000',execQty:String(count)}] : [],nextPageCursor:''}})};
  const lag=monitorEventLoopDelay({resolution:1});lag.enable();
  const firstStart=performance.now();await captureFirstFill({bybit,record,proof,reader});const firstRequestMs=performance.now()-firstStart;
  const timer=setInterval(async()=>{const start=performance.now();const r=await captureFirstFill({bybit,record,proof,reader});requests++;if (r.kind!==(phase==='fallback_at_limit'?'no_executions_found':'found')) failures++;captureMs.push(performance.now()-start);},50);
  await wait(seconds*1000);clearInterval(timer);clearInterval(wsTimer);await wait(1100);
  lag.disable();recorder.stop();peer?.terminate();await new Promise(resolve=>server.close(resolve));
  const status=recorder.status();
  store.close();
  report.phases.push({phase,firstRequestMs,requests,failures,readMs:summary(readMs),linkReadMs:summary(linkReadMs),factReadMs:summary(factReadMs),captureMs:summary(captureMs),
    eventLoopMs:{p50:lag.percentile(50)/1e6,p95:lag.percentile(95)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6},
    wsReceiveMs:summary(receiveMs),wsFlushMs:summary(flushMs),batchWriteMs:summary(writeMs),
    sent:seq,received:status.receivedRecords,dropped:status.droppedRecords,backlog:status.bufferedRecords,finalDbBytes:statSync(dbPath).size});
  if (phase==='rest_success' && readMs.length) throw Error('baseline touched SQLite verifier');
}
writeFileSync(join(output,'metrics.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
