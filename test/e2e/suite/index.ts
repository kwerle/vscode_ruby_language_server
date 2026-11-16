// Runs inside VS Code's extension host (see ../runTest.ts).  Uses Mocha 10
// (the `mocha-vscode-host` alias) because VS Code 1.82's extension host runs
// Node 18, and the project's Mocha 12 needs Node 20.19 or later.
import * as fs from 'fs';
import * as path from 'path';

// The alias has no type definitions of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Mocha = require('mocha-vscode-host');

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 180000, color: true });
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js'))) {
    mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => (failures > 0 ? reject(new Error(`${failures} end-to-end test(s) failed`)) : resolve()));
  });
}
