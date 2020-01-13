# I find it handy to have a makefile to run common commands

IMAGE_NAME=vscode_ruby_language_server

image: build
	# docker-compose run app bash -c 'npm install vscode && npm install -g typescript && yarn install'
	docker-compose run app bash -c 'npm install @types/vscode && npm install -g typescript && yarn install'
	# docker build -t $(IMAGE_NAME) .

build:
	docker-compose build

clean:
	rm -rf out/* node_modules/* package-lock.json

shell: image
	docker run --rm -it -v $(PWD):/tmp/src -w /tmp/src $(IMAGE_NAME) bash
