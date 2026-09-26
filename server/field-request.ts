import { z } from 'zod';
import type { ActionResult, FieldAction } from '../src/game/actions';

const room = z.number().int().positive();
const text = z.string().max(200);
const id = z.string().min(1).max(100);
export const operatorActionSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('scan'), room }),
  z.object({ t: z.literal('door'), door: id, action: z.enum(['lock', 'unlock']) }),
  z.object({ t: z.literal('power'), zone: z.enum(['A', 'B', 'C', 'D']), action: z.enum(['on', 'off', 'reroute']), target: z.enum(['A', 'B', 'C', 'D']).optional() }),
  z.object({ t: z.literal('drone'), room }),
  z.object({ t: z.literal('drone_attack'), room: room.optional() }),
  z.object({ t: z.literal('trace'), room: room.optional() }),
  z.object({ t: z.literal('help') }),
]);
export const fieldRequestSchema = z.object({
  roundId: id,
  requestId: id,
  action: z.discriminatedUnion('t', [
    z.object({ t: z.literal('move'), room }),
    ...(['search', 'wait', 'listen', 'answerKnock', 'ignoreKnock'] as const).map(t => z.object({ t: z.literal(t) })),
    z.object({ t: z.literal('attack'), weapon: z.enum(['fist', 'crowbar', 'sealant']) }),
    z.object({ t: z.literal('transmit'), text }),
    z.object({ t: z.literal('ping'), room, kind: z.enum(['help', 'scan', 'danger', 'note']), note: text.optional(), remove: z.boolean().optional() }),
    z.object({ t: z.literal('brace'), door: id, remove: z.boolean().optional() }),
    z.object({ t: z.literal('pickup'), item: id }),
    z.object({ t: z.literal('drop'), index: z.number().int().nonnegative(), item: id }),
    z.object({ t: z.literal('use'), item: id }),
    z.object({ t: z.literal('interact'), id }),
  ]),
});

export type FieldRequest = { roundId: string; requestId: string; action: FieldAction };
export type RequestCache = Map<string, { fingerprint: string; result: ActionResult }>;

/** 同一个请求重发只返回既有结果；重开后旧请求绝不能作用于新局。 */
export function executeFieldRequest(roundId: string, cache: RequestCache, input: unknown, apply: (action: FieldAction) => ActionResult): ActionResult {
  const parsed = fieldRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: '操作格式或页面版本不匹配，请刷新页面后重试。' };
  const request = parsed.data;
  if (request.roundId !== roundId) return { ok: false, message: '这条操作来自上一轮，未执行。请按当前画面重新选择。' };
  const fingerprint = JSON.stringify(request.action);
  const previous = cache.get(request.requestId);
  if (previous) return previous.fingerprint === fingerprint ? previous.result : { ok: false, message: '请求编号已被其他操作使用，未执行。' };
  const result = apply(request.action);
  cache.set(request.requestId, { fingerprint, result });
  // 按一局完整保留已执行编号；不能淘汰后让延迟重发再次生效。
  return result;
}
