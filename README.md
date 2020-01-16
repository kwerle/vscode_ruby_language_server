# vscode_ruby_language_server

[vscode_ruby_language_server](https://github.com/kwerle/vscode_ruby_language_server) is a plugin for Visual Studio Code to run the language server https://github.com/kwerle/ruby_language_server .

## Functionality

* Module/Class outlines
* Basic function lookup/jumping
* Basic variable lookup/jumping
* Rubocop linting (when it works)

## Requirements

You must have [docker](https://hub.docker.com/search/?type=edition&offering=community) installed (and running).  I hear you asking why.  Because I don't install a development environment any more - just docker.  And it takes care of all the requirements, consistency, etc.  No platform issues.  No library issues (other than what is brought with).

## Status

The plugin is alpha software.  I will be using it every day, so it ought to work.  The language server I'd call... beta.

## Credit

This plugin started as a copy of https://github.com/mtsmfm/vscode-ruby-lsc .  Thanks to Fumiaki MATSUSHIMA for the work.  He deserves none of the blame.

## Release instructions for myself

From https://code.visualstudio.com/api/working-with-extensions/publishing-extension

* Bump version in [package.json](package.json)
* Update [changelog](CHANGELOG.md)
* merge to master
* `make shell`
* `vsce publish -p <code>`

## License

[MIT](https://opensource.org/licenses/MIT)
