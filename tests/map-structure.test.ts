import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, validateWinnability } from '../src/game/generator';

function blockedStart(status: 'locked' | 'jammed') {
  const s = createGame('structural-boundary', 'unstable', 'coop');
  const start = s.rooms.find((r) => r.id === s.player.room)!;
  for (const r of s.rooms) {
    r.items = r.items.filter((it) => it !== 'crowbar');
    r.hiddenItems = r.hiddenItems.filter((it) => it !== 'crowbar');
  }
  s.player.inventory = s.player.inventory.filter((it) => it !== 'crowbar');
  for (const d of Object.values(s.doors)) {
    d.status = start.doors.includes(d.id) ? status : 'open';
    d.remoteBroken = start.doors.includes(d.id);
  }
  return { s, start };
}

test('坏锁后的撬棍不能解开自身依赖，随身撬棍可以', () => {
  const { s } = blockedStart('locked');
  s.rooms.find((r) => r.id !== s.player.room)!.items.push('crowbar');
  assert.ok(validateWinnability(s).some((p) => p.includes('crowbar')));
  s.player.inventory.push('crowbar');
  assert.deepEqual(validateWinnability(s), []);
});

test('地图没有撬棍不等于已经拿到撬棍，可达副本也不被不可达副本遮蔽', () => {
  const { s, start } = blockedStart('jammed');
  assert.ok(validateWinnability(s).length > 0);
  s.rooms.find((r) => r.id !== start.id)!.hiddenItems.push('crowbar');
  start.items.push('crowbar');
  assert.deepEqual(validateWinnability(s), []);
});

test('配电阀与工具包都可达才恢复供电，已通电坏阀不阻断解锁', () => {
  const s = createGame('structural-power', 'unstable', 'coop');
  const podZone = s.rooms.find((r) => r.id === s.podRoom)!.zone;
  for (const d of Object.values(s.doors)) d.status = 'open';
  s.zones[podZone].powered = false;
  s.zones[podZone].breakerDamaged = true;
  const breaker = s.rooms.find((r) => r.feature === 'breaker')!;
  const start = s.rooms.find((r) => r.id === s.player.room)!;
  start.zone = podZone;
  // 复位点在门后，门又依赖复位；不能凭地图上存在配电阀就放行。
  if (breaker.id === start.id) { breaker.feature = null; s.rooms.find((r) => r.id !== start.id && r.feature === null)!.feature = 'breaker'; }
  for (const id of start.doors) {
    const d = s.doors[id]; d.status = 'locked'; d.remoteBroken = false;
    s.rooms.find((r) => r.id === (d.a === start.id ? d.b : d.a))!.zone = podZone;
  }
  assert.ok(validateWinnability(s).length > 0);
  s.zones[podZone].powered = true;
  assert.deepEqual(validateWinnability(s), []);
});

test('随身关键物品被计入结构检查，检查不修改状态', () => {
  const s = createGame('structural-inventory', 'unstable', 'coop');
  for (const r of s.rooms) {
    for (const key of ['toolkit', 'navcore', 'idcard']) {
      if (r.items.includes(key) || r.hiddenItems.includes(key)) s.player.inventory.push(key);
      r.items = r.items.filter((it) => it !== key);
      r.hiddenItems = r.hiddenItems.filter((it) => it !== key);
    }
  }
  const before = structuredClone(s);
  assert.deepEqual(validateWinnability(s), []);
  assert.deepEqual(s, before);
});

test('3000 张初始地图满足结构前提（不代表资源与生存求解）', () => {
  for (const difficulty of ['light', 'unstable', 'silence'] as const) {
    for (let i = 0; i < 1000; i++) {
      const s = createGame(`structural-audit-${i}`, difficulty, 'coop');
      assert.deepEqual(validateWinnability(s), [], `${difficulty}/${s.seed}`);
    }
  }
});
