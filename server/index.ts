// ─────────────────────────────────────────────────────────────────────────────
// 《失联之后》联机服务
//   · 权威 Game Engine（server/runs.ts）
//   · 浏览器同步：HTTP + WebSocket（现场员，只能拿到 FieldView）
//   · MCP Server：Streamable HTTP，路径 /mcp（远程操作员，只能拿到 OperatorView）
//
// 启动： npx tsx server/index.ts        （默认端口 8787）
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { z } from 'zod';
import { operatorActionSchema } from './field-request';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { createMcpServer } from './mcp';
import {
  claimLocalSeat,
  createRun,
  restartRun,
  retireRun,
  doFieldRequest,
  doOperatorAction,
  elapsedOf,
  fieldViewOf,
  getRun,
  listRuns,
  operatorSeatLive,
  operatorViewOf,
  presenceOf,
  setPaused,
  statusOf,
  subscribe,
  verifyField,
  type Run,
} from './runs';
import { buildReport } from '../src/game/report';
import type { Difficulty } from '../src/game/types';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

/* ───────────────────────── 工具 ───────────────────────── */

function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, X-Field-Token');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 现场员身份校验 */
function authField(req: http.IncomingMessage, run: Run, body?: Record<string, unknown>): boolean {
  const header = req.headers['x-field-token'];
  const token = (Array.isArray(header) ? header[0] : header) ?? (body?.fieldToken as string | undefined);
  return verifyField(run, token);
}

/**
 * 远程席兼任通道：只有在 MCP 远程席不在线时，浏览器端才能直接操作远程席。
 * MCP 在位时这里一律拒绝——两个人不允许同时握住同一个操纵杆。
 */
function seatFree(run: Run): { ok: true } | { ok: false; reason: string } {
  if (operatorSeatLive(run)) {
    return {
      ok: false,
      reason: `远端席位正由「${presenceOf(run).name}」接管。请用留言和标记与对方协作，而不是直接操作。`,
    };
  }
  return { ok: true };
}

const createOptions = z.object({ seed: z.string().max(200).optional(), difficulty: z.enum(['light', 'unstable', 'silence']).optional() });

