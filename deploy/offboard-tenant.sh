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

# ─── 2. Sessions — purge SYNCHRONOUSLY before any teardown ────────────────────
# We must NOT lean on the TTL reaper here: step 4 deletes the tenant's runtime,
# and the reaper needs that runtime to mount the tenant's EFS for the purge. So
# stop + purge each session inline NOW (same stop-then-purge the reaper does),
# THEN hard-delete the row. After this, no session needs the runtime — step 4 is
# safe. Resolve the tenant's runtime (silo or shared) the same way the app does.
echo "  [2/5] Stopping + purging the tenant's sessions inline (before teardown)"
SILO=$(aws dynamodb get-item "${R[@]}" --table-name "$EMBER_TABLE" \
  --key "{\"sessionId\":{\"S\":\"tenant:${TENANT_ID}\"}}" --output json 2>/dev/null || echo '{}')
TENANT_RUNTIME_ARN=$(echo "$SILO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Item',{}).get('runtimeArn',{}).get('S',''))" 2>/dev/null || echo "")
[[ -z "$TENANT_RUNTIME_ARN" ]] && TENANT_RUNTIME_ARN="${CODING_AGENT_RUNTIME_ARN:-}"

# `|| PURGE_RC=$?` so set -e doesn't abort on the script's intentional exit 2
# (= "some purges deferred to the reaper").
PURGE_RC=0
EMBER_TABLE="$EMBER_TABLE" TENANT_ID="$TENANT_ID" AWS_REGION="$AWS_REGION" \
RUNTIME_ARN="$TENANT_RUNTIME_ARN" python3 - <<'PY' || PURGE_RC=$?
import boto3, json, os, sys, time
region = os.environ["AWS_REGION"]
ddb = boto3.client("dynamodb", region_name=region)
ac = boto3.client("bedrock-agentcore", region_name=region)
table = os.environ["EMBER_TABLE"]
tenant = os.environ["TENANT_ID"]
runtime_arn = os.environ.get("RUNTIME_ARN") or ""
done, failed = 0, 0
kwargs = {"TableName": table, "IndexName": "tenant-index",
          "KeyConditionExpression": "tenantId = :t",
          "ExpressionAttributeValues": {":t": {"S": tenant}}}
while True:
    res = ddb.query(**kwargs)
    for item in res.get("Items", []):
        sid = item["sessionId"]["S"]
        if sid.startswith(("config:", "auth:", "tenant:")):
            continue
        cli = item.get("cli", {}).get("S", "claude")
        conv = item.get("claudeSessionId", {}).get("S")
        purged = False
        if runtime_arn:
            # Stop the live microVM (best-effort), then invoke purge on a fresh VM
            # that re-mounts EFS — rmtree the workspace + delete S3 artifacts.
            try:
                ac.stop_runtime_session(runtimeSessionId=sid, agentRuntimeArn=runtime_arn, qualifier="DEFAULT")
            except Exception:
                pass
            payload = {"purge": True, "session_id": sid, "cli": cli, "tenant_id": tenant}
            if conv:
                payload["claude_session_id"] = conv
            try:
                r = ac.invoke_agent_runtime(
                    agentRuntimeArn=runtime_arn, runtimeSessionId=sid,
                    payload=json.dumps(payload).encode(), contentType="application/json",
                    accept="application/json")
                body = r.get("response")
                raw = body.read() if hasattr(body, "read") else body
                purged = bool(json.loads(raw).get("purged")) if raw else False
            except Exception as exc:
                print(f"        WARN purge {sid}: {type(exc).__name__}: {str(exc)[:160]}")
        if purged:
            # Confirmed reclaimed → safe to hard-delete the row.
            ddb.delete_item(TableName=table, Key={"sessionId": {"S": sid}})
            done += 1
        else:
            # Purge failed / no runtime → DON'T delete. Tombstone + short TTL so the
            # reaper retries the cleanup. The silo teardown below is then skipped,
            # leaving the runtime the reaper needs to mount EFS.
            failed += 1
            ddb.update_item(
                TableName=table, Key={"sessionId": {"S": sid}},
                UpdateExpression="SET deletedAt = :d, #t = :ttl",
                ExpressionAttributeNames={"#t": "ttl"},
                ExpressionAttributeValues={
                    ":d": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                    ":ttl": {"N": str(int(time.time()) + 60)}},
            )
    lek = res.get("LastEvaluatedKey")
    if not lek:
        break
    kwargs["ExclusiveStartKey"] = lek
print(f"        purged + removed {done} session(s); {failed} left for reaper retry")
# Exit 2 signals "some purges deferred" so the script skips silo teardown.
sys.exit(2 if failed else 0)
PY
if [[ "$PURGE_RC" == "2" ]]; then
  PURGE_INCOMPLETE=1
  echo "        ⚠ some sessions could not be purged inline — keeping the tenant"
  echo "          runtime + registry so the reaper can retry. Re-run offboard later."
else
  PURGE_INCOMPLETE=0
fi

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
# Sessions are stopped + CONFIRMED-purged (step 2), so deleting the runtime now
# strands nothing. If any purge was deferred to the reaper, SKIP teardown — the
# reaper needs this runtime + registry row to mount the tenant's EFS and finish.
if [[ "$PURGE_INCOMPLETE" == "1" ]]; then
  echo "  [4/5] SKIPPED — purges deferred; keeping runtime/role/EFS AP + registry."
  echo "        Re-run offboard once the reaper drains (sessions disappear)."
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Tenant $TENANT_ID PARTIALLY offboarded (users + secrets + S3 removed)."
  echo "  Compute silo + registry preserved for reaper retry. Re-run to finish."
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
fi
echo "  [4/5] Tearing down the dedicated compute silo (if provisioned)"
RUNTIME_ARN="$TENANT_RUNTIME_ARN"
# (RUNTIME_ARN falls back to the shared runtime when un-siloed; only delete a
# runtime that's actually this tenant's dedicated one, i.e. the silo row had it.)
SILO_RUNTIME=$(echo "$SILO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Item',{}).get('runtimeArn',{}).get('S',''))" 2>/dev/null || echo "")
RUNTIME_ARN="$SILO_RUNTIME"
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
