#!/bin/bash
# ─── Register a federated identity provider (SSO) on the Ember pool ───────────
# Lets an employer wire their existing SSO (Okta, Entra/Azure AD, Google, OneLogin,
# Ping, Cloudflare Access, …) into Ember WITHOUT redeploying the app. Cognito sits
# in front of the IdP; the app only ever verifies Cognito tokens, so federated
# users land in their own per-user tenant automatically (keyed to Cognito sub).
#
# It does two things, idempotently:
#   1. Creates/updates the IdP on the user pool (SAML or OIDC).
#   2. Enables that IdP on the web + CLI app clients so it shows in the Hosted UI
#      (the clients ship COGNITO-only; without this the IdP exists but is hidden).
#
# After it runs, users sign in via the Hosted-UI chooser, or jump straight to this
# IdP with a direct link:  https://<deployment>/api/auth/login?idp=<NAME>
#
# Usage:
#   # SAML (Okta, Entra, OneLogin, Ping, Cloudflare Access — metadata URL or file):
#   deploy/cognito/add-idp.sh <NAME> saml  --metadata-url  https://acme.okta.com/app/x/sso/saml/metadata
#   deploy/cognito/add-idp.sh <NAME> saml  --metadata-file ./acme-idp-metadata.xml
#
#   # OIDC (generic OpenID Connect IdP):
#   deploy/cognito/add-idp.sh <NAME> oidc \
#       --client-id <id> --client-secret <secret> --issuer https://acme.example.com
#
#   # Google (social):
#   deploy/cognito/add-idp.sh Google google --client-id <id> --client-secret <secret>
#
# NAME is the provider name users see and pass to ?idp= (letters/digits/_.- , <=32).
# Re-running with the same NAME updates that provider in place.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../config.sh"

POOL_NAME="${COGNITO_POOL_NAME:-ember-users}"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────────────
NAME="${1:-}"; TYPE="${2:-}"; shift 2 2>/dev/null || true
[[ -n "$NAME" && -n "$TYPE" ]] || die "usage: add-idp.sh <NAME> <saml|oidc|google> [options] (see header)"
[[ "$NAME" =~ ^[A-Za-z0-9_.-]{1,32}$ ]] || die "NAME must be letters/digits/_.- and <=32 chars (got '$NAME')"

METADATA_URL=""; METADATA_FILE=""
CLIENT_ID=""; CLIENT_SECRET=""; ISSUER=""
SCOPES="openid email profile"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --metadata-url)   METADATA_URL="$2"; shift 2 ;;
    --metadata-file)  METADATA_FILE="$2"; shift 2 ;;
    --client-id)      CLIENT_ID="$2"; shift 2 ;;
    --client-secret)  CLIENT_SECRET="$2"; shift 2 ;;
    --issuer)         ISSUER="$2"; shift 2 ;;
    --scopes)         SCOPES="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --region "$AWS_REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)
[[ "$POOL_ID" != "None" && -n "$POOL_ID" ]] || die "user pool '$POOL_NAME' not found — run setup-cognito.sh first"

echo "── Registering IdP '$NAME' ($TYPE) on pool $POOL_ID (region $AWS_REGION) ──"

# ── build provider-type + details + attribute mapping per IdP type ────────────
# email mapping is what lets Ember show a friendly identity; sub stays the userId.
ATTR_MAP="email=email"
case "$TYPE" in
  saml)
    PROVIDER_TYPE="SAML"
    if [[ -n "$METADATA_URL" ]]; then
      DETAILS="MetadataURL=${METADATA_URL}"
    elif [[ -n "$METADATA_FILE" ]]; then
      [[ -f "$METADATA_FILE" ]] || die "metadata file not found: $METADATA_FILE"
      # AWS wants the XML inline as MetadataFile; read it in.
      META_XML="$(cat "$METADATA_FILE")"
      DETAILS="MetadataFile=${META_XML}"
    else
      die "saml needs --metadata-url or --metadata-file"
    fi
    # SAML assertions commonly carry email at this standard claim URI.
    ATTR_MAP="email=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    ;;
  oidc)
    PROVIDER_TYPE="OIDC"
    [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" && -n "$ISSUER" ]] \
      || die "oidc needs --client-id, --client-secret, --issuer"
    DETAILS="client_id=${CLIENT_ID},client_secret=${CLIENT_SECRET},oidc_issuer=${ISSUER},attributes_request_method=GET,authorize_scopes=${SCOPES}"
    ;;
  google)
    PROVIDER_TYPE="Google"
    [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || die "google needs --client-id and --client-secret"
    DETAILS="client_id=${CLIENT_ID},client_secret=${CLIENT_SECRET},authorize_scopes=${SCOPES}"
    ;;
  *) die "type must be saml | oidc | google (got '$TYPE')" ;;
esac

# ── 1. create or update the IdP ───────────────────────────────────────────────
if aws cognito-idp describe-identity-provider --user-pool-id "$POOL_ID" \
     --provider-name "$NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Updating existing IdP '$NAME'..."
  aws cognito-idp update-identity-provider --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
    --provider-name "$NAME" \
    --provider-details "$DETAILS" \
    --attribute-mapping "$ATTR_MAP" >/dev/null
else
  echo "Creating IdP '$NAME'..."
  aws cognito-idp create-identity-provider --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
    --provider-name "$NAME" --provider-type "$PROVIDER_TYPE" \
    --provider-details "$DETAILS" \
    --attribute-mapping "$ATTR_MAP" >/dev/null
fi

# ── 2. enable the IdP on each app client (additively — keep COGNITO + others) ──
enable_on_client() {
  local client_name="$1"
  local client_id
  client_id=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
    --max-results 60 --query "UserPoolClients[?ClientName=='${client_name}'].ClientId | [0]" --output text)
  [[ "$client_id" != "None" && -n "$client_id" ]] || { echo "  (skip: client '$client_name' not found)"; return; }

  # Read current providers, add NAME if absent, write the union back. We must
  # re-send the OAuth flow/scope/callback config or update would blank it.
  local current
  current=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" \
    --client-id "$client_id" --region "$AWS_REGION" \
    --query 'UserPoolClient.SupportedIdentityProviders' --output text)
  if echo "$current" | tr '\t' '\n' | grep -qx "$NAME"; then
    echo "  $client_name: already has '$NAME'"
    return
  fi
  # shellcheck disable=SC2206
  local providers=($current $NAME)
  echo "  $client_name: enabling [${providers[*]}]"
  # shellcheck disable=SC2068
  aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \
    --client-id "$client_id" --region "$AWS_REGION" \
    --supported-identity-providers ${providers[@]} >/dev/null
}

enable_on_client "ember-web"
enable_on_client "ember-cli"

DEPLOY_URL="${DEPLOYMENT_URL:-https://<your-deployment>}"
cat <<EOF

── IdP '$NAME' ready ────────────────────────────────────────────────────────
Users can now sign in with $NAME from the Hosted-UI chooser, or jump straight in:

  ${DEPLOY_URL%/}/api/auth/login?idp=${NAME}

Notes:
- SAML/OIDC federation requires the Cognito Essentials tier or higher (not Lite).
- On the IdP side, set the ACS / redirect URL to:
    ${COGNITO_DOMAIN:-https://<pool-domain>}/oauth2/idpresponse
- Federated users get their own per-user tenant automatically. To group a whole
  company into one shared tenant, add a Pre-Token-Generation Lambda (see docs/SSO.md).
────────────────────────────────────────────────────────────────────────────────
EOF
