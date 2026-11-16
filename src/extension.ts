'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { CloseAction, ErrorAction, ErrorHandler, LanguageClient, LanguageClientOptions } from 'vscode-languageclient';

import { daemonIsUp, delay, DockerNotInstalledError, refreshImage, waitForDaemon } from './docker';
import { ServerConfig, ServerContainer } from './serverContainer';
import { checkServerVersion } from './serverVersion';
import { StatusBar } from './statusBar';

const RESTART_COMMAND = 'ruby-language-server.restart';
// How long the first start waits for Docker before offering Retry.
const INITIAL_DOCKER_WAIT_MS = 2 * 60 * 1000;
// How long to let a client shut down cleanly before removing its container.
const STOP_GRACE_MS = 2000;

let output: vscode.OutputChannel;
let statusBar: StatusBar;
let client: LanguageClient | undefined;
let container: ServerContainer | undefined;
// Bumped by every startServer() so an older, still-waiting start can tell it's been superseded.
let generation = 0;
let imageRefreshed = false;
let versionWarningShown = false;

// ServerContainer.start() does the waiting and retrying, so the client always
// restarts after a close.  Connection errors use the library's default policy.
const errorHandler: ErrorHandler = {
  error: (_error, _message, count) => count <= 3 ? ErrorAction.Continue : ErrorAction.Shutdown,
  closed: () => CloseAction.Restart,
};

function projectRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // No folder open: use the directory of the Ruby file that activated us.
  const rubyFile = vscode.workspace.textDocuments.find(doc => doc.languageId === 'ruby' && doc.uri.scheme === 'file');
  return rubyFile ? path.dirname(rubyFile.uri.fsPath) : undefined;
}

function readConfig(root: string): ServerConfig {
  const conf = vscode.workspace.getConfiguration("ruby-language-server");
  return {
    image: conf["dockerImage"] || "kwerle/ruby_language_server",
    logLevel: conf["logLevel"],
    additionalGems: conf["additionalGems"] || "",
    projectRoot: root,
  };
}

async function showError(message: string, ...actions: string[]): Promise<string | undefined> {
  const choice = await vscode.window.showErrorMessage(message, ...actions, 'Show Output');
  if (choice === 'Show Output') {
    output.show();
  }
  return choice;
}

async function showDockerNotInstalled() {
  const selected = await vscode.window.showErrorMessage(
    'Docker executable not found. Install Docker.',
    { modal: true },
    'Open settings'
  );
  if (selected === 'Open settings') {
    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings');
  }
}

// Wait for the Docker daemon on first start.  False if it didn't come up (and the user has been told).
async function dockerIsReady(myGeneration: number): Promise<boolean> {
  try {
    if (await daemonIsUp()) {
      return true;
    }
    statusBar.show('Waiting for Docker');
    output.appendLine('Docker is not reachable. Waiting for it to start.');
    const ready = await waitForDaemon({
      timeoutMs: INITIAL_DOCKER_WAIT_MS,
      cancelled: () => myGeneration !== generation,
    });
    if (ready || myGeneration !== generation) {
      return ready;
    }
    statusBar.show('Stopped');
    const choice = await showError("Docker isn't running. Start Docker, then retry.", 'Retry');
    if (choice === 'Retry') {
      startServer();
    }
    return false;
  } catch (caught) {
    if (!(caught instanceof DockerNotInstalledError)) {
      throw caught;
    }
    statusBar.show('Stopped');
    await showDockerNotInstalled();
    return false;
  }
}

// Pull the image in the background, once per session.  A failure is reported
// once and the server runs from the local copy.
function refreshImageOnce(image: string) {
  if (imageRefreshed) {
    return;
  }
  imageRefreshed = true;
  refreshImage(image).then(problem => {
    if (problem) {
      output.appendLine(`Couldn't update ${image}: ${problem}`);
      vscode.window.showWarningMessage(`Couldn't update ${image}; using the local copy. ${problem}`, 'Show Output')
        .then(choice => { if (choice === 'Show Output') { output.show(); } });
    }
  });
}

// Once a client is running, log the server's name and version, and warn (once
// per session) if it's known to be too old.
function reportServerVersion(runningClient: LanguageClient, image: string) {
  const result = runningClient.initializeResult;
  const check = checkServerVersion(result && result.serverInfo, image);
  output.appendLine(check.log);
  if (check.warning && !versionWarningShown) {
    versionWarningShown = true;
    vscode.window.showWarningMessage(check.warning, 'Show Output')
      .then(choice => { if (choice === 'Show Output') { output.show(); } });
  }
}

async function stopServer() {
  const oldClient = client;
  const oldContainer = container;
  client = undefined;
  container = undefined;
  // A starting client's stop() waits on its connection, which may be waiting on
  // Docker, so don't wait for it for long before removing the container.
  const stopping = oldClient && oldClient.needsStop()
    ? oldClient.stop().catch(() => undefined)
    : Promise.resolve();
  await Promise.race([stopping, delay(STOP_GRACE_MS)]);
  if (oldContainer) {
    oldContainer.dispose();
  }
}

// Start, or restart, the server.
async function startServer() {
  const myGeneration = ++generation;
  await stopServer();

  const root = projectRoot();
  if (!root) {
    statusBar.show('Stopped');
    showError('Ruby Language Server needs an open folder or Ruby file.');
    return;
  }
  const config = readConfig(root);

  statusBar.show('Starting');
  if (!await dockerIsReady(myGeneration) || myGeneration !== generation) {
    return;
  }
  refreshImageOnce(config.image);

  const newContainer = new ServerContainer(config, output);
  const clientOptions: LanguageClientOptions = {
    documentSelector: ['ruby'],
    outputChannel: output,
    errorHandler,
  };
  const newClient = new LanguageClient('Ruby Language Server', () => newContainer.start(), clientOptions);
  container = newContainer;
  client = newClient;
  statusBar.track(newClient, newContainer);
  newClient.start();
  // onReady rejects when the start fails; that's reported elsewhere.
  newClient.onReady().then(() => reportServerVersion(newClient, config.image), () => undefined);
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ruby Language Server');
  statusBar = new StatusBar(RESTART_COMMAND);
  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand(RESTART_COMMAND, () => startServer()),
  );
  // Don't hold up activation while waiting for Docker.
  startServer().catch(error => output.appendLine(`Failed to start: ${error}`));
}

export async function deactivate() {
  generation++;
  await stopServer();
}
