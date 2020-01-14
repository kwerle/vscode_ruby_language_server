'use strict';

import * as vscode from 'vscode';
import { execFile } from 'mz/child_process';

import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';

export async function activate(context: vscode.ExtensionContext) {
    const conf = vscode.workspace.getConfiguration("vscode_ruby_language_server");
    // let [command, ...args] = (<[string]>conf.get("commandWithArgs"));
    let command: string;
    let args: Array<string>;
    if (!command) {
        try {
            // const image = "local_ruby_language_server";
            const image = "kwerle/ruby_language_server";

            await vscode.window.withProgress({title: "vscode_ruby_language_server", location: vscode.ProgressLocation.Window}, async progress => {
                progress.report({message: `Pulling ${image}`});

                await execFile("docker", ["pull", image]);
            });

            command = "docker";
            args = ["run", "--rm", "-i", "-e", "LOG_LEVEL=debug", "-v", `${vscode.workspace.rootPath}:/project`, "-w", "/project", image];
        } catch (err) {
            if (err.code == "ENOENT") {
                const selected = await vscode.window.showErrorMessage(
                    'Docker executable not found. Install Docker.',
                    {modal: true},
                    'Open settings'
                );
                if (selected === 'Open settings') {
                    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings');
                }
            } else {
                vscode.window.showErrorMessage('Error execution Language Server via Docker: ' + err.message);
                console.error(err);
            }
        }
    }
    const clientOptions: LanguageClientOptions = {
        documentSelector: ['ruby']
    };
    const executable: ServerOptions = {command, args};
    const disposable = new LanguageClient('Ruby Language Server', executable, clientOptions).start();

    context.subscriptions.push(disposable);
}
