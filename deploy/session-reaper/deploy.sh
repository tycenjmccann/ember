#!/usr/bin/env bash
#
# deploy.sh — wire the event-driven session reaper.
#
# A deleted session is soft-deleted (deletedAt + ttl) by the API. This sets up the
# infra that turns that tombstone into actual backend cleanup, with NO polling:
#
#   1. DynamoDB TTL on `ttl`            → expires the tombstoned row automatically
#   2. DynamoDB Streams (NEW_AND_OLD)   → emits the REMOVE event on expiry
#   3. Reaper Lambda                    → stops the microVM + purges EFS/S3
#   4. Event-source mapping             → stream → Lambda (fires once per delete)
#   5. S3 lifecycle rule                → backstop: expire orphaned artifacts
#
# Idempotent: re-running only applies what's missing. Env/STS-derived — no
# hardcoded account, region, or names.
#
# Usage:
#   source deploy/config.sh
#   export CODING_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...:runtime/...
#   ./deploy/session-reaper/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
FN_NAME="${REAPER_FN_NAME:-ember-session-reaper}"
ROLE_NAME="${REAPER_ROLE_NAME:-ember-session-reaper-role}"
# Days an orphaned S3 artifact lingers before the lifecycle rule expires it (the
# backstop for anything the reaper still misses). Resume/checkpoint payloads are
# only needed while a session is live, so this is generous.
ARTIFACT_TTL_DAYS="${ARTIFACT_TTL_DAYS:-7}"

if [ -z "${CODING_AGENT_RUNTIME_ARN:-}" ]; then
  echo "ERROR: CODING_AGENT_RUNTIME_ARN must be set (the reaper invokes it to purge)." >&2
  exit 1
fi

echo "─── Session reaper ──────────────────────────────────────"
echo "  Table:   $EMBER_TABLE"
echo "  Bucket:  $ARTIFACT_BUCKET   (artifact TTL: ${ARTIFACT_TTL_DAYS}d)"
echo "  Lambda:  $FN_NAME"
echo "  Region:  $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# ─── 1. DynamoDB TTL on `ttl` ─────────────────────────────────────────────────
TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "$EMBER_TABLE" \
  --region "$AWS_REGION" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo NONE)"
if [ "$TTL_STATUS" = "ENABLED" ] || [ "$TTL_STATUS" = "ENABLING" ]; then
  echo "  [skip] TTL already $TTL_STATUS"
else
  echo "  [enable] TTL on attribute 'ttl'"
  aws dynamodb update-time-to-live --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" --output text >/dev/null
fi

# ─── 2. DynamoDB Streams (NEW_AND_OLD_IMAGES — reaper needs OldImage) ──────────
STREAM_ARN="$(aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
  --query 'Table.LatestStreamArn' --output text 2>/dev/null || echo None)"
STREAM_VIEW="$(aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
  --query 'Table.StreamSpecification.StreamViewType' --output text 2>/dev/null || echo None)"
if [ "$STREAM_VIEW" = "NEW_AND_OLD_IMAGES" ] && [ "$STREAM_ARN" != "None" ]; then
  echo "  [skip] stream already on ($STREAM_VIEW)"
else
  echo "  [enable] DynamoDB stream NEW_AND_OLD_IMAGES"
  aws dynamodb update-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
    --stream-specification "StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES" --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$EMBER_TABLE" --region "$AWS_REGION"
  STREAM_ARN="$(aws dynamodb describe-table --table-name "$EMBER_TABLE" --region "$AWS_REGION" \
    --query 'Table.LatestStreamArn' --output text)"
fi
echo "  stream: $STREAM_ARN"

# ─── 3. IAM role for the Lambda ───────────────────────────────────────────────
TABLE_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${EMBER_TABLE}"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "  [skip] role exists"
else
  echo "  [create] role $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' --output text >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
