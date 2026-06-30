"""
Amazon Bedrock AgentCore Runtime — resumable coding agent server.

Hosts Claude Code (and Codex) behind the AgentCore `/invocations` data-plane
contract. This is the official "safe to close your laptop" pattern from
awslabs/agentcore-samples (04-coding-agents/01-claude-code-with-s3-files): the
CLI runs server-side in a per-session microVM, the workspace persists on session
storage at /mnt/workspace, and a conversation is resumed by invoking again with
the SAME runtimeSessionId.

Interaction loop (per turn):
  client → invoke_agent_runtime(runtimeSessionId, {prompt, repo?, cli?, claude_session_id?})
         → this server runs the CLI in /mnt/workspace/<repo-slug>
         → returns {response, claude_session_id, workspace, cli}
  resume → same runtimeSessionId (→ same microVM, warm /mnt/workspace)
           + pass back claude_session_id → claude --resume <id>

Two endpoints:
  - GET  /ping, /health  — AgentCore lifecycle. HealthyBusy while a CLI runs so
    the session is not reaped mid-turn; the time_of_last_update field is REQUIRED.
  - POST /invocations     — run one coding turn and return the result.

The OTel collector sidecar (otel-collector-config.yaml) forwards each CLI's
telemetry to CloudWatch (aws/spans) so every tool call is a trace.
"""

import glob
import io
import json
import os
import re
from datetime import datetime, timezone
import shlex
import shutil
import socket
import sqlite3
import subprocess
import time
import zipfile

import boto3
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from log import get_logger, redact

logger = get_logger("coding-agent-runtime")

# Workspace lives on the EFS mount (/mnt/efs) — elastic + POSIX + persists across
# cold microVMs, so repo clones + node_modules don't hit the ~1 GB sessionStorage
# cap (ENOSPC) and survive for true warm resume. deploy.py sets WORKSPACE_ROOT.
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/mnt/efs")
DEFAULT_CLI = "claude"
CLAUDE_MODEL = os.environ.get("ANTHROPIC_MODEL") or os.environ.get(
    "CLAUDE_MODEL", "us.anthropic.claude-opus-4-6-v1"
)
# A single coding turn can be long; cap so a wedged CLI can't pin the microVM.
TURN_TIMEOUT_S = int(os.environ.get("TURN_TIMEOUT_S", "1500"))

# Per-user coding-CLI config bundle (MCP servers, skills, custom agents, prefs).
# The app uploads a zip to s3://{ARTIFACT_BUCKET}/ember/t/{tenantId}/configs/
# {userId}/{version}.zip; we materialize it into the CLI config dirs on session
# start. Every artifact key is tenant-scoped (see _tenant_prefix) so a per-tenant
# runtime role can be locked to its own ember/t/<tenantId>/* subtree (Phase 3) —
# this mirrors src/lib/ember/s3keys.ts; keep the two layouts in sync.
ARTIFACT_BUCKET = os.environ.get("ARTIFACT_BUCKET", "")
# Fallback tenant for no-auth deploys + legacy callers that don't send tenant_id.
DEFAULT_TENANT_ID = "default"


def _tenant_prefix(tenant_id: str | None) -> str:
    """Per-tenant S3 root: ember/t/<tenantId>. The IAM boundary hangs off this."""
    return f"ember/t/{tenant_id or DEFAULT_TENANT_ID}"
CLAUDE_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.join(WORKSPACE_ROOT, ".codex"))
# Kiro keeps sessions in a SQLite DB under its data dir; KIRO_HOME relocates it.
KIRO_HOME = os.environ.get("KIRO_HOME", os.path.join(WORKSPACE_ROOT, ".kiro-data"))

# Skills (agentskills.io standard) and Kiro's config dir are read from FIXED
# home-relative paths the CLIs hardcode — codex from ~/.agents/skills, kiro from
# ~/.kiro/{skills,agents,prompts,steering} — which CODEX_HOME/KIRO_HOME do NOT
# relocate. $HOME is container-local (wiped on a warm-VM recycle) while config
# persists on EFS, so we stage these subtrees in EFS-backed dirs and symlink the
# fixed home paths onto them (the same trick _codex_home_for uses for auth.json).
_HOME = os.environ.get("HOME", "/home/bedrock_agentcore")
CODEX_SKILLS_DIR = os.path.join(WORKSPACE_ROOT, ".agents-skills")  # → ~/.agents/skills
KIRO_CONFIG_DIR = os.path.join(WORKSPACE_ROOT, ".kiro-config")     # → ~/.kiro/<dir>
# Marker so we only materialize a given (user, version) once per warm microVM.
_CONFIG_MARKER = os.path.join(WORKSPACE_ROOT, ".config-applied")
BEDROCK_MANTLE_REGION = os.environ.get("BEDROCK_MANTLE_REGION", "us-east-2")
CODEX_MODEL = os.environ.get("CODEX_MODEL", "openai.gpt-5.5")

# ── Subscription auth (user's own Claude Pro/Max or ChatGPT plan) ─────────────
# The alternative to Bedrock: a turn can run on the user's OWN subscription. The
# laptop uploads its credential to S3; the runtime materializes it per session:
#   Claude  → CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), Bedrock OFF
#   Codex   → ~/.codex/auth.json (from `codex login`), default OpenAI provider
# Stored at s3://{ARTIFACT_BUCKET}/ember/auth/{userId}/{cli}.json
# ({"token": "..."} for claude, the verbatim auth.json for codex). Bedrock stays
# the default; auth_mode="subscription" on the turn payload opts in.
# Subscription-mode model names (NOT Bedrock model ids).
CLAUDE_SUB_MODEL = os.environ.get("CLAUDE_SUB_MODEL", "claude-opus-4-8")
CODEX_SUB_MODEL = os.environ.get("CODEX_SUB_MODEL", "gpt-5.1-codex")
# Kiro is bring-your-own-key only (no Bedrock). Empty model → omit --model and let
# the account default win (kiro's default is its own opus-class model).
KIRO_MODEL = os.environ.get("KIRO_MODEL", "")

_CODING_PROC_NAMES = ("claude", "codex", "kiro", "kiro-cli", "node")
COLLECTOR_BIN = "/usr/bin/otelcol-contrib"
COLLECTOR_CFG = "/app/otel-collector-config.yaml"

# Claude Code scopes a conversation to the directory it ran in. On resume the
# caller passes claude_session_id but may not re-send the repo, so we persist a
# {claude_session_id → repo} map on session storage and recover the cwd from it.
SESSION_MAP = os.path.join(WORKSPACE_ROOT, ".sessions.json")


def _load_session_map() -> dict:
    try:
        with open(SESSION_MAP) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _remember_session(claude_session_id: str | None, repo: str | None) -> None:
    if not claude_session_id:
        return
    # Best-effort: a degraded/stale EFS mount can make makedirs raise
    # FileExistsError even with exist_ok=True (path exists but isn't a dir). This
    # is bookkeeping for cwd recovery on resume — never worth failing a finished
    # turn over (the turn's output is already streamed by the time we get here).
    try:
        os.makedirs(WORKSPACE_ROOT, exist_ok=True)
        m = _load_session_map()
        m[claude_session_id] = {"repo": repo}
        with open(SESSION_MAP, "w") as f:
            json.dump(m, f)
    except OSError as exc:
        logger.warning("session_map_write_failed", extra={"error": str(exc)[:200]})


# ─── Default MCP gateway ──────────────────────────────────────────────────────

# AgentCore Gateway exposing shared MCP tools (Jira, S3, SkillLoader). Wired as
# a default MCP server so every session gets these tools with zero config; a
# user-uploaded config bundle merges its own servers on top. Set DISABLE_DEFAULT_MCP=1
# to skip. Auth is currently NONE on the gateway (internal); revisit before
# multi-user/public (would add an Authorization header here).
MCP_GATEWAY_URL = os.environ.get("MCP_GATEWAY_URL", "")
MCP_GATEWAY_NAME = os.environ.get("MCP_GATEWAY_NAME", "ember_gateway")


def _apply_default_mcp() -> None:
    """Write the gateway as a default MCP server for both CLIs, without
    clobbering a user's own MCP entries.

    - Claude Code: a streamable-HTTP server in {CLAUDE_CONFIG_DIR}/.mcp.json
      under key MCP_GATEWAY_NAME (we own that key; user keys are preserved).
    - Codex: a [mcp_servers.<name>] table appended to config.toml only if absent
      (merge-codex-config already guards our provider block)."""
    if not MCP_GATEWAY_URL or os.environ.get("DISABLE_DEFAULT_MCP") == "1":
        return

    # Claude — .mcp.json (merge: keep user servers, set/overwrite only ours).
    try:
        os.makedirs(CLAUDE_CONFIG_DIR, exist_ok=True)
        mcp_path = os.path.join(CLAUDE_CONFIG_DIR, ".mcp.json")
        try:
            with open(mcp_path) as f:
                doc = json.load(f)
        except (OSError, json.JSONDecodeError):
            doc = {}
        servers = doc.get("mcpServers") or {}
        servers[MCP_GATEWAY_NAME] = {"type": "http", "url": MCP_GATEWAY_URL}
        doc["mcpServers"] = servers
        with open(mcp_path, "w") as f:
            json.dump(doc, f, indent=2)
    except OSError as exc:
        logger.warning("default_mcp_claude_failed", extra={"error": str(exc)[:200]})

    # Codex — append [mcp_servers.<name>] if not already present.
    try:
        os.makedirs(CODEX_HOME, exist_ok=True)
        toml_path = os.path.join(CODEX_HOME, "config.toml")
        existing = ""
        if os.path.exists(toml_path):
            with open(toml_path) as f:
                existing = f.read()
        if f"[mcp_servers.{MCP_GATEWAY_NAME}]" not in existing:
            block = (
                f'\n[mcp_servers.{MCP_GATEWAY_NAME}]\n'
                f'url = "{MCP_GATEWAY_URL}"\n'
            )
            with open(toml_path, "a") as f:
                f.write(block)
    except OSError as exc:
        logger.warning("default_mcp_codex_failed", extra={"error": str(exc)[:200]})

    logger.info("default_mcp_applied", extra={"gateway": MCP_GATEWAY_NAME})


def _seed_claude_first_run(workdir: str | None = None) -> None:
    """Pre-answer Claude Code's first-run interactive prompts so a fresh microVM
    never blocks on them — critical for the Terminal tab, where the TUI's
    theme picker / trust dialog would otherwise stall with no way to answer on
    mobile (no arrow keys / Enter on a soft keyboard).

    Writes the gate keys Claude checks on launch into $CLAUDE_CONFIG_DIR/.claude.json
    (global UI state, NOT settings.json):
      - hasCompletedOnboarding   → skips the welcome + theme picker
      - theme                    → the theme the picker would have asked for
      - bypassPermissionsModeAccepted → don't prompt about skip-permissions mode
    and, when the workspace dir is known, the per-project trust gate so the
    'do you trust the files in this folder?' prompt is pre-accepted.

    Merge-preserving + idempotent: we only set our keys, keep everything else.
    Best-effort — a write failure must never fail a turn."""
    theme = os.environ.get("EMBER_CLAUDE_THEME", "dark")
    try:
        os.makedirs(CLAUDE_CONFIG_DIR, exist_ok=True)
        path = os.path.join(CLAUDE_CONFIG_DIR, ".claude.json")
        try:
            with open(path) as f:
                doc = json.load(f)
        except (OSError, json.JSONDecodeError):
            doc = {}
        if not isinstance(doc, dict):
            doc = {}
        doc.setdefault("theme", theme)
        doc["hasCompletedOnboarding"] = True
        doc["bypassPermissionsModeAccepted"] = True
        if workdir:
            # Trust is keyed by the resolved cwd Claude launches in (same rule as
            # the transcript project slug). Pre-accept it for the ported workspace.
            proj = doc.get("projects")
            if not isinstance(proj, dict):
                proj = {}
            real = os.path.realpath(workdir)
            entry = proj.get(real) if isinstance(proj.get(real), dict) else {}
            entry["hasTrustDialogAccepted"] = True
            entry["hasCompletedProjectOnboarding"] = True
            proj[real] = entry
            doc["projects"] = proj
        with open(path, "w") as f:
            json.dump(doc, f, indent=2)
        logger.info("claude_first_run_seeded", extra={"theme": theme, "scoped": bool(workdir)})
    except OSError as exc:
        logger.warning("claude_first_run_seed_failed", extra={"error": str(exc)[:200]})


