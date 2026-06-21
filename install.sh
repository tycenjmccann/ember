#!/usr/bin/env bash
#
# install.sh — stand up Ember in YOUR AWS account, end to end.
#
# Runs the full chain, each step idempotent so you can re-run any time:
#   1. Preflight   — check aws/docker/node, resolve account, enforce guard
#   2. Stores      — DynamoDB table + S3 bucket          (deploy/setup-stores.sh)
#   3. Role        — coding runtime IAM execution role   (setup-coding-runtime-role.sh)
#   4. Network     — default-VPC + EFS workspace         (setup-coding-efs.sh)
#   5. Runtime     — build/push ARM64 image + deploy AgentCore runtime
#   6. Web         — build/push web image + App Runner service
#   7. Persist     — write .env.local with every resolved id/URL
#
# Result: a public App Runner URL serving the Ember UI over a coding runtime
# that lives entirely in your account. Pure-infra cost ~$15-30/mo; LLM is the
# only real variable cost (and $0 marginal if you connect your own Claude/ChatGPT
# plan — see the in-app /cost calculator).
#
# Usage:
#   export AWS_PROFILE=<your-profile>     # creds for the target account
#   ./install.sh                          # full install
#   ./install.sh --skip-runtime           # web only (runtime already deployed)
#   ./install.sh --runtime-only           # backend only, no App Runner web
#
# Optional env (sensible defaults, override in .env.local or the shell):
#   AWS_REGION            default us-east-1
#   EMBER_TABLE      default ember-sessions
#   ARTIFACT_BUCKET       default ember-artifacts-<account>-<region>
#   GITHUB_PAT            (optional) for private-repo clone/push from the runtime
#   EXPECTED_ACCOUNT_ID   (optional) refuse to deploy to any other account

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

SKIP_RUNTIME=0
RUNTIME_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-runtime) SKIP_RUNTIME=1 ;;
    --runtime-only) RUNTIME_ONLY=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

step() { echo ""; echo "═══════════════════════════════════════════════════════════════"; echo "  $1"; echo "═══════════════════════════════════════════════════════════════"; }

# ─── 1. Preflight ─────────────────────────────────────────────────────────────
step "1/7  Preflight"
for bin in aws docker node npm python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH." >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "ERROR: Docker is not running." >&2; exit 1; }

# config.sh resolves ACCOUNT_ID/AWS_REGION and enforces the account guard.
# shellcheck disable=SC1091
source "$ROOT/deploy/config.sh"

export EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
export ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
echo "  Account: $ACCOUNT_ID   Region: $AWS_REGION"
echo "  Table:   $EMBER_TABLE"
echo "  Bucket:  $ARTIFACT_BUCKET"

# ─── 2. Stores ────────────────────────────────────────────────────────────────
step "2/7  DynamoDB table + S3 bucket"
"$ROOT/deploy/setup-stores.sh"

if [ "$SKIP_RUNTIME" -eq 0 ]; then
  # ─── 3. Runtime IAM role ────────────────────────────────────────────────────
  step "3/7  Coding runtime IAM role"
  # shellcheck disable=SC1091
  source "$ROOT/deploy/coding-agent-runtime/setup-coding-runtime-role.sh"

  # ─── 4. VPC + EFS ───────────────────────────────────────────────────────────
  step "4/7  VPC + EFS workspace"
  "$ROOT/deploy/coding-agent-runtime/setup-coding-efs.sh"

  # ─── 5. Runtime image + AgentCore runtime ───────────────────────────────────
  step "5/7  Build runtime image + deploy AgentCore runtime"
  IMAGE_URI="$("$ROOT/deploy/coding-agent-runtime/build-and-push.sh" latest | awk '/export IMAGE_URI=/{sub(/.*=/,""); print}')"
  if [ -z "${IMAGE_URI:-}" ]; then
    IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/coding-agent-runtime:latest"
  fi
  export IMAGE_URI
  echo "  IMAGE_URI=$IMAGE_URI"
  python3 "$ROOT/deploy/coding-agent-runtime/deploy.py"
  CODING_AGENT_RUNTIME_ARN="$(cat "$ROOT/deploy/coding-agent-runtime/coding-runtime-arn.txt")"
  export CODING_AGENT_RUNTIME_ARN
else
  step "3-5/7  Skipping runtime (--skip-runtime)"
  CODING_AGENT_RUNTIME_ARN="${CODING_AGENT_RUNTIME_ARN:-$(cat "$ROOT/deploy/coding-agent-runtime/coding-runtime-arn.txt" 2>/dev/null || true)}"
fi

# ─── Persist .env.local (so web build + MCP + re-runs share the same ids) ─────
step "Persisting .env.local"
write_env() {
  local key="$1" val="$2"
  [ -z "$val" ] && return 0
  if grep -q "^${key}=" .env.local 2>/dev/null; then
    sed "s|^${key}=.*|${key}=\"${val}\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
  else
    echo "${key}=\"${val}\"" >> .env.local
  fi
}
touch .env.local
write_env AWS_REGION "$AWS_REGION"
write_env EMBER_TABLE "$EMBER_TABLE"
write_env ARTIFACT_BUCKET "$ARTIFACT_BUCKET"
write_env CODING_AGENT_RUNTIME_ARN "${CODING_AGENT_RUNTIME_ARN:-}"
[ -n "${EXPECTED_ACCOUNT_ID:-}" ] && write_env EXPECTED_ACCOUNT_ID "$EXPECTED_ACCOUNT_ID"
chmod 600 .env.local
echo "  wrote .env.local"

if [ "$RUNTIME_ONLY" -eq 1 ]; then
  step "Done (runtime-only)"
  echo "  Backend ready. Run the web UI locally with:  AWS_PROFILE=$AWS_PROFILE npm run dev"
  exit 0
fi

# ─── 6. Web (App Runner) ──────────────────────────────────────────────────────
step "6/7  Build web image + deploy App Runner"
"$ROOT/deploy/apprunner/deploy.sh"

# ─── 7. Smoke test ────────────────────────────────────────────────────────────
# Run ONE real coding turn so a broken deploy fails loudly here (with the cause)
# instead of silently 424-ing on the user's first session. Non-fatal: a cold
# microVM can exceed this check's patience, and the web tier is already up — but
# verify.py prints the actual root cause (no egress / Bedrock access / EFS) when
# it can find one.
if [ "$SKIP_RUNTIME" -eq 0 ]; then
  step "7/7  Smoke test (one real turn)"
  # shellcheck disable=SC1091
  source "$ROOT/.env.local" 2>/dev/null || true
  python3 "$ROOT/deploy/verify.py" || \
    echo "  (smoke test did not pass — see the diagnosis above; the web URL is still live below)"
fi

# ─── Done ──────────────────────────────────────────────────────────────────────
step "Done"
# shellcheck disable=SC1091
source "$ROOT/.env.local" 2>/dev/null || true
echo "  Ember is live → ${DEPLOYMENT_URL:-(see App Runner console)}"
echo ""
echo "  Next:"
echo "    • Open the URL and start a session (Bedrock works out of the box)."
echo "    • To run on your own Claude Pro/Max or ChatGPT plan instead of Bedrock,"
echo "      open Account & sign-in in the app, or use the port-session MCP login."
echo "    • See cost math at  ${DEPLOYMENT_URL:-<url>}/cost"
