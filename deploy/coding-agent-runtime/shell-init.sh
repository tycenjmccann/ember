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
# The /shell route (prepare step) materializes a subscription token when the
# session's auth mode is "subscription". Phase 4 writes it to a tmpfs dir
# (EMBER_EPHEMERAL_CREDS_DIR, default /dev/shm/ember-creds) so the secret never
# lands on the shared EFS; we still read the legacy $CLAUDE_CONFIG_DIR path for a
# VM materialized before the change. If present, use the user's plan; else Bedrock.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$WORKSPACE_ROOT/.claude-data}"
_EPHEMERAL_CREDS_DIR="${EMBER_EPHEMERAL_CREDS_DIR:-/dev/shm/ember-creds}"
_SUB_TOKEN_FILE=""
if [ -f "$_EPHEMERAL_CREDS_DIR/.sub-token" ]; then
  _SUB_TOKEN_FILE="$_EPHEMERAL_CREDS_DIR/.sub-token"
elif [ -f "$CLAUDE_CONFIG_DIR/.sub-token" ]; then
  _SUB_TOKEN_FILE="$CLAUDE_CONFIG_DIR/.sub-token"
fi
if [ -n "$_SUB_TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$_SUB_TOKEN_FILE")"
  unset CLAUDE_CODE_USE_BEDROCK ANTHROPIC_MODEL
  _CLAUDE_AUTH="your Claude plan"
else
  export CLAUDE_CODE_USE_BEDROCK=1
  export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-us.anthropic.claude-opus-4-6-v1}}"
  _CLAUDE_AUTH="Bedrock"
fi
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# Pre-answer Claude Code's first-run prompts (theme picker / trust dialog) so a
# Terminal session never blocks on a TUI menu that's unanswerable on a mobile
# soft-keyboard. The server's _seed_claude_first_run() does the same on the
# /invocations path, but a DEFAULT Bedrock session opened straight in Terminal
# never hits /invocations first — so we seed here too (idempotent, merge-safe).
if [ ! -f "$CLAUDE_CONFIG_DIR/.first-run-seeded" ]; then
  EMBER_CLAUDE_THEME="${EMBER_CLAUDE_THEME:-dark}" \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" python3 - <<'PY' 2>/dev/null && \
    touch "$CLAUDE_CONFIG_DIR/.first-run-seeded" 2>/dev/null || true
import json, os
d = os.environ["CLAUDE_CONFIG_DIR"]; p = os.path.join(d, ".claude.json")
try:
    doc = json.load(open(p))
    if not isinstance(doc, dict): doc = {}
except Exception:
    doc = {}
doc.setdefault("theme", os.environ.get("EMBER_CLAUDE_THEME", "dark"))
doc["hasCompletedOnboarding"] = True
doc["bypassPermissionsModeAccepted"] = True
json.dump(doc, open(p, "w"), indent=2)
PY
fi

# ── Codex → Bedrock Mantle (default) OR the user's ChatGPT plan ──
export BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"
# The chat path isolates each Ember session under its own CODEX_HOME
# (_codex_home_for) so resumed rollouts can't collide; the PTY otherwise only
# sees the deploy-default and would resume from a different — shared — rollout
# tree than the headless turn wrote. The resume hint carries this session's
# per-session home as EMBER_CODEX_HOME; prefer it so `codex resume` in the
# Terminal continues the same conversation the chat created.
_resume_hint="/tmp/.resume-launch.sh"
if [ -f "$_resume_hint" ]; then
  # shellcheck disable=SC1090
  . "$_resume_hint"
  [ -n "${EMBER_CODEX_HOME:-}" ] && CODEX_HOME="$EMBER_CODEX_HOME"
fi
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

