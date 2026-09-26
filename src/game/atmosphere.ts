import { RNG, hashSeed } from './rng';
import type { AtmosphereState, FieldPerception, GameState, OperatorAdvisory, PerceptionCue } from './types';

export const TRUST_ANCHORS = [
  '资源、分区供电和舱门状态是当前确值；传感器读数与定位带各自的采样时间，仍可能失真。',
  '最终确认只记录实际提交的指令及其结果。回执显示异常不会增添、反转或代替任何操作。',
  '通讯记录的发送者不会被冒充，已经写入的日志不会被改写。',
  '旧值班模块的评估是非权威提示，不是行动指令，也不知道你的思考或未发送的现场信息。',
];

export function createAtmosphere(seed: string): AtmosphereState {
  const rng = new RNG(hashSeed(`${seed}|perception-v1`));
  const nextTurn = rng.range(5, 8);
  return {
    rngState: rng.state, seq: 0, nextTurn,
    lastPhysicalTurn: -10, lastAssessmentTurn: -10, lastDisplayTurn: -10,
    incidents: [], visits: {}, used: {}, pendingEcho: null, pendingMoment: null,
    inspections: 0, inspectionTurns: 0, inspectionPower: 0, advisories: [],
  };
}

function memory(state: GameState): AtmosphereState {
  return state.atmosphere ??= createAtmosphere(`${state.seed}|${state.difficulty}`);
}

