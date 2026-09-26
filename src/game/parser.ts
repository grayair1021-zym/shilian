import type { Command } from './engine';
import type { GameState, Room } from './types';

export interface ParseResult {
  commands: Command[];
  errors: string[];
}

const CN_NUM: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function cnNumbers(text: string): string {
  return text.replace(/[零一二两三四五六七八九十]+/g, (m) => {
    if (m === '十') return '10';
    if (/^十[一二三四五六七八九]$/.test(m)) return String(10 + CN_NUM[m[1]]);
    if (/^[一二两三四五六七八九]十$/.test(m)) return String(CN_NUM[m[0]] * 10);
    if (/^[一二两三四五六七八九]十[一二三四五六七八九]$/.test(m))
      return String(CN_NUM[m[0]] * 10 + CN_NUM[m[2]]);
    if (m.length === 1 && CN_NUM[m] !== undefined) return String(CN_NUM[m]);
    return m;
  });
}

const VERB_FIX: [RegExp, string][] = [
  [/扫一下|扫一扫|扫一遍|扫个/g, '扫描'],
  [/扫描一下|扫描一遍/g, '扫描'],
  [/看一下|看一看|瞧一下/g, '查看'],
  [/查一下|查一查/g, '检查'],
  [/读一下|读一读/g, '读取'],
  [/开一下|开一开/g, '打开'],
  [/关一下/g, '关闭'],
  [/追一下|追一追/g, '追踪'],
  [/确认一下/g, '确认'],
  [/试一下|试一试/g, '尝试'],
];

function normalize(raw: string): string {
  let t = raw
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim();
  for (const [re, rep] of VERB_FIX) t = t.replace(re, rep);
  t = cnNumbers(t);
  t = t.replace(/甲区/g, 'A区').replace(/乙区/g, 'B区').replace(/丙区/g, 'C区').replace(/丁区/g, 'D区');
  return t.toUpperCase();
}

const SPLIT_RE = /[，,。；;、\n\r]+|然后|接着|之后|再帮我|再/;

const FEATURE_ALIAS: { key: string; words: string[] }[] = [
  { key: 'pod', words: ['逃生舱', '救生舱', '撤离舱'] },
  { key: 'breaker', words: ['配电间', '配电室', '配电'] },
  { key: 'comm', words: ['通讯中枢', '通讯', '通信'] },
  { key: 'nav', words: ['导航舱', '导航'] },
  { key: 'auth', words: ['主控室', '主控'] },
  { key: 'dronebay', words: ['无人机坞', '机坞'] },
  { key: 'maintenance', words: ['维修通道', '检修通道', '维修'] },
];

function resolveRoom(state: GameState, text: string): { room: Room | null; note?: string } {
  // 编号：3号舱 / 3号房 / 房间3 / R3
  const numeric =
    text.match(/(\d{1,2})\s*号/) ??
    text.match(/(?:房间|舱室|舱段|房|舱)\s*(\d{1,2})/) ??
    text.match(/\bR(\d{1,2})\b/);
  if (numeric) {
    const id = parseInt(numeric[1], 10);
    const room = state.rooms.find((r) => r.id === id);
    if (room) return { room };
  }
  // 完整名称
  let best: Room | null = null;
  let bestLen = 0;
  for (const r of state.rooms) {
    if (text.includes(r.name) && r.name.length > bestLen) {
      best = r;
      bestLen = r.name.length;
    }
  }
  if (best) return { room: best };
  // 设施别名
  for (const f of FEATURE_ALIAS) {
    for (const w of f.words) {
      if (text.includes(w)) {
        const room = state.rooms.find((r) => r.feature === f.key);
        if (room) return { room };
        // 功能舱信息不可用时（例如远程席只有名称对照表），退回按名称匹配
        const byName = state.rooms.find((r) => r.name.includes(w) || w.includes(r.name));
        if (byName) return { room: byName };
      }
    }
  }
  // 模糊匹配：允许"逃生舱"匹配"逃生舱区"、"配电"匹配"配电间"
  {
    let fuzzy: Room | null = null;
    let score = 0;
    for (const r of state.rooms) {
      const len = longestCommonRun(text, r.name);
      if (len >= 2 && len > score) {
        score = len;
        fuzzy = r;
      }
    }
    if (fuzzy) return { room: fuzzy };
  }
  // 方位词：先按名称，再按站体坐标推定（同侧取最靠外的一舱）
  const dirs: [RegExp, string][] = [
    [/东/, '东'],
    [/西/, '西'],
    [/南/, '南'],
    [/北/, '北'],
    [/中央|中间|中部/, '中'],
  ];
  for (const [re, ch] of dirs) {
    if (re.test(text)) {
      const matches = state.rooms.filter((r) => r.name.includes(ch));
      if (matches.length === 1) return { room: matches[0] };
      if (matches.length > 1) {
        return { room: matches[0], note: `方位描述对应多个舱室，已按最靠前的${matches[0].id} 号舱执行。` };
      }
    }
  }
  const hasCoords = typeof state.rooms[0]?.x === 'number';
  if (hasCoords) {
    const edge: [RegExp, (rs: Room[]) => Room[]][] = [
      [/东/, (rs) => rs.filter((r) => r.x === Math.max(...rs.map((o) => o.x)))],
      [/西/, (rs) => rs.filter((r) => r.x === Math.min(...rs.map((o) => o.x)))],
      [/南/, (rs) => rs.filter((r) => r.y === Math.max(...rs.map((o) => o.y)))],
      [/北/, (rs) => rs.filter((r) => r.y === Math.min(...rs.map((o) => o.y)))],
    ];
    for (const [re, pick] of edge) {
      if (re.test(text)) {
        const cands = pick(state.rooms);
        const room = cands.find((r) => !r.visited) ?? cands[0];
        if (room) {
          return { room, note: `按方位推定为${room.id} 号舱（如有误请用编号明确指定）。` };
        }
      }
    }
  }
  return { room: null };
}

