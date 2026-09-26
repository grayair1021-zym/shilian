import { RNG } from './rng';
import {
  advanceAtmosphere, onClueLifted, onDangerMarked, onFieldStill,
  onKnockAnswered, onRoomEntered, physicalCue, recordInspection,
} from './atmosphere';
import {
  CALM_ROOM_LINES,
  DARK_LINES,
  FOG_LINES,
  ITEMS,
  LISTENING_LINES,
  LOSE_HULL_LINES,
  LOSE_O2_LINES,
  MOVE_LINES,
  RELICS,
  SEARCH_EMPTY_LINES,
  SENSOR_CLUES,
  WIN_LINES,
  hazardLine,
} from './content';
import { pushLog, roomLabel, shortRoom } from './generator';
import {
  DIFFICULTIES,
  type Door,
  type GameState,
  type PingKind,
  type RemoteReading,
  type Room,
} from './types';

export interface CommandResult {
  ok: boolean;
  receipt: string;
  turns: number;
  warnings?: string[];
}

export const REMOTE_COSTS = {
  scan: 6,
  unlock: 8,
  lock: 4,
  power: 5,
  transfer: 6,
  drone: 10,
  trace: 12,
};

/** 安全情报的统一复核窗口；仅用于提示与结算分类，不保证目标静止。 */
export const SAFE_READING_MAX_AGE = 3;

export function inDepartureGrace(state: GameState): boolean {
  const grace = state.departureGrace;
  return !!grace && (grace.until === null ? state.player.room === grace.room : state.turn <= grace.until);
}

export function getRoom(state: GameState, id: number): Room {
  return state.rooms.find((r) => r.id === id)!;
}

export function zonePowered(state: GameState, roomId: number): boolean {
  const r = getRoom(state, roomId);
  return state.zones[r.zone]?.powered ?? false;
}

export function otherSide(door: Door, roomId: number): number {
  return door.a === roomId ? door.b : door.a;
}

export function adjacency(state: GameState, roomId: number): { room: Room; door: Door }[] {
  const room = getRoom(state, roomId);
  return room.doors.map((d) => {
    const door = state.doors[d];
    return { room: getRoom(state, otherSide(door, roomId)), door };
  });
}

function rngOf(state: GameState): RNG {
  return new RNG(state.rngState);
}
function saveRng(state: GameState, rng: RNG) {
  state.rngState = rng.state;
}

export function doorLabel(door: Door): string {
  return `${door.id} 舱门`;
}

export function doorStatusText(status: Door['status']): string {
  switch (status) {
    case 'open':
      return '开启';
    case 'closed':
      return '关闭';
    case 'locked':
      return '锁定';
    case 'jammed':
      return '机械卡死';
  }
}

export function hasItem(state: GameState, id: string): boolean {
  return state.player.inventory.includes(id);
}

function removeItem(state: GameState, id: string) {
  const i = state.player.inventory.indexOf(id);
  if (i >= 0) state.player.inventory.splice(i, 1);
}

function noise(state: GameState, amount: number) {
  if (!state.entity.exists) return;
  // 呼吸越稳，动作越轻，制造的噪声越少
  const damped = state.player.composure >= 70 ? amount - 1 : state.player.composure >= 40 ? amount - 0.5 : amount;
  state.entity.agitation = Math.min(8, state.entity.agitation + Math.max(0.5, damped));
}

function directionFrom(state: GameState, from: number, to: number): string {
  const a = getRoom(state, from);
  const b = getRoom(state, to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? '东侧' : '西侧';
  if (dy !== 0) return dy > 0 ? '南侧' : '北侧';
  return '附近';
}

function danger(state: GameState, text: string, severity: number) {
  state.stats.dangerEvents.push({ turn: state.turn, text, severity });
}

export function decision(state: GameState, text: string, weight = 1) {
  const entry = `第 ${state.turn} 回合：${text}`;
  state.stats.decisions.push(entry);
  (state.stats.decisionWeights ??= {})[entry] = weight;
}

/* ------------------------------------------------------------------ */
/*  回合推进                                                            */
/* ------------------------------------------------------------------ */

export function advance(state: GameState, turns = 1) {
  // 目标由已提交的动作达成，时间归属动作回合，不能拖到环境推进后。
  checkGoals(state);
  const cfg = DIFFICULTIES[state.difficulty];
  const rng = rngOf(state);
  for (let t = 0; t < turns; t++) {
    if (state.status !== 'playing') break;
    state.turn += 1;

    // 氧气
    const room = getRoom(state, state.player.room);
    let drain = cfg.drain + state.player.suitLeak;
    if (room.hazard?.active) {
      if (room.hazard.kind === 'vacuum') drain += 1.5;
      if (room.hazard.kind === 'cold') drain += 0.6;
      if (room.hazard.kind === 'radiation') drain += 0.5;
    }
    // 屏息：本回合把呼吸压到最低，氧气消耗大幅下降（一次性消费）
    if (state.player.breathHold) {
      drain *= 0.4;
    } else if (state.player.composure >= 60) {
      // 呼吸稳定时基础消耗也略低
      drain *= 0.88;
    }
    state.lastDrain = Number(drain.toFixed(2));
    state.oxygen = Math.max(0, state.oxygen - drain);
    // 镇定自然衰减
    state.player.composure = Math.max(0, state.player.composure - 4);

    // 电力
    const poweredZones = Object.values(state.zones).filter((z) => z.powered).length;
    state.power = Math.min(130, Math.max(0, state.power + cfg.powerRegen - poweredZones * 0.55));
    if (state.power <= 0.5) {
      const on = Object.values(state.zones).filter((z) => z.powered);
      if (on.length) {
        const z = rng.pick(on);
        z.powered = false;
        pushLog(state, 'alert', `电力储备耗尽，${z.id} 区自动脱网。`, true);
        danger(state, `${z.id} 区因电力耗尽自动脱网`, 5);
      }
    }

    // 分区不稳定
    for (const z of Object.values(state.zones)) {
      if (z.unstable && z.powered && state.turn > (z.stableUntilTurn ?? 0) && rng.chance(0.12)) {
        z.powered = false;
        pushLog(state, 'alert', `${z.id} 区电压塌陷，供电中断。`);
        if (getRoom(state, state.player.room).zone === z.id) {
          pushLog(state, 'field', '灯全灭了。你只剩下头灯的一小片光。');
          physicalCue(state, 'lamp', '照明中断，头灯仍可使用。');
        }
      }
    }

    // 电弧危险随供电状态变化
    for (const r of state.rooms) {
      if (r.hazard && r.hazard.kind === 'arc') r.hazard.active = state.zones[r.zone].powered && !r.hazard.isolated;
    }

    // 危险持续作用（对生命值与护服的双重危害）
    if (room.hazard?.active) {
      if (room.hazard.kind === 'arc' && rng.chance(0.2)) {
        state.player.health = Math.max(0, state.player.health - 10);
        state.player.suitLeak = Math.min(0.8, state.player.suitLeak + 0.15);
        state.integrity = Math.max(0, state.integrity - 2);
        pushLog(state, 'alert', '一道电弧擦过护服，外层被烧穿，高压电流灼伤了躯体！生命值 -10，氧气开始漏失。', true, 'field');
        physicalCue(state, 'suit', '受到高压电弧灼伤！生命值受损，防护服正在漏氧。');
        danger(state, '在高压电弧舱内被击中，受到电流灼伤', 7);
      }
      if (room.hazard.kind === 'debris' && rng.chance(0.18)) {
        state.player.health = Math.max(0, state.player.health - 8);
        state.integrity = Math.max(0, state.integrity - 3);
        pushLog(state, 'alert', '结构二次坍塌！锋利的合金角钢砸中肩部（生命值 -8），整段舱体发出低沉撕裂声。', true, 'field');
        physicalCue(state, 'fracture', '舱段结构断裂！身体受到钝击挫伤。');
        danger(state, '结构二次坍塌砸伤人员', 6);
      }
      if (room.hazard.kind === 'radiation' && rng.chance(0.25)) {
        state.player.health = Math.max(0, state.player.health - 3);
        pushLog(state, 'alert', '高剂量电离辐射穿透护服，面罩内侧闪过微弱白光，身体感到轻微灼痛（生命值 -3）。', false, 'field');
      }
    }

    // 未知目标行动
    moveEntity(state, rng);
    state.player.breathHold = false;

    // 随机事件
    const rate = cfg.eventRate + (state.integrity < 45 ? 0.06 : 0);
    if (rng.chance(rate)) randomEvent(state, rng);

    // 通讯延迟递减
    if (state.commDelay > 0) state.commDelay -= 1;

    // 位置是协作底座，传感器失真不再伪造或延迟现场员位置。
    state.tracked = { room: state.player.room, turn: state.turn, note: '实时定位' };

    // 氧气警告
    if (state.oxygen <= 15 && state.oxygen + drain > 15) {
      pushLog(state, 'alert', '护服提示音变成连续长鸣：氧气储量不足。', true, 'field');
    } else if (state.oxygen <= 30 && state.oxygen + drain > 30) {
      pushLog(state, 'alert', '呼吸阻力变大了，氧气开始告急。', false, 'field');
    }

    if (state.player.health <= 0) {
      state.status = 'lost';
      state.endReason = '生命体征归零。多次遭受重创导致体内失血休克，面罩内只剩下最后的长鸣音。';
      break;
    }
    if (state.oxygen <= 0) {
      state.status = 'lost';
      state.endReason = rng.pick(LOSE_O2_LINES);
      break;
    }
    if (state.integrity <= 0) {
      state.status = 'lost';
      state.endReason = rng.pick(LOSE_HULL_LINES);
      break;
    }
    advanceAtmosphere(state);
  }
  saveRng(state, rng);
  checkGoals(state);
}

function moveEntity(state: GameState, rng: RNG) {
  const e = state.entity;
  if (!e.exists || state.status !== 'playing') return;
  if (inDepartureGrace(state)) {
    e.hunting = false; e.huntTarget = null; e.agitation = 0;
    e.lastMoveTurn = state.turn;
    return;
  }
  if (state.departureGrace?.until === state.turn - 1) {
    pushLog(state, 'system', '离舱缓冲结束。未知目标可能开始活动；留意声音，提前确认退路。', true);
    e.lastMoveTurn = state.turn;
    return;
  }

  // 僵直状态检查
  if (e.stunnedTurns > 0) {
    e.stunnedTurns -= 1;
    if (e.stunnedTurns === 0) e.vitality = Math.min(100, Math.max(35, e.vitality + 25));
    return;
  }

  // 敏锐感知：如果现场员发出了噪声或者在邻舱，生物开启持续追猎模式 (Hunting)
  const distToPlayer = distance(state, e.room, state.player.room);
  if (distToPlayer <= 2 && !state.player.breathHold) {
    e.hunting = true;
    e.huntTarget = state.player.room;
  }

  // 移动间隔：追猎状态下每 1~2 回合逼近一步，普通状态 2~3 回合
  // 追猎也需要重新辨认来路，给现场转移与远端配合留出一步间隔。
  const interval = 2;
  if (e.hunting && (distToPlayer > 2 || state.player.breathHold)) {
    e.hunting = false; e.huntTarget = null; e.agitation = 0;
  }
  if (state.turn - e.lastMoveTurn < interval) return;
  e.lastMoveTurn = state.turn;

  const options = adjacency(state, e.room).filter(
    ({ door }) => !door.braced && (door.status === 'open' || door.status === 'closed'),
  );
  if (!options.length) return;

  let target: number;
  // 持续跟踪逻辑：如果处于 hunting 状态且有目标，坚定地沿着最短路追赶！
  if (e.hunting && e.huntTarget !== null) {
    const toward = options
      .slice()
      .sort((a, b) => distance(state, a.room.id, e.huntTarget!) - distance(state, b.room.id, e.huntTarget!));
    // 85% 概率精准扑向玩家方向
    if (rng.chance(0.85)) {
      target = toward[0].room.id;
    } else {
      target = rng.pick(options).room.id;
    }
    // 如果玩家屏息并且已经甩开距离，它小概率失去嗅觉踪迹（追猎更执着）
    if (state.player.breathHold && distToPlayer >= 2 && rng.chance(0.35)) {
      e.hunting = false;
      e.huntTarget = null;
      pushLog(state, 'field', '你屏住呼吸一动不动。隔壁那头生物在门口徘徊了一会儿，嗅探的声音渐渐远了。');
    }
  } else if (e.agitation >= 2 && rng.chance(0.75)) {
    const toward = options
      .slice()
      .sort((a, b) => distance(state, a.room.id, state.player.room) - distance(state, b.room.id, state.player.room));
    target = toward[0].room.id;
  } else if (e.nature === 'warmth' && rng.chance(0.7)) {
    // 追热：优先去通电或有热源的舱
    const warm = options.filter(
      ({ room }) => state.zones[room.zone].powered || (room.hazard?.active && ['arc', 'radiation'].includes(room.hazard.kind)),
    );
    target = (warm.length ? rng.pick(warm) : rng.pick(options)).room.id;
  } else if (e.nature === 'drift' && rng.chance(0.7)) {
    // 随流：被真空/低压舱吸引
    const pull = options.filter(({ room }) => room.hazard?.active && room.hazard.kind === 'vacuum');
    target = (pull.length ? rng.pick(pull) : rng.pick(options)).room.id;
  } else {
    // echo / unknown 平静时游荡
    if (e.nature === 'echo' && e.agitation === 0 && rng.chance(0.55)) {
      target = e.room;
    } else {
      target = rng.pick(options).room.id;
    }
  }

  e.room = target;
  if (e.agitation > 0 && rng.chance(0.25)) e.agitation -= 1;

  if (e.room === state.player.room) {
    if (state.player.quietSteps > 0) {
      state.player.quietSteps = 0;
      e.lastHitTurn = state.turn;
      const escape = adjacency(state, e.room).filter(({ door }) => !door.braced && (door.status === 'open' || door.status === 'closed'));
      if (escape.length) e.room = rng.pick(escape).room.id;
      e.agitation = 0;
      pushLog(state, 'field', '你认出了刚才听见的摩擦声，提前避到门框后。那东西擦过去了，护服没有受损。静听预判已消耗。', true);
      return;
    }
    if (state.turn - e.lastHitTurn < 5) {
      pushLog(state, 'field', '那东西又贴了过来。你屏住呼吸，沿着舱壁挪开了一点。');
      return;
    }
    e.lastHitTurn = state.turn;
    state.player.health = Math.max(0, state.player.health - 15);
    state.oxygen = Math.max(0, state.oxygen - 4);
    state.player.suitLeak = Math.min(1, state.player.suitLeak + 0.2);
    state.integrity = Math.max(0, state.integrity - 2);
    pushLog(
      state,
      'alert',
      '有什么庞然巨物从黑暗里狂扑而来！头盔与胸甲被重重撞击（生命值 -15），护服接缝发出刺耳的嘶鸣！',
      true,
      'field',
    );
    danger(state, '与未知目标正面遭遇', 9);
    physicalCue(state, 'suit', '防护服被划破。氧气泄漏，需要密封胶。');
    // 撞击之后它自己也退开了
    const away = adjacency(state, e.room).filter(({ door }) => !door.braced && (door.status === 'open' || door.status === 'closed'));
    if (away.length) e.room = rng.pick(away).room.id;
    e.agitation = 1;
    pushLog(state, 'field', '它退回了黑暗里，声音在另一侧的通道里越来越远。');
  } else if (adjacency(state, state.player.room).some((a) => a.room.id === e.room)) {
    const dir = directionOf(state, state.player.room, e.room);
    if (!state.pendingKnock && state.turn % 4 === 0) {
      pushLog(state, 'field', `${dir}传来金属被缓慢推开的声音，很沉。`);
    }
  }
}

/** 相对方位（东/西/南/北），用于敲击与声音定向。 */
function directionOf(state: GameState, from: number, to: number): string {
  const a = getRoom(state, from);
  const b = getRoom(state, to);
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) return b.x > a.x ? '东侧' : '西侧';
  return b.y > a.y ? '南侧' : '北侧';
}

