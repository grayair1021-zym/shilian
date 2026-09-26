import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp';
import { createRun, getRun, restartRun, retireRun, dropRun, doFieldAction, operatorViewOf, fieldViewOf } from '../server/runs';
import { createGame } from '../src/game/generator';
import { operatorDroneAttack, advance } from '../src/game/engine';

function fixture(seed: string) {
  const s = createGame(seed, 'unstable', 'coop');
  s.departureGrace = undefined;
  s.entity.exists = true; s.entity.room = s.drone.room;
  s.power = 100; s.drone.charge = 100;
  for (const r of s.rooms) r.hazard = null;
  for (const z of Object.values(s.zones)) z.unstable = false;
  return s;
}

test('错误舱室与默认目标不会隔舱命中或自动追踪真实位置', () => {
  for (let i = 0; i < 20; i++) {
    const s = fixture('wrong-' + i);
    s.entity.room = s.rooms.find(r => r.id !== s.drone.room)!.id;
    const vitality = s.entity.vitality; const turn = s.turn;
    const result = operatorDroneAttack(s);
    assert.equal(result.ok, true); assert.equal(result.turns, 1);
    assert.equal(s.entity.vitality, vitality); assert.equal(s.turn, turn + 1);
    assert.ok(result.receipt.includes('未确认命中')); assert.ok(s.power < 100);
  }
});

test('不可达目标与非法舱室不耗资源', () => {
  const s = fixture('blocked');
  for (const d of Object.values(s.doors)) d.status = 'locked';
  const target = s.rooms.find(r => r.id !== s.drone.room)!.id;
  const before = JSON.stringify(s);
  assert.equal(operatorDroneAttack(s, target).ok, false);
  assert.equal(operatorDroneAttack(s, 999).ok, false);
  assert.equal(JSON.stringify(s), before);
});

test('累积伤势延长未来安全窗口，重创只掉一次物资', () => {
  const s = fixture('injury');
  let hits = 0; let previousRest = 0;
  for (let i = 0; i < 25 && hits < 3; i++) {
    s.drone.lost = false; s.drone.charge = 100; s.power = 100;
    s.drone.room = s.entity.room;
    const before = s.entity.vitality;
    operatorDroneAttack(s, s.entity.room);
    if (s.entity.vitality < before) {
      hits++;
      assert.ok(s.entity.stunnedTurns > previousRest);
      previousRest = s.entity.stunnedTurns;
    }
  }
  assert.equal(hits, 3); assert.equal(s.entity.vitality, 0);
  assert.ok(s.entity.salvageDropped); assert.equal(s.entity.stunnedTurns, 10);
  const batteries = s.rooms.flatMap(r => r.items).filter(x => x === 'battery').length;
  s.drone.room = s.entity.room; s.drone.lost = false; s.power = 100;
  operatorDroneAttack(s);
  assert.equal(s.rooms.flatMap(r => r.items).filter(x => x === 'battery').length, batteries);
  const room = s.entity.room;
  const rest = s.entity.stunnedTurns;
  for (let i = 0; i < rest; i++) { advance(s, 1); assert.equal(s.entity.room, room); }
  assert.ok(s.entity.vitality >= 35);
});

test('隐藏伤势不通过现场或远程视图泄漏', () => {
  const { runId } = createRun({ seed: 'privacy' }); const run = getRun(runId)!;
  try {
    run.state.entity.vitality = 13; run.state.entity.salvageDropped = true;
    assert.equal(fieldViewOf(run).state.entity.vitality, 0);
    assert.equal(fieldViewOf(run).state.entity.salvageDropped, false);
    assert.equal('entity' in operatorViewOf(run), false);
    assert.ok(!JSON.stringify(operatorViewOf(run)).includes('vitality'));
  } finally { dropRun(runId); }
});

test('MCP 拒绝旧轮、缺少轮次和错误目标；落空回执仍确认执行', async () => {
  const { runId } = createRun({ seed: 'mcp-safety' }); const run = getRun(runId)!;
  const client = new Client({ name: 'combat-test', version: '1' }); const server = createMcpServer();
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    const oldRound = run.roundId; restartRun(run);
    assert.notEqual(oldRound, run.roundId);
    const startTurn = run.state.turn;
    for (const round_id of [undefined, oldRound]) {
      const result = await call('operator_scan', { run_id: runId, round_id, area: '1' });
      assert.equal(result.isError, true); assert.equal(run.state.turn, startTurn);
    }
    const writes: [string, Record<string, unknown>][] = [
      ['operator_say', { text: 'test' }], ['operator_ping', { target: '1', kind: 'note' }],
      ['operator_scan', { area: '1' }], ['operator_door', { door_id: 'A1', action: 'unlock' }],
      ['operator_power', { zone_id: 'A', action: 'on' }], ['operator_trace', {}],
      ['operator_drone', { target: '1' }], ['operator_drone_attack', {}],
    ];
    for (const [name, args] of writes) {
      const result = await call(name, { ...args, run_id: runId, round_id: oldRound });
      assert.equal(result.isError, true, name); assert.equal(run.state.turn, startTurn);
    }
    const common = { run_id: runId, round_id: run.roundId };
    const bad = await call('operator_drone_attack', { ...common, target: '不存在的舱室' });
    assert.equal(bad.isError, true); assert.equal(run.state.turn, startTurn);
    run.state.entity.exists = false; run.state.power = 100;
    const miss = await call('operator_drone_attack', common);
    assert.equal(miss.isError, false);
    assert.equal((miss.structuredContent as { confirmation: { executed: boolean } }).confirmation.executed, true);
    assert.equal(run.state.turn, startTurn + 1);
    retireRun(run);
    assert.equal((await call('operator_say', { ...common, text: 'old' })).isError, true);
    assert.equal(doFieldAction(run, { t: 'wait' }).ok, false);
  } finally { await client.close(); await server.close(); dropRun(runId); }
});

test('多局时不能静默选择最新局，离开旧局后只能连接剩余局', () => {
  const a = createRun({ seed: 'a' }); const b = createRun({ seed: 'b' });
  try {
    assert.equal(getRun(), null);
    retireRun(getRun(a.runId)!);
    assert.equal(getRun(a.runId), null);
    assert.equal(getRun()?.id, b.runId);
  } finally { dropRun(a.runId); dropRun(b.runId); }
});
