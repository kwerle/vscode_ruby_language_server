// Security properties of package.json that should only change on purpose.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

describe('package.json', () => {
  it('supports untrusted workspaces, with a reason, and not virtual ones', () => {
    const { untrustedWorkspaces, virtualWorkspaces } = manifest.capabilities;
    assert.strictEqual(untrustedWorkspaces.supported, true);
    assert.ok(untrustedWorkspaces.description.length > 0);
    assert.strictEqual(virtualWorkspaces.supported, false);
  });

  // Supporting untrusted workspaces relies on this: a workspace's own settings
  // must not be able to choose the image or how it runs.
  it('only accepts its settings from user (or machine) settings, never from a workspace', () => {
    const properties = manifest.contributes.configuration.properties;
    for (const [name, setting] of Object.entries<{ scope?: string }>(properties)) {
      assert.ok(['application', 'machine', 'user'].includes(setting.scope || 'window'), `${name} has scope "${setting.scope || 'window (the default)'}"`);
    }
  });
});
