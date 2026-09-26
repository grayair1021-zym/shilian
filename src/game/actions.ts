// 共享动作层：浏览器与服务端使用同一套动作定义与执行逻辑。
// 浏览器只在"本地单机模式"下自行执行；联机模式下所有动作都由服务端权威执行。

import {
  executeCommand,
  fieldAnswerKnock,
  fieldAttack,
  fieldDrop,
  fieldIgnoreKnock,
  fieldInteract,
  fieldListen,
  fieldMove,
  fieldPickup,
  fieldPing,
  fieldBraceDoor,
  fieldSearch,
  fieldTransmit,
  fieldUse,
  fieldWait,
  operatorDroneAttack,
  operatorPing,
  operatorSay,
  type Command,
} from './engine';
import type { GameState, PingKind } from './types';

export type FieldAction =
  | { t: 'move'; room: number }
  | { t: 'search' }
  | { t: 'wait' }
  | { t: 'listen' }
  | { t: 'answerKnock' }
  | { t: 'ignoreKnock' }
  | { t: 'attack'; weapon: 'fist' | 'crowbar' | 'sealant' }
  | { t: 'transmit'; text: string }
  | { t: 'ping'; room: number; kind: PingKind; note?: string; remove?: boolean }
  | { t: 'brace'; door: string; remove?: boolean }
  | { t: 'pickup'; item: string }
  | { t: 'drop'; index: number; item?: string }
  | { t: 'use'; item: string }
  | { t: 'interact'; id: string };

export type OperatorAction =
  | { t: 'scan'; room: number }
  | { t: 'door'; door: string; action: 'lock' | 'unlock' }
  | { t: 'power'; zone: string; action: 'on' | 'off' | 'reroute'; target?: string }
  | { t: 'drone'; room: number }
  | { t: 'drone_attack'; room?: number }
  | { t: 'trace'; room?: number }
  | { t: 'say'; text: string }
  | { t: 'ping'; room: number; kind: PingKind; note?: string }
  | { t: 'help' };

export interface ActionResult {
  ok: boolean;
  message: string;
  warnings?: string[];
}

function applyFieldActionInner(state: GameState, action: FieldAction): ActionResult {
  if (state.status !== 'playing') return { ok: false, message: '任务已经结束。' };
  let msg = '';
  switch (action.t) {
    case 'move':
      msg = fieldMove(state, action.room);
      break;
    case 'search':
      msg = fieldSearch(state);
      break;
    case 'wait':
      msg = fieldWait(state);
      break;
    case 'listen':
      msg = fieldListen(state);
      break;
    case 'answerKnock':
      msg = fieldAnswerKnock(state);
      break;
    case 'ignoreKnock':
      msg = fieldIgnoreKnock(state);
      break;
    case 'attack':
      msg = fieldAttack(state, action.weapon);
      break;
    case 'transmit':
      msg = fieldTransmit(state, action.text);
      break;
    case 'ping':
      msg = fieldPing(state, action.room, action.kind, action.note ?? '', action.remove);
      break;
    case 'brace':
      msg = fieldBraceDoor(state, action.door, action.remove);
      break;
    case 'pickup':
      msg = fieldPickup(state, action.item);
      break;
    case 'drop':
      msg = fieldDrop(state, action.index, action.item);
      break;
    case 'use':
      msg = fieldUse(state, action.item);
      break;
    case 'interact':
      msg = fieldInteract(state, action.id);
      break;
    default:
      msg = '未知的现场动作。';
  }
  return { ok: !msg, message: msg };
}

export function operatorActionToCommand(action: Exclude<OperatorAction, { t: 'say' } | { t: 'ping' } | { t: 'drone_attack' }>): Command {
  switch (action.t) {
    case 'scan':
      return { type: 'scan', room: action.room, raw: 'MCP:scan' };
    case 'door':
      return { type: action.action === 'lock' ? 'lock' : 'unlock', door: action.door, raw: 'MCP:door' };
    case 'power':
      if (action.action === 'reroute')
        return { type: 'transfer', zone: action.zone, zone2: action.target, raw: 'MCP:power' };
      return {
        type: action.action === 'on' ? 'power_on' : 'power_off',
        zone: action.zone,
        raw: 'MCP:power',
      };
    case 'drone':
      return { type: 'drone', room: action.room, raw: 'MCP:drone' };
    case 'trace':
      return { type: 'trace', room: action.room, raw: 'MCP:trace' };
    case 'help':
      return { type: 'help', raw: 'MCP:help' };
  }
}

