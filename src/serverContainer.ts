'use strict';

import * as vscode from 'vscode';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { StreamInfo } from 'vscode-languageclient';

import { delay, removeContainer } from './docker';

// Port the server listens on inside the container.  The host side is picked at runtime.
const CONTAINER_PORT = 2087;
// How long to wait for the server to start accepting connections.
const CONNECT_TIMEOUT_MS = 90 * 1000;
// A connection must stay open this long before we trust it (see connectWhenReady).
const SETTLE_MS = 500;
const RETRY_MS = 250;

export interface ServerConfig {
  image: string;
  logLevel: string;
  additionalGems: string;
  projectRoot: string;
}

// Runs the language server in a docker container and connects to it over TCP.
// One instance per client; start() may be called again on client restart and
// replaces the previous container.
export class ServerContainer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private name: string | undefined;
  private stderrTail = '';

  constructor(private config: ServerConfig, private output: vscode.OutputChannel) {}

  async start(): Promise<StreamInfo> {
    this.dispose();

    const hostPort = await findFreePort();
    this.name = `vscode-ruby-lsp-${process.pid}-${hostPort}`;
    this.child = this.spawnContainer(this.name, hostPort);

    const socket = await this.connectWhenReady(hostPort, this.child);
    socket.setKeepAlive(true, 60 * 1000);
    this.output.appendLine(`Connected to language server on localhost:${hostPort}`);
    return { reader: socket, writer: socket };
  }

  dispose() {
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

  private dockerArgs(name: string, hostPort: number): string[] {
    const { image, logLevel, additionalGems, projectRoot } = this.config;
    const args = [
      "run", "--rm",
      "--name", name,
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
