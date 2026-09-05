#!/usr/bin/env bash
# Twin-Brain — start the local backend (and create the venv on first run).
set -euo pipefail
cd "$(dirname "$0")"

PY="./.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "creating .venv and installing requirements (first run only)..."
  python3 -m venv .venv
  "./.venv/bin/pip" install --upgrade pip >/dev/null
  "./.venv/bin/pip" install -r requirements.txt
fi

exec "$PY" -m server.app "$@"
