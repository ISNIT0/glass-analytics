import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UPGRADE_COMMAND, isNewerThan, parseSemver, upgradeMessage } from '../src/version.ts';

describe('version helpers', () => {
  it('parses dotted semver and compares', () => {
    assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseSemver('0.2.0-beta'), [0, 2, 0]);
    assert.equal(parseSemver('nope'), null);
    assert.equal(isNewerThan('0.2.0', '0.1.0'), true);
    assert.equal(isNewerThan('0.1.0', '0.2.0'), false);
    assert.equal(isNewerThan('0.1.0', '0.1.0'), false);
    assert.equal(isNewerThan('1.0.0', '0.9.9'), true);
  });

  it('names the upgrade command', () => {
    assert.match(upgradeMessage('0.1.0', '0.2.0'), /0\.1\.0/);
    assert.match(upgradeMessage('0.1.0', '0.2.0'), /0\.2\.0/);
    assert.match(upgradeMessage('0.1.0', '0.2.0'), new RegExp(UPGRADE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