function distance(state: GameState, from: number, to: number): number {
  const dist: Record<number, number> = { [from]: 0 };
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) return dist[cur];
    for (const { room, door } of adjacency(state, cur)) {
      if (door.braced || door.status === 'locked' || door.status === 'jammed') continue;
      if (dist[room.id] === undefined) {
        dist[room.id] = dist[cur] + 1;
        q.push(room.id);
      }
    }
  }
  return 99;
}

function maybeAlert(state: GameState, rng: RNG) {
  if (state.alerts.length > 14) state.alerts.shift();
  const rooms = state.rooms;
  const r = rng.pick(rooms);
  const pool: { text: string; fake: boolean }[] = [];
  if (r.hazard?.active && r.hazard.kind === 'vacuum') pool.push({ text: `${shortRoom(r)}压力持续下降`, fake: false });
  if (r.hazard?.active && r.hazard.kind === 'radiation') pool.push({ text: `${shortRoom(r)}电离剂量高于基线`, fake: false });
  if (state.entity.exists && state.entity.agitation >= 2)
    pool.push({ text: '低频信号强度上升，来源仍不明确', fake: false });
  pool.push({ text: `${shortRoom(r)}出现间歇性热源，特征无法归类`, fake: !r.hazard?.active && state.entity.room !== r.id });
  pool.push({ text: `${shortRoom(r)}的舱门开合记录与实际状态不符`, fake: rng.chance(0.6) });
  // 负载尖峰与"追热本质"真实挂钩：当它正待在通电舱里，尖峰是真的——它在用这座站的系统。
  const entityRoom = state.entity.exists ? getRoom(state, state.entity.room) : null;
  const feedingOnStation =
    state.entity.exists && state.entity.nature === 'warmth' && entityRoom !== null && state.zones[entityRoom.zone].powered;
  pool.push({
    text: '生命维持回路出现一次无法解释的负载尖峰',
    fake: feedingOnStation ? false : rng.chance(0.6),
  });
  const pick = rng.pick(pool);
  state.alertSeq += 1;
  state.alerts.push({ id: state.alertSeq, turn: state.turn, text: pick.text, fake: pick.fake });
}

