import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp';
import { createRun, doFieldAction, dropRun, fieldViewOf, getRun, subscribe } from '../server/runs';
import { advanceAtmosphere } from '../src/game/atmosphere';
import { adjacency, doorStatusText } from '../src/game/engine';

test('MCP 只拿远端碎片，写操作带真实最终确认并同步到现场', async () => {
  const { runId } = createRun({ seed: 'MCP 氛围集成检查', difficulty: 'unstable' });
  const run = getRun(runId)!;
  const world = run.state;
  for (const room of world.rooms) { room.hazard = null; room.visualNoise = false; room.sensor = 'ok'; }
  for (const zone of Object.values(world.zones)) { zone.powered = true; zone.unstable = false; }
  for (const door of Object.values(world.doors)) { door.braced = false; door.remoteBroken = false; door.status = 'open'; }
  const nav = world.rooms.find((r) => r.feature === 'nav')!;
  world.player.room = nav.id;
  nav.visited = true;
  world.entity.exists = true;
  world.entity.room = adjacency(world, nav.id)[0].room.id;
  world.turn = 10;
  world.atmosphere!.nextTurn = 10;
  advanceAtmosphere(world);
  const fieldText = world.atmosphere!.incidents[0].field!.text;
  const remoteText = world.atmosphere!.incidents[0].operator!.text;

  const server = createMcpServer();
  const client = new Client({ name: '氛围回归测试', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let syncCount = 0;
  const unsubscribe = subscribe(run, { send: () => { syncCount += 1; } });
  try {
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({
      name, arguments: { ...args, run_id: runId, round_id: run.roundId, operator_name: '测试席' },
    });
    const view = await call('operator_view');
    assert.ok(JSON.stringify(view).includes(remoteText));
    assert.ok(!JSON.stringify(view).includes(fieldText));
    assert.ok(!JSON.stringify(await call('operator_log')).includes(fieldText));
    assert.ok(!JSON.stringify(fieldViewOf(run)).includes(remoteText));
    assert.equal(fieldViewOf(run).state.atmosphere, null);

    const oldTurn = world.turn;
    const oldLog = JSON.stringify(world.log);
    await call('operator_view');
    assert.equal(world.turn, oldTurn);
    assert.equal(JSON.stringify(world.log), oldLog);

    world.entity.exists = false;
    const door = Object.values(world.doors)[0];
    door.status = 'locked';
    const reply = await call('operator_door', { door_id: door.id, action: 'unlock' });
    assert.equal(reply.isError, false);
    const data = reply.structuredContent as {
      confirmation: {
        runId: string; asOfTurn: number; action: string; executed: boolean;
        resources: { oxygenPercent: number; power: number };
        doors: { id: string; status: string }[];
      };
    };
    assert.equal(data.confirmation.runId, runId);
    assert.equal(data.confirmation.asOfTurn, world.turn);
    assert.equal(data.confirmation.resources.power, Number(world.power.toFixed(1)));
    assert.equal(data.confirmation.resources.oxygenPercent, Number(world.oxygen.toFixed(1)));
    assert.equal(data.confirmation.doors.find((d) => d.id === door.id)!.status, doorStatusText(door.status));
    assert.ok(syncCount >= 2);

    world.pendingKnock = { turn: world.turn, dir: '东侧', roomId: world.player.room, expiresTurn: world.turn + 3 };
    await call('operator_say', { text: '建议先不要回答敲击声。' });
    assert.equal(world.entity.answeredKnock, false);
    assert.ok(world.pendingKnock);
    assert.equal(world.transmissions.at(-1)?.source, 'operator');
    assert.equal(world.transmissions.at(-1)?.text, '建议先不要回答敲击声。');
    doFieldAction(run, { t: 'transmit', text: '这句话确实由现场员发出。' });
    assert.equal(world.transmissions.at(-1)?.source, 'field');
    assert.ok(JSON.stringify(await call('operator_view')).includes('这句话确实由现场员发出。'));
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
    dropRun(runId);
  }
});
