#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Twin-Brain — start the local backend (creates .venv on first run).
#   server: http://127.0.0.1:8765   token: printed below + data/token.txt
# Keep this terminal open while you use Twin-Brain.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")" || exit 1

VPY="./.venv/bin/python"
BOOT=""

for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then BOOT="$cand"; break; fi
done

if [ ! -x "$VPY" ]; then
  if [ -z "$BOOT" ]; then
    echo "Twin-Brain: ERROR - no python3 interpreter found on PATH."
    echo "             Install Python 3.9+ and run ./run.sh again."
    exit 1
  fi
  echo "Twin-Brain: first run - creating .venv with $BOOT ..."
  if "$BOOT" -m venv .venv; then
    "$VPY" -m pip install --upgrade pip >/dev/null 2>&1 || true
    "$VPY" -m pip install -r requirements.txt || \
      echo "Twin-Brain: WARNING - pip install reported errors; continuing."
  else
    echo "Twin-Brain: WARNING - could not create .venv; will try system python."
    VPY="$BOOT"
  fi
fi

if ! "$VPY" -c "import flask" >/dev/null 2>&1; then
  if [ -n "$BOOT" ] && [ "$VPY" != "$BOOT" ] && "$BOOT" -c "import flask" >/dev/null 2>&1; then
    echo "Twin-Brain: venv incomplete - using system interpreter $BOOT."
    VPY="$BOOT"
  else
    echo "Twin-Brain: installing requirements (flask is the only hard requirement)..."
    "$VPY" -m pip install -r requirements.txt || {
      echo "Twin-Brain: ERROR - Flask is not installed and pip failed. Aborting."
      exit 1
    }
  fi
fi

echo "Twin-Brain: starting the backend with $VPY ..."
exec "$VPY" -m server.app "$@"
