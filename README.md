# vscode_ruby_language_server

[vscode_ruby_language_server](https://github.com/kwerle/vscode_ruby_language_server) is a plugin for Visual Studio Code to run the language server https://github.com/kwerle/ruby_language_server .

## Functionality

* Module/Class outlines
* Basic function lookup/jumping
* Basic variable lookup/jumping
* Rubocop linting (when it works)

## Requirements

VS Code 1.82 or later.

You must have [docker](https://hub.docker.com/search/?type=edition&offering=community) installed (and running).  I hear you asking why.  Because I don't install a development environment any more - just docker.  And it takes care of all the requirements, consistency, etc.  No platform issues.  No library issues (other than what is brought with).  For example this requires sqlite with a plugin installed.  Who does that?  Docker.

## Status

I use this every day.  If Docker isn't running yet, the extension waits for it, and it brings the server back if Docker restarts.  The status bar shows the server's state; click it (or run **Ruby Language Server: Restart**) to restart the server.

## Server versions

The extension runs the server image's `latest` tag, so server fixes reach you without an extension update. The server stays backward compatible with the protocol this extension uses; a breaking change would come with a new major version and advance notice.

The **Ruby Language Server** output shows which server version is running. If your local image is older than this extension needs (for example, when it couldn't be updated while offline), you'll see a warning: run `docker pull kwerle/ruby_language_server`, then **Ruby Language Server: Restart**.

## Credit

This plugin started as a copy of https://github.com/mtsmfm/vscode-ruby-lsc .  Thanks to Fumiaki MATSUSHIMA for the work.  He deserves none of the blame.

## Releasing

Releases are published by the Release workflow ([release.yml](.github/workflows/release.yml)) when a version tag is pushed on `master`.

1. On a release branch from `develop`, bump `version` in [package.json](package.json) and rename `#### Unreleased` in [CHANGELOG.md](CHANGELOG.md) to `#### <version> <date>`.
2. Check they agree: `npm run release:check -- <version>`.
3. Merge into `master` by PR, then merge `master` back into `develop`.
4. Tag the merge commit on `master` with the bare version (`0.2.0`, no `v`) and push the tag: `git tag 0.2.0 origin/master && git push origin 0.2.0`.

The workflow checks the tag against `package.json` and the CHANGELOG, checks the commit is on `master`, runs the CI build and the integration and end-to-end tests, publishes the `.vsix` CI built to the [Marketplace](https://marketplace.visualstudio.com/manage), and creates a GitHub release with the `.vsix` attached. If a check fails, nothing is published: fix it, delete the tag (`git push origin :refs/tags/<version>`), and tag again.

One-time setup: the Marketplace token is the `VSCE_PAT` secret in the `release` environment, which only release tags can use. It's an Azure DevOps personal access token with the Marketplace › Manage scope for all accessible organizations, and it expires (a year at most), so renew it before then.

## License

[MIT](https://opensource.org/licenses/MIT)
