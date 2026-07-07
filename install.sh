#!/usr/bin/env bash
# Installs claudet to ~/.agent-os/bin and seeds the duty roster.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${AGENT_OS_DIR:-$HOME/.agent-os}"

command -v tmux >/dev/null 2>&1 || echo "note: tmux not found; install it (brew install tmux / apt install tmux)"
command -v node >/dev/null 2>&1 || echo "note: node not found; the watchdog and lease helper need it"

mkdir -p "$BASE/bin" "$BASE/rings" "$BASE/seats"
cp -P "$DIR/bin/"* "$BASE/bin/"
chmod +x "$BASE/bin/"*
[[ -f "$BASE/duty-roster.md" ]] || cp "$DIR/templates/duty-roster.md" "$BASE/duty-roster.md"

cat <<EOF
Installed to $BASE

Add these to your shell profile (~/.bashrc or ~/.zshrc):

  alias claudet='bash $BASE/bin/claudet'
  alias codext='bash $BASE/bin/codext'
  alias doorbell='bash $BASE/bin/doorbell'

Then open a new terminal and run: claudet
Watchdog setup (optional): see README "The watchdog".
EOF
