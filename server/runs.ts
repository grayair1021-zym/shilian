// ─────────────────────────────────────────────────────────────────────────────
// Game Engine 宿主：保存权威 WorldState，所有变更都在这里发生。
// 浏览器（现场员）与 MCP（远程操作员）连接的是同一个实例、同一局游戏。
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { executeFieldRequest, type RequestCache } from './field-request';
import {
  applyFieldAction,
  applyOperatorAction,
  describeOperatorAction,
  type FieldAction,
  type OperatorAction,
} from '../src/game/actions';
import { createGame, pushLog } from '../src/game/generator';
import { randomSeed } from '../src/game/rng';
import {
  projectField,
  projectOperator,
  projectOperatorLog,
  projectStatus,
  type GameStatusView,
  type OperatorPresence,
  type OperatorView,
} from '../src/game/views';
import type { Difficulty, GameState } from '../src/game/types';

/** MCP 远程席多久没有动作就视为断开（毫秒） */
export const OPERATOR_TIMEOUT_MS = 60_000;

export interface RunSubscriber {
  send(payload: unknown): void;
}

interface Run {
  id: string;
  roundId: string;
  retired: boolean;
  state: GameState;
  paused: boolean;
  createdAt: number;
  pauseAccumMs: number;
  pauseStartAt: number | null;
  fieldToken: string;
  operator: {
    name: string;
    kind: 'none' | 'mcp' | 'local';
    lastSeenAt: number | null;
    lastAction: string | null;
    lastActionAt: number | null;
    handshakes: number;
  };
  subscribers: Set<RunSubscriber>;
  revision: number;
  fieldRequests: RequestCache;
}

const runs = new Map<string, Run>();

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function createRun(opts: {
  seed?: string;
  difficulty?: Difficulty;
}): { runId: string; fieldToken: string } {
  const seed = (opts.seed ?? '').trim() || randomSeed();
  const difficulty: Difficulty = opts.difficulty ?? 'unstable';
  const id = shortId();
  const run: Run = {
    id,
    roundId: randomUUID(),
    retired: false,
    fieldRequests: new Map(),
    state: createGame(seed, difficulty, 'coop'),
    paused: false,
    createdAt: Date.now(),
    pauseAccumMs: 0,
    pauseStartAt: null,
    fieldToken: randomUUID(),
    operator: {
      name: '远程操作员',
      kind: 'none',
      lastSeenAt: null,
      lastAction: null,
      lastActionAt: null,
      handshakes: 0,
    },
    subscribers: new Set(),
    revision: 0,
  };
  pushLog(
    run.state,
    'system',
    `远端链路已建立，对局编号 ${id}。等待远程操作员接入控制端。`,
  );
  runs.set(id, run);
  return { runId: id, fieldToken: run.fieldToken };
}

export function restartRun(run: Run, seed?: string, difficulty?: Difficulty) {
  run.fieldRequests.clear();
  run.roundId = randomUUID();
  run.state = createGame(seed?.trim() || run.state.seed, difficulty ?? run.state.difficulty, 'coop');
  run.paused = false;
  run.createdAt = Date.now();
  run.pauseAccumMs = 0;
  run.pauseStartAt = null;
  run.operator.lastAction = null;
  run.operator.lastActionAt = null;
  pushLog(run.state, 'system', `任务重新开始；联机编号 ${run.id} 保持不变。远程席请重新读取状态，旧局情报已失效。`, true);
  broadcast(run);
}

export function retireRun(run: Run) {
  setPaused(run, true);
  run.retired = true;
}

export function getRun(runId?: string): Run | null {
  if (runId) { const run = runs.get(runId.toUpperCase()); return run && !run.retired ? run : null; }
  // 多局时不猜测现场员意图，要求明确选择。
  const active = [...runs.values()].filter(r => !r.retired);
  return active.length === 1 ? active[0] : null;
}

export function listRuns() {
  return [...runs.values()].filter(r => !r.retired).map((r) => ({
    runId: r.id,
    roundId: r.roundId,
    seed: r.state.seed,
    difficulty: r.state.difficulty,
    turn: r.state.turn,
    status: r.state.status,
    paused: r.paused,
    operator: presenceOf(r),
    createdAt: r.createdAt,
  }));
}

export function dropRun(runId: string) {
  runs.delete(runId.toUpperCase());
}

export function verifyField(run: Run, token: string | undefined): boolean {
  return !!token && token === run.fieldToken;
}

/* ───────────────────────── 远程席在位状态 ───────────────────────── */

export function presenceOf(run: Run): OperatorPresence {
  const live =
    run.operator.kind === 'mcp' &&
    run.operator.lastSeenAt !== null &&
    Date.now() - run.operator.lastSeenAt < OPERATOR_TIMEOUT_MS;
  return {
    name: run.operator.name,
    kind: live ? 'mcp' : run.operator.kind === 'mcp' ? 'none' : run.operator.kind,
    connected: live,
    lastAction: run.operator.lastAction,
    lastActionAt: run.operator.lastActionAt,
    lastSeenAt: run.operator.lastSeenAt,
  };
}

