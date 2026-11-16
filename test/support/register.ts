// Loaded by mocha before any test (see .mocharc.json): makes `require('vscode')`
// return the stub in ./vscode, since the real module only exists inside VS Code.
import * as vscodeStub from './vscode';

// Module._load isn't in Node's type definitions.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const originalLoad = Module._load;

Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, ...rest);
};
