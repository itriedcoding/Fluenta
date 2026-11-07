import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, versionParts } from '../apps/web/src/lib/version.ts';

test('version parts ignore a leading v', () => {
  assert.deepEqual(versionParts('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(versionParts('2.0'), [2, 0]);
  assert.deepEqual(versionParts('not-a-version'), []);
});

test('isNewerVersion only reports genuine upgrades', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('v1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
  assert.equal(isNewerVersion('v1.0.0', '1.0'), false);
  assert.equal(isNewerVersion('garbage', '1.0.0'), false);
});
