import * as assert from 'assert';
import { CloseAction, ErrorAction, LanguageClientOptions, State, StreamInfo } from 'vscode-languageclient/node';

import { ServerConfig } from '../../src/serverContainer';
import { Client, Container, errorHandler, ManagerDeps, ServerManager } from '../../src/serverManager';
import { ServerInfo } from '../../src/serverVersion';
import { StatusBar } from '../../src/statusBar';
import { EventEmitter, FakeOutputChannel, resetStub, window } from '../support/vscode';
import { OutputChannel } from 'vscode';

const turn = () => new Promise(resolve => setImmediate(resolve));

class FakeClient implements Client {
  state = State.Stopped;
  initializeResult: { serverInfo?: ServerInfo } | undefined;
  starts = 0;
  stops = 0;
  private readonly states = new EventEmitter<{ oldState: State, newState: State }>();
  readonly onDidChangeState = this.states.event;

  constructor(
    readonly clientOptions: LanguageClientOptions,
    private readonly behavior: { start: 'run' | 'fail' | 'hang', serverInfo?: ServerInfo },
  ) {}

  async start() {
    this.starts++;
    this.setState(State.Starting);
    if (this.behavior.start === 'hang') {
      return new Promise<void>(() => undefined);
    }
    if (this.behavior.start === 'fail') {
      this.setState(State.Stopped);
      throw new Error('start failed');
    }
    this.initializeResult = { serverInfo: this.behavior.serverInfo };
    this.setState(State.Running);
  }

  async stop() {
    this.stops++;
    // Like vscode-languageclient 9: only a running client can be stopped.
    if (this.state !== State.Running) {
      throw new Error(`Client is not running and can't be stopped. It's current state is: ${this.state}`);
    }
    this.setState(State.Stopped);
  }

  private setState(newState: State) {
    const oldState = this.state;
    this.state = newState;
    this.states.fire({ oldState, newState });
  }
}

class FakeContainer implements Container {
  disposed = false;
  private readonly statuses = new EventEmitter<'waiting-for-docker' | 'starting'>();
  readonly onDidChangeStatus = this.statuses.event;

  constructor(readonly config: ServerConfig) {}

  async start(): Promise<StreamInfo> {
    return {} as StreamInfo;
  }

  dispose() {
    this.disposed = true;
  }
}

function setup(options: { root?: string | undefined, dockerUp?: boolean } = {}) {
  const state = {
    dockerUp: options.dockerUp === undefined ? true : options.dockerUp,
    // What waitForDaemon does: come up, time out, or block until cancelled.
    wait: 'up' as 'up' | 'timeout' | 'block' | 'not-installed',
    // Outcomes for the next waitForDaemon calls, in order; then `wait`.
    waitQueue: [] as ('up' | 'timeout')[],
    waits: 0,
    pullProblem: undefined as string | undefined,
    pulls: 0,
    nextClient: { start: 'run' } as { start: 'run' | 'fail' | 'hang', serverInfo?: ServerInfo },
    clients: [] as FakeClient[],
    containers: [] as FakeContainer[],
  };
  const deps: Partial<ManagerDeps> = {
    projectRoot: () => ('root' in options ? options.root : '/projects/demo'),
    readConfig: root => ({ image: 'example/image', logLevel: 'error', additionalGems: '', projectRoot: root }),
    daemonIsUp: async () => {
      if (state.wait === 'not-installed') {
        const { DockerNotInstalledError } = await import('../../src/docker');
        throw new DockerNotInstalledError();
      }
      return state.dockerUp;
    },
    waitForDaemon: async ({ cancelled }) => {
      state.waits++;
      const outcome = state.waitQueue.shift() || state.wait;
      if (outcome === 'up') {
        state.dockerUp = true;
        return true;
      }
      if (outcome === 'timeout') {
        return false;
      }
      while (!(cancelled && cancelled())) {
        await turn();
      }
      return false;
    },
    refreshImage: async () => {
      state.pulls++;
      return state.pullProblem;
    },
    createContainer: config => {
      const container = new FakeContainer(config);
      state.containers.push(container);
      return container;
    },
    createClient: (_serverOptions, clientOptions) => {
      const client = new FakeClient(clientOptions, state.nextClient);
      state.clients.push(client);
      return client;
    },
  };
  const output = new FakeOutputChannel('Ruby Language Server');
  const statusBar = new StatusBar('ruby-language-server.restart');
  const manager = new ServerManager(output as unknown as OutputChannel, statusBar, deps);
  const statusText = () => window.statusBarItems[0].text;
  return { state, manager, output, statusText };
}

