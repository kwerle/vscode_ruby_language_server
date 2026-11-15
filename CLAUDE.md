# CLAUDE.md

VS Code client for [ruby_language_server](https://github.com/kwerle/ruby_language_server). The extension doesn't contain a language server: it runs the server's Docker image (`kwerle/ruby_language_server` by default) and talks LSP to it.

## Branches

Git-flow:

- **`develop`**: new work is forked from `develop` on its own branch (e.g. `feature/<name>`), then merged back into `develop` by PR when it's done. Don't commit directly to `develop`.
- **`master`**: released code only. It changes when we ship: a release is merged into `master` and tagged (e.g. `0.1.2`), then merged back into `develop`.
- Dependabot PRs target `master`. After merging them, bring `develop` up to date with `master`.

## Build and run

The supported environment is Docker (see the Makefile): `make image` installs dependencies and compiles, `make package` builds the `.vsix`, and `make shell` opens a shell in the build image. `yarn` isn't expected to be installed on the host.

What ships is a single bundle, `dist/extension.js`, built by `scripts/bundle.js` (esbuild) with the runtime dependencies inlined. `.vscodeignore` excludes everything except the bundle, README, CHANGELOG and LICENSE, so new files stay out of the `.vsix` unless they're added there. `vscode:prepublish` type-checks and builds the minified production bundle. The bundler is `esbuild-wasm`, not `esbuild`, because `node_modules` is shared between the Linux build image and the host, and esbuild's native binary only works on the platform that installed it. Don't add dependencies with platform-specific binaries.

Host-side, for debugging in VS Code:

- `npm run compile` type-checks, compiles to `out/` (used by tests), and builds the development bundle with a source map. `npm run watch` rebuilds the bundle on change; reload the test window to pick it up.
- F5 ("Launch Client") runs the `npm: compile` task and opens an Extension Development Host. `.vscode/settings.json` sets `npm.packageManager` to `npm` because yarn isn't on the host.
- The project pins TypeScript 3.9 (`node_modules/.bin/tsc`). VS Code's built-in TypeScript is newer and may check files with strict settings, so keep code valid under both (e.g. no type annotations on `catch` variables, which 3.9 doesn't support; cast instead).

## Architecture

- `src/extension.ts`: activation, user-facing messages and wiring. `startServer()` waits for the Docker daemon (up to 2 minutes on first start, then offers Retry), pulls the image once in the background, and creates a new `ServerContainer` and `LanguageClient`. The `ruby-language-server.restart` command and the status bar click both call `startServer()`.
- `src/serverContainer.ts`: `ServerContainer` runs one server container and returns a TCP socket to the client. `start()` is called again after every connection close and replaces the previous container; `dispose()` kills it and runs `docker rm -f`.
- `src/statusBar.ts`: the status bar item (Waiting for Docker / Starting / Running / Stopped). `track()` is called again for each new client.
- `src/docker.ts`: plain Docker CLI helpers (`daemonIsUp`, `waitForDaemon`, `refreshImage`, `removeContainer`). No VS Code UI here.

Restart and retry design, shaped by `vscode-languageclient` 6:

- The error handler's `closed()` is synchronous, so it can't check the daemon. It always returns `Restart`, and `ServerContainer.start()` does the waiting: it waits as long as it takes for the daemon and retries failed launches. It rejects only after 5 crashes in 3 minutes while the daemon was up. Failures while Docker is down don't count.
- If a client's `start()` rejects, that client can never start again (it keeps the rejected connection). So Restart creates a new `LanguageClient` rather than reusing one. A `ServerContainer` disposed mid-start never settles its promise, so the discarded client doesn't show a spurious error.
- Containers are named `ruby-language-server-<root hash>-<pid>` and labeled with both values. Before each start, containers for the same project root are removed if their pid label is this process or a dead one. Containers belonging to other live windows are left alone.

Transport: the container gets `LSP_PORT=2087` (server v0.9.0+) and is published on `127.0.0.1:<free host port>`. Two server/Docker behaviours shape the connection code. Don't "simplify" them away:

- The server calls `accept` **once**. A readiness probe that connects and disconnects uses up that accept and kills the server.
- Docker's port proxy accepts host connections before the server listens, then drops them. So the client keeps the first connection that stays open for `SETTLE_MS` and hands that same socket to the `LanguageClient`.

The server logs to stderr; those logs show up in the "Ruby Language Server" output channel.

## Testing

There's no working automated test suite. `yarn test` and `test/index.ts` depend on the deprecated `vscode` package, which isn't installed. To check a change, run it with F5 against a Ruby project, or load the compiled `out/src/serverContainer.js` from Node with a stub `vscode` module and run it against the real image.
