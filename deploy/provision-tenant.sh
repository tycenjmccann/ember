#!/usr/bin/env bash
#
# provision-tenant.sh — stand up a dedicated COMPUTE SILO for one tenant (Phase 3).
#
# A pool tenant shares the default runtime, EFS, and runtime role. This script
# gives a tenant its OWN:
#   1. EFS access point  — its own root dir (/t/<tenant>) on the shared filesystem,
#      mounted as a NON-ROOT POSIX user (uid/gid 1000), so a tenant's agent can't
#      read another tenant's files or run as root on the box.
#   2. Runtime IAM role  — S3 scoped to ember/t/<tenant>/* ONLY (a hard wall: even
#      a leaked key from another tenant is unreadable), plus EFS access locked to
#      this tenant's access point.
#   3. AgentCore runtime — dedicated microVMs (separate from every other tenant's).
#   4. tenant:{id} registry row — so the app + reaper route this tenant's sessions
#      to the runtime above instead of the shared default.
#
# Idempotent: re-running reconciles. SAFE: provisioning tenant A never touches the
# pool runtime or tenant B. Untils this runs for a tenant, that tenant keeps using
# the shared runtime unchanged.
#
# Usage:
#   source deploy/config.sh
#   deploy/provision-tenant.sh <tenantId>
#
# Prereqs: the shared stack is already up (setup-coding-efs.sh wrote efs.config:
# we reuse its filesystem id + subnets + security group + image + the role trust).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/config.sh"
# efs.config carries the shared filesystem id / subnets / SG / NFS we reuse.
# shellcheck disable=SC1091
[[ -f "$SCRIPT_DIR/coding-agent-runtime/efs.config" ]] && source "$SCRIPT_DIR/coding-agent-runtime/efs.config"

