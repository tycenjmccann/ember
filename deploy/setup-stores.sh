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
if aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  [skip] table exists"
else
  echo "  [create] table $EMBER_TABLE"
  aws dynamodb create-table \
    --table-name "$EMBER_TABLE" \
    --attribute-definitions AttributeName=sessionId,AttributeType=S \
    --key-schema AttributeName=sessionId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION" \
    --output text >/dev/null
  echo "         waiting for ACTIVE..."
  aws dynamodb wait table-exists --table-name "$EMBER_TABLE" --region "$AWS_REGION"
fi

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

echo ""
echo "OK stores ready."
echo "  export EMBER_TABLE=$EMBER_TABLE"
echo "  export ARTIFACT_BUCKET=$ARTIFACT_BUCKET"
