// 《失联之后》核心数据类型

export type Difficulty = 'light' | 'unstable' | 'silence';
export type Mode = 'coop' | 'solo';

export type DoorStatus = 'open' | 'closed' | 'locked' | 'jammed';

export interface Door {
  id: string;
  a: number;
  b: number;
  status: DoorStatus;
  remoteBroken: boolean;
  seen: boolean;
  remoteUnlockTurn: number | null;
  /** 现场员用压差楔顶住的舱门。远端不能越过机械楔操作，移动目标也无法穿过。 */
  braced: boolean;
}

export type HazardKind = 'vacuum' | 'arc' | 'radiation' | 'debris' | 'cold';

export interface Hazard {
  kind: HazardKind;
  active: boolean;
  /** 电弧等设备性危险被现场手动隔离后，不会因分区仍通电而自动恢复。 */
  isolated: boolean;
  /** 肉眼难以察觉：现场员看不到，只有传感器/无人机能发现 */
  visualHidden: boolean;
}

export type SensorState = 'ok' | 'damaged' | 'jammed' | 'delayed' | 'offline';

export type Feature =
  | 'pod'
  | 'breaker'
  | 'comm'
  | 'nav'
  | 'auth'
  | 'dronebay'
  | 'maintenance'
  | null;

export interface RemoteReading {
  turn: number;
  heat: boolean;
  motion: boolean;
  life: boolean;
  hazard: boolean;
  trustNote: string;
  fromDrone: boolean;
}

export interface Room {
  id: number;
  name: string;
  zone: string;
  x: number;
  y: number;
  doors: string[];
  items: string[];
  hiddenItems: string[];
  hazard: Hazard | null;
  sensor: SensorState;
  /** 现场员是否已经发现传感器受损的物理线索 */
  sensorClueFound: boolean;
  visited: boolean;
  searched: boolean;
  clue: string | null;
  visualNoise: boolean;
  feature: Feature;
  lastScan: RemoteReading | null;
  /** 现场员最近一次的主观判断：'safe' | 'danger' | 'unknown' */
  fieldVerdict: 'safe' | 'danger' | 'unknown' | null;
  /** 现场员是否在本舱静听过一次。 */
  listened: boolean;
  /** 被发现的遗留物编号；未搜索前不会进入任何视图。 */
  relic: string | null;
  relicFound: boolean;
}

export interface Transmission {
  id: number;
  turn: number;
  /** 现场员与远程操作员共用同一条通讯记录，双方互相可见。 */
  source: 'field' | 'operator';
  text: string;
}

/** 地图标记：双人协作的核心信物，双方互相可见。 */
export type PingKind = 'help' | 'scan' | 'danger' | 'note';

export interface Ping {
  id: number;
  room: number;
  kind: PingKind;
  note: string;
  from: 'field' | 'operator';
  turn: number;
}

export interface Zone {
  id: string;
  powered: boolean;
  unstable: boolean;
  breakerDamaged: boolean;
  stableUntilTurn?: number;
}

export type GoalKind = 'power_pod' | 'nav_core' | 'fix_comm' | 'auth' | 'alt_route';

export interface Goal {
  kind: GoalKind;
  title: string;
  fieldHint: string;
  remoteHint: string;
  done: boolean;
  doneTurn: number | null;
}

export type LogSide = 'field' | 'remote' | 'system' | 'alert';

export interface LogEntry {
  id: number;
  turn: number;
  side: LogSide;
  text: string;
  key?: boolean;
  audience?: 'field' | 'operator' | 'both';
  transmissionId?: number;
}

export type PerceptionCue = 'tremor' | 'lamp' | 'knock' | 'scrape' | 'vent' | 'fog' | 'glass' | 'signal' | 'stillness' | 'suit' | 'fracture';

/** 已发生的现场感知，不含远端片段或来源真相。 */
export interface FieldPerception {
  id: number;
  turn: number;
  roomId: number;
  title: string;
  text: string;
  cue: PerceptionCue;
  direction: string;
}

export interface OperatorFragment {
  id: number;
  turn: number;
  roomId: number;
  source: string;
  text: string;
}

export interface OperatorAdvisory {
  id: number;
  turn: number;
  kind: 'assessment' | 'display';
  source: string;
  text: string;
  authoritative: false;
}