/** MCP 远程席是否正占用席位（占用时浏览器端的粘贴指令回退通道会被让出） */
export function operatorSeatLive(run: Run): boolean {
  return presenceOf(run).connected;
}

export function touchOperator(run: Run, name?: string) {
  const resumed = !operatorSeatLive(run);
  const nextName = name?.trim().slice(0, 24) || run.operator.name;
  const first = run.operator.kind !== 'mcp' || nextName !== run.operator.name;
  run.operator.kind = 'mcp';
  run.operator.lastSeenAt = Date.now();
  if (name && name.trim()) run.operator.name = name.trim().slice(0, 24);
  if (first) {
    run.operator.handshakes += 1;
    pushLog(
      run.state,
      'system',
      `远程操作员「${run.operator.name}」已接入控制端，远端席位由对方接管。`,
      true,
    );
    broadcast(run);
  } else if (resumed) {
    // 无调用超时不是传输断线；刷新在位状态，不重复记录接管。
    broadcast(run);
  }
}

/** 浏览器主动兼任远程席（MCP 未接入时的回退模式） */
export function claimLocalSeat(run: Run, take: boolean) {
  if (operatorSeatLive(run)) return false;
  run.operator.kind = take ? 'local' : 'none';
  run.operator.name = take ? '现场员兼任' : '远程操作员';
  broadcast(run);
  return true;
}

/* ───────────────────────── 视图投影（对外唯一出口） ───────────────────────── */

export function fieldViewOf(run: Run) {
  return {
    runId: run.id,
    roundId: run.roundId,
    revision: run.revision,
    paused: run.paused,
    operator: presenceOf(run),
    state: projectField({ ...run.state, elapsedMs: elapsedOf(run) }),
  };
}

export function operatorViewOf(run: Run): OperatorView & { roundId: string } {
  return { ...projectOperator(run.state, run.id, run.paused), roundId: run.roundId };
}

export function statusOf(run: Run): GameStatusView & { roundId: string } {
  return { ...projectStatus(run.state, run.id, run.paused, presenceOf(run)), roundId: run.roundId };
}

export function operatorLogOf(run: Run, limit?: number) {
  return projectOperatorLog(run.state, limit ?? 20);
}

/* ───────────────────────── 变更与广播 ───────────────────────── */

export function broadcast(run: Run) {
  run.revision += 1;
  const payload = { type: 'sync', ...fieldViewOf(run) };
  for (const sub of run.subscribers) {
    try {
      sub.send(payload);
    } catch {
      run.subscribers.delete(sub);
    }
  }
}

export function subscribe(run: Run, sub: RunSubscriber) {
  run.subscribers.add(sub);
  sub.send({ type: 'sync', ...fieldViewOf(run) });
  return () => run.subscribers.delete(sub);
}

export function setPaused(run: Run, paused: boolean) {
  if (run.paused === paused) return;
  const now = Date.now();
  if (paused) {
    run.pauseStartAt = now;
  } else if (run.pauseStartAt !== null) {
    run.pauseAccumMs += now - run.pauseStartAt;
    run.pauseStartAt = null;
  }
  run.paused = paused;
  pushLog(run.state, 'system', paused ? '任务已暂停，站内一切停在此刻。' : '任务恢复推进。');
  broadcast(run);
}

/** 任务用时（毫秒，扣除暂停）。联机结算以此为准。 */
export function elapsedOf(run: Run): number {
  const now = Date.now();
  const extra = run.paused && run.pauseStartAt !== null ? now - run.pauseStartAt : 0;
  return Math.max(0, now - run.createdAt - run.pauseAccumMs - extra);
}

export function doFieldAction(run: Run, action: FieldAction) {
  if (run.retired) return { ok: false, message: '旧局已结束，请进入当前联机任务。' };
  if (run.paused) return { ok: false, message: '任务处于暂停状态，无法行动。' };
  const res = applyFieldAction(run.state, action);
  broadcast(run);
  return res;
}

export function doFieldRequest(run: Run, input: unknown) {
  if (run.retired) return { ok: false, message: '旧局已结束，请进入当前联机任务。' };
  return executeFieldRequest(run.roundId, run.fieldRequests, input, (action) => doFieldAction(run, action));
}

export function doOperatorAction(run: Run, action: OperatorAction, actorName?: string) {
  if (run.retired) return { ok: false, message: '旧局已结束，远端指令未执行。' };
  if (run.paused) return { ok: false, message: '任务处于暂停状态，远端指令已挂起。' };
  const summary = describeOperatorAction(run.state, action);
  const actionTurn = run.state.turn;
  const res = applyOperatorAction(run.state, action, actorName ?? run.operator.name);
  if (res.ok) {
    run.operator.lastAction = summary;
    run.operator.lastActionAt = Date.now();
    if (actorName) run.operator.name = actorName.slice(0, 24);
  }
  broadcast(run);
  return { ...res, summary, actionTurn, settledTurn: run.state.turn };
}

export type { Run };
