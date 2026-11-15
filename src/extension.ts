'use strict';

import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, State } from 'vscode-languageclient';

import { pullImage, waitForDocker } from './docker';
import { ServerConfig, ServerContainer } from './serverContainer';

let client: LanguageClient | undefined;

function readConfig(): ServerConfig {
  const conf = vscode.workspace.getConfiguration("ruby-language-server");
  return {
    image: conf["dockerImage"] || "kwerle/ruby_language_server",
    logLevel: conf["logLevel"],
    additionalGems: conf["additionalGems"] || "",
    projectRoot: vscode.workspace.rootPath || "",
  };
}

function createStatusBar(client: LanguageClient): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'workbench.action.output.toggleOutput';
  item.text = 'Ruby LSP: Starting';
  item.show();
  const labels: { [state: number]: string } = {
    [State.Starting]: 'Ruby LSP: Starting',
    [State.Running]: 'Ruby LSP: Running',
    [State.Stopped]: 'Ruby LSP: Stopped',
  };
  const listener = client.onDidChangeState(event => { item.text = labels[event.newState]; });
  return vscode.Disposable.from(listener, item);
}

export async function activate(context: vscode.ExtensionContext) {
  const config = readConfig();
  const output = vscode.window.createOutputChannel('Ruby Language Server');
  const container = new ServerContainer(config, output);

  pullImage(config.image);
  await waitForDocker();

  const clientOptions: LanguageClientOptions = {
    documentSelector: ['ruby'],
    outputChannel: output
  };
  client = new LanguageClient('Ruby Language Server', () => container.start(), clientOptions);

  context.subscriptions.push(output, container, createStatusBar(client), client.start());
}

export async function deactivate() {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
