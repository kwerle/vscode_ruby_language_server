'use strict';

import * as vscode from 'vscode';
import { execFile } from 'mz/child_process';

import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';

export async function activate(context: vscode.ExtensionContext) {
  const conf = vscode.workspace.getConfiguration("ruby-language-server");
  let defaultImage = "kwerle/ruby_language_server";
  let command: string;
  let args: Array<string>;
  const image = conf["dockerImage"] || defaultImage;

  command = "docker";
  let logLevel = conf["logLevel"];
  args = ["run", "--rm", "-i", "-e", `LOG_LEVEL=${logLevel}`, "-v", `${vscode.workspace.rootPath}:/project`, "-w", "/project"];
  let additionalGems = conf["additionalGems"];
  if (additionalGems && additionalGems != "") {
    args.push("-e", `ADDITIONAL_GEMS=${additionalGems}`)
  }
  args.push(image);
  try {
    await vscode.window.withProgress({ title: "vscode_ruby_language_server", location: vscode.ProgressLocation.Window }, async progress => {
      progress.report({ message: `Pulling ${image}` });

      await execFile("docker", ["pull", image]);
    });
  } catch (err) {
    if (err.code == "ENOENT") {
      const selected = await vscode.window.showErrorMessage(
        'Docker executable not found. Install Docker.',
        { modal: true },
        'Open settings'
      );
      if (selected === 'Open settings') {
        await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings');
      }
    } else {
      vscode.window.showErrorMessage('Error updating docker image - will try to use existing local one: ' + err.message);
      console.error(err);
    }
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: ['ruby']
  };

  const executable: ServerOptions = { command, args };
  const disposable = new LanguageClient('Ruby Language Server', executable, clientOptions).start();

  context.subscriptions.push(disposable);
}
