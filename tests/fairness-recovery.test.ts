import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from '../src/game/generator';
import { advance, adjacency, fieldAttack, fieldDrop } from '../src/game/engine';
import { createRun, getRun, dropRun, restartRun, doFieldRequest, fieldViewOf } from '../server/runs';

function fixture(seed: string) {
  const s = createGame(seed, 'light', 'coop');
  s.departureGrace = undefined;
  for (const room of s.rooms) room.hazard = null;
  for (const zone of Object.values(s.zones)) { zone.powered = true; zone.unstable = false; }
  for (const door of Object.values(s.doors)) { door.status = 'open'; door.braced = false; }
  s.turn = 20; s.entity.exists = true; s.entity.lastHitTurn = 0;
  s.entity.room = adjacency(s, s.player.room)[0].room.id;
  return s;
}

test('屏息在怪物感知阶段仍有效，并只作用一回合', () => {
  const held = fixture('hold-breath'); const normal = structuredClone(held);
  held.entity.hunting = normal.entity.hunting = false;
  held.entity.agitation = normal.entity.agitation = 0;
  held.entity.lastMoveTurn = normal.entity.lastMoveTurn = 100;
  held.player.breathHold = true;
  advance(held); advance(normal);
  assert.equal(held.entity.hunting, false);
  assert.equal(normal.entity.hunting, true);
  assert.equal(held.player.breathHold, false);
  assert.ok(held.lastDrain < normal.lastDrain);
  advance(held); assert.equal(held.entity.hunting, true);
});

test('百种随机流中攻击落空只结算一次反扑，不叠加同回合扑击', () => {
  let misses = 0;
  for (let i = 0; i < 100; i++) {
    const s = fixture(`miss-fairness-${i}`);
    s.entity.lastMoveTurn = 0;
    fieldAttack(s, 'fist');
    if (s.stats.decisions.some((d) => d.includes('攻击落空'))) {
      misses++;
      assert.equal(s.player.health, 82, s.seed);
      assert.equal(s.entity.lastHitTurn, 21);
    }
  }
  assert.ok(misses > 30);
});

test('背包排序改变后旧放下动作不会丢掉另一件物品', () => {
  const s = fixture('bag-race'); s.player.inventory = ['navcore', 'o2'];
  const before = JSON.stringify(s);
  assert.match(fieldDrop(s, 0, 'o2'), /重新选择/);
  assert.equal(JSON.stringify(s), before);
  assert.equal(fieldDrop(s, 1, 'o2'), '');
  assert.deepEqual(s.player.inventory, ['navcore']);
});

test('同请求重发只推进一次，编号碰撞、旧轮和畸形操作均不执行', () => {
  const { runId } = createRun({ seed: 'request-recovery' }); const run = getRun(runId)!;
  try {
    const request = { roundId: run.roundId, requestId: 'request-1', action: { t: 'wait' } };
    const turn = run.state.turn;
    assert.equal(doFieldRequest(run, request).ok, true);
    const after = JSON.stringify(run.state); const revision = run.revision;
    assert.equal(doFieldRequest(run, request).ok, true);
    assert.equal(run.state.turn, turn + 1); assert.equal(JSON.stringify(run.state), after);
    assert.equal(run.revision, revision);
    assert.equal(doFieldRequest(run, { ...request, action: { t: 'search' } }).ok, false);
    for (const action of [null, {}, { t: 'attack', weapon: 'laser' }, { t: 'drop', index: -1, item: 'o2' }, { t: 'move', room: '1' }]) {
      assert.equal(doFieldRequest(run, { ...request, requestId: 'malformed', action }).ok, false);
      assert.equal(JSON.stringify(run.state), after);
    }
    restartRun(run);
    const fresh = JSON.stringify(run.state);
    assert.equal(doFieldRequest(run, request).ok, false);
    assert.equal(JSON.stringify(run.state), fresh);
  } finally { dropRun(runId); }
});

test('重连快照保留服务器实际计时，暂停期间不累加', () => {
  const { runId } = createRun({ seed: 'elapsed-rejoin' }); const run = getRun(runId)!;
  try {
    const now = Date.now(); run.createdAt = now - 60_000;
    run.paused = true; run.pauseStartAt = now - 20_000;
    assert.ok(Math.abs(fieldViewOf(run).state.elapsedMs - 40_000) < 50);
  } finally { dropRun(runId); }
});
