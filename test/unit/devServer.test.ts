import * as assert from 'assert';
import { Socket } from 'net';
import { OutputChannel } from 'vscode';

import { CONNECT_TIMEOUT_MS, DevServerConnection, devPortFrom } from '../../src/devServer';
import { FakeOutputChannel, resetStub } from '../support/vscode';

class FakeSocket {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

// A clock that only moves when the connection waits, and a connect that fails `failures` times.
function setup(failures: number) {
  const state = { clock: 0, attempts: 0, socket: new FakeSocket() };
  const output = new FakeOutputChannel('Ruby Language Server');
  const connection = new DevServerConnection(7658, output as unknown as OutputChannel, {
    connect: async port => {
      assert.strictEqual(port, 7658);
      state.attempts++;
      if (state.attempts <= failures) {
        throw new Error('ECONNREFUSED');
      }
      return state.socket as unknown as Socket;
    },
    delay: async ms => {
      state.clock += ms;
    },
    now: () => state.clock,
  });
  return { state, output, connection };
}

describe('devPortFrom', () => {
  it('reads a port number from RUBY_LANGUAGE_SERVER_DEV_PORT', () => {
    assert.strictEqual(devPortFrom({ RUBY_LANGUAGE_SERVER_DEV_PORT: '7658' }), 7658);
  });

  it('ignores a missing or invalid value', () => {
    assert.strictEqual(devPortFrom({}), undefined);
    assert.strictEqual(devPortFrom({ RUBY_LANGUAGE_SERVER_DEV_PORT: '' }), undefined);
    assert.strictEqual(devPortFrom({ RUBY_LANGUAGE_SERVER_DEV_PORT: 'abc' }), undefined);
    assert.strictEqual(devPortFrom({ RUBY_LANGUAGE_SERVER_DEV_PORT: '70000' }), undefined);
  });
});

describe('DevServerConnection', () => {
  beforeEach(() => resetStub());

  it('retries until the server accepts, then returns the socket as reader and writer', async () => {
    const { state, output, connection } = setup(3);
    const streams = await connection.start();

    assert.strictEqual(state.attempts, 4);
    assert.strictEqual(streams.reader, state.socket);
    assert.strictEqual(streams.writer, state.socket);
    assert.match(output.text, /Connected to the development server on port 7658/);
  });

  it('gives up after the time limit, saying how to start the server', async () => {
    const { state, output, connection } = setup(Infinity);
    await assert.rejects(connection.start(), /No development server on port 7658/);

    assert.ok(state.clock >= CONNECT_TIMEOUT_MS);
    assert.match(output.text, /make debug_server/);
  });

  it('destroys the socket on dispose', async () => {
    const { state, connection } = setup(0);
    await connection.start();
    connection.dispose();

    assert.ok(state.socket.destroyed);
  });
});
