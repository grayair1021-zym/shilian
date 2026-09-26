import { RNG, hashSeed } from './rng';
import { createAtmosphere } from './atmosphere';
import { CLUES, FEATURE_ROOMS, GOAL_DEFS, RELICS, ROOM_NAMES } from './content';
import {
  DIFFICULTIES,
  type Difficulty,
  type Door,
  type GameState,
  type Goal,
  type GoalKind,
  type HazardKind,
  type Mode,
  type Room,
  type SensorState,
  type Zone,
} from './types';

const COLS = 4;
const ROWS = 4;

function zoneOf(x: number, y: number): string {
  if (y < 2) return x < 2 ? 'A' : 'B';
  return x < 2 ? 'C' : 'D';
}

export function neighborsOf(state: GameState, roomId: number): { room: number; door: Door }[] {
  const room = state.rooms.find((r) => r.id === roomId)!;
  return room.doors.map((d) => {
    const door = state.doors[d];
    return { room: door.a === roomId ? door.b : door.a, door };
  });
}

function bfsDist(rooms: Room[], doors: Record<string, Door>, from: number): Record<number, number> {
  const dist: Record<number, number> = { [from]: 0 };
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    const room = rooms.find((r) => r.id === cur)!;
    for (const dId of room.doors) {
      const door = doors[dId];
      const other = door.a === cur ? door.b : door.a;
      if (dist[other] === undefined) {
        dist[other] = dist[cur] + 1;
        q.push(other);
      }
    }
  }
  return dist;
}

