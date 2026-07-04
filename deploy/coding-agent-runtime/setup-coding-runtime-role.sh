#!/usr/bin/env bash
#
# setup-coding-runtime-role.sh — create the IAM execution role the AgentCore
# coding runtime assumes. Grants exactly what main.py + the OTel sidecar need:
#   - ECR pull (the runtime image)
#   - CloudWatch Logs + X-Ray + metrics (observability sidecar)
#   - Bedrock InvokeModel (Claude over Bedrock when auth_mode=bedrock)
#   - Bedrock Mantle inference (Codex GPT-5.5 via the OpenAI-compatible
#     Responses endpoint — a SEPARATE `bedrock-mantle:*` action namespace)
#   - S3 on the artifact bucket (config bundles, ported transcripts, auth creds)
#   - EC2/EFS describe + mount perms (VPC networking + EFS workspace mount)
#
# Idempotent. Everything env/STS-derived — no hardcoded account or region.
# Exports CODING_RUNTIME_ROLE_ARN on success (source this script to capture it).
#
# Usage:
#   source deploy/config.sh
#   source deploy/coding-agent-runtime/setup-coding-runtime-role.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

ROLE_NAME="${CODING_RUNTIME_ROLE_NAME:-ember-coding-runtime}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"

echo "─── Coding runtime execution role ───────────────────────"
echo "  Role:   $ROLE_NAME"
echo "  Region: $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# Trust policy — the AgentCore service principal, scoped to this account/region
# (the canonical conditions from the AgentCore runtime permissions guide).
TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeRolePolicy",
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
        "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:*" }
      }
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "  [update] trust policy"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST" >/dev/null
else
  echo "  [create] role"
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" \
    --description "Execution role for the Ember coding-agent runtime" --output text >/dev/null
fi

# Permissions policy. Bedrock + observability follow the AgentCore guide; the S3,
# EC2 (VPC ENI), and EFS statements cover this runtime's specific needs.
PERMS=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRImageAccess",
      "Effect": "Allow",
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": ["arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/*"]
    },
    {
      "Sid": "ECRToken",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"],
      "Resource": ["arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:*"]
    },
    {
      "Sid": "Xray",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
      "Resource": ["*"]
    },
    {
      "Sid": "Metrics",
      "Effect": "Allow",
      "Action": "cloudwatch:PutMetricData",
      "Resource": "*",
      "Condition": { "StringEquals": { "cloudwatch:namespace": "bedrock-agentcore" } }
    },
    {
      "Sid": "BedrockModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:*"]
    },
    {
      "Sid": "BedrockMantleInference",
      "Effect": "Allow",
      "Action": ["bedrock-mantle:CreateInference", "bedrock-mantle:Get*", "bedrock-mantle:List*"],
      "Resource": ["arn:aws:bedrock-mantle:*:${ACCOUNT_ID}:project/*"]
    },
    {
      "Sid": "BedrockMantleBearerToken",
      "Effect": "Allow",
      "Action": ["bedrock-mantle:CallWithBearerToken"],
      "Resource": "*"
    },
    {
      "Sid": "S3Artifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${ARTIFACT_BUCKET}",
        "arn:aws:s3:::${ARTIFACT_BUCKET}/ember/*"
      ]
    },
    {
      "Sid": "SecretsManagerCreds",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:ember/t/*"
    },
    {
      "Sid": "VpcEni",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EfsMount",
      "Effect": "Allow",
      "Action": ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeAccessPoints"],
      "Resource": "*"
    }
  ]
}
JSON
)

aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "CodingRuntimePerms" --policy-document "$PERMS" >/dev/null

# ─── Optional broad AWS access ────────────────────────────────────────────────
# The baseline policy above is least-privilege: the agent can reach Bedrock, the
# artifact bucket, and its own secrets — nothing else. That's the safe default
# for a runtime executing UNTRUSTED agent output, so OSS deploys get it unless
# they opt in.
#
# But when you actually want the agent to operate on real AWS infra (inspect the
# account, deploy stacks, etc.), set CODING_RUNTIME_ACCESS to widen the role by
# attaching an AWS-managed policy. Everything the agent does is still bounded by
# THIS account's resources — scope the blast radius by pointing the runtime at a
# dedicated/non-prod account if that matters to you.
#
#   locked     (default) baseline only — everything else AccessDenied
#   readonly   + ReadOnlyAccess          inspect anything, mutate nothing
#   poweruser  + PowerUserAccess         full access EXCEPT IAM/Organizations
#   admin      + AdministratorAccess     unrestricted (single-env / trusted use)
CODING_RUNTIME_ACCESS="${CODING_RUNTIME_ACCESS:-locked}"
case "$CODING_RUNTIME_ACCESS" in
  locked)    BROAD_POLICY_ARN="" ;;
  readonly)  BROAD_POLICY_ARN="arn:aws:iam::aws:policy/ReadOnlyAccess" ;;
  poweruser) BROAD_POLICY_ARN="arn:aws:iam::aws:policy/PowerUserAccess" ;;
  admin)     BROAD_POLICY_ARN="arn:aws:iam::aws:policy/AdministratorAccess" ;;
  *) echo "ERROR: CODING_RUNTIME_ACCESS='$CODING_RUNTIME_ACCESS' invalid (locked|readonly|poweruser|admin)" >&2; exit 1 ;;
esac

# Detach any managed broad-access policy from a previous run so switching tiers
# (or back to locked) doesn't leave a wider one stacked underneath.
for _mp in ReadOnlyAccess PowerUserAccess AdministratorAccess; do
  _arn="arn:aws:iam::aws:policy/${_mp}"
  [ "$_arn" = "$BROAD_POLICY_ARN" ] && continue
  aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$_arn" 2>/dev/null || true
done
if [ -n "$BROAD_POLICY_ARN" ]; then
  echo "  [attach] broad access: $CODING_RUNTIME_ACCESS ($BROAD_POLICY_ARN)"
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$BROAD_POLICY_ARN" >/dev/null
else
  echo "  [access] locked (baseline least-privilege only)"
fi

CODING_RUNTIME_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
export CODING_RUNTIME_ROLE_ARN

echo ""
echo "OK role ready."
echo "  export CODING_RUNTIME_ROLE_ARN=$CODING_RUNTIME_ROLE_ARN"
