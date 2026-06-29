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
    --query 'UserPoolClient.ClientId' --output text)
else
  echo "Reusing app client ${CLIENT_ID} (updating callback URLs)..."
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --region "$AWS_REGION" \
    --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --supported-identity-providers COGNITO \
    --callback-urls "$CALLBACK_URLS" --logout-urls "$LOGOUT_URLS" \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH >/dev/null
fi

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --region "$AWS_REGION" \
  --query 'UserPoolClient.ClientSecret' --output text)

cat <<EOF

── Cognito ready ──────────────────────────────────────────────────────────────
Add these to deploy/.env.local (gitignored), then run deploy/apprunner/deploy.sh:

COGNITO_USER_POOL_ID="${POOL_ID}"
COGNITO_CLIENT_ID="${CLIENT_ID}"
COGNITO_CLIENT_SECRET="${CLIENT_SECRET}"
COGNITO_DOMAIN="${COGNITO_DOMAIN}"

Callback URL registered: ${CALLBACK_URLS}
(If DEPLOYMENT_URL was unset/localhost, rerun this after the first App Runner
deploy so the real URL is registered as a callback.)

Create your first admin:
  deploy/cognito/admin-user.sh add you@company.com --tenant acme --admin
────────────────────────────────────────────────────────────────────────────────
EOF
