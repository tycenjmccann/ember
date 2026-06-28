#!/bin/bash
# ─── Ember admin user management ─────────────────────────────────────────────
# Admin-create-only: there is no self-signup. Admins provision users here.
#
#   admin-user.sh add  <email> --tenant <id> [--admin] [--name "Full Name"]
#   admin-user.sh list [--tenant <id>]
#   admin-user.sh disable <email>
#   admin-user.sh delete  <email>
#   admin-user.sh set-tenant <email> <tenantId>
#
# `add` creates the user with custom:tenantId set and emails them a temporary
# password (Cognito's default invite flow). --admin also puts them in the admin
# group. Requires COGNITO_USER_POOL_ID in env or deploy/.env.local.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../config.sh"

POOL_ID="${COGNITO_USER_POOL_ID:-}"
if [[ -z "$POOL_ID" ]]; then
  echo "ERROR: COGNITO_USER_POOL_ID not set. Run deploy/cognito/setup-cognito.sh first" >&2
  echo "       and add the COGNITO_* values to deploy/.env.local." >&2
  exit 1
fi
R=(--user-pool-id "$POOL_ID" --region "$AWS_REGION")

cmd="${1:-}"; shift || true

case "$cmd" in
  add)
    email="${1:-}"; shift || true
    tenant=""; admin=0; name=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tenant) tenant="$2"; shift 2;;
        --admin)  admin=1; shift;;
        --name)   name="$2"; shift 2;;
        *) echo "unknown flag: $1" >&2; exit 1;;
      esac
    done
    [[ -z "$email" || -z "$tenant" ]] && { echo "usage: add <email> --tenant <id> [--admin] [--name ...]" >&2; exit 1; }

    attrs="Name=email,Value=${email} Name=email_verified,Value=true Name=custom:tenantId,Value=${tenant}"
    [[ -n "$name" ]] && attrs="$attrs Name=name,Value=${name}"
    # shellcheck disable=SC2086
    aws cognito-idp admin-create-user "${R[@]}" \
      --username "$email" --user-attributes $attrs \
      --desired-delivery-mediums EMAIL >/dev/null
    echo "Created ${email} (tenant=${tenant}). Invite email sent with temp password."

    if [[ "$admin" == "1" ]]; then
      aws cognito-idp admin-add-user-to-group "${R[@]}" --username "$email" --group-name admin >/dev/null
      echo "Added ${email} to admin group."
    fi
    ;;

  list)
    tenant=""
    [[ "${1:-}" == "--tenant" ]] && tenant="${2:-}"
    aws cognito-idp list-users "${R[@]}" \
      --query 'Users[].{email:Attributes[?Name==`email`]|[0].Value, tenant:Attributes[?Name==`custom:tenantId`]|[0].Value, status:UserStatus, enabled:Enabled}' \
      --output table | { [[ -n "$tenant" ]] && grep -i "$tenant" || cat; }
    ;;

  disable)
    email="${1:?usage: disable <email>}"
    aws cognito-idp admin-disable-user "${R[@]}" --username "$email" >/dev/null
    echo "Disabled ${email}."
    ;;

  delete)
    email="${1:?usage: delete <email>}"
    aws cognito-idp admin-delete-user "${R[@]}" --username "$email" >/dev/null
    echo "Deleted ${email}."
    ;;

  set-tenant)
    email="${1:?usage: set-tenant <email> <tenantId>}"
    tenant="${2:?usage: set-tenant <email> <tenantId>}"
    aws cognito-idp admin-update-user-attributes "${R[@]}" \
      --username "$email" --user-attributes "Name=custom:tenantId,Value=${tenant}" >/dev/null
    echo "Set ${email} tenant=${tenant}. (User must re-login for a new token.)"
    ;;

  *)
    echo "usage: admin-user.sh {add|list|disable|delete|set-tenant} ..." >&2
    exit 1;;
esac
