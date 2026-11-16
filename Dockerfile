# The build image: Node and npm. Pinned to an LTS release so builds are
# reproducible; Dependabot proposes minor updates within it.
FROM node:24 AS build

# The test image adds what the integration and end-to-end tests need beyond
# Node: the Docker CLI (they start real server containers, through the host's
# Docker socket), and Xvfb plus the libraries VS Code (Electron) needs to run
# without a screen. See the `test` service in docker-compose.yml.
FROM build AS test

COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xauth \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libdrm2 libgbm1 libgtk-3-0 \
    libnss3 libsecret-1-0 libxkbfile1 libxss1 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*
