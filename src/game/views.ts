// ─────────────────────────────────────────────────────────────────────────────
// 三层状态：WorldState（权威世界状态） → FieldView（现场员视图） / OperatorView（远程席视图）
//
// 所有投影都在服务端执行。浏览器只会收到 FieldView，MCP 只会收到 OperatorView。
// 任何一侧都拿不到 WorldState 的真值字段（真实危险、真实未知目标位置、隐藏物资、
// 传感器是否在说谎等）。这是数据层的硬隔离，不依赖前端隐藏或提示词约束。
// ─────────────────────────────────────────────────────────────────────────────

import { fieldObservations } from './briefing';
import { fieldPerceptions, operatorAdvisories, operatorFragments, TRUST_ANCHORS } from './atmosphere';
import { ITEMS } from './content';
import { PING_LABEL, REMOTE_COSTS, SAFE_READING_MAX_AGE, canFieldAttack, doorStatusText, getRoom, interactOptions, readingText } from './engine';
import { shortRoom } from './generator';
import { DIFFICULTIES, type GameState, type Room } from './types';

/* ========================= 公共：任务状态 ========================= */

export interface OperatorPresence {
  name: string;
  kind: 'none' | 'mcp' | 'local';
  connected: boolean;
  lastAction: string | null;
  lastActionAt: number | null;
  lastSeenAt: number | null;
}

export interface GameStatusView {
  runId: string;
  seed: string;
  turn: number;
  difficulty: string;
  difficultyName: string;
  mode: string;
  paused: boolean;
  status: 'playing' | 'won' | 'lost';
  endReason: string | null;
  goals: { title: string; done: boolean; doneTurn: number | null }[];
  goalsCompleted: number;
  goalsTotal: number;
  evacuation: { room: number; name: string };
  operator: OperatorPresence;
  roomsTotal: number;
  updatedAt: number;
}

export function projectStatus(
  state: GameState,
  runId: string,
  paused: boolean,
  operator: OperatorPresence,
): GameStatusView {
  const pod = getRoom(state, state.podRoom);
  return {
    runId,
    seed: state.seed,
    turn: state.turn,
    difficulty: state.difficulty,
    difficultyName: DIFFICULTIES[state.difficulty].name,
    mode: state.mode === 'coop' ? '双人协作' : '单人同屏',
    paused,
    status: state.status,
    endReason: state.endReason,
    goals: state.goals.map((g) => ({ title: g.title, done: g.done, doneTurn: g.doneTurn })),
    goalsCompleted: state.goals.filter((g) => g.done).length,
    goalsTotal: state.goals.length,
    evacuation: { room: pod.id, name: pod.name },
    operator,
    roomsTotal: state.rooms.length,
    updatedAt: Date.now(),
  };
}

/* ========================= FieldView ========================= */

/** 现场员只有"体感"，没有精确读数。把氧气量化到区间中值后再下发。 */
function oxygenBand(o: number): number {
  if (o > 60) return 80;
  if (o > 35) return 47;
  if (o > 18) return 26;
  return 9;
}

/**
 * FieldView 与 GameState 结构兼容（方便现有组件直接渲染），
 * 但所有远程席专属字段与世界真值都已被抹除。
 */
