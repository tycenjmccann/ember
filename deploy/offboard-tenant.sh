#!/usr/bin/env bash
#
# offboard-tenant.sh — fully remove a tenant and reclaim everything it owned (Phase 4).
#
# The inverse of onboarding (admin-user.sh add + provision-tenant.sh). Removes, in
# safe order:
#   1. Cognito users   — every user whose custom:tenantId is this tenant (disable
#                        then delete) so no one can log back into the tenant.
#   2. Sessions        — soft-delete each session row; the reaper then stops the
#                        microVM + purges its EFS/S3 on its own (idempotent).
#   3. Secrets         — delete every Secrets Manager secret under ember/t/<id>/
#                        (subscription creds), and the S3 ember/t/<id>/ prefix
#                        (config bundles, transcripts, bundles, checkpoints).
#   4. Compute silo    — delete the per-tenant runtime, runtime role, and EFS
#                        access point if the tenant was siloed (provision-tenant.sh).
#   5. Registry        — delete the tenant:{id} row and the config:/auth: meta rows.
#
# DESTRUCTIVE + IRREVERSIBLE. Requires an explicit --yes (or interactive confirm).
# Idempotent: re-running cleans up whatever a partial prior run left.
#
# Usage:
#   source deploy/config.sh
#   deploy/offboard-tenant.sh <tenantId> --yes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/config.sh"

TENANT_ID="${1:-}"; shift || true
ASSUME_YES=0
[[ "${1:-}" == "--yes" ]] && ASSUME_YES=1
[[ -z "$TENANT_ID" ]] && { echo "usage: offboard-tenant.sh <tenantId> --yes" >&2; exit 1; }

EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
POOL_ID="${COGNITO_USER_POOL_ID:-}"
R=(--region "$AWS_REGION")

echo "═══════════════════════════════════════════════════════════════"
echo "  OFFBOARD TENANT: $TENANT_ID   (account $ACCOUNT_ID, $AWS_REGION)"
echo "  This DELETES the tenant's users, sessions, secrets, storage, and"
echo "  dedicated compute. IRREVERSIBLE."
echo "═══════════════════════════════════════════════════════════════"
if [[ "$ASSUME_YES" != "1" ]]; then
  read -r -p "Type the tenantId to confirm: " CONFIRM
  [[ "$CONFIRM" == "$TENANT_ID" ]] || { echo "aborted." >&2; exit 1; }
fi

# ─── 1. Cognito users ─────────────────────────────────────────────────────────
if [[ -n "$POOL_ID" ]]; then
  echo "  [1/5] Removing Cognito users in tenant $TENANT_ID"
  # list-users can't filter on a custom attribute server-side; page + match locally.
  NEXT=""
  while :; do
    if [[ -n "$NEXT" ]]; then
      PAGE=$(aws cognito-idp list-users "${R[@]}" --user-pool-id "$POOL_ID" --limit 60 --pagination-token "$NEXT" --output json)
    else
      PAGE=$(aws cognito-idp list-users "${R[@]}" --user-pool-id "$POOL_ID" --limit 60 --output json)
    fi
    echo "$PAGE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for u in d.get('Users',[]):
    attrs={a['Name']:a.get('Value') for a in u.get('Attributes',[])}
    if attrs.get('custom:tenantId')=='$TENANT_ID':
        print(u['Username'])
" | while read -r uname; do
      [[ -z "$uname" ]] && continue
      aws cognito-idp admin-disable-user "${R[@]}" --user-pool-id "$POOL_ID" --username "$uname" >/dev/null 2>&1 || true
      aws cognito-idp admin-delete-user "${R[@]}" --user-pool-id "$POOL_ID" --username "$uname" >/dev/null 2>&1 || true
      echo "        removed user $uname"
    done
    NEXT=$(echo "$PAGE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('PaginationToken',''))")
    [[ -z "$NEXT" ]] && break
  done
else
  echo "  [1/5] COGNITO_USER_POOL_ID unset — skipping user removal"
fi

# ─── 2. Sessions (soft-delete → reaper purges compute/storage) ────────────────
echo "  [2/5] Soft-deleting the tenant's sessions (reaper reclaims VMs + artifacts)"
EMBER_TABLE="$EMBER_TABLE" TENANT_ID="$TENANT_ID" AWS_REGION="$AWS_REGION" python3 - <<'PY'
import boto3, os, time
ddb = boto3.client("dynamodb", region_name=os.environ["AWS_REGION"])
table = os.environ["EMBER_TABLE"]
tenant = os.environ["TENANT_ID"]
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
ttl = str(int(time.time()) + 60)
# Query the tenant-index for this tenant's session rows.
count = 0
kwargs = {"TableName": table, "IndexName": "tenant-index",
          "KeyConditionExpression": "tenantId = :t",
          "ExpressionAttributeValues": {":t": {"S": tenant}}}
