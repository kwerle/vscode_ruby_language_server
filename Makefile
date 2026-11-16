# Common commands, run in the build image (see Dockerfile and docker-compose.yml).
# The project directory is mounted at /app, so node_modules, out/ and dist/ are
# shared with the host.

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

# Update dependencies within their ranges in package.json (and package-lock.json).
npm_update: image
	docker compose run --rm app npm update

.PHONY: build clean image package shell test npm_update