export function projectField(state: GameState): GameState {
  const notes = fieldObservations(state);
  const droneVisible = !state.drone.lost && state.drone.room === state.player.room;

  // 现场员知道的布局：去过的舱 + 当前所在舱的相邻舱（与地图显示规则严格一致）。
  // 布局之外的一切（名称、设施、远处舱门状态）都不下发。
  const here = state.player.room;
  const known = new Set<number>([here, state.podRoom]); // 撤离点在任务简报里是公开的
  for (const r of state.rooms) if (r.visited) known.add(r.id);
  for (const dId of getRoom(state, here).doors) {
    const d = state.doors[dId];
    known.add(d.a === here ? d.b : d.a);
  }

  const rooms: Room[] = state.rooms.map((r) => ({
    ...r,
    name: known.has(r.id) ? r.name : '未探索区域',
    feature: known.has(r.id) ? r.feature : null,
    // 只把现场员已明确看到并判断为危险的处置对象下发；未被发现的真值仍然隐藏。
    hazard: r.visited && r.fieldVerdict === 'danger' && r.hazard && !r.hazard.visualHidden
      ? { kind: r.hazard.kind, active: r.hazard.active, isolated: r.hazard.isolated, visualHidden: false }
      : null,
    hiddenItems: [],
    items: r.visited ? [...r.items] : [],
    clue: r.searched ? r.clue : null,
    relic: r.relicFound ? r.relic : null,
    relicFound: r.relicFound,
    // 只有现场找到物理线索后才知道传感器可疑
    sensor: r.sensorClueFound ? r.sensor : 'ok',
    // 传感器读数属于远程席
    lastScan: null,
    visualNoise: r.visited ? r.visualNoise : false,
  }));

  const zones: GameState['zones'] = {};
  for (const [k, z] of Object.entries(state.zones)) {
    // 通断可以从照明与通风判断；电压诊断与配电阀状态属于远程席
    zones[k] = { id: z.id, powered: z.powered, unstable: false, breakerDamaged: false };
  }

  // 远处舱门的真实状态不下发：只有当一侧去过时，现场员才亲眼见过这扇门
  const doors: GameState['doors'] = {};
  const visitedIds = new Set(state.rooms.filter((r) => r.visited).map((r) => r.id));
  for (const [id, d] of Object.entries(state.doors)) {
    const seen = visitedIds.has(d.a) || visitedIds.has(d.b);
    doors[id] = seen
      ? { ...d, remoteUnlockTurn: null }
      : { ...d, status: 'closed', remoteBroken: false, seen: false, remoteUnlockTurn: null };
  }

  const view: GameState = {
    ...state,
    rngState: 0,
    fieldAttackAvailable: canFieldAttack(state),
    fieldInteractions: interactOptions(state).filter((o) => !['seal_leak', 'isolate_arc', 'secure_debris', 'warm_lines'].includes(o.id) || getRoom(state, here).fieldVerdict === 'danger'),
    oxygen: oxygenBand(state.oxygen),
    power: -1,
    integrity: -1,
    rooms,
    zones,
    doors,
    // 远程席的诊断数据一律不下发
    alerts: [],
    alertSeq: 0,
    entity: { exists: false, room: 0, agitation: 0, lastMoveTurn: 0, lastHitTurn: 0, nature: 'unknown', hunting: false, huntTarget: null, stunnedTurns: 0, vitality: 0, salvageDropped: false, answeredKnock: false, touchedHull: false },
    drone: {
      room: droneVisible ? state.drone.room : -1,
      charge: droneVisible ? state.drone.charge : -1,
      carrying: droneVisible ? state.drone.carrying : null,
      // 无人机是远程席的资产，是否失联只能由对方告知
      lost: false,
    },
    // 护服是否泄漏可以感知，精确泄漏率属于远程席诊断
    player: { ...state.player, suitLeak: state.player.suitLeak > 0 ? 0.5 : 0 },
    // 任务进度是共享的，但写给远程席的提示文字不下发
    goals: state.goals.map((g) => ({ ...g, remoteHint: '' })),
    // 远端对现场员的定位诊断不下发（现场员只知道自己在哪里）
    tracked: { room: state.player.room, turn: state.turn, note: '' },
    commDelay: 0,
    receipts: [],
    // 结算统计在任务结束前不下发（结束后由结算接口一次性开放）
    stats: {
      conflicts: 0,
      conflictNotes: [],
      assists: 0,
      assistNotes: [],
      misjudgments: 0,
      misjudgeNotes: [],
      decisions: [],
      scans: 0,
      droneMoves: 0,
      remoteCommands: 0,
      parseFails: 0,
      searches: 0,
      dangerEvents: [],
    },
    log: state.log.filter((l) => l.side !== 'remote' && l.audience !== 'operator'),
    fieldNotes: notes,
    atmosphere: null,
    fieldEffects: fieldPerceptions(state),
    endingEcho: [],
  };
  return view;
}

/* ========================= OperatorView ========================= */

export interface OperatorViewZone {
  id: string;
  powered: boolean;
  voltage: '稳定' | '不稳定';
  breaker: '正常' | '机械断开，远端合闸无效';
}

