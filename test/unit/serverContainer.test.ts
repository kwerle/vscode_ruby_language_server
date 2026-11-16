import * as assert from 'assert';
import { ChildProcess, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { OutputChannel } from 'vscode';
import { StreamInfo } from 'vscode-languageclient/node';

import {
  containerName, ContainerDeps, ContainerStatus, CrashBudget, CRASH_WINDOW_MS, dockerArgs, LABEL_PID, LABEL_ROOT,
  MAX_CRASHES, MEMORY_LIMIT, mountSpec, PIDS_LIMIT, processIsAlive, rootHashOf, ServerConfig, ServerContainer,
  staleContainerIds,
} from '../../src/serverContainer';
import { FakeOutputChannel, resetStub } from '../support/vscode';

const config: ServerConfig = {
  image: 'example/image',
  logLevel: 'error',
  additionalGems: '',
  projectRoot: '/projects/demo',
};
const PID = 4242;

describe('dockerArgs', () => {
  const args = dockerArgs(config, 'the-name', 'abc123', PID);

  it('talks over stdin/stdout: -i, never -t', () => {
    assert.ok(args.includes('-i'));
    assert.ok(!args.includes('-t') && !args.includes('-it'));
  });

  it('names, labels and locks down the container, mounts the project read-only and runs the image last', () => {
    assert.deepStrictEqual(args, [
      'run', '--rm', '-i',
      '--name', 'the-name',
      '--label', `${LABEL_ROOT}=abc123`,
      '--label', `${LABEL_PID}=${PID}`,
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', PIDS_LIMIT,
      '--memory', MEMORY_LIMIT,
      '-e', 'LOG_LEVEL=error',
      '--mount', 'type=bind,source=/projects/demo,target=/project,readonly',
      '-w', '/project',
      'example/image',
    ]);
  });

  it('never uses -v, whose colon-separated spec a path can change', () => {
    assert.ok(!args.includes('-v') && !args.includes('--volume'));
  });

  it('passes additional gems only when set', () => {
    const withGems = dockerArgs({ ...config, additionalGems: 'a,b' }, 'n', 'h', PID);
    assert.deepStrictEqual(withGems.slice(-3), ['-e', 'ADDITIONAL_GEMS=a,b', 'example/image']);
  });
});

describe('mountSpec', () => {
  it('mounts the project read-only at /project', () => {
    assert.strictEqual(mountSpec('/projects/demo'), 'type=bind,source=/projects/demo,target=/project,readonly');
  });

  it('leaves colons and spaces alone', () => {
    assert.strictEqual(mountSpec('/p/a:b c'), 'type=bind,source=/p/a:b c,target=/project,readonly');
  });

  it('quotes a path containing a comma, so it cannot add mount options', () => {
    assert.strictEqual(mountSpec('/p/x,readonly=false'), 'type=bind,"source=/p/x,readonly=false",target=/project,readonly');
  });

  it('doubles quotes inside a quoted path', () => {
    assert.strictEqual(mountSpec('/p/a"b,c'), 'type=bind,"source=/p/a""b,c",target=/project,readonly');
  });
});

describe('container naming', () => {
  it('hashes the project root to 12 stable hex characters', () => {
    assert.match(rootHashOf('/projects/demo'), /^[0-9a-f]{12}$/);
    assert.strictEqual(rootHashOf('/projects/demo'), rootHashOf('/projects/demo'));
    assert.notStrictEqual(rootHashOf('/projects/demo'), rootHashOf('/projects/other'));
  });

  it('names containers by root hash and pid', () => {
    assert.strictEqual(containerName('abc123', PID), 'ruby-language-server-abc123-4242');
  });
});

describe('staleContainerIds', () => {
  const alive = new Set([PID, 777]);
  const isAlive = (pid: number) => alive.has(pid);

  it('picks this window\'s containers and dead windows\' containers, and keeps live windows\'', () => {
    const listing = `mine ${PID}\ndead 999\nlive 777\n`;
    assert.deepStrictEqual(staleContainerIds(listing, PID, isAlive), ['mine', 'dead']);
  });

  it('treats a missing or unreadable pid label as stale', () => {
    assert.deepStrictEqual(staleContainerIds('nolabel \ngarbled abc\n', PID, isAlive), ['nolabel', 'garbled']);
  });

  it('ignores blank lines', () => {
    assert.deepStrictEqual(staleContainerIds('\n  \n', PID, isAlive), []);
  });
});

describe('CrashBudget', () => {
  it(`is used up on the ${MAX_CRASHES}th crash inside the window`, () => {
    let now = 0;
    const budget = new CrashBudget(MAX_CRASHES, CRASH_WINDOW_MS, () => now);
    for (let crash = 1; crash < MAX_CRASHES; crash++) {
      assert.strictEqual(budget.record(), false, `crash ${crash}`);
      now += 1000;
    }
    assert.strictEqual(budget.record(), true);
  });

  it('forgets crashes older than the window', () => {
    let now = 0;
    const budget = new CrashBudget(MAX_CRASHES, CRASH_WINDOW_MS, () => now);
    for (let crash = 1; crash < MAX_CRASHES; crash++) {
      budget.record();
    }
    now = CRASH_WINDOW_MS + 1;
    assert.strictEqual(budget.record(), false);
    assert.strictEqual(budget.count, 1);
  });
});

describe('processIsAlive', () => {
  it('is true for this process', () => {
    assert.strictEqual(processIsAlive(process.pid), true);
  });

  it('is false for a process that has exited, or no pid at all', () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    assert.strictEqual(processIsAlive(exited), false);
    assert.strictEqual(processIsAlive(NaN), false);
  });
});

