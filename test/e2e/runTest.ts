// Launch a real VS Code with this extension and run the suite in ./suite inside it.
//
//   npm run test:e2e
//
// VSCODE_TEST_VERSION picks the VS Code version (default: 1.82.0, the minimum
// in package.json; CI also runs "stable"). RLS_TEST_IMAGE picks the server image.
// Needs Docker, and a display (in CI: xvfb-run).
import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const repo = path.resolve(__dirname, '..', '..', '..');

async function main() {
  // Set when this runs from VS Code's own terminal; it would make the test
  // VS Code start as plain Node instead of the editor.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const version = process.env.VSCODE_TEST_VERSION || '1.82.0';
  // A short, private profile.  Short matters: VS Code puts a socket in it, and
  // long paths exceed the OS limit for socket names.
  const userDataDir = path.join(repo, '.vscode-test', 'ud');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  // dockerImage is a user-scoped setting, so it goes in the profile's user settings.
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'ruby-language-server.dockerImage': process.env.RLS_TEST_IMAGE || 'kwerle/ruby_language_server',
    'ruby-language-server.logLevel': 'error',
  }, null, 2));

  await runTests({
    version,
    extensionDevelopmentPath: repo,
    extensionTestsPath: path.join(__dirname, 'suite', 'index'),
    launchArgs: [
      path.join(repo, 'test', 'fixtures', 'project'),
      `--user-data-dir=${userDataDir}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
