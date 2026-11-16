import * as vscode from 'vscode';
import * as path from 'path';
import {
  CloseAction, ErrorAction, ErrorHandler, LanguageClient, LanguageClientOptions, State, StreamInfo,
} from 'vscode-languageclient/node';

import { daemonIsUp, DockerNotInstalledError, refreshImage, waitForDaemon, WaitForDaemonOptions } from './docker';
import { ContainerStatus, ServerConfig, ServerContainer } from './serverContainer';
import { checkServerVersion, ServerInfo } from './serverVersion';
import { StatusBar } from './statusBar';

// How long the first start waits for Docker before offering Retry.
export const INITIAL_DOCKER_WAIT_MS = 2 * 60 * 1000;
// How long to let a running client shut down cleanly before removing its container.
const STOP_TIMEOUT_MS = 2000;

// The parts of a LanguageClient the manager uses (tests pass a fake).
export interface Client {
  readonly state: State;
  readonly initializeResult: { serverInfo?: ServerInfo } | undefined;
  readonly onDidChangeState: vscode.Event<{ oldState: State, newState: State }>;
  start(): Promise<void>;
  stop(timeout?: number): Promise<void>;
}

// The parts of a ServerContainer the manager uses.
export interface Container extends vscode.Disposable {
  readonly onDidChangeStatus: vscode.Event<ContainerStatus>;
  start(): Promise<StreamInfo>;
}

export interface ManagerDeps {
  createContainer: (config: ServerConfig, output: vscode.OutputChannel) => Container;
  createClient: (serverOptions: () => Promise<StreamInfo>, clientOptions: LanguageClientOptions) => Client;
  daemonIsUp: () => Promise<boolean>;
  waitForDaemon: (options: WaitForDaemonOptions) => Promise<boolean>;
  refreshImage: (image: string) => Promise<string | undefined>;
  projectRoot: () => string | undefined;
  readConfig: (root: string) => ServerConfig;
}

// ServerContainer.start() does all the waiting and retrying, so the client
// always restarts after a close.  `handled: true` keeps vscode-languageclient 9
// from popping up a notification on every restart; ServerContainer logs instead.
// Connection errors use the library's usual policy.
export const errorHandler: ErrorHandler = {
  error: (_error, _message, count) => ({ action: count !== undefined && count <= 3 ? ErrorAction.Continue : ErrorAction.Shutdown }),
  closed: () => ({ action: CloseAction.Restart, handled: true }),
};

function workspaceProjectRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // No folder open: use the directory of the Ruby file that activated us.
  const rubyFile = vscode.workspace.textDocuments.find(doc => doc.languageId === 'ruby' && doc.uri.scheme === 'file');
  return rubyFile ? path.dirname(rubyFile.uri.fsPath) : undefined;
}

function settings(root: string): ServerConfig {
  const conf = vscode.workspace.getConfiguration('ruby-language-server');
  return {
    image: conf['dockerImage'] || 'kwerle/ruby_language_server',
    logLevel: conf['logLevel'],
    additionalGems: conf['additionalGems'] || '',
    projectRoot: root,
  };
}

const realDeps: ManagerDeps = {
  createContainer: (config, output) => new ServerContainer(config, output),
  createClient: (serverOptions, clientOptions) =>
    new LanguageClient('ruby-language-server', 'Ruby Language Server', serverOptions, clientOptions),
  daemonIsUp: () => daemonIsUp(),
  waitForDaemon: options => waitForDaemon(options),
  refreshImage: image => refreshImage(image),
  projectRoot: workspaceProjectRoot,
  readConfig: settings,
};

// Owns the server's lifecycle: one LanguageClient and one ServerContainer at a
// time.  start() starts or restarts; the Restart command and Retry call it.
//
// vscode-languageclient 9 can't restart a client whose start failed, and its
// stop() (and so restart()) throws unless the client is fully running.  So a
// restart always builds a new client, and a client that's still starting is
// dropped by disposing its container, which leaves its start() pending forever
// rather than failing with a spurious error.
export class ServerManager implements vscode.Disposable {
  private client: Client | undefined;
  private container: Container | undefined;
  // Bumped by every start() and stop(), so an older start still waiting on
  // Docker can tell it's been superseded.
  private generation = 0;
  private imageRefreshed = false;
  private versionWarningShown = false;
  private readonly deps: ManagerDeps;

  constructor(private readonly output: vscode.OutputChannel, private readonly statusBar: StatusBar, deps: Partial<ManagerDeps> = {}) {
    this.deps = { ...realDeps, ...deps };
  }

