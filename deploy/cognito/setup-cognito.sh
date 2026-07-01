#!/bin/bash
# ─── Ember Cognito user pool (Phase 1 multi-tenant auth) ──────────────────────
# Provisions a Cognito user pool configured ADMIN-CREATE-ONLY (no self-signup),
# a confidential Hosted-UI app client, and a hosted-UI domain. Idempotent: reruns
# reuse the existing pool/client/domain by the Name tag / deterministic ids.
#
# Identity model:
#   - sub                 → Ember userId (the employee)
#   - custom:tenantId     → Ember tenantId (the company / isolation boundary)
#   - cognito:groups      → "admin" gates the admin user-management endpoints
#
# After it runs, the printed COGNITO_* exports go into deploy/.env.local; the App
# Runner deploy overlays them onto the service. Add users with deploy/cognito/admin-user.sh.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../config.sh"

POOL_NAME="${COGNITO_POOL_NAME:-ember-users}"
CLIENT_NAME="ember-web"
# Hosted-UI domain prefix must be globally unique in the region; derive from the
# account so two deployers don't collide. Override with COGNITO_DOMAIN_PREFIX.
DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-ember-${ACCOUNT_ID}}"
CALLBACK_BASE="${DEPLOYMENT_URL:-http://localhost:3000}"
CALLBACK_BASE="${CALLBACK_BASE%/}"

echo "── Cognito setup (region $AWS_REGION, account $ACCOUNT_ID) ──"

# ── 1. User pool (admin-create-only) ─────────────────────────────────────────
POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --region "$AWS_REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)

if [[ "$POOL_ID" == "None" || -z "$POOL_ID" ]]; then
  echo "Creating user pool ${POOL_NAME}..."
  POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" --region "$AWS_REGION" \
    --admin-create-user-config '{"AllowAdminCreateUserOnly":true}' \
    --auto-verified-attributes email \
    --username-attributes email \
    --schema '[{"Name":"tenantId","AttributeDataType":"String","Mutable":true,"Required":false,"StringAttributeConstraints":{"MinLength":"1","MaxLength":"128"}}]' \
    --policies '{"PasswordPolicy":{"MinimumLength":12,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true}}' \
    --query 'UserPool.Id' --output text)
else
  echo "Reusing user pool ${POOL_ID} (ensuring admin-create-only)..."
  aws cognito-idp update-user-pool --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
    --admin-create-user-config '{"AllowAdminCreateUserOnly":true}' \
    --auto-verified-attributes email >/dev/null
fi

# ── 2. admin group (gates user-management endpoints) ─────────────────────────
aws cognito-idp get-group --user-pool-id "$POOL_ID" --group-name admin --region "$AWS_REGION" >/dev/null 2>&1 || \
  aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name admin --region "$AWS_REGION" \
    --description "Ember administrators (manage users)" >/dev/null

# ── 3. Hosted-UI domain ──────────────────────────────────────────────────────
EXISTING_DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
  --query 'UserPool.Domain' --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_DOMAIN" == "None" || -z "$EXISTING_DOMAIN" ]]; then
  echo "Creating Hosted-UI domain ${DOMAIN_PREFIX}..."
  aws cognito-idp create-user-pool-domain --domain "$DOMAIN_PREFIX" \
    --user-pool-id "$POOL_ID" --region "$AWS_REGION" >/dev/null
  DOMAIN_PREFIX_FINAL="$DOMAIN_PREFIX"
else
  echo "Reusing Hosted-UI domain ${EXISTING_DOMAIN}..."
  DOMAIN_PREFIX_FINAL="$EXISTING_DOMAIN"
fi
COGNITO_DOMAIN="https://${DOMAIN_PREFIX_FINAL}.auth.${AWS_REGION}.amazoncognito.com"

# Token lifetimes — default to "stay logged in". The web app pairs these with a
# refresh-token cookie + transparent middleware refresh, so the only real ceiling
# is the refresh token (Cognito max: 10y/3650d). id/access run 24h between silent
# refreshes. Applied to BOTH clients so the CLI's id-token also auto-refreshes.
TOKEN_VALIDITY=(--refresh-token-validity 3650 --access-token-validity 24 --id-token-validity 24
  --token-validity-units RefreshToken=days,AccessToken=hours,IdToken=hours)

