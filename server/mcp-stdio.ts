#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// MCP stdio 桥接：给 Claude Desktop / Cursor 这类只支持 stdio 的客户端使用。
// 它不自己保存游戏状态，而是把每个工具调用转发到同一个联机服务的 /mcp 端点，
// 因此 AI 远程操作员操作的仍然是浏览器里那一局游戏。
//
// 启动： GAME_SERVER=http://127.0.0.1:8787 npx tsx server/mcp-stdio.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.GAME_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ENDPOINT = new URL(`${BASE}/mcp`);

async function connectUpstream(): Promise<Client> {
  const client = new Client({ name: 'shilian-stdio-bridge', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(ENDPOINT));
  return client;
}

async function main() {
  let upstream: Client | null = null;
  const ensure = async (): Promise<Client> => {
    if (upstream) return upstream;
    upstream = await connectUpstream();
    return upstream;
  };

  const server = new Server(
    { name: 'shilian-zhihou-operator-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await ensure();
    const list = await client.listTools();
    return { tools: list.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const client = await ensure();
      return (await client.callTool({
        name: req.params.name,
        arguments: req.params.arguments ?? {},
      })) as never;
    } catch (err) {
      upstream = null;
      return {
        content: [
          {
            type: 'text' as const,
            text: `无法连接到《失联之后》联机服务（${BASE}）。请确认服务已经启动：npx tsx server/index.ts\n原始错误：${String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(`[失联之后] stdio 桥接已就绪，上游：${ENDPOINT.href}`);
}

main().catch((err) => {
  console.error('[失联之后] stdio 桥接启动失败：', err);
  process.exit(1);
});