fi
# Inline policy: read the stream, invoke + stop the runtime, purge S3. Scoped to
# this table's stream, this runtime, and this bucket. (The runtime's own role does
# the EFS rmtree; the Lambda only triggers it via invoke.)
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name reaper --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",
     \"Action\":[\"dynamodb:GetRecords\",\"dynamodb:GetShardIterator\",\"dynamodb:DescribeStream\",\"dynamodb:ListStreams\"],
     \"Resource\":\"${TABLE_ARN}/stream/*\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"bedrock-agentcore:InvokeAgentRuntime\",\"bedrock-agentcore:StopRuntimeSession\"],
     \"Resource\":\"${CODING_AGENT_RUNTIME_ARN}*\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${ARTIFACT_BUCKET}\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::${ARTIFACT_BUCKET}/*\"}
  ]
}" >/dev/null
echo "  role policy applied"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# ─── 4. Lambda function ───────────────────────────────────────────────────────
ZIP="$(mktemp -d)/reaper.zip"
( cd "$SCRIPT_DIR" && zip -q "$ZIP" handler.py )
if aws lambda get-function --function-name "$FN_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  [update] Lambda code"
  aws lambda update-function-code --function-name "$FN_NAME" --region "$AWS_REGION" \
    --zip-file "fileb://$ZIP" --output text >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$AWS_REGION"
  aws lambda update-function-configuration --function-name "$FN_NAME" --region "$AWS_REGION" \
    --environment "Variables={CODING_AGENT_RUNTIME_ARN=$CODING_AGENT_RUNTIME_ARN}" \
    --timeout 120 --output text >/dev/null
else
  echo "  [create] Lambda $FN_NAME"
  # IAM role propagation can lag create-function; retry briefly.
  for attempt in 1 2 3 4 5; do
    if aws lambda create-function --function-name "$FN_NAME" --region "$AWS_REGION" \
        --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
        --zip-file "fileb://$ZIP" --timeout 120 --memory-size 256 \
        --environment "Variables={CODING_AGENT_RUNTIME_ARN=$CODING_AGENT_RUNTIME_ARN}" \
        --output text >/dev/null 2>&1; then
      break
    fi
    echo "         role not ready, retry $attempt…"; sleep 6
  done
  aws lambda wait function-active --function-name "$FN_NAME" --region "$AWS_REGION"
fi

# ─── 4b. Event-source mapping: stream → Lambda ────────────────────────────────
# Filter to REMOVE so the Lambda is only invoked on a delete/expiry (not every
# session write). BisectBatchOnFunctionError + retries give per-record retry.
EXISTING_ESM="$(aws lambda list-event-source-mappings --function-name "$FN_NAME" --region "$AWS_REGION" \
  --query "EventSourceMappings[?starts_with(EventSourceArn, '${TABLE_ARN}/stream/')].UUID" --output text 2>/dev/null || echo "")"
if [ -n "$EXISTING_ESM" ] && [ "$EXISTING_ESM" != "None" ]; then
  echo "  [skip] event-source mapping exists ($EXISTING_ESM)"
else
  echo "  [create] event-source mapping (REMOVE only)"
  aws lambda create-event-source-mapping --function-name "$FN_NAME" --region "$AWS_REGION" \
    --event-source-arn "$STREAM_ARN" \
    --starting-position LATEST \
    --batch-size 10 --maximum-retry-attempts 5 --bisect-batch-on-function-error \
    --filter-criteria '{"Filters":[{"Pattern":"{\"eventName\":[\"REMOVE\"]}"}]}' \
    --output text >/dev/null
fi

# ─── 5. S3 lifecycle backstop ─────────────────────────────────────────────────
echo "  [apply] S3 lifecycle: expire ember/resume/ + ember/checkpoint/ after ${ARTIFACT_TTL_DAYS}d"
aws s3api put-bucket-lifecycle-configuration --bucket "$ARTIFACT_BUCKET" --lifecycle-configuration "{
  \"Rules\":[
    {\"ID\":\"ember-resume-ttl\",\"Status\":\"Enabled\",
     \"Filter\":{\"Prefix\":\"ember/resume/\"},
     \"Expiration\":{\"Days\":${ARTIFACT_TTL_DAYS}}},
    {\"ID\":\"ember-checkpoint-ttl\",\"Status\":\"Enabled\",
     \"Filter\":{\"Prefix\":\"ember/checkpoint/\"},
     \"Expiration\":{\"Days\":${ARTIFACT_TTL_DAYS}}}
  ]
}" >/dev/null

echo ""
echo "OK session reaper wired. Deletes now soft-delete; the TTL-expiry stream"
echo "   event fires $FN_NAME once per delete to stop + purge. No polling."
