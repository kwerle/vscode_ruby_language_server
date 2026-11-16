import * as assert from 'assert';

import {
  containerIsRunning, daemonIsUp, docker, DockerNotInstalledError, DockerRunner, ExecFile,
  refreshImage, removeContainer, waitForDaemon,
} from '../../src/docker';

// A runner that records its calls and answers from `reply`.
function recordingRunner(reply: (args: string[]) => Promise<string>) {
  const calls: string[][] = [];
  const run: DockerRunner = args => {
    calls.push(args);
    return reply(args);
  };
  return { run, calls };
}

const fails = (error: object) => () => Promise.reject(error);

describe('docker', () => {
  it('runs the docker CLI and returns stdout', async () => {
    const seen: { file: string, args: string[], timeout: number }[] = [];
    const exec: ExecFile = async (file, args, options) => {
      seen.push({ file, args, timeout: options.timeout });
      return { stdout: 'output\n' };
    };
    assert.strictEqual(await docker(['ps'], { timeout: 5 }, exec), 'output\n');
    assert.deepStrictEqual(seen, [{ file: 'docker', args: ['ps'], timeout: 5 }]);
  });

  it('reports a missing docker CLI as DockerNotInstalledError', async () => {
    const exec: ExecFile = () => Promise.reject({ code: 'ENOENT', message: 'spawn docker ENOENT' });
    await assert.rejects(docker(['ps'], {}, exec), DockerNotInstalledError);
  });

  it('passes other failures through', async () => {
    const failure = { code: 1, message: 'Cannot connect to the Docker daemon' };
    await assert.rejects(docker(['ps'], {}, () => Promise.reject(failure)), (error: unknown) => error === failure);
  });
});

describe('daemonIsUp', () => {
  it('is true when docker version answers', async () => {
    const { run, calls } = recordingRunner(async () => '27.0.1');
    assert.strictEqual(await daemonIsUp(run), true);
    assert.deepStrictEqual(calls[0], ['version', '--format', '{{.Server.Version}}']);
  });

  it('is false when the daemon is down', async () => {
    assert.strictEqual(await daemonIsUp(fails({ code: 1, message: 'Cannot connect' })), false);
  });

  it('throws when docker is not installed', async () => {
    await assert.rejects(daemonIsUp(fails(new DockerNotInstalledError())), DockerNotInstalledError);
  });
});

describe('waitForDaemon', () => {
  it('polls until the daemon answers', async () => {
    const answers = [false, false, true];
    let polls = 0;
    const isUp = async () => answers[polls++];
    assert.strictEqual(await waitForDaemon({ isUp, pollMs: 1 }), true);
    assert.strictEqual(polls, 3);
  });

  it('gives up after the timeout', async () => {
    const started = Date.now();
    assert.strictEqual(await waitForDaemon({ isUp: async () => false, pollMs: 5, timeoutMs: 30 }), false);
    assert.ok(Date.now() - started < 1000);
  });

  it('stops when cancelled', async () => {
    let polls = 0;
    let cancelled = false;
    const isUp = async () => {
      polls++;
      cancelled = polls === 2;
      return false;
    };
    assert.strictEqual(await waitForDaemon({ isUp, pollMs: 1, cancelled: () => cancelled }), false);
    assert.strictEqual(polls, 2);
  });
});

describe('refreshImage', () => {
  it('returns undefined when the pull succeeds', async () => {
    const { run, calls } = recordingRunner(async () => '');
    assert.strictEqual(await refreshImage('example/image', run), undefined);
    assert.deepStrictEqual(calls[0], ['pull', 'example/image']);
  });

  it('returns the last line of stderr when the pull fails', async () => {
    const stderr = 'Using default tag: latest\nError response from daemon: pull access denied\n';
    assert.strictEqual(await refreshImage('x', fails({ message: 'Command failed', stderr })),
      'Error response from daemon: pull access denied');
  });

  it('falls back to the error message without stderr', async () => {
    assert.strictEqual(await refreshImage('x', fails({ message: 'Docker executable not found' })),
      'Docker executable not found');
  });
});

describe('containerIsRunning', () => {
  it('reads the running state', async () => {
    assert.strictEqual(await containerIsRunning('c', async () => 'true\n'), true);
    assert.strictEqual(await containerIsRunning('c', async () => 'false\n'), false);
  });

  it('is false when the container does not exist (yet)', async () => {
    assert.strictEqual(await containerIsRunning('c', fails({ message: 'No such object: c' })), false);
  });
});

describe('removeContainer', () => {
  it('force-removes the container', async () => {
    const { run, calls } = recordingRunner(async () => '');
    await removeContainer('abc', run);
    assert.deepStrictEqual(calls[0], ['rm', '-f', 'abc']);
  });

  it('ignores failures', async () => {
    await removeContainer('gone', fails({ message: 'No such container: gone' }));
  });
});