TENANT_ID="${1:-}"
[[ -z "$TENANT_ID" ]] && { echo "usage: provision-tenant.sh <tenantId>" >&2; exit 1; }
# Tenant id must be safe in a runtime name ([a-zA-Z0-9_]) and an S3 prefix.
if ! [[ "$TENANT_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$ ]]; then
  echo "ERROR: tenantId must be [a-zA-Z0-9_-], <=41 chars, alnum start." >&2; exit 1
fi
# Runtime names allow no hyphens; map - → _ for the runtime/role names only.
SAFE="${TENANT_ID//-/_}"

EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
FS_ID="${CODING_EFS_FILESYSTEM_ID:-}"
SUBNET_1="${CODING_SUBNET_1:-}"
SUBNET_2="${CODING_SUBNET_2:-}"
SG_ID="${CODING_SECURITY_GROUP:-}"
IMAGE_URI="${IMAGE_URI:-}"
# A non-root POSIX identity for the tenant's workspace. 1000 matches the image's
# bedrock_agentcore user; the access point FORCES this uid regardless of the
# process, so the container can't escalate to root on the shared filesystem.
TENANT_UID=1000
TENANT_GID=1000

if [[ -z "$FS_ID" || -z "$SUBNET_1" || -z "$SUBNET_2" || -z "$SG_ID" ]]; then
  echo "ERROR: shared EFS/VPC config missing. Run setup-coding-efs.sh first and" >&2
  echo "       source deploy/coding-agent-runtime/efs.config." >&2
  exit 1
fi
if [[ -z "$IMAGE_URI" ]]; then
  # Default to the shared runtime's image (latest pushed); operator can override.
  IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/ember-coding-runtime:latest"
  echo "  IMAGE_URI not set — defaulting to $IMAGE_URI"
fi

R=(--region "$AWS_REGION")
RUNTIME_NAME="ember_coding_rt_${SAFE}"
ROLE_NAME="ember-coding-rt-${TENANT_ID}"
AP_NAME="ember-ap-${TENANT_ID}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Provisioning tenant silo: $TENANT_ID"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "  Runtime: $RUNTIME_NAME   Role: $ROLE_NAME"
echo "═══════════════════════════════════════════════════════════════"

# ─── 1. Per-tenant EFS access point (non-root, isolated root dir) ─────────────
echo "  [1/4] EFS access point $AP_NAME (uid=$TENANT_UID, root=/t/$TENANT_ID)"
AP_ARN=$(aws efs describe-access-points "${R[@]}" --file-system-id "$FS_ID" \
  --query "AccessPoints[?Tags[?Key=='Name' && Value=='$AP_NAME']].AccessPointArn | [0]" \
  --output text 2>/dev/null || echo "None")
if [ "$AP_ARN" = "None" ] || [ -z "$AP_ARN" ]; then
  AP_ARN=$(aws efs create-access-point "${R[@]}" --file-system-id "$FS_ID" \
    --tags "Key=Name,Value=$AP_NAME" "Key=ember:tenant,Value=$TENANT_ID" \
    --posix-user "Uid=${TENANT_UID},Gid=${TENANT_GID}" \
    --root-directory "{\"Path\":\"/t/${TENANT_ID}\",\"CreationInfo\":{\"OwnerUid\":${TENANT_UID},\"OwnerGid\":${TENANT_GID},\"Permissions\":\"0700\"}}" \
    --query "AccessPointArn" --output text)
fi
echo "        $AP_ARN"

# ─── 2. Per-tenant runtime role (S3 fenced to ember/t/<tenant>/*) ─────────────
echo "  [2/4] IAM role $ROLE_NAME"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST" >/dev/null
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" \
    --description "Ember per-tenant coding runtime role ($TENANT_ID)" --output text >/dev/null
fi
# The isolation wall: S3 read/write is scoped to this tenant's prefix ONLY, and
# EFS mount is scoped to this tenant's access point ONLY. Everything else mirrors
# the shared runtime role (ECR/logs/bedrock/VPC) so the runtime still functions.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "tenant-${TENANT_ID}" --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Sid\":\"ECRImage\",\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Resource\":[\"arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/*\"]},
    {\"Sid\":\"ECRToken\",\"Effect\":\"Allow\",\"Action\":[\"ecr:GetAuthorizationToken\"],\"Resource\":\"*\"},
    {\"Sid\":\"Logs\",\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"logs:DescribeLogGroups\"],\"Resource\":[\"arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:*\"]},
    {\"Sid\":\"Xray\",\"Effect\":\"Allow\",\"Action\":[\"xray:PutTraceSegments\",\"xray:PutTelemetryRecords\",\"xray:GetSamplingRules\",\"xray:GetSamplingTargets\"],\"Resource\":[\"*\"]},
    {\"Sid\":\"Metrics\",\"Effect\":\"Allow\",\"Action\":\"cloudwatch:PutMetricData\",\"Resource\":\"*\"},
    {\"Sid\":\"BedrockModels\",\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":[\"arn:aws:bedrock:*::foundation-model/*\",\"arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:*\"]},
    {\"Sid\":\"BedrockMantle\",\"Effect\":\"Allow\",\"Action\":[\"bedrock-mantle:CreateInference\",\"bedrock-mantle:Get*\",\"bedrock-mantle:List*\",\"bedrock-mantle:CallWithBearerToken\"],\"Resource\":\"*\"},
    {\"Sid\":\"S3TenantOnly\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":[\"arn:aws:s3:::${ARTIFACT_BUCKET}/ember/t/${TENANT_ID}/*\"]},
    {\"Sid\":\"S3ListTenantOnly\",\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::${ARTIFACT_BUCKET}\"],\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"ember/t/${TENANT_ID}/*\"]}}},
    {\"Sid\":\"VpcEni\",\"Effect\":\"Allow\",\"Action\":[\"ec2:CreateNetworkInterface\",\"ec2:DescribeNetworkInterfaces\",\"ec2:DeleteNetworkInterface\",\"ec2:DescribeSubnets\",\"ec2:DescribeSecurityGroups\",\"ec2:DescribeVpcs\"],\"Resource\":\"*\"},
    {\"Sid\":\"EfsTenantAccessPoint\",\"Effect\":\"Allow\",\"Action\":[\"elasticfilesystem:ClientMount\",\"elasticfilesystem:ClientWrite\"],\"Resource\":\"arn:aws:elasticfilesystem:${AWS_REGION}:${ACCOUNT_ID}:file-system/${FS_ID}\",\"Condition\":{\"StringEquals\":{\"elasticfilesystem:AccessPointArn\":\"${AP_ARN}\"}}},
    {\"Sid\":\"EfsDescribe\",\"Effect\":\"Allow\",\"Action\":[\"elasticfilesystem:DescribeMountTargets\",\"elasticfilesystem:DescribeAccessPoints\"],\"Resource\":\"*\"}
  ]
}" >/dev/null
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "        $ROLE_ARN"

# ─── 3. Per-tenant AgentCore runtime ──────────────────────────────────────────
echo "  [3/4] AgentCore runtime $RUNTIME_NAME (this can take minutes)"
ARN_FILE="$(mktemp)"
RUNTIME_NAME="$RUNTIME_NAME" \
RUNTIME_ARN_FILE="$ARN_FILE" \
CODING_RUNTIME_ROLE_ARN="$ROLE_ARN" \
CODING_EFS_ACCESS_POINT_ARN="$AP_ARN" \
CODING_SUBNET_1="$SUBNET_1" CODING_SUBNET_2="$SUBNET_2" CODING_SECURITY_GROUP="$SG_ID" \
IMAGE_URI="$IMAGE_URI" \
  python3 "$SCRIPT_DIR/coding-agent-runtime/deploy.py"
RUNTIME_ARN="$(cat "$ARN_FILE")"
rm -f "$ARN_FILE"
[[ -z "$RUNTIME_ARN" ]] && { echo "ERROR: runtime deploy produced no ARN" >&2; exit 1; }
echo "        $RUNTIME_ARN"

# ─── 4. Register the silo (tenant:{id} row the app + reaper route on) ─────────
echo "  [4/4] Registering tenant:${TENANT_ID} in $EMBER_TABLE"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
aws dynamodb put-item --table-name "$EMBER_TABLE" "${R[@]}" --item "{
  \"sessionId\":{\"S\":\"tenant:${TENANT_ID}\"},
  \"runtimeArn\":{\"S\":\"${RUNTIME_ARN}\"},
  \"efsAccessPointArn\":{\"S\":\"${AP_ARN}\"},
  \"runtimeRoleArn\":{\"S\":\"${ROLE_ARN}\"},
  \"createdAt\":{\"S\":\"${NOW}\"}
}" >/dev/null

echo "═══════════════════════════════════════════════════════════════"
echo "  Tenant $TENANT_ID is now siloed."
echo "    runtime: $RUNTIME_ARN"
echo "    role:    $ROLE_ARN (S3 fenced to ember/t/${TENANT_ID}/*)"
echo "    efs ap:  $AP_ARN (uid ${TENANT_UID}, root /t/${TENANT_ID})"
echo "  New sessions for this tenant route here automatically (cache TTL ~60s)."
echo "═══════════════════════════════════════════════════════════════"
