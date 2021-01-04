'use strict';

import * as vscode from 'vscode';
import { execFile } from 'mz/child_process';

import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

async function pullImage(image:String) {
  var attempts = 0;
  while (attempts < 10) {
    try {
      await vscode.window.withProgress({ title: "vscode_ruby_language_server", location: vscode.ProgressLocation.Window }, async progress => {
        progress.report({ message: `Pulling ${image}` });
        // console.log('before')
        await execFile("docker", ["pull", image]);
        // console.error('after');
        attempts = attempts + 10
      });
    } catch (err) {
      attempts = attempts + 1
      // vscode.window.showErrorMessage(`${err.code}`);
      if (err.code == 1) { // Docker not yet running
        // console.error('a');
        vscode.window.showErrorMessage('Waiting for docker to start');
        // console.error('b');
        await delay(10 * 1000);
        // console.error('c');
      } else {
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
          vscode.window.showErrorMessage('Error updating docker image! - will try to use existing local one: ' + err.message);
          console.error(err);
        }
      }

    }
  }
}

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

  // console.log("HERE 1");
  pullImage(image);
  // console.log("HERE 2");

  const clientOptions: LanguageClientOptions = {
    documentSelector: ['ruby']
  };

  const executable: ServerOptions = { command, args };
  // console.log("HERE 3");
  try {
    // Try to run a simple docker command
    await execFile("docker", ["ps"]);
    // console.log("HERE 3.1");
  } catch (error) {
    // If it fails we assume it's starting up - give it time
    // console.log("HERE 3.2");
    await delay(20 * 1000)
    // console.log("HERE 3.3");
  }
  const disposable = new LanguageClient('Ruby Language Server', executable, clientOptions).start();
  // console.log("HERE 4");

  context.subscriptions.push(disposable);
}