# A rerun must NOT drop federated IdPs added later via add-idp.sh. update-user-pool-client
# replaces the whole client, so when we reuse a client we re-send the UNION of its
# current providers with COGNITO instead of COGNITO alone. Echoes a space-separated list.
client_idps_union() {
  local client_id="$1" current p out="COGNITO"
  current=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" \
    --client-id "$client_id" --region "$AWS_REGION" \
    --query 'UserPoolClient.SupportedIdentityProviders' --output text 2>/dev/null || true)
  for p in $current; do [[ "$p" == "COGNITO" || "$p" == "None" || -z "$p" ]] || out="$out $p"; done
  echo "$out"
}

# ── 4. Confidential app client (auth-code flow, with secret) ─────────────────
CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
  --max-results 60 --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)

CALLBACK_URLS="${CALLBACK_BASE}/api/auth/callback"
LOGOUT_URLS="${CALLBACK_BASE}/login"

if [[ "$CLIENT_ID" == "None" || -z "$CLIENT_ID" ]]; then
  echo "Creating app client ${CLIENT_NAME}..."
  CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" --client-name "$CLIENT_NAME" --region "$AWS_REGION" \
    --generate-secret \
    --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --supported-identity-providers COGNITO \
    --callback-urls "$CALLBACK_URLS" --logout-urls "$LOGOUT_URLS" \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    "${TOKEN_VALIDITY[@]}" \
    --query 'UserPoolClient.ClientId' --output text)
else
  echo "Reusing app client ${CLIENT_ID} (updating callback URLs)..."
  # shellcheck disable=SC2046
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --region "$AWS_REGION" \
    --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --supported-identity-providers $(client_idps_union "$CLIENT_ID") \
    --callback-urls "$CALLBACK_URLS" --logout-urls "$LOGOUT_URLS" \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    "${TOKEN_VALIDITY[@]}" >/dev/null
fi

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --region "$AWS_REGION" \
  --query 'UserPoolClient.ClientSecret' --output text)

# ── 5. Public CLI app client (PKCE, NO secret) for the port-session MCP ───────
# The MCP runs on a laptop, so it can't hold a client secret — it uses a PUBLIC
# client with the authorization-code + PKCE flow and a loopback redirect. This is
# what `/mcp__port-session__auth` drives: opens the Hosted UI, captures the code
# on http://localhost:<port>/callback, exchanges it with PKCE (no secret).
CLI_CLIENT_NAME="ember-cli"
# Loopback ports the MCP may bind; all registered so whichever is free works.
CLI_CALLBACKS="http://localhost:8717/callback http://localhost:8718/callback http://localhost:8719/callback"
CLI_LOGOUTS="http://localhost:8717/logout http://localhost:8718/logout http://localhost:8719/logout"
CLI_CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
  --max-results 60 --query "UserPoolClients[?ClientName=='${CLI_CLIENT_NAME}'].ClientId | [0]" --output text)

if [[ "$CLI_CLIENT_ID" == "None" || -z "$CLI_CLIENT_ID" ]]; then
  echo "Creating public CLI app client ${CLI_CLIENT_NAME}..."
  # shellcheck disable=SC2086
  CLI_CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" --client-name "$CLI_CLIENT_NAME" --region "$AWS_REGION" \
    --no-generate-secret \
    --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --supported-identity-providers COGNITO \
    --callback-urls $CLI_CALLBACKS --logout-urls $CLI_LOGOUTS \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    "${TOKEN_VALIDITY[@]}" \
    --query 'UserPoolClient.ClientId' --output text)
