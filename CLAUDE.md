# CLAUDE.md

VS Code client for [ruby_language_server](https://github.com/kwerle/ruby_language_server). The extension doesn't contain a language server: it runs the server's Docker image (`kwerle/ruby_language_server` by default) and talks LSP to it.

## Branches

Git-flow:

- **`develop`**: new work is forked from `develop` on its own branch (e.g. `feature/<name>`), then merged back into `develop` by PR when it's done. Don't commit directly to `develop`.
- **`master`**: released code only. It changes when we ship: a release is merged into `master` and tagged (e.g. `0.1.2`), then merged back into `develop`.
- Dependabot PRs target `master`. After merging them, bring `develop` up to date with `master`.

## Build and run

The supported environment is Docker (see the Makefile): `make image` installs dependencies and compiles, `make package` builds the `.vsix`, and `make shell` opens a shell in the build image. `yarn` isn't expected to be installed on the host.

Host-side, for debugging in VS Code:

- `npm run compile` builds once into `out/`. `npm run watch` rebuilds on change.
- F5 ("Launch Client") runs the `npm: watch` task and opens an Extension Development Host. `.vscode/settings.json` sets `npm.packageManager` to `npm` because yarn isn't on the host.
- The project pins TypeScript 3.9 (`node_modules/.bin/tsc`). VS Code's built-in TypeScript is newer and may check files with strict settings, so keep code valid under both (e.g. no type annotations on `catch` variables, which 3.9 doesn't support; cast instead).

## Architecture

- `src/extension.ts`: activation and wiring only. Reads settings, creates the output channel, status bar item, `ServerContainer` and `LanguageClient`.
- `src/serverContainer.ts`: `ServerContainer` runs one server container and returns a TCP socket to the client. `start()` is called again on each client restart and replaces the previous container; `dispose()` kills it and runs `docker rm -f`.
- `src/docker.ts`: Docker CLI helpers (`pullImage`, `waitForDocker`, `removeContainer`).

Transport: the container gets `LSP_PORT=2087` (server v0.9.0+) and is published on `127.0.0.1:<free host port>`. Two server/Docker behaviours shape the connection code. Don't "simplify" them away:

- The server calls `accept` **once**. A readiness probe that connects and disconnects uses up that accept and kills the server.
- Docker's port proxy accepts host connections before the server listens, then drops them. So the client keeps the first connection that stays open for `SETTLE_MS` and hands that same socket to the `LanguageClient`.

The server logs to stderr; those logs show up in the "Ruby Language Server" output channel.

## Testing

There's no working automated test suite. `yarn test` and `test/index.ts` depend on the deprecated `vscode` package, which isn't installed. To check a change, run it with F5 against a Ruby project, or load the compiled `out/src/serverContainer.js` from Node with a stub `vscode` module and run it against the real image.
