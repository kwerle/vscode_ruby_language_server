# Common commands, run in the build image (see Dockerfile and docker-compose.yml).
# The project directory is mounted into the container, so node_modules, out/ and
# dist/ are shared with the host.

# The test service mounts the project at the same path as on the host.
export PROJECT_DIR := $(CURDIR)

build:
	docker compose build

clean:
	rm -rf out dist node_modules .vscode-test *.vsix

image: build
	docker compose run --rm app bash -c 'npm ci && npm run compile'

# Build the .vsix. Useful for installing test/development builds locally.
package: image
	docker compose run --rm app npm run package

shell: image
	docker compose run --rm app bash

test: image
	docker compose run --rm app npm test

# Type-check and bundle, without reinstalling. F5 runs this (see .vscode/tasks.json).
compile: build
	docker compose run --rm app npm run compile

# Rebuild the bundle on change (the "watch" task in .vscode/tasks.json).
# Stopping the compose client doesn't stop the container it started, so the
# container has a fixed name: removed when this stops, and before it starts in
# case a previous run was killed.
WATCH_CONTAINER := vscode-ruby-language-server-watch
watch: build
	@docker rm -f $(WATCH_CONTAINER) >/dev/null 2>&1 || true
	trap 'docker rm -f $(WATCH_CONTAINER) >/dev/null 2>&1' EXIT HUP INT TERM; \
	  docker compose run --rm --name $(WATCH_CONTAINER) app npm run watch

# Against real Docker and the server image (RLS_TEST_IMAGE picks another).
test_integration: image
	docker compose build test
	docker compose run --rm test npm run test:integration

# A real VS Code under Xvfb. VSCODE_TEST_VERSION picks the version (default 1.82.0).
test_e2e: image
	docker compose build test
	docker compose run --rm test xvfb-run -a npm run test:e2e

lint: image
	docker compose run --rm app npm run lint

# Any other command in the build image, e.g.
#   make run CMD="npm run release:check -- 0.2.0"
#   make run CMD="npx vsce show KurtWerle.ruby-language-server"
run: build
	docker compose run --rm app $(CMD)

# Update dependencies within their ranges in package.json (and package-lock.json).
npm_update: image
	docker compose run --rm app npm update

.PHONY: build clean compile image lint package run shell test test_e2e test_integration watch npm_update