else
  echo "Reusing public CLI app client ${CLI_CLIENT_ID} (updating callbacks)..."
  # shellcheck disable=SC2086
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$POOL_ID" --client-id "$CLI_CLIENT_ID" --region "$AWS_REGION" \
    --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --supported-identity-providers $(client_idps_union "$CLI_CLIENT_ID") \
    --callback-urls $CLI_CALLBACKS --logout-urls $CLI_LOGOUTS \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    "${TOKEN_VALIDITY[@]}" >/dev/null
fi

# ── 6. Ember-branded Managed Login (v2) ──────────────────────────────────────
# Classic Hosted UI (managed-login v1) is the grey AWS default. Upgrade the
# domain to Managed Login v2 and apply the Ember palette (warm night-black page,
# graphite card, ember-orange primary button) to BOTH app clients so the sign-in
# page matches the product. Idempotent: reruns update the existing branding.
echo "Applying Ember Managed Login branding..."
aws cognito-idp update-user-pool-domain --user-pool-id "$POOL_ID" --region "$AWS_REGION" \
  --domain "$DOMAIN_PREFIX_FINAL" --managed-login-version 2 >/dev/null 2>&1 || \
  echo "  (domain already on managed-login v2)"

for BRAND_CLIENT in "$CLIENT_ID" "$CLI_CLIENT_ID"; do
  BRAND_ID=$(aws cognito-idp describe-managed-login-branding-by-client \
    --user-pool-id "$POOL_ID" --client-id "$BRAND_CLIENT" --region "$AWS_REGION" \
    --query 'ManagedLoginBranding.ManagedLoginBrandingId' --output text 2>/dev/null || echo "None")
  if [[ "$BRAND_ID" == "None" || -z "$BRAND_ID" ]]; then
    BRAND_ID=$(aws cognito-idp create-managed-login-branding \
      --user-pool-id "$POOL_ID" --client-id "$BRAND_CLIENT" --region "$AWS_REGION" \
      --use-cognito-provided-values \
      --query 'ManagedLoginBranding.ManagedLoginBrandingId' --output text)
  fi
  # branding.json enables components.form.logo, which only turns ON the logo slot
  # — the image itself is a SEPARATE input (--assets, not --settings). Without it
  # the box shows an empty slot / stale default. Ship the PNG as a FORM_LOGO asset
  # for both color modes so the Ember mark actually renders.
  if [[ -f "$HERE/login-logo.png" ]]; then
    LOGO_B64=$(base64 -i "$HERE/login-logo.png" | tr -d '\n')
    aws cognito-idp update-managed-login-branding \
      --user-pool-id "$POOL_ID" --managed-login-branding-id "$BRAND_ID" --region "$AWS_REGION" \
      --settings "file://$HERE/branding.json" \
      --assets \
        "Category=FORM_LOGO,ColorMode=LIGHT,Extension=PNG,Bytes=$LOGO_B64" \
        "Category=FORM_LOGO,ColorMode=DARK,Extension=PNG,Bytes=$LOGO_B64" >/dev/null
  else
    aws cognito-idp update-managed-login-branding \
      --user-pool-id "$POOL_ID" --managed-login-branding-id "$BRAND_ID" --region "$AWS_REGION" \
      --settings "file://$HERE/branding.json" >/dev/null
  fi
  echo "  branded client ${BRAND_CLIENT} (${BRAND_ID})"
done

cat <<EOF

── Cognito ready ──────────────────────────────────────────────────────────────
Add these to deploy/.env.local (gitignored), then run deploy/apprunner/deploy.sh:

COGNITO_USER_POOL_ID="${POOL_ID}"
COGNITO_CLIENT_ID="${CLIENT_ID}"
COGNITO_CLIENT_SECRET="${CLIENT_SECRET}"
COGNITO_DOMAIN="${COGNITO_DOMAIN}"
COGNITO_CLI_CLIENT_ID="${CLI_CLIENT_ID}"

Callback URL registered: ${CALLBACK_URLS}
(If DEPLOYMENT_URL was unset/localhost, rerun this after the first App Runner
deploy so the real URL is registered as a callback.)

Create your first admin:
  deploy/cognito/admin-user.sh add you@company.com --tenant acme --admin
────────────────────────────────────────────────────────────────────────────────
EOF