# ─── Per-user config bundle ───────────────────────────────────────────────────


def _link_cli_dirs() -> None:
    """Symlink the CLIs' FIXED home-relative config dirs onto the EFS-staged copies.

    Codex reads USER-scope skills from ~/.agents/skills and Kiro reads its config
    from ~/.kiro/* — paths neither CODEX_HOME nor KIRO_HOME relocates. $HOME is
    container-local (gone after a warm-VM recycle), so we keep the real bytes on
    EFS (CODEX_SKILLS_DIR / KIRO_CONFIG_DIR) and repoint the home dirs at them
    each apply (idempotent; refresh in case $HOME was recreated)."""
    links = {
        os.path.join(_HOME, ".agents", "skills"): CODEX_SKILLS_DIR,
        os.path.join(_HOME, ".kiro"): KIRO_CONFIG_DIR,
    }
    for link, target in links.items():
        try:
            os.makedirs(os.path.dirname(link), exist_ok=True)
            # Replace any prior link/dir so the home path always points at EFS.
            if os.path.islink(link):
                if os.path.realpath(link) == os.path.realpath(target):
                    continue
                os.remove(link)
            elif os.path.isdir(link):
                shutil.rmtree(link)
            elif os.path.exists(link):
                os.remove(link)
            os.symlink(target, link)
        except OSError as exc:
            logger.warning("cli_dir_link_failed", extra={"link": link, "error": str(exc)[:200]})


def _apply_config_bundle(user_id: str | None, version: str | None,
                         tenant_id: str | None = None) -> None:
    """Materialize a user's coding-CLI config bundle into the CLI config dirs.

    The bundle is a zip at
    s3://{ARTIFACT_BUCKET}/ember/t/{tenantId}/configs/{userId}/{version}.zip
    laid out as `claude/...` (→ CLAUDE_CONFIG_DIR) and `codex/...` (→ CODEX_HOME).
    Idempotent per warm microVM via a marker file. The user's files land first;
    run-codex.sh / the launchers then re-assert our Bedrock provider on top, so a
    user config can add MCP/skills/agents but never break model access.
    """
    # The marker records {token, files[]} of the last applied bundle so we can
    # (a) skip re-applying the same one and (b) cleanly remove exactly those
    # files when the user disables their bundle (version unset).
    def _read_marker() -> dict:
        try:
            with open(_CONFIG_MARKER) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}

    def _remove_applied(files: list) -> None:
        for rel in files:
            try:
                os.remove(rel)
            except OSError:
                pass

    # Disable path: no version selected → strip any previously-applied bundle
    # files from the persistent EFS config dirs so defaults truly return.
    if not version:
        prev = _read_marker()
        if prev.get("files"):
            _remove_applied(prev["files"])
            try:
                os.remove(_CONFIG_MARKER)
            except OSError:
                pass
            logger.info("config_bundle_cleared", extra={"removed": len(prev["files"])})
        return
    if not (user_id and ARTIFACT_BUCKET):
        return

    token = f"{user_id}:{version}"
    prev = _read_marker()
    if prev.get("token") == token:
        # Bytes already staged on EFS, but the home-dir symlinks live on the
        # container-local $HOME, which a warm-VM recycle wipes. Re-link (cheap,
        # idempotent) before the early return so skills stay visible post-recycle.
        _link_cli_dirs()
        return  # already applied to this warm VM
    # Switching versions/disabling → clear the previous bundle's files first.
    if prev.get("files"):
        _remove_applied(prev["files"])

    key = f"{_tenant_prefix(tenant_id)}/configs/{user_id}/{version}.zip"
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001 — missing/forbidden bundle is non-fatal
        logger.warning("config_bundle_fetch_failed", extra={"key": key, "error": str(exc)[:200]})
        return

    # Stage every subtree on EFS (persists across warm-VM recycles), then symlink
    # the CLIs' FIXED home-relative dirs onto the staged copies (see _link_cli_dirs).
    for d in (CLAUDE_CONFIG_DIR, CODEX_HOME, KIRO_HOME, CODEX_SKILLS_DIR, KIRO_CONFIG_DIR):
        os.makedirs(d, exist_ok=True)

    def _route(member: str) -> str | None:
        """Map a bundle member path to its EFS staging target, honoring the CLI's
        real on-disk layout. Returns None for anything we don't recognize."""
        top, _, rel = member.partition("/")
        if not rel:
            return None
        if top == "claude":
            return os.path.join(CLAUDE_CONFIG_DIR, rel)
        if top == "codex":
            # Skills are USER-scope at ~/.agents/skills, NOT under CODEX_HOME.
            if rel.startswith("skills/"):
                return os.path.join(CODEX_SKILLS_DIR, rel[len("skills/"):])
            return os.path.join(CODEX_HOME, rel)
        if top == "kiro":
            # skills/agents/prompts/steering → ~/.kiro/<dir>.
            return os.path.join(KIRO_CONFIG_DIR, rel)
        return None

    applied_paths: list = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for member in zf.namelist():
                if member.endswith("/"):
                    continue
                target = _route(member)
                if not target:
                    continue  # outside a recognized CLI subtree
                # Path-traversal guard: target must stay within its staging root.
                target = os.path.normpath(target)
                roots = (CLAUDE_CONFIG_DIR, CODEX_HOME, KIRO_HOME,
                         CODEX_SKILLS_DIR, KIRO_CONFIG_DIR)
                if not any(target.startswith(os.path.normpath(r) + os.sep) for r in roots):
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
                applied_paths.append(target)
    except zipfile.BadZipFile:
        logger.warning("config_bundle_bad_zip", extra={"key": key})
        return

    # Point the CLIs' hardcoded home dirs at the EFS-staged subtrees.
    _link_cli_dirs()

    # Record token + the exact files written, so a later disable/switch removes
    # precisely this bundle (and nothing else in the shared config dirs).
    try:
        with open(_CONFIG_MARKER, "w") as f:
            json.dump({"token": token, "files": applied_paths}, f)
    except OSError:
        pass
    logger.info("config_bundle_applied", extra={"user": user_id, "version": version, "files": len(applied_paths)})


# ─── Subscription credentials ─────────────────────────────────────────────────


# Phase 4: where subscription creds live. "s3" (default) reads the encrypted
# object; "secretsmanager" reads a per-(tenant,user,cli) secret. Set by the same
# EMBER_SECRETS_BACKEND the app uses, so both sides agree.
SECRETS_BACKEND = os.environ.get("EMBER_SECRETS_BACKEND", "s3")


def _secret_name(tenant_id: str | None, user_id: str, cli: str) -> str:
    """Secrets Manager secret name — mirrors src/lib/ember/secrets.ts."""
    return f"{_tenant_prefix(tenant_id)}/auth/{user_id}/{cli}"


def _fetch_subscription_cred(user_id: str | None, cli: str,
                             tenant_id: str | None = None) -> dict | None:
    """Fetch the user's uploaded subscription credential for this CLI.

    Reads from the configured backend (S3 object or Secrets Manager secret).
    Returns the parsed JSON ({"token": ...} for claude; the auth.json doc for
    codex) or None if absent/unreadable. Best-effort — a missing credential
    just means the turn can't run in subscription mode (caller surfaces that)."""
    if not user_id:
        return None
    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        if SECRETS_BACKEND == "secretsmanager":
            sm = boto3.client("secretsmanager", region_name=region)
            resp = sm.get_secret_value(SecretId=_secret_name(tenant_id, user_id, cli))
            return json.loads(resp["SecretString"])
        if not ARTIFACT_BUCKET:
            return None
        key = f"{_tenant_prefix(tenant_id)}/auth/{user_id}/{cli}.json"
        s3 = boto3.client("s3", region_name=region)
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)
        return json.loads(obj["Body"].read())
    except Exception as exc:  # noqa: BLE001 — missing/forbidden cred is non-fatal
        logger.warning("subscription_cred_fetch_failed", extra={"cli": cli, "error": str(exc)[:200]})
        return None


# Phase 4: materialize plaintext creds to a tmpfs (RAM-backed, NON-persistent)
# dir, never the shared EFS. /dev/shm is tmpfs on Linux; fall back to /tmp. The
# claude PTY token lands here and shell-init.sh reads it from here — so the secret
# never touches the durable filesystem other tenants' VMs also mount.
EPHEMERAL_CREDS_DIR = os.environ.get(
    "EMBER_EPHEMERAL_CREDS_DIR",
    "/dev/shm/ember-creds" if os.path.isdir("/dev/shm") else "/tmp/ember-creds",
)
_CLAUDE_SUB_TOKEN_PATH = os.path.join(EPHEMERAL_CREDS_DIR, ".sub-token")


def _materialize_claude_token(user_id: str | None, tenant_id: str | None = None) -> bool:
    """Write the user's Claude subscription token to a tmpfs file so the
    interactive PTY shell (shell-init.sh) launches `claude` on their plan. The
    headless chat path reads the token from the backend per turn instead. Returns
    True on success; absence of the file signals Bedrock mode to the shell."""
    cred = _fetch_subscription_cred(user_id, "claude", tenant_id) or {}
    token = cred.get("token") or cred.get("oauth_token")
    if not token:
        return False
    try:
        os.makedirs(EPHEMERAL_CREDS_DIR, mode=0o700, exist_ok=True)
        with open(_CLAUDE_SUB_TOKEN_PATH, "w") as f:
            f.write(token)
        os.chmod(_CLAUDE_SUB_TOKEN_PATH, 0o600)
        return True
    except OSError as exc:
        logger.warning("claude_token_write_failed", extra={"error": str(exc)[:200]})
        return False


# The codex CLI only reads auth.json from $CODEX_HOME — but CODEX_HOME is on the
# shared/durable EFS (it also holds config.toml + session history). So we keep the
# SECRET bytes on tmpfs and expose them to codex via a symlink: $CODEX_HOME/auth.json
# → tmpfs. The link lives on EFS; the credential bytes never do.
_CODEX_AUTH_TMPFS = os.path.join(EPHEMERAL_CREDS_DIR, "codex-auth.json")
_CODEX_AUTH_LINK = os.path.join(CODEX_HOME, "auth.json")
# Kiro access key for the interactive PTY (shell-init.sh reads it). tmpfs only.
_KIRO_KEY_PATH = os.path.join(EPHEMERAL_CREDS_DIR, ".kiro-api-key")


def _clear_subscription_creds() -> None:
    """Remove any materialized subscription creds so a Bedrock-mode session on a
    warm VM doesn't accidentally inherit a prior subscription session's plan.
    Clears the tmpfs secrets, the codex symlink, and legacy EFS locations.
    (Kiro is always BYO-key, so its key is cleared by the kiro branch itself.)"""
    for p in (_CLAUDE_SUB_TOKEN_PATH,
              _CODEX_AUTH_TMPFS,
              _CODEX_AUTH_LINK,  # symlink (or pre-fix real file) at $CODEX_HOME/auth.json
              _KIRO_KEY_PATH,
              os.path.join(CLAUDE_CONFIG_DIR, ".sub-token")):  # legacy
        try:
            os.remove(p)
        except OSError:
            pass


def _materialize_kiro_key(user_id: str | None, tenant_id: str | None = None) -> bool:
    """Write the user's Kiro access key to a tmpfs file so the interactive PTY
    (shell-init.sh) launches `kiro-cli` on their key. The headless chat path reads
    the key from the backend per turn instead. Returns True on success."""
    cred = _fetch_subscription_cred(user_id, "kiro", tenant_id) or {}
    key = cred.get("token") or cred.get("api_key") or cred.get("access_key")
    if not key:
        # Fail closed: no key fetched (disconnected / unreadable) → remove any
        # stale key a prior session left on this warm VM so shell-init.sh / the
        # turn never silently run on an old credential.
        try:
            os.remove(_KIRO_KEY_PATH)
        except OSError:
            pass
        return False
    try:
        os.makedirs(EPHEMERAL_CREDS_DIR, mode=0o700, exist_ok=True)
        with open(_KIRO_KEY_PATH, "w") as f:
            f.write(key)
        os.chmod(_KIRO_KEY_PATH, 0o600)
        return True
    except OSError as exc:
        logger.warning("kiro_key_write_failed", extra={"error": str(exc)[:200]})
        return False


