// 行动指引：根据现场员可见的信息，推理出眼下最值得做的 1-3 件事。
// 只使用现场侧可观察的信息（去过的舱、相邻舱、声呐、背包、任务进度），
// 绝不读取世界真值（未知目标位置、隐藏危险、传感器是否说谎）。

import { adjacency, getRoom, interactOptions } from './engine';
import type { FieldAction } from './actions';
import type { GameState, PingKind } from './types';

export type SuggestionRun =
  | { kind: 'field'; action: FieldAction }
  | { kind: 'focus'; room: number }
  | { kind: 'message'; text: string }
  | { kind: 'ping'; room: number; pingKind: PingKind; note: string };

export interface Suggestion {
  id: string;
  title: string;
  reason: string;
  run: SuggestionRun[];
  urgent?: boolean;
}

const hasItem = (state: GameState, id: string) => state.player.inventory.includes(id);

/** 现场员认知中的已知舱室：去过 + 去过之地的相邻舱 + 撤离点（简报公开）。 */
function knownRooms(state: GameState): Set<number> {
  const known = new Set<number>([state.podRoom]);
  for (const r of state.rooms) if (r.visited) known.add(r.id);
  for (const r of state.rooms) {
    if (!r.visited) continue;
    for (const { room } of adjacency(state, r.id)) known.add(room.id);
  }
  return known;
}

function roomLabel(state: GameState, id: number): string {
  const r = getRoom(state, id);
  return `${r.id} 号${r.visited || id === state.podRoom ? r.name : '区域'}`;
}

interface Route {
  path: number[];
  lockedDoors: string[];
}

/** 在已知舱室内寻路。锁定的门记下来（可请求远端解锁），卡死/楔住的门视为不通。 */
function findRoute(state: GameState, from: number, to: number): Route | null {
  const known = knownRooms(state);
  if (!known.has(to)) return null;
  const prev = new Map<number, number>();
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) break;
    for (const { room, door } of adjacency(state, cur)) {
      if (!known.has(room.id) || seen.has(room.id)) continue;
      if (door.braced || door.status === 'jammed') continue;
      seen.add(room.id);
      prev.set(room.id, cur);
      q.push(room.id);
    }
  }
  if (from !== to && !prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0])!);
  const lockedDoors: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = getRoom(state, path[i]);
    for (const dId of a.doors) {
      const d = state.doors[dId];
      const other = d.a === path[i] ? d.b : d.a;
      if (other === path[i + 1] && d.status === 'locked') lockedDoors.push(dId);
    }
  }
  return { path, lockedDoors };
}

function featureRoom(state: GameState, feature: string): number | null {
  const r = state.rooms.find((x) => x.feature === feature);
  return r ? r.id : null;
}

function nearestUnvisited(state: GameState): number | null {
  const known = knownRooms(state);
  let best: number | null = null;
  let bestDist = Infinity;
  for (const r of state.rooms) {
    if (r.visited || !known.has(r.id)) continue;
    const route = findRoute(state, state.player.room, r.id);
    const d = route ? route.path.length : 99;
    if (d < bestDist) {
      bestDist = d;
      best = r.id;
    }
  }
  return best;
}

/** 朝目标走一步：能走就走，被锁就请求解锁，到不了就定位。 */
function stepToward(state: GameState, target: number, why: string): Suggestion {
  const route = findRoute(state, state.player.room, target);
  const label = roomLabel(state, target);
  if (route && route.path.length > 1) {
    const firstLocked = route.lockedDoors[0];
    const door = firstLocked ? state.doors[firstLocked] : null;
    const doorKnown =
      door && (getRoom(state, door.a).visited || getRoom(state, door.b).visited || door.a === state.player.room || door.b === state.player.room);
    if (firstLocked && doorKnown && door) {
      return {
        id: `unlock-${firstLocked}`,
        title: `请开 ${firstLocked} 门`,
        reason: `去${label}的路被这扇门锁住${why ? `，${why}` : ''}`,
        run: [
          { kind: 'ping', room: target, pingKind: 'help', note: `需要经过 ${firstLocked}` },
          { kind: 'message', text: `请求解锁 ${firstLocked} 舱门，我要去${label}。` },
          { kind: 'focus', room: target },
        ],
      };
    }
    return {
      id: `goto-${target}`,
      title: `前往${label}`,
      reason: why || '继续推进',
      run: [{ kind: 'field', action: { t: 'move', room: route.path[1] } }],
    };
  }
  return {
    id: `focus-${target}`,
    title: `查看${label}`,
    reason: why || '先看清路线',
    run: [{ kind: 'focus', room: target }],
  };
}

