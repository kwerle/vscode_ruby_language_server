# CLAUDE.md

VS Code client for [ruby_language_server](https://github.com/kwerle/ruby_language_server). The extension doesn't contain a language server: it runs the server's Docker image (`kwerle/ruby_language_server` by default) and talks LSP to it.

## Branches

Git-flow:

- **`develop`**: new work is forked from `develop` on its own branch (e.g. `feature/<name>`), then merged back into `develop` by PR when it's done. Don't commit directly to `develop`.
- **`master`**: released code only. It changes when we ship: a release is merged into `master` and tagged (e.g. `0.1.2`), then merged back into `develop`.
- Dependabot (`.github/dependabot.yml`): version updates for npm, GitHub Actions and the build image target `develop`. Security updates always target `master`; after merging one, bring `develop` up to date with `master`. Dependabot reads its config from `master`, so config changes take effect when they ship.

## Build and run

The supported environment is Docker (see the Makefile): `make image` installs dependencies and compiles, `make test` runs the tests, `make package` builds the `.vsix`, and `make shell` opens a shell in the build image. The build image is pinned to `node:24`, because later Node images no longer include yarn. `yarn` isn't expected to be installed on the host.

What ships is a single bundle, `dist/extension.js`, built by `scripts/bundle.js` (esbuild) with the runtime dependencies inlined. `.vscodeignore` excludes everything except the bundle, README, CHANGELOG and LICENSE, so new files stay out of the `.vsix` unless they're added there. `npm run package` builds the `.vsix`, and CI checks its contents with `scripts/check-package.js`. To ship a new file on purpose, add it to both `.vscodeignore` and the script's `EXPECTED` list. `vscode:prepublish` type-checks and builds the minified production bundle. The bundler is `esbuild-wasm`, not `esbuild`, because `node_modules` is shared between the Linux build image and the host, and esbuild's native binary only works on the platform that installed it. Don't add dependencies with platform-specific binaries.

Host-side, for debugging in VS Code:

- `npm run compile` type-checks, compiles to `out/` (used by tests), and builds the development bundle with a source map. `npm run watch` rebuilds the bundle on change; reload the test window to pick it up.
- F5 ("Launch Client") runs the `npm: compile` task and opens an Extension Development Host. `.vscode/settings.json` sets `npm.packageManager` to `npm` because yarn isn't on the host.
- The minimum VS Code version is 1.82 (`engines.vscode`), which runs extensions on Node 18. Keep `@types/vscode` at the same version as the engine: newer types would allow APIs that 1.82 doesn't have, and `vsce` refuses to package that. TypeScript is 5.x with `strict` on.

## Architecture

- `src/extension.ts`: activation, user-facing messages and wiring. `startServer()` waits for the Docker daemon (up to 2 minutes on first start, then offers Retry), pulls the image once in the background, and creates a new `ServerContainer` and `LanguageClient`. The `ruby-language-server.restart` command and the status bar click both call `startServer()`.
- `src/serverContainer.ts`: `ServerContainer` runs one server container and returns its stdin/stdout to the client. `start()` is called again after every connection close and replaces the previous container; `dispose()` kills it and runs `docker rm -f`. Everything it needs from Docker, the OS, the clock and timers comes through a `ContainerDeps` object (real by default). The unit tests drive it with a scripted fake Docker (`test/unit/serverContainer.test.ts`), so keep new Docker or process calls going through `ContainerDeps`. The pure parts (`dockerArgs`, `staleContainerIds`, `CrashBudget`, naming) are exported functions.
- `src/serverVersion.ts`: decides what to log and warn about the server version from the `initialize` result's `serverInfo` (`MIN_SERVER_VERSION`). Raise `MIN_SERVER_VERSION` when the extension starts depending on newer server behavior. A server that reports no version only gets a log line, because servers before ruby_language_server#168 never report one.
- `src/statusBar.ts`: the status bar item (Waiting for Docker / Starting / Running / Stopped). `track()` is called again for each new client.
- `src/docker.ts`: plain Docker CLI helpers (`daemonIsUp`, `waitForDaemon`, `refreshImage`, `removeContainer`). No VS Code UI here.

Restart and retry design, shaped by `vscode-languageclient` 6:

- The error handler's `closed()` is synchronous, so it can't check the daemon. It always returns `Restart`, and `ServerContainer.start()` does the waiting: it waits as long as it takes for the daemon and retries failed launches. It rejects only after 5 crashes in 3 minutes while the daemon was up. Failures while Docker is down don't count.
- If a client's `start()` rejects, that client can never start again (it keeps the rejected connection). So Restart creates a new `LanguageClient` rather than reusing one. A `ServerContainer` disposed mid-start never settles its promise, so the discarded client doesn't show a spurious error.
- Containers are named `ruby-language-server-<root hash>-<pid>` and labeled with both values. Before each start, containers for the same project root are removed if their pid label is this process or a dead one. Containers belonging to other live windows are left alone.

Transport: stdio. The container runs with `docker run -i` (never `-t`: a TTY rewrites line endings and corrupts the stream), and the client talks LSP over its stdin/stdout. Don't move this to TCP to fix garbled messages. LSP framing (`Content-Length` + JSON body) is the same over both, and the known cause of garbled messages is a server bug that breaks both: `Content-Length` counted characters, not bytes (ruby_language_server#167). Two rules follow from stdio:

- The container runs with least privilege (`dockerArgs`): `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit` and `--memory` limits, and the project mounted read-only with `--mount` (see `mountSpec`). Don't loosen these, or switch to `-v`, without a reason: the extension follows the image's `latest` tag, and these bound what a bad image could do. `-v` also breaks on paths containing `:`. `--read-only` for the container's own filesystem waits for ruby_language_server#169, since the server currently writes its database at `/`.
- Nothing but the language client may read the container's stdout or write its stdin. `ServerContainer` only listens to stderr.
- `start()` hands the streams to the client only once Docker reports the container running (`containerIsRunning`). The client sends `initialize` at once, and if the server dies during `initialize`, vscode-languageclient 6 gives up instead of restarting. Failures before that point (daemon down, image can't be pulled) are retried inside `start()`.

The server logs to stderr; those logs show up in the "Ruby Language Server" output channel.

## Security checks

- `package.json` declares support for untrusted workspaces (Restricted Mode). That relies on every setting being `user` or `machine` scoped, so a workspace can't choose the image or how it runs. `test/unit/manifest.test.ts` enforces both. If the server ever starts running project code (for example, RuboCop with the project's config), revisit the declaration.
- CI's "Build and test" job runs `scripts/audit.js`, which fails on high or critical advisories in the runtime dependencies (the ones inlined into the bundle). It reads `yarn audit --json`, because yarn's exit code doesn't follow `--level` reliably. Development-only advisories don't fail the build.
- CodeQL (`.github/workflows/codeql.yml`) scans `src/`, `scripts/` and `test/` on PRs, on pushes to `develop` and `master`, and weekly.

## Testing

`npm test` (or `make test` in Docker) compiles with `tsc` and runs the Mocha unit tests in `test/unit/` in plain Node. `.mocharc.json` loads `test/support/register.ts` first, which makes `require('vscode')` return the stub in `test/support/vscode.ts`. The stub fakes only what the code uses; when code under test needs more of the VS Code API, add it there. Its fakes record what was done to them (`window.statusBarItems`, `window.messages`, `commands.registered`), and `resetStub()` clears them between tests.

- Write tests in TypeScript under `test/unit/`, named `*.test.ts`, using Mocha's `describe`/`it` and Node's `assert`.
- Keep unit tests free of Docker and the network. Logic that talks to Docker should take its command runner as a parameter, so tests can pass a fake.
- Integration tests (`test/integration/`, `npm run test:integration`, needs Docker) run the real `ServerContainer` against real Docker and the server image, with a byte-accurate LSP client (`test/integration/lsp.ts`) and the fixture project in `test/fixtures/project/`. `RLS_TEST_IMAGE` picks another image, such as a local build of the server. CI runs them on PRs, on pushes, and daily against `latest` (`.github/workflows/integration.yml`). Tests that need a newer server check the image's version and skip with a message on older ones.
- The server only returns symbols for a file after `textDocument/didOpen`, as VS Code sends. Tests must open a file before asking about it.
- Some changes still need checking in VS Code: run them with F5 against a Ruby project.
