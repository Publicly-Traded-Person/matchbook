#!/bin/sh
# launchd entrypoint for Matchbook. launchd has no EnvironmentFile=, so this
# wrapper sources the gitignored .env itself and secrets never enter the plist.
set -eu

HOME_DIR="${MATCHBOOK_HOME:-$HOME/matchbook}"
BUN_BIN="${MATCHBOOK_BUN:-/opt/homebrew/bin/bun}"

if [ -f "$HOME_DIR/.env" ]; then
  set -a
  . "$HOME_DIR/.env"
  set +a
fi

# No token is a setup state, not a crash. Exit 0 so KeepAlive (SuccessfulExit
# false) does not restart-loop a bot that cannot log in.
if [ -z "${DISCORD_TOKEN:-}" ]; then
  echo "matchbook: DISCORD_TOKEN not set in $HOME_DIR/.env; not starting" >&2
  exit 0
fi

export MATCHBOOK_CONFIG="$HOME_DIR/config.toml"
export MATCHBOOK_DB="$HOME_DIR/data/matchbook.db"
cd "$HOME_DIR"
exec "$BUN_BIN" run src/main.ts
