import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeviceChecks } from '../src/game/deviceChecks';

for (const result of runDeviceChecks()) {
  test(result.name, () => assert.equal(result.passed, true, result.detail));
}