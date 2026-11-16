'use strict';

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { StreamInfo } from 'vscode-languageclient';

import { containerIsRunning, daemonIsUp, delay, docker, DockerRunner, removeContainer, waitForDaemon } from './docker';

// How often to ask Docker whether a just-launched container is running.
const RUNNING_POLL_MS = 250;
// Upper bound on `docker run` getting the container running.  Generous because
// on a first install `docker run` pulls the image before starting it.
const START_TIMEOUT_MS = 10 * 60 * 1000;
// Give up after this many crashes (while the Docker daemon is up) within the window.
// Matches vscode-languageclient's default restart policy.
export const MAX_CRASHES = 5;
export const CRASH_WINDOW_MS = 3 * 60 * 1000;
// Pause between attempts after a crash.
const CRASH_BACKOFF_MS = 1000;

export const LABEL_ROOT = 'ruby-language-server.root';
export const LABEL_PID = 'ruby-language-server.pid';

export interface ServerConfig {
  image: string;
  logLevel: string;
  additionalGems: string;
  projectRoot: string;
}

export type ContainerStatus = 'waiting-for-docker' | 'starting';

// Everything ServerContainer needs from Docker, the OS and the clock.  The
// defaults are the real thing; tests pass fakes.
export interface ContainerDeps {
  docker: DockerRunner;
  daemonIsUp: () => Promise<boolean>;
  waitForDaemon: (options: { cancelled: () => boolean }) => Promise<boolean>;
  containerIsRunning: (name: string) => Promise<boolean>;
  removeContainer: (nameOrId: string) => Promise<void>;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  delay: (ms: number) => Promise<unknown>;
  isAlive: (pid: number) => boolean;
  now: () => number;
  // The extension host's process ID, used to name and label containers.
  pid: number;
}

const realDeps: ContainerDeps = {
  docker,
  daemonIsUp: () => daemonIsUp(),
  waitForDaemon: options => waitForDaemon(options),
  containerIsRunning: name => containerIsRunning(name),
  removeContainer: nameOrId => removeContainer(nameOrId),
  spawn: (command, args, options) => spawn(command, args, options),
  delay,
  isAlive: pid => processIsAlive(pid),
  now: () => Date.now(),
  pid: process.pid,
};

// Short, stable identifier for a project root, used in container names and labels.
export function rootHashOf(projectRoot: string): string {
  return crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
}

export function containerName(rootHash: string, pid: number): string {
  return `ruby-language-server-${rootHash}-${pid}`;
}

// Limits for the server container: generous enough for a large project's index,
// but bounded, so a misbehaving image can't take the machine down.
export const MEMORY_LIMIT = '2g';
export const PIDS_LIMIT = '256';

// `--mount` reads its value as CSV, so a path containing a comma or a quote
// would change the spec.  Quote the field when needed, CSV style.
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// The project, mounted read-only: the server parses it and never writes to it.
export function mountSpec(projectRoot: string): string {
  return ['type=bind', csvField(`source=${projectRoot}`), 'target=/project', 'readonly'].join(',');
}

export function dockerArgs(config: ServerConfig, name: string, rootHash: string, pid: number): string[] {
  const { image, logLevel, additionalGems, projectRoot } = config;
  // -i without -t: a TTY would rewrite line endings and corrupt the LSP stream.
  const args = [
    "run", "--rm", "-i",
    "--name", name,
    "--label", `${LABEL_ROOT}=${rootHash}`,
    "--label", `${LABEL_PID}=${pid}`,
    // Least privilege.  The server only parses code: it needs no network (the
    // protocol is on stdin/stdout), no Linux capabilities and no privilege changes.
    // Since the extension follows the image's `latest` tag, they also bound what a bad image could do.
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", PIDS_LIMIT,
    "--memory", MEMORY_LIMIT,
    "-e", `LOG_LEVEL=${logLevel}`,
    "--mount", mountSpec(projectRoot),
    "-w", "/project",
  ];
  if (additionalGems) {
    args.push("-e", `ADDITIONAL_GEMS=${additionalGems}`);
  }
  args.push(image);
  return args;
}

// From `docker ps` lines of "<id> <pid label>", the containers to remove before
// a start: ones left by this process (an earlier start) or by a process that's
// gone (a window that crashed).  Other live windows' containers are kept.
export function staleContainerIds(listing: string, myPid: number, isAlive: (pid: number) => boolean): string[] {
  const stale: string[] = [];
  for (const line of listing.split('\n')) {
    const [id, pidText] = line.trim().split(' ');
    if (!id) {
      continue;
    }
    const pid = parseInt(pidText, 10);
    if (pid === myPid || !isAlive(pid)) {
      stale.push(id);
    }
  }
  return stale;
}

// Counts crashes within a sliding window.
export class CrashBudget {
  private times: number[] = [];

