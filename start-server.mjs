#!/usr/bin/env node
// 《失联之后》联机服务启动器（不依赖 package.json 脚本）
//   node start-server.mjs            启动联机服务（HTTP + WebSocket + MCP）
//   node start-server.mjs --stdio    启动 MCP stdio 桥接
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const stdio = process.argv.includes('--stdio');
const target = path.join(here, 'server', stdio ? 'mcp-stdio.ts' : 'index.ts');
const tsx = path.join(here, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const child = spawn(tsx, [target], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