def _materialize_codex_auth(user_id: str | None, tenant_id: str | None = None) -> bool:
    """Materialize the user's ChatGPT-plan auth.json for `codex exec`. The secret
    bytes are written to tmpfs (never EFS); $CODEX_HOME/auth.json is a symlink to
    them, which is all the codex CLI needs. Returns True on success."""
    cred = _fetch_subscription_cred(user_id, "codex", tenant_id)
    if not cred:
        return False
    try:
        os.makedirs(EPHEMERAL_CREDS_DIR, mode=0o700, exist_ok=True)
        os.makedirs(CODEX_HOME, exist_ok=True)
        # The uploaded doc may be the raw auth.json, or wrapped as {"auth_json": {...}}.
        doc = cred.get("auth_json") if isinstance(cred, dict) and "auth_json" in cred else cred
        with open(_CODEX_AUTH_TMPFS, "w") as f:
            json.dump(doc, f)
        os.chmod(_CODEX_AUTH_TMPFS, 0o600)
        # Point $CODEX_HOME/auth.json at the tmpfs copy (replace any prior file/link).
        try:
            os.remove(_CODEX_AUTH_LINK)
        except OSError:
            pass
        os.symlink(_CODEX_AUTH_TMPFS, _CODEX_AUTH_LINK)
        logger.info("codex_auth_materialized", extra={"user": user_id, "tmpfs": True})
        return True
    except OSError as exc:
        logger.warning("codex_auth_write_failed", extra={"error": str(exc)[:200]})
        return False


# ─── OTel collector sidecar ───────────────────────────────────────────────────