export function suggestNext(state: GameState): Suggestion[] {
  if (state.status !== 'playing') return [];
  const out: Suggestion[] = [];
  const here = getRoom(state, state.player.room);
  const push = (s: Suggestion) => {
    if (out.length < 3 && !out.some((x) => x.id === s.id)) out.push(s);
  };

  // ── 1. 撤离流程（最高优先级） ──
  if (state.goals.every((g) => g.done)) {
    const podPowered = state.zones[getRoom(state, state.podRoom).zone].powered;
    if (state.player.room === state.podRoom && podPowered) {
      push({ id: 'escape', title: '启动逃生舱', reason: '条件齐备，回家', run: [{ kind: 'field', action: { t: 'interact', id: 'escape' } }], urgent: true });
      return out;
    }
    if (!podPowered) {
      const zone = getRoom(state, state.podRoom).zone;
      push({
        id: 'need-power',
        title: '请求逃生舱合闸',
        reason: `目标已完成，只差 ${zone} 区供电`,
        urgent: true,
        run: [
          { kind: 'ping', room: state.podRoom, pingKind: 'help', note: '请求合闸' },
          { kind: 'message', text: `目标已全部完成，请求为逃生舱所在 ${zone} 区合闸。` },
          { kind: 'focus', room: state.podRoom },
        ],
      });
    } else {
      const s = stepToward(state, state.podRoom, '目标完成，去逃生舱');
      push({ ...s, urgent: true });
    }
    return out;
  }

  // ── 2. 生存危机 ──
  if (state.player.suitLeak > 0 && hasItem(state, 'sealant')) {
    push({ id: 'seal', title: '封堵护服泄漏', reason: '氧气正在流失', urgent: true, run: [{ kind: 'field', action: { t: 'use', item: 'sealant' } }] });
  }
  if (state.oxygen <= 22) {
    if (hasItem(state, 'o2')) {
      push({ id: 'o2', title: '接入备用氧气罐', reason: '氧气告急', urgent: true, run: [{ kind: 'field', action: { t: 'use', item: 'o2' } }] });
    } else {
      push({ id: 'hold', title: '屏息省氧', reason: '氧气告急，先把消耗压下来', urgent: true, run: [{ kind: 'field', action: { t: 'wait' } }] });
    }
  }

  // ── 3. 本舱可执行的设施（处置危险 / 推进目标） ──
  const ready = interactOptions(state).find((o) => o.enabled && o.id !== 'escape');
  if (ready) {
    push({ id: `do-${ready.id}`, title: ready.label, reason: '就在本舱，现在就能做', run: [{ kind: 'field', action: { t: 'interact', id: ready.id } }] });
  }

  // ── 4. 本舱还没翻过 ──
  if (!here.searched) {
    push({ id: 'search', title: '翻找本舱', reason: '找物资、线索和遗留物', run: [{ kind: 'field', action: { t: 'search' } }] });
  }

  // ── 5. 声呐示警：附近有东西 ──
  const sonar = state.sonar;
  if (sonar && sonar.danger && state.turn - sonar.turn <= 2) {
    if (hasItem(state, 'wedge')) {
      // 把朝向威胁方向的门顶住
      const dirVec: Record<string, [number, number]> = { 东侧: [1, 0], 西侧: [-1, 0], 南侧: [0, 1], 北侧: [0, -1] };
      const v = dirVec[sonar.dir];
      const link = v
        ? adjacency(state, here.id).find(({ room }) => room.x - here.x === v[0] && room.y - here.y === v[1])
        : adjacency(state, here.id)[0];
      if (link && !link.door.braced) {
        push({
          id: `brace-${link.door.id}`,
          title: `楔住 ${link.door.id} 门`,
          reason: `声呐显示${sonar.dir}有动静，先封住来路`,
          urgent: true,
          run: [{ kind: 'field', action: { t: 'brace', door: link.door.id } }],
        });
      }
    } else {
      push({
        id: 'hide',
        title: '屏息躲避',
        reason: `声呐显示${sonar.dir}有动静，别出声`,
        urgent: true,
        run: [
          { kind: 'ping', room: here.id, pingKind: 'danger', note: sonar.label },
          { kind: 'field', action: { t: 'wait' } },
        ],
      });
    }
  }

  // ── 6. 第一个未完成目标的下一步 ──
  const goal = state.goals.find((g) => !g.done);
  if (goal) {
    if (goal.kind === 'power_pod' && state.flags.breakerFixed && !state.zones[getRoom(state, state.podRoom).zone].powered) {
      const zone = getRoom(state, state.podRoom).zone;
      push({
        id: 'req-power',
        title: '请求逃生舱合闸',
        reason: '配电阀已复位，等远端合闸',
        run: [
          { kind: 'ping', room: state.podRoom, pingKind: 'help', note: '请求合闸' },
          { kind: 'message', text: `配电阀已复位，请求为 ${zone} 区合闸。` },
        ],
      });
    } else {
      const need: Partial<Record<string, { item: string; itemName: string; feature: string; place: string }>> = {
        power_pod: { item: 'toolkit', itemName: '工程工具包', feature: 'breaker', place: '配电间' },
        nav_core: { item: 'navcore', itemName: '导航核心', feature: 'nav', place: '导航舱' },
        fix_comm: { item: 'toolkit', itemName: '工程工具包', feature: 'comm', place: '通讯中枢' },
        auth: { item: 'idcard', itemName: '船员身份卡', feature: 'auth', place: '主控室' },
        alt_route: { item: 'crowbar', itemName: '液压撬棍', feature: 'maintenance', place: '维修通道' },
      };
      const n = need[goal.kind];
      if (n) {
        if (hasItem(state, n.item)) {
          const target = featureRoom(state, n.feature);
          if (target !== null) push(stepToward(state, target, `去${n.place}：${goal.title}`));
        } else {
          const explore = nearestUnvisited(state);
          if (explore !== null) {
            push({ ...stepToward(state, explore, `先找到${n.itemName}：${goal.title}`), id: `find-${n.item}` });
          }
        }
      }
    }
  }

  // ── 7. 还没静听过？教一次 ──
  if (!here.listened && state.turn >= 2 && out.length < 3) {
    push({ id: 'listen-once', title: '静听一次', reason: '耗时 1 回合，获取现场方位线索', run: [{ kind: 'field', action: { t: 'listen' } }] });
  }

  return out.slice(0, 3);
}
