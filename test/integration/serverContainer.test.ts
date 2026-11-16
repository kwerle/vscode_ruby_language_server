// Integration tests: the real ServerContainer against real Docker and the real
// server image.  Run with `npm run test:integration` (needs Docker).  CI runs
// them on every PR and daily against the image's `latest` tag, so a server
// release that breaks the client shows up without a client change.
//
// RLS_TEST_IMAGE picks another image, e.g. a local build of the server.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { OutputChannel } from 'vscode';
import { StreamInfo } from 'vscode-languageclient';

import { ContainerStatus, LABEL_PID, LABEL_ROOT, MAX_CRASHES, rootHashOf, ServerContainer } from '../../src/serverContainer';
import { FakeOutputChannel } from '../support/vscode';
import { LspConnection, uriOf } from './lsp';

const IMAGE = process.env.RLS_TEST_IMAGE || 'kwerle/ruby_language_server';
// Resolve symlinks (macOS /tmp, CI workspaces) so paths match what Docker reports.
const FIXTURE = fs.realpathSync(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'project'));
const ROOT_HASH = rootHashOf(FIXTURE);
// A Docker socket that doesn't exist: how these tests take Docker "down".
const NO_DOCKER = 'unix:///nonexistent/docker.sock';

// Docker commands the tests run themselves, always against the real daemon.
function docker(args: string[]): string {
  const env = { ...process.env };
  delete env.DOCKER_HOST;
  return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixtureContainers(): string[] {
  return docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_ROOT}=${ROOT_HASH}`]).split('\n').filter(id => id);
}

function removeFixtureContainers() {
  const ids = fixtureContainers();
  if (ids.length) {
    docker(['rm', '-f', ...ids]);
  }
}

async function eventually(condition: () => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function makeContainer(image = IMAGE) {
  const output = new FakeOutputChannel('integration');
  const container = new ServerContainer(
    { image, logLevel: 'error', additionalGems: '', projectRoot: FIXTURE },
    output as unknown as OutputChannel,
  );
  const statuses: ContainerStatus[] = [];
  container.onDidChangeStatus(status => statuses.push(status));
  return { container, output, statuses };
}

// The server version inside the image.  Until the server reports serverInfo
// (ruby_language_server#168), read it from the image itself.
function imageServerVersion(image: string): string {
  return docker(['run', '--rm', '--network', 'none', '--entrypoint', 'ruby', image, '-e',
    'require "/app/lib/ruby_language_server/version"; print RubyLanguageServer::VERSION']);
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => text.split('.').map(part => parseInt(part, 10) || 0);
  const [have, need] = [parts(version), parts(minimum)];
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    if ((have[index] || 0) !== (need[index] || 0)) {
      return (have[index] || 0) > (need[index] || 0);
    }
  }
  return true;
}

function symbolNames(result: unknown): string[] {
  return (JSON.stringify(result).match(/"name":"[^"]*"/g) || []).map(pair => JSON.parse(pair.slice(7)));
}

describe('ServerContainer against real Docker', function () {
  this.timeout(180000);

  let current: ServerContainer | undefined;
  let serverVersion = '';

  before(() => {
    // Get the current image (in CI: today's `latest`) so tests don't time out on a
    // first pull.  A local-only build (RLS_TEST_IMAGE) can't be pulled; use it as is.
    try {
      docker(['pull', '-q', IMAGE]);
    } catch (error) {
      docker(['image', 'inspect', IMAGE]);
    }
    serverVersion = imageServerVersion(IMAGE);
    console.log(`    ${IMAGE}: server ${serverVersion}`);
  });

  beforeEach(removeFixtureContainers);

  afterEach(async () => {
    delete process.env.DOCKER_HOST;
    if (current) {
      current.dispose();
      current = undefined;
    }
    await eventually(() => fixtureContainers().length === 0);
  });

  it('starts the server and answers requests over stdio', async () => {
    const { container } = makeContainer();
    current = container;
    const lsp = new LspConnection(await container.start() as StreamInfo);

    const init = await lsp.initialize(FIXTURE);
    assert.ok(init.result, 'initialize returns a result');
    const file = path.join(FIXTURE, 'sample.rb');
    lsp.open(file, fs.readFileSync(file, 'utf8'));
    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uriOf(file) } });
    assert.deepStrictEqual(symbolNames(symbols.result), ['Greeter', 'hello']);
    assert.deepStrictEqual(lsp.unparseable, []);
  });

  it('runs the container locked down: no network, no capabilities, read-only project', async () => {
    const { container } = makeContainer();
    current = container;
    await container.start();

    const [id] = fixtureContainers();
    const info = JSON.parse(docker(['inspect', id]))[0];
    assert.strictEqual(info.HostConfig.NetworkMode, 'none');
    assert.deepStrictEqual(info.HostConfig.CapDrop, ['ALL']);
    assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges'));
    const project = info.Mounts.find((mount: { Destination: string }) => mount.Destination === '/project');
    assert.strictEqual(project.RW, false);
    assert.throws(() => docker(['exec', id, 'sh', '-c', 'touch /project/written-by-test']));
    assert.ok(!fs.existsSync(path.join(FIXTURE, 'written-by-test')));
  });

  it('replies to requests about non-ASCII code with correctly framed messages', async function () {
    if (!versionAtLeast(serverVersion, '0.9.8')) {
      // Fixed in server 0.9.8 (ruby_language_server#167). Runs automatically once the image has it.
      console.log(`      skipped: server ${serverVersion} predates the Content-Length fix in 0.9.8`);
      this.skip();
    }
    const { container } = makeContainer();
    current = container;
    const lsp = new LspConnection(await container.start() as StreamInfo);
    await lsp.initialize(FIXTURE);

    const file = path.join(FIXTURE, 'cafe.rb');
    lsp.open(file, fs.readFileSync(file, 'utf8'));
    let symbols;
    try {
      symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uriOf(file) } }, 15000);
    } catch (error) {
      // A server that counts Content-Length in characters instead of bytes
      // (ruby_language_server#167, fixed in 0.9.8) cuts these replies short.
      assert.fail(`No usable reply; ${lsp.unparseable.length} message(s) couldn't be parsed. ` +
        'The server probably counts Content-Length in characters, not bytes (ruby_language_server#167).');
    }
    assert.deepStrictEqual(lsp.unparseable, []);
    assert.deepStrictEqual(symbolNames(symbols.result), ['Café', 'naïve_método']);
  });

  it('waits while Docker is down, then starts once it is back', async () => {
    const { container, statuses } = makeContainer();
    current = container;
    process.env.DOCKER_HOST = NO_DOCKER;
    const starting = container.start();

    await eventually(() => statuses.includes('waiting-for-docker'));
    assert.deepStrictEqual(fixtureContainers(), []);
    delete process.env.DOCKER_HOST;

    const lsp = new LspConnection(await starting as StreamInfo);
    assert.ok((await lsp.initialize(FIXTURE)).result);
    assert.deepStrictEqual(statuses.slice(-1), ['starting']);
  });

  it('brings the server back after its container is killed', async () => {
    const { container } = makeContainer();
    current = container;
    const first = await container.start() as StreamInfo;
    const [firstId] = fixtureContainers();

    const closed = new Promise(resolve => first.reader.once('close', resolve));
    docker(['kill', firstId]);
    await closed;

    // The language client calls start() again when the connection closes.
    const lsp = new LspConnection(await container.start() as StreamInfo);
    assert.ok((await lsp.initialize(FIXTURE)).result);
    const ids = fixtureContainers();
    assert.strictEqual(ids.length, 1);
    assert.notStrictEqual(ids[0], firstId);
  });

  it('removes containers left by a dead window, and keeps another live window\'s', async () => {
    const label = (pid: number) => ['--label', `${LABEL_ROOT}=${ROOT_HASH}`, '--label', `${LABEL_PID}=${pid}`];
    const dead = docker(['create', ...label(999999), IMAGE]);
    // pid 1 always exists (and isn't ours), so it stands in for another open window.
    const live = docker(['create', ...label(1), IMAGE]);
    try {
      const { container } = makeContainer();
      current = container;
      await container.start();

      const ids = fixtureContainers();
      assert.ok(!ids.includes(dead), 'the dead window\'s container is removed');
      assert.ok(ids.includes(live), 'the live window\'s container is kept');
    } finally {
      docker(['rm', '-f', live]);
    }
  });

  it(`gives up after ${MAX_CRASHES} failed launches while Docker is up`, async () => {
    const { container, output } = makeContainer('ruby-language-server-test/does-not-exist:none');
    current = container;

    await assert.rejects(container.start(), new RegExp(`failed ${MAX_CRASHES} times`));
    assert.strictEqual(output.text.split('Server failed to start').length - 1, MAX_CRASHES);
  });
});
