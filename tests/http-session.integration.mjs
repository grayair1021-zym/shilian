import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
const base = 'http://127.0.0.1:18787';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: '18787', HOST: '127.0.0.1' }, stdio: 'ignore',
});
const client = new Client({ name: 'session-integration', version: '1' });
let ws;
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: {
  'Content-Type': 'application/json', ...(token ? { 'X-Field-Token': token } : {}),
}, body: JSON.stringify(body) });
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (server.exitCode !== null) throw Error('Test server exited');
    try { ready = (await fetch(base + '/health')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready);
  const first = await (await post('/api/runs', { seed: 'session-integration', difficulty: 'light' })).json();
  const request = { roundId: first.roundId, requestId: 'http-retry', action: { t: 'wait' } };
  const fieldPath = `/api/runs/${first.runId}/field/action`;
  const executed = await (await post(fieldPath, request, first.fieldToken)).json();
  const retried = await (await post(fieldPath, request, first.fieldToken)).json();
  assert.equal(executed.ok, true); assert.equal(retried.ok, true);
  assert.equal(retried.state.turn, first.state.turn + 1);
  assert.equal(retried.revision, executed.revision);
  assert.equal((await post('/api/runs', { difficulty: 'impossible' })).status, 400);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const call = (name, args) => client.callTool({ name, arguments: args });
  ws = new WebSocket(`ws://127.0.0.1:18787/ws?run=${first.runId}&token=${first.fieldToken}`);
  const frames = [];
  ws.on('message', data => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  assert.equal((await post(`/api/runs/${first.runId}/restart`, {})).status, 403);
  const restart = await (await post(`/api/runs/${first.runId}/restart`, { seed: 'again' }, first.fieldToken)).json();
  assert.equal(restart.runId, first.runId); assert.notEqual(restart.roundId, first.roundId);
  const staleField = await (await post(fieldPath, { ...request, requestId: 'stale-field' }, first.fieldToken)).json();
  assert.equal(staleField.ok, false); assert.equal(staleField.state.turn, 1);
  assert.equal((await post(`/api/runs/${first.runId}/operator/action`, { roundId: first.roundId, action: { t: 'scan', room: 1 } }, first.fieldToken)).status, 409);
  const old = await call('operator_say', { run_id: first.runId, round_id: first.roundId, text: 'stale' });
  assert.equal(old.isError, true);
  const fresh = await call('operator_say', { run_id: first.runId, round_id: restart.roundId, text: 'current' });
  assert.equal(fresh.isError, false);
  await delay(30);
  assert.ok(frames.some(f => f.roundId === restart.roundId && f.runId === first.runId));
  const snapshot = frames.findLast(f => f.type === 'sync' && f.roundId === restart.roundId);
  assert.ok(Array.isArray(snapshot.state.fieldInteractions));
  assert.equal(typeof snapshot.state.fieldAttackAvailable, 'boolean');
  assert.equal((await post('/api/runs', { replaceRunId: first.runId, replaceToken: 'wrong' })).status, 403);
  const next = await (await post('/api/runs', { seed: 'replacement', replaceRunId: first.runId, replaceToken: first.fieldToken })).json();
  assert.equal((await call('game_status', { run_id: first.runId })).isError, true);
  const status = await call('game_status', {});
  assert.equal(status.structuredContent.runId, next.runId);
  ws.send(JSON.stringify({ type: 'field_action', id: 'retired-action', action: { t: 'wait' } }));
  await delay(30);
  assert.ok(frames.some(f => f.type === 'action_result' && f.id === 'retired-action' && f.ok === false));
  assert.equal((await post(`/api/runs/${next.runId}/leave`, {})).status, 403);
  assert.equal((await post(`/api/runs/${next.runId}/leave`, {}, next.fieldToken)).status, 200);
  assert.equal((await call('game_status', {})).isError, true);
  const recovered = await (await post('/api/runs', { seed: 'after-restart', replaceRunId: 'NOTFOUND', replaceToken: 'obsolete' })).json();
  assert.ok(recovered.runId);
  assert.equal((await post(`/api/runs/${recovered.runId}/leave`, {}, recovered.fieldToken)).status, 200);
  console.log('PASS HTTP/MCP/WebSocket: restart identity, round rejection, same-round write, authenticated replacement, old socket rejection, authenticated leave.');
} finally {
  ws?.terminate(); await client.close(); server.kill('SIGTERM');
}
