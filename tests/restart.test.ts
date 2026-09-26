import assert from 'node:assert/strict';
import test from 'node:test';
import { createRun, getRun, restartRun, subscribe, touchOperator, setPaused, verifyField, presenceOf, dropRun } from '../server/runs';
test('联机重开保留身份、远程席与同步订阅，只重置局内进度', () => {
  const created = createRun({ seed: 'restart-check', difficulty: 'light' });
  const run = getRun(created.runId)!;
  try {
    touchOperator(run, '湛'); setPaused(run, true); run.state.turn = 8;
    const received: unknown[] = [];
    subscribe(run, { send: value => { received.push(value); } });
    const revision = run.revision;
    restartRun(run, 'new-seed', 'silence');
    assert.equal(getRun(created.runId), run);
    assert.equal(verifyField(run, created.fieldToken), true);
    assert.equal(run.state.turn, 1); assert.equal(run.state.seed, 'new-seed');
    assert.equal(run.paused, false); assert.equal(presenceOf(run).connected, true);
    assert.equal(presenceOf(run).name, '湛'); assert.ok(run.revision > revision);
    assert.equal(received.length, 2);
  } finally { dropRun(created.runId); }
});