/* ───────────────────────── MCP（Streamable HTTP，无状态） ───────────────────────── */

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // 无状态模式不维护 SSE 长连接
    cors(res);
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
    return;
  }
  const body = await readJson(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => void transport.close());
  cors(res);
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/* ───────────────────────── HTTP 路由 ───────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/mcp') return void (await handleMcp(req, res));

    if (path === '/health' || path === '/') {
      return json(res, 200, {
        service: '失联之后 · 联机服务',
        ok: true,
        mcpEndpoint: '/mcp',
        runs: listRuns().length,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (path === '/api/runs' && req.method === 'GET') {
      return json(res, 200, { runs: listRuns() });
    }

    if (path === '/api/runs' && req.method === 'POST') {
      const body = await readJson(req);
      if (!createOptions.safeParse(body).success) return json(res, 400, { error: '任务种子或难度无效，请重新选择。' });
      const previous = typeof body.replaceRunId === 'string' ? getRun(body.replaceRunId) : null;
      if (previous && !verifyField(previous, body.replaceToken as string | undefined))
        return json(res, 403, { error: '旧局身份无效，未创建新局。' });
      const { runId, fieldToken } = createRun({
        seed: body.seed as string | undefined,
        difficulty: body.difficulty as Difficulty | undefined,
      });
      if (previous) retireRun(previous);
      const run = getRun(runId)!;
      return json(res, 200, { fieldToken, ...fieldViewOf(run) });
    }

    const m = path.match(/^\/api\/runs\/([A-Za-z0-9]+)(\/.*)?$/);
    if (m) {
      const run = getRun(m[1]);
      if (!run) return json(res, 404, { error: `对局 ${m[1]} 不存在，可能已经结束或服务重启过。` });
      const sub = m[2] ?? '';
      const body = req.method === 'POST' ? await readJson(req) : {};

      if (sub === '' && req.method === 'GET') {
        if (!authField(req, run)) return json(res, 403, { error: '现场员身份校验失败。' });
        return json(res, 200, fieldViewOf(run));
      }
      if (sub === '/status') return json(res, 200, statusOf(run));

      // 任务结束后信息壁垒解除，现场员可以取回完整的任务记录
      if (sub === '/debrief' && req.method === 'GET') {
        if (!authField(req, run)) return json(res, 403, { error: '身份校验失败。' });
        if (run.state.status === 'playing')
          return json(res, 409, { error: '任务尚未结束，结算数据暂不开放。' });
        return json(res, 200, { report: buildReport({ ...run.state, elapsedMs: elapsedOf(run) }) });
      }

      if (sub === '/leave' && req.method === 'POST') {
        if (!authField(req, run)) return json(res, 403, { error: '现场员身份校验失败。' });
        retireRun(run);
        return json(res, 200, { ok: true });
      }
      if (sub === '/restart' && req.method === 'POST') {
        if (!authField(req, run)) return json(res, 403, { error: '现场员身份校验失败。' });
        if ((body.seed !== undefined && (typeof body.seed !== 'string' || body.seed.length > 200)) ||
            (body.difficulty !== undefined && !['light', 'unstable', 'silence'].includes(String(body.difficulty)))) {
          return json(res, 400, { error: '重开参数无效。' });
        }
        restartRun(run, body.seed as string | undefined, body.difficulty as Difficulty | undefined);
        return json(res, 200, fieldViewOf(run));
      }

      // ── 现场员通道 ──
      if (sub === '/field' && req.method === 'GET') {
        if (!authField(req, run)) return json(res, 403, { error: '现场员身份校验失败。' });
        return json(res, 200, fieldViewOf(run));
      }
      if (sub === '/field/action' && req.method === 'POST') {
        if (!authField(req, run, body)) return json(res, 403, { error: '现场员身份校验失败。' });
        const result = doFieldRequest(run, body);
        return json(res, 200, { ...result, ...fieldViewOf(run) });
      }
      if (sub === '/pause' && req.method === 'POST') {
        if (!authField(req, run, body)) return json(res, 403, { error: '现场员身份校验失败。' });
        setPaused(run, !!body.paused);
        return json(res, 200, fieldViewOf(run));
      }
      if (sub === '/seat' && req.method === 'POST') {
        if (!authField(req, run, body)) return json(res, 403, { error: '现场员身份校验失败。' });
        const okSeat = claimLocalSeat(run, !!body.take);
        return json(res, okSeat ? 200 : 423, {
          ok: okSeat,
          error: okSeat ? undefined : seatFree(run),
          operatorView: okSeat && body.take ? operatorViewOf(run) : undefined,
          ...fieldViewOf(run),
        });
      }

      // ── 远程席兼任通道：无 MCP 在位时，浏览器直接下达结构化远程操作 ──
      if (sub === '/operator/action' && req.method === 'POST') {
        if (!authField(req, run, body)) return json(res, 403, { error: '身份校验失败。' });
        const allow = seatFree(run);
        if (!allow.ok) return json(res, 423, { error: allow.reason, locked: true });
        if (body.roundId !== run.roundId) return json(res, 409, { error: '页面轮次已过期，操作未执行。请等待同步或刷新页面。' });
        const parsed = operatorActionSchema.safeParse(body.action);
        if (!parsed.success) return json(res, 400, { error: '远程操作参数无效，未执行。' });
        const r = doOperatorAction(run, parsed.data, '现场员兼任');
        return json(res, 200, { ok: r.ok, message: r.message, operatorView: operatorViewOf(run), ...fieldViewOf(run) });
      }
    }

    return json(res, 404, { error: '接口不存在。' });
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) json(res, 500, { error: '请求未能处理，请检查连接并重试。' });
  }
});

/* ───────────────────────── WebSocket：现场员实时同步 ───────────────────────── */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const runId = url.searchParams.get('run') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const run = getRun(runId);
  if (!run || !verifyField(run, token)) {
    ws.send(JSON.stringify({ type: 'error', message: '对局不存在或身份校验失败。' }));
    ws.close();
    return;
  }
  const unsubscribe = subscribe(run, {
    send: (payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload)),
  });

  // 远程席在位状态需要按时间衰减，因此定时推送一次心跳视图
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'presence', runId: run.id, operator: presenceOf(run), paused: run.paused }));
  }, 5000);

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown> = {};
    try {
      msg = JSON.parse(String(raw));
      if (!msg || typeof msg !== 'object') return;
    } catch {
      return;
    }
    if (msg.type === 'field_action') {
      const result = doFieldRequest(run, msg);
      ws.send(JSON.stringify({ type: 'action_result', id: msg.id, ...result }));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  《失联之后》联机服务已启动');
  console.log(`  游戏同步 API : http://${HOST}:${PORT}/api/runs`);
  console.log(`  现场员 WS    : ws://${HOST}:${PORT}/ws?run=<对局编号>&token=<现场令牌>`);
  console.log(`  MCP 端点     : http://${HOST}:${PORT}/mcp   （Streamable HTTP）`);
  console.log(`  stdio 桥接   : npx tsx server/mcp-stdio.ts  （供 Claude Desktop 等使用）`);
  console.log('');
});