def _wire_log_headers() -> None:
    raw = os.environ.get("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "")
    for kv in raw.split(","):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        if k.strip() == "x-aws-log-group":
            os.environ["AWS_OTEL_LOG_GROUP"] = v.strip()
        elif k.strip() == "x-aws-log-stream":
            os.environ["AWS_OTEL_LOG_STREAM"] = v.strip()


def _wait_for_collector(host: str = "127.0.0.1", port: int = 4318, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _bootstrap_collector() -> None:
    if not (os.path.exists(COLLECTOR_BIN) and os.path.exists(COLLECTOR_CFG)):
        logger.warning("otel_collector_unavailable")
        return
    _wire_log_headers()
    logger.info("otel_collector_starting", extra={"config": COLLECTOR_CFG})
    proc = subprocess.Popen(
        [COLLECTOR_BIN, "--config", COLLECTOR_CFG],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if _wait_for_collector():
        logger.info("otel_collector_ready")
    elif proc.poll() is not None:
        out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
        logger.error("otel_collector_exited", extra={"rc": proc.returncode, "head": out[:1500]})


# ─── Workspace + git ──────────────────────────────────────────────────────────


def _slugify_repo(repo: str) -> str:
    """owner/name or a URL → a stable, filesystem-safe per-repo slug."""
    s = repo.strip()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^git@", "", s)
    s = re.sub(r"\.git$", "", s)
    s = s.replace(":", "/")
    # Keep the last two path components (owner/name) when present.
    tail = [p for p in s.split("/") if p][-2:]
    slug = "-".join(tail) if tail else "default"
    return re.sub(r"[^A-Za-z0-9._-]", "-", slug) or "default"


def _configure_git() -> None:
    # Session storage mounts under a uid that may differ from the runtime user,
    # so Git refuses to operate ("dubious ownership"). Trust the workspace tree.
    subprocess.run(
        ["git", "config", "--global", "--replace-all",
         "safe.directory", WORKSPACE_ROOT],
        check=False,
    )
    subprocess.run(
        ["git", "config", "--global", "--add", "safe.directory", "*"],
        check=False,
    )
    pat = os.environ.get("GITHUB_PAT")
    if not pat:
        return
    subprocess.run(
        ["git", "config", "--global",
         f"url.https://x-access-token:{pat}@github.com/.insteadOf",
         "https://github.com/"],
        check=False,
    )
    subprocess.run(["git", "config", "--global", "user.email",
                    os.environ.get("GIT_AUTHOR_EMAIL", "agent@ember.example.com")], check=False)
    subprocess.run(["git", "config", "--global", "user.name",
                    os.environ.get("GIT_AUTHOR_NAME", "AgentCore Hub Agent")], check=False)
    # Expose the PAT to the GitHub CLI so the agent can enumerate/inspect repos
    # (e.g. `gh repo list`, `gh api`) — not just clone a known URL.
    os.environ.setdefault("GH_TOKEN", pat)
    os.environ.setdefault("GITHUB_TOKEN", pat)


def _valid_repo(repo: str) -> bool:
    """A clonable target: a full URL, or owner/name (>= 2 path segments).
    A bare owner like 'tycenjmccann' is NOT clonable — reject it early so we
    return a clean error instead of a 404 git clone."""
    r = repo.strip()
    if r.startswith(("http://", "https://", "git@")):
        return True
    return len([p for p in r.split("/") if p]) >= 2


def _session_dir(session_id: str | None) -> str:
    """Per-session root under the workspace. Each session gets an isolated
    checkout so two sessions on the same repo can't clobber each other's branch
    or edits. Falls back to a shared 'default' dir when no session id is given."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", (session_id or "default"))[:80]
    return os.path.join(WORKSPACE_ROOT, "sessions", safe)


def _codex_home_for(session_id: str | None) -> str:
    """Per-Ember-session CODEX_HOME.

    Codex keys its entire session store off $CODEX_HOME and looks rollouts up by
    the thread uuid alone. So two DIFFERENT Ember sessions that resume the SAME
    laptop Codex thread (same uuid) would collide in one shared sessions/ tree —
    a checkpoint could upload the sibling's rollout. Giving each Ember session its
    own CODEX_HOME isolates the rollout history (mirrors how Claude isolates by
    workdir slug). Shared PER-USER state (config.toml, auth.json) is symlinked in
    from the global CODEX_HOME, so only the conversation history is per-session.

    It lives UNDER _session_dir(session_id), so deleting the session (rmtree of
    that dir) reclaims the rollouts too. Falls back to the global home when no
    session id is given (legacy / non-isolated callers)."""
    if not session_id:
        return CODEX_HOME
    home = os.path.join(_session_dir(session_id), ".codex")
    try:
        os.makedirs(os.path.join(home, "sessions"), exist_ok=True)
        # (Re)link shared per-user state so codex sees the user's config + plan
        # auth inside this session's home. Refresh each call — auth.json may have
        # just been re-materialized to a new tmpfs target.
        for name in ("config.toml", "auth.json"):
            link = os.path.join(home, name)
            target = os.path.join(CODEX_HOME, name)
            try:
                if os.path.islink(link) or os.path.exists(link):
                    os.remove(link)
            except OSError:
                pass
            if os.path.lexists(target):
                try:
                    os.symlink(target, link)
                except OSError:
                    pass
    except OSError as exc:
        logger.warning("codex_home_prepare_failed",
                       extra={"session": session_id, "error": str(exc)[:200]})
        return CODEX_HOME
    return home


# ── Kiro session store (SQLite) ───────────────────────────────────────────────
# kiro-cli keeps every conversation as ONE ROW in conversations_v2
# (key=cwd, conversation_id=uuid, value=conversation JSON). KIRO_HOME relocates
# the data dir, so each Ember session gets an isolated DB (mirrors _codex_home_for).
# kiro's verbatim DDL — we create the table ourselves so an upsert works even on a
# fresh KIRO_HOME kiro hasn't migrated yet (our IF NOT EXISTS matches its schema).
_KIRO_DDL = """
CREATE TABLE IF NOT EXISTS conversations_v2 (
  key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_updated_at ON conversations_v2(updated_at DESC);
"""


# Config entries (synced agents/prompts) the bundle materializes into the GLOBAL
# KIRO_HOME; we symlink them into each per-session home so a session sees the
# user's synced kiro config without sharing the per-session conversations DB.
_KIRO_CONFIG_ENTRIES = ("agents", "cli-agents", "prompts", "global_context.json", "AGENTS.md")


def _kiro_home_for(session_id: str | None) -> str:
    """Per-Ember-session KIRO_HOME so two sessions resuming the same kiro uuid
    don't share one conversations DB. Lives under _session_dir(session_id) so
    deleting the session reclaims it. The user's synced config (agents/prompts,
    materialized into the global KIRO_HOME by _apply_config_bundle) is symlinked
    in, mirroring how _codex_home_for links codex's shared per-user state. Kiro
    auth is the per-turn KIRO_API_KEY env var, so there's no credential to link."""
    if not session_id:
        return KIRO_HOME
    home = os.path.join(_session_dir(session_id), ".kiro")
    try:
        os.makedirs(home, exist_ok=True)
        # (Re)link the synced config entries from the global home. Refresh each
        # call so a newly-synced bundle is picked up on the next turn.
        for name in _KIRO_CONFIG_ENTRIES:
            link = os.path.join(home, name)
            target = os.path.join(KIRO_HOME, name)
            try:
                if os.path.islink(link) or os.path.exists(link):
                    os.remove(link)
            except OSError:
                pass
            if os.path.lexists(target):
                try:
                    os.symlink(target, link)
                except OSError:
                    pass
    except OSError as exc:
        logger.warning("kiro_home_prepare_failed",
                       extra={"session": session_id, "error": str(exc)[:200]})
        return KIRO_HOME
    return home


def _kiro_db_path(kiro_home: str | None = None) -> str:
    # Kiro stores its SQLite under $XDG_DATA_HOME/kiro-cli/ (NOT $KIRO_HOME). We
    # point XDG_DATA_HOME at the per-session home (see _run_kiro), so the DB lands
    # in <home>/kiro-cli/data.sqlite3 — match that here so install/discovery/
    # checkpoint all read the same file kiro actually wrote.
    return os.path.join(kiro_home or KIRO_HOME, "kiro-cli", "data.sqlite3")


def _install_kiro_resume_transcript(s3_key: str, session_id: str, workdir: str,
                                    kiro_home: str | None = None) -> bool:
    """Kiro analog of _install_resume_transcript. Download a ported conversation
    `value` JSON from S3 and UPSERT it into the per-session DB, rewriting `key` to
    the cloud workdir cwd so `kiro-cli chat --resume-id <uuid>` (scoped to cwd)
    finds it. Idempotent: a re-pull overwrites the row in place."""
    if not (s3_key and session_id and ARTIFACT_BUCKET):
        return False
    db_path = _kiro_db_path(kiro_home)
    try:
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        value = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)["Body"].read().decode("utf-8")
        key = os.path.realpath(workdir)
        now = int(time.time() * 1000)
        conn = sqlite3.connect(db_path)
        try:
            conn.executescript(_KIRO_DDL)
            conn.execute(
                "INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(key, conversation_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, session_id, value, now, now),
            )
            conn.commit()
        finally:
            conn.close()
        logger.info("kiro_resume_transcript_installed", extra={"session": session_id})
        return True
    except Exception as exc:  # noqa: BLE001 — non-fatal; fall back to a cold turn
        logger.warning("kiro_resume_transcript_install_failed",
                       extra={"key": s3_key, "error": str(exc)[:200]})
        return False


def _kiro_newest_id(workdir: str, kiro_home: str | None = None) -> str | None:
    """The conversation_id of the newest kiro row for a cwd, or None. Used to learn
    the resume id after a NEW kiro turn (kiro has no JSON output to report it)."""
    db_path = _kiro_db_path(kiro_home)
    if not os.path.isfile(db_path):
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT conversation_id FROM conversations_v2 WHERE key=? "
                "ORDER BY updated_at DESC LIMIT 1",
                (os.path.realpath(workdir),),
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.warning("kiro_newest_id_failed", extra={"error": str(exc)[:200]})
        return None


def _claude_project_slug(workdir: str) -> str:
    """Claude Code stores a conversation under
    {CLAUDE_CONFIG_DIR}/projects/<slug>/<sessionId>.jsonl where <slug> is the
    real (symlink-resolved) cwd with every non-alphanumeric char replaced by '-'.
    `claude --resume` looks up the transcript by that exact slug, so a ported
    session resumes ONLY if we place its .jsonl under the matching folder."""
    return re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(workdir))


# The resume hint shell-init reads is CONTAINER-LOCAL (/tmp) — never at
# $WORKSPACE_ROOT. EFS is shared across every session's microVM, so a hint at the
# shared root would leak: a different session's Terminal would source it and
# `claude --resume` the wrong (or another user's) conversation. /tmp is private to
# this microVM (one per runtimeSessionId).
#
# But /tmp dies when the microVM is recycled, and a cold VM may be reached only by
# the config-only prepare path (non-ported session) that doesn't recompute the
# hint. So we ALSO persist a durable copy in the per-session EFS dir — which is
# session-scoped (sessions/<id>/...), not the shared root, so it can't leak — and
# restore /tmp from it at the start of every invocation. Durable source of truth,
# private runtime copy.
RESUME_HINT_PATH = "/tmp/.resume-launch.sh"  # noqa: S108 — container-local, see above
RESUME_HINT_NAME = ".resume-launch.sh"


def _write_resume_launch_hint(workdir: str, resume_sid: str, runtime_session_id: str | None,
                              cli: str = "claude", kiro_home: str | None = None,
                              codex_home: str | None = None) -> bool:
    """Write the hint the interactive shell reads on launch to
    `cd <workdir> && <cli> --resume <resume_sid>` itself — so the browser never
    types the resume command into an already-running TUI on reattach.

    Two distinct ids: `resume_sid` is the conversation id (the resume arg);
    `runtime_session_id` is the AgentCore runtimeSessionId that keys the
    per-session EFS dir AND is what _restore_resume_launch_hint looks up later.
    They differ, so the durable copy MUST be keyed by the runtime id or restore
    would miss it on a recycled VM.

    For kiro/codex we also carry the per-session home (EMBER_KIRO_HOME /
    EMBER_CODEX_HOME, the _kiro_home_for / _codex_home_for dir): the PTY shell
    otherwise only sees the deploy-default home and would read a different —
    shared, cross-session — session store than the chat path wrote. shell-init
    exports the home from it so the Terminal resumes the same conversation this
    session created.

    Writes both the private /tmp copy (what shell-init reads) and a durable copy
    in the per-session EFS dir (survives a VM recycle; restored to /tmp by
    _restore_resume_launch_hint). shell-init sources it once per fresh shell (its
    run-once guard means a PTY reattach to a live CLI never re-launches)."""
    body = (
        f"EMBER_RESUME_DIR={shlex.quote(os.path.realpath(workdir))}\n"
        f"EMBER_RESUME_SID={shlex.quote(resume_sid)}\n"
        f"EMBER_RESUME_CLI={shlex.quote(cli)}\n"
    )
    if cli == "kiro" and kiro_home:
        body += f"EMBER_KIRO_HOME={shlex.quote(kiro_home)}\n"
    if cli == "codex" and codex_home:
        body += f"EMBER_CODEX_HOME={shlex.quote(codex_home)}\n"
    ok = False
    try:
        with open(RESUME_HINT_PATH, "w") as f:
            f.write(body)
        ok = True
    except OSError as exc:
        logger.warning("resume_launch_hint_failed", extra={"error": str(exc)[:200]})
    # Durable copy keyed by the RUNTIME session id (what restore looks up) so a
    # recycled VM — even one only prepared, never warmed — can repopulate /tmp.
    if runtime_session_id:
        try:
            sdir = _session_dir(runtime_session_id)
            os.makedirs(sdir, exist_ok=True)
            with open(os.path.join(sdir, RESUME_HINT_NAME), "w") as f:
                f.write(body)
        except OSError as exc:
            logger.warning("resume_hint_persist_failed", extra={"error": str(exc)[:200]})
    if ok:
        logger.info("resume_launch_hint_written", extra={"workdir": workdir})
    return ok


def _write_home_hint(session_id: str | None, cli: str, home: str) -> bool:
    """Pin the PTY to this session's per-session home (KIRO_HOME / CODEX_HOME) when
    there's nothing to resume yet (a Terminal opened before any headless turn).
    Writes ONLY the home var — no EMBER_RESUME_SID — so shell-init isolates the
    session store but doesn't auto-exec a resume. Without this the first Terminal
    turn would land in the shared deploy-default home (a cross-session EFS store).
    Mirrors _write_resume_launch_hint's dual write: private /tmp + durable
    per-session EFS (restored to /tmp by _restore_resume_launch_hint on a
    recycled VM)."""
    home_var = "EMBER_KIRO_HOME" if cli == "kiro" else "EMBER_CODEX_HOME"
    body = f"EMBER_RESUME_CLI={shlex.quote(cli)}\n{home_var}={shlex.quote(home)}\n"
    ok = False
    try:
        with open(RESUME_HINT_PATH, "w") as f:
            f.write(body)
        ok = True
    except OSError as exc:
        logger.warning("home_hint_failed", extra={"cli": cli, "error": str(exc)[:200]})
    if session_id:
        try:
            sdir = _session_dir(session_id)
            os.makedirs(sdir, exist_ok=True)
            with open(os.path.join(sdir, RESUME_HINT_NAME), "w") as f:
                f.write(body)
        except OSError as exc:
            logger.warning("home_hint_persist_failed", extra={"cli": cli, "error": str(exc)[:200]})
    return ok


def _restore_resume_launch_hint(session_id: str | None) -> None:
    """Repopulate the private /tmp hint from the durable per-session EFS copy if
    /tmp is missing (a recycled microVM). Lets a non-ported session resume in the
    Terminal even when it's reached only by the config-only prepare path. No-op if
    /tmp already has it or there's no durable copy."""
    if not session_id or os.path.exists(RESUME_HINT_PATH):
        return
    src = os.path.join(_session_dir(session_id), RESUME_HINT_NAME)
    try:
        if os.path.isfile(src):
            with open(src) as f:
                body = f.read()
            with open(RESUME_HINT_PATH, "w") as f:
                f.write(body)
            logger.info("resume_launch_hint_restored", extra={"session": session_id})
    except OSError as exc:
        logger.warning("resume_hint_restore_failed", extra={"error": str(exc)[:200]})


def _install_resume_transcript(s3_key: str, session_id: str, workdir: str,
                               runtime_session_id: str | None = None) -> bool:
    """Download a ported Claude transcript from S3 and place it where
    `claude --resume <session_id>` will find it (the workdir's project slug).

    This is how "port my laptop session to the cloud" achieves a LOSSLESS,
    native resume: we ship the real .jsonl, not a text summary.

    Called on EVERY ported turn (not just the seed), because Claude scopes a
    conversation by its project slug = realpath(cwd), and the cwd can change
    between turns (e.g. the seed turn's clone failed → bare session dir, a later
    turn's clone succeeds → repo subdir). A new cwd means a new slug where the
    .jsonl is absent, so `claude --resume <id>` reports "No conversation found".

    Resolution order, picking the MOST COMPLETE transcript so cloud turns are
    never dropped:
      1. Already at the target slug → done.
      2. Present at a DIFFERENT slug (the cwd moved) → relocate it. This is the
         grown transcript with the cloud's appended turns; never clobber it with
         the smaller original from S3.
      3. Nowhere on disk → download the original from S3.
    Returns True if the transcript is in place after this."""
    if not (s3_key and session_id and ARTIFACT_BUCKET):
        return False
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    projects_root = os.path.join(config_dir, "projects")
    proj = os.path.join(projects_root, _claude_project_slug(workdir))
    dest = os.path.join(proj, f"{session_id}.jsonl")

    # 1. Already where the resume will look.
    if os.path.exists(dest):
        return True

    # 2. Present under another slug (cwd changed across turns) — relocate the
    # existing copy rather than re-downloading, so the cloud's appended turns
    # survive. Pick the largest if somehow more than one exists.
    #
    # CRITICAL scoping: several ember sessions can share one Claude conversation
    # id (the user ported the same laptop session more than once), so each writes
    # <cid>.jsonl under ITS OWN session-dir slug. A bare glob on the cid would
    # match those sibling sessions and move a DIFFERENT live session's transcript.
    # Every slug for THIS session derives from realpath(_session_dir(session_id)),
    # so restrict candidates to slugs carrying this session's dir marker.
    try:
        # Skip relocation unless we can scope to this ember session's slugs —
        # otherwise a sibling session's transcript could be matched + moved.
        sess_marker = (
            _claude_project_slug(_session_dir(runtime_session_id))
            if runtime_session_id else None
        )
        candidates = (
            glob.glob(os.path.join(projects_root, "*", f"{glob.escape(session_id)}.jsonl"))
            if sess_marker else []
        )
        candidates = [
            c for c in candidates
            if os.path.realpath(c) != os.path.realpath(dest)
            and sess_marker in os.path.basename(os.path.dirname(c))
        ]
        if candidates:
            src = max(candidates, key=lambda p: os.path.getsize(p))
            os.makedirs(proj, exist_ok=True)
            shutil.move(src, dest)
            logger.info("resume_transcript_relocated",
                        extra={"session": session_id, "slug": _claude_project_slug(workdir)})
            return True
    except OSError as exc:
        logger.warning("resume_transcript_relocate_failed", extra={"error": str(exc)[:200]})

    # 3. Not on disk anywhere — download the original from S3.
    try:
        os.makedirs(proj, exist_ok=True)
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        with open(dest, "wb") as f:
            f.write(obj["Body"].read())
        logger.info("resume_transcript_installed",
                    extra={"session": session_id, "slug": _claude_project_slug(workdir)})
        return True
    except Exception as exc:  # noqa: BLE001 — a missing transcript is non-fatal; fall back to a cold turn
        logger.warning("resume_transcript_install_failed", extra={"key": s3_key, "error": str(exc)[:200]})
        return False


def _install_codex_resume_transcript(s3_key: str, session_id: str,
                                     codex_home: str | None = None) -> bool:
    """Codex analog of _install_resume_transcript. Download a ported codex rollout
    from S3 and place it under {codex_home}/sessions so `codex exec resume <uuid>`
    finds it. Codex locates a session by scanning that tree for the uuid in the
    filename and reading the .jsonl directly (the SQLite index is a rebuildable
    cache with a filesystem fallback), so a flat placement is picked up — we don't
    need the original YYYY/MM/DD path. Idempotent: if a rollout for this uuid is
    already present (e.g. a prior turn grew it), keep that grown copy.

    codex_home is the PER-SESSION home (_codex_home_for) so two Ember sessions
    resuming the same uuid don't share one rollout."""
    home = codex_home or CODEX_HOME
    if not (s3_key and session_id and ARTIFACT_BUCKET):
        return False
    existing = _find_codex_rollout(session_id, home)
    if existing:
        return True  # already on disk (possibly grown by a prior cloud turn)
    # Codex locates a session by parsing BOTH a timestamp and the uuid out of the
    # filename (rollout-<YYYY-MM-DDThh-mm-ss>-<uuid>.jsonl), so the name must match
    # that shape or the scan skips it. Place it under today's YYYY/MM/DD like codex
    # itself does, with a synthetic timestamp.
    now = datetime.now(timezone.utc)
    dest_dir = os.path.join(home, "sessions",
                            f"{now.year:04d}", f"{now.month:02d}", f"{now.day:02d}")
    ts = now.strftime("%Y-%m-%dT%H-%M-%S")
    dest = os.path.join(dest_dir, f"rollout-{ts}-{session_id}.jsonl")
    try:
        os.makedirs(dest_dir, exist_ok=True)
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        with open(dest, "wb") as f:
            f.write(obj["Body"].read())
        logger.info("codex_resume_transcript_installed", extra={"session": session_id})
        return True
    except Exception as exc:  # noqa: BLE001 — non-fatal; fall back to a cold turn
        logger.warning("codex_resume_transcript_install_failed",
                       extra={"key": s3_key, "error": str(exc)[:200]})
        return False


def _find_codex_rollout(session_id: str, codex_home: str | None = None) -> str | None:
    """Locate a codex session's rollout .jsonl by its thread uuid. Codex stores
    one file per session at {codex_home}/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,
    so we glob the tree for the uuid anywhere in the filename and take the newest
    match (a resumed session keeps the same uuid). codex_home is the per-session
    home so the lookup can't cross into a sibling Ember session's rollout."""
    home = codex_home or CODEX_HOME
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", session_id)
    matches: list[str] = []
    for cid in {session_id, safe}:
        matches += glob.glob(
            os.path.join(home, "sessions", "**", f"*{glob.escape(cid)}*.jsonl"),
            recursive=True,
        )
    files = [m for m in set(matches) if os.path.isfile(m)]
    if not files:
        return None
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return files[0]


def _checkpoint_transcript(session_id: str, workdir: str,
                           tenant_id: str | None = None, cli: str = "claude",
                           codex_home: str | None = None,
                           kiro_home: str | None = None) -> dict:
    """Reverse of install: read the (now-grown) transcript off EFS and upload it
    to S3 so the laptop can pull it back and resume locally.

    Per-CLI on-disk layout:
      claude → {CLAUDE_CONFIG_DIR}/projects/<slug>/<session_id>.jsonl
      codex  → {CODEX_HOME}/sessions/**/rollout-<ts>-<session_id>.jsonl
      kiro   → conversations_v2 row (value JSON) in {KIRO_HOME}/data.sqlite3
    — the same transcript the cloud grew during the session. Returns
    {key, bytes, branch?} for the caller to presign a GET. The branch (current
    checkout) lets the laptop pull the cloud's commits before resuming."""
    if cli == "kiro":
        db_path = _kiro_db_path(kiro_home)
        if not os.path.isfile(db_path):
            raise FileNotFoundError(
                f"no kiro DB at {db_path} (session never ran on this VM?)")
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT value FROM conversations_v2 WHERE conversation_id=? "
                "ORDER BY updated_at DESC LIMIT 1", (session_id,)).fetchone()
        finally:
            conn.close()
        if not row:
            raise FileNotFoundError(
                f"no kiro conversation {session_id} in {db_path} "
                "(session never resumed on this VM?)")
        data = row[0].encode("utf-8") if isinstance(row[0], str) else row[0]
        src = None
    elif cli == "codex":
        home = codex_home or CODEX_HOME
        src = _find_codex_rollout(session_id, home)
        if not src:
            raise FileNotFoundError(
                f"no codex rollout for {session_id} under {home}/sessions "
                "(session never ran on this VM?)")
    else:
        config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
        src = os.path.join(config_dir, "projects", _claude_project_slug(workdir), f"{session_id}.jsonl")
        if not os.path.isfile(src):
            raise FileNotFoundError(f"no transcript at {src} (session never resumed on this VM?)")
    if not ARTIFACT_BUCKET:
        raise RuntimeError("ARTIFACT_BUCKET not set")
    key = f"{_tenant_prefix(tenant_id)}/checkpoint/{session_id}/{session_id}.jsonl"
    if src is not None:
        with open(src, "rb") as f:
            data = f.read()
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    s3.put_object(Bucket=ARTIFACT_BUCKET, Key=key, Body=data, ContentType="application/x-ndjson")
    branch = None
    try:
        res = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=workdir,
                             capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            branch = res.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    logger.info("checkpoint_uploaded", extra={"session": session_id, "bytes": len(data), "branch": branch})
    return {"key": key, "bytes": len(data), "branch": branch}


