#!/usr/bin/env bash
# shell-init.sh — sourced by every interactive Terminal-tab shell.
#
# Makes bare `claude` / `codex` / `gh` "just work" with no login screen: Claude
# uses Bedrock (env var); Codex uses our Bedrock Mantle provider + a freshly
# minted bearer token; gh uses GITHUB_PAT. Mirrors what the headless launchers
# set up, so the interactive terminal matches the chat experience.

# Sourced from both /etc/bash.bashrc and ~/.bashrc — run once per shell.
[ -n "$_CODING_SHELL_INIT_DONE" ] && return 0
export _CODING_SHELL_INIT_DONE=1

# The PTY shell does NOT inherit the server process's env (where AgentCore
# injects GITHUB_PAT, model ids, ARTIFACT_BUCKET). The server writes them to the
# writable workspace mount on startup so the interactive terminal sees them.
for _envf in /mnt/efs/.runtime-env.sh /mnt/workspace/.runtime-env.sh; do
  [ -f "$_envf" ] && source "$_envf" && break
done

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
# EFS-backed workspace (set by deploy.py via WORKSPACE_ROOT); /mnt/efs default.
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-/mnt/efs}"

# Claude Code installs to ~/.local/bin; a non-login Terminal shell doesn't have
# it on PATH, so `claude` reads as "command not found". Add it (and npm globals
# + /usr/local/bin where uv/uvx live).
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# Browser-automation MCP servers (puppeteer/playwright) use the system chromium
# baked into the image instead of downloading one per session.
export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/usr/bin/chromium}"
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-0}"

# ── Claude Code → Bedrock (default) OR the user's subscription ──
# The /shell route (prepare step) materializes a subscription token to
# $CLAUDE_CONFIG_DIR/.sub-token when the session's auth mode is "subscription".
# If present, use the user's Claude Pro/Max plan; otherwise Bedrock.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$WORKSPACE_ROOT/.claude-data}"
if [ -f "$CLAUDE_CONFIG_DIR/.sub-token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CLAUDE_CONFIG_DIR/.sub-token")"
  unset CLAUDE_CODE_USE_BEDROCK ANTHROPIC_MODEL
  _CLAUDE_AUTH="your Claude plan"
else
  export CLAUDE_CODE_USE_BEDROCK=1
  export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-us.anthropic.claude-opus-4-6-v1}}"
  _CLAUDE_AUTH="Bedrock"
fi
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# ── Codex → Bedrock Mantle (default) OR the user's ChatGPT plan ──
export BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"
export CODEX_HOME="${CODEX_HOME:-$WORKSPACE_ROOT/.codex}"
mkdir -p "$CODEX_HOME" 2>/dev/null || true

codextoken() {
  local t
  t="$(BEDROCK_REGION="$BEDROCK_MANTLE_REGION" python3 - <<'PY' 2>/dev/null
import os
try:
    from aws_bedrock_token_generator import provide_token
    print(provide_token(region=os.environ["BEDROCK_REGION"]), end="")
except Exception:
    print("", end="")
PY
)"
  [ -n "$t" ] && export OPENAI_API_KEY="$t"
}

# A materialized auth.json (written by the prepare step for a subscription
# session) means use the ChatGPT plan via the default OpenAI provider — strip our
# Mantle block so it can't shadow it. Otherwise wire Bedrock Mantle + token.
if [ -f "$CODEX_HOME/auth.json" ]; then
  export CODEX_MODEL="${CODEX_SUB_MODEL:-gpt-5.1-codex}"
  unset OPENAI_API_KEY OPENAI_BASE_URL
  python3 /app/merge-codex-config.py "$CODEX_HOME/config.toml" "-" "-" "-" 2>/dev/null || true
  _CODEX_AUTH="your ChatGPT plan"
else
  export CODEX_MODEL="${CODEX_MODEL:-openai.gpt-5.5}"
  python3 /app/merge-codex-config.py "$CODEX_HOME/config.toml" \
    "$CODEX_MODEL" \
    "https://bedrock-mantle.${BEDROCK_MANTLE_REGION}.api.aws/openai/v1" \
    "${BEDROCK_MANTLE_PROJECT:-default}" 2>/dev/null || true
  codextoken
  _CODEX_AUTH="GPT-5.5 via Mantle"
fi

# ── GitHub CLI / git → authenticated via the PAT (no `gh auth login`) ──
if [ -n "${GITHUB_PAT:-}" ]; then
  export GH_TOKEN="$GITHUB_PAT"
  export GITHUB_TOKEN="$GITHUB_PAT"
  git config --global "url.https://x-access-token:${GITHUB_PAT}@github.com/.insteadOf" "https://github.com/" 2>/dev/null || true
  git config --global --add safe.directory '*' 2>/dev/null || true
fi

if [ -t 1 ]; then
  echo "Coding agents ready: 'claude' (${_CLAUDE_AUTH:-Bedrock}) · 'codex' (${_CODEX_AUTH:-GPT-5.5 via Mantle}) · 'gh' (authed). No login needed."
  echo "Workspace: $WORKSPACE_ROOT   (run 'codextoken' if codex auth expires)"
fi
