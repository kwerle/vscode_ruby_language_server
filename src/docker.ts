'use strict';

import * as vscode from 'vscode';
import { promisify } from 'util';
import * as childProcess from 'child_process';

const execFile = promisify(childProcess.execFile);

// execFile rejects with the exit status (number) or a spawn error code like ENOENT (string).
interface ExecError {
  code?: number | string;
  message: string;
}

export function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

// If docker isn't answering we assume it's starting up - give it time.
export async function waitForDocker() {
  try {
    await execFile("docker", ["ps"]);
  } catch (error) {
    await delay(20 * 1000);
  }
}

export async function pullImage(image: string) {
  var attempts = 0;
  while (attempts < 10) {
    try {
      await vscode.window.withProgress({ title: "vscode_ruby_language_server", location: vscode.ProgressLocation.Window }, async progress => {
        progress.report({ message: `Pulling ${image}` });
        await execFile("docker", ["pull", image]);
        attempts = attempts + 10
      });
    } catch (caught) {
      const err = caught as ExecError;
      attempts = attempts + 1
      if (err.code == 1) { // Docker not yet running
        vscode.window.showErrorMessage('Waiting for docker to start');
        await delay(10 * 1000);
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

export async function removeContainer(name: string) {
  try {
    await execFile("docker", ["rm", "-f", name]);
  } catch (error) {
    // Already gone.
  }
}