function applyOperatorActionInner(
  state: GameState,
  action: OperatorAction,
  actorName = '远程操作员',
): ActionResult {
  if (state.status !== 'playing') return { ok: false, message: '任务已经结束。' };
  if (action.t === 'say' && (typeof action.text !== 'string' || !action.text.trim())) {
    return { ok: false, message: '消息为空，未发送。' };
  }
  if (action.t === 'ping' && (!state.rooms.some((r) => r.id === action.room) || !['help', 'scan', 'danger', 'note'].includes(action.kind))) {
    return { ok: false, message: '目标或标记类型无效，未发送。' };
  }
  // 通讯行为免费：不耗电力、不推进回合，随时可用
  if (action.t === 'say') return { ok: true, message: operatorSay(state, action.text, actorName) };
  if (action.t === 'ping')
    return { ok: true, message: operatorPing(state, action.room, action.kind, action.note ?? '') };
  if (action.t === 'drone_attack') {
    const res = operatorDroneAttack(state, action.room);
    return { ok: res.ok, message: res.receipt };
  }
  const res = executeCommand(state, operatorActionToCommand(action));
  return { ok: res.ok, message: res.receipt, warnings: res.warnings };
}

function withDecisionImpact(state: GameState, apply: () => ActionResult): ActionResult {
  const first = state.stats.decisions.length;
  const before = [state.player.health, state.oxygen, state.power, state.integrity];
  const goals = state.goals.filter((g) => g.done).length;
  const result = apply();
  const after = [state.player.health, state.oxygen, state.power, state.integrity];
  const resourceImpact = Math.min(40, Math.max(...after.map((v, i) => Math.abs(v - before[i]))));
  const weight = state.goals.filter((g) => g.done).length > goals ? 100 : resourceImpact;
  for (const entry of state.stats.decisions.slice(first)) {
    const weights = state.stats.decisionWeights ??= {};
    weights[entry] = Math.max(weights[entry] ?? 1, weight);
  }
  return result;
}

export function applyFieldAction(state: GameState, action: FieldAction): ActionResult {
  return withDecisionImpact(state, () => applyFieldActionInner(state, action));
}

export function applyOperatorAction(state: GameState, action: OperatorAction, actorName = '远程操作员'): ActionResult {
  return withDecisionImpact(state, () => applyOperatorActionInner(state, action, actorName));
}

/** 把一次远程操作压缩成一句中文摘要，用于"最近一次远程操作"的展示。 */
export function describeOperatorAction(state: GameState, action: OperatorAction): string {
  const roomName = (id: number) => {
    const r = state.rooms.find((x) => x.id === id);
    return r ? `${r.id} 号 ${r.name}` : `${id} 号舱`;
  };
  switch (action.t) {
    case 'scan':
      return `扫描${roomName(action.room)}`;
    case 'door':
      return `${action.action === 'lock' ? '锁定' : '解锁'} ${action.door} 舱门`;
    case 'power':
      if (action.action === 'reroute') return `把 ${action.zone} 区电力转移到 ${action.target} 区`;
      return `${action.action === 'on' ? '接通' : '切断'} ${action.zone} 区供电`;
    case 'drone':
      return `派无人机前往${roomName(action.room)}`;
    case 'drone_attack':
      return `无人机冲击${action.room ? roomName(action.room) : '未知目标'}`;
    case 'trace':
      return action.room !== undefined ? `重点追踪${roomName(action.room)}的信号` : '追踪未知信号';
    case 'say':
      return `留言：${action.text.slice(0, 24)}`;
    case 'ping':
      return `标记${roomName(action.room)}`;
    case 'help':
      return '调阅指令说明';
  }
}