# ── Kiro → the user's access key (no Bedrock; bring-your-own-key only) ──
# The prepare step materializes the access key to the tmpfs creds dir when the
# session is kiro. KIRO_HOME points at the per-session SQLite store. Secret never
# lands on the shared EFS.
# The chat path isolates each Ember session under its own KIRO_HOME
# (_kiro_home_for); the PTY otherwise only sees the deploy-default and would read
# a different — shared, cross-session — DB. The resume hint carries this session's
# per-session home as EMBER_KIRO_HOME; prefer it so the Terminal reads the same
# conversation store the headless turn wrote. (The hint lives in container-local
# /tmp, one microVM per session, so it can't leak across sessions.)
_resume_hint="/tmp/.resume-launch.sh"
if [ -f "$_resume_hint" ]; then
  # shellcheck disable=SC1090
  . "$_resume_hint"
  [ -n "${EMBER_KIRO_HOME:-}" ] && KIRO_HOME="$EMBER_KIRO_HOME"
fi
export KIRO_HOME="${KIRO_HOME:-$WORKSPACE_ROOT/.kiro-data}"
# Kiro's SQLite session store follows $XDG_DATA_HOME/kiro-cli/, not $KIRO_HOME —
# pin XDG_DATA_HOME so a resumed PTY reads the same DB the chat path wrote.
export XDG_DATA_HOME="$KIRO_HOME"
mkdir -p "$KIRO_HOME" 2>/dev/null || true
if [ -f "$_EPHEMERAL_CREDS_DIR/.kiro-api-key" ]; then
  export KIRO_API_KEY="$(cat "$_EPHEMERAL_CREDS_DIR/.kiro-api-key")"
  _KIRO_AUTH="your access key"
fi

# ── GitHub CLI / git → authenticated via the PAT (no `gh auth login`) ──
if [ -n "${GITHUB_PAT:-}" ]; then
  export GH_TOKEN="$GITHUB_PAT"
  export GITHUB_TOKEN="$GITHUB_PAT"
  git config --global "url.https://x-access-token:${GITHUB_PAT}@github.com/.insteadOf" "https://github.com/" 2>/dev/null || true
  git config --global --add safe.directory '*' 2>/dev/null || true
fi

if [ -t 1 ]; then
  _kiro_status="${_KIRO_AUTH:+ · 'kiro' (${_KIRO_AUTH})}"
  echo "Coding agents ready: 'claude' (${_CLAUDE_AUTH:-Bedrock}) · 'codex' (${_CODEX_AUTH:-GPT-5.5 via Mantle})${_kiro_status} · 'gh' (authed). No login needed."
  echo "Workspace: $WORKSPACE_ROOT   (run 'codextoken' if codex auth expires)"
fi

# ── Ported session: auto-resume the conversation in the Terminal ──
# The server writes .resume-launch.sh (EMBER_RESUME_DIR + EMBER_RESUME_SID) when
# a session has a Claude conversation to continue. Launch it HERE — once per
# fresh interactive shell; the run-once guard at the top means a PTY reattach to
# an already-running `claude` never reaches this line. So the browser no longer
# types the resume command into a live TUI input box. `exec` replaces the shell
# with claude, so exiting the agent ends the PTY cleanly like a normal session.
# Container-local (/tmp), NOT on EFS — EFS is shared across sessions, so a hint
# there would resume the wrong conversation. One microVM per session means /tmp
# is private to this session. Must match RESUME_HINT_PATH in main.py.
_resume_hint="/tmp/.resume-launch.sh"
if [ -t 1 ] && [ -t 0 ] && [ -f "$_resume_hint" ]; then
  # shellcheck disable=SC1090
  . "$_resume_hint"
  if [ -n "${EMBER_RESUME_SID:-}" ]; then
    cd "${EMBER_RESUME_DIR:-$WORKSPACE_ROOT}" 2>/dev/null || cd "$WORKSPACE_ROOT"
    case "${EMBER_RESUME_CLI:-claude}" in
      kiro) exec kiro-cli chat --resume-id "$EMBER_RESUME_SID" ;;
      codex) exec codex resume "$EMBER_RESUME_SID" ;;
      *) exec claude --resume "$EMBER_RESUME_SID" ;;
    esac
  fi
fi
