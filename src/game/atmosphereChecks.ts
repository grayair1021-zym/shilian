import { createGame } from './generator';
import { applyFieldAction, applyOperatorAction } from './actions';
import { adjacency, doorStatusText, executeCommand, fieldAnswerKnock, fieldTransmit } from './engine';
import {
  advanceAtmosphere, atmospherePairsForReport, fieldPerceptions, onClueLifted,
  onDangerMarked, onRoomEntered, operatorAdvisories, physicalCue, recordInspection,
} from './atmosphere';
import { projectField, projectOperator, projectOperatorLog } from './views';

export interface AtmosphereCheck { name: string; passed: boolean; detail?: string }

/** 所有检查只操作新建的独立测试局，绝不接收正在游玩的状态。 */
export function runAtmosphereChecks(): AtmosphereCheck[] {
  const results: AtmosphereCheck[] = [];
  const require = (value: unknown, message = '断言未满足') => { if (!value) throw new Error(message); };
  const check = (name: string, fn: () => void) => {
    try { fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : '检查失败' }); }
  };
  const fixture = () => {
    const game = createGame('氛围隔离测试', 'unstable', 'coop');
    for (const r of game.rooms) { r.hazard = null; r.visualNoise = false; r.sensor = 'ok'; }
    for (const z of Object.values(game.zones)) { z.powered = true; z.unstable = false; }
    for (const d of Object.values(game.doors)) { d.status = 'open'; d.braced = false; d.remoteBroken = false; }
    game.entity.exists = false;
    return game;
  };
  const glassFixture = () => {
    const game = fixture();
    const room = game.rooms.find((r) => r.feature === 'nav')!;
    game.player.room = room.id;
    room.visited = true;
    game.entity.exists = true;
    game.entity.room = adjacency(game, room.id)[0].room.id;
    game.turn = 10;
    game.atmosphere!.nextTurn = 10;
    advanceAtmosphere(game);
    return game;
  };

  check('同种子、同动作的氛围可复现', () => {
    require(JSON.stringify(glassFixture()) === JSON.stringify(glassFixture()));
  });
  check('开局留出平静，不立即展示异常', () => {
    const g = fixture();
    const firstTurn = g.atmosphere!.nextTurn;
    for (g.turn = 1; g.turn < firstTurn; g.turn++) advanceAtmosphere(g);
    require(g.atmosphere!.incidents.length === 0);
  });
  check('舷窗事件从同一条记录分出两份线索', () => {
    const g = glassFixture();
    const pair = g.atmosphere!.incidents[0];
    require(pair.kind === 'glass' && pair.field && pair.operator);
    require(pair.field!.turn === pair.operator!.turn && pair.field!.roomId === pair.operator!.roomId);
  });
  check('现场网络数据不含远程片段与氛围真值', () => {
    const g = glassFixture();
    const f = projectField(g);
    require(f.atmosphere === null && !!f.fieldEffects?.length);
    require(!JSON.stringify(f).includes(g.atmosphere!.incidents[0].operator!.text));
  });
  check('远程视图和日志不含未经发送的现场片段', () => {
    const g = glassFixture();
    const text = g.atmosphere!.incidents[0].field!.text;
    require(!JSON.stringify(projectOperator(g, 'TEST', false)).includes(text));
    require(!JSON.stringify(projectOperatorLog(g, 100)).includes(text));
  });
  check('气氛事件后至少留出五回合间隔', () => {
    const g = glassFixture();
    const start = g.turn;
    const count = g.atmosphere!.incidents.length;
    require(g.atmosphere!.nextTurn - start >= 5);
    for (g.turn++; g.turn < g.atmosphere!.nextTurn; g.turn++) advanceAtmosphere(g);
    require(g.atmosphere!.incidents.length === count);
  });
  check('同局不会反复演出舷窗手印', () => {
    const g = glassFixture();
    g.turn = g.atmosphere!.nextTurn;
    advanceAtmosphere(g);
    require(g.atmosphere!.incidents.filter((e) => e.kind === 'glass').length === 1);
  });
  check('读取视图不推进回合、不抽新随机数', () => {
    const g = glassFixture();
    const before = JSON.stringify(g);
    projectField(g); projectOperator(g, 'TEST', false); projectOperatorLog(g);
    fieldPerceptions(g); operatorAdvisories(g);
    require(JSON.stringify(g) === before);
  });
  check('新线索只追加，不改写旧日志或玩家消息', () => {
    const g = fixture();
    fieldTransmit(g, '这句是现场员实际输入的。');
    applyOperatorAction(g, { t: 'say', text: '这句来自远程席。' }, '测试席');
    const beforeLog = JSON.stringify(g.log);
    const beforeMessages = JSON.stringify(g.transmissions);
    g.rooms.find((r) => r.id === g.player.room)!.clue = '纸页正面的原文。';
    g.turn = 10;
    g.atmosphere!.nextTurn = 10;
    onClueLifted(g);
    g.turn++;
    advanceAtmosphere(g);
    const oldCount = JSON.parse(beforeLog).length as number;
    require(JSON.stringify(g.log.slice(0, oldCount)) === beforeLog);
    require(JSON.stringify(g.transmissions) === beforeMessages);
    require(g.transmissions.map((m) => m.source).join(',') === 'field,operator');
  });
  check('回应敲击只制造噪声，不传送目标', () => {
    const g = fixture();
    g.turn = 12;
    g.entity.exists = true;
    g.entity.room = g.rooms.find((r) => r.id !== g.player.room)!.id;
    const beforeRoom = g.entity.room;
    g.pendingKnock = { turn: 12, dir: '东侧', roomId: g.player.room, expiresTurn: 15 };
    require(fieldAnswerKnock(g) === '');
    require(g.entity.room === beforeRoom && g.turn === 13);
    require(g.entity.answeredKnock && !g.pendingKnock && g.transmissions.length === 0);
  });
  check('正常搜索动作能在节拍到达时触发背面线索', () => {
    const g = fixture();
    const room = g.rooms.find((r) => r.id === g.player.room)!;
    room.searched = false;
    room.clue = '一页写有维修笔记的纸。';
    g.turn = g.atmosphere!.nextTurn - 1;
    const result = applyFieldAction(g, { t: 'search' });
    require(result.ok && g.atmosphere!.incidents.some((e) => e.kind === 'paper'));
  });
  check('过期的敲击不能事后触发回应', () => {
    const g = fixture();
    g.pendingKnock = { turn: 1, dir: '东侧', roomId: g.player.room, expiresTurn: 4 };
    g.turn = 5;
    const result = fieldAnswerKnock(g);
    require(!!result && g.turn === 5 && !g.entity.answeredKnock);
  });
  check('压力提示引用真实核验计数，不改资源', () => {
    const g = fixture();
    g.turn = 10;
    const resources = [g.power, g.oxygen, g.integrity];
    recordInspection(g, 6, 1); recordInspection(g, 6, 1); recordInspection(g, 12, 2);
    const a = operatorAdvisories(g)[0];
    require(a?.text.includes('3 次') && a.text.includes('4 回合') && a.text.includes('24 点'));
    require(!a.authoritative && JSON.stringify(resources) === JSON.stringify([g.power, g.oxygen, g.integrity]));
  });
  check('显示诊断不假冒一条锁门指令', () => {
    const g = fixture();
    g.turn = 14;
    const room = g.rooms[0];
    room.sensor = 'delayed';
    const doors = JSON.stringify(g.doors);
    recordInspection(g, 6, 1, room.id); recordInspection(g, 6, 1, room.id);
    const note = operatorAdvisories(g).find((a) => a.kind === 'display');
    require(note && !note.authoritative && note.text.includes('不是锁门指令'));
    require(JSON.stringify(g.doors) === doors && g.transmissions.length === 0);
  });
  check('标记回应不生成假事故、不改门态', () => {
    const g = fixture();
    g.turn = 10;
    g.atmosphere!.nextTurn = 10;
    const before = JSON.stringify([g.oxygen, g.integrity, g.doors]);
    onDangerMarked(g, g.player.room);
    g.turn++;
    advanceAtmosphere(g);
    require(g.atmosphere!.incidents[0]?.kind === 'annotation');
    require(before === JSON.stringify([g.oxygen, g.integrity, g.doors]));
  });
  check('重返细节不偷换背包或地面资源', () => {
    const g = fixture();
    const room = g.rooms.find((r) => r.id === g.player.room)!;
    const before = JSON.stringify([g.player.inventory, room.items, room.hiddenItems]);
    onRoomEntered(g, false);
    g.turn = 12;
    g.atmosphere!.nextTurn = 12;
    onRoomEntered(g, true);
    g.turn++;
    advanceAtmosphere(g);
    require(g.atmosphere!.incidents.some((e) => e.kind.startsWith('return-')));
    require(before === JSON.stringify([g.player.inventory, room.items, room.hiddenItems]));
  });
  check('音画提示没有额外伤害和资源代价', () => {
    const g = fixture();
    const before = JSON.stringify([g.player, g.power, g.oxygen, g.integrity, g.rngState]);
    physicalCue(g, 'tremor', '测试用震动记录。');
    require(before === JSON.stringify([g.player, g.power, g.oxygen, g.integrity, g.rngState]));
  });
  check('工具执行后投影的资源和门态对应真实最终状态', () => {
    const g = fixture();
    const d = Object.values(g.doors)[0];
    d.status = 'locked';
    const result = executeCommand(g, { type: 'unlock', door: d.id, raw: '测试解锁' });
    const v = projectOperator(g, 'TEST', false);
    require(result.ok && v.doors.find((door) => door.id === d.id)?.status === doorStatusText(d.status));
    require(v.resources.power === Number(g.power.toFixed(1)) && v.resources.oxygenPercent === Number(g.oxygen.toFixed(1)));
  });
  check('无条件调用物品或撤离不会越过规则', () => {
    const g = fixture();
    require(!applyFieldAction(g, { t: 'use', item: 'idcard' }).ok);
    require(!applyFieldAction(g, { t: 'interact', id: 'escape' }).ok);
    require(g.status === 'playing');
  });
  check('两边片段只在任务结束后合并', () => {
    const g = glassFixture();
    require(atmospherePairsForReport(g).length === 0);
    g.status = 'lost';
    const pairs = atmospherePairsForReport(g);
    require(pairs.length === 1 && pairs[0].field !== pairs[0].operator);
  });
  return results;
}