import * as assert from 'assert';

import { checkServerVersion, compareVersions, MIN_SERVER_VERSION } from '../../src/serverVersion';

const IMAGE = 'kwerle/ruby_language_server';

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    assert.strictEqual(compareVersions('0.9.10', '0.9.8'), 1);
    assert.strictEqual(compareVersions('0.9.8', '0.9.10'), -1);
    assert.strictEqual(compareVersions('1.0.0', '0.99.99'), 1);
    assert.strictEqual(compareVersions('0.9.8', '0.9.8'), 0);
  });

  it('treats missing parts as 0 and ignores pre-release suffixes', () => {
    assert.strictEqual(compareVersions('0.9', '0.9.0'), 0);
    assert.strictEqual(compareVersions('0.9.8-beta', '0.9.8'), 0);
  });
});

describe('checkServerVersion', () => {
  it('logs the name and version of a recent enough server, with no warning', () => {
    const check = checkServerVersion({ name: 'ruby_language_server', version: '0.9.9' }, IMAGE);
    assert.strictEqual(check.log, 'Server: ruby_language_server 0.9.9');
    assert.strictEqual(check.warning, undefined);
  });

  it('accepts exactly the minimum version', () => {
    assert.strictEqual(checkServerVersion({ name: 's', version: MIN_SERVER_VERSION }, IMAGE).warning, undefined);
  });

  it('warns about an older server, saying how to update', () => {
    const check = checkServerVersion({ name: 'ruby_language_server', version: '0.9.7' }, IMAGE);
    assert.match(check.log, /0\.9\.7 \(older than 0\.9\.8/);
    assert.match(check.warning || '', /version 0\.9\.7/);
    assert.match(check.warning || '', /docker pull kwerle\/ruby_language_server/);
    assert.match(check.warning || '', /Restart/);
  });

  it('only logs when the server reports no version, since older servers never do', () => {
    assert.deepStrictEqual(checkServerVersion(undefined, IMAGE), { log: "Server didn't report its name or version." });
    assert.deepStrictEqual(checkServerVersion({ name: 'other' }, IMAGE), { log: 'Server: other (no version reported)' });
  });

  it('uses the minimum it is given', () => {
    assert.ok(checkServerVersion({ name: 's', version: '1.0.0' }, IMAGE, '2.0.0').warning);
  });
});