/** 最长公共连续子串长度，用于中文舱室名的模糊匹配 */
function longestCommonRun(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diagonal + 1;
        if (prev[j] > best) best = prev[j];
      } else {
        prev[j] = 0;
      }
      diagonal = tmp;
    }
  }
  return best;
}

function resolveDoor(state: GameState, text: string): string | null {
  const m = text.match(/\b([A-D])\s*-?\s*(\d{1,2})\b/) ?? text.match(/([A-D])(\d{1,2})/);
  if (m) {
    const id = `${m[1]}${parseInt(m[2], 10)}`;
    if (state.doors[id]) return id;
  }
  return null;
}

function resolveZones(state: GameState, text: string): string[] {
  const out: string[] = [];
  const re = /([A-D])\s*区/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (state.zones[m[1]] && !out.includes(m[1])) out.push(m[1]);
  }
  if (!out.length) {
    const alt = text.match(/([A-D])\s*(?:分区|电网|供电|区域)/);
    if (alt && state.zones[alt[1]]) out.push(alt[1]);
  }
  return out;
}

/** 供 MCP / 服务端复用：把一段中文目标描述解析成舱室。 */
export function resolveRoomByText(state: GameState, text: string): Room | null {
  return resolveRoom(state, normalize(text)).room;
}

/** 供 MCP / 服务端复用：解析舱门编号。 */
export function resolveDoorByText(state: GameState, text: string): string | null {
  return resolveDoor(state, normalize(text));
}

/** 供 MCP / 服务端复用：解析分区字母。 */
export function resolveZoneByText(state: GameState, text: string): string | null {
  const t = normalize(text);
  const zones = resolveZones(state, t);
  if (zones.length) return zones[0];
  const bare = t.match(/\b([A-D])\b/);
  return bare && state.zones[bare[1]] ? bare[1] : null;
}

