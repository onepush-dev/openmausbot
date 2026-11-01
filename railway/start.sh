#!/usr/bin/env bash
# OpenMausBot on Railway: runs the three processes upstream's compose stack runs
# (server, Caddy edge) plus the pairing gate, all as the unprivileged `maus` user.
# If any of them exits, the container exits and Railway restarts it (restart ALWAYS).
set -euo pipefail

export HOME=/data
export PORT="${PORT:-8080}"
# A fresh Railway volume is root's: hand it to maus once.
mkdir -p /data
if [ "$(stat -c %U /data)" != "maus" ]; then
  echo "[railway] handing /data to maus"
  chown -R maus:maus /data
fi

# Public address for pairing links and webhook URLs.
if [ -z "${OMB_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export OMB_PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
fi
if [ -z "${OMB_WEBHOOK_PUBLIC_URL:-}" ] && [ -n "${OMB_PUBLIC_URL:-}" ]; then
  export OMB_WEBHOOK_PUBLIC_URL="$OMB_PUBLIC_URL"
fi

as_maus() { setpriv --reuid=maus --regid=maus --init-groups "$@"; }

ADMIN_PASSWORD="${OMB_ADMIN_PASSWORD:-}"
unset OMB_ADMIN_PASSWORD   # never in the server's (and so the bots') environment

cd /app
echo "[railway] starting OpenMausBot on 127.0.0.1:${OMB_PORT:-8799} (public: ${OMB_PUBLIC_URL:-unset})"
as_maus node dist-server/server-launcher.js &
OMB_PID=$!

OMB_ADMIN_PASSWORD="$ADMIN_PASSWORD" as_maus node /etc/omb-railway/pair-gate.mjs &
GATE_PID=$!

# Wait for the server before opening the edge, like compose's depends_on: service_healthy.
for i in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${OMB_PORT:-8799}/api/health" | grep -q openmausbot; then break; fi
  if ! kill -0 "$OMB_PID" 2>/dev/null; then echo "[railway] server exited during start" >&2; exit 1; fi
  sleep 1
done

echo "[railway] Caddy edge on :${PORT}"
as_maus env XDG_DATA_HOME=/data/.caddy/data XDG_CONFIG_HOME=/data/.caddy/config \
  caddy run --config /etc/omb-railway/Caddyfile --adapter caddyfile &
CADDY_PID=$!

if [ -n "$ADMIN_PASSWORD" ] && [ -n "${OMB_PUBLIC_URL:-}" ]; then
  echo "[railway] pair a browser: open ${OMB_PUBLIC_URL}/_railway/pair (user ${OMB_ADMIN_USER:-admin}, password = OMB_ADMIN_PASSWORD)"
fi

trap 'kill -TERM $OMB_PID $GATE_PID $CADDY_PID 2>/dev/null || true' TERM INT
set +e
wait -n "$OMB_PID" "$GATE_PID" "$CADDY_PID"
code=$?
echo "[railway] a process exited (code $code); stopping so Railway restarts the service" >&2
kill -TERM "$OMB_PID" "$GATE_PID" "$CADDY_PID" 2>/dev/null
wait
exit "$code"