export function createGame(seedStr: string, difficulty: Difficulty, mode: Mode): GameState {
  const cfg = DIFFICULTIES[difficulty];
  const rng = new RNG(hashSeed(seedStr + '|' + difficulty));

  // ---------- 1. 选取舱室格子 ----------
  const all: { x: number; y: number }[] = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) all.push({ x, y });
  const chosen: { x: number; y: number }[] = [];
  const startCell = rng.pick(all);
  chosen.push(startCell);
  while (chosen.length < cfg.rooms) {
    const base = rng.pick(chosen);
    const cand = rng
      .shuffle([
        { x: base.x + 1, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y + 1 },
        { x: base.x, y: base.y - 1 },
      ])
      .find(
        (c) =>
          c.x >= 0 &&
          c.x < COLS &&
          c.y >= 0 &&
          c.y < ROWS &&
          !chosen.some((o) => o.x === c.x && o.y === c.y),
      );
    if (cand) chosen.push(cand);
  }
  chosen.sort((a, b) => a.y - b.y || a.x - b.x);

  const rooms: Room[] = chosen.map((c, i) => ({
    id: i + 1,
    name: '',
    zone: zoneOf(c.x, c.y),
    x: c.x,
    y: c.y,
    doors: [],
    items: [],
    hiddenItems: [],
    hazard: null,
    sensor: 'ok' as SensorState,
    sensorClueFound: false,
    visited: false,
    searched: false,
    clue: null,
    visualNoise: false,
    feature: null,
    lastScan: null,
    fieldVerdict: null,
    listened: false,
    relic: null,
    relicFound: false,
  }));

  const at = (x: number, y: number) => rooms.find((r) => r.x === x && r.y === y);

  // ---------- 2. 生成连通图 ----------
  const candidateEdges: [number, number][] = [];
  for (const r of rooms) {
    const right = at(r.x + 1, r.y);
    const down = at(r.x, r.y + 1);
    if (right) candidateEdges.push([r.id, right.id]);
    if (down) candidateEdges.push([r.id, down.id]);
  }
  const shuffled = rng.shuffle(candidateEdges);
  const parent: Record<number, number> = {};
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  rooms.forEach((r) => (parent[r.id] = r.id));
  const edges: [number, number][] = [];
  for (const [a, b] of shuffled) {
    if (find(a) !== find(b)) {
      parent[find(a)] = find(b);
      edges.push([a, b]);
    }
  }
  for (const [a, b] of shuffled) {
    if (edges.some(([x, y]) => x === a && y === b)) continue;
    if (rng.chance(0.34)) edges.push([a, b]);
  }

  const doors: Record<string, Door> = {};
  const counters: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const [a, b] of edges) {
    const ra = rooms.find((r) => r.id === a)!;
    const rb = rooms.find((r) => r.id === b)!;
    const letter = ra.zone;
    counters[letter] += 1;
    const id = `${letter}${counters[letter]}`;
    doors[id] = {
      id,
      a,
      b,
      status: 'closed',
      remoteBroken: false,
      seen: false,
      remoteUnlockTurn: null,
      braced: false,
    };
    ra.doors.push(id);
    rb.doors.push(id);
  }

  // ---------- 3. 功能舱与命名 ----------
  const startRoom = rooms.find((r) => r.x === startCell.x && r.y === startCell.y)!;
  const dist = bfsDist(rooms, doors, startRoom.id);
  const sortedByDist = rooms.slice().sort((a, b) => (dist[b.id] ?? 0) - (dist[a.id] ?? 0));
  const podRoom = sortedByDist[0];
  podRoom.feature = 'pod';

  const featureOrder: Array<Exclude<Room['feature'], null | 'pod'>> = [
    'breaker',
    'comm',
    'nav',
    'auth',
    'dronebay',
    'maintenance',
  ];
  const freeRooms = rng.shuffle(rooms.filter((r) => r !== podRoom && r !== startRoom));
  featureOrder.forEach((f, i) => {
    if (freeRooms[i]) freeRooms[i].feature = f;
  });

  const usedNames = new Set<string>();
  for (const r of rooms) {
    if (r.feature) {
      r.name = FEATURE_ROOMS[r.feature];
      usedNames.add(r.name);
    }
  }
  const corridorPool = rng.shuffle(['主环廊', '中央走廊', '中转平台', '北侧连接舱', '南侧连接舱']);
  const namePool = rng.shuffle(ROOM_NAMES.filter((n) => !usedNames.has(n)));
  for (const r of rooms) {
    if (r.name) continue;
    if (r.doors.length >= 3) {
      const positional = r.x >= 2 ? '东侧走廊' : '西侧走廊';
      const alt = r.y < 2 ? '北侧连接舱' : '南侧连接舱';
      const pick = !usedNames.has(positional) ? positional : !usedNames.has(alt) ? alt : corridorPool.find((n) => !usedNames.has(n));
      if (pick) {
        r.name = pick;
        usedNames.add(pick);
        continue;
      }
    }
    const n = namePool.find((x) => !usedNames.has(x)) ?? `${r.id} 号舱段`;
    r.name = n;
    usedNames.add(n);
  }
  if (!startRoom.feature) {
    startRoom.name = usedNames.has('医疗舱') ? startRoom.name : '医疗舱';
    usedNames.add(startRoom.name);
  }

  // ---------- 4. 任务目标 ----------
  const goalKinds: GoalKind[] = ['power_pod'];
  const optional: GoalKind[] = rng.shuffle(['nav_core', 'fix_comm', 'auth', 'alt_route']);
  while (goalKinds.length < cfg.goals && optional.length) goalKinds.push(optional.shift()!);
  const goals: Goal[] = goalKinds.map((k) => ({
    kind: k,
    title: GOAL_DEFS[k].title,
    fieldHint: GOAL_DEFS[k].fieldHint,
    remoteHint: GOAL_DEFS[k].remoteHint,
    done: false,
    doneTurn: null,
  }));

  // ---------- 5. 分区电力 ----------
  const zoneIds = Array.from(new Set(rooms.map((r) => r.zone))).sort();
  const zones: Record<string, Zone> = {};
  const offline = rng.sample(zoneIds.filter((z) => z !== startRoom.zone), difficulty === 'light' ? 1 : 2);
  const unstableCandidates = zoneIds.filter((z) => z !== podRoom.zone);
  const unstable = unstableCandidates.length ? rng.pick(unstableCandidates) : '';
  for (const z of zoneIds) {
    zones[z] = {
      id: z,
      powered: !offline.includes(z),
      unstable: z === unstable && difficulty !== 'light',
      breakerDamaged: false,
    };
  }
  zones[podRoom.zone].breakerDamaged = true;
  zones[podRoom.zone].powered = false;

  // ---------- 6. 危险 ----------
  const hazardKinds: HazardKind[] = ['vacuum', 'arc', 'radiation', 'debris', 'cold'];
  const hazardCount = difficulty === 'light' ? 2 : difficulty === 'unstable' ? 3 : 4;
  const hazardHiddenP = difficulty === 'light' ? 0.3 : difficulty === 'unstable' ? 0.45 : 0.6;
  const hazardRooms = rng.sample(
    rooms.filter((r) => r !== startRoom && r.feature !== 'pod' && r.feature !== 'dronebay'),
    hazardCount,
  );
  for (const r of hazardRooms) {
    r.hazard = {
      kind: rng.pick(hazardKinds),
      active: true,
      isolated: false,
      visualHidden: rng.chance(hazardHiddenP),
    };
  }

  // ---------- 7. 传感器状态 ----------
  const brokenCount = difficulty === 'light' ? 2 : difficulty === 'unstable' ? 4 : 6;
  const sensorRooms = rng.sample(rooms.filter((r) => r !== startRoom), brokenCount);
  for (const r of sensorRooms) {
    r.sensor = rng.pick<SensorState>(['damaged', 'jammed', 'delayed', 'damaged']);
  }
  for (const r of rng.sample(rooms, difficulty === 'silence' ? 3 : 2)) {
    if (r !== startRoom) r.visualNoise = true;
  }

  // ---------- 8. 物品 ----------
  const placeable = rng.shuffle(rooms.filter((r) => r !== startRoom));
  let pi = 0;
  const nextRoom = (pred?: (r: Room) => boolean): Room => {
    for (let i = 0; i < placeable.length; i++) {
      const r = placeable[(pi + i) % placeable.length];
      if (!pred || pred(r)) {
        pi = (pi + i + 1) % placeable.length;
        return r;
      }
    }
    return placeable[0];
  };
  const drop = (roomFilterOrRoom: Room | ((r: Room) => boolean) | undefined, item: string, hidden: boolean) => {
    const room =
      roomFilterOrRoom && typeof roomFilterOrRoom !== 'function'
        ? roomFilterOrRoom
        : nextRoom(roomFilterOrRoom as ((r: Room) => boolean) | undefined);
    if (hidden) room.hiddenItems.push(item);
    else room.items.push(item);
  };

  const safeSpot = (r: Room) => r.feature !== 'pod' && r.feature !== 'maintenance';
  // 撬棍必须放在"不必先撬门"就能抵达的区域（锁门可由远端解决，卡死门不行）
  const reachable = new Set<number>([startRoom.id]);
  const queue = [startRoom.id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const dId of rooms.find((r) => r.id === cur)!.doors) {
      const door = doors[dId];
      if (door.status === 'jammed') continue;
      const next = door.a === cur ? door.b : door.a;
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  drop(safeSpot, 'toolkit', rng.chance(0.5));
  drop((r) => safeSpot(r) && reachable.has(r.id), 'crowbar', rng.chance(0.5));
  if (goalKinds.includes('auth')) drop((r) => safeSpot(r) && r.feature !== 'auth', 'idcard', true);
  if (goalKinds.includes('nav_core')) drop((r) => safeSpot(r) && r.feature !== 'nav', 'navcore', rng.chance(0.6));
  drop(undefined, 'schema', true);
  drop(undefined, 'relay', true);
  drop(undefined, 'torchcell', rng.chance(0.5));
  const o2Count = difficulty === 'light' ? 6 : 5;
  // 补给分散到不同舱室，避免所有氧气集中在同一条死路。
  for (const r of rng.sample(rooms.filter((r) => r !== startRoom), o2Count)) {
    drop(r, 'o2', rng.chance(0.3));
  }
  for (let i = 0; i < 2; i++) drop(undefined, 'battery', rng.chance(0.5));
  for (let i = 0; i < 2; i++) drop(undefined, 'sealant', rng.chance(0.5));
  // 治疗补给：肾上腺素 2 支、能量胶 3 支，分散放置
  for (const r of rng.sample(rooms.filter((r) => r !== startRoom), Math.min(2, rooms.length - 1))) drop(r, 'adrenaline', rng.chance(0.4));
  for (const r of rng.sample(rooms.filter((r) => r !== startRoom), Math.min(3, rooms.length - 1))) drop(r, 'energygel', rng.chance(0.4));
  // 一枚压差楔提供一次可逆的手动封门策略；录音机增强现场口述。
  drop((r) => r !== startRoom, 'wedge', true);
  if (rng.chance(0.72)) drop((r) => r !== startRoom, 'recorder', true);
  if (rng.chance(0.34)) drop(undefined, 'charm', true);

  // ---------- 9. 线索 ----------
  const clueRooms = rng.sample(rooms, Math.min(6, rooms.length));
  const cluePool = rng.shuffle(CLUES);
  clueRooms.forEach((r, i) => {
    if (cluePool[i]) r.clue = cluePool[i];
  });
  // 遗留物与彩蛋由种子固定，只有搜索后才会被发现。
  const relicPool = Object.values(RELICS).filter((r) => !r.rare || rng.chance(difficulty === 'silence' ? 0.26 : 0.14));
  for (const [i, relic] of rng.sample(relicPool, Math.min(rng.range(2, 4), relicPool.length)).entries()) {
    const candidates = rooms.filter((r) => r !== startRoom && !r.relic);
    if (candidates.length) rng.pick(candidates).relic = relic.id;
    void i;
  }

  // ---------- 10. 舱门初始状态 ----------
  const doorList = Object.values(doors);
  for (const d of doorList) {
    const roll = rng.next();
    if (roll < 0.22) d.status = 'open';
    else if (roll < 0.86) d.status = 'closed';
    else d.status = 'locked';
  }
  const lockedTarget = difficulty === 'light' ? 2 : difficulty === 'unstable' ? 3 : 4;
  const lockedNow = doorList.filter((d) => d.status === 'locked');
  if (lockedNow.length < lockedTarget) {
    for (const d of rng.sample(doorList.filter((x) => x.status === 'closed'), lockedTarget - lockedNow.length)) {
      d.status = 'locked';
    }
  }
  for (const d of rng.sample(
    doorList.filter((x) => x.status !== 'locked' && !startRoom.doors.includes(x.id)),
    difficulty === 'light' ? 1 : difficulty === 'unstable' ? 2 : 3,
  )) {
    d.remoteBroken = true;
  }
  // 维修通道被卡死（但不能因此切断通往逃生舱的唯一通路）
  const maint = rooms.find((r) => r.feature === 'maintenance');
  if (maint && maint.doors.length) {
    const podStillReachable = (skip: string): boolean => {
      const seen = new Set([startRoom.id]);
      const stack = [startRoom.id];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const dId of rooms.find((r) => r.id === cur)!.doors) {
          if (dId === skip) continue;
          const dr = doors[dId];
          const next = dr.a === cur ? dr.b : dr.a;
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      return seen.has(podRoom.id);
    };
    const candidate = rng.shuffle(maint.doors).find((d) => podStillReachable(d));
    if (candidate) {
      doors[candidate].status = 'jammed';
      doors[candidate].remoteBroken = true;
    }
  }
  // 保证起始房至少有一扇可以直接通过或手动打开的门
  const startDoors = startRoom.doors.map((d) => doors[d]);
  if (startDoors.every((d) => d.status === 'locked' || d.status === 'jammed')) {
    startDoors[0].status = 'closed';
    startDoors[0].remoteBroken = false;
  }
  // 机械断开的回路内不生成双侧锁死：否则工具或配电阀可能被永远锁在断电门后。
  for (const d of doorList) {
    const za = zones[rooms.find((r) => r.id === d.a)!.zone];
    const zb = zones[rooms.find((r) => r.id === d.b)!.zone];
    if (d.status === 'locked' && za.breakerDamaged && zb.breakerDamaged) d.status = 'closed';
  }
  // 检修门确定之后再检查工具可达性，防止撬棍落在必须先用撬棍才能进入的舱段。
  const accessible = new Set([startRoom.id]);
  const frontier = [startRoom.id];
  while (frontier.length) {
    const id = frontier.shift()!;
    for (const dId of rooms.find((r) => r.id === id)!.doors) {
      const d = doors[dId];
      if (d.status === 'jammed') continue;
      const to = d.a === id ? d.b : d.a;
      if (!accessible.has(to)) { accessible.add(to); frontier.push(to); }
    }
  }
  for (const tool of ['crowbar', 'toolkit']) {
    const location = rooms.find((r) => r.items.includes(tool) || r.hiddenItems.includes(tool));
    if (location && !accessible.has(location.id)) {
      location.items = location.items.filter((it) => it !== tool);
      location.hiddenItems = location.hiddenItems.filter((it) => it !== tool);
      startRoom.items.push(tool);
    }
  }

  // ---------- 11. 未知目标 / 无人机 ----------
  const entityExists = rng.next() < cfg.entity;
  const far = sortedByDist.filter((r) => r !== startRoom && (dist[r.id] ?? 0) >= 2);
  const entityRoom = entityExists ? rng.pick(far.length ? far : rooms).id : podRoom.id;
  // 未知目标的隐藏本质由种子固定。unknown 占一定比例，保证"有时就是无解"。
  const entityNature = rng.pick(['drift', 'warmth', 'echo', 'echo', 'unknown'] as const);
  const bay = rooms.find((r) => r.feature === 'dronebay') ?? startRoom;

  startRoom.visited = true;
  startRoom.fieldVerdict = startRoom.hazard && !startRoom.hazard.visualHidden ? 'danger' : 'safe';

  const state: GameState = {
    seed: seedStr,
    rngState: rng.state,
    difficulty,
    mode,
    turn: 1,
    elapsedMs: 0,
    rooms,
    doors,
    zones,
    player: {
      room: startRoom.id,
      inventory: ['torchcell', 'o2'],
      health: 100,
      suitLeak: 0,
      capacity: cfg.capacity,
      composure: 55,
      breathHold: false,
      quietSteps: 0,
    },
    drone: { room: bay.id, charge: cfg.droneCharge, carrying: null, lost: false },
    entity: {
      exists: entityExists,
      room: entityRoom,
      agitation: 0,
      lastMoveTurn: 0,
      lastHitTurn: -9,
      nature: entityNature,
      hunting: false,
      huntTarget: null,
      stunnedTurns: 0,
      vitality: 100,
      salvageDropped: false,
      answeredKnock: false,
      touchedHull: false,
    },
    oxygen: 100,
    power: cfg.power,
    integrity: 100,
    goals,
    log: [],
    logSeq: 0,
    alerts: [],
    alertSeq: 0,
    transmissions: [],
    transmissionSeq: 0,
    pings: [],
    pingSeq: 0,
    recoveredRelics: [],
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
    status: 'playing',
    endReason: null,
    endingCode: null,
    endingEcho: [],
    hintStep: 0,
    tracked: { room: startRoom.id, turn: 1, note: '' },
    commDelay: 0,
    departureGrace: { room: startRoom.id, until: null },
    sonar: null,
    lastDrain: cfg.drain,
    pendingKnock: null,
    knocksIgnored: 0,
    flags: {
      breakerFixed: false,
      commFixed: false,
      navInstalled: false,
      authGranted: false,
      altRoute: false,
    },
    receipts: [],
    podRoom: podRoom.id,
    atmosphere: createAtmosphere(`${seedStr}|${difficulty}`),
  };

  pushLog(state, 'system', `记录恢复。站内时间 04:17，主控中断后第 6 小时。种子：${seedStr}。`);
  pushLog(
    state,
    'field',
    `你在${roomLabel(startRoom)}醒来，面罩内侧有一道细裂纹。应急灯每隔几秒亮一次，其余时间只有黑。`,
  );
  pushLog(
    state,
    'system',
    mode === 'solo'
      ? '单人任务已启动。舱门、扫描和供电已接入随身设备，不需要等待远程搭档。'
      : '与远端控制中心的链路仍然可用。系统操作交由远程席，现场动作由你决定。',
  );
  pushLog(state, 'alert', `本次任务需要完成 ${goals.length} 项目标，然后前往${roomLabel(podRoom)}撤离。`);

  const initialAlerts = [
    '主环路电压持续波动',
    '多个舱段压力读数不一致',
    '检测到来源不明的低频信号',
  ];
  for (const t of rng.sample(initialAlerts, 2)) {
    state.alerts.push({ id: ++state.alertSeq, turn: 1, text: t, fake: rng.chance(0.3) });
  }
  // 最终保险：验证初始地图的结构可达性并修复（不证明资源足够或保证生还）
  ensureWinnable(state);
  state.rngState = rng.state;
  return state;
}

