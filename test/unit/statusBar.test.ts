import * as assert from 'assert';
import { State } from 'vscode-languageclient/node';

import { ContainerStatus } from '../../src/serverContainer';
import { StatusBar } from '../../src/statusBar';
import { EventEmitter, FakeStatusBarItem, resetStub, window } from '../support/vscode';

const RESTART = 'ruby-language-server.restart';

// Just enough of a client and a container to drive the status bar.
function fakes() {
  const clientStates = new EventEmitter<{ oldState: State, newState: State }>();
  const containerStatus = new EventEmitter<ContainerStatus>();
  const client = { onDidChangeState: clientStates.event };
  const container = { onDidChangeStatus: containerStatus.event };
  const setState = (newState: State) => clientStates.fire({ oldState: State.Starting, newState });
  return { client, container, setState, containerStatus };
}

describe('StatusBar', () => {
  let statusBar: StatusBar;
  let item: FakeStatusBarItem;

  beforeEach(() => {
    resetStub();
    statusBar = new StatusBar(RESTART);
    item = window.statusBarItems[0];
  });

  it('starts visible, showing Starting, and restarts when clicked', () => {
    assert.strictEqual(window.statusBarItems.length, 1);
    assert.strictEqual(item.text, 'Ruby LSP: Starting');
    assert.strictEqual(item.visible, true);
    assert.strictEqual(item.command, RESTART);
    assert.match(item.tooltip || '', /restart/);
  });

  it('shows the label it is given', () => {
    statusBar.show('Waiting for Docker');
    assert.strictEqual(item.text, 'Ruby LSP: Waiting for Docker');
  });

  it('follows the client state', () => {
    const { client, container, setState } = fakes();
    statusBar.track(client, container);

    setState(State.Running);
    assert.strictEqual(item.text, 'Ruby LSP: Running');
    setState(State.Stopped);
    assert.strictEqual(item.text, 'Ruby LSP: Stopped');
    setState(State.Starting);
    assert.strictEqual(item.text, 'Ruby LSP: Starting');
  });

  it('follows the container status while the client is starting', () => {
    const { client, container, containerStatus } = fakes();
    statusBar.track(client, container);

    containerStatus.fire('waiting-for-docker');
    assert.strictEqual(item.text, 'Ruby LSP: Waiting for Docker');
    containerStatus.fire('starting');
    assert.strictEqual(item.text, 'Ruby LSP: Starting');
  });

  it('stops following the previous client after a restart', () => {
    const first = fakes();
    const second = fakes();
    statusBar.track(first.client, first.container);
    statusBar.track(second.client, second.container);

    second.setState(State.Running);
    first.setState(State.Stopped);
    first.containerStatus.fire('waiting-for-docker');
    assert.strictEqual(item.text, 'Ruby LSP: Running');
  });

  it('disposes the item and stops listening when disposed', () => {
    const { client, container, setState } = fakes();
    statusBar.track(client, container);
    statusBar.dispose();

    assert.strictEqual(item.disposed, true);
    const textAtDispose = item.text;
    setState(State.Running);
    assert.strictEqual(item.text, textAtDispose);
  });
});