function log(state: GameState, side: 'field' | 'remote', text: string) {
  state.log.push({ id: ++state.logSeq, turn: state.turn, side, text, key: true, audience: side === 'field' ? 'field' : 'operator' });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

function emit(
  state: GameState,
  kind: string,
  field: Omit<FieldPerception, 'id' | 'turn'> | null,
  operator: { roomId: number; source: string; text: string } | null,
  writeLog = true,
) {
  const mem = memory(state);
  const id = ++mem.seq;
  mem.incidents.push({
    id, kind,
    field: field ? { ...field, id, turn: state.turn } : null,
    operator: operator ? { ...operator, id, turn: state.turn } : null,
  });
  if (mem.incidents.length > 48) mem.incidents.shift();
  if (writeLog && field) log(state, 'field', field.text);
  if (writeLog && operator) log(state, 'remote', `${operator.source}：${operator.text}`);
}

function eligible(state: GameState, kind: string, max = 2): boolean {
  const mem = memory(state);
  return state.status === 'playing' && state.turn >= mem.nextTurn && (mem.used[kind] ?? 0) < max;
}

function rest(state: GameState, kind: string) {
  const mem = memory(state);
  const rng = new RNG(mem.rngState);
  // 氛围与生存机制分用随机流。关闭音画不会改变世界后续事件。
  mem.nextTurn = state.turn + rng.range(state.difficulty === 'light' ? 7 : 5, 10);
  mem.rngState = rng.state;
  mem.used[kind] = (mem.used[kind] ?? 0) + 1;
}

function sample<T>(state: GameState, values: T[]): T {
  const mem = memory(state);
  const rng = new RNG(mem.rngState);
  const value = rng.pick(values);
  mem.rngState = rng.state;
  return value;
}

/** 故障已由引擎结算。这里仅发音画提示，不追加伤害或重复日志。 */
export function physicalCue(state: GameState, cue: PerceptionCue, text: string, direction = '不明') {
  const mem = memory(state);
  const urgent = cue === 'suit' || cue === 'fracture';
  if (!urgent && state.turn - mem.lastPhysicalTurn < 2) return;
  mem.lastPhysicalTurn = state.turn;
  emit(state, `physical-${cue}`, {
    roomId: state.player.room, cue, title: cue === 'suit' ? '防护服破损' : cue === 'fracture' ? '结构断裂' : '现场变化', text, direction,
  }, null, false);
}

function nearDirection(state: GameState): string | null {
  const here = state.rooms.find((r) => r.id === state.player.room)!;
  if (!state.entity.exists || state.entity.room === here.id) return null;
  const link = here.doors.map((id) => state.doors[id]).find((d) =>
    !d.braced && (d.a === state.entity.room || d.b === state.entity.room),
  );
  if (!link) return null;
  const other = state.rooms.find((r) => r.id === state.entity.room)!;
  if (other.x !== here.x) return other.x > here.x ? '东侧' : '西侧';
  return other.y > here.y ? '南侧' : '北侧';
}

/** 只在动作推进后运行；读取视图、发消息与前端渲染不推进氛围。 */
export function advanceAtmosphere(state: GameState) {
  const mem = memory(state);
  const moment = mem.pendingMoment;
  mem.pendingMoment = null;
  if (state.pendingKnock && (state.pendingKnock.roomId !== state.player.room || state.turn > state.pendingKnock.expiresTurn)) {
    log(state, 'field', '那一组敲击没有继续。你没再回头确认。');
    state.pendingKnock = null;
  }
  if (state.status !== 'playing' || state.turn < mem.nextTurn) return;
  const room = state.rooms.find((r) => r.id === state.player.room)!;
  const dir = nearDirection(state);

  if (moment && moment.dueTurn === state.turn && moment.roomId === room.id) {
    const key = moment.kind === 'return' ? `return-${room.id}` : moment.kind;
    if (eligible(state, key, 1) && (moment.kind !== 'return' || (mem.used.return ?? 0) < 2)) {
      const titles = { return: '回到同一个地方', paper: '纸页背面', stillness: '你停，它也停' };
      const fragments = {
        return: { source: '微加速度计', text: '上次采样后记录到一次微小姿态漂移。没有足够的图像数据解释它。' },
        paper: { source: '旧档案扫描座', text: '遮光触点短暂复位。电子档案只存有一页，未附第二次扫描。' },
        stillness: { source: '运动采样', text: '周期波形中止，末帧仍占用缓存。无法确认是目标停止，还是离开了探头范围。' },
      };
      const fragment = fragments[moment.kind];
      emit(state, key, {
        roomId: room.id, title: titles[moment.kind], text: moment.text, direction: moment.direction,
        cue: moment.kind === 'return' ? 'stillness' : moment.kind === 'paper' ? 'vent' : 'scrape',
      }, { roomId: room.id, source: `${room.id} 号${fragment.source}`, text: fragment.text });
      if (moment.kind === 'return') mem.used.return = (mem.used.return ?? 0) + 1;
      rest(state, key);
      return;
    }
  }

  if (mem.pendingEcho && state.turn >= mem.pendingEcho.dueTurn) {
    const target = state.rooms.find((r) => r.id === mem.pendingEcho!.roomId)!;
    mem.pendingEcho = null;
    if (eligible(state, 'annotation', 1)) {
      const audible = target.id === room.id || room.doors.some((id) => {
        const d = state.doors[id];
        return d.a === target.id || d.b === target.id;
      });
      emit(state, 'annotation', audible ? {
        roomId: room.id, cue: 'vent', title: '标记之后', direction: '不明',
        text: '你放下标记不久，通风管里响了一下。标记还在原处，声音已经没有了。',
      } : null, {
        roomId: target.id, source: `${target.id} 号舱应力探头`,
        text: '记录到一次短脉冲。同期无舱门动作，尚不足以判定损坏。',
      });
      rest(state, 'annotation');
      return;
    }
  }

  if (dir && (room.feature === 'nav' || room.name.includes('观测')) && eligible(state, 'glass', 1)) {
    state.entity.touchedHull = true;
    emit(state, 'glass', {
      roomId: room.id, cue: 'glass', direction: dir, title: '玻璃另一侧',
      text: '舷窗的雾面上多了一块五指形的清亮区域。你把头灯移近，玻璃另一侧的痕迹正在重新结雾。',
    }, {
      roomId: room.id, source: `${room.id} 号外壁热探头`,
      text: '近距热信号贴近后离开，持续不足一秒。舱内运动通道没有同步记录。',
    });
    rest(state, 'glass');
    return;
  }

  if (dir && !state.pendingKnock && eligible(state, 'knock', 2)) {
    state.pendingKnock = { turn: state.turn, dir, roomId: room.id, expiresTurn: state.turn + 3 };
    emit(state, 'knock', {
      roomId: room.id, cue: 'knock', direction: dir, title: '隔墙的节奏',
      text: mem.used.knock ? `${room.name}的${dir}又响起那种停顿不匀的敲击。这次最后两下贴得很近，你等了一会儿，没有第三下。` : `${dir}传来三声短响，隔了一会儿又响了两声。你没看见声源。最后一下之后，通风声显得很远。`,
    }, {
      roomId: room.id, source: `${room.id} 号舱壁振动采样`,
      text: mem.used.knock ? '再次采到非周期撞击，末端两个峰值间距缩短。波形与先前记录相似，无法确认同源。' : '出现五个离散峰值，未与站内泵组周期对齐。没有收到语音呼叫。',
    });
    rest(state, 'knock');
    return;
  }

  if (room.visualNoise && eligible(state, 'fog', 2)) {
    emit(state, 'fog', {
      roomId: room.id, cue: 'fog', direction: '不明', title: '雾后的间隙',
      text: mem.used.fog ? `${room.name}的雾从门框边滑开了一点。${state.zones[room.zone].powered ? '顶灯下' : '头灯扫过时'}，有一截影子比管线多伸出来半步；你换了角度，它又缩进了重叠的阴影。和先前那次不太一样。` : `${room.name}那排管道后面像多了一道竖着的轮廓。你把头灯移过去，雾正好合拢了。`,
    }, {
      roomId: room.id, source: `${room.id} 号光学测距`,
      text: mem.used.fog ? `${room.zone} 区这次采样在门框边缘出现双重距离值。热通道仍无连续轨迹；与先前遮挡记录不能可靠配准。` : '近场回波重叠，轮廓拟合中断。热通道没有形成稳定目标，不能据此排除遮挡。',
    });
    rest(state, 'fog');
    return;
  }

  if (eligible(state, 'vent', 2)) {
    emit(state, 'vent', {
      roomId: room.id, cue: 'vent', direction: '不明', title: '先听见的东西',
      text: `${room.name}里，` + sample(state, [
        '头灯还没扫到通道尽头，上方的风管先响了一下。你停住，后面没有第二声。',
        '耳机里是静电，墙外却有一段很长的擦响。两种声音停下的时间并不一样。',
        '一声很轻的撞击沿着管道传过来，到了你这里，像是被谁接住了。',
      ].filter((text) => !mem.incidents.some((e) => e.kind === 'vent' && e.field?.text.endsWith(text)))),
    }, {
      roomId: room.id, source: `${room.id} 号回风支路`,
      text: mem.used.vent ? '回风支路再次出现短促震动，持续时间比上次更短。转速记录仍没有对应变化，来源尚不能定位。' : '振动读数有一次短暂偏移，风机转速保持不变。该样本不足以判断是否存在移动物。',
    });
    rest(state, 'vent');
  } else {
    mem.nextTurn = state.turn + 6;
  }
}

const RETURN_DETAILS = [
  ['墙脚的空杯横着，杯口朝向舱壁。', '空杯的杯口现在朝着门。固定绳仍扣在原处，你记得自己没有碰过它。'],
  ['检修牌被一角胶带粘在管道上，背面朝外。', '检修牌正面朝外。那一角胶带还在，字迹没有变。'],
  ['备用座椅折着，安全带平铺在座面上。', '安全带的一端垂在座面外。它也许只是滑下来了。'],
];

export function onRoomEntered(state: GameState, revisit: boolean) {
  const mem = memory(state);
  const room = state.rooms.find((r) => r.id === state.player.room)!;
  const visits = (mem.visits[room.id] ?? 0) + 1;
  mem.visits[room.id] = visits;
  const detail = RETURN_DETAILS[hashSeed(`${state.seed}|detail|${room.id}`) % RETURN_DETAILS.length];
  if (visits === 1 && !room.visualNoise) {
    log(state, 'field', detail[0]);
    mem.used[`baseline-${room.id}`] = 1;
  } else if (revisit && visits >= 2 && mem.used[`baseline-${room.id}`] && (mem.used.return ?? 0) < 2) {
    mem.pendingMoment = { kind: 'return', roomId: room.id, text: detail[1], direction: '本舱', dueTurn: state.turn + 1 };
  }
}

export function onFieldStill(state: GameState) {
  const dir = nearDirection(state);
  if (!dir) return;
  memory(state).pendingMoment = {
    kind: 'stillness', roomId: state.player.room, direction: dir, dueTurn: state.turn + 1,
    text: '你收住脚步，隔墙的摩擦声也收住了。你等它先动，它没有。',
  };
}

export function onClueLifted(state: GameState) {
  const room = state.rooms.find((r) => r.id === state.player.room)!;
  if (!room.clue) return;
  memory(state).pendingMoment = {
    kind: 'paper', roomId: room.id, direction: '不明', dueTurn: state.turn + 1,
    text: '纸页翻起后，背面还有一行字：「别替另一头的人回答。」旧记录没有变，是你刚才没有看见这一面。',
  };
}

export function onDangerMarked(state: GameState, roomId: number) {
  const mem = memory(state);
  if (mem.pendingEcho || (mem.used.annotation ?? 0) > 0) return;
  mem.pendingEcho = { roomId, dueTurn: Math.max(state.turn + 1, mem.nextTurn) };
}

export function onKnockAnswered(state: GameState, roomId: number, direction: string) {
  emit(state, 'answer', {
    roomId, cue: 'knock', direction, title: '不同的间隔',
    text: '你敲完后等了很久。另一头终于回了两下，间隔和你的不一样。你还有时间决定下一步。',
  }, {
    roomId, source: `${roomId} 号结构振动采样`,
    text: '一组峰值之后又出现两次响应，间隔不同。控制器没有发出对应的机械动作。',
  });
  rest(state, 'answer');
}

/** 只引用远程席已执行的操作，不从现场私有数据推断玩家意图。 */
export function recordInspection(state: GameState, power: number, turns: number, target?: number) {
  const mem = memory(state);
  mem.inspections += 1;
  mem.inspectionPower += power;
  mem.inspectionTurns += turns;
  if (state.status !== 'playing') return;
  const room = state.rooms.find((r) => r.id === target);
  const displayIssue = state.commDelay > 0 || room?.sensor === 'jammed' || room?.sensor === 'delayed';
  const add = (kind: OperatorAdvisory['kind'], text: string) => {
    const note: OperatorAdvisory = {
      id: ++mem.seq, turn: state.turn, kind, text, authoritative: false,
      source: kind === 'display' ? '回执显示缓存' : '旧值班评估模块',
    };
    mem.advisories.push(note);
    if (mem.advisories.length > 8) mem.advisories.shift();
    log(state, 'remote', `${note.source}（非权威提示）：${text}`);
  };
  if (displayIssue && state.turn - mem.lastDisplayTurn >= 12 && mem.inspections % 2 === 0) {
    add('display', '回执暂存页出现一个未补全的「锁」字，命令号为空。重读后未发现对应调用；不是锁门指令。最终确认区未受影响。');
    mem.lastDisplayTurn = state.turn;
    return;
  }
  if (mem.inspections >= 3 && mem.inspections % 3 === 0 && state.turn - mem.lastAssessmentTurn >= 8) {
    add('assessment', `你已进行 ${mem.inspections} 次扫描或追踪，累计占用 ${mem.inspectionTurns} 回合、消耗 ${mem.inspectionPower} 点电力。核验仍然可以继续。你是在等一条新证据，还是等一次保证？`);
    mem.lastAssessmentTurn = state.turn;
  }
}

export function fieldPerceptions(state: GameState): FieldPerception[] {
  if (!state.atmosphere) return state.fieldEffects ?? [];
  return state.atmosphere.incidents.flatMap((e) => e.field ? [{ ...e.field }] : []).slice(-16);
}

export function operatorFragments(state: GameState) {
  return state.atmosphere?.incidents.flatMap((e) => e.operator ? [{ ...e.operator }] : []).slice(-8) ?? [];
}

export function operatorAdvisories(state: GameState) {
  return state.atmosphere?.advisories.slice(-4).map((n) => ({ ...n })) ?? [];
}

export function atmospherePairsForReport(state: GameState) {
  if (state.status === 'playing') return [];
  return state.atmosphere?.incidents.filter((e) => e.field && e.operator).map((e) => ({
    turn: e.field!.turn, roomId: e.field!.roomId,
    field: e.field!.text, operator: e.operator!.text,
  })) ?? [];
}
