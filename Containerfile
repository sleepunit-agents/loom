FROM docker.io/library/node:24-trixie@sha256:6e5d4c38403930b420404f190be8563396dca2bd156a6cb4722707b0efcf6fc1

# CI uses age and Chromium as well as the program's native Node dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends age chromium python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /opt/loom /var/lib/loom

ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    LOOM_TEST_CHROME=/usr/bin/chromium \
    LOOM_HOME=/var/lib/loom/household \
    LOOM_HTTP_HOST=0.0.0.0
WORKDIR /opt/loom
USER node
COPY --chown=node:node . .
RUN npm ci --no-audit --no-fund && npm --prefix web ci --no-audit --no-fund \
    && npm --prefix web run build && npm cache clean --force

EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
CMD ["node","dist/index.js","serve"]