export interface OperatorViewDoor {
  id: string;
  connects: string;
  status: string;
  remoteControllable: boolean;
  note: string;
}

export interface OperatorViewReading {
  room: number;
  roomName: string;
  summary: string;
  source: '传感器' | '无人机';
  reliability: string;
  ageTurns: number;
  life: boolean;
  motion: boolean;
  heat: boolean;
  environmentAbnormal: boolean;
}

export interface OperatorViewOperation {
  tool: string;
  name: string;
  powerCost: number;
  available: boolean;
  note: string;
}

export interface OperatorView {
  runId: string;
  turn: number;
  seed: string;
  difficulty: string;
  paused: boolean;
  status: 'playing' | 'won' | 'lost';
  resources: {
    healthPercent: number;
    oxygenPercent: number;
    oxygenDrainPerTurn: number;
    estimatedTurnsLeft: number;
    power: number;
    powerNetPerTurn: number;
    integrityPercent: number;
    suitLeakDetected: boolean;
  };
  zones: OperatorViewZone[];
  doors: OperatorViewDoor[];
  stationRoster: { id: number; name: string; zone: string; x: number; y: number }[];
  readings: OperatorViewReading[];
  darkZones: string[];
  fieldMember: {
    reportedRoom: number;
    reportedRoomName: string;
    dataAgeTurns: number;
    realtime: boolean;
    note: string;
  };
  drone: {
    online: boolean;
    room: number | null;
    roomName: string | null;
    chargeSegments: number;
    carrying: string | null;
  };
  hiddenAlerts: { turn: number; text: string }[];
  disturbanceFragments: ReturnType<typeof operatorFragments>;
  advisories: ReturnType<typeof operatorAdvisories>;
  trustedAnchors: string[];
  /** 共享通讯记录：现场员主动发出的口述，以及你自己的留言。 */
  fieldTransmissions: { turn: number; text: string; from: 'field' | 'operator' }[];
  /** 地图标记：双方互相可见的协作信物。 */
  pings: { room: number; roomName: string; kind: string; note: string; from: 'field' | 'operator'; turn: number }[];
  goals: { title: string; done: boolean; remoteHint: string }[];
  evacuation: { room: number; name: string; powered: boolean };
  availableOperations: OperatorViewOperation[];
  informationBoundary: string[];
  brief: string;
}