/** 只保存在世界层，投影时必须拆分，不能整体下发。 */
export interface AtmosphereState {
  rngState: number;
  seq: number;
  nextTurn: number;
  lastPhysicalTurn: number;
  lastAssessmentTurn: number;
  lastDisplayTurn: number;
  incidents: {
    id: number;
    kind: string;
    field: FieldPerception | null;
    operator: OperatorFragment | null;
  }[];
  visits: Record<number, number>;
  used: Record<string, number>;
  pendingEcho: { roomId: number; dueTurn: number } | null;
  pendingMoment: {
    kind: 'return' | 'paper' | 'stillness'; roomId: number;
    text: string; direction: string; dueTurn: number;
  } | null;
  inspections: number;
  inspectionTurns: number;
  inspectionPower: number;
  advisories: OperatorAdvisory[];
}

export interface DangerEvent {
  turn: number;
  text: string;
  severity: number;
}

export interface Stats {
  trustEvents?: { turn: number; room: number; evidence: string[]; outcome: 'success' | 'distorted' | 'stale' | 'changed'; sampleTurn?: number }[];
  scanTruth?: Record<string, boolean>;
  decisionWeights?: Record<string, number>;
  conflicts: number;
  conflictNotes: string[];
  assists: number;
  assistNotes: string[];
  misjudgments: number;
  misjudgeNotes: string[];
  decisions: string[];
  scans: number;
  droneMoves: number;
  remoteCommands: number;
  parseFails: number;
  searches: number;
  dangerEvents: DangerEvent[];
}

export interface Alert {
  id: number;
  turn: number;
  text: string;
  fake: boolean;
}

export interface GameState {
  seed: string;
  rngState: number;
  difficulty: Difficulty;
  mode: Mode;
  turn: number;
  elapsedMs: number;
  rooms: Room[];
  doors: Record<string, Door>;
  zones: Record<string, Zone>;
  player: {
    room: number;
    inventory: string[];
    /** 生命值/身体状况 0-100：受到物理撞击、利爪撕裂、反击失败时扣除，归零直接死亡。 */
    health: number;
    suitLeak: number;
    capacity: number;
    /** 呼吸控制 0-100：越高越安静，动作噪声更低、搜索更细致。 */
    composure: number;
    /** 本回合处于屏息状态，氧气消耗大幅降低（由屏息动作设置，推进回合时消费）。 */
    breathHold: boolean;
    /** 静听后的预判机会：轻步移动不增加噪声，遇袭可消耗全部机会躲开一次擦撞。 */
    quietSteps: number;
  };
  drone: {
    room: number;
    charge: number;
    carrying: string | null;
    lost: boolean;
  };
  entity: {
    exists: boolean;
    room: number;
    agitation: number;
    lastMoveTurn: number;
    lastHitTurn: number;
    /**
     * 未知目标的隐藏本质（由种子固定）。游戏永不直接告诉任何一方它"是什么"，
     * 只通过传感器读数、现场声音、遗留物碎片让双方去拼。'unknown' 表示这一局
     * 它的行为始终无法归类——这是设计上的合法答案，不是缺省值。
     * drift  = 被真空拖拽在管道里游荡的东西（会被气流吸引）
     * warmth = 追逐生命维持热量的东西（爱去通电、有热源的舱）
     * echo   = 只在被打扰后才活跃的东西（扫描/追踪/回应敲击会惊动它）
     * unknown= 三者特征都沾一点，永远对不齐——本局无解
     */
    nature: 'drift' | 'warmth' | 'echo' | 'unknown';
    /** 是否处于追踪猎杀玩家的状态 */
    hunting: boolean;
    /** 追猎记忆：最近察觉到的玩家踪迹舱室 */
    huntTarget: number | null;
    /** 被击退或击晕的剩余回合（>0 时暂时停止行动） */
    stunnedTurns: number;
    /** 隐藏伤势，只由服务端保存；休整后部分恢复。 */
    vitality: number;
    salvageDropped: boolean;
    /** 现场员是否回应过敲击声（一次性重大决定，会显著改变它的行为与结局措辞）。 */
    answeredKnock: boolean;
    /** 它是否曾贴着舷窗外壁出现过（用于人机拼图彩蛋与结局回响）。 */
    touchedHull: boolean;
  };
  /** 氧气罐个体的动态容量 map，key 为物品实例标识，value 为随机剩余百分比 (例如 10%~24%) */
  itemCustomData?: Record<string, { o2Amount?: number }>;
  oxygen: number;
  power: number;
  integrity: number;
  goals: Goal[];
  log: LogEntry[];
  logSeq: number;
  alerts: Alert[];
  alertSeq: number;
  transmissions: Transmission[];
  transmissionSeq: number;
  /** 地图标记：双方互相可见的协作信物。 */
  pings: Ping[];
  pingSeq: number;
  /** 已找到的彩蛋/遗留物，仅记录已经由现场员亲自发现的内容。 */
  recoveredRelics: string[];
  stats: Stats;
  status: 'playing' | 'won' | 'lost';
  endReason: string | null;
  /** 结局代号：撤离时按当局全局状态判定，用于任务报告的分支标题。 */
  endingCode: string | null;
  /** 结局回响：任务报告里对"这一局到底发生了什么"的克制收束。 */
  endingEcho: string[];
  hintStep: number;
  tracked: { room: number; turn: number; note: string };
  commDelay: number;
  /** 新生局出生准备期；旧存局缺省不追加保护。首次离舱后给四个缓冲回合。 */
  departureGrace?: { room: number; until: number | null };
  /** 最近一次静听得到的方位情报，只属于现场员。 */
  sonar: {
    dir: string; distance: number; label: string; turn: number; danger: boolean;
    originRoom?: number; doorId?: string;
  } | null;
  /** 上一回合实际氧气消耗，用于向现场员展示屏息收益。 */
  lastDrain: number;
  /** 当前是否有一次"待回应的敲击"悬在现场员面前（可回应/可无视，是重大抉择）。 */
  pendingKnock: { turn: number; dir: string; roomId: number; expiresTurn: number } | null;
  /** 现场员选择无视敲击的次数（用于结局措辞）。 */
  knocksIgnored: number;
  flags: {
    breakerFixed: boolean;
    commFixed: boolean;
    navInstalled: boolean;
    authGranted: boolean;
    altRoute: boolean;
  };
  receipts: string[];
  podRoom: number;
  /**
   * 联机模式下由服务端计算并随 FieldView 下发的现场观察文本。
   * 本地单机模式为空，由客户端自行推导。
   */
  fieldNotes?: string[];
  /** 现场端只接收攻击可用性，不接收目标位置或伤势。 */
  fieldAttackAvailable?: boolean;
  fieldInteractions?: { id: string; label: string; hint: string; enabled: boolean }[];
  atmosphere: AtmosphereState | null;
  /** 联机现场席的音画事件入口。 */
  fieldEffects?: FieldPerception[];
}