def _purge_session(session_id: str, conversation_id: str | None = None,
                   cli: str = "claude", tenant_id: str | None = None) -> dict:
    """Reclaim everything a session left on disk, so deleting it in the UI also
    frees the backend storage it was paying for. Three stores:

      • EFS  — the session's isolated dir (clone, resume hint, markers) at
               sessions/<id>/. The big one: a full clone can be 100s of MB.
      • EFS  — the conversation transcript, which lives OUTSIDE that dir:
                 claude → $CLAUDE_CONFIG_DIR/projects/<workdir-slug>/<id>.jsonl
                 codex  → $CODEX_HOME/sessions/**/<...id...>  (rollout files)
               We don't know the claude slug here, but the id is a unique filename,
               so we glob for it; for codex we match files whose name carries the id.
      • S3   — the ported transcript + git bundle (ember/resume/<id>/) and any
               checkpoint uploads (ember/checkpoint/<id>/).

    Best-effort and idempotent: a missing dir / already-deleted key is success, so
    a double-delete or a purge of a session that never warmed a VM is harmless. The
    live microVM is NOT torn down here — the caller stops the runtime session
    separately (it also ages out on its own idle lifecycle)."""
    removed = {"efs": False, "s3_objects": 0, "transcripts": 0}
    # EFS: rm -rf the per-session dir. _session_dir sanitizes the id, and we re-check
    # the result stays under sessions/ so a crafted id can't escape the namespace.
    sdir = _session_dir(session_id)
    sessions_root = os.path.join(WORKSPACE_ROOT, "sessions")
    if os.path.realpath(sdir).startswith(os.path.realpath(sessions_root) + os.sep):
        try:
            if os.path.isdir(sdir):
                shutil.rmtree(sdir, ignore_errors=True)
                removed["efs"] = True
        except OSError as exc:
            logger.warning("purge_efs_failed", extra={"session": session_id, "error": str(exc)[:200]})
    # EFS transcript: the conversation log lives OUTSIDE sessions/<id> (keyed by
    # the cwd slug for claude, by the rollout path for codex), so rmtree above
    # misses it. The conversation id is unique, so glob for files carrying it.
    if conversation_id:
        safe_cid = re.sub(r"[^A-Za-z0-9._-]", "-", conversation_id)
        # Escape the id before embedding it in a glob: a raw id containing glob
        # metacharacters (e.g. a ported session with claudeSessionId "*") would
        # otherwise expand and delete EVERY session's transcript. The directory
        # components stay literal; only the id substring is escaped.
        glob_cid = glob.escape(conversation_id)
        if cli == "kiro":
            # Kiro's transcript is a SQLite row inside the per-session .kiro dir,
            # which the rmtree above already reclaimed — no external file to glob.
            patterns = []
        elif cli == "codex":
            # Codex rollout files persist under $CODEX_HOME/sessions/**; the id is
            # embedded in the filename (e.g. rollout-...-<uuid>.jsonl). Match it
            # anywhere in the tree (recursive), and also try the sanitized id form.
            patterns = [
                os.path.join(CODEX_HOME, "sessions", "**", f"*{glob_cid}*"),
                os.path.join(CODEX_HOME, "sessions", "**", f"*{glob.escape(safe_cid)}*"),
            ]
        else:
            # Claude: $CLAUDE_CONFIG_DIR/projects/<workdir-slug>/<id>.jsonl.
            patterns = [os.path.join(CLAUDE_CONFIG_DIR, "projects", "*", f"{glob.escape(safe_cid)}.jsonl")]
        try:
            seen: set[str] = set()
            for pat in patterns:
                for path in glob.glob(pat, recursive=True):
                    if path in seen or not os.path.isfile(path):
                        continue
                    seen.add(path)
                    try:
                        os.remove(path)
                        removed["transcripts"] += 1
                    except OSError:
                        pass
        except OSError as exc:
            logger.warning("purge_transcript_failed",
                           extra={"session": session_id, "cli": cli, "error": str(exc)[:200]})
    # S3: delete every object under the session's resume + checkpoint prefixes.
    # Note the keying differs: the ported transcript + bundle are under the RUNTIME
    # session id (resume/<sessionId>/), but _checkpoint_transcript writes
    # checkpoints under the CONVERSATION id (checkpoint/<conversationId>/) —
    # which normally differs from cc-<sessionId>. Purge both forms so a checkpointed
    # session doesn't leak its pulled-home transcript.
    #
    # Keys are tenant-scoped (ember/t/<tenantId>/…). We also purge the LEGACY
    # un-prefixed forms (ember/resume/…, ember/checkpoint/…) so a session ported
    # before the tenant-prefix change still gets fully reclaimed on delete.
    if ARTIFACT_BUCKET:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        tp = _tenant_prefix(tenant_id)
        prefixes = [
            f"{tp}/resume/{session_id}/",
            f"{tp}/checkpoint/{session_id}/",
            f"ember/resume/{session_id}/",        # legacy (pre tenant-prefix)
            f"ember/checkpoint/{session_id}/",    # legacy
        ]
        if conversation_id:
            prefixes.append(f"{tp}/checkpoint/{conversation_id}/")
            prefixes.append(f"ember/checkpoint/{conversation_id}/")  # legacy
        for prefix in prefixes:
            try:
                paginator = s3.get_paginator("list_objects_v2")
                for page in paginator.paginate(Bucket=ARTIFACT_BUCKET, Prefix=prefix):
                    keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                    if keys:
                        s3.delete_objects(Bucket=ARTIFACT_BUCKET, Delete={"Objects": keys, "Quiet": True})
                        removed["s3_objects"] += len(keys)
            except Exception as exc:  # noqa: BLE001 — S3 cleanup is best-effort
                logger.warning("purge_s3_failed", extra={"prefix": prefix, "error": str(exc)[:200]})
    logger.info("session_purged", extra={"session": session_id, **removed})
    return removed


