import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game/generator';
import { advance, adjacency, canFieldAttack, executeCommand, fieldAttack, fieldMove, inDepartureGrace } from '../src/game/engine';
import { projectField, projectOperator } from '../src/game/views';

test('出生准备不因远端推进耗尽，首次离舱后缓冲到期并提前预警', () => {
  for (const difficulty of ['light', 'unstable', 'silence'] as const) {
    const s = createGame('锈蚀第九次-964', difficulty, 'coop');
    s.entity.exists = true;
    const entityRoom = s.entity.room;
    for (let i = 0; i < 12; i++) {
      s.power = 130; s.oxygen = 100;
      executeCommand(s, { type: 'scan', room: s.player.room, raw: '扫描' });
      assert.equal(s.player.health, 100);
      assert.equal(s.entity.room, entityRoom);
      assert.equal(inDepartureGrace(s), true);
    }
    const link = adjacency(s, s.player.room)[0]; link.door.status = 'open'; link.door.braced = false;
    link.room.hazard = null;
    fieldMove(s, link.room.id);
    const until = s.departureGrace!.until!;
    assert.equal(until, s.turn + 4);
    while (s.turn <= until) { s.oxygen = 100; advance(s); }
    assert.equal(inDepartureGrace(s), false);
    assert.ok(s.log.some(l => l.text.includes('离舱缓冲结束')));
    assert.equal(s.player.health, 100);
  }
});

test('所有难度定位直接报告当前房间，旧采样不伪装成实时', () => {
  for (const difficulty of ['light', 'unstable', 'silence'] as const) {
    const s = createGame('real-position', difficulty, 'coop');
    s.player.room = adjacency(s, s.player.room)[0].room.id;
    s.commDelay = 8;
    const view = projectOperator(s, 'test', false);
    assert.equal(view.fieldMember.reportedRoom, s.player.room);
    assert.equal(view.fieldMember.dataAgeTurns, 0);
    assert.equal(view.fieldMember.realtime, true);
    assert.equal(s.flags.commFixed, false);
  }
});

test('无人机路径不通或电量不足时仅记请求次数，不扣电、不推进', () => {
  const s = createGame('drone-preflight', 'unstable', 'coop');
  const target = adjacency(s, s.drone.room)[0].room.id;
  for (const d of Object.values(s.doors)) d.status = 'locked';
  const before = structuredClone(s);
  const result = executeCommand(s, { type: 'drone', room: target, raw: '无人机' });
  assert.equal(result.ok, false); assert.equal(result.turns, 0);
  before.stats.remoteCommands++;
  assert.deepEqual(s, before);
  for (const d of Object.values(s.doors)) d.status = 'open';
  s.drone.charge = 0;
  const beforeEmpty = structuredClone(s);
  assert.equal(executeCommand(s, { type: 'drone', room: target, raw: '无人机' }).ok, false);
  beforeEmpty.stats.remoteCommands++;
  assert.deepEqual(s, beforeEmpty);
});

test('新送电六回合内不因随机跳闸或不稳塌陷，仍可主动断电', () => {
  for (let i = 0; i < 100; i++) {
    const s = createGame(`power-grace-${i}`, 'unstable', 'coop');
    const z = Object.values(s.zones).find(z => !z.breakerDamaged)!;
    z.powered = false; z.unstable = true;
    assert.equal(executeCommand(s, { type: 'power_on', zone: z.id, raw: '送电' }).ok, true);
    const until = z.stableUntilTurn!;
    while (s.turn < until) { s.oxygen = 100; advance(s); assert.equal(z.powered, true); }
    assert.equal(executeCommand(s, { type: 'power_off', zone: z.id, raw: '断电' }).ok, true);
    assert.equal(z.powered, false);
  }
});

test('侧键可用性跟随目标范围与门态，锁门和门楔切断攻击', () => {
  const s = createGame('attack-range', 'unstable', 'coop');
  const link = adjacency(s, s.player.room)[0];
  s.entity.exists = true; s.entity.room = link.room.id;
  link.door.status = 'open'; link.door.braced = false;
  assert.equal(canFieldAttack(s), true); assert.equal(projectField(s).fieldAttackAvailable, true);
  link.door.status = 'locked'; assert.equal(canFieldAttack(s), false);
  link.door.status = 'open'; link.door.braced = true; assert.equal(canFieldAttack(s), false);
  s.entity.room = s.player.room; assert.equal(canFieldAttack(s), true);
});

test('退避窗口中补刀落空不会让失能目标突然反扑', () => {
  let misses = 0;
  for (let i = 0; i < 50; i++) {
    const s = createGame(`stunned-miss-${i}`, 'light', 'coop');
    for (const r of s.rooms) r.hazard = null;
    s.departureGrace = undefined;
    s.entity.exists = true; s.entity.room = s.player.room; s.entity.stunnedTurns = 5;
    fieldAttack(s, 'fist');
    if (s.log.some(l => l.text.includes('仍在退避休整'))) {
      misses++; assert.equal(s.player.health, 100); assert.equal(s.player.suitLeak, 0);
      assert.equal(s.entity.stunnedTurns, 4);
    }
  }
  assert.ok(misses > 20);
});

test('追猎移动留出间隔，封死通路后不继续追踪玩家', () => {
  const s = createGame('pursuit-interval', 'light', 'coop');
  s.departureGrace = undefined;
  for (const r of s.rooms) r.hazard = null;
  for (const d of Object.values(s.doors)) { d.status = 'open'; d.braced = false; }
  s.entity.exists = true; s.entity.hunting = true;
  s.entity.room = adjacency(s, s.player.room)[0].room.id;
  s.entity.lastMoveTurn = s.turn; s.entity.lastHitTurn = s.turn;
  const position = s.entity.room;
  advance(s);
  assert.equal(s.entity.room, position, '刚行动过的目标下一回合不能再移动');
  for (const d of Object.values(s.doors)) d.status = 'locked';
  advance(s);
  assert.equal(s.entity.hunting, false);
  assert.equal(s.entity.huntTarget, null);
});
