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

## Release instructions for myself

From https://code.visualstudio.com/api/working-with-extensions/publishing-extension

* Bump version in [package.json](package.json)
* Update [changelog](CHANGELOG.md)
* merge to master
* `make shell`
* `make package`
Then
* `yarn vsce publish -p <code>`
Or more likely
* https://marketplace.visualstudio.com/manage and upload

## License

[MIT](https://opensource.org/licenses/MIT)