function randomEvent(state: GameState, rng: RNG) {
  const roll = rng.int(100);
  const rooms = state.rooms;
  if (rng.chance(0.45)) maybeAlert(state, rng);
  if (roll < 16) {
    const r = rng.pick(rooms);
    state.integrity = Math.max(0, state.integrity - 3);
    pushLog(state, 'alert', `${shortRoom(r)}方向传来结构震动，站体完整度下降。`);
    physicalCue(state, 'tremor', '舱壁的震动沿着扶手传到手套上。');
    danger(state, `${shortRoom(r)}附近结构震动`, 4);
  } else if (roll < 30) {
    const on = Object.values(state.zones).filter((z) => z.powered && state.turn > (z.stableUntilTurn ?? 0));
    if (on.length) {
      const z = rng.pick(on);
      z.powered = false;
      pushLog(state, 'alert', `${z.id} 区配电柜跳闸，该区失去供电。`);
      if (getRoom(state, state.player.room).zone === z.id) {
        pushLog(state, 'field', '照明骤然熄灭，通风声也停了。');
        physicalCue(state, 'lamp', '灯管缓慢暗下去，头灯仍在。');
      }
    }
  } else if (roll < 42) {
    const cand = Object.values(state.doors).filter((d) => d.status !== 'jammed' && !d.braced &&
      !(state.zones[getRoom(state, d.a).zone].breakerDamaged && state.zones[getRoom(state, d.b).zone].breakerDamaged));
    if (cand.length) {
      const d = rng.pick(cand);
      d.status = 'locked';
      pushLog(state, 'alert', `${doorLabel(d)}触发自锁程序。`);
      if (getRoom(state, state.player.room).doors.includes(d.id))
        pushLog(state, 'field', `你面前的${doorLabel(d)}发出沉闷的锁死声。`);
    }
  } else if (roll < 54) {
    const cand = rooms.filter((r) => r.sensor === 'ok');
    if (cand.length) {
      const r = rng.pick(cand);
      r.sensor = rng.pick(['damaged', 'jammed', 'delayed'] as const);
      pushLog(state, 'remote', `${shortRoom(r)}的传感器回路出现异常，读数可信度下降。`);
    }
  } else if (roll < 64) {
    state.oxygen = Math.max(0, state.oxygen - 4);
    pushLog(state, 'alert', '一段氧气管路失压，储量直接掉了一截。');
    danger(state, '氧气管路失压', 5);
  } else if (roll < 74) {
    noise(state, 3);
    pushLog(state, 'remote', '低频信号强度上升，某种东西开始移动得更频繁。');
  } else if (roll < 82) {
    state.commDelay = 3;
    pushLog(state, 'remote', '远端数据链出现延迟，接下来几回合的读数可能是旧的。');
    physicalCue(state, 'signal', '链路指示短暂停顿，消息已原样送达。');
  } else if (roll < 90) {
    const r = rng.pick(rooms);
    r.visualNoise = true;
    pushLog(state, 'system', `${shortRoom(r)}内出现冷凝雾，肉眼观察将变得不可靠。`);
  } else if (roll < 96) {
    state.power = Math.min(130, state.power + 9);
    pushLog(state, 'remote', '一组备用电容自检完成，电力储备略有回升。');
  } else {
    const cand = rooms.filter((r) => r.sensor !== 'ok');
    if (cand.length) {
      const r = rng.pick(cand);
      r.sensor = 'ok';
      pushLog(state, 'remote', `${shortRoom(r)}的传感器完成自检，恢复正常上报。`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  信息冲突 / 协作统计                                                 */
/* ------------------------------------------------------------------ */

export function registerConflict(state: GameState, room: Room, reading: RemoteReading) {
  if (!room.visited || room.fieldVerdict === null || room.fieldVerdict === 'unknown') return;
  const remoteDanger = reading.hazard || reading.life;
  const fieldDanger = room.fieldVerdict === 'danger';
  if (remoteDanger !== fieldDanger) {
    state.stats.conflicts += 1;
    state.stats.conflictNotes.push(
      remoteDanger
        ? `第 ${state.turn} 回合：${shortRoom(room)}——现场判断安全，远端读数显示异常。`
        : `第 ${state.turn} 回合：${shortRoom(room)}——现场看到异常，远端读数显示一切正常。`,
    );
  }
}

function assist(state: GameState, note: string) {
  state.stats.assists += 1;
  state.stats.assistNotes.push(`第 ${state.turn} 回合：${note}`);
}

/* ------------------------------------------------------------------ */
/*  现场行动                                                            */
/* ------------------------------------------------------------------ */

export function observeRoom(state: GameState, room: Room) {
  room.visited = true;
  const rng = rngOf(state);
  const dark = !state.zones[room.zone].powered && !hasItem(state, 'torchcell');
  if (room.hazard?.active && !room.hazard.visualHidden) {
    room.fieldVerdict = 'danger';
    pushLog(state, 'field', hazardLine(room.hazard.kind, true, state.turn * 31 + room.id), true);
  } else if (state.entity.exists && state.entity.room === room.id) {
    room.fieldVerdict = 'danger';
  } else if (room.visualNoise || dark) {
    room.fieldVerdict = 'unknown';
    pushLog(
      state,
      'field',
      dark ? rng.pick(DARK_LINES) : rng.pick(FOG_LINES),
    );
  } else {
    room.fieldVerdict = 'safe';
    if (room.hazard?.active) {
      pushLog(state, 'field', hazardLine(room.hazard.kind, false, state.turn * 17 + room.id));
    } else {
      pushLog(state, 'field', rng.pick(CALM_ROOM_LINES));
    }
  }
  if (room.sensor !== 'ok' && !room.sensorClueFound && rng.chance(0.5)) {
    room.sensorClueFound = true;
    pushLog(state, 'field', SENSOR_CLUES[room.sensor], true);
  }
  saveRng(state, rng);
}

export function fieldMove(state: GameState, targetId: number): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const link = adjacency(state, state.player.room).find((a) => a.room.id === targetId);
  if (!link) return '两舱之间没有直接通道。';
  const { door, room } = link;
  door.seen = true;
  let cost = 1;
  if (door.braced) {
    return `${doorLabel(door)}被压差楔顶住了。先把楔子取下，才能通过。`;
  }
  if (door.status === 'locked') {
    if (!door.remoteBroken) {
      return `${doorLabel(door)}处于锁定状态。只有远端能解除锁定——把门号告诉你的搭档。`;
    }
    if (!hasItem(state, 'crowbar')) {
      return `${doorLabel(door)}锁死且控制回路已损坏，远端也帮不上忙。需要液压撬棍。`;
    }
    cost = 3;
    door.status = 'open';
    state.integrity = Math.max(0, state.integrity - 2);
    noise(state, 4);
    pushLog(state, 'field', `锁扣被撬棍生生掰断，${doorLabel(door)}的门框跟着变形了。声音传得很远。`, true);
    decision(state, `强行破坏了失控的${doorLabel(door)}`);
  }
  if (door.status === 'jammed') {
    if (!hasItem(state, 'crowbar')) return `${doorLabel(door)}被结构变形卡死，需要液压撬棍。`;
    cost = 2;
    door.status = 'open';
    noise(state, 3);
    pushLog(state, 'field', `你把撬棍插进${doorLabel(door)}的缝隙，金属在整条走廊里回响。`, true);
    decision(state, `强行撬开${doorLabel(door)}`);
  } else if (door.status === 'closed') {
    if (!state.zones[room.zone].powered && !state.zones[getRoom(state, state.player.room).zone].powered) {
      if (hasItem(state, 'crowbar')) {
        cost = 1;
        noise(state, 3);
        pushLog(state, 'field', `断电的${doorLabel(door)}被撬棍一下顶开，声音很大。`);
      } else {
        cost = 2;
        noise(state, 2);
        pushLog(
          state,
          'field',
          `没有电，你摸黑找到手动摇柄，一圈一圈把${doorLabel(door)}摇开。很慢，也很响。`,
        );
      }
    }
    door.status = 'open';
  }
  const entryTurn = state.turn;
  const evidence: string[] = [];
  const scan = room.lastScan;
  if (door.remoteUnlockTurn !== null && state.turn - door.remoteUnlockTurn <= 25) {
    evidence.push(`远端解锁${doorLabel(door)}`);
    door.remoteUnlockTurn = null;
  }
  if (scan) evidence.push(`第 ${scan.turn} 回合的${scan.fromDrone ? '无人机' : '传感器'}读数（进入时已过 ${entryTurn - scan.turn} 回合）`);
  const unsafeOnEntry = !!room.hazard?.active || (state.entity.exists && state.entity.room === room.id);
  const healthBefore = state.player.health;
  const first = !room.visited;
  if (state.pendingKnock) state.pendingKnock = null;
  state.player.room = room.id;
  if (state.departureGrace?.until === null && room.id !== state.departureGrace.room) {
    state.departureGrace.until = state.turn + cost + 4;
    pushLog(state, 'field', '你离开了出生舱的安全准备区。通行后的四个回合内目标不会主动接近；随后保护结束，留意来路与退路。', true);
  }
  state.sonar = null;
  pushLog(state, 'field', `${MOVE_LINES[(state.turn + room.id) % MOVE_LINES.length]}${roomLabel(room)}。`);
  observeRoom(state, room);
  onRoomEntered(state, !first);
  const quietMove = state.player.quietSteps > 0;
  if (!quietMove) noise(state, 1);
  if (first && room.feature === 'maintenance') {
    state.flags.altRoute = true;
  }
  advance(state, cost);
  const encountered = unsafeOnEntry || state.player.health < healthBefore;
  if (evidence.length) {
    const safeReading = scan && !scan.life && !scan.motion && !scan.hazard;
    const outcome = encountered && safeReading
      ? entryTurn - scan.turn > SAFE_READING_MAX_AGE ? 'stale'
        : state.stats.scanTruth?.[`${room.id}:${scan.turn}`] === false ? 'distorted' : 'changed'
      : 'success';
    if (!encountered || safeReading) {
      (state.stats.trustEvents ??= []).push({ turn: entryTurn, room: room.id, evidence, outcome, sampleTurn: scan?.turn });
      const note = `第 ${entryTurn} 回合：进入${shortRoom(room)}；依据：${evidence.join('；')}`;
      if (!encountered) {
        state.stats.assists += 1;
        state.stats.assistNotes.push(note);
      } else {
        const label = outcome === 'stale' ? '过期安全情报后遇险' : outcome === 'distorted' ? '失真安全读数后遇险' : '采样后环境变化或真值未留存';
        state.stats.misjudgeNotes.push(`${note}；${label}`);
      }
    }
  }
  if (quietMove) state.player.quietSteps = Math.max(0, state.player.quietSteps - 1);
  return '';
}

export function fieldSearch(state: GameState): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const room = getRoom(state, state.player.room);
  if (room.searched) {
    return '本舱已经翻找完毕。没有扣除回合或氧气。';
  }
  state.stats.searches += 1;
  room.searched = true;
  const found = room.hiddenItems.splice(0, room.hiddenItems.length);
  room.items.push(...found);
  if (found.length) {
    pushLog(state, 'field', `搜索后找到：${found.map((f) => ITEMS[f].name).join('、')}。`);
  } else {
    pushLog(state, 'field', SEARCH_EMPTY_LINES[(state.turn + room.id) % SEARCH_EMPTY_LINES.length]);
  }
  if (room.clue) {
    pushLog(state, 'field', room.clue, true);
    onClueLifted(state);
  }
  if (room.relic && !room.relicFound) {
    const relic = RELICS[room.relic];
    room.relicFound = true;
    state.recoveredRelics.push(relic.id);
    pushLog(state, 'field', `${relic.title}。${relic.text}`, true);
    decision(state, `在${shortRoom(room)}找到了${relic.title.replace('遗留物：', '').replace('彩蛋：', '')}`);
  }
  if (room.sensor !== 'ok' && !room.sensorClueFound) {
    room.sensorClueFound = true;
    pushLog(state, 'field', SENSOR_CLUES[room.sensor], true);
  }
  if (room.hazard?.active && room.hazard.visualHidden) {
    const rng = rngOf(state);
    // 呼吸稳定时手更稳、看得更细，更容易发现隐藏危险
    if (rng.chance(state.player.composure >= 60 ? 0.85 : 0.6)) {
      room.hazard.visualHidden = false;
      room.fieldVerdict = 'danger';
      pushLog(state, 'field', `仔细检查后你确认了危险：${hazardLine(room.hazard.kind, true, state.turn + room.id)}`, true);
    }
    saveRng(state, rng);
  }
  noise(state, 1);
  advance(state, 1);
  return '';
}

export function fieldPickup(state: GameState, item: string): string {
  const room = getRoom(state, state.player.room);
  const i = room.items.indexOf(item);
  if (i < 0) return '这里没有这件物品。';
  if (state.player.inventory.length >= state.player.capacity) return '背包已满，需要先放下一件东西。';
  room.items.splice(i, 1);
  state.player.inventory.push(item);
  pushLog(state, 'field', `你拿起了${ITEMS[item].name}。`);
  return '';
}

export function fieldDrop(state: GameState, index: number, expectedItem?: string): string {
  const item = state.player.inventory[index];
  if (!item || (expectedItem !== undefined && item !== expectedItem)) return '背包物品已变化，请重新选择要放下的物品。';
  state.player.inventory.splice(index, 1);
  getRoom(state, state.player.room).items.push(item);
  pushLog(state, 'field', `你把${ITEMS[item].name}放在了地上。`);
  return '';
}

export function fieldUse(state: GameState, item: string): string {
  if (state.status !== 'playing') return '任务已经结束。';
  if (!hasItem(state, item)) return '背包里没有这件物品。';
  const room = getRoom(state, state.player.room);
  switch (item) {
    case 'o2': {
      if (state.oxygen >= 99) return '氧气仍然充足，先保留这只备用罐。';
      const rng = rngOf(state);
      // 氧气罐充气量具有随机残压 (9% ~ 23%)
      const gain = rng.range(9, 23);
      state.oxygen = Math.min(100, state.oxygen + gain);
      removeItem(state, item);
      saveRng(state, rng);
      pushLog(state, 'field', `氧气罐接入护服（充入约 ${gain}% 氧气），呼吸阻力稍微减轻。`, true);
      decision(state, `使用了一支备用氧气罐（补氧 ${gain}%）`);
      break;
    }
    case 'battery':
      state.power = Math.min(130, state.power + 22);
      removeItem(state, item);
      pushLog(state, 'field', '你把储能电池并入配线盒，远端应该能看到电力回升。', true);
      break;
    case 'sealant':
      if (state.player.suitLeak > 0) {
        state.player.suitLeak = 0;
        state.player.health = Math.min(100, state.player.health + 8);
        pushLog(state, 'field', '密封胶糊住了护服的破口，泄漏停止了，伤口也被泡沫固定住（生命 +8）。', true);
      } else {
        pushLog(state, 'field', '你用密封胶封住了舱壁上的一道细缝。');
      }
      state.integrity = Math.min(100, state.integrity + 4);
      removeItem(state, item);
      break;
    case 'adrenaline':
      state.player.health = Math.min(100, state.player.health + 40);
      state.player.composure = Math.min(100, state.player.composure + 25);
      removeItem(state, item);
      pushLog(state, 'field', '你把肾上腺素扎进大腿。心跳像战鼓一样擂起来，剧痛被强行压了下去（生命 +40，呼吸控制 +25）。', true);
      decision(state, '注射了肾上腺素，强行压制了伤势');
      break;
    case 'energygel':
      state.player.health = Math.min(100, state.player.health + 20);
      state.player.composure = Math.min(100, state.player.composure + 15);
      removeItem(state, item);
      pushLog(state, 'field', '你撕开能量胶挤进嘴里，甜腻的暖流顺着喉咙烧下去（生命 +20，呼吸控制 +15）。', true);
      break;
    case 'relay':
      for (const r of state.rooms) if (r.zone === room.zone) r.sensor = 'ok';
      removeItem(state, item);
      pushLog(state, 'field', `中继器在${room.zone} 区展开，本区传感器重新校准。`, true);
      decision(state, `在 ${room.zone} 区部署了信号中继器`);
      break;
    case 'schema': {
      state.flags.altRoute = true;
      // 揭示全站盲区与隐藏结构
      const blind = state.rooms.filter((r) => r.sensor !== 'ok');
      pushLog(
        state,
        'field',
        `【研读线路图】标出了隐藏检修通道；并标注盲区回路：${blind.slice(0, 3).map((r) => shortRoom(r)).join('、') || '全站回路正常'}。`,
        true,
      );
      decision(state, '对照研读了维修线路图，获得了空间站检修暗道坐标');
      break;
    }
    case 'torchcell':
      for (const r of state.rooms) r.visualNoise = false;
      pushLog(state, 'field', '头灯换上高能锂电核心，强光光锥穿透冷凝雾，全站断电与冷凝盲区均可清晰识别！', true);
      decision(state, '更换了头灯高能电池');
      break;
    case 'recorder': {
      const rng = rngOf(state);
      state.player.composure = Math.min(100, state.player.composure + 45);
      state.player.health = Math.min(100, state.player.health + 8);
      const lines = [
        '录音机里传来热茶倒进杯子的微弱流水声，熟悉的生活噪音让狂跳的心率逐渐平息。（呼吸控制 +45%，生命轻微回升 +8）',
        '磁带里录着事故前交接班的笑声，那些日常对话驱散了绝境中的恐慌。（呼吸控制 +45%）',
        '播放到最后，只有一段平稳而规律的深呼吸。你跟着那段节奏调整了自己的换气。（呼吸控制 +45%）',
      ];
      pushLog(state, 'field', rng.pick(lines), true);
      state.entity.agitation = Math.max(0, state.entity.agitation - 2);
      saveRng(state, rng);
      decision(state, '播放了微型录音机，平复了恐慌与心跳');
      break;
    }
    case 'charm':
      state.player.composure = Math.min(100, state.player.composure + 30);
      pushLog(state, 'field', '你把刻着老班组名字的旧工牌扣在胸前。金属的冰凉触感带来了一种奇异的踏实感。（呼吸控制 +30%）', true);
      state.entity.agitation = Math.max(0, state.entity.agitation - 1);
      decision(state, '将旧工牌扣在护服胸前');
      break;
    default:
      return '这件物品无法直接使用。';
  }
  advance(state, 1);
  return '';
}

/**
 * 静听：贴着舱壁分辨声音来源。
 * 明确收益：给出「方位 + 距离 + 性质」的结构化情报，并写入地图方位指示；
 * 同时小幅回升镇定。这是现场员独有、远端永远拿不到的信息。
 */
export function fieldListen(state: GameState): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const room = getRoom(state, state.player.room);
  if (state.sonar?.originRoom === room.id && state.turn - state.sonar.turn <= 1) {
    return '刚刚听过，线索仍在地图上。没有扣除回合。';
  }
  const rng = rngOf(state);
  room.listened = true;
  state.player.composure = Math.min(100, state.player.composure + 12);
  state.player.quietSteps = 2;

  const setSonar = (dir: string, distance: number, label: string, dangerous: boolean) => {
    const direction = adjacency(state, room.id).find(({ room: r }) => directionFrom(state, room.id, r.id) === dir);
    state.sonar = { dir, distance, label, turn: state.turn, danger: dangerous, originRoom: room.id, doorId: dangerous ? direction?.door.id : undefined };
  };

  // 1) 优先分辨移动目标：能给出方位与大致距离
  if (state.entity.exists) {
    const d = topoDistance(state, room.id, state.entity.room);
    if (d === 0) {
      setSonar('本舱', 0, '就在这一舱内', true);
      pushLog(state, 'field', '声音不是从通道传来的。它和你在同一个舱室里。', true);
      danger(state, '静听确认未知目标与现场员同舱', 8);
      saveRng(state, rng);
      advance(state, 1);
      return '';
    }
    if (d <= 2) {
      const dir = directionFrom(state, room.id, state.entity.room);
      setSonar(dir, d, d === 1 ? '缓慢移动的重物，很近' : '有节奏的金属摩擦声', true);
      pushLog(
        state,
        'field',
        d === 1
          ? `${dir}方向，一墙之隔。有东西在慢慢挪动，中间停顿了两次。`
          : `${dir}方向大约两个舱段外，有规律的摩擦声，正在移动。`,
        true,
      );
      danger(state, `静听定位：${dir}方向 ${d} 段外存在移动目标`, d === 1 ? 5 : 3);
      saveRng(state, rng);
      advance(state, 1);
      return '';
    }
  }

  // 2) 其次分辨环境危险：听出的是"下一舱能不能进"
  const hazardNeighbor = adjacency(state, room.id).find(({ room: r }) => r.hazard?.active);
  if (room.hazard?.active && room.hazard.kind === 'vacuum') {
    setSonar('本舱', 0, '细微的漏气哨声', true);
    pushLog(state, 'field', '你把耳朵贴上舱壁。某处有极细的哨声，空气正从一个针孔大的地方被抽走。', true);
  } else if (room.hazard?.active && room.hazard.kind === 'arc' && state.zones[room.zone].powered) {
    setSonar('本舱', 0, '规律的放电噼啪声', true);
    pushLog(state, 'field', '噼啪声很规律。每次停顿之前，金属扶手都会轻轻发颤——这条支路还带着电。', true);
  } else if (hazardNeighbor && rng.chance(0.75)) {
    const dir = directionFrom(state, room.id, hazardNeighbor.room.id);
    const kind = hazardNeighbor.room.hazard!.kind;
    const label =
      kind === 'vacuum' ? '持续的漏气声' : kind === 'arc' ? '断续的放电声' : kind === 'cold' ? '管路结冰的爆裂声' : '结构受力的呻吟';
    setSonar(dir, 1, label, true);
    pushLog(state, 'field', `${dir}方向的舱门后面传来${label}。那一舱现在不适合直接进去。`, true);
  } else if (room.visualNoise && rng.chance(0.5)) {
    setSonar('不明', 0, '回声互相干扰，无法定向', false);
    pushLog(state, 'field', '冷凝雾让每一处细响都像从很远的地方传来。这一次你分辨不出方向。');
  } else {
    // 3) 什么都没有，也是有价值的情报：确认周边暂时安静
    setSonar('周边', 2, '两个舱段内没有移动源', false);
    pushLog(state, 'field', rng.pick(LISTENING_LINES));
    pushLog(state, 'field', '至少在两个舱段之内，没有正在移动的东西。', true);
  }
  state.entity.agitation = Math.max(0, state.entity.agitation - 1);
  saveRng(state, rng);
  advance(state, 1);
  return '';
}

/** 明确由现场员发出的口述，才会被共享给远程席；不会泄漏任何未主动说出的现场信息。 */
export function fieldTransmit(state: GameState, text: string): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!clean) return '先写一句要发送的话。';
  state.transmissionSeq += 1;
  state.transmissions.push({ id: state.transmissionSeq, turn: state.turn, source: 'field', text: clean });
  if (state.transmissions.length > 40) state.transmissions.splice(0, state.transmissions.length - 40);
  pushLog(state, 'field', `你向远程席发送：${clean}`, true);
  state.log[state.log.length - 1].transmissionId = state.transmissionSeq;
  return '';
}

