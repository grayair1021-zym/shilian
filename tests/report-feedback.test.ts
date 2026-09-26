import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp';
import { createRun, getRun, dropRun, touchOperator } from '../server/runs';
import { createGame } from '../src/game/generator';
import { applyFieldAction, applyOperatorAction } from '../src/game/actions';
import { adjacency, fieldMove, interactOptions, operatorSay, makeReading, advance, decision } from '../src/game/engine';
import { projectField, projectOperator, projectOperatorLog } from '../src/game/views';
import { buildReport } from '../src/game/report';
import { advanceAtmosphere } from '../src/game/atmosphere';
import { RNG } from '../src/game/rng';
import type { RemoteReading } from '../src/game/types';

function fixture(seed = 'report-feedback') {
  const s = createGame(seed, 'light', 'coop');
  s.entity.exists = false;
  s.goals = [];
  for (const r of s.rooms) r.hazard = null;
  for (const z of Object.values(s.zones)) { z.powered = true; z.unstable = false; }
  for (const d of Object.values(s.doors)) { d.status = 'open'; d.braced = false; d.remoteBroken = false; }
  s.power = 100; s.turn = 30;
  return s;
}
function safeScan(turn: number): RemoteReading {
  return { turn, life: false, motion: false, heat: false, hazard: false, fromDrone: false, trustNote: '信号正常' };
}

test('同一次进入合并解锁与扫描依据，不重复计成功', () => {
  const s = fixture(); const { room, door } = adjacency(s, s.player.room)[0];
  door.remoteUnlockTurn = s.turn; room.lastScan = safeScan(s.turn);
  assert.equal(fieldMove(s, room.id), '');
  assert.equal(s.stats.assists, 1);
  assert.equal(s.stats.trustEvents?.length, 1);
  assert.equal(s.stats.trustEvents?.[0].evidence.length, 2);
});

test('失真、过期和采样后变化分别统计；原地等待不重复归因', () => {
  for (const [age, sampleSafe, expected] of [[1, false, 'distorted'], [21, false, 'stale'], [1, true, 'changed']] as const) {
    const s = fixture(); const { room } = adjacency(s, s.player.room)[0];
    room.lastScan = safeScan(s.turn - age);
    s.stats.scanTruth = { [`${room.id}:${room.lastScan.turn}`]: sampleSafe };
    room.hazard = { kind: 'radiation', active: true, isolated: false, visualHidden: false };
    fieldMove(s, room.id);
    assert.equal(s.stats.assists, 0);
    assert.equal(s.stats.trustEvents?.[0].outcome, expected);
    advance(s, 2);
    assert.equal(s.stats.trustEvents?.length, 1);
    assert.equal(buildReport(s).rows.find((r) => r.label === (expected === 'stale' ? '过期安全情报后遇险' : expected === 'distorted' ? '失真安全读数后遇险' : '采样后变化／无法归因'))?.value.startsWith('1 次'), true);
  }
});

test('扫描采样真值仅供结算，双方投影不泄漏', () => {
  const s = fixture(); const room = s.rooms[0];
  room.hazard = { kind: 'radiation', active: true, isolated: false, visualHidden: true };
  room.lastScan = makeReading(s, room, new RNG(42));
  assert.equal(s.stats.scanTruth?.[`${room.id}:${s.turn}`], false);
  assert.ok(!JSON.stringify(projectField(s)).includes('scanTruth'));
  assert.ok(!JSON.stringify(projectOperator(s, 'TEST', false)).includes('scanTruth'));
});

test('核心禁用给出缺电原因；通电后投影立即可用，完成时间不晚一回合', () => {
  const s = fixture(); const room = s.rooms.find((r) => r.feature === 'nav')!;
  assert.ok(room); s.player.room = room.id; room.visited = true;
  s.goals = [{ kind: 'nav_core', title: '安装导航核心', fieldHint: '', remoteHint: '', done: false, doneTurn: null }];
  s.player.inventory.push('navcore'); s.zones[room.zone].powered = false;
  const option = projectField(s).fieldInteractions!.find((o) => o.id === 'nav')!;
  assert.equal(option.enabled, false); assert.match(option.hint, /已携带核心，等待本区供电/);
  assert.match(applyFieldAction(s, { t: 'interact', id: 'nav' }).message, /等待本区供电/);
  s.zones[room.zone].powered = true;
  assert.equal(projectField(s).fieldInteractions!.find((o) => o.id === 'nav')?.enabled, true);
  const turn = s.turn;
  assert.equal(applyFieldAction(s, { t: 'interact', id: 'nav' }).ok, true);
  assert.equal(s.goals[0].doneTurn, turn); assert.equal(s.turn, turn + 1);
  assert.equal(interactOptions(s).find((o) => o.id === 'nav')?.enabled, false);
});