def _ensure_workspace(repo: str | None, session_id: str | None = None,
                      clone_url: str | None = None) -> str:
    """Return the working dir for this session. If repo given and not yet cloned,
    clone it under the session's own dir (on EFS, so a re-invoke with the same
    runtimeSessionId finds it warm — no re-clone).

    clone_url overrides the URL derived from repo — used by the port handoff so
    the cloud clones the laptop's exact origin (which may be a public upstream the
    account has no push rights to; bundle mode then layers the laptop's commits)."""
    base = _session_dir(session_id)
    # A non-github / self-hosted port can ship clone_url WITHOUT an owner/name
    # repo. Treat clone_url as the clonable target then (slug derived from it).
    if not repo and not clone_url:
        # A chat resume with no repo just needs a cwd. Tolerate a degraded EFS
        # mount (makedirs can raise FileExistsError when the path exists but isn't
        # a dir) — fall back to any usable existing dir rather than 500 the turn.
        try:
            os.makedirs(base, exist_ok=True)
            return base
        except OSError as exc:
            logger.warning("workspace_mkdir_failed", extra={"base": base, "error": str(exc)[:200]})
            if os.path.isdir(base):
                return base
            return WORKSPACE_ROOT if os.path.isdir(WORKSPACE_ROOT) else "/tmp"
    if repo and not _valid_repo(repo):
        raise ValueError(
            f"'{repo}' is not a valid repository. Use 'owner/name' or a full "
            f"clone URL. (A bare owner can't be cloned — leave repo empty and "
            f"ask the agent to 'gh repo list {repo}' instead.)"
        )
    slug = _slugify_repo(repo or clone_url or "default")
    wd = os.path.join(base, slug)
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("workspace_warm", extra={"slug": slug})
        return wd
    os.makedirs(base, exist_ok=True)
    url = clone_url or (repo if repo.startswith(("http://", "https://", "git@")) else f"https://github.com/{repo}.git")
    logger.info("workspace_cloning", extra={"slug": slug, "url": url.split("@")[-1]})
    res = subprocess.run(["git", "clone", url, wd], capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise RuntimeError(f"git clone failed: {res.stderr.strip()[:400]}")
    return wd


def _safe_branch_name(name: str | None) -> str:
    """A git-legal local branch name. Falls back to a stable default so bundle
    mode always lands on a NAMED branch (never detached HEAD) — that's what lets
    pull-home bring cloud commits back via a real branch."""
    cand = (name or "").strip()
    if re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", cand) and not cand.startswith("-"):
        return cand
    return "ember/ported-work"


def _apply_resume_bundle(s3_key: str, workdir: str, session_id: str | None,
                         branch: str | None = None) -> bool:
    """Bundle mode: download the laptop's git bundle from S3 and layer its commits
    onto the freshly-cloned upstream. The bundle holds base..HEAD (the laptop's
    in-flight commits); we fetch all its refs and check out its tip ON A NAMED
    BRANCH so the workspace matches the laptop without push access to origin —
    and so checkpoint/pull-home can return cloud commits on a real branch (a
    detached HEAD would make pull try origin/HEAD and lose them).

    Idempotent per warm microVM via a marker. Best-effort: a bad/missing bundle
    leaves the clean clone in place (the agent can still work) rather than failing
    the turn. Returns True if the bundle's work was checked out."""
    if not (s3_key and ARTIFACT_BUCKET and os.path.isdir(os.path.join(workdir, ".git"))):
        return False
    marker = os.path.join(_session_dir(session_id), ".bundle-applied")
    try:
        if os.path.exists(marker):
            with open(marker) as f:
                if f.read().strip() == s3_key:
                    return True  # already applied on this warm VM
    except OSError:
        pass
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001 — missing bundle is non-fatal
        logger.warning("bundle_fetch_failed", extra={"key": s3_key, "error": str(exc)[:200]})
        return False

    bundle_path = os.path.join(workdir, ".ember-work.bundle")
    try:
        with open(bundle_path, "wb") as f:
            f.write(raw)
        # Verify it's a real bundle before fetching (clean error if not).
        verify = subprocess.run(["git", "bundle", "verify", bundle_path], cwd=workdir,
                                capture_output=True, text=True, timeout=60)
        if verify.returncode != 0:
            logger.warning("bundle_verify_failed", extra={"err": verify.stderr.strip()[:200]})
            return False
        # Fetch every ref the bundle carries into a namespace, then check out its tip.
        fetch = subprocess.run(
            ["git", "fetch", bundle_path, "+refs/heads/*:refs/remotes/ember-port/*", "HEAD"],
            cwd=workdir, capture_output=True, text=True, timeout=120)
        if fetch.returncode != 0:
            logger.warning("bundle_fetch_refs_failed", extra={"err": fetch.stderr.strip()[:200]})
            return False
        # FETCH_HEAD is the bundle's HEAD (the laptop's tip). Land it on a NAMED
        # branch (-B = create or reset) so the workspace isn't on a detached HEAD —
        # checkpoint reads a real branch name and pull-home can fast-forward it.
        local_branch = _safe_branch_name(branch)
        co = subprocess.run(["git", "checkout", "-B", local_branch, "FETCH_HEAD"], cwd=workdir,
                            capture_output=True, text=True, timeout=60)
        if co.returncode != 0:
            logger.warning("bundle_checkout_failed", extra={"err": co.stderr.strip()[:200]})
            return False
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as f:
            f.write(s3_key)
        logger.info("bundle_applied", extra={"key": s3_key, "branch": local_branch})
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("bundle_apply_failed", extra={"error": str(exc)[:200]})
        return False
    finally:
        try:
            os.remove(bundle_path)
        except OSError:
            pass


def _selfcontained_workspace(session_id: str | None) -> str | None:
    """Path of an already-rebuilt self-contained repo for this session, or None.

    Self-contained ports live at `<session>/workspace` (a fixed name, NOT a
    repo-slug), set by _rebuild_from_bundle. Later turns/checkpoint omit
    git_mode + resume_bundle and carry no repo, so we detect the warm workspace
    by its .git rather than relying on the caller re-sending the handoff fields."""
    if not session_id:
        return None
    wd = os.path.join(_session_dir(session_id), "workspace")
    return wd if os.path.isdir(os.path.join(wd, ".git")) else None


def _rebuild_from_bundle(s3_key: str, session_id: str | None,
                         branch: str | None = None) -> str:
    """Self-contained mode: rebuild a STANDALONE repo from a `git bundle --all`
    the laptop shipped (no origin, no clone). `git clone <bundle>` reconstructs
    every branch + the full history into the session's EFS workspace; we then land
    on a named branch so the agent works on a real branch (and pull-home works).

    Idempotent + warm-safe: if the workspace already has a .git (a warm microVM, or
    the pre-warm pass already rebuilt it), reuse it. Returns the workdir.

    Raises on a missing/corrupt bundle — unlike bundle mode (which can fall back to
    the clean clone), self-contained has NO other source for the code, so a failure
    here is a real setup error the caller surfaces as 500."""
    base = _session_dir(session_id)
    wd = os.path.join(base, "workspace")
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("selfcontained_warm")
        return wd
    if not (s3_key and ARTIFACT_BUCKET):
        raise RuntimeError("self-contained port is missing its bundle (no resume_bundle/bucket)")
    os.makedirs(base, exist_ok=True)

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
    raw = obj["Body"].read()
    bundle_path = os.path.join(base, ".ember-all.bundle")
    try:
        with open(bundle_path, "wb") as f:
            f.write(raw)
        # Clone the bundle → a real repo with all refs; HEAD is the laptop's tip.
        # (No separate `git bundle verify`: that needs to run inside a repo, which
        # the runtime cwd isn't — and clone validates the bundle anyway, failing
        # cleanly with the same diagnostic on a corrupt/truncated file.)
        clone = subprocess.run(["git", "clone", bundle_path, wd],
                               capture_output=True, text=True, timeout=300)
        if clone.returncode != 0:
            raise RuntimeError(f"bundle clone failed: {clone.stderr.strip()[:300]}")
        # Drop the 'origin' the clone set to the local bundle file (it's gone after
        # this function) so the workspace is truly standalone — `git remote add`
        # later won't collide, and nothing points at a vanished path.
        subprocess.run(["git", "remote", "remove", "origin"], cwd=wd,
                       capture_output=True, text=True, timeout=30)
        # Land on a NAMED branch (the bundle clone may be detached on HEAD).
        local_branch = _safe_branch_name(branch)
        subprocess.run(["git", "checkout", "-B", local_branch], cwd=wd,
                       capture_output=True, text=True, timeout=60)
        logger.info("selfcontained_rebuilt", extra={"branch": local_branch})
        return wd
    finally:
        try:
            os.remove(bundle_path)
        except OSError:
            pass


def _checkout_branch(workdir: str, branch: str) -> None:
    """Fetch + check out the branch the laptop pushed its in-flight work to.
    Best-effort: a fresh clone lands on the default branch, so we move to the
    ported branch before the agent resumes. Non-fatal if it fails (agent can
    recover via its own git tools)."""
    if not os.path.isdir(os.path.join(workdir, ".git")):
        return
    safe = branch.strip()
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", safe or ""):
        logger.warning("checkout_branch_rejected", extra={"branch": branch[:60]})
        return
    subprocess.run(["git", "fetch", "origin", safe], cwd=workdir,
                   capture_output=True, text=True, timeout=120)
    res = subprocess.run(["git", "checkout", safe], cwd=workdir,
                         capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        logger.warning("checkout_branch_failed", extra={"branch": safe, "err": res.stderr.strip()[:200]})
    else:
        logger.info("checkout_branch_ok", extra={"branch": safe})


# ─── CLI runners ──────────────────────────────────────────────────────────────


def _claude_env_and_model(config_dir: str, auth_mode: str, user_id: str | None,
                          tenant_id: str | None = None) -> tuple[dict, str | None]:
    """Build the env + model for a Claude turn given the auth mode.

    bedrock (default): CLAUDE_CODE_USE_BEDROCK=1, Bedrock model id.
    subscription: CLAUDE_CODE_OAUTH_TOKEN from the user's uploaded token, with
      Bedrock + any ANTHROPIC_* override stripped (they'd shadow the OAuth path),
      and a subscription-valid model name. Returns (env, model_or_None) — model
      None means "omit --model" (let the account default win)."""
    base = {**os.environ, "CLAUDE_CONFIG_DIR": config_dir}
    if auth_mode == "subscription":
        cred = _fetch_subscription_cred(user_id, "claude", tenant_id) or {}
        token = cred.get("token") or cred.get("oauth_token")
        if not token:
            raise RuntimeError(
                "subscription mode selected but no Claude token uploaded — "
                "run the login step (claude setup-token) on your laptop first")
        env = {k: v for k, v in base.items()
               if k not in ("CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY",
                            "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN")}
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
        return env, CLAUDE_SUB_MODEL
    return {**base, "CLAUDE_CODE_USE_BEDROCK": "1"}, CLAUDE_MODEL


def _run_claude(prompt: str, workdir: str, claude_session_id: str | None,
                auth_mode: str = "bedrock", user_id: str | None = None,
                tenant_id: str | None = None) -> dict:
    """Run one Claude Code turn. Resume the conversation when a prior
    claude_session_id is supplied (same microVM keeps its ~/.claude state)."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)

    env, model = _claude_env_and_model(config_dir, auth_mode, user_id, tenant_id)
    # `claude --print` does NOT auto-load a project .mcp.json (needs interactive
    # approval). _build_claude_args passes --mcp-config explicitly; it's variadic,
    # so the positional prompt must come last (appended here).
    args = _build_claude_args(config_dir, claude_session_id, stream=False, model=model) + [prompt]

    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    try:
        parsed = json.loads(proc.stdout)
        return {"response": parsed.get("result", proc.stdout.strip()),
                "claude_session_id": parsed.get("session_id")}
    except json.JSONDecodeError:
        return {"response": proc.stdout.strip(), "claude_session_id": None}


def _build_claude_args(config_dir: str, claude_session_id: str | None, stream: bool,
                       model: str | None = CLAUDE_MODEL) -> list:
    """Shared argv for a Claude turn. stream=True emits realtime stream-json.
    model=None omits --model (subscription account default wins)."""
    args = ["claude", "--print"]
    mcp_config = os.path.join(config_dir, ".mcp.json")
    if os.path.isfile(mcp_config):
        args += ["--mcp-config", mcp_config]
    args += ["--dangerously-skip-permissions",
             "--max-turns", os.environ.get("MAX_TURNS", "100")]
    if model:
        args += ["--model", model]
    if stream:
        # --include-partial-messages emits token-level content_block_delta frames
        # (without it, claude sends whole message blocks → one chunk at the end).
        args += ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    else:
        args += ["--output-format", "json"]
    if claude_session_id:
        args += ["--resume", claude_session_id]
    return args


def _stream_claude(prompt: str, workdir: str, claude_session_id: str | None, repo: str | None = None,
                   auth_mode: str = "bedrock", user_id: str | None = None,
                   runtime_session_id: str | None = None, tenant_id: str | None = None):
    """Generator yielding SSE lines for a Claude turn as it runs.

    Parses claude stream-json line-by-line: assistant text deltas → 'text'
    events, the final 'result' → a terminal 'done' event carrying the full text
    and the claude session id (for resume). The UI renders text incrementally.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)

    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    try:
        env, model = _claude_env_and_model(config_dir, auth_mode, user_id, tenant_id)
    except RuntimeError as exc:
        yield sse({"type": "error", "error": str(exc)})
        yield sse({"type": "done", "response": f"⚠ {exc}", "claude_session_id": claude_session_id})
        return
    args = _build_claude_args(config_dir, claude_session_id, stream=True, model=model) + [prompt]

    proc = subprocess.Popen(args, cwd=workdir, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL, bufsize=1)
    new_session_id: str | None = claude_session_id
    full_text: list[str] = []
    block_has_text = False  # did the current text block emit anything?
    try:
        for line in proc.stdout:  # line-buffered: yields as claude emits
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "system" and obj.get("subtype") == "init" and obj.get("session_id"):
                new_session_id = obj["session_id"]
            elif t == "stream_event":
                ev = obj.get("event", {})
                et = ev.get("type")
                if et == "content_block_delta":
                    delta = ev.get("delta", {})
                    txt = delta.get("text")  # ignore thinking deltas
                    if txt:
                        full_text.append(txt)
                        block_has_text = True
                        yield sse({"type": "text", "text": txt})
                elif et == "content_block_stop" and block_has_text:
                    # Each text block is a distinct assistant message (often with
                    # a tool call between them). Separate with a blank line so the
                    # UI renders paragraphs, not run-on sentences.
                    block_has_text = False
                    full_text.append("\n\n")
                    yield sse({"type": "text", "text": "\n\n"})
            elif t == "result":
                if not full_text and isinstance(obj.get("result"), str):
                    full_text.append(obj["result"])
                    yield sse({"type": "text", "text": obj["result"]})
                if obj.get("session_id"):
                    new_session_id = obj["session_id"]
        proc.wait(timeout=30)
    except Exception as exc:  # noqa: BLE001
        yield sse({"type": "error", "error": str(exc)[:600]})
        return
    if proc.returncode not in (0, None):
        err = (proc.stderr.read() or "")[:600] if proc.stderr else ""
        yield sse({"type": "error", "error": f"claude exited {proc.returncode}: {err}"})
        return
    # Persist {claude_session_id → repo} so a later resume recovers the cwd.
    _remember_session(new_session_id, repo)
    # Update the Terminal resume hint now the id is known (new chats learn it
    # here), so opening the Terminal for this session auto-resumes the conversation.
    if new_session_id:
        _write_resume_launch_hint(workdir, new_session_id, runtime_session_id)
    yield sse({"type": "done", "response": "".join(full_text), "claude_session_id": new_session_id})


def _run_codex(prompt: str, workdir: str, codex_session_id: str | None,
               auth_mode: str = "bedrock", user_id: str | None = None,
               tenant_id: str | None = None, codex_home: str | None = None) -> dict:
    """Run one Codex turn. Default routes through the Mantle launcher (GPT-5.5);
    auth_mode="subscription" uses the user's ChatGPT plan via a materialized
    ~/.codex/auth.json + the default OpenAI provider. Resumes the prior
    conversation when codex_session_id (a codex thread_id) is supplied.

    codex_home pins the per-session CODEX_HOME so this turn's rollout history is
    isolated from sibling sessions (and run-codex.sh records into it).

    We surface codex's thread_id through the same `claude_session_id` field the
    server returns, so the caller's resume handle is CLI-agnostic."""
    env = {**os.environ, "WORKSPACE_DIR": workdir}
    if codex_home:
        env["CODEX_HOME"] = codex_home
    if auth_mode == "subscription":
        if not _materialize_codex_auth(user_id, tenant_id):
            raise RuntimeError(
                "subscription mode selected but no Codex auth uploaded — "
                "run the login step (codex login) on your laptop first")
        # CODEX_AUTH_MODE tells run-codex.sh to use the default OpenAI provider
        # (ChatGPT plan) instead of the Bedrock Mantle provider block.
        env["CODEX_AUTH_MODE"] = "subscription"
        env["CODEX_SUB_MODEL"] = CODEX_SUB_MODEL
    args = ["/app/run-codex.sh", prompt]
    if codex_session_id:
        args.append(codex_session_id)
    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"codex exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    # codex exec --json emits JSONL. Pull the thread_id (resume handle) and the
    # final assistant text. New shape:
    #   {"type":"thread.started","thread_id":"..."}
    #   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    # Older builds: {"msg":{"type":"agent_message","message":"..."}}.
    text = proc.stdout.strip()
    thread_id: str | None = codex_session_id
    found_text = False
    for line in proc.stdout.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "thread.started" and obj.get("thread_id"):
            thread_id = obj["thread_id"]
        item = obj.get("item") or obj.get("msg") or obj
        if item.get("type") == "agent_message":
            msg = item.get("text") or item.get("message")
            if msg:
                text = msg
                found_text = True
    if not found_text:
        text = proc.stdout.strip()
    return {"response": text, "claude_session_id": thread_id}


def _run_kiro(prompt: str, workdir: str, kiro_session_id: str | None,
              user_id: str | None = None, tenant_id: str | None = None,
              kiro_home: str | None = None) -> dict:
    """Run one Kiro turn. Kiro is bring-your-own-key only (no Bedrock): the turn
    runs on the user's uploaded KIRO_API_KEY access key. Resumes the prior
    conversation when kiro_session_id (a kiro conversation uuid) is supplied.

    kiro_home pins the per-session KIRO_HOME so this turn's SQLite session store
    is isolated from sibling sessions. We surface kiro's conversation_id through
    the same `claude_session_id` field for a CLI-agnostic resume handle. Kiro chat
    has no JSON output, so we parse plain stdout and learn the conversation_id by
    reading the newest conversations_v2 row for this workdir after the turn."""
    cred = _fetch_subscription_cred(user_id, "kiro", tenant_id) or {}
    api_key = cred.get("token") or cred.get("api_key") or cred.get("access_key")
    if not api_key:
        raise RuntimeError(
            "no Kiro access key uploaded — run the login step on your laptop "
            "(login_cli kiro). Kiro has no Bedrock fallback.")
    home = kiro_home or KIRO_HOME
    os.makedirs(home, exist_ok=True)
    # Kiro's session DB follows $XDG_DATA_HOME/kiro-cli/, not $KIRO_HOME — pin both
    # so the per-session store is isolated AND lands where _kiro_db_path looks.
    env = {**os.environ, "KIRO_HOME": home, "XDG_DATA_HOME": home, "KIRO_API_KEY": api_key}

    args = ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools"]
    if KIRO_MODEL:
        args += ["--model", KIRO_MODEL]
    if kiro_session_id:
        args += ["--resume-id", kiro_session_id]
    args.append(prompt)

    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"kiro exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    text = proc.stdout.strip()
    # Learn the resume id: on a new turn it's the newest row for this cwd; on a
    # resume it stays the id we passed.
    conv_id = kiro_session_id or _kiro_newest_id(workdir, home)
    return {"response": text, "claude_session_id": conv_id}


# ─── Server ───────────────────────────────────────────────────────────────────

app = FastAPI()


def _cli_is_running(proc_root: str = "/proc") -> bool:
    try:
        pids = os.listdir(proc_root)
    except OSError:
        return False
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, pid, "cmdline"), "rb") as f:
                raw = f.read()
        except OSError:
            continue
        if not raw:
            continue
        exe = raw.split(b"\x00", 1)[0].decode(errors="replace").rsplit("/", 1)[-1]
        if exe in _CODING_PROC_NAMES:
            return True
    return False


