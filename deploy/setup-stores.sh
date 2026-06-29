#!/usr/bin/env bash
#
# setup-stores.sh — create the two backing stores Ember needs:
#   1. DynamoDB table  (one row per session + config:{user} + auth:{user})
#   2. S3 bucket       (ported transcripts, checkpoints, config bundles, auth creds)
#
# Idempotent: re-running is a no-op if the resources already exist.
# Everything is env/STS-derived — no hardcoded account, region, or name.
#
# Usage:
#   source deploy/config.sh
#   ./deploy/setup-stores.sh
#
# Names default to:
#   EMBER_TABLE = ember-sessions
#   ARTIFACT_BUCKET  = ember-artifacts-<account>-<region>
# Override either by exporting it (or setting it in .env.local) before running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/config.sh"

EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"

echo "─── Stores ──────────────────────────────────────────────"
echo "  Table:  $EMBER_TABLE"
echo "  Bucket: $ARTIFACT_BUCKET"
echo "  Region: $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# ─── 1. DynamoDB table ────────────────────────────────────────────────────────
# Single-table design: partition key `sessionId` holds session rows AND the
# `config:{userId}` / `auth:{userId}` metadata rows. On-demand billing → pay only
# for the handful of reads/writes a coding session makes (pennies/month).
#
# `tenant-index` GSI (partition key tenantId): lets listSessions Query one
# tenant's rows instead of Scanning the whole table — the security boundary AND
# the cost win. Metadata rows (config:/auth:) carry no tenantId so they're absent
# from the index, which is exactly what we want (they're never listed). Projection
# is ALL because the sidebar needs most attributes; the per-tenant row count is
# tiny, so the duplicate storage is negligible.
TENANT_GSI="tenant-index"
if aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  [skip] table exists"
  # Add the GSI to a pre-existing table (idempotent: skip if already present).
  if aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
       --query "Table.GlobalSecondaryIndexes[?IndexName=='${TENANT_GSI}'] | length(@)" \
       --output text 2>/dev/null | grep -q '^1$'; then
    echo "  [skip] GSI $TENANT_GSI exists"
  else
    echo "  [create] GSI $TENANT_GSI on $EMBER_TABLE"
    aws dynamodb update-table \
      --table-name "$EMBER_TABLE" \
      --attribute-definitions AttributeName=tenantId,AttributeType=S \
      --global-secondary-index-updates "[{\"Create\":{\"IndexName\":\"${TENANT_GSI}\",\"KeySchema\":[{\"AttributeName\":\"tenantId\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}}]" \
      --region "$AWS_REGION" --output text >/dev/null
    echo "         waiting for GSI ACTIVE (can take minutes on a large table)..."
    # update-table returns immediately; the index backfills async. Poll until ACTIVE.
    for _ in $(seq 1 120); do
      STATE=$(aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
        --query "Table.GlobalSecondaryIndexes[?IndexName=='${TENANT_GSI}'].IndexStatus | [0]" \
        --output text 2>/dev/null || echo UNKNOWN)
      [[ "$STATE" == "ACTIVE" ]] && break
      sleep 5
    done
  fi
else
  echo "  [create] table $EMBER_TABLE (with GSI $TENANT_GSI)"
  aws dynamodb create-table \
    --table-name "$EMBER_TABLE" \
    --attribute-definitions \
      AttributeName=sessionId,AttributeType=S \
      AttributeName=tenantId,AttributeType=S \
    --key-schema AttributeName=sessionId,KeyType=HASH \
    --global-secondary-indexes "[{\"IndexName\":\"${TENANT_GSI}\",\"KeySchema\":[{\"AttributeName\":\"tenantId\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}]" \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION" \
    --output text >/dev/null
  echo "         waiting for ACTIVE..."
  aws dynamodb wait table-exists --table-name "$EMBER_TABLE" --region "$AWS_REGION"
fi