// ---------------------------------------------------------------- ServerContainer with a fake Docker

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;

  kill() {
    this.killed = true;
    this.exit(null, 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: string | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

type Launch = 'run' | 'fail';

// A scripted Docker.  Tests set `up`, queue what each `docker run` does, and
// read back what was spawned and removed.
function fakeDocker() {
  const state = {
    up: true,
    // When Docker is down, it comes back after this many polls (Infinity: never).
    downForWaits: 1,
    // Polls since Docker last went down.
    waits: 0,
    // Whether a failing `docker run` also takes the daemon down (as when Docker quits).
    failureTakesDockerDown: false,
    launches: [] as Launch[],
    defaultLaunch: 'run' as Launch,
    spawned: [] as { args: string[], child: FakeChild, launch: Launch }[],
    removed: [] as string[],
    psListing: '',
    alive: new Set<number>([PID]),
    now: 1000000,
  };

  const latest = () => state.spawned[state.spawned.length - 1];
  const deps: Partial<ContainerDeps> = {
    docker: async () => state.psListing,
    daemonIsUp: async () => state.up,
    waitForDaemon: async ({ cancelled }) => {
      // Poll (yielding to the event loop) until Docker comes back or the wait is cancelled.
      while (!cancelled()) {
        state.waits++;
        if (state.waits >= state.downForWaits) {
          state.up = true;
          return true;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return false;
    },
    containerIsRunning: async () => {
      const last = latest();
      return !!last && last.launch === 'run' && last.child.exitCode === null && last.child.signalCode === null;
    },
    removeContainer: async nameOrId => {
      state.removed.push(nameOrId);
    },
    spawn: (_command, args) => {
      const child = new FakeChild();
      const launch = state.launches.shift() || state.defaultLaunch;
      state.spawned.push({ args, child, launch });
      if (launch === 'fail') {
        // `docker run` exits at once, e.g. "Unable to find image".
        child.stderr.write('Unable to find image\n');
        child.exit(125);
        if (state.failureTakesDockerDown) {
          state.up = false;
          state.waits = 0;
        }
      }
      return child as unknown as ChildProcess;
    },
    // Yield to the event loop instead of sleeping, so retry loops run fast but don't starve it.
    delay: () => new Promise(resolve => setImmediate(resolve)),
    isAlive: pid => state.alive.has(pid),
    now: () => state.now,
    pid: PID,
  };
  return { state, deps, latest };
}

function makeContainer(deps: Partial<ContainerDeps>) {
  const output = new FakeOutputChannel('test');
  const container = new ServerContainer(config, output as unknown as OutputChannel, deps);
  const statuses: ContainerStatus[] = [];
  container.onDidChangeStatus(status => statuses.push(status));
  return { container, output, statuses };
}

// Resolves 'pending' if the promise hasn't settled after a few turns of the event loop.
async function settledState(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending';
  promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  for (let turn = 0; turn < 20; turn++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  return state;
}

describe('ServerContainer', () => {
  beforeEach(() => resetStub());

  it('hands over the container\'s stdin and stdout once it is running', async () => {
    const { deps, latest } = fakeDocker();
    const { container, statuses } = makeContainer(deps);

    const stream = await container.start() as StreamInfo;
    assert.strictEqual(stream.reader, latest().child.stdout);
    assert.strictEqual(stream.writer, latest().child.stdin);
    assert.deepStrictEqual(statuses, ['starting']);
    assert.ok(latest().args.includes(containerName(rootHashOf(config.projectRoot), PID)));
  });

  it('waits for Docker, without counting it as a crash', async () => {
    const { state, deps } = fakeDocker();
    state.up = false;
    state.downForWaits = 3;
    const { container, statuses } = makeContainer(deps);

    await container.start();
    assert.deepStrictEqual(statuses, ['waiting-for-docker', 'starting']);
    assert.strictEqual(state.spawned.length, 1);
  });

  it(`gives up after ${MAX_CRASHES} failed launches while Docker is up`, async () => {
    const { state, deps } = fakeDocker();
    state.defaultLaunch = 'fail';
    const { container } = makeContainer(deps);

    await assert.rejects(container.start(), new RegExp(`failed ${MAX_CRASHES} times`));
    assert.strictEqual(state.spawned.length, MAX_CRASHES);
  });

  it('does not count launches that fail because Docker went away', async () => {
    const { state, deps } = fakeDocker();
    state.failureTakesDockerDown = true;
    state.launches = Array(MAX_CRASHES * 2).fill('fail');
    const { container } = makeContainer(deps);

    await container.start();
    assert.strictEqual(state.spawned.length, MAX_CRASHES * 2 + 1);
  });

  it('counts a restart while Docker is up as a crash, and replaces the container', async () => {
    const { state, deps } = fakeDocker();
    const { container } = makeContainer(deps);

    await container.start();
    for (let restart = 1; restart < MAX_CRASHES; restart++) {
      const previous = state.spawned[state.spawned.length - 1].child;
      await container.start();
      assert.strictEqual(previous.killed, true, `restart ${restart} kills the previous container`);
    }
    await assert.rejects(container.start(), /stopped unexpectedly/);
  });

  it('does not count restarts after Docker went away', async () => {
    const { state, deps } = fakeDocker();
    const { container } = makeContainer(deps);

    await container.start();
    for (let restart = 0; restart < MAX_CRASHES * 2; restart++) {
      state.up = false;
      state.waits = 0;
      await container.start();
    }
    assert.strictEqual(state.spawned.length, MAX_CRASHES * 2 + 1);
  });

  it('forgets crashes older than three minutes', async () => {
    const { state, deps } = fakeDocker();
    const { container } = makeContainer(deps);

    await container.start();
    for (let restart = 0; restart < MAX_CRASHES * 2; restart++) {
      state.now += CRASH_WINDOW_MS / 2;
      await container.start();
    }
  });

  it('removes stale containers before launching', async () => {
    const { state, deps } = fakeDocker();
    state.psListing = `mine ${PID}\ndead 999\nlive 777\n`;
    state.alive.add(777);
    const { container } = makeContainer(deps);

    await container.start();
    assert.deepStrictEqual(state.removed, ['mine', 'dead']);
  });

  it('never settles, and launches nothing, when disposed while waiting for Docker', async () => {
    const { state, deps } = fakeDocker();
    state.up = false;
    state.downForWaits = Infinity;
    const { container } = makeContainer(deps);

    const starting = container.start();
    await settledState(Promise.resolve());
    container.dispose();
    assert.strictEqual(await settledState(starting), 'pending');
    assert.strictEqual(state.spawned.length, 0);
  });

  it('kills and removes the container when disposed', async () => {
    const { state, deps, latest } = fakeDocker();
    const { container } = makeContainer(deps);

    await container.start();
    container.dispose();
    assert.strictEqual(latest().child.killed, true);
    assert.deepStrictEqual(state.removed, [containerName(rootHashOf(config.projectRoot), PID)]);
  });

  it('keeps the server\'s stderr in the output channel', async () => {
    const { deps, latest } = fakeDocker();
    const { container, output } = makeContainer(deps);

    await container.start();
    latest().child.stderr.write('server says hello\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(output.text, /server says hello/);
  });
});
