// End-to-end: the real extension in a real VS Code, against real Docker and the
// server image, on the fixture project (opened as the workspace by ../runTest.ts).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

import type { TestApi } from '../../../src/extension';
import { LABEL_ROOT, rootHashOf } from '../../../src/serverContainer';

const EXTENSION_ID = 'KurtWerle.ruby-language-server';

function fixture(): string {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders && folders.length === 1, 'the fixture project is open as the workspace');
  return folders[0].uri.fsPath;
}

function containerIds(root: string): string[] {
  return execFileSync('docker', ['ps', '-q', '--no-trunc', '--filter', `label=${LABEL_ROOT}=${rootHashOf(root)}`], { encoding: 'utf8' })
    .split('\n').filter(id => id);
}

async function eventually<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 120000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== undefined) {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Ask VS Code (and through it, the server) for a file's symbols until it has some:
// the server indexes the project in the background after it starts.
async function symbolNames(uri: vscode.Uri): Promise<string[]> {
  return eventually(`symbols for ${path.basename(uri.fsPath)}`, async () => {
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider', uri);
    const names: string[] = [];
    const walk = (items: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => items.forEach(item => {
      names.push(item.name);
      if ('children' in item) {
        walk(item.children);
      }
    });
    walk(symbols || []);
    return names.length > 0 ? names : undefined;
  });
}

describe('Ruby Language Server in VS Code', function () {
  this.timeout(240000);

  let api: TestApi;
  let sampleUri: vscode.Uri;

  before(async () => {
    sampleUri = vscode.Uri.file(path.join(fixture(), 'sample.rb'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sampleUri));
  });

  it('activates when a Ruby file opens', async () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is installed`);
    await eventually('activation', () => (extension.isActive ? true : undefined));
    api = extension.exports;
  });

  it('reaches Running in the status bar', async () => {
    await eventually('status Running', () => (api.statusText() === 'Ruby LSP: Running' ? true : undefined));
  });

  it('provides document symbols from the server', async () => {
    const names = await symbolNames(sampleUri);
    assert.ok(names.includes('Greeter') && names.includes('hello'), `got ${JSON.stringify(names)}`);
  });

  it('runs one locked-down container for the project', () => {
    const ids = containerIds(fixture());
    assert.strictEqual(ids.length, 1);
    const host = JSON.parse(execFileSync('docker', ['inspect', ids[0]], { encoding: 'utf8' }))[0].HostConfig;
    assert.strictEqual(host.NetworkMode, 'none');
  });

  it('replaces the container on "Ruby Language Server: Restart", and keeps working', async () => {
    const [before] = containerIds(fixture());
    const started = Date.now();
    const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const timings: string[] = [];
    const restart = vscode.commands.executeCommand('ruby-language-server.restart');

    await eventually('a new container', () => {
      const ids = containerIds(fixture());
      return ids.length === 1 && ids[0] !== before ? true : undefined;
    });
    timings.push(`new container ${elapsed()}`);
    await eventually('status Running after restart', () => (api.statusText() === 'Ruby LSP: Running' ? true : undefined));
    timings.push(`Running ${elapsed()}`);
    const names = await symbolNames(sampleUri);
    timings.push(`symbols ${elapsed()}`);
    await restart;
    timings.push(`command done ${elapsed()}`);
    console.log(`      restart: ${timings.join(', ')}`);
    assert.ok(names.includes('Greeter'), `got ${JSON.stringify(names)}`);
  });

  it('brings the server back after its container is killed', async () => {
    const [before] = containerIds(fixture());
    execFileSync('docker', ['kill', before]);

    await eventually('a replacement container', () => {
      const ids = containerIds(fixture());
      return ids.length === 1 && ids[0] !== before ? true : undefined;
    });
    await eventually('status Running after the crash', () => (api.statusText() === 'Ruby LSP: Running' ? true : undefined));
  });
});
