import * as vscode from 'vscode';
import * as net from 'net';
import { StreamInfo } from 'vscode-languageclient/node';

import { delay } from './docker';
import { ContainerStatus } from './serverContainer';

// Development only: connect to a server that's already running, instead of
// starting a container.  ServerManager uses this when the Extension Development
// Host has RUBY_LANGUAGE_SERVER_DEV_PORT set, which only the "Launch Client
// (debug server)" configuration does.  The server side is ruby_language_server's
// `make debug_server` (LSP over TCP, under the rdbg debugger).
export const DEV_PORT_ENV = 'RUBY_LANGUAGE_SERVER_DEV_PORT';

// The server may still be starting, so keep trying for a while.
export const CONNECT_RETRY_MS = 250;
export const CONNECT_TIMEOUT_MS = 10 * 1000;

// The port from the environment, or undefined if it's unset or not a port number.
export function devPortFrom(env: NodeJS.ProcessEnv): number | undefined {
  const port = Number(env[DEV_PORT_ENV]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export interface DevServerDeps {
  connect: (port: number) => Promise<net.Socket>;
  delay: (ms: number) => Promise<unknown>;
  now: () => number;
}

function connectOnce(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

const realDeps: DevServerDeps = { connect: connectOnce, delay, now: () => Date.now() };

// Same shape as ServerContainer, so ServerManager and the status bar treat it alike.
export class DevServerConnection implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<ContainerStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private socket: net.Socket | undefined;
  private readonly deps: DevServerDeps;

  constructor(private readonly port: number, private readonly output: vscode.OutputChannel, deps: Partial<DevServerDeps> = {}) {
    this.deps = { ...realDeps, ...deps };
  }

  async start(): Promise<StreamInfo> {
    this.statusEmitter.fire('starting');
    const deadline = this.deps.now() + CONNECT_TIMEOUT_MS;
    for (;;) {
      try {
        const socket = await this.deps.connect(this.port);
        this.socket = socket;
        this.output.appendLine(`Connected to the development server on port ${this.port}.`);
        return { reader: socket, writer: socket };
      } catch (error) {
        if (this.deps.now() >= deadline) {
          const message = `No development server on port ${this.port}. Start it with "Debug server" (make debug_server) in ruby_language_server.`;
          this.output.appendLine(message);
          throw new Error(message, { cause: error });
        }
        await this.deps.delay(CONNECT_RETRY_MS);
      }
    }
  }

  dispose() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    this.statusEmitter.dispose();
  }
}
