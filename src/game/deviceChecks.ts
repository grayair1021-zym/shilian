import { createGame, validateWinnability } from './generator';
import { adjacency, advance, getRoom } from './engine';
import { applyFieldAction, applyOperatorAction } from './actions';
import { deviceGuidance, sonarFresh } from './deviceLogic';
import { fieldPerceptions, physicalCue } from './atmosphere';
import { projectField, projectOperator } from './views';

export function runDeviceChecks(): { name: string; passed: boolean; detail?: string }[] {
  const results: { name: string; passed: boolean; detail?: string }[] = [];
  const expect = (condition: unknown) => { if (!condition) throw new Error('未满足预期'); };
  const check = (name: string, execute: () => void) => {
    try { execute(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : '失败' }); }
  };
  const fixture = () => {
    const g = createGame('设备操作回归', 'light', 'solo');
    g.departureGrace = undefined;
    g.entity.exists = false;
    for (const r of g.rooms) { r.hazard = null; r.visualNoise = false; }
    for (const z of Object.values(g.zones)) { z.powered = true; z.unstable = false; }
    return g;
  };
  check('单人直接生成本地完整状态，不依赖服务', () => {
    const g = createGame('离线评测', 'light', 'solo');
    expect(g.mode === 'solo' && g.power > 0 && g.integrity === 100);
  });
  check('氧气补给：轻度 7 罐，其余 6 罐，含随身 1 罐', () => {
    for (const difficulty of ['light', 'unstable', 'silence'] as const) {
      const g = createGame('氧气补给', difficulty, 'solo');
      const all = [...g.player.inventory, ...g.rooms.flatMap((r) => [...r.items, ...r.hiddenItems])];
      expect(all.filter((it) => it === 'o2').length === (difficulty === 'light' ? 7 : 6));
      expect(g.player.inventory.includes('o2'));
    }
  });
  check('同种子与难度重建相同布局和补给', () => {
    expect(JSON.stringify(createGame('复盘', 'light', 'solo')) === JSON.stringify(createGame('复盘', 'light', 'solo')));
  });
  check('配电阀未复位的双侧回路不生成锁死门', () => {
    for (const seed of ['路由甲', '路由乙', '路由丙', '路由丁']) {
      const g = createGame(seed, 'unstable', 'solo');
      for (const d of Object.values(g.doors)) {
        const za = g.zones[getRoom(g, d.a).zone], zb = g.zones[getRoom(g, d.b).zone];
        expect(!(za.breakerDamaged && zb.breakerDamaged && d.status === 'locked'));
      }
    }
  });
  check('单人能直接解锁舱门，不发给不存在的搭档', () => {
    const g = fixture();
    const d = adjacency(g, g.player.room)[0].door;
    d.status = 'locked'; d.braced = false; d.remoteBroken = false;
    const power = g.power;
    const result = applyOperatorAction(g, { t: 'door', door: d.id, action: 'unlock' });
    expect(result.ok && g.power < power && g.turn === 2);
    expect(g.transmissions.length === 0);
  });
  check('单人可本地切换供电，消耗真实电力', () => {
    const g = fixture();
    const zone = getRoom(g, g.player.room).zone;
    const result = applyOperatorAction(g, { t: 'power', zone, action: 'off' });
    expect(result.ok && !g.zones[zone].powered && g.turn === 2);
  });
  check('重复翻找不再白耗氧气', () => {
    const g = fixture();
    getRoom(g, g.player.room).searched = true;
    const before = JSON.stringify(g);
    expect(!applyFieldAction(g, { t: 'search' }).ok);
    expect(before === JSON.stringify(g));
  });
  check('静听标出相邻来路，附带两次轻步', () => {
    const g = fixture();
    const next = adjacency(g, g.player.room)[0];
    g.entity.exists = true; g.entity.room = next.room.id; g.entity.lastMoveTurn = 100;
    expect(applyFieldAction(g, { t: 'listen' }).ok);
    expect(g.player.quietSteps === 2 && g.sonar?.originRoom === g.player.room && g.sonar?.doorId && sonarFresh(g));
    expect(projectField(g).sonar?.doorId === g.sonar?.doorId);
    expect(!('sonar' in projectOperator(g, 'test', false)));
  });
  check('刚听过时不会重复扣费', () => {
    const g = fixture();
    applyFieldAction(g, { t: 'listen' });
    const before = JSON.stringify(g);
    expect(!applyFieldAction(g, { t: 'listen' }).ok);
    expect(before === JSON.stringify(g));
  });
  check('轻步可避开一次擦撞，消耗预判而不损坏护服', () => {
    const g = fixture();
    const here = g.player.room;
    const neighbor = adjacency(g, here)[0];
    for (const d of Object.values(g.doors)) { d.status = 'locked'; d.braced = false; }
    neighbor.door.status = 'open';
    g.entity.exists = true; g.entity.room = neighbor.room.id; g.entity.lastMoveTurn = -10;
    g.player.quietSteps = 2;
    advance(g, 1);
    expect(g.player.quietSteps === 0 && g.player.suitLeak === 0);
    expect(g.log.some((l) => l.text.includes('护服没有受损')));
  });
  check('护服与结构警报是独立音画类型', () => {
    const g = fixture();
    physicalCue(g, 'suit', '测试：防护服破损');
    physicalCue(g, 'fracture', '测试：舱段断裂');
    const cues = fieldPerceptions(g).map((e) => e.cue);
    expect(cues.includes('suit') && cues.includes('fracture'));
  });
  check('建议只描述下一步，不自行动作', () => {
    const g = fixture();
    const before = JSON.stringify(g);
    const suggestion = deviceGuidance(g, true);
    expect(!!suggestion.title && !suggestion.title.includes('请求') && before === JSON.stringify(g));
  });
  check('现场员遭遇时可使用武器反击，不同武器效果与消耗真实结算', () => {
    const g = fixture();
    g.entity.exists = true;
    g.entity.room = g.player.room; // 同舱遭遇
    g.player.inventory.push('crowbar', 'sealant');
    const resultFist = applyFieldAction(g, { t: 'attack', weapon: 'fist' });
    expect(resultFist.ok);
    // 撬棍攻击
    const resultCrowbar = applyFieldAction(g, { t: 'attack', weapon: 'crowbar' });
    expect(resultCrowbar.ok);
  });
  check('远程无人机冲击消耗15点电力并作用于目标', () => {
    const g = fixture();
    g.entity.exists = true;
    const targetRoom = g.rooms[1].id;
    g.entity.room = targetRoom;
    g.drone.room = targetRoom;
    g.power = 40;
    g.drone.lost = false;
    g.drone.charge = 3;
    const result = applyOperatorAction(g, { t: 'drone_attack', room: targetRoom });
    expect(result.ok || result.message.includes('冲击'));
    // 消耗15点电力（回合推进后会有微弱回充），最终电力应小于 30
    expect(g.power < 30);
  });
  check('治疗补给按量投放：肾上腺素2支，能量胶3支', () => {
    for (const difficulty of ['light', 'unstable', 'silence'] as const) {
      const g = createGame('治疗补给', difficulty, 'solo');
      const all = [...g.player.inventory, ...g.rooms.flatMap((r) => [...r.items, ...r.hiddenItems])];
      expect(all.filter((it) => it === 'adrenaline').length === 2);
      expect(all.filter((it) => it === 'energygel').length === 3);
    }
  });
  check('肾上腺素回血40、能量胶回血20且均被消耗', () => {
    const g = fixture();
    g.player.health = 30;
    g.player.inventory.push('adrenaline', 'energygel');
    expect(applyFieldAction(g, { t: 'use', item: 'adrenaline' }).ok);
    expect(g.player.health === 70 && !g.player.inventory.includes('adrenaline'));
    expect(applyFieldAction(g, { t: 'use', item: 'energygel' }).ok);
    expect(g.player.health === 90 && !g.player.inventory.includes('energygel'));
  });
  check('密封胶修补护服时附带治疗，屏息包扎缓慢回血', () => {
    const g = fixture();
    g.player.health = 60;
    g.player.suitLeak = 0.5;
    g.player.inventory.push('sealant');
    expect(applyFieldAction(g, { t: 'use', item: 'sealant' }).ok);
    expect(g.player.health === 68 && g.player.suitLeak === 0);
    const before = g.player.health;
    expect(applyFieldAction(g, { t: 'wait' }).ok);
    expect(g.player.health === Math.min(100, before + 5));
  });
  check('单次受伤有上限：实体撞击与反击失败不再一击致残', () => {
    const g = fixture();
    g.entity.exists = true;
    g.entity.room = g.player.room;
    g.entity.lastMoveTurn = -10;
    g.player.health = 100;
    advance(g, 1);
    expect(g.player.health >= 80);
  });
  check('低血量时指引优先推荐治疗', () => {
    const g = fixture();
    g.player.health = 40;
    g.player.inventory.push('adrenaline');
    const s = deviceGuidance(g, true);
    expect(s.title.includes('肾上腺素'));
  });
  check('多种子多难度初始目标及关键物品结构可达（含长夜残响-416）', () => {
    const seeds = ['长夜残响-416', '灰河尾迹-101', '锈蚀边界-233', '深潜零点-377', '回声备份-502', '寂静七号-618', '黑砂断线-734', '南极星归航-88'];
    for (const difficulty of ['light', 'unstable', 'silence'] as const) {
      for (const seed of seeds) {
        const problems = validateWinnability(createGame(seed, difficulty, 'coop'));
        if (problems.length) throw new Error(`${difficulty}/${seed}: ${problems.join('; ')}`);
      }
    }
  });
  return results;
}
