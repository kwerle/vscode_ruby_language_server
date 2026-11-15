'use strict';

import { promisify } from 'util';
import * as childProcess from 'child_process';

const execFile = promisify(childProcess.execFile);

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

export function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

// Run a docker command and return its stdout.
export async function docker(args: string[], options: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFile("docker", args, { timeout: options.timeout || 0 });
    return stdout;
  } catch (caught) {
    if ((caught as ExecError).code === 'ENOENT') {
      throw new DockerNotInstalledError();
    }
    throw caught;
  }
}

// True if the daemon answers.  Throws DockerNotInstalledError if there's no docker CLI.
export async function daemonIsUp(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeout: DAEMON_CHECK_TIMEOUT_MS });
    return true;
  } catch (caught) {
    if (caught instanceof DockerNotInstalledError) {
      throw caught;
    }
    return false;
  }
}

// Poll until the daemon answers.  Without timeoutMs it waits indefinitely.
// Resolves false on timeout or when cancelled() returns true.
export async function waitForDaemon(options: { timeoutMs?: number, cancelled?: () => boolean } = {}): Promise<boolean> {
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  const cancelled = options.cancelled || (() => false);
  while (!cancelled()) {
    if (await daemonIsUp()) {
      return true;
    }
    if (Date.now() + DAEMON_POLL_MS > deadline) {
      return false;
    }
    await delay(DAEMON_POLL_MS);
  }
  return false;
}

// Pull the image once.  Returns undefined on success, or the last line of the
// error on failure, so the caller can report it and carry on with a local copy.
export async function refreshImage(image: string): Promise<string | undefined> {
  try {
    await docker(["pull", image]);
    return undefined;
  } catch (caught) {
    const err = caught as ExecError;
    const lines = (err.stderr || err.message || 'unknown error').trim().split('\n');
    return lines[lines.length - 1];
  }
}

export async function removeContainer(nameOrId: string) {
  try {
    await docker(["rm", "-f", nameOrId]);
  } catch (error) {
    // Already gone, or docker isn't reachable - nothing to clean up either way.
  }
}