export const PING_LABEL: Record<PingKind, string> = {
  help: '需要支援',
  scan: '请求扫描',
  danger: '危险',
  note: '注意',
};

/**
 * 地图标记：现场员在地图上钉一枚对远程席可见的标记。
 * 通讯行为，不消耗回合、不消耗资源，随时可用。
 */
export function fieldPing(state: GameState, roomId: number, kind: PingKind, note = '', remove = false): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return '找不到这个舱室。';
  const label = `${room.id} 号${room.name}`;
  if (remove) {
    const before = state.pings.length;
    state.pings = state.pings.filter((p) => !(p.room === roomId && p.from === 'field'));
    if (state.pings.length === before) return '这里没有你的标记。';
    pushLog(state, 'field', `你擦掉了 ${label} 的标记。`);
    return '';
  }
  if (!PING_LABEL[kind]) return '未知的标记类型。';
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 60);
  state.pings = state.pings.filter((p) => !(p.room === roomId && p.from === 'field' && p.kind === kind));
  state.pingSeq += 1;
  state.pings.push({ id: state.pingSeq, room: roomId, kind, note: clean, from: 'field', turn: state.turn });
  while (state.pings.length > 12) state.pings.shift();
  pushLog(state, 'field', `你在地图上标记了 ${label}：${PING_LABEL[kind]}${clean ? `——${clean}` : ''}。`, true);
  if (kind === 'danger') onDangerMarked(state, roomId);
  return '';
}

/**
 * 远程席留言：AI 操作员说给现场员听的话。
 * 进入共享通讯记录，双方可见；不消耗回合与电力。
 */
export function operatorSay(state: GameState, text: string, name = '远程操作员'): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) return '消息为空。';
  state.transmissionSeq += 1;
  state.transmissions.push({ id: state.transmissionSeq, turn: state.turn, source: 'operator', text: clean });
  if (state.transmissions.length > 40) state.transmissions.splice(0, state.transmissions.length - 40);
  pushLog(state, 'system', `远程操作员「${name}」：${clean}`, true);
  state.log[state.log.length - 1].transmissionId = state.transmissionSeq;
  return `已发送：第 ${state.turn} 回合「${clean}」`;
}

/** 远程席地图标记：AI 在地图上给现场员钉标记，同样免费。 */
export function operatorPing(state: GameState, roomId: number, kind: PingKind, note = ''): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return '找不到这个舱室。';
  if (!PING_LABEL[kind]) return '未知的标记类型。';
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 60);
  state.pings = state.pings.filter((p) => !(p.room === roomId && p.from === 'operator' && p.kind === kind));
  state.pingSeq += 1;
  state.pings.push({ id: state.pingSeq, room: roomId, kind, note: clean, from: 'operator', turn: state.turn });
  while (state.pings.length > 12) state.pings.shift();
  const label = `${room.id} 号${room.name}`;
  pushLog(state, 'system', `远程席在地图上标记了 ${label}：${PING_LABEL[kind]}${clean ? `——${clean}` : ''}。`, true);
  return `已标记 ${label}：${PING_LABEL[kind]}${clean ? `——${clean}` : ''}`;
}