export function parseCommands(state: GameState, input: string): ParseResult {
  const commands: Command[] = [];
  const errors: string[] = [];
  const raw = normalize(input);
  if (!raw) return { commands, errors: ['指令为空。'] };

  const fragments = raw
    .split(SPLIT_RE)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  for (const frag of fragments.slice(0, 6)) {
    const doorId = resolveDoor(state, frag);
    const zones = resolveZones(state, frag);
    const roomRes = resolveRoom(state, frag);

    const isHelp = /帮助|指令列表|有哪些指令|怎么操作|说明一下|HELP/.test(frag);
    const isDrone = /无人机|探测器|机器人|飞行器/.test(frag);
    const isTrace = /追踪|溯源|信号源|三角定位|定位信号|找出信号|锁定信号|追一下|信号/.test(frag);
    const powerWord = /供电|电力|电源|电网|通电|断电|合闸|送电|拉闸|电/.test(frag);
    const offWord = /关闭|切断|断开|停掉|停止|切掉|断掉|拉闸|关掉|断电|停电/.test(frag);
    const onWord = /开启|恢复|接通|打开|通电|送电|合闸|供上|给.*供电|重新供电|上电/.test(frag);
    const transferWord = /转移|调配|调度|挪|转给|分给|调到|转到|匀/.test(frag);
    const lockWord = /锁定|锁上|上锁|锁死|封锁|封闭|锁住|关门|锁门|关上|关闭|关掉/.test(frag);
    const unlockWord = /解锁|解除锁定|打开|开启|放行|开门|松开|开一下/.test(frag);
    const scanWord = /扫描|扫一下|扫一扫|扫过|探测|检测|检查|查看|看一下|看看|读取|读一下|传感器|查一下|确认一下|监测/.test(frag);

    if (isHelp) {
      commands.push({ type: 'help', raw: frag });
      continue;
    }

    if (isDrone) {
      let target = roomRes.room?.id;
      if (!target && /返回|回来|回到我|过来|来我这|找我/.test(frag)) target = state.player.room;
      if (!target) {
        errors.push(`无人机指令缺少目标：「${frag}」。例如「无人机前往 5 号舱」或「无人机返回」。`);
        continue;
      }
      commands.push({ type: 'drone', room: target, raw: frag });
      continue;
    }

    if (isTrace && !doorId) {
      const focus = resolveRoom(state, frag).room;
      commands.push(focus ? { type: 'trace', room: focus.id, raw: frag } : { type: 'trace', raw: frag });
      continue;
    }

    if (powerWord && !doorId && (zones.length > 0 || transferWord)) {
      if (transferWord && zones.length >= 2) {
        commands.push({ type: 'transfer', zone: zones[0], zone2: zones[1], raw: frag });
        continue;
      }
      if (zones.length === 0) {
        errors.push(`没有识别到分区：「${frag}」。分区写作 A 区 / B 区 / C 区 / D 区。`);
        continue;
      }
      if (transferWord && zones.length === 1) {
        errors.push(`电力转移需要两个分区：「${frag}」。例如「把 B 区电力转移到 D 区」。`);
        continue;
      }
      if (offWord && !onWord) {
        commands.push({ type: 'power_off', zone: zones[0], raw: frag });
        continue;
      }
      if (onWord && !offWord) {
        commands.push({ type: 'power_on', zone: zones[0], raw: frag });
        continue;
      }
      if (offWord) {
        commands.push({ type: 'power_off', zone: zones[0], raw: frag });
        continue;
      }
      if (onWord) {
        commands.push({ type: 'power_on', zone: zones[0], raw: frag });
        continue;
      }
      errors.push(`不清楚是要接通还是切断 ${zones[0]} 区供电：「${frag}」。`);
      continue;
    }

    if (doorId && (lockWord || unlockWord || /门/.test(frag))) {
      const lockOnly = /锁定|锁上|上锁|锁死|封锁|封闭|锁住|关门|锁门|关上|关掉|关闭/.test(frag);
      const unlockOnly = /解锁|解除|打开|开启|放行|开门|松开/.test(frag);
      if (unlockOnly && !/(不要|别)(解锁|打开)/.test(frag)) {
        commands.push({ type: 'unlock', door: doorId, raw: frag });
      } else if (lockOnly) {
        commands.push({ type: 'lock', door: doorId, raw: frag });
      } else {
        commands.push({ type: 'unlock', door: doorId, raw: frag });
      }
      continue;
    }

    if ((lockWord || unlockWord) && /门|通道|舱口/.test(frag) && !doorId) {
      errors.push(`没有识别到舱门编号：「${frag}」。舱门写作 A1 / B2 / C4 这样的编号。`);
      continue;
    }

    if (scanWord) {
      if (!roomRes.room) {
        errors.push(`没有识别到要扫描的舱室：「${frag}」。例如「扫描 7 号舱」或「扫描东侧走廊」。`);
        continue;
      }
      if (roomRes.note) errors.push(roomRes.note);
      commands.push({ type: 'scan', room: roomRes.room.id, raw: frag });
      continue;
    }

    if (roomRes.room && /去|前往|到/.test(frag)) {
      commands.push({ type: 'scan', room: roomRes.room.id, raw: frag });
      continue;
    }

    errors.push(
      `没能理解这条指令：「${frag}」。可用格式：扫描 3 号舱 / 解锁 C4 / 锁定 B2 / 关闭 B 区供电 / 开启 D 区供电 / 把 A 区电力转移到 C 区 / 无人机前往 7 号舱 / 追踪信号（可指定区域）。`,
    );
  }

  return { commands, errors };
}