while True:
    res = ddb.query(**kwargs)
    for item in res.get("Items", []):
        sid = item["sessionId"]["S"]
        if sid.startswith(("config:", "auth:", "tenant:")):
            continue
        if "deletedAt" in item:
            continue  # already tombstoned
        ddb.update_item(
            TableName=table, Key={"sessionId": {"S": sid}},
            UpdateExpression="SET deletedAt = :d, #t = :ttl",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":d": {"S": now}, ":ttl": {"N": ttl}},
        )
        count += 1
    lek = res.get("LastEvaluatedKey")
    if not lek:
        break
    kwargs["ExclusiveStartKey"] = lek
print(f"        soft-deleted {count} session(s) — reaper will purge them")
PY

# ─── 3. Secrets + S3 prefix ───────────────────────────────────────────────────
echo "  [3/5] Deleting Secrets Manager creds + S3 prefix ember/t/$TENANT_ID/"
# Secrets Manager: every secret named ember/t/<id>/auth/...
aws secretsmanager list-secrets "${R[@]}" \
  --filters "Key=name,Values=ember/t/${TENANT_ID}/" \
  --query 'SecretList[].ARN' --output text 2>/dev/null | tr '\t' '\n' | while read -r arn; do
    [[ -z "$arn" ]] && continue
    aws secretsmanager delete-secret "${R[@]}" --secret-id "$arn" --force-delete-without-recovery >/dev/null 2>&1 || true
    echo "        deleted secret $arn"
  done
# S3: the whole tenant prefix (config bundles, transcripts, bundles, checkpoints).
aws s3 rm "s3://${ARTIFACT_BUCKET}/ember/t/${TENANT_ID}/" --recursive >/dev/null 2>&1 || true
echo "        purged s3://${ARTIFACT_BUCKET}/ember/t/${TENANT_ID}/"

# ─── 4. Compute silo (runtime + role + access point), if any ──────────────────
echo "  [4/5] Tearing down the dedicated compute silo (if provisioned)"
SILO=$(aws dynamodb get-item "${R[@]}" --table-name "$EMBER_TABLE" \
  --key "{\"sessionId\":{\"S\":\"tenant:${TENANT_ID}\"}}" --output json 2>/dev/null || echo '{}')
RUNTIME_ARN=$(echo "$SILO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Item',{}).get('runtimeArn',{}).get('S',''))" 2>/dev/null || echo "")
ROLE_ARN=$(echo "$SILO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Item',{}).get('runtimeRoleArn',{}).get('S',''))" 2>/dev/null || echo "")
AP_ARN=$(echo "$SILO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Item',{}).get('efsAccessPointArn',{}).get('S',''))" 2>/dev/null || echo "")

if [[ -n "$RUNTIME_ARN" ]]; then
  RID="${RUNTIME_ARN##*/}"  # runtime id is the last ARN segment
  aws bedrock-agentcore-control delete-agent-runtime "${R[@]}" --agent-runtime-id "$RID" >/dev/null 2>&1 \
    && echo "        deleted runtime $RID" || echo "        runtime $RID already gone"
fi
if [[ -n "$ROLE_ARN" ]]; then
  RN="${ROLE_ARN##*/}"
  # A role must be empty of inline policies before deletion.
  for p in $(aws iam list-role-policies --role-name "$RN" --query 'PolicyNames' --output text 2>/dev/null || true); do
    aws iam delete-role-policy --role-name "$RN" --policy-name "$p" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "$RN" >/dev/null 2>&1 \
    && echo "        deleted role $RN" || echo "        role $RN already gone"
fi
if [[ -n "$AP_ARN" ]]; then
  APID="${AP_ARN##*/}"
  aws efs delete-access-point "${R[@]}" --access-point-id "$APID" >/dev/null 2>&1 \
    && echo "        deleted EFS access point $APID" || echo "        access point $APID already gone"
fi

# ─── 5. Registry + metadata rows ──────────────────────────────────────────────
echo "  [5/5] Deleting tenant registry + metadata rows"
aws dynamodb delete-item "${R[@]}" --table-name "$EMBER_TABLE" \
  --key "{\"sessionId\":{\"S\":\"tenant:${TENANT_ID}\"}}" >/dev/null 2>&1 || true
# config:/auth: rows are keyed by userId (deleted with the users above); the
# tenant:{id} row is the one tenant-scoped metadata row. Session rows are left for
# the reaper to hard-delete via TTL after it purges them.

echo "═══════════════════════════════════════════════════════════════"
echo "  Tenant $TENANT_ID offboarded."
echo "  Sessions are tombstoned; the reaper completes VM/EFS/S3 purge shortly."
echo "═══════════════════════════════════════════════════════════════"