/** 用压差楔手动封门，阻止未知目标与远端误操作；取下后可重复使用。 */
export function fieldBraceDoor(state: GameState, doorId: string, remove = false): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const door = state.doors[doorId];
  if (!door) return '找不到这扇舱门。';
  if (door.a !== state.player.room && door.b !== state.player.room) return '压差楔只能安装在你身边的舱门上。';
  if (remove) {
    if (!door.braced) return '这扇门没有安装压差楔。';
    if (state.player.inventory.length >= state.player.capacity) return '背包已满，无法收回压差楔。';
    door.braced = false;
    state.player.inventory.push('wedge');
    pushLog(state, 'field', `你从${doorLabel(door)}上取下压差楔，门锁重新可以响应。`, true);
    advance(state, 1);
    return '';
  }
  if (door.braced) return `${doorLabel(door)}已经被压差楔顶住。`;
  if (!hasItem(state, 'wedge')) return '你没有可用的压差楔。';
  if (door.status === 'locked' || door.status === 'jammed') return '门轨尚未释放。先解锁或撬开，再安装压差楔。';
  if (door.status === 'open') {
    door.status = 'closed';
    pushLog(state, 'field', `你先把${doorLabel(door)}手动拉回闭合位置。`);
  }
  removeItem(state, 'wedge');
  door.braced = true;
  door.status = 'closed';
  noise(state, 1);
  pushLog(state, 'field', `压差楔咬住了${doorLabel(door)}的门轨。至少暂时，没有东西能从这边推开它。`, true);
  decision(state, `用压差楔封住了${doorLabel(door)}`);
  advance(state, 1);
  return '';
}

/** 回应制造噪声，但不传送目标、不绕过舱门，也不给玩家强制伤害。 */
export function fieldAnswerKnock(state: GameState): string {
  if (state.status !== 'playing') return '任务已经结束。';
  if (!state.pendingKnock) return '现在没有需要回应的声音。';
  const knock = state.pendingKnock;
  if (knock.roomId !== state.player.room || state.turn > knock.expiresTurn) {
    state.pendingKnock = null;
    return '那一组敲击已经停了。';
  }
  state.pendingKnock = null;
  state.entity.answeredKnock = true;
  pushLog(state, 'field', '你用扳手在舱壁上敲了回去：三短，两长。', true);
  if (state.entity.exists) {
    state.entity.agitation = Math.min(8, state.entity.agitation + 3);
    state.entity.lastMoveTurn = state.turn + 1;
  }
  onKnockAnswered(state, state.player.room, knock.dir);
  decision(state, '回应了舱壁上的敲击声');
  advance(state, 1);
  return '';
}

/** 无视敲击：安全，但会累计一种"错过"的分量，进结局措辞。 */
export function fieldIgnoreKnock(state: GameState): string {
  if (state.status !== 'playing') return '任务已经结束。';
  if (!state.pendingKnock) return '现在没有需要回应的声音。';
  state.pendingKnock = null;
  state.knocksIgnored += 1;
  pushLog(state, 'field', '你握紧扳手，没有敲回去。声音敲了最后一下，然后再也没有响。', true);
  if (state.entity.exists && state.entity.nature === 'echo') {
    // echo 本质：没被回应就慢慢平静
    state.entity.agitation = Math.max(0, state.entity.agitation - 2);
  }
  decision(state, '选择无视了敲击声');
  return '';
}

export function fieldWait(state: GameState): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const rng = rngOf(state);
  state.player.breathHold = true;
  state.player.composure = Math.min(100, state.player.composure + 30);
  // 屏息时顺手处理伤口：缓慢但可再生的恢复手段
  if (state.player.health < 100) {
    state.player.health = Math.min(100, state.player.health + 5);
    pushLog(state, 'field', '你贴住舱壁，把呼吸压到最慢，顺手按住渗血的伤口包扎了一下（生命 +5）。面罩里的雾气退了一圈，耗氧明显降下来。', true);
  } else {
    pushLog(state, 'field', '你贴住舱壁，把呼吸压到最慢。面罩里的雾气退了一圈，耗氧明显降下来。', true);
  }
  onFieldStill(state);

  const e = state.entity;
  if (e.exists) {
    const before = e.agitation;
    e.agitation = Math.max(0, e.agitation - 3);
    e.hunting = false; // 屏息打断追猎
    e.huntTarget = null;
    const adjacent = adjacency(state, state.player.room).find((x) => x.room.id === e.room);
    if (adjacent) {
      if (rng.chance(0.75)) {
        const away = adjacency(state, e.room).filter(
          ({ door, room }) => !door.braced && room.id !== state.player.room && (door.status === 'open' || door.status === 'closed'),
        );
        if (away.length) {
          e.room = rng.pick(away).room.id;
          e.lastMoveTurn = state.turn;
          pushLog(state, 'field', '隔壁的动静停了几秒，然后慢慢往另一头去了。它没有找到你。', true);
        } else {
          pushLog(state, 'field', '隔壁的东西停住了。它没有再靠近，但也没有离开。', true);
        }
      } else {
        pushLog(state, 'field', '你屏住呼吸。隔着一道舱壁，那个东西也停了下来，像是在听。', true);
      }
    } else if (before > 0) {
      pushLog(state, 'field', '远处的响动一点点稀疏下去，站体重新安静。');
    }
  }
  saveRng(state, rng);
  advance(state, 1);
  return '';
}

/**
 * 现场员攻击未知目标
 * 规则：
 * - 只有当未知生物在同舱、或在身边相邻舱室时才能攻击。
 * - 武器选择与成功概率明确透明：
 *   1. 徒手搏击：命中率 30%。造成轻伤并暂时击退；失败承受反击、失氧与护服破损。
 *   2. 液压撬棍：需携带。命中率 65%。造成较重伤势，伤势累积延长休整；失败承受反扑。
 *   3. 喷射密封胶：需携带。命中率 85%。成功封堵感知并产生少量伤势，消耗密封胶；失败被反扑。
 */
/** 隐藏伤势换取完整的未来安全回合；奖励每局最多一次。 */
function woundEntity(state: GameState, damage: number, control: number, side: 'field' | 'remote') {
  const e = state.entity;
  const impact = e.room;
  e.vitality = Math.max(0, e.vitality - damage);
  const rest = e.vitality === 0 ? 10 : control + Math.floor((100 - e.vitality) / 25) * 2;
  e.stunnedTurns = Math.max(e.stunnedTurns, rest + 1); // 本次攻击结算不会吃掉承诺的未来回合
  e.agitation = 0; e.hunting = false; e.huntTarget = null;
  const visited = new Set([impact]);
  for (let step = 0; step < 2; step++) {
    const options = adjacency(state, e.room).filter(({ door, room }) =>
      !door.braced && ['open', 'closed'].includes(door.status) && !visited.has(room.id) && room.id !== state.player.room);
    options.sort((a, b) => distance(state, b.room.id, state.player.room) - distance(state, a.room.id, state.player.room));
    if (!options.length) break;
    e.room = options[0].room.id; visited.add(e.room);
  }
  if (e.vitality <= 40 && !e.salvageDropped) {
    e.salvageDropped = true;
    getRoom(state, impact).items.push('battery');
    pushLog(state, side, `撞击中，一块嵌在甲壳缝里的备用电池掉落在${shortRoom(getRoom(state, impact))}。需要现场员前往拾取。`, true);
  }
  const injury = e.vitality === 0 ? '目标重创，暂时失去行动能力' : e.vitality <= 40 ? '目标步态崩溃，拖行退避' : '目标负伤，停止追猎';
  pushLog(state, side, `${injury}。这次攻击结算后，至少有 ${rest} 回合不会主动行动；环境危险仍在。`, true);
  return rest;
}

export function canFieldAttack(state: GameState): boolean {
  return state.status === 'playing' && state.entity.exists && (
    state.entity.room === state.player.room || adjacency(state, state.player.room).some(
      (a) => a.room.id === state.entity.room && !a.door.braced && ['open', 'closed'].includes(a.door.status),
    )
  );
}

export function fieldAttack(state: GameState, weapon: 'fist' | 'crowbar' | 'sealant'): string {
  if (state.status !== 'playing') return '任务已经结束。';
  const here = state.player.room;
  const e = state.entity;
  if (!e.exists) {
    return '周围一片死寂，黑暗中没有任何可以攻击的目标。';
  }

  if (!canFieldAttack(state)) {
    return '未知生物距离太远，你的攻击无法触及。它仍在暗处移动。';
  }

  const rng = rngOf(state);
  let successRate = 0.3;
  let weaponName = '徒手搏击';

  if (weapon === 'crowbar') {
    if (!hasItem(state, 'crowbar')) {
      saveRng(state, rng);
      return '背包里没有液压撬棍。';
    }
    successRate = 0.65;
    weaponName = '液压撬棍重击';
  } else if (weapon === 'sealant') {
    if (!hasItem(state, 'sealant')) {
      saveRng(state, rng);
      return '背包里没有密封胶。';
    }
    successRate = 0.85;
    weaponName = '喷射密封胶';
  }

  const hit = rng.chance(successRate);
  decision(state, `在${shortRoom(getRoom(state, here))}对未知目标发动了【${weaponName}】（命中率 ${Math.round(successRate * 100)}%）：${hit ? '命中成功' : '攻击落空'}`);

  if (hit) {
    if (weapon === 'sealant') removeItem(state, 'sealant');
    const damage = weapon === 'crowbar' ? 30 : weapon === 'fist' ? 10 : 5;
    woundEntity(state, damage, weapon === 'sealant' ? 4 : weapon === 'crowbar' ? 2 : 1, 'field');
    pushLog(state, 'field', `【攻击命中】${weaponName}迫使目标退缩。抓紧这个空当转移、治疗或修复设备。`, true);
  } else if (e.stunnedTurns > 0) {
    pushLog(state, 'field', '【攻击落空】你挥空了，仍在退避休整的目标没有反扑。保留这个喘息窗口，尽快转移。', true);
  } else {
    // 攻击失败，承受反扑（数值已回调：不再一击致残）
    physicalCue(state, 'suit', '反击失败！护服被利爪重重扯开，面罩红光警报狂鸣！');
    state.player.health = Math.max(0, state.player.health - 18);
    state.oxygen = Math.max(0, state.oxygen - 5);
    state.player.suitLeak = Math.min(1.0, state.player.suitLeak + 0.25);
    state.integrity = Math.max(0, state.integrity - 2);
    e.hunting = true;
    e.huntTarget = here;
    // 反扑已经结算一次伤害，不再在紧接着的环境推进中叠加普通扑击。
    e.lastHitTurn = state.turn + 1;
    e.agitation = Math.min(8, e.agitation + 2);
    pushLog(state, 'alert', `【反击失败】你的${weaponName}落空了！黑暗里的阴影速度快得惊人，利爪直接顺着你的头盔肩缝划过，带起一串灼热的火花和氧气狂泄的白雾！（生命值 -18）`, true, 'field');
    danger(state, `反击失败，承受反扑伤害（生命 -18，氧气 -5%，护服泄漏增加）`, 8);
  }

  saveRng(state, rng);
  advance(state, 1);
  return '';
}

/**
 * 远程操作员使用无人机进行战术冲击 / 自杀式电磁爆震
 * 命中率 75%，消耗 15 点电力；
 * 仅近距离有效目标可命中；隐藏伤势累积延长退避；
 * 但无人机有 40% 概率损毁失联！
 */
