import type { GameState, Room } from './types';
import { adjacency, getRoom, interactOptions } from './engine';

export type DeviceSelection = { type: 'room'; id: number } | { type: 'door'; id: string } | { type: 'item'; index: number };
export interface DeviceGuidance {
  title: string;
  detail: string;
  roomId?: number;
  doorId?: string;
  action?: 'search' | 'listen' | 'wait' | 'item' | 'interact';
}

export const GOAL_FEATURE: Record<string, Room['feature']> = {
  power_pod: 'breaker', nav_core: 'nav', fix_comm: 'comm', auth: 'auth', alt_route: 'maintenance',
};

export function sonarFresh(state: GameState): boolean {
  return !!state.sonar && state.sonar.originRoom === state.player.room && state.turn - state.sonar.turn <= 3;
}

/** 只在现场已知的路线内寻路；听见危险的通道增加代价，而不是擅自替玩家封锁。 */
export function fieldRoute(state: GameState, target: number): number[] {
  const from = state.player.room;
  const known = new Set(state.rooms.filter((r) => r.visited).map((r) => r.id));
  for (const r of state.rooms.filter((r) => r.visited)) adjacency(state, r.id).forEach((a) => known.add(a.room.id));
  known.add(state.podRoom);
  const cost = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const queue = new Set([from]);
  while (queue.size) {
    const current = [...queue].sort((a, b) => cost.get(a)! - cost.get(b)!)[0];
    queue.delete(current);
    if (current === target) break;
    for (const { room, door } of adjacency(state, current)) {
      if (!known.has(room.id) || door.braced) continue;
      if ((door.status === 'jammed' || (door.status === 'locked' && door.remoteBroken)) && !state.player.inventory.includes('crowbar')) continue;
      const penalty = (door.status === 'locked' ? 2 : 0) + (sonarFresh(state) && state.sonar?.doorId === door.id ? 6 : 0);
      const next = cost.get(current)! + 1 + penalty;
      if (next < (cost.get(room.id) ?? Infinity)) { cost.set(room.id, next); prev.set(room.id, current); queue.add(room.id); }
    }
  }
  if (from !== target && !prev.has(target)) return [];
  const route = [target];
  while (route[0] !== from) route.unshift(prev.get(route[0])!);
  return route;
}

export function deviceGuidance(state: GameState, direct: boolean): DeviceGuidance {
  const here = getRoom(state, state.player.room);
  const bag = state.player.inventory;
  if (state.player.suitLeak > 0 && bag.includes('sealant')) return { title: '先修补防护服', detail: '点设备上的密封胶，再点「使用」。', action: 'item' };
  if (state.oxygen <= 35 && bag.includes('o2')) return { title: '补充氧气再继续', detail: '点背包里的氧气罐，再点「接入氧气罐」。', action: 'item' };
  if (state.player.health <= 45 && bag.includes('adrenaline')) return { title: '注射肾上腺素', detail: '生命值过低。点背包里的肾上腺素注射器回血 40。', action: 'item' };
  if (state.player.health <= 60 && bag.includes('energygel')) return { title: '服用能量胶', detail: '点背包里的能量胶回血 20，稳住状态。', action: 'item' };
  const ready = (state.fieldInteractions ?? interactOptions(state)).find((o) => o.enabled);
  if (ready) return { title: ready.label, detail: '设施就在本舱，使用下方现场处置键。', roomId: here.id, action: 'interact' };
  if (sonarFresh(state) && state.sonar?.danger && state.sonar.doorId) return {
    title: `绕开 ${state.sonar.doorId} 的动静`, detail: '地图橙色门线是刚听见的来路。可绕行或点该门安装压差楔。', doorId: state.sonar.doorId,
  };
  const needs = state.goals.filter((g) => !g.done);
  const keyNeed = new Set<string>();
  needs.forEach((g) => {
    if (g.kind === 'power_pod' || g.kind === 'fix_comm') keyNeed.add('toolkit');
    if (g.kind === 'nav_core') keyNeed.add('navcore');
    if (g.kind === 'auth') keyNeed.add('idcard');
    if (g.kind === 'alt_route') keyNeed.add('crowbar');
  });
  const keyOnFloor = here.items.find((it) => keyNeed.has(it) && !bag.includes(it));
  if (keyOnFloor) return { title: bag.length < state.player.capacity ? '拿上本舱的关键物资' : '腾出一格背包', detail: '地面物品在设备下方；点击拾取。背包满时先使用补给或放下非必需品。', action: 'item' };

  if (state.flags.breakerFixed && needs.some((g) => g.kind === 'power_pod')) return {
    title: `恢复 ${getRoom(state, state.podRoom).zone} 区供电`, roomId: state.podRoom,
    detail: direct ? '点地图中的逃生舱，再拨动设备上的供电开关。' : '点逃生舱，再按供电键向搭档请求合闸。',
  };
  if (!here.searched) return { title: '翻找当前舱室', detail: '按下设备左侧「翻找」键。一次搜索即可找出物资与线索。', action: 'search', roomId: here.id };

  const goal = needs[0];
  let target = !goal ? getRoom(state, state.podRoom) : undefined;
  if (goal) {
    const need = goal.kind === 'nav_core' ? 'navcore' : goal.kind === 'auth' ? 'idcard' : goal.kind === 'alt_route' ? 'crowbar' : 'toolkit';
    if (bag.includes(need)) target = state.rooms.find((r) => r.feature === GOAL_FEATURE[goal.kind]);
    else target = state.rooms.find((r) => r.visited && r.items.includes(need));
  }
  if (target?.id === here.id && !state.zones[here.zone].powered) return {
    title: `接通 ${here.zone} 区供电`, detail: direct ? '拨动设备的供电开关，再操作设施。' : '向远程席请求恢复本区供电。', roomId: here.id,
  };
  const candidates = state.rooms.filter((r) => !r.visited).map((r) => ({ r, path: fieldRoute(state, r.id) }))
    .filter((a) => a.path.length > 1).sort((a, b) => a.path.length - b.path.length);
  let path = target ? fieldRoute(state, target.id) : [];
  if (path.length < 2 && candidates.length) { target = candidates[0].r; path = candidates[0].path; }
  if (target && path.length > 1) {
    const next = path[1];
    const door = adjacency(state, here.id).find((a) => a.room.id === next)!.door;
    if (door.status === 'locked' && !door.remoteBroken) return {
      title: `先解锁 ${door.id} 舱门`, detail: direct ? `点击地图上的 ${door.id} 门标，设备会显示「解锁」。无需等待搭档。` : `点击 ${door.id} 门标，请远程席解锁。`, doorId: door.id, roomId: next,
    };
    return { title: `前往 ${next} 号舱`, detail: '直接点地图中亮起的相邻舱室，一次点击走一段。', roomId: next };
  }
  const frontierDoor = state.rooms.filter((r) => r.visited).flatMap((r) => adjacency(state, r.id))
    .find(({ room, door }) => !room.visited && door.status === 'locked' && !door.remoteBroken);
  if (frontierDoor) return { title: `检查 ${frontierDoor.door.id} 门`, detail: '这扇门后仍有未探索区域；点击门标查看。', doorId: frontierDoor.door.id };
  return { title: '确认手头物资与去路', detail: '选中地图舱室查看设备上的操作。完成任务后，返回逃生舱。' };
}