/** 忽略资源消耗与动态事件，迭代收集可达工具并恢复可修复的供电。 */
function structuralAccess(state: GameState) {
  const roomOf = (id: number) => state.rooms.find((r) => r.id === id)!;
  const reach = new Set([state.player.room]);
  const items = new Set(state.player.inventory);
  const podZone = roomOf(state.podRoom).zone;
  const canPower = (zone: string) => state.zones[zone].powered || !state.zones[zone].breakerDamaged ||
    (zone === podZone && state.goals.some((g) => g.kind === 'power_pod') && items.has('toolkit') &&
      state.rooms.some((r) => r.feature === 'breaker' && reach.has(r.id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const room of state.rooms.filter((r) => reach.has(r.id))) {
      for (const item of [...room.items, ...room.hiddenItems]) {
        if (!items.has(item)) { items.add(item); changed = true; }
      }
      for (const doorId of room.doors) {
        const d = state.doors[doorId];
        const passable = d.status === 'jammed' ? items.has('crowbar') : d.status === 'locked'
          ? d.remoteBroken ? items.has('crowbar') : canPower(roomOf(d.a).zone) || canPower(roomOf(d.b).zone)
          : true;
        const next = d.a === room.id ? d.b : d.a;
        if (passable && !reach.has(next)) { reach.add(next); changed = true; }
      }
    }
  }
  return { reach, items, canPower };
}

/**
 * 初始地图结构检查（保留既有函数名）。空数组仅表示目标、物品及供电前提可达。
 * 不计算氧气、电力、负重、伤害或随机事件，不是完整游戏求解器，也不保证生还。
 */
export function validateWinnability(state: GameState): string[] {
  const problems: string[] = [];
  const { reach, items, canPower } = structuralAccess(state);
  const findItem = (item: string) => state.rooms.find((r) => r.items.includes(item) || r.hiddenItems.includes(item));
  const crowbarRoom = findItem('crowbar');
  if (crowbarRoom && !items.has('crowbar')) problems.push(`crowbar在${crowbarRoom.id}号舱不可达`);
  const need: Array<[string, number | undefined]> = [['逃生舱', state.podRoom]];
  const feat = (f: string) => state.rooms.find((r) => r.feature === f)?.id;
  for (const g of state.goals) {
    if (g.kind === 'power_pod') need.push(['配电间', feat('breaker')]);
    if (g.kind === 'fix_comm') need.push(['通讯中枢', feat('comm')]);
    if (g.kind === 'nav_core') need.push(['导航舱', feat('nav')]);
    if (g.kind === 'auth') need.push(['主控室', feat('auth')]);
    if (g.kind === 'alt_route') need.push(['维修通道', feat('maintenance')]);
  }
  for (const [label, id] of need) {
    if (id === undefined) problems.push(`${label}功能舱缺失`);
    else if (!reach.has(id)) problems.push(`${label}(${id}号)不可达`);
    else if (['逃生舱', '通讯中枢', '导航舱', '主控室'].includes(label) &&
      !canPower(state.rooms.find((r) => r.id === id)!.zone)) problems.push(`${label}(${id}号)无法恢复供电`);
  }
  const needItems: Array<[string, string | null]> = [['工具包', 'toolkit']];
  if (state.goals.some((g) => g.kind === 'auth')) needItems.push(['身份卡', 'idcard']);
  if (state.goals.some((g) => g.kind === 'nav_core')) needItems.push(['导航核心', 'navcore']);
  for (const [label, item] of needItems) {
    if (item && items.has(item)) continue;
    const r = item && findItem(item);
    if (item && !r) problems.push(`${label}未放置`);
    else if (r && !reach.has(r.id)) problems.push(`${label}在${r.id}号舱不可达`);
  }
  return problems;
}

/** 生成期结构修复：按固定顺序打开挡路的锁死门、搬运卡住的关键物品。 */
function ensureWinnable(state: GameState): void {
  const roomOf = (id: number) => state.rooms.find((r) => r.id === id)!;
  // 先保证关键工具可达，不能把坏锁当作可以远端解锁。
  for (const tool of ['crowbar', 'toolkit']) {
    const loc = state.rooms.find((r) => r.items.includes(tool) || r.hiddenItems.includes(tool));
    if (!loc) continue;
    if (!structuralAccess(state).items.has(tool)) {
      loc.items = loc.items.filter((it) => it !== tool);
      loc.hiddenItems = loc.hiddenItems.filter((it) => it !== tool);
      roomOf(state.player.room).items.push(tool);
    }
  }
  // 再逐扇打开挡路的锁死门（按门编号固定顺序，保证同种子同结果）
  const lockedDoors = Object.values(state.doors)
    .filter((d) => d.status === 'locked')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const d of lockedDoors) {
    if (validateWinnability(state).length === 0) return;
    d.status = 'closed';
  }
}

export function roomLabel(room: Room): string {
  return `${room.id} 号舱 · ${room.name}`;
}

export function shortRoom(room: Room): string {
  return `${room.id} 号 ${room.name}`;
}

export function pushLog(
  state: GameState,
  side: GameState['log'][number]['side'],
  text: string,
  key = false,
  audience?: 'field' | 'operator' | 'both',
) {
  state.logSeq += 1;
  state.log.push({ id: state.logSeq, turn: state.turn, side, text, key, audience });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}