export function operatorDroneAttack(state: GameState, targetRoom?: number): CommandResult {
  if (state.status !== 'playing') return { ok: false, receipt: '任务已经结束。', turns: 0 };
  if (state.drone.lost || state.drone.charge <= 0) return { ok: false, receipt: '无人机失联或电量耗尽，冲击未执行。', turns: 0 };
  const target = targetRoom ?? state.drone.room;
  if (!state.rooms.some(r => r.id === target)) return { ok: false, receipt: '目标舱室不存在，冲击未执行。', turns: 0 };
  const path = findPath(state, state.drone.room, target);
  if (!path || path.length > 1) return { ok: false, receipt: '冲击只覆盖无人机当前舱或可通行的相邻舱。请先调动无人机。', turns: 0 };
  if (state.power < 15 || state.drone.charge < path.length + 1) return { ok: false, receipt: '冲击所需电力或无人机电量不足，未执行。', turns: 0 };
  const rng = rngOf(state);
  state.power -= 15; state.stats.remoteCommands += 1;
  state.drone.room = target; state.drone.charge -= path.length + 1;
  const hit = state.entity.exists && state.entity.room === target && rng.chance(0.75);
  let receipt = '';
  if (hit) {
    const rest = woundEntity(state, 45, 2, 'remote');
    receipt = `冲击已执行并命中，目标负伤退避；结算后至少 ${rest} 回合不会主动行动（电力 -15）。`;
  } else {
    receipt = '冲击已执行，但本次未确认命中（电力 -15，推进 1 回合）。这不证明目标不存在或该舱安全。';
  }
  pushLog(state, 'remote', receipt, true);
  if (rng.chance(0.4)) {
    state.drone.lost = true;
    receipt += ' 无人机因过载损毁失联。';
    pushLog(state, 'remote', '无人机过载损毁失联。', true);
  }
  saveRng(state, rng); advance(state, 1);
  return { ok: true, receipt, turns: 1 }; // 已执行不等于命中；落空也有真实代价
}

export interface InteractOption {
  id: string;
  label: string;
  hint: string;
  enabled: boolean;
}

export function interactOptions(state: GameState): InteractOption[] {
  const room = getRoom(state, state.player.room);
  const powered = state.zones[room.zone].powered;
  const list: InteractOption[] = [];
  const hasGoal = (k: string) => state.goals.some((g) => g.kind === k);
  if (room.hazard?.active && !room.hazard.visualHidden) {
    if (room.hazard.kind === 'vacuum') {
      list.push({
        id: 'seal_leak',
        label: '封堵舱壁裂口',
        hint: hasItem(state, 'sealant') ? '消耗一份密封胶，降低泄漏风险' : '需要一份密封胶',
        enabled: hasItem(state, 'sealant'),
      });
    }
    if (room.hazard.kind === 'arc') {
      list.push({
        id: 'isolate_arc',
        label: '手动隔离电弧回路',
        hint: hasItem(state, 'toolkit') ? '需要工程工具包（已携带）' : '需要工程工具包',
        enabled: hasItem(state, 'toolkit'),
      });
    }
    if (room.hazard.kind === 'debris') {
      list.push({
        id: 'secure_debris',
        label: '固定松动结构',
        hint: hasItem(state, 'toolkit') ? '需要工程工具包，耗时但可降低二次坍塌风险' : '需要工程工具包',
        enabled: hasItem(state, 'toolkit'),
      });
    }
    if (room.hazard.kind === 'cold') {
      list.push({
        id: 'warm_lines',
        label: '接入电池融化管路',
        hint: hasItem(state, 'battery') ? '消耗一组储能电池，恢复舱内温度' : '需要一组储能电池',
        enabled: hasItem(state, 'battery'),
      });
    }
  }
  if (room.feature === 'breaker' && hasGoal('power_pod')) {
    list.push({
      id: 'breaker',
      label: state.flags.breakerFixed ? '配电阀已复位' : '手动复位配电阀',
      hint: hasItem(state, 'toolkit') ? '需要工程工具包（已携带）' : '需要工程工具包',
      enabled: !state.flags.breakerFixed && hasItem(state, 'toolkit'),
    });
  }
  if (room.feature === 'comm' && hasGoal('fix_comm')) {
    list.push({
      id: 'comm',
      label: state.flags.commFixed ? '对外通讯阵列已修复' : '修复对外通讯阵列',
      hint: `需要工程工具包 + 本区供电（${powered ? '已通电' : '当前断电'}）`,
      enabled: !state.flags.commFixed && hasItem(state, 'toolkit') && powered,
    });
  }
  if (room.feature === 'nav' && hasGoal('nav_core')) {
    list.push({
      id: 'nav',
      label: state.flags.navInstalled ? '导航核心已安装' : '安装导航核心',
      hint: state.flags.navInstalled ? '核心已经安装完成' : !hasItem(state, 'navcore') ? '尚未携带导航核心' : !powered ? '已携带核心，等待本区供电' : '核心已携带，本区已通电',
      enabled: !state.flags.navInstalled && hasItem(state, 'navcore') && powered,
    });
  }
  if (room.feature === 'auth' && hasGoal('auth')) {
    list.push({
      id: 'auth',
      label: state.flags.authGranted ? '身份授权已签发' : '签发身份授权',
      hint: `需要船员身份卡 + 本区供电（${powered ? '已通电' : '当前断电'}）`,
      enabled: !state.flags.authGranted && hasItem(state, 'idcard') && powered,
    });
  }
  if (room.feature === 'pod') {
    const remaining = state.goals.filter((g) => !g.done).length;
    list.push({
      id: 'escape',
      label: '启动逃生舱并撤离',
      hint:
        remaining > 0
          ? `还有 ${remaining} 项目标未完成`
          : state.zones[room.zone].powered
            ? '所有条件已满足'
            : '逃生舱区仍未通电，需要远端合闸',
      enabled: remaining === 0 && state.zones[room.zone].powered,
    });
  }
  return list;
}

export function fieldInteract(state: GameState, id: string): string {
  if (state.status !== 'playing') return '任务已经结束。';
  if (!interactOptions(state).some((o) => o.id === id && o.enabled)) {
    const option = interactOptions(state).find((o) => o.id === id);
    return option ? `${option.label}：${option.hint}。` : '当前位置没有这项设施操作。';
  }
  const room = getRoom(state, state.player.room);
  switch (id) {
    case 'breaker':
      state.flags.breakerFixed = true;
      state.zones[getRoom(state, state.podRoom).zone].breakerDamaged = false;
      pushLog(
        state,
        'field',
        `配电阀被你一格一格扳回原位。现在需要远端为${getRoom(state, state.podRoom).zone} 区合闸。`,
        true,
      );
      decision(state, '复位了逃生舱区的配电阀');
      break;
    case 'seal_leak':
      if (!room.hazard || room.hazard.kind !== 'vacuum' || !hasItem(state, 'sealant')) return '裂口的位置已经无法确认。';
      removeItem(state, 'sealant');
      room.hazard.active = false;
      room.hazard.isolated = true;
      state.integrity = Math.min(100, state.integrity + 7);
      pushLog(state, 'field', '密封胶沿着裂缝扩开，哨声一点点停了下来。舱压开始回升。', true);
      decision(state, `在${shortRoom(room)}封堵了真空泄漏`);
      break;
    case 'isolate_arc':
      if (!room.hazard || room.hazard.kind !== 'arc' || !hasItem(state, 'toolkit')) return '找不到需要隔离的回路。';
      room.hazard.active = false;
      room.hazard.isolated = true;
      pushLog(state, 'field', '你拉下手动隔离闸，电弧在最后一次爆响后熄灭。照明仍在，但这条支路已经死了。', true);
      decision(state, `在${shortRoom(room)}隔离了高压电弧回路`);
      break;
    case 'secure_debris':
      if (!room.hazard || room.hazard.kind !== 'debris' || !hasItem(state, 'toolkit')) return '没有可固定的松动结构。';
      room.hazard.active = false;
      room.hazard.isolated = true;
      state.integrity = Math.min(100, state.integrity + 3);
      pushLog(state, 'field', '你用固定带把漂浮的结构件扣回支架。舱壁的低鸣没有消失，但不再像要立刻断开。', true);
      decision(state, `在${shortRoom(room)}固定了松动结构`);
      break;
    case 'warm_lines':
      if (!room.hazard || room.hazard.kind !== 'cold' || !hasItem(state, 'battery')) return '冻结的管路已经没有可接入的位置。';
      removeItem(state, 'battery');
      room.hazard.active = false;
      room.hazard.isolated = true;
      pushLog(state, 'field', '电池的余热沿管路慢慢走开，霜层从边缘开始融化。', true);
      decision(state, `在${shortRoom(room)}为冻结管路接入了储能电池`);
      break;
    case 'comm':
      state.flags.commFixed = true;
      pushLog(state, 'field', '空间站对外主通讯阵列重新起振，求救信标与站内调查记录开始传出。你们的短距对讲和实时定位始终独立工作。', true);
      decision(state, '修复了通讯模块');
      break;
    case 'nav':
      state.flags.navInstalled = true;
      removeItem(state, 'navcore');
      pushLog(state, 'field', '导航核心插回卡槽，屏幕上重新出现了一条回家的航线。', true);
      decision(state, '安装了导航核心');
      break;
    case 'auth':
      state.flags.authGranted = true;
      state.power = Math.max(0, state.power - 6);
      pushLog(state, 'field', '主控室接受了身份卡，授权已经写入逃生舱的许可名单。', true);
      decision(state, '签发了身份授权');
      break;
    case 'escape':
      state.status = 'won';
      applyEscapeEnding(state);
      pushLog(state, 'field', '舱门合拢，推进器点火。你听见搭档在通讯里长长呼出一口气。', true);
      advance(state, 1);
      return '';
    default:
      return '这里没有可以操作的设施。';
  }
  if (room.hazard?.isolated && !room.hazard.active) room.fieldVerdict = 'safe';
  noise(state, 1);
  advance(state, 1);
  void room;
  return '';
}

export function checkGoals(state: GameState) {
  for (const g of state.goals) {
    if (g.done) continue;
    let done = false;
    switch (g.kind) {
      case 'power_pod':
        done = state.flags.breakerFixed && state.zones[getRoom(state, state.podRoom).zone].powered;
        break;
      case 'fix_comm':
        done = state.flags.commFixed;
        break;
      case 'nav_core':
        done = state.flags.navInstalled;
        break;
      case 'auth':
        done = state.flags.authGranted;
        break;
      case 'alt_route':
        done = state.flags.altRoute;
        break;
    }
    if (done) {
      g.done = true;
      g.doneTurn = state.turn;
      pushLog(state, 'system', `任务目标达成：${g.title}。`, true);
      decision(state, `任务目标达成：${g.title}`, 100);
      if (g.kind === 'power_pod') assist(state, '在现场复位与远端合闸的配合下恢复了逃生舱供电');
    }
  }
}

/**
 * 撤离结局分支。标准好结局是"完成目标并撤离"，但下面这些状态会改变结局的味道与代号：
 * - 是否修好通讯（决定你们是带着完整记录走，还是带着一段空白走）
 * - 是否拿到身份授权（决定黑匣子里是否留下了"发生过什么"的官方口供）
 * - 未知目标的最终状态：被回应过 / 曾贴上舷窗 / 仍在活跃 / 根本不存在
 * - 是否始终没弄清它是什么（unknown 本质 → "逃出去但没弄明白"分支）
 */
