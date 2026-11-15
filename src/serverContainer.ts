'use strict';

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { StreamInfo } from 'vscode-languageclient';

import { daemonIsUp, delay, docker, removeContainer, waitForDaemon } from './docker';

// Port the server listens on inside the container.  The host side is picked at runtime.
const CONTAINER_PORT = 2087;
// How long to wait for the server to start accepting connections.
const CONNECT_TIMEOUT_MS = 90 * 1000;
// A connection must stay open this long before we trust it (see connectWhenReady).
const SETTLE_MS = 500;
const RETRY_MS = 250;
// Give up after this many crashes (while the Docker daemon is up) within the window.
// Matches vscode-languageclient's default restart policy.
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 3 * 60 * 1000;
// Pause between attempts after a crash.
const CRASH_BACKOFF_MS = 1000;

const LABEL_ROOT = 'ruby-language-server.root';
const LABEL_PID = 'ruby-language-server.pid';

export interface ServerConfig {
  image: string;
  logLevel: string;
  additionalGems: string;
  projectRoot: string;
}

export type ContainerStatus = 'waiting-for-docker' | 'starting';

// Runs the language server in a docker container and connects to it over TCP.
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
  private crashTimes: number[] = [];
  private readonly rootHash: string;
  private readonly statusEmitter = new vscode.EventEmitter<ContainerStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(private config: ServerConfig, private output: vscode.OutputChannel) {
    this.rootHash = crypto.createHash('sha1').update(config.projectRoot).digest('hex').slice(0, 12);
  }

  async start(): Promise<StreamInfo> {
    this.stopContainer();

    if (this.started && await this.daemonIsUpSafely()) {
      // The previous server's connection closed while Docker was running.
      this.recordCrash('The server stopped unexpectedly.');
      await delay(CRASH_BACKOFF_MS);
    }
    this.started = true;

    while (!this.disposed) {
      if (!await this.daemonIsUpSafely()) {
        this.statusEmitter.fire('waiting-for-docker');
        this.output.appendLine('Docker is not reachable. Waiting for it to start.');
        await waitForDaemon({ cancelled: () => this.disposed });
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
          await delay(CRASH_BACKOFF_MS);
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
      return await daemonIsUp();
    } catch (error) {
      return false; // docker CLI missing - extension.ts reports that before we get here
    }
  }

  // Throws once the crash budget is used up.
  private recordCrash(reason: string) {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter(time => now - time < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    if (this.crashTimes.length >= MAX_CRASHES) {
      throw new Error(
        `${reason} It has failed ${this.crashTimes.length} times in the last ${CRASH_WINDOW_MS / 60000} minutes ` +
        `and will not be restarted. Use "Ruby Language Server: Restart" to try again.\n${this.stderrTail}`
      );
    }
  }

  private async launch(): Promise<StreamInfo> {
    await this.removeStaleContainers();
    const hostPort = await findFreePort();
    this.name = `ruby-language-server-${this.rootHash}-${process.pid}`;
    this.child = this.spawnContainer(this.name, hostPort);

    const socket = await this.connectWhenReady(hostPort, this.child);
    socket.setKeepAlive(true, 60 * 1000);
    this.output.appendLine(`Connected to language server on localhost:${hostPort}`);
    return { reader: socket, writer: socket };
  }

  private stopContainer() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = undefined;
    if (this.name) {
      // Belt and braces: the docker CLI doesn't always forward the signal.
      removeContainer(this.name);
      this.name = undefined;
    }
  }

  // Remove containers for this project left by an earlier start in this window,
  // or by a window that has since gone away.  Other live windows' containers
  // are left alone.
  private async removeStaleContainers() {
    const listing = await docker([
      "ps", "-a",
      "--filter", `label=${LABEL_ROOT}=${this.rootHash}`,
      "--format", `{{.ID}} {{.Label "${LABEL_PID}"}}`,
    ]);
    for (const line of listing.split('\n')) {
      const [id, pidText] = line.trim().split(' ');
      if (!id) {
        continue;
      }
      const pid = parseInt(pidText, 10);
      if (pid === process.pid || !processIsAlive(pid)) {
        this.output.appendLine(`Removing stale container ${id}`);
        await removeContainer(id);
      }
    }
  }

  private dockerArgs(name: string, hostPort: number): string[] {
    const { image, logLevel, additionalGems, projectRoot } = this.config;
    const args = [
      "run", "--rm",
      "--name", name,
      "--label", `${LABEL_ROOT}=${this.rootHash}`,
      "--label", `${LABEL_PID}=${process.pid}`,
      "-e", `LOG_LEVEL=${logLevel}`,
      "-e", `LSP_PORT=${CONTAINER_PORT}`,
      "-p", `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
      "-v", `${projectRoot}:/project`,
      "-w", "/project",
    ];
    if (additionalGems) {
      args.push("-e", `ADDITIONAL_GEMS=${additionalGems}`);
    }
    args.push(image);
    return args;
  }

  private spawnContainer(name: string, hostPort: number): ChildProcess {
    this.output.appendLine(`Starting container ${name} (localhost:${hostPort} -> ${CONTAINER_PORT})`);
    this.stderrTail = '';
    const child = spawn("docker", this.dockerArgs(name, hostPort), { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (data: Buffer) => this.output.append(data.toString()));
    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      this.output.append(text);
    });
    child.on('error', (err: Error) => this.output.appendLine(`Failed to run docker: ${err.message}`));
    child.on('exit', (code, signal) => this.output.appendLine(`Container ${name} exited (${signal || code})`));
    return child;
  }

  // Docker's port proxy accepts host connections before the server inside the
  // container is listening, then drops them.  The server only accepts a single
  // connection and waits for the client to speak first, so the first connection
  // that stays open is the real one - and we must hand that exact socket to the
  // client rather than probing and reconnecting.
  private async connectWhenReady(port: number, child: ChildProcess): Promise<net.Socket> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Container exited before accepting a connection.\n${this.stderrTail}`);
      }
      const socket = await connectAndSettle(port);
      if (socket) {
        return socket;
      }
      await delay(RETRY_MS);
    }
    throw new Error(`Timed out waiting for the language server on port ${port}.\n${this.stderrTail}`);
  }
}

function processIsAlive(pid: number): boolean {
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

// Ask the OS for an unused port on the loopback interface.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

// Resolve with a connected socket that is still open after SETTLE_MS, or null.
function connectAndSettle(port: number): Promise<net.Socket | null> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let done = false;
    const fail = () => {
      if (done) { return; }
      done = true;
      socket.destroy();
      resolve(null);
    };
    const events = ['error', 'close', 'end'];
    events.forEach(event => socket.once(event, fail));
    socket.once('connect', () => {
      setTimeout(() => {
        if (done) { return; }
        done = true;
        events.forEach(event => socket.removeListener(event, fail));
        resolve(socket);
      }, SETTLE_MS);
    });
  });
}