export function projectOperator(state: GameState, runId: string, paused: boolean): OperatorView {
  const cfg = DIFFICULTIES[state.difficulty];
  const poweredZones = Object.values(state.zones).filter((z) => z.powered).length;
  const drain = cfg.drain + state.player.suitLeak;
  const netPower = cfg.powerRegen - poweredZones * 0.55;
  const tracked = getRoom(state, state.player.room);
  const pod = getRoom(state, state.podRoom);

  const readings: OperatorViewReading[] = state.rooms
    .filter((r) => r.lastScan)
    .sort((a, b) => b.lastScan!.turn - a.lastScan!.turn)
    .slice(0, 10)
    .map((r) => {
      const s = r.lastScan!;
      return {
        room: r.id,
        roomName: r.name,
        summary: readingText(r, s, state.turn),
        source: s.fromDrone ? '无人机' : '传感器',
        reliability: `${s.fromDrone ? '无人机直视回传' : s.trustNote}；${state.turn - s.turn > SAFE_READING_MAX_AGE ? `超过 ${SAFE_READING_MAX_AGE} 回合，安全判断已过期，需重新确认` : '采样后目标仍可能移动'}`,
        ageTurns: state.turn - s.turn,
        life: s.life,
        motion: s.motion,
        heat: s.heat,
        environmentAbnormal: s.hazard,
      };
    });

  const canPay = (n: number) => state.power >= n;
  const ops: OperatorViewOperation[] = [
    {
      tool: 'operator_scan',
      name: '扫描指定舱室',
      powerCost: REMOTE_COSTS.scan,
      available: canPay(REMOTE_COSTS.scan),
      note: '断电区的传感器不会返回数据；扫描有概率惊动未知目标。',
    },
    {
      tool: 'operator_door',
      name: '锁定 / 解锁舱门',
      powerCost: REMOTE_COSTS.unlock,
      available: canPay(REMOTE_COSTS.lock),
      note: '控制回路损坏或两侧均断电的舱门无法远端操作；机械卡死只能由现场处理。',
    },
    {
      tool: 'operator_power',
      name: '开启 / 关闭 / 转移分区供电',
      powerCost: REMOTE_COSTS.power,
      available: canPay(REMOTE_COSTS.power),
      note: '断电会同时关闭该区照明、舱门与传感器，但也会让电弧类危险停下。',
    },
    {
      tool: 'operator_drone',
      name: '派出无人机',
      powerCost: REMOTE_COSTS.drone,
      available: canPay(REMOTE_COSTS.drone) && !state.drone.lost && state.drone.charge > 0,
      note: '无人机回传的是直视画面，比传感器可信，但可能损坏或失联。',
    },
    {
      tool: 'operator_trace',
      name: '追踪未知信号（可指定区域聚焦）',
      powerCost: REMOTE_COSTS.trace,
      available: canPay(REMOTE_COSTS.trace),
      note: '耗时 2 回合。可粗略定位移动源，但会显著提高它的活跃度；定位与附加结论都可能有偏差。',
    },
  ];

  return {
    runId,
    turn: state.turn,
    seed: state.seed,
    difficulty: cfg.name,
    paused,
    status: state.status,
    resources: {
      healthPercent: Math.round(state.player.health),
      oxygenPercent: Number(state.oxygen.toFixed(1)),
      oxygenDrainPerTurn: Number(drain.toFixed(2)),
      estimatedTurnsLeft: Math.floor(state.oxygen / Math.max(0.01, drain)),
      power: Number(state.power.toFixed(1)),
      powerNetPerTurn: Number(netPower.toFixed(1)),
      integrityPercent: Number(state.integrity.toFixed(0)),
      suitLeakDetected: state.player.suitLeak > 0,
    },
    zones: Object.values(state.zones).map((z) => ({
      id: z.id,
      powered: z.powered,
      voltage: z.unstable ? '不稳定' : '稳定',
      breaker: z.breakerDamaged ? '机械断开，远端合闸无效' : '正常',
    })),
    doors: Object.values(state.doors).map((d) => ({
      id: d.id,
      connects: `${d.a} 号 ↔ ${d.b} 号`,
      status: doorStatusText(d.status),
      remoteControllable: !d.braced && !d.remoteBroken && d.status !== 'jammed',
      note: d.braced ? '存在机械约束，需现场解除'
        : d.remoteBroken
        ? '控制回路损坏，远端指令无效'
        : d.status === 'jammed'
          ? '机械卡死，需现场用撬棍处理'
          : '',
    })),
    stationRoster: state.rooms.map((r) => ({ id: r.id, name: r.name, zone: r.zone, x: r.x, y: r.y })),
    readings,
    darkZones: Object.values(state.zones).filter((z) => !z.powered).map((z) => z.id),
    fieldMember: {
      reportedRoom: tracked.id,
      reportedRoomName: tracked.name,
      dataAgeTurns: 0,
      realtime: true,
      note: '现场员实时定位，与对外通讯阵列维修独立',
    },
    drone: {
      online: !state.drone.lost,
      room: state.drone.lost ? null : state.drone.room,
      roomName: state.drone.lost ? null : getRoom(state, state.drone.room).name,
      chargeSegments: state.drone.charge,
      carrying: state.drone.carrying ? ITEMS[state.drone.carrying].name : null,
    },
    hiddenAlerts: state.alerts.slice(-8).map((a) => ({ turn: a.turn, text: a.text })),
    disturbanceFragments: operatorFragments(state),
    advisories: operatorAdvisories(state),
    trustedAnchors: TRUST_ANCHORS,
    fieldTransmissions: state.transmissions.slice(-10).map((t) => ({ turn: t.turn, text: t.text, from: t.source })),
    pings: state.pings.map((p) => ({
      room: p.room,
      roomName: getRoom(state, p.room).name,
      kind: PING_LABEL[p.kind] ?? p.kind,
      note: p.note,
      from: p.from,
      turn: p.turn,
    })),
    goals: state.goals.map((g) => ({ title: g.title, done: g.done, remoteHint: g.remoteHint })),
    evacuation: { room: pod.id, name: pod.name, powered: state.zones[pod.zone].powered },
    availableOperations: ops,
    informationBoundary: [
      '你看不到现场员眼前的画面：舱内的物品、尸体、划痕、纸条、雾气，这些只有他能描述。',
      '你看不到舱室里真实存在什么。传感器可能损坏、延迟或认错东西，"未检测到异常"不等于安全。',
      '你不知道哪一台传感器正在说谎，只能从信号状态、无人机直视画面和现场员的描述里自己判断。',
      '即使信号正常的传感器也有小概率误报。不要把单次读数当作定论，用多种来源交叉验证。',
      '未知目标的真实位置对你不可见，追踪结果只是概率性的。',
      '定位是本次快照的准确位置；读取之后玩家仍可能移动。无需因通讯尚未维修而反复询问位置。',
      '用 operator_say 随时和现场员说话、用 operator_ping 在地图上做标记，这两件事免费且不消耗回合。',
      '每次行动后用一句话告诉现场员你做了什么、为什么——他看不到你的屏幕。',
      '不要替现场员做决定，也不要编造这份数据里没有的东西。',
    ],
    brief: buildOperatorBriefText(state, runId, paused),
  };
}