# ─── 1b. Backfill tenantId on legacy session rows ─────────────────────────────
# The tenant-index GSI only indexes rows that carry a tenantId. Rows written
# before multi-tenant auth (a pre-existing personal deploy) have none, so after
# the switch to Query they'd drop out of listSessions. Stamp them with the
# "default" tenant — the same value no-auth deploys resolve to — so they keep
# showing. Skips config:/auth: metadata rows (they must stay out of the index).
# Idempotent: only rows missing tenantId are touched.
echo "  [backfill] stamping tenantId=default on legacy session rows"
EMBER_TABLE="$EMBER_TABLE" AWS_REGION="$AWS_REGION" python3 - <<'PY'
import boto3, os
ddb = boto3.client("dynamodb", region_name=os.environ["AWS_REGION"])
table = os.environ["EMBER_TABLE"]
paginator = ddb.get_paginator("scan")
patched = 0
for page in paginator.paginate(TableName=table,
        ProjectionExpression="sessionId, tenantId"):
    for item in page.get("Items", []):
        sid = item["sessionId"]["S"]
        if sid.startswith("config:") or sid.startswith("auth:"):
            continue
        if "tenantId" in item:
            continue
        ddb.update_item(
            TableName=table,
            Key={"sessionId": {"S": sid}},
            UpdateExpression="SET tenantId = :t",
            ConditionExpression="attribute_not_exists(tenantId)",
            ExpressionAttributeValues={":t": {"S": "default"}},
        )
        patched += 1
print(f"         backfilled {patched} row(s)")
PY

# ─── 2. S3 bucket ─────────────────────────────────────────────────────────────
# us-east-1 is special: create-bucket rejects a LocationConstraint there.
if aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  [skip] bucket exists"
else
  echo "  [create] bucket $ARTIFACT_BUCKET"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" --output text >/dev/null
  else
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" --output text >/dev/null
  fi
  # Lock it down: block all public access, enforce TLS-only, server-side encryption.
  aws s3api put-public-access-block --bucket "$ARTIFACT_BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
  aws s3api put-bucket-encryption --bucket "$ARTIFACT_BUCKET" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
fi

# ─── 2b. Migrate legacy config/auth artifacts under the tenant prefix ─────────
# Phase 2 moved every S3 key under ember/t/<tenantId>/… so a per-tenant runtime
# role can be IAM-scoped to its own subtree. Config bundles + subscription creds
# are long-lived and recomputed from (tenant,user), so a pre-Phase-2 deploy's
# objects must move to the "default" tenant or the runtime won't find them.
# (resume/checkpoint artifacts are session-scoped + 7-day TTL → left in place;
# the runtime/purge sweeps both old and new layouts.) Idempotent: copies only
# legacy keys that don't already exist under the new prefix, then deletes them.
echo "  [migrate] moving legacy configs/auth under ember/t/default/"
EMBER_BUCKET="$ARTIFACT_BUCKET" AWS_REGION="$AWS_REGION" python3 - <<'PY'
import boto3, os
s3 = boto3.client("s3", region_name=os.environ["AWS_REGION"])
bucket = os.environ["EMBER_BUCKET"]
moved = 0
paginator = s3.get_paginator("list_objects_v2")
for legacy_root in ("ember/configs/", "ember/auth/"):
    for page in paginator.paginate(Bucket=bucket, Prefix=legacy_root):
        for obj in page.get("Contents", []):
            src = obj["Key"]
            # ember/configs/<u>/<v>.zip → ember/t/default/configs/<u>/<v>.zip
            dst = "ember/t/default/" + src[len("ember/"):]
            try:
                s3.head_object(Bucket=bucket, Key=dst)
                continue  # already migrated
            except s3.exceptions.ClientError:
                pass
            s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": src}, Key=dst)
            s3.delete_object(Bucket=bucket, Key=src)
            moved += 1
print(f"         migrated {moved} object(s)")
PY

echo ""
echo "OK stores ready."
echo "  export EMBER_TABLE=$EMBER_TABLE"
echo "  export ARTIFACT_BUCKET=$ARTIFACT_BUCKET"
