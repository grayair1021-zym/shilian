import assert from 'node:assert/strict';
import test from 'node:test';
import { runAtmosphereChecks } from '../src/game/atmosphereChecks';

for (const result of runAtmosphereChecks()) {
  test(result.name, () => assert.equal(result.passed, true, result.detail));
}