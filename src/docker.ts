import { promisify } from 'util';
import * as childProcess from 'child_process';

// How often to ask whether the Docker daemon is up.
const DAEMON_POLL_MS = 2000;
// A daemon that's up answers `docker version` in well under this.
const DAEMON_CHECK_TIMEOUT_MS = 10 * 1000;

// execFile rejects with the exit status (number) or a spawn error code like ENOENT (string).
interface ExecError {
  code?: number | string;
  message: string;
  stderr?: string;
}

export class DockerNotInstalledError extends Error {
  constructor() {
    super('Docker executable not found');
  }
}

// Runs `docker <args>` and resolves with its stdout.  The helpers below take
// one as their last parameter, defaulting to the real CLI, so tests can pass a fake.
export type DockerRunner = (args: string[], options?: { timeout?: number }) => Promise<string>;

export type ExecFile = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

const execFileAsync = promisify(childProcess.execFile);
const realExecFile: ExecFile = (file, args, options) => execFileAsync(file, args, options);

export function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

// The real DockerRunner.  Throws DockerNotInstalledError if there's no docker CLI.
export async function docker(args: string[], options: { timeout?: number } = {}, exec: ExecFile = realExecFile): Promise<string> {
  try {
    const { stdout } = await exec('docker', args, { timeout: options.timeout || 0 });
    return stdout;
  } catch (caught) {
    if ((caught as ExecError).code === 'ENOENT') {
      throw new DockerNotInstalledError();
    }
    throw caught;
  }
}

// True if the daemon answers.  Throws DockerNotInstalledError if there's no docker CLI.
export async function daemonIsUp(run: DockerRunner = docker): Promise<boolean> {
  try {
    await run(['version', '--format', '{{.Server.Version}}'], { timeout: DAEMON_CHECK_TIMEOUT_MS });
    return true;
  } catch (caught) {
    if (caught instanceof DockerNotInstalledError) {
      throw caught;
    }
    return false;
  }
}

export interface WaitForDaemonOptions {
  // Give up after this long.  Without it, wait indefinitely.
  timeoutMs?: number;
  // Checked before each poll; resolve false as soon as it returns true.
  cancelled?: () => boolean;
  pollMs?: number;
  isUp?: () => Promise<boolean>;
}

// Poll until the daemon answers.  Resolves false on timeout or when cancelled.
export async function waitForDaemon(options: WaitForDaemonOptions = {}): Promise<boolean> {
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  const cancelled = options.cancelled || (() => false);
  const pollMs = options.pollMs === undefined ? DAEMON_POLL_MS : options.pollMs;
  const isUp = options.isUp || (() => daemonIsUp());
  while (!cancelled()) {
    if (await isUp()) {
      return true;
    }
    if (Date.now() + pollMs > deadline) {
      return false;
    }
    await delay(pollMs);
  }
  return false;
}

// Pull the image once.  Returns undefined on success, or the last line of the
// error on failure, so the caller can report it and carry on with a local copy.
export async function refreshImage(image: string, run: DockerRunner = docker): Promise<string | undefined> {
  try {
    await run(['pull', image]);
    return undefined;
  } catch (caught) {
    const err = caught as ExecError;
    const lines = (err.stderr || err.message || 'unknown error').trim().split('\n');
    return lines[lines.length - 1];
  }
}

// True once Docker reports the container's process running.  False while it
// doesn't exist yet (e.g. `docker run` is still pulling) or has stopped.
export async function containerIsRunning(nameOrId: string, run: DockerRunner = docker): Promise<boolean> {
  try {
    const state = await run(['inspect', '--format', '{{.State.Running}}', nameOrId]);
    return state.trim() === 'true';
  } catch (error) {
    return false;
  }
}

export async function removeContainer(nameOrId: string, run: DockerRunner = docker) {
  try {
    await run(['rm', '-f', nameOrId]);
  } catch (error) {
    // Already gone, or docker isn't reachable - nothing to clean up either way.
  }
}
