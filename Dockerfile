# OpenMausBot on Railway: the official server image (built by upstream CI from
# milind-soni/OpenMausBot's Dockerfile, tag v0.1.136) plus what upstream's
# compose.yaml adds next to it, folded into one container because Railway
# services cannot share a network namespace:
#   - Caddy in front (the compose `caddy` service), on Railway's PORT;
#   - the Claude Code and Codex CLIs (the compose ENGINES build arg);
#   - tini as PID 1 (compose `init: true`) to reap the bots' browser processes;
#   - a tiny password-protected pairing gate, so the first browser can pair
#     without a terminal.
# The server keeps binding 127.0.0.1:8799 / :8800 only; nothing reaches them
# except through Caddy, which forwards headers so every request is "remote"
# and needs a paired session (upstream's loopback-trust model).
FROM caddy:2.10.2 AS edge
RUN cp /usr/bin/caddy /caddy

FROM ghcr.io/milind-soni/openmausbot:v0.1.136@sha256:419140ae271e85a59352175b6bdbc810b1f7c3315b931c9494f732bc13835783
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ARG ENGINES="@anthropic-ai/claude-code@2.1.316 @openai/codex@0.166.0"
RUN if [ -n "$ENGINES" ]; then HOME=/tmp/omb-build-home npm install -g $ENGINES && rm -rf /tmp/omb-build-home /tmp/node-compile-cache; fi
COPY --from=edge /caddy /usr/local/bin/caddy
COPY railway/Caddyfile /etc/omb-railway/Caddyfile
COPY railway/pair-gate.mjs /etc/omb-railway/pair-gate.mjs
COPY railway/start.sh /usr/local/bin/omb-railway-start
RUN chmod 755 /usr/local/bin/omb-railway-start && chmod 644 /etc/omb-railway/* \
 && caddy validate --config /etc/omb-railway/Caddyfile --adapter caddyfile
# Plain defaults live in the image so the Railway template only carries
# generated secrets and references. Any of them can be overridden with a
# Railway service variable.
ENV HOME=/data \
    PORT=8080 \
    OMB_PORT=8799 \
    OMB_WEBHOOK_PORT=8800 \
    OMB_PAIR_GATE_PORT=8801 \
    OMB_ADMIN_USER=admin \
    OMB_DATA_DIR=/data/.openmausbot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${PORT:-8080}/api/health" | grep -q openmausbot || exit 1
# Starts as root only to hand the volume to `maus`; every process then runs as maus.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/omb-railway-start"]
