'use strict';

import * as vscode from 'vscode';
import { State } from 'vscode-languageclient/node';

import { ContainerStatus } from './serverContainer';

// What the status bar follows: a client's state and its container's status.
export interface Trackable {
  readonly onDidChangeState: vscode.Event<{ newState: State }>;
}
export interface TrackableContainer {
  readonly onDidChangeStatus: vscode.Event<ContainerStatus>;
}

// Status bar item showing the server's state.  Clicking it runs `command` (restart).
// track() is called for each new client/container pair after a restart.
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private tracking: vscode.Disposable[] = [];

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = command;
    this.item.tooltip = 'Ruby Language Server: click to restart';
    this.show('Starting');
    this.item.show();
  }

  show(label: 'Waiting for Docker' | 'Starting' | 'Running' | 'Stopped') {
    this.item.text = `Ruby LSP: ${label}`;
  }

  track(client: Trackable, container: TrackableContainer) {
    this.untrack();
    this.tracking.push(
      client.onDidChangeState(event => {
        switch (event.newState) {
          case State.Starting: this.show('Starting'); break;
          case State.Running: this.show('Running'); break;
          case State.Stopped: this.show('Stopped'); break;
        }
      }),
      container.onDidChangeStatus(status => {
        this.show(status === 'waiting-for-docker' ? 'Waiting for Docker' : 'Starting');
      })
    );
  }

  dispose() {
    this.untrack();
    this.item.dispose();
  }

  private untrack() {
    this.tracking.forEach(disposable => disposable.dispose());
    this.tracking = [];
  }
}
