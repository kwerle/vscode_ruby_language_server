# Change Log

#### 0.2.0 Sun Nov 15 22:37:57 PST 2026

* Requires VS Code 1.82 or later
* Wait for Docker to start, and restart the server after Docker restarts, without reloading the window (#28)
* Add a "Ruby Language Server: Restart" command; the status bar shows the server's state and restarts it when clicked
* A failed image pull shows one warning and uses the local image
* Show the server's version in the output, and warn if the local server image is too old
* Run the server container locked down: no network, no Linux capabilities, read-only project
* Works in Restricted Mode (untrusted workspaces); not available in virtual workspaces
* Upgrade to vscode-languageclient 9

#### 0.1.2 Tue Oct 25 19:53:55 PDT 2022

* Update node files (yarn upgrade)

#### 0.1.1 Thu Feb 17 22:03:43 PST 2022

* Update node files (yarn upgrade)

#### 0.1.0 Sun Jan  3 21:04:52 PST 2021

* Cope with slow docker launch

#### 0.0.3 Wed Jan 22 22:22:35 PST 2020

* Add support for log level

#### 0.0.2 Wed Jan 15 22:09:03 PST 2020

* Add configuration support for image name and additional gems

#### 0.0.1 Mon Jan 13 23:19:27 PST 2020

* Initial functionality