  constructor(
    private readonly max: number = MAX_CRASHES,
    private readonly windowMs: number = CRASH_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Record a crash.  True once `max` crashes fall within the window.
  record(): boolean {
    const time = this.now();
    this.times = this.times.filter(earlier => time - earlier < this.windowMs);
    this.times.push(time);
    return this.times.length >= this.max;
  }

  get count(): number {
    return this.times.length;
  }
}

// Runs the language server in a docker container and talks LSP to it over the
// container's stdin/stdout (`docker run -i`).  The server logs to stderr, which
// goes to the output channel.
//
// The client calls start() on first start and again after every connection
// close.  vscode-languageclient 6's error handler is synchronous and a client
// whose start() rejected can never start again, so all waiting and retrying
// happens here: start() waits for the Docker daemon for as long as it takes,
// retries failed launches, and rejects only once the server has crashed
// MAX_CRASHES times within CRASH_WINDOW_MS while the daemon was up.
export class ServerContainer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private name: string | undefined;
  private stderrTail = '';
  private started = false;
  private disposed = false;
  private readonly deps: ContainerDeps;
  private readonly crashes: CrashBudget;
  private readonly rootHash: string;
  private readonly statusEmitter = new vscode.EventEmitter<ContainerStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(private config: ServerConfig, private output: vscode.OutputChannel, deps: Partial<ContainerDeps> = {}) {
    this.deps = { ...realDeps, ...deps };
    this.crashes = new CrashBudget(MAX_CRASHES, CRASH_WINDOW_MS, this.deps.now);
    this.rootHash = rootHashOf(config.projectRoot);
  }

  async start(): Promise<StreamInfo> {
    this.stopContainer();

    if (this.started && await this.daemonIsUpSafely()) {
      // The previous server's connection closed while Docker was running.
      this.recordCrash('The server stopped unexpectedly.');
      await this.deps.delay(CRASH_BACKOFF_MS);
    }
    this.started = true;

    while (!this.disposed) {
      if (!await this.daemonIsUpSafely()) {
        this.statusEmitter.fire('waiting-for-docker');
        this.output.appendLine('Docker is not reachable. Waiting for it to start.');
        await this.deps.waitForDaemon({ cancelled: () => this.disposed });
        continue;
      }

      this.statusEmitter.fire('starting');
      try {
        return await this.launch();
      } catch (caught) {
        this.stopContainer();
        if (this.disposed) {
          break;
        }
        this.output.appendLine(`Server failed to start: ${(caught as Error).message}`);
        if (await this.daemonIsUpSafely()) {
          this.recordCrash('The server failed to start.');
          await this.deps.delay(CRASH_BACKOFF_MS);
        }
      }
    }

    // Disposed mid-start (a restart or shutdown is replacing this server).
    // Never settle: rejecting would make the old client show a spurious
    // "Couldn't start client" error, and the old client is discarded anyway.
    return new Promise<StreamInfo>(() => undefined);
  }

  dispose() {
    this.disposed = true;
    this.stopContainer();
    this.statusEmitter.dispose();
  }

  private async daemonIsUpSafely(): Promise<boolean> {
    try {
      return await this.deps.daemonIsUp();
    } catch (error) {
      return false; // docker CLI missing - extension.ts reports that before we get here
    }
  }

  // Throws once the crash budget is used up.
  private recordCrash(reason: string) {
    if (this.crashes.record()) {
      throw new Error(
        `${reason} It has failed ${this.crashes.count} times in the last ${CRASH_WINDOW_MS / 60000} minutes ` +
        `and will not be restarted. Use "Ruby Language Server: Restart" to try again.\n${this.stderrTail}`
      );
    }
  }

  private async launch(): Promise<StreamInfo> {
    await this.removeStaleContainers();
    const name = containerName(this.rootHash, this.deps.pid);
    const child = this.spawnContainer(name);
    this.name = name;
    this.child = child;

    await this.waitUntilRunning(name, child);
    this.output.appendLine(`Container ${name} is running`);
    return { reader: child.stdout!, writer: child.stdin! };
  }

  private stopContainer() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = undefined;
    if (this.name) {
      // Belt and braces: the docker CLI doesn't always forward the signal.
      this.deps.removeContainer(this.name).catch(() => undefined);
      this.name = undefined;
    }
  }

  private async removeStaleContainers() {
    const listing = await this.deps.docker([
      "ps", "-a",
      "--filter", `label=${LABEL_ROOT}=${this.rootHash}`,
      "--format", `{{.ID}} {{.Label "${LABEL_PID}"}}`,
    ]);
    for (const id of staleContainerIds(listing, this.deps.pid, this.deps.isAlive)) {
      this.output.appendLine(`Removing stale container ${id}`);
      await this.deps.removeContainer(id);
    }
  }

  private spawnContainer(name: string): ChildProcess {
    this.output.appendLine(`Starting container ${name}`);
    this.stderrTail = '';
    // stdin/stdout carry the protocol and belong to the language client; only stderr is ours.
    const args = dockerArgs(this.config, name, this.rootHash, this.deps.pid);
    const child = this.deps.spawn("docker", args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      this.output.append(text);
    });
    child.on('error', (err: Error) => this.output.appendLine(`Failed to run docker: ${err.message}`));
    child.on('exit', (code, signal) => this.output.appendLine(`Container ${name} exited (${signal || code})`));
    return child;
  }

  // The client sends `initialize` as soon as start() resolves.  If the server
  // dies during initialize, vscode-languageclient 6 gives up instead of
  // restarting, so hand over the streams only once Docker reports the container
  // running.  Failures before that (daemon down, image can't be pulled) are
  // retried by start().  Until then `docker run` may still be pulling the image.
  private async waitUntilRunning(name: string, child: ChildProcess) {
    const deadline = this.deps.now() + START_TIMEOUT_MS;
    while (this.deps.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Container exited before it started.\n${this.stderrTail}`);
      }
      if (await this.deps.containerIsRunning(name)) {
        return;
      }
      await this.deps.delay(RUNNING_POLL_MS);
    }
    throw new Error(`Timed out waiting for container ${name} to start.\n${this.stderrTail}`);
  }
}

export function processIsAlive(pid: number): boolean {
  if (isNaN(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    // EPERM: it exists but belongs to someone else.
    return (caught as NodeJS.ErrnoException).code === 'EPERM';
  }
}