function applyEscapeEnding(state: GameState) {
  const e = state.entity;
  const echo: string[] = [];
  let code = 'clean';

  // 主标题层：通讯 + 授权 决定"带走了多少真相"
  if (state.flags.commFixed && state.flags.authGranted) {
    code = 'record_intact';
    state.endReason = '逃生舱脱离对接口。通讯恢复了，授权也签了——这一次，有人会知道这里发生过什么。';
  } else if (!state.flags.commFixed) {
    code = 'silent_run';
    state.endReason = '逃生舱脱离对接口，空间站对外主通讯阵列仍未修复。你们保持着短距对讲撤离，却未能通过主阵列传出站内调查记录。';
  } else {
    state.endReason = WIN_LINES[state.turn % WIN_LINES.length];
  }

  // 回响层：关于那个东西
  if (!e.exists) {
    echo.push('复盘时你们确认：那些读数大多来自结构自身。这座站里，也许从头到尾只有你们两个活物。');
  } else {
    if (e.answeredKnock) {
      echo.push('你确实敲回去过。另一头只回了两声，你们至今没有弄清那是不是回答。');
      code = code === 'silent_run' ? 'answered_silent' : 'answered';
    }
    if (e.touchedHull) {
      echo.push('舷窗痕迹与外壁热脉冲发生在同一段时间。两份记录都留了下来，没有一份足以说明那是什么。');
    }
    if (e.nature === 'unknown') {
      echo.push('直到离开，你们也没能给它一个名字。传感器说它是生命，声音说它是机器，它自己什么都没承认。');
      if (code === 'clean' || code === 'record_intact') code = 'unknown_survivor';
    } else if (e.agitation >= 3) {
      echo.push(`撤离时，它仍在 ${shortRoom(getRoom(state, e.room))} 附近活动。你们走了，它留下了。`);
    } else {
      echo.push('最后一次读数里，它安静地停在某处，像是终于不再追。');
    }
    if (state.knocksIgnored > 0 && !e.answeredKnock) {
      echo.push(`你 ${state.knocksIgnored} 次听见敲击，一次都没有回答。有些门，不敲开也许才是对的。`);
    }
  }

  // 氧气尾声
  if (state.oxygen < 15) echo.push('撤离时护服里剩下的氧气，不够再走一个舱段。');

  state.endingCode = code;
  state.endingEcho = echo;
}

/* ------------------------------------------------------------------ */
/*  远程操作                                                            */
/* ------------------------------------------------------------------ */

function spend(state: GameState, amount: number): boolean {
  if (state.power < amount) return false;
  state.power -= amount;
  return true;
}

export function makeReading(state: GameState, room: Room, rng: RNG): RemoteReading {
  const cfg = DIFFICULTIES[state.difficulty];
  const entityHere = state.entity.exists && state.entity.room === room.id;
  const truth = {
    hazard: !!room.hazard?.active,
    life: entityHere,
    motion: entityHere || state.drone.room === room.id,
    heat: entityHere || (room.hazard?.active && ['arc', 'radiation'].includes(room.hazard.kind)) || false,
  };
  const factor =
    room.sensor === 'ok' ? 0.45 : room.sensor === 'delayed' ? 1.1 : room.sensor === 'damaged' ? 1.7 : 2.4;
  const p = Math.min(0.62, cfg.distortion * factor);
  const flip = (v: boolean) => (rng.chance(p) ? !v : v);
  const reading: RemoteReading = {
    turn: state.turn,
    hazard: flip(truth.hazard),
    life: flip(truth.life),
    motion: flip(truth.motion),
    heat: flip(truth.heat),
    trustNote:
      room.sensor === 'ok'
        ? '信号正常'
        : room.sensor === 'delayed'
          ? '数据存在延迟'
          : room.sensor === 'damaged'
            ? '信号校验失败，数据可能失真'
            : '受到强干扰，读数不稳定',
    fromDrone: false,
  };
  (state.stats.scanTruth ??= {})[`${room.id}:${reading.turn}`] = !truth.hazard && !truth.life;
  return reading;
}

export function readingText(room: Room, reading: RemoteReading, currentTurn = reading.turn): string {
  const parts: string[] = [];
  if (reading.life) parts.push('检测到未知生命迹象');
  if (reading.motion && !reading.life) parts.push('检测到移动信号');
  if (reading.heat) parts.push('检测到异常热源');
  if (reading.hazard) parts.push('环境参数超出安全范围');
  if (!parts.length) parts.push('未检测到异常');
  const suffix = reading.fromDrone ? '（无人机现场回传，可信）' : `（${reading.trustNote}）`;
  const age = currentTurn - reading.turn;
  return `${shortRoom(room)}：${parts.join('，')}${suffix}${age > SAFE_READING_MAX_AGE ? `【采样已过 ${age} 回合，安全判断过期，需复核】` : ''}`;
}

export interface Command {
  type: 'scan' | 'unlock' | 'lock' | 'power_on' | 'power_off' | 'transfer' | 'drone' | 'trace' | 'help';
  room?: number;
  door?: string;
  zone?: string;
  zone2?: string;
  raw: string;
}