export interface DifficultyConfig {
  key: Difficulty;
  name: string;
  desc: string;
  detail: string[];
  drain: number;
  power: number;
  powerRegen: number;
  distortion: number;
  eventRate: number;
  entity: number;
  goals: number;
  rooms: number;
  droneCharge: number;
  capacity: number;
  trackDelay: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  light: {
    key: 'light',
    name: '轻度异常',
    desc: '系统大体可信，故障有限。适合第一次配合。',
    detail: [
      '传感器失真概率低，多数读数可以直接采信',
      '氧气消耗较慢，电力回充充足',
      '未知目标不一定存在',
      '需要完成 3 项任务目标',
    ],
    drain: 0.66,
    power: 100,
    powerRegen: 2.6,
    distortion: 0.12,
    eventRate: 0.12,
    entity: 0.6,
    goals: 3,
    rooms: 12,
    droneCharge: 6,
    capacity: 5,
    trackDelay: 1,
  },
  unstable: {
    key: 'unstable',
    name: '系统失控',
    desc: '数据开始互相矛盾，你们需要不断确认对方说了什么。',
    detail: [
      '部分传感器损坏，读数可能与现场完全相反',
      '电网不稳定，分区会自行断电',
      '未知目标持续活动',
      '需要完成 4 项任务目标',
    ],
    drain: 0.82,
    power: 86,
    powerRegen: 2.3,
    distortion: 0.28,
    eventRate: 0.2,
    entity: 1,
    goals: 4,
    rooms: 13,
    droneCharge: 5,
    capacity: 4,
    trackDelay: 2,
  },
  silence: {
    key: 'silence',
    name: '深空静默',
    desc: '系统会说谎，而且不会承认。你们只剩下彼此。',
    detail: [
      '大量假信号与延迟数据，"无异常"未必安全',
      '电力紧张，扫描一次就要付出代价',
      '未知目标会被噪声吸引，主动接近',
      '需要完成全部 5 项任务目标',
    ],
    drain: 0.9,
    power: 72,
    powerRegen: 2.0,
    distortion: 0.44,
    eventRate: 0.28,
    entity: 1,
    goals: 5,
    rooms: 14,
    droneCharge: 4,
    capacity: 4,
    trackDelay: 3,
  },
};
