'use strict';

import * as vscode from 'vscode';

import { ServerManager } from './serverManager';
import { StatusBar } from './statusBar';

const RESTART_COMMAND = 'ruby-language-server.restart';

let manager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Ruby Language Server');
  const statusBar = new StatusBar(RESTART_COMMAND);
  const serverManager = new ServerManager(output, statusBar);
  manager = serverManager;
  context.subscriptions.push(
    output,
    statusBar,
    serverManager,
    vscode.commands.registerCommand(RESTART_COMMAND, () => serverManager.start()),
  );
  // Don't hold up activation while waiting for Docker.
  serverManager.start().catch(error => output.appendLine(`Failed to start: ${error}`));
}

export async function deactivate() {
  if (manager) {
    await manager.stop();
    manager = undefined;
  }
}
