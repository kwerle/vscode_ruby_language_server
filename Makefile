# I find it handy to have a makefile to run common commands

IMAGE_NAME=vscode_ruby_language_server

DEV_MOUNTS=$(PWD):/tmp/src -w /tmp/src

build:
	docker build -t $(IMAGE_NAME) .
	docker compose build

clean:
	rm -rf out/* node_modules/* node_modules/.yarn-integrity package-lock.json *.vsix

image: build
	docker compose run app bash -c 'yarn install && tsc'

# Used to make vsix file.  Useful for installing test/development builds locally.
package: image
	docker compose run app vsce package

shell: image
	docker run --rm -it -v $(DEV_MOUNTS) $(IMAGE_NAME) bash

yarn_upgrade: image
	docker run --rm -it -v $(DEV_MOUNTS) $(IMAGE_NAME) yarn upgrade