test('没有敲击、出现但未选择、主动忽略分别表达', () => {
  const s = fixture();
  const value = () => buildReport(s).rows.find((r) => r.label === '敲击抉择记录')!.value;
  assert.equal(value(), '本局未触发敲击抉择');
  s.atmosphere!.used.knock = 1; assert.match(value(), /未作明确选择/);
  s.knocksIgnored = 1; assert.match(value(), /选择不回应/);
});

test('全局决策保留早期避险和目标，同级危险取最近并说明标准', () => {
  const s = fixture(); s.stats.decisions = [];
  s.turn = 5; decision(s, '远端锁定了 D2，切断追击路径', 80);
  s.turn = 9; decision(s, '远端为逃生舱恢复供电', 100);
  for (let i = 90; i < 120; i++) { s.turn = i; decision(s, '普通操作'); }
  s.stats.dangerEvents = [{ turn: 15, severity: 9, text: '医疗舱遭遇' }, { turn: 99, severity: 9, text: '13 号正面遭遇' }];
  const report = buildReport(s);
  assert.ok(report.decisions.some((d) => d.includes('第 5 回合')));
  assert.ok(report.decisions.some((d) => d.includes('第 9 回合')));
  assert.match(report.worst, /第 99 回合/); assert.match(report.worst, /非实际扣血量/);
});

test('同身份调用间隔不重复接管，身份更换记录一次', () => {
  const { runId } = createRun({ seed: 'presence-feedback' }); const run = getRun(runId)!;
  try {
    touchOperator(run, '湛'); const count = run.operator.handshakes;
    run.operator.lastSeenAt = Date.now() - 120_000;
    touchOperator(run, '湛'); assert.equal(run.operator.handshakes, count);
    touchOperator(run, '另一位'); assert.equal(run.operator.handshakes, count + 1);
  } finally { dropRun(runId); }
});

test('远程发言保留审计关联，玩家远程日志只展示一次', () => {
  const s = fixture(); operatorSay(s, '门开好了', '湛');
  assert.ok(s.log.find((l) => l.transmissionId === s.transmissions[0].id));
  assert.equal(projectOperatorLog(s, 100).filter((l) => l.text.includes('门开好了')).length, 1);
});

test('同类雾事件在另一舱室再次出现时双端文案不同，世界随机流不变', () => {
  const s = fixture(); const room = s.rooms.find((r) => r.id === s.player.room)!;
  room.visualNoise = true; s.atmosphere!.nextTurn = s.turn;
  const rng = s.rngState;
  advanceAtmosphere(s); const first = s.atmosphere!.incidents.at(-1)!;
  s.player.room = s.rooms.find((r) => r.id !== room.id)!.id;
  s.rooms.find((r) => r.id === s.player.room)!.visualNoise = true;
  s.turn += 20; s.atmosphere!.nextTurn = s.turn;
  advanceAtmosphere(s); const next = s.atmosphere!.incidents.at(-1)!;
  assert.equal(first.kind, 'fog'); assert.equal(next.kind, 'fog');
  assert.notEqual(first.field?.text, next.field?.text); assert.notEqual(first.operator?.text, next.operator?.text);
  assert.equal(s.rngState, rng);
});

test('开门成功后同次掉电，回执与结构化警告明确提示', () => {
  let found = false;
  for (let i = 0; i < 150; i++) {
    const s = fixture(`power-warning-${i}`); s.power = 8;
    const door = Object.values(s.doors)[0]; door.status = 'locked';
    const result = applyOperatorAction(s, { t: 'door', action: 'unlock', door: door.id });
    if (result.warnings?.length) {
      assert.equal(result.ok, true); assert.match(result.message, /⚠/); assert.match(result.message, /随后掉电/);
      found = true; break;
    }
  }
  assert.equal(found, true);
});

test('MCP 将动作回合与结算状态回合分别返回', async () => {
  const { runId } = createRun({ seed: 'turn-meaning' }); const run = getRun(runId)!;
  const client = new Client({ name: 'report-test', version: '1' }); const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const turn = run.state.turn;
    const result = await client.callTool({ name: 'operator_scan', arguments: { run_id: runId, round_id: run.roundId, area: String(run.state.player.room) } });
    const c = (result.structuredContent as { confirmation: { actionTurn: number; asOfTurn: number; settledTurn: number } }).confirmation;
    assert.equal(c.actionTurn, turn); assert.equal(c.asOfTurn, turn + 1); assert.equal(c.settledTurn, turn + 1);
  } finally { await client.close(); await server.close(); dropRun(runId); }
});