describe('ServerManager', () => {
  beforeEach(() => resetStub());

  it('starts a client for Ruby files, with the restart-friendly error handler', async () => {
    const { state, manager, statusText } = setup();
    await manager.start();

    assert.strictEqual(state.clients.length, 1);
    assert.strictEqual(state.clients[0].state, State.Running);
    assert.deepStrictEqual(state.clients[0].clientOptions.documentSelector, [{ scheme: 'file', language: 'ruby' }]);
    assert.strictEqual(state.clients[0].clientOptions.errorHandler, errorHandler);
    assert.strictEqual(state.containers[0].config.projectRoot, '/projects/demo');
    assert.strictEqual(statusText(), 'Ruby LSP: Running');
  });

  it('waits for Docker on first start, then starts', async () => {
    const { state, manager, output } = setup({ dockerUp: false });
    await manager.start();

    assert.strictEqual(state.waits, 1);
    assert.strictEqual(state.clients.length, 1);
    assert.match(output.text, /Docker is not reachable/);
  });

  it('offers Retry when Docker does not come up, and Retry starts again', async () => {
    const { state, manager, statusText } = setup({ dockerUp: false });
    // The first wait times out; by the time Retry is clicked, Docker is up.
    state.waitQueue = ['timeout', 'up'];
    window.answers.push('Retry');
    await manager.start();

    assert.match(window.messages[0].message, /Docker isn't running/);
    assert.deepStrictEqual(window.messages[0].items, ['Retry', 'Show Output']);

    // Retry runs in the background.
    for (let i = 0; i < 5 && state.clients.length === 0; i++) {
      await turn();
    }
    assert.strictEqual(state.waits, 2);
    assert.strictEqual(state.clients.length, 1);
    assert.strictEqual(statusText(), 'Ruby LSP: Running');
  });

  it('says so when Docker is not installed, and starts nothing', async () => {
    const { state, manager, statusText } = setup();
    state.wait = 'not-installed';
    await manager.start();

    assert.strictEqual(state.clients.length, 0);
    assert.match(window.messages[0].message, /Docker executable not found/);
    assert.strictEqual(statusText(), 'Ruby LSP: Stopped');
  });

  it('needs a folder or a Ruby file', async () => {
    const { state, manager, statusText } = setup({ root: undefined });
    await manager.start();

    assert.strictEqual(state.clients.length, 0);
    assert.match(window.messages[0].message, /needs an open folder or Ruby file/);
    assert.strictEqual(statusText(), 'Ruby LSP: Stopped');
  });

  it('restarts a running server by stopping it and starting a new client and container', async () => {
    const { state, manager } = setup();
    await manager.start();
    await manager.start();

    assert.strictEqual(state.clients.length, 2);
    assert.strictEqual(state.clients[0].stops, 1);
    assert.strictEqual(state.containers[0].disposed, true);
    assert.strictEqual(state.clients[1].state, State.Running);
  });

  it('restarts a server that is still starting without calling stop(), which would throw', async () => {
    const { state, manager } = setup();
    state.nextClient = { start: 'hang' };
    manager.start();
    await turn();
    state.nextClient = { start: 'run' };
    await manager.start();

    assert.strictEqual(state.clients[0].stops, 0);
    assert.strictEqual(state.containers[0].disposed, true);
    assert.strictEqual(state.clients[1].state, State.Running);
  });

  it('restarts after a failed start, with a new client', async () => {
    const { state, manager, statusText } = setup();
    state.nextClient = { start: 'fail' };
    await manager.start();
    assert.strictEqual(statusText(), 'Ruby LSP: Stopped');

    state.nextClient = { start: 'run' };
    await manager.start();
    assert.strictEqual(state.clients.length, 2);
    assert.strictEqual(state.clients[1].state, State.Running);
  });

  it('lets a restart supersede a start that is still waiting for Docker', async () => {
    const { state, manager } = setup({ dockerUp: false });
    state.wait = 'block';
    const first = manager.start();
    await turn();

    state.dockerUp = true;
    await manager.start();
    await first;
    assert.strictEqual(state.clients.length, 1, 'only the newer start creates a client');
    assert.strictEqual(window.messages.length, 0, 'the superseded wait shows no error');
  });

  it('stops the running server', async () => {
    const { state, manager } = setup();
    await manager.start();
    await manager.stop();

    assert.strictEqual(state.clients[0].stops, 1);
    assert.strictEqual(state.containers[0].disposed, true);
  });

  it('logs the server version, and warns about an old server once per session', async () => {
    const { state, manager, output } = setup();
    state.nextClient = { start: 'run', serverInfo: { name: 'ruby_language_server', version: '0.9.1' } };
    await manager.start();
    await manager.start();

    assert.match(output.text, /Server: ruby_language_server 0\.9\.1/);
    const warnings = window.messages.filter(message => message.level === 'warning');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].message, /needs 0\.9\.8 or later/);
  });

  it('pulls the image once per session, and warns once if that fails', async () => {
    const { state, manager, output } = setup();
    state.pullProblem = 'pull access denied';
    await manager.start();
    await manager.start();
    await turn();

    assert.strictEqual(state.pulls, 1);
    assert.match(output.text, /Couldn't update example\/image: pull access denied/);
    assert.strictEqual(window.messages.filter(message => /Couldn't update/.test(message.message)).length, 1);
  });
});

describe('errorHandler', () => {
  it('always restarts after a close, without a notification', async () => {
    assert.deepStrictEqual(await errorHandler.closed(), { action: CloseAction.Restart, handled: true });
  });

  it('continues through a few connection errors, then shuts down', async () => {
    const error = new Error('broken pipe');
    assert.deepStrictEqual(await errorHandler.error(error, undefined, 3), { action: ErrorAction.Continue });
    assert.deepStrictEqual(await errorHandler.error(error, undefined, 4), { action: ErrorAction.Shutdown });
    assert.deepStrictEqual(await errorHandler.error(error, undefined, undefined), { action: ErrorAction.Shutdown });
  });
});