export function executeCommand(state: GameState, cmd: Command): CommandResult {
  if (state.status !== 'playing') return { ok: false, receipt: '任务已经结束。', turns: 0 };
  // 目标有效性校验（避免过期编号导致的异常）
  if (cmd.type === 'scan' || cmd.type === 'drone') {
    if (cmd.room === undefined || !state.rooms.some((r) => r.id === cmd.room))
      return { ok: false, receipt: '目标舱室编号不存在，请确认后重新下达。', turns: 0 };
  }
  if (cmd.type === 'unlock' || cmd.type === 'lock') {
    if (!cmd.door || !state.doors[cmd.door])
      return { ok: false, receipt: '舱门编号不存在，请确认后重新下达。', turns: 0 };
  }
  if (cmd.type === 'power_on' || cmd.type === 'power_off') {
    if (!cmd.zone || !state.zones[cmd.zone])
      return { ok: false, receipt: '供电分区不存在，请确认后重新下达。', turns: 0 };
  }
  if (cmd.type === 'transfer') {
    if (!cmd.zone || !cmd.zone2 || !state.zones[cmd.zone] || !state.zones[cmd.zone2] || cmd.zone === cmd.zone2)
      return { ok: false, receipt: '电力转移需要两个不同且存在的分区。', turns: 0 };
  }
  if (cmd.type === 'trace' && cmd.room !== undefined && !state.rooms.some((r) => r.id === cmd.room))
    return { ok: false, receipt: '追踪聚焦的舱室编号不存在。', turns: 0 };
  const rng = rngOf(state);
  let result: CommandResult = { ok: false, receipt: '指令无法执行。', turns: 0 };
  let inspectionPower = 0;
  state.stats.remoteCommands += 1;

  const fail = (msg: string): CommandResult => ({ ok: false, receipt: msg, turns: 0 });

  switch (cmd.type) {
    case 'help':
      result = { ok: true, receipt: '已在日志中列出全部可用远程指令。', turns: 0 };
      pushLog(
        state,
        'remote',
        '可用远程指令：扫描 <房间> / 解锁 <舱门> / 锁定 <舱门> / 开启 <区>供电 / 关闭 <区>供电 / 转移电力 <区> 到 <区> / 无人机前往 <房间> / 追踪信号（可指定区域聚焦）。',
      );
      break;

    case 'scan': {
      const room = getRoom(state, cmd.room!);
      if (!state.zones[room.zone].powered) {
        if (!spend(state, 2)) {
          result = fail('电力不足，离线探头查询未执行。');
          break;
        }
        inspectionPower = 2;
        pushLog(state, 'remote', `${shortRoom(room)}：传感器无供电，未返回任何数据。`);
        result = { ok: true, receipt: `扫描${shortRoom(room)}：该区断电，传感器离线（电力 -2）。`, turns: 1 };
        break;
      }
      if (!spend(state, REMOTE_COSTS.scan)) {
        result = fail('电力储备不足，无法完成扫描。');
        break;
      }
      state.stats.scans += 1;
      inspectionPower = REMOTE_COSTS.scan;
      const reading = makeReading(state, room, rng);
      room.lastScan = reading;
      registerConflict(state, room, reading);
      pushLog(state, 'remote', `扫描结果 · ${readingText(room, reading)}`);
      if (state.entity.exists && state.entity.room === room.id) noise(state, 2);
      if (state.player.room === room.id)
        pushLog(state, 'field', '舱内的传感器阵列亮起一圈，扫过一遍又暗下去。');
      result = { ok: true, receipt: `已扫描${shortRoom(room)}，结果写入远程终端（电力 -6）。`, turns: 1 };
      break;
    }

    case 'unlock':
    case 'lock': {
      const door = state.doors[cmd.door!];
      const locking = cmd.type === 'lock';
      if (door.braced) {
        result = fail(`${doorLabel(door)}被现场压差楔顶住，远端无法越过机械楔操作。`);
        break;
      }
      if (door.remoteBroken) {
        result = fail(`${doorLabel(door)}的控制回路已损坏，远端无法操作。`);
        break;
      }
      if (door.status === 'jammed') {
        result = fail(`${doorLabel(door)}被机械卡死，只能由现场处理。`);
        break;
      }
      const zoneOk = state.zones[getRoom(state, door.a).zone].powered || state.zones[getRoom(state, door.b).zone].powered;
      if (!zoneOk) {
        result = fail(`${doorLabel(door)}两侧均无供电，舱门不响应远端指令。`);
        break;
      }
      const cost = locking ? REMOTE_COSTS.lock : REMOTE_COSTS.unlock;
      if (!spend(state, cost)) {
        result = fail('电力储备不足，舱门操作失败。');
        break;
      }
      if (locking && door.status === 'locked') {
        state.stats.misjudgments += 1;
        state.stats.misjudgeNotes.push(`第 ${state.turn} 回合：重复锁定已锁死的${doorLabel(door)}，白白消耗了电力。`);
      }
      const pursuitBefore = state.entity.exists && state.entity.hunting ? findPath(state, state.entity.room, state.player.room) : null;
      door.status = locking ? 'locked' : 'open';
      const pursuitAfter = pursuitBefore ? findPath(state, state.entity.room, state.player.room) : null;
      const cutPursuit = locking && pursuitBefore !== null && (pursuitAfter === null || pursuitAfter.length > pursuitBefore.length);
      if (!locking) door.remoteUnlockTurn = state.turn;
      pushLog(state, 'remote', `${doorLabel(door)}已${locking ? '锁定' : '解锁并开启'}。`);
      if (getRoom(state, state.player.room).doors.includes(door.id)) {
        pushLog(
          state,
          'field',
          locking
            ? `你身边的${doorLabel(door)}"咔"一声闭合，锁扣落下。`
            : `${doorLabel(door)}的指示灯转绿，门缓缓滑开。`,
          true,
        );
      }
      decision(state, (locking ? `远端锁定了${doorLabel(door)}` : `远端解锁了${doorLabel(door)}`) + (cutPursuit ? '，切断或延长了追击路径' : ''), cutPursuit ? 80 : 10);
      result = {
        ok: true,
        receipt: `${doorLabel(door)}已${locking ? '锁定' : '解锁'}（电力 -${cost}）。`,
        turns: 1,
      };
      break;
    }

    case 'power_on':
    case 'power_off': {
      const zone = state.zones[cmd.zone!];
      const on = cmd.type === 'power_on';
      if (on && zone.breakerDamaged) {
        result = fail(`${zone.id} 区配电阀处于机械断开状态，远端合闸无效，需要现场手动复位。`);
        break;
      }
      if (zone.powered === on) {
        state.stats.misjudgments += 1;
        state.stats.misjudgeNotes.push(
          `第 ${state.turn} 回合：对已经${on ? '通电' : '断电'}的 ${zone.id} 区重复下达供电指令。`,
        );
        result = fail(`${zone.id} 区已经处于${on ? '通电' : '断电'}状态。`);
        break;
      }
      if (!spend(state, REMOTE_COSTS.power)) {
        result = fail('电力储备不足，配电操作失败。');
        break;
      }
      zone.powered = on;
      if (on) zone.stableUntilTurn = state.turn + 6;
      for (const r of state.rooms) {
        if (r.zone === zone.id && r.hazard?.kind === 'arc') r.hazard.active = on && !r.hazard.isolated;
      }
      pushLog(state, 'remote', `${zone.id} 区供电已${on ? '接通' : '切断'}。`);
      if (getRoom(state, state.player.room).zone === zone.id) {
        pushLog(
          state,
          'field',
          on
            ? '头顶的灯管一根接一根亮起来，通风重新开始转动。'
            : '所有灯同时熄灭，只剩头灯的一小圈光。舱门也停止响应。',
          true,
        );
        physicalCue(state, 'lamp', on ? '灯管恢复亮度，仍有一处接触不良。' : '灯光暗下去，头灯仍在。');
      }
      decision(state, `远端${on ? '接通' : '切断'}了 ${zone.id} 区供电`);
      result = { ok: true, receipt: `${zone.id} 区供电已${on ? '接通' : '切断'}（电力 -5）。`, turns: 1 };
      break;
    }

    case 'transfer': {
      const from = state.zones[cmd.zone!];
      const to = state.zones[cmd.zone2!];
      if (!from || !to) {
        result = fail('分区不存在。');
        break;
      }
      if (to.breakerDamaged) {
        result = fail(`${to.id} 区配电阀未复位，无法接受电力。`);
        break;
      }
      if (!spend(state, REMOTE_COSTS.transfer)) {
        result = fail('电力储备不足，无法完成转移。');
        break;
      }
      from.powered = false;
      to.powered = true;
      for (const r of state.rooms) {
        if (r.hazard?.kind === 'arc') r.hazard.active = state.zones[r.zone].powered && !r.hazard.isolated;
      }
      pushLog(state, 'remote', `电力已由 ${from.id} 区转移至 ${to.id} 区。`);
      decision(state, `远端把 ${from.id} 区的电力转给了 ${to.id} 区`);
      if (getRoom(state, state.player.room).zone === from.id)
        pushLog(state, 'field', '灯灭了。远端应该是把电挪去了别的地方。', true);
      if (getRoom(state, state.player.room).zone === to.id)
        pushLog(state, 'field', '这一区突然来电，通风口吐出一股冷风。', true);
      result = { ok: true, receipt: `电力已从 ${from.id} 区转移到 ${to.id} 区（电力 -6）。`, turns: 1 };
      break;
    }

    case 'drone': {
      if (state.drone.lost) {
        result = fail('无人机已失联，无法再接收指令。');
        break;
      }
      if (state.drone.charge <= 0) {
        result = fail('无人机电量耗尽，停在原地。');
        break;
      }
      const path = findPath(state, state.drone.room, cmd.room!);
      if (!path) {
        result = fail('无人机无法抵达目标：沿途舱门锁定、卡死或被门楔阻隔。未起飞，不耗电、不推进回合。');
        break;
      }
      if (path.length > state.drone.charge) {
        result = fail('无人机电量不足以抵达目标。未起飞，不耗电、不推进回合。');
        break;
      }
      if (!spend(state, REMOTE_COSTS.drone)) {
        result = fail('电力储备不足，无人机无法起飞。');
        break;
      }
      let moved = 0;
      for (const step of path) {
        if (state.drone.charge <= 0) break;
        state.drone.room = step;
        state.drone.charge -= 1;
        moved += 1;
        state.stats.droneMoves += 1;
        noise(state, 1);
        const r = getRoom(state, step);
        const risky =
          (state.entity.exists && state.entity.room === step && rng.chance(0.35)) ||
          (r.hazard?.active && r.hazard.kind === 'arc' && rng.chance(0.3));
        if (risky) {
          state.drone.lost = true;
          pushLog(state, 'remote', `无人机在${shortRoom(r)}失去信号，最后一帧画面是一片过曝的白。`, true);
          danger(state, '无人机在途中失联', 5);
          break;
        }
      }
      const here = getRoom(state, state.drone.room);
      if (!state.drone.lost) {
        const entityHere = state.entity.exists && state.entity.room === here.id;
        const reading: RemoteReading = {
          turn: state.turn,
          hazard: !!here.hazard?.active,
          life: entityHere,
          motion: entityHere,
          heat: entityHere || (here.hazard?.active && ['arc', 'radiation'].includes(here.hazard.kind)) || false,
          trustNote: '无人机直视回传',
          fromDrone: true,
        };
        here.lastScan = reading;
        registerConflict(state, here, reading);
        const itemNote = here.items.length
          ? `舱内可见：${here.items.map((i) => ITEMS[i].name).join('、')}。`
          : '舱内没有可见的物资。';
        pushLog(state, 'remote', `无人机抵达${shortRoom(here)}。${readingText(here, reading)} ${itemNote}`, true);
        if (here.id === state.player.room && state.drone.carrying) {
          if (state.player.inventory.length < state.player.capacity) {
            state.player.inventory.push(state.drone.carrying);
            pushLog(state, 'field', `无人机把${ITEMS[state.drone.carrying].name}放到你脚边，然后悬停等待。`, true);
            assist(state, `无人机送来了${ITEMS[state.drone.carrying].name}`);
            state.drone.carrying = null;
          }
        } else if (!state.drone.carrying) {
          const light = here.items.find((i) => ['o2', 'battery', 'sealant', 'relay', 'torchcell', 'idcard', 'adrenaline', 'energygel'].includes(i));
          if (light) {
            here.items.splice(here.items.indexOf(light), 1);
            state.drone.carrying = light;
            pushLog(state, 'remote', `无人机抓取了${ITEMS[light].name}，可送往现场员所在舱。`);
          }
        }
        if (here.id === state.player.room)
          pushLog(state, 'field', '无人机的红色指示灯从通道口飘进来，停在你面前。');
      }
      result = {
        ok: true,
        receipt: state.drone.lost
          ? `无人机移动 ${moved} 段后失联（电力 -10）。`
          : `无人机移动 ${moved} 段，已抵达并回传数据（电力 -10，剩余电量 ${state.drone.charge}）。`,
        turns: Math.max(1, moved),
      };
      break;
    }

    case 'trace': {
      if (!spend(state, REMOTE_COSTS.trace)) {
        result = fail('电力储备不足，无法展开信号追踪。');
        break;
      }
      inspectionPower = REMOTE_COSTS.trace;
      noise(state, 2);
      const focusRoom = cmd.room !== undefined ? getRoom(state, cmd.room) : null;
      if (!state.entity.exists) {
        const ghost = rng.pick(state.rooms);
        pushLog(
          state,
          'remote',
          rng.chance(0.5)
            ? '追踪完成：未捕捉到任何移动源，低频信号可能来自结构自身的震动。'
            : `追踪完成：信号疑似来自${shortRoom(ghost)}，但特征与生命体不符。`,
          true,
        );
      } else {
        let target = state.entity.room;
        let note = '定位置信度高';
        if (state.difficulty !== 'light' && rng.chance(state.difficulty === 'silence' ? 0.4 : 0.22)) {
          const adj = adjacency(state, target);
          if (adj.length) {
            target = rng.pick(adj).room.id;
            note = '定位存在偏差风险';
          }
        }
        pushLog(
          state,
          'remote',
          `追踪完成：移动源当前位于${shortRoom(getRoom(state, target))}附近（${note}）。它似乎注意到了这次追踪。`,
          true,
        );
        if (focusRoom) {
          const d = topoDistance(state, focusRoom.id, target);
          pushLog(
            state,
            'remote',
            d === 0
              ? `聚焦分析：${shortRoom(focusRoom)}与信号源位置吻合，建议不要让现场员单独进入。`
              : `聚焦分析：${shortRoom(focusRoom)}距离信号源约 ${d} 段通道。`,
          );
        }
      }
      // 附加结论不是定论：传感器整体越不可靠，误报概率越高
      if (rng.chance(DIFFICULTIES[state.difficulty].distortion)) {
        const calm = state.rooms.filter((r) => !r.visited && !r.hazard?.active);
        const pick = calm.length ? rng.pick(calm) : rng.pick(state.rooms);
        pushLog(
          state,
          'remote',
          `附加结论：${shortRoom(pick)}的读数出现可疑波动，特征不稳定，建议结合现场描述进一步确认。`,
        );
      } else {
        const unknown = state.rooms.filter((r) => !r.visited && r.hazard?.active);
        if (unknown.length) {
          const r = rng.pick(unknown);
          pushLog(
            state,
            'remote',
            `附加结论：${shortRoom(r)}的环境参数疑似超限，建议结合现场描述判断，不建议贸然进入。`,
          );
        }
      }
      result = { ok: true, receipt: '信号追踪完成，结果写入远程终端（电力 -12，耗时 2 回合）。', turns: 2 };
      break;
    }
  }

  saveRng(state, rng);
  const committedZones = Object.fromEntries(Object.entries(state.zones).map(([id, z]) => [id, z.powered]));
  const committedDoors = Object.fromEntries(Object.entries(state.doors).map(([id, d]) => [id, d.status]));
  if (result.ok && result.turns > 0) advance(state, result.turns);
  else checkGoals(state);
  if (result.ok) {
    result.warnings = [
      ...Object.entries(state.zones).filter(([id, z]) => z.powered !== committedZones[id]).map(([id, z]) => `${id} 区随后${z.powered ? '恢复供电' : '掉电'}`),
      ...Object.entries(state.doors).filter(([id, d]) => d.status !== committedDoors[id]).map(([id, d]) => `${id} 舱门随后变为${doorStatusText(d.status)}`),
    ];
    if (result.warnings.length) result.receipt += `\n⚠ 本次操作已执行，但同次结算发生变化：${result.warnings.join('；')}。请重新核对行动条件。`;
  }
  if (result.ok && inspectionPower > 0) {
    recordInspection(state, inspectionPower, result.turns, cmd.room);
  }
  return result;
}

/** 忽略门锁的拓扑距离，用于追踪聚焦分析 */
function topoDistance(state: GameState, from: number, to: number): number {
  if (from === to) return 0;
  const dist: Record<number, number> = { [from]: 0 };
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    for (const { room } of adjacency(state, cur)) {
      if (dist[room.id] === undefined) {
        dist[room.id] = dist[cur] + 1;
        if (room.id === to) return dist[room.id];
        q.push(room.id);
      }
    }
  }
  return 99;
}

export function findPath(state: GameState, from: number, to: number): number[] | null {
  if (from === to) return [];
  const prev: Record<number, number> = {};
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    for (const { room, door } of adjacency(state, cur)) {
      if (door.braced || door.status === 'locked' || door.status === 'jammed') continue;
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      prev[room.id] = cur;
      if (room.id === to) {
        const path: number[] = [to];
        let c = to;
        while (prev[c] !== from) {
          c = prev[c];
          path.unshift(c);
        }
        return path;
      }
      q.push(room.id);
    }
  }
  return null;
}