/** 远程席简报（纯文本）：MCP 回执用的人类可读视图，与结构化数据同源。 */
export function buildOperatorBriefText(state: GameState, runId: string, paused: boolean): string {
  const cfg = DIFFICULTIES[state.difficulty];
  const L: string[] = [];
  const poweredZones = Object.values(state.zones).filter((z) => z.powered).length;
  const net = (cfg.powerRegen - poweredZones * 0.55).toFixed(1);
  const drain = (cfg.drain + state.player.suitLeak).toFixed(2);

  L.push(`【失联之后 · 远程终端】第 ${state.turn} 回合 ｜ 难度：${cfg.name} ｜ 对局 ${runId}${paused ? ' ｜ 已暂停' : ''}`);
  L.push('');
  L.push(`氧气：${state.oxygen.toFixed(0)}%（每回合约 -${drain}）`);
  L.push(`电力储备：${state.power.toFixed(0)}（净回充 ${Number(net) >= 0 ? '+' : ''}${net}/回合）`);
  L.push(`站体完整度：${state.integrity.toFixed(0)}%`);
  if (state.player.suitLeak > 0) L.push('现场员护服：检测到持续泄漏');
  L.push('');
  L.push('供电分区：');
  for (const z of Object.values(state.zones)) {
    const tags = [z.powered ? '在线' : '离线'];
    if (z.unstable) tags.push('电压不稳');
    if (z.breakerDamaged) tags.push('配电阀机械断开，远端合闸无效');
    L.push(`- ${z.id} 区：${tags.join('，')}`);
  }
  L.push('');
  const tracked = getRoom(state, state.player.room);
  L.push(
    `现场员定位：${shortRoom(tracked)}（实时）`,
  );
  L.push(
    state.drone.lost
      ? '无人机：已失联'
      : `无人机：位于${shortRoom(getRoom(state, state.drone.room))} ｜ 剩余电量 ${state.drone.charge} 段 ｜ 携带：${state.drone.carrying ? ITEMS[state.drone.carrying].name : '无'}`,
  );
  L.push('');
  L.push('传感器读数（仅包含已扫描或已回传的舱室）：');
  const scanned = state.rooms.filter((r) => r.lastScan);
  if (!scanned.length) L.push('- 暂无数据。所有舱室都需要先扫描。');
  scanned
    .sort((a, b) => b.lastScan!.turn - a.lastScan!.turn)
    .slice(0, 8)
    .forEach((r) => {
      const age = state.turn - r.lastScan!.turn;
      L.push(`- ${readingText(r, r.lastScan!, state.turn)}${age > 0 ? ` [${age} 回合前]` : ' [本回合]'}`);
    });
  const dark = Object.values(state.zones).filter((z) => !z.powered).map((z) => z.id);
  if (dark.length) L.push(`- ${dark.join('、')} 区断电，区内传感器全部离线。`);
  L.push('');
  L.push('舱门（编号 连接 状态）：');
  for (const d of Object.values(state.doors)) {
    const tag = d.remoteBroken ? ' ※控制回路损坏，远端无法操作' : '';
    L.push(`- ${d.id} ${d.a}↔${d.b} ${doorStatusText(d.status)}${tag}`);
  }
  L.push('');
  const remoteLog = state.log.filter((l) => l.side === 'remote' && l.audience !== 'field').slice(-6);
  if (remoteLog.length) {
    L.push('远端操作记录（最近）：');
    for (const l of remoteLog) L.push(`- 第 ${l.turn} 回合：${l.text}`);
    L.push('');
  }
  if (state.alerts.length) {
    L.push('隐藏警报（现场员看不到）：');
    for (const a of state.alerts.slice(-6)) L.push(`- 第 ${a.turn} 回合：${a.text}`);
    L.push('');
  }
  if (state.transmissions.length) {
    L.push('通讯记录（最近，双方互相可见）：');
    for (const t of state.transmissions.slice(-6)) {
      const who = t.source === 'field' ? '现场员' : '你';
      L.push(`- 第 ${t.turn} 回合 [${who}] ${t.text}`);
    }
    L.push('');
  }
  if (state.pings.length) {
    L.push('地图标记（双方互相可见）：');
    for (const p of state.pings) {
      const who = p.from === 'field' ? '现场员' : '你';
      const room = getRoom(state, p.room);
      L.push(`- ${shortRoom(room)}：${PING_LABEL[p.kind] ?? p.kind}${p.note ? `——${p.note}` : ''}（${who}，第 ${p.turn} 回合）`);
    }
    L.push('');
  }
  L.push('任务目标：');
  for (const g of state.goals) L.push(`- ${g.title}：${g.done ? '已完成' : '未完成'}｜${g.remoteHint}`);
  L.push(`- 撤离点：${shortRoom(getRoom(state, state.podRoom))}`);
  L.push('');
  L.push('舱室编号对照：');
  L.push(state.rooms.map((r) => `${r.id}=${r.name}`).join('，'));
  L.push('');
  L.push('可执行远程操作（括号内为电力消耗，每条指令推进 1 回合）：');
  L.push('扫描 <舱室>（6）｜ 解锁 <舱门>（8）｜ 锁定 <舱门>（4）｜ 开启/关闭 <区> 供电（5）');
  L.push('把 <区> 电力转移到 <区>（6）｜ 无人机前往 <舱室>（10）｜ 追踪信号（12，耗时 2 回合，可指定区域）');
  const fragments = operatorFragments(state);
  if (fragments.length) {
    L.push('', '独立采样片段（只代表探头当时收到的信号）：');
    for (const f of fragments.slice(-4)) L.push(`- 第 ${f.turn} 回合 · ${f.source}：${f.text}`);
  }
  const advisories = operatorAdvisories(state);
  if (advisories.length) {
    L.push('', '终端评估 / 显示诊断（非执行指令）：');
    for (const a of advisories.slice(-2)) L.push(`- ${a.source}：${a.text}`);
  }
  L.push('', '可信底座：', ...TRUST_ANCHORS.map((t) => `- ${t}`));
  return L.join('\n');
}

/** 远程席日志：只包含远端席位与系统层面的事件，不含现场员的第一人称观察。 */
export function projectOperatorLog(state: GameState, limit = 20) {
  const systemEntries = state.log
    .filter((l) => l.audience !== 'field' && !state.transmissions.some((t) => t.id === l.transmissionId) && (l.side === 'remote' || l.side === 'system' || l.side === 'alert'))
    .map((l) => ({
      turn: l.turn,
      channel: l.side === 'remote' ? '远端席' : l.side === 'alert' ? '警报' : '系统',
      text: l.text,
    }));
  const transmissions = state.transmissions.map((t) => ({
    turn: t.turn,
    channel: t.source === 'field' ? '现场员原文' : '远程操作员原文',
    text: t.text,
  }));
  return [...systemEntries, ...transmissions]
    .sort((a, b) => a.turn - b.turn)
    .slice(-Math.max(1, Math.min(100, limit)));
}