@app.get("/ping")
@app.get("/health")
async def health():
    status = "HealthyBusy" if _cli_is_running() else "Healthy"
    return JSONResponse({"status": status, "time_of_last_update": int(time.time())})


@app.post("/invocations")
async def invocations(request: Request):
    """Run one coding turn.

    Payload: { prompt (required), repo?, cli? (claude|codex), claude_session_id?,
               user_id?, config_version? }
    Returns: { response, claude_session_id, cli, workspace }  (or { error })
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    # Pre-warm: clone + checkout + install the transcript on the microVM NOW, so
    # opening the session later is instant (no prompt runs). Fired by the port
    # route right after the transcript is uploaded.
    warm = bool(payload.get("warm"))
    # Checkpoint: upload the grown transcript back to S3 so the laptop can pull
    # the session home (the round-trip / "unpark"). No prompt, no clone needed
    # beyond locating the existing workspace.
    checkpoint = bool(payload.get("checkpoint"))
    # Prepare: config-only. Materialize the user's bundle (skills/agents/.mcp.json)
    # + default MCP into the shared config dir, then return. No clone, no CLI. The
    # /shell route fires this before handing the browser a presigned PTY URL, so a
    # terminal-only session (which never hits a chat turn) still gets skills + MCP.
    prepare = bool(payload.get("prepare"))
    # Purge: reclaim the session's EFS dir + S3 artifacts when the user deletes it
    # in the UI, so what they see (gone) matches the backend reality. No clone, no
    # CLI, no config — handled up front before any workspace setup runs.
    purge = bool(payload.get("purge"))
    if purge:
        sid = payload.get("session_id")
        if not sid:
            return JSONResponse({"error": "purge needs a session id"}, status_code=400)
        return JSONResponse({"purged": True, **_purge_session(
            sid, payload.get("claude_session_id"), (payload.get("cli") or "claude").lower(),
            payload.get("tenant_id"))})

    prompt = (payload.get("prompt") or "").strip()
    if not prompt and not warm and not checkpoint and not prepare:
        return JSONResponse({"error": "prompt is required"}, status_code=400)

    cli = (payload.get("cli") or DEFAULT_CLI).lower()
    repo = payload.get("repo")
    claude_session_id = payload.get("claude_session_id")
    user_id = payload.get("user_id")
    # Tenant (company) — scopes every S3 key this turn touches (config/auth fetch,
    # checkpoint upload). Absent on legacy/no-auth callers → "default".
    tenant_id = payload.get("tenant_id")
    # Auth mode: "bedrock" (default) or "subscription" (user's own Pro/ChatGPT plan).
    auth_mode = (payload.get("auth_mode") or "bedrock").lower()
    config_version = payload.get("config_version")
    session_id = payload.get("session_id")  # isolates this session's checkout
    # Per-Ember-session CODEX_HOME so a codex thread resumed into two different
    # sessions can't share one rollout tree (see _codex_home_for). Cheap no-op for
    # claude turns; computed once and threaded into every codex helper below.
    codex_home = _codex_home_for(session_id) if cli == "codex" else None
    # Per-Ember-session KIRO_HOME (isolated SQLite session store); no-op for others.
    kiro_home = _kiro_home_for(session_id) if cli == "kiro" else None
    # Repopulate the private /tmp resume hint from the durable per-session copy if
    # this microVM was recycled — so even a config-only prepare (non-ported
    # session) leaves the Terminal able to auto-resume the conversation.
    _restore_resume_launch_hint(session_id)
    stream = bool(payload.get("stream"))  # SSE incremental output (claude only)
    # "Port to cloud": a real laptop transcript shipped via S3 for a native,
    # lossless `claude --resume`. resume_session_id is the id INSIDE that file.
    resume_transcript = payload.get("resume_transcript")  # s3 key
    resume_session_id = payload.get("resume_session_id")
    branch = payload.get("branch")  # checkout this branch before the turn
    # Flexible git handoff (port-session MCP): git_mode is pushed|bundle|selfContained|none.
    #   clone_url     — explicit origin to clone (may be an upstream we can't push to)
    #   resume_bundle — s3 key of a git bundle: commits-on-top (bundle mode) OR a
    #                   whole-repo `bundle --all` to rebuild standalone (selfContained)
    git_mode = payload.get("git_mode")
    clone_url = payload.get("clone_url")
    resume_bundle = payload.get("resume_bundle")

    # On resume, recover the repo the conversation was started in (so we land in
    # the same cwd Claude Code scoped the session to) when the caller omits it.
    if claude_session_id and not repo:
        repo = _load_session_map().get(claude_session_id, {}).get("repo")

    logger.info("turn_start", extra=redact(
        {"cli": cli, "repo": repo, "resume": bool(claude_session_id),
         "stream": stream, "prompt_head": prompt[:120]}))

    # Config materialization is BEST-EFFORT — never turn-fatal. A degraded EFS
    # mount or unwritable config dir would otherwise 500 an otherwise-runnable
    # turn (the CLI can still run against whatever's already on disk). Order:
    # user bundle FIRST (may ship its own .mcp.json / config.toml), THEN our
    # default gateway on top so the always-advertised gateway tools survive.
    config_ok = True
    config_err = ""
    try:
        _apply_config_bundle(user_id, config_version, tenant_id)
        _apply_default_mcp()
        # Pre-answer Claude's first-run prompts (theme picker / trust dialog) so a
        # Terminal session doesn't stall on a TUI prompt that's unanswerable on
        # mobile. Runs on every code path that readies a VM (prepare/warm/turn).
        if cli == "claude":
            _seed_claude_first_run()
    except Exception as exc:  # noqa: BLE001 — config is non-fatal
        config_ok = False
        config_err = str(exc)[:300]
        logger.warning("config_apply_failed", extra={"error": config_err})

    # Subscription creds for the PTY: the /shell prepare materializes the user's
    # token / auth.json to disk so the interactive terminal launches on their
    # plan (the headless chat path reads from S3 per turn instead). Clear them in
    # bedrock mode so a warm VM never inherits a prior subscription session.
    if cli == "kiro":
        # Kiro is always BYO-key (no Bedrock), so materialize the access key for
        # the PTY regardless of auth_mode.
        _materialize_kiro_key(user_id, tenant_id)
    elif auth_mode == "subscription":
        if cli == "claude":
            _materialize_claude_token(user_id, tenant_id)
        elif cli == "codex":
            _materialize_codex_auth(user_id, tenant_id)
    else:
        _clear_subscription_creds()

    # Config-only prepare: the bundle + default MCP are the whole job. Report
    # success/failure but always 200 so the /shell best-effort caller never errors
    # (a stale-mount VM will be replaced; the next turn retries).
    if prepare:
        # A kiro session opened straight in Terminal (no headless turn / ported
        # transcript yet) returns here before any _write_resume_launch_hint call,
        # so the PTY would fall back to the shared deploy-default KIRO_HOME and put
        # its FIRST conversation into a cross-session EFS DB. Pin the per-session
        # home now (no resume id needed) so even that first Terminal turn is
        # isolated. Don't clobber a richer hint already on disk (one with a SID).
        if cli == "kiro" and kiro_home and not os.path.exists(RESUME_HINT_PATH):
            _write_home_hint(session_id, "kiro", kiro_home)
        elif cli == "codex" and codex_home and not os.path.exists(RESUME_HINT_PATH):
            _write_home_hint(session_id, "codex", codex_home)
        # resume_ready: a (restored or prior) /tmp hint means the Terminal will
        # auto-resume this non-ported conversation.
        resume_ready = os.path.exists(RESUME_HINT_PATH)
        logger.info("prepare_done", extra={"user": user_id, "version": config_version,
                                           "auth": auth_mode, "ok": config_ok, "resume_ready": resume_ready})
        return JSONResponse({"prepared": config_ok, "config_error": config_err or None, "resume_ready": resume_ready})

    # Workspace setup IS fatal — no workdir, no turn.
    try:
        _configure_git()
        # Self-contained: no origin — rebuild a standalone repo from the laptop's
        # `bundle --all` (the no-remote / not-a-repo port). The bundle IS the only
        # source of the code, so this replaces the clone entirely.
        if git_mode == "selfContained" and resume_bundle:
            workdir = _rebuild_from_bundle(resume_bundle, session_id, branch=branch)
        elif _selfcontained_workspace(session_id) and not repo and not clone_url:
            # Warm self-contained session on a LATER turn (or checkpoint): the
            # caller only sends git_mode/resume_bundle on the seed turn, and there's
            # no repo to re-derive a slug from. Reuse the standalone repo already on
            # EFS — otherwise _ensure_workspace(None,…) returns the bare session root
            # and the CLI runs OUTSIDE the shipped code (and checkpoint reads the
            # wrong project slug).
            workdir = _selfcontained_workspace(session_id)
            logger.info("selfcontained_warm_reuse")
        else:
            # The repo clone / branch checkout is best-effort WHEN we have a ported
            # transcript to resume: `claude --resume` only needs the .jsonl placed at
            # the cwd's project slug, not a working clone. A clone can legitimately
            # fail — an origin the cloud can't reach (a laptop-local path like
            # /tmp/x.git), a lost upstream, an auth failure. Letting that abort the
            # whole setup means the resume hint is never written and the Terminal
            # opens to a bare shell (the conversation is stranded). So on failure,
            # fall back to a bare per-session workspace and still resume the chat.
            # Fall back for any Claude RESUME, not just the seed turn that ships the
            # transcript. Port resume fields (resume_transcript) are sent only on the
            # first turn; later chat turns send repo + claude_session_id. If the seed
            # turn already fell back to the bare workspace (unreachable upstream), those
            # later turns must reuse it — _ensure_workspace(None, session_id) returns
            # the SAME per-session dir where the transcript was installed — instead of
            # re-attempting the doomed clone and 500ing the now-live conversation.
            can_fallback = cli == "claude" and bool(
                (resume_transcript and resume_session_id) or claude_session_id
            )
            try:
                workdir = _ensure_workspace(repo, session_id, clone_url=clone_url)
                # Bundle mode: clone the upstream (above), then layer the laptop's commits
                # from the uploaded git bundle. Do this BEFORE branch checkout — the bundle
                # detaches onto the laptop's tip, which is the state we want to resume on.
                if git_mode == "bundle" and resume_bundle:
                    _apply_resume_bundle(resume_bundle, workdir, session_id, branch=branch)
                # Land on the ported branch (pushed mode: the laptop's branch on origin).
                elif branch:
                    _checkout_branch(workdir, branch)
            except Exception as exc:  # noqa: BLE001
                if not can_fallback:
                    raise
                workdir = _ensure_workspace(None, session_id)
                logger.warning("workspace_clone_failed_resume_fallback",
                               extra={"clone_url": clone_url, "repo": repo,
                                      "error": str(exc)[:300], "workdir": workdir})
        # Now that the workspace dir is known, pre-accept its trust prompt too
        # (the global seed above can't know the cwd yet). A Terminal `claude
        # --resume` then lands straight in the repo with no trust dialog.
        if cli == "claude":
            _seed_claude_first_run(workdir)
        # Install a ported transcript and resume it natively. On success the turn
        # runs as `claude --resume <id>` / `codex exec resume <id>` — true
        # continuation of the laptop conversation.
        if cli == "claude" and resume_transcript and resume_session_id:
            if _install_resume_transcript(resume_transcript, resume_session_id, workdir,
                                          runtime_session_id=session_id):
                claude_session_id = claude_session_id or resume_session_id
        elif cli == "codex" and resume_transcript and resume_session_id:
            if _install_codex_resume_transcript(resume_transcript, resume_session_id, codex_home):
                claude_session_id = claude_session_id or resume_session_id
        elif cli == "kiro" and resume_transcript and resume_session_id:
            if _install_kiro_resume_transcript(resume_transcript, resume_session_id, workdir, kiro_home):
                claude_session_id = claude_session_id or resume_session_id
        # Hand the interactive Terminal a one-shot launch hint: which dir to cd
        # into and which conversation to `claude --resume`. shell-init.sh reads
        # this on a FRESH shell only (its run-once guard means a PTY reattach to
        # an already-running claude never re-fires), so the resume launches
        # server-side instead of the browser typing it into a live TUI input box.
        resume_ready = False
        if cli == "claude" and claude_session_id:
            resume_ready = _write_resume_launch_hint(workdir, claude_session_id, session_id)
        elif cli == "kiro" and claude_session_id:
            resume_ready = _write_resume_launch_hint(
                workdir, claude_session_id, session_id, cli="kiro", kiro_home=kiro_home)
        elif cli == "codex" and claude_session_id:
            resume_ready = _write_resume_launch_hint(
                workdir, claude_session_id, session_id, cli="codex", codex_home=codex_home)
    except ValueError as ve:  # bad repo field — caller error, not a 500
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        logger.error("turn_setup_failed", extra={"cli": cli, "error": str(exc)[:600]})
        return JSONResponse({"error": str(exc)[:600]}, status_code=500)

    # Checkpoint: upload the grown transcript back to S3 for the laptop to pull.
    # The session id to checkpoint is the resume id (the conversation's real id).
    if checkpoint:
        cp_id = resume_session_id or claude_session_id
        if not cp_id:
            return JSONResponse({"error": "checkpoint needs a session id"}, status_code=400)
        try:
            info = _checkpoint_transcript(cp_id, workdir, tenant_id, cli, codex_home, kiro_home)
        except FileNotFoundError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        except Exception as exc:  # noqa: BLE001
            logger.error("checkpoint_failed", extra={"error": str(exc)[:600]})
            return JSONResponse({"error": str(exc)[:600]}, status_code=500)
        return JSONResponse({"checkpointed": True, **info})

    # Pre-warm done: workspace cloned, branch checked out, transcript installed.
    # No CLI runs — the first real turn (on open) will be instant + warm.
    if warm:
        logger.info("warm_done", extra={"repo": repo, "workspace": workdir, "resume_ready": resume_ready})
        # resume_ready tells /shell whether the Terminal will auto-resume — the
        # browser gates its first-prompt seed on it (no resume → don't fire the
        # seed into a bare shell; leave it pending for a retry).
        return JSONResponse({"warmed": True, "workspace": workdir, "cli": cli, "resume_ready": resume_ready})

    # Streaming path (claude): yield SSE as the turn runs. The runtime forwards
    # an async/sync generator response as text/event-stream through InvokeAgentRuntime.
    if stream and cli == "claude":
        return StreamingResponse(
            _stream_claude(prompt, workdir, claude_session_id, repo, auth_mode, user_id, session_id, tenant_id),
            media_type="text/event-stream",
        )

    try:
        if cli == "codex":
            result = _run_codex(prompt, workdir, claude_session_id, auth_mode, user_id, tenant_id, codex_home)
        elif cli == "kiro":
            result = _run_kiro(prompt, workdir, claude_session_id, user_id, tenant_id, kiro_home)
        elif cli == "claude":
            result = _run_claude(prompt, workdir, claude_session_id, auth_mode, user_id, tenant_id)
        else:
            return JSONResponse({"error": f"unknown cli '{cli}'"}, status_code=400)
    except subprocess.TimeoutExpired:
        logger.error("turn_timeout", extra={"cli": cli, "timeout_s": TURN_TIMEOUT_S})
        return JSONResponse({"error": f"{cli} timed out after {TURN_TIMEOUT_S}s"}, status_code=504)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the caller
        logger.error("turn_failed", extra={"cli": cli, "error": str(exc)[:600]})
        return JSONResponse({"error": str(exc)[:600]}, status_code=500)

    # Persist {claude_session_id → repo} so a later resume recovers the cwd.
    _remember_session(result.get("claude_session_id"), repo)

    # A brand-new chat learns its claude_session_id only now (it was unset on
    # entry, so the pre-run hint above was skipped). Write it here too, so opening
    # the Terminal for this non-ported session also auto-resumes the conversation.
    if cli == "claude" and result.get("claude_session_id"):
        _write_resume_launch_hint(workdir, result["claude_session_id"], session_id)
    elif cli == "kiro" and result.get("claude_session_id"):
        _write_resume_launch_hint(
            workdir, result["claude_session_id"], session_id, cli="kiro", kiro_home=kiro_home)
    elif cli == "codex" and result.get("claude_session_id"):
        _write_resume_launch_hint(
            workdir, result["claude_session_id"], session_id, cli="codex", codex_home=codex_home)

    result.update({"cli": cli, "workspace": workdir})
    logger.info("turn_done", extra={"cli": cli, "chars": len(result.get("response") or "")})
    return JSONResponse(result)


def _export_runtime_env() -> None:
    """Persist AgentCore-injected env vars to a file the interactive PTY shell
    can source. The PTY spawns as a fresh process that does NOT inherit this
    server process's environment, so GITHUB_PAT / model ids / bucket would be
    empty in the Terminal tab. shell-init.sh sources this file.

    The EFS mount can lag the server's startup by a few seconds (writes fail
    with EACCES until it's ready), so retry in a background thread rather than
    block boot or give up on the first failure."""
    import threading

    keys = [
        "GITHUB_PAT", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME",
        "AWS_REGION", "BEDROCK_MANTLE_REGION", "ANTHROPIC_MODEL", "CLAUDE_MODEL",
        "CODEX_MODEL", "KIRO_MODEL", "KIRO_HOME", "ARTIFACT_BUCKET", "WORKSPACE_ROOT",
    ]
    body = "".join(
        f"export {k}={shlex.quote(os.environ[k])}\n" for k in keys if os.environ.get(k)
    )
    path = os.path.join(WORKSPACE_ROOT, ".runtime-env.sh")

    def _writer() -> None:
        for attempt in range(30):  # ~60s of retries for the EFS mount to appear
            try:
                os.makedirs(WORKSPACE_ROOT, exist_ok=True)
                with open(path, "w") as f:
                    f.write(body)
                logger.info("runtime_env_exported", extra={"path": path, "attempt": attempt})
                return
            except OSError:
                time.sleep(2)
        logger.warning("runtime_env_export_failed", extra={"path": path})

    threading.Thread(target=_writer, daemon=True).start()


if __name__ == "__main__":
    _export_runtime_env()
    _bootstrap_collector()
    logger.info("server_starting", extra={"port": 8080, "workspace_root": WORKSPACE_ROOT})
    uvicorn.run(app, host="0.0.0.0", port=8080)
