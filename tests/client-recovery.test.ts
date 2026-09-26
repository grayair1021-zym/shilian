import assert from 'node:assert/strict';
import test from 'node:test';
import { createRun, getRun, dropRun, doFieldRequest, fieldViewOf } from '../server/runs';

async function exercise(lostResponses: number) {
  const keys = ['fetch', 'location', 'window', 'sessionStorage', 'WebSocket'] as const;
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const set = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { runId, fieldToken } = createRun({ seed: 'client-retry' }); const run = getRun(runId)!;
  run.state.entity.exists = false;
  const bodies: { requestId: string; action: { t: string } }[] = [];
  let failed = 0;
  set('location', { protocol: 'http:', hostname: 'localhost' });
  set('window', { setTimeout, clearTimeout });
  set('sessionStorage', { getItem: () => null });
  set('WebSocket', class { close() {} });
  set('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/runs')) return new Response(JSON.stringify({ ...fieldViewOf(run), fieldToken }));
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const result = doFieldRequest(run, body);
    if (failed++ < lostResponses) throw new TypeError('Simulated response lost after commit');
    return new Response(JSON.stringify({ ...result, ...fieldViewOf(run) }));
  });
  const { OnlineClient } = await import('../src/net/client');
  const client = new OnlineClient('http://localhost:8787', { onSync() {}, onPresence() {}, onStatus() {} });
  try {
    await client.createRun('client-retry', 'light');
    const turn = run.state.turn;
    if (lostResponses === 1) {
      const result = await client.fieldAction({ t: 'wait' });
      assert.equal(result.ok, true);
      assert.equal(result.sync?.state.turn, turn + 1);
    } else {
      await assert.rejects(client.fieldAction({ t: 'wait' }));
      const room = run.state.rooms.find(r => r.id === run.state.player.room)!;
      assert.equal(room.searched, false);
      const recovery = await client.fieldAction({ t: 'search' });
      assert.equal(recovery.ok, false);
      assert.match(recovery.message, /当前点击没有额外执行/);
      assert.equal(room.searched, false);
      assert.equal(recovery.sync?.state.turn, turn + 1);
    }
    assert.equal(run.state.turn, turn + 1);
    assert.equal(new Set(bodies.map(body => body.requestId)).size, 1);
    assert.ok(bodies.every(body => body.action.t === 'wait'));
  } finally {
    client.close(); dropRun(runId);
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('客户端响应丢失后以同一编号重发，不重复扣回合', () => exercise(1));
test('连续两次丢失确认后，下次点击先核实旧请求，不额外执行新动作', () => exercise(2));