  // Start, or restart, the server.
  async start(): Promise<void> {
    const myGeneration = ++this.generation;
    await this.stopCurrent();
    if (myGeneration !== this.generation) {
      return;
    }

    const root = this.deps.projectRoot();
    if (!root) {
      this.statusBar.show('Stopped');
      this.showError('Ruby Language Server needs an open folder or Ruby file.');
      return;
    }
    const config = this.deps.readConfig(root);

    this.statusBar.show('Starting');
    if (!await this.dockerIsReady(myGeneration) || myGeneration !== this.generation) {
      return;
    }
    this.refreshImageOnce(config.image);

    const container = this.deps.createContainer(config, this.output);
    const client = this.deps.createClient(() => container.start(), {
      documentSelector: [{ scheme: 'file', language: 'ruby' }],
      outputChannel: this.output,
      errorHandler,
    });
    this.container = container;
    this.client = client;
    this.statusBar.track(client, container);
    try {
      await client.start();
    } catch (error) {
      return; // The client reports start failures itself.
    }
    if (this.client === client) {
      this.reportServerVersion(client, config.image);
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    await this.stopCurrent();
  }

  dispose() {
    this.stop().catch(() => undefined);
  }

  private async stopCurrent() {
    const client = this.client;
    const container = this.container;
    this.client = undefined;
    this.container = undefined;
    if (client && client.state === State.Running) {
      try {
        await client.stop(STOP_TIMEOUT_MS);
      } catch (error) {
        // Timed out, or the server already went away: the container goes next anyway.
      }
    }
    if (container) {
      container.dispose();
    }
  }

  // Wait for the Docker daemon on first start.  False if it didn't come up (and the user has been told).
  private async dockerIsReady(myGeneration: number): Promise<boolean> {
    try {
      if (await this.deps.daemonIsUp()) {
        return true;
      }
      this.statusBar.show('Waiting for Docker');
      this.output.appendLine('Docker is not reachable. Waiting for it to start.');
      const ready = await this.deps.waitForDaemon({
        timeoutMs: INITIAL_DOCKER_WAIT_MS,
        cancelled: () => myGeneration !== this.generation,
      });
      if (ready || myGeneration !== this.generation) {
        return ready;
      }
      this.statusBar.show('Stopped');
      const choice = await this.showError("Docker isn't running. Start Docker, then retry.", 'Retry');
      if (choice === 'Retry') {
        this.start().catch(error => this.output.appendLine(`Failed to start: ${error}`));
      }
      return false;
    } catch (caught) {
      if (!(caught instanceof DockerNotInstalledError)) {
        throw caught;
      }
      this.statusBar.show('Stopped');
      await this.showDockerNotInstalled();
      return false;
    }
  }

  // Pull the image in the background, once per session.  A failure is reported
  // once and the server runs from the local copy.
  private refreshImageOnce(image: string) {
    if (this.imageRefreshed) {
      return;
    }
    this.imageRefreshed = true;
    this.deps.refreshImage(image).then(problem => {
      if (problem) {
        this.output.appendLine(`Couldn't update ${image}: ${problem}`);
        this.showWithOutput(vscode.window.showWarningMessage(`Couldn't update ${image}; using the local copy. ${problem}`, 'Show Output'));
      }
    });
  }

  // Log the server's name and version, and warn (once per session) if it's known to be too old.
  private reportServerVersion(client: Client, image: string) {
    const result = client.initializeResult;
    const check = checkServerVersion(result && result.serverInfo, image);
    this.output.appendLine(check.log);
    if (check.warning && !this.versionWarningShown) {
      this.versionWarningShown = true;
      this.showWithOutput(vscode.window.showWarningMessage(check.warning, 'Show Output'));
    }
  }

  private async showError(message: string, ...actions: string[]): Promise<string | undefined> {
    return this.showWithOutput(vscode.window.showErrorMessage(message, ...actions, 'Show Output'));
  }

  private async showWithOutput(shown: Thenable<string | undefined>): Promise<string | undefined> {
    const choice = await shown;
    if (choice === 'Show Output') {
      this.output.show();
    }
    return choice;
  }

  private async showDockerNotInstalled() {
    const selected = await vscode.window.showErrorMessage(
      'Docker executable not found. Install Docker.',
      { modal: true },
      'Open settings'
    );
    if (selected === 'Open settings') {
      await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings');
    }
  }
}
