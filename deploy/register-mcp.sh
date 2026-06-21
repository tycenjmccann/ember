#!/usr/bin/env bash
#
# register-mcp.sh — build the port-session MCP server and wire it into your
# local Claude Code, with EMBER_URL pre-filled from this deployment.
#
# Today this is a manual two-step (npm run mcp:build, then hand-edit
# ~/.claude.json and paste your App Runner URL). This does both:
#
#   ./deploy/register-mcp.sh            # build + print the ready-to-paste block
#   ./deploy/register-mcp.sh --write    # build + merge into ~/.claude.json (backup first)
#
# EMBER_URL is read from DEPLOYMENT_URL in .env.local (written by the App Runner
# deploy). Override by exporting EMBER_URL before running.
#
# Idempotent: re-running --write updates the existing server in place.
#
# The server name MUST be "port-session" (the default): the MCP's own code
# hard-codes that token in the slash-command prefix it prints for follow-up
# steps (/mcp__port-session__pull / sync-config) AND in the sync-config
# self-exclusion. Renaming it here would make those printed commands dangle and
# would no longer exclude the handoff server from a config sync. Override via
# MCP_SERVER_NAME only if you also update src/index.ts + src/config.ts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
WRITE=0
SERVER_NAME="${MCP_SERVER_NAME:-port-session}"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"

for arg in "$@"; do
  case "$arg" in
    --write) WRITE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# EMBER_URL: explicit env wins, else DEPLOYMENT_URL from .env.local.
if [ -z "${EMBER_URL:-}" ] && [ -f "$ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env.local"; set +a
  EMBER_URL="${DEPLOYMENT_URL:-}"
fi
if [ -z "${EMBER_URL:-}" ]; then
  echo "WARNING: EMBER_URL not found (.env.local has no DEPLOYMENT_URL)." >&2
  echo "         Deploy the web tier first, or export EMBER_URL=<your-url>." >&2
fi

DIST="$ROOT/mcp/port-session/dist/index.js"

echo "─── Build port-session MCP ───────────────────────────────"
( cd "$ROOT/mcp/port-session" && npm install --silent && npm run --silent build )
[ -f "$DIST" ] || { echo "ERROR: build did not produce $DIST" >&2; exit 1; }
echo "  built → $DIST"

# The config block, rendered with this machine's absolute path + the URL.
read -r -d '' BLOCK <<JSON || true
{
  "mcpServers": {
    "${SERVER_NAME}": {
      "type": "stdio",
      "command": "node",
      "args": ["${DIST}"],
      "env": { "EMBER_URL": "${EMBER_URL:-https://<your-app-runner-url>}" }
    }
  }
}
JSON

if [ "$WRITE" -eq 0 ]; then
  echo ""
  echo "─── Add this to $CLAUDE_JSON (merge into mcpServers) ─────"
  echo "$BLOCK"
  echo ""
  echo "Then reconnect in Claude Code with  /mcp  (or restart it)."
  echo "Re-run with --write to merge it in automatically."
  exit 0
fi

# --write must NOT register a placeholder URL: the MCP server would treat itself
# as configured and every port/pull/login would hit https://<your-app-runner-url>,
# leaving a broken server the user has to find and edit by hand. Fail fast and
# tell them how to supply a real one. (Print mode above still shows a placeholder.)
if [ -z "${EMBER_URL:-}" ]; then
  echo "ERROR: --write needs a real EMBER_URL. Deploy the web tier first (so" >&2
  echo "       .env.local has DEPLOYMENT_URL), or export EMBER_URL=<your-url>." >&2
  echo "       Run without --write to print the config block instead." >&2
  exit 1
fi

# --write: merge into ~/.claude.json with a one-time backup. python3 (a deploy
# dependency) does the JSON surgery so we never clobber other mcpServers.
python3 - "$CLAUDE_JSON" "$SERVER_NAME" "$DIST" "${EMBER_URL:-}" <<'PY'
import json, os, stat, sys

path, name, dist, url = sys.argv[1:5]
data = {}
# ~/.claude.json holds MCP env secrets and is typically 0600. Preserve that mode
# on the backup AND the temp file we replace it with, so `--write` never widens
# the permissions (Python's default open() would create 0644 under umask 022).
mode = None
if os.path.exists(path):
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        print(f"ERROR: {path} exists but isn't valid JSON — not touching it.", file=sys.stderr)
        sys.exit(1)
    bak = path + ".bak-ember-mcp"
    if not os.path.exists(bak):
        fd = os.open(bak, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode or 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  backed up → {bak}")

servers = data.setdefault("mcpServers", {})
servers[name] = {
    "type": "stdio",
    "command": "node",
    "args": [dist],
    "env": {"EMBER_URL": url or "https://<your-app-runner-url>"},
}

tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode or 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
if mode is not None:
    os.chmod(tmp, mode)  # O_CREAT mode is umask-masked; force it exactly
os.replace(tmp, path)
print(f"  wrote '{name}' MCP server → {path}")
PY

echo ""
echo "OK — reconnect in Claude Code with  /mcp  (or restart it) to load it."
echo "First step in the cloud:  /mcp__${SERVER_NAME}__sync-config claude"
