#!/usr/bin/env bash
#
# deploy/apprunner/deploy.sh — Idempotent App Runner deployment for Ember.
#
# Creates (if needed):
#   1. ECR repo: ember-web
#   2. AppRunnerECRAccessRole (App Runner pulls from ECR)
#   3. ember-apprunner-instance role (runtime perms: AgentCore, DynamoDB, S3, Bedrock)
#   4. Docker build + push (linux/amd64)
#   5. App Runner service: ember
#
# Output: DEPLOYMENT_URL (the public App Runner URL), persisted to .env.local.
#
# Prereqs: AWS creds (AWS_PROFILE), Docker running, .env.local present.
# Usage:   AWS_PROFILE=<your-profile> ./deploy/apprunner/deploy.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Account guard — refuse to deploy to the wrong account.
if [[ -n "${EXPECTED_ACCOUNT_ID:-}" && "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "ERROR: account $ACCOUNT_ID != EXPECTED_ACCOUNT_ID=$EXPECTED_ACCOUNT_ID. Wrong AWS_PROFILE?" >&2
  exit 1
fi

ECR_REPO="ember-web"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
SERVICE_NAME="ember"
ECR_ACCESS_ROLE="AppRunnerECRAccessRole"
INSTANCE_ROLE="ember-apprunner-instance"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"

echo "═══════════════════════════════════════════════════════════════"
echo "  App Runner Deploy — Ember"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "═══════════════════════════════════════════════════════════════"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running." >&2; exit 1
fi

# ─── 1. ECR repo ──────────────────────────────────────────────────────────────
echo "  [1/5] ECR repo: $ECR_REPO"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true --output text >/dev/null

# ─── 2. ECR access role ───────────────────────────────────────────────────────
echo "  [2/5] IAM role: $ECR_ACCESS_ROLE"
ECR_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$ECR_ACCESS_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ECR_ACCESS_ROLE" --policy-document "$ECR_TRUST" >/dev/null
else
  aws iam create-role --role-name "$ECR_ACCESS_ROLE" --assume-role-policy-document "$ECR_TRUST" \
    --description "Allows App Runner to pull from ECR" --output text >/dev/null
fi
aws iam attach-role-policy --role-name "$ECR_ACCESS_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess" >/dev/null
ECR_ACCESS_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ECR_ACCESS_ROLE}"

# ─── 3. Instance role (runtime perms) ─────────────────────────────────────────
echo "  [3/5] IAM role: $INSTANCE_ROLE"
INSTANCE_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"tasks.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$INSTANCE_ROLE" --policy-document "$INSTANCE_TRUST" >/dev/null
else
  aws iam create-role --role-name "$INSTANCE_ROLE" --assume-role-policy-document "$INSTANCE_TRUST" \
    --description "Instance role for Ember App Runner service" --output text >/dev/null
fi
aws iam put-role-policy --role-name "$INSTANCE_ROLE" --policy-name "EmberAppRunnerPerms" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"AgentCore\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"bedrock-agentcore:InvokeAgentRuntime\",
          \"bedrock-agentcore:InvokeAgentRuntimeCommandShell\",
          \"bedrock-agentcore:StopRuntimeSession\",
          \"bedrock-agentcore:GetAgentRuntime\",
          \"bedrock-agentcore:ListAgentRuntimes\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"DynamoDB\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"dynamodb:GetItem\", \"dynamodb:PutItem\", \"dynamodb:UpdateItem\",
          \"dynamodb:DeleteItem\", \"dynamodb:Query\", \"dynamodb:Scan\"
        ],
        \"Resource\": \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${EMBER_TABLE}\"
      },
      {
        \"Sid\": \"S3Artifacts\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\", \"s3:ListBucket\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/ember/*\"
        ]
      },
      {
        \"Sid\": \"BedrockModels\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"STS\",
        \"Effect\": \"Allow\",
        \"Action\": \"sts:GetCallerIdentity\",
        \"Resource\": \"*\"
      }
    ]
  }"
INSTANCE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_ROLE}"

# ─── 4. Build + push ──────────────────────────────────────────────────────────
echo "  [4/5] Docker build + ECR push (linux/amd64)"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "$(date +%Y%m%d%H%M%S)")"
FULL_TAG="${ECR_URI}:${GIT_SHA}"
LATEST_TAG="${ECR_URI}:latest"

docker buildx build --platform linux/amd64 \
  --tag "$FULL_TAG" --tag "$LATEST_TAG" --push --file Dockerfile .
echo "        Pushed $FULL_TAG"

# ─── 5. App Runner service ────────────────────────────────────────────────────
echo "  [5/5] App Runner service: $SERVICE_NAME"

EXISTING_ARN=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
  | python3 -c "import json,sys
for s in json.load(sys.stdin).get('ServiceSummaryList',[]):
    if s.get('ServiceName')=='${SERVICE_NAME}': print(s['ServiceArn']); break" 2>/dev/null || true)

# Runtime env. HOSTNAME=0.0.0.0 + PORT=8080 so the standalone server binds where
# App Runner's TCP health check looks.
#
# Env is ADDITIVE, never subtractive: start from the LIVE service's existing
# RuntimeEnvironmentVariables (so a redeploy from a shell that didn't export every
# var can't silently drop CODING_AGENT_RUNTIME_ARN etc. and break the app), then
# overlay any values the current shell/.env.local provides. config.sh defaults
# fill the rest. A var only changes if explicitly set this run.
source "$REPO_ROOT/deploy/config.sh" 2>/dev/null || true
EXISTING_ENV='{}'
if [[ -n "$EXISTING_ARN" ]]; then
  EXISTING_ENV=$(aws apprunner describe-service --service-arn "$EXISTING_ARN" --region "$AWS_REGION" \
    --query 'Service.SourceConfiguration.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables' \
    --output json 2>/dev/null || echo '{}')
fi
ENV_VARS=$(EXISTING_ENV="$EXISTING_ENV" python3 -c "
import json, os
env = json.loads(os.environ.get('EXISTING_ENV') or '{}')
env.update({'HOSTNAME':'0.0.0.0','PORT':'8080','NODE_ENV':'production'})
# Overlay only vars actually present in this shell's environment.
for k in ['AWS_REGION','CODING_AGENT_RUNTIME_ARN','EMBER_TABLE','ARTIFACT_BUCKET','DEPLOYMENT_URL','NEXT_PUBLIC_BRAND_NAME',
          'COGNITO_USER_POOL_ID','COGNITO_CLIENT_ID','COGNITO_CLIENT_SECRET','COGNITO_DOMAIN','EMBER_AUTH_DISABLED']:
    v = os.environ.get(k)
    if v: env[k] = v
print(json.dumps(env))
")
# Hard guard: never deploy without the runtime ARN — the whole app is dead without it.
if ! echo "$ENV_VARS" | grep -q 'CODING_AGENT_RUNTIME_ARN'; then
  echo "ERROR: CODING_AGENT_RUNTIME_ARN missing from both the live service and this shell." >&2
  echo "       Export it (or set it in deploy/config.sh) before deploying." >&2
  exit 1
fi

# Auth guard: fail closed. Either a Cognito pool must be wired (multi-tenant) OR
# the deployer must explicitly opt into the no-auth personal mode. Shipping with
# neither would leave every session reachable by anyone — the pre-Phase-1 hole.
if ! echo "$ENV_VARS" | grep -q 'COGNITO_USER_POOL_ID' && ! echo "$ENV_VARS" | grep -q '"EMBER_AUTH_DISABLED": *"1"'; then
  echo "ERROR: No auth configured. Set COGNITO_* (run deploy/cognito/setup-cognito.sh) for" >&2
  echo "       multi-tenant auth, or export EMBER_AUTH_DISABLED=1 for a personal no-auth deploy." >&2
  exit 1
fi

if [[ -n "$EXISTING_ARN" ]]; then
  echo "        Updating existing service..."
  aws apprunner update-service --service-arn "$EXISTING_ARN" --region "$AWS_REGION" \
    --source-configuration "{
      \"AuthenticationConfiguration\": {\"AccessRoleArn\": \"${ECR_ACCESS_ROLE_ARN}\"},
      \"ImageRepository\": {
        \"ImageIdentifier\": \"${FULL_TAG}\",
        \"ImageRepositoryType\": \"ECR\",
        \"ImageConfiguration\": {\"Port\": \"8080\", \"RuntimeEnvironmentVariables\": ${ENV_VARS}}
      }
    }" \
    --instance-configuration "{\"InstanceRoleArn\": \"${INSTANCE_ROLE_ARN}\"}" --output text >/dev/null
  aws apprunner start-deployment --service-arn "$EXISTING_ARN" --region "$AWS_REGION" --output text >/dev/null 2>&1 || true
else
  echo "        Creating new service..."
  aws apprunner create-service --service-name "$SERVICE_NAME" --region "$AWS_REGION" \
    --source-configuration "{
      \"AuthenticationConfiguration\": {\"AccessRoleArn\": \"${ECR_ACCESS_ROLE_ARN}\"},
      \"ImageRepository\": {
        \"ImageIdentifier\": \"${FULL_TAG}\",
        \"ImageRepositoryType\": \"ECR\",
        \"ImageConfiguration\": {\"Port\": \"8080\", \"RuntimeEnvironmentVariables\": ${ENV_VARS}}
      }
    }" \
    --instance-configuration "{\"Cpu\": \"1024\", \"Memory\": \"2048\", \"InstanceRoleArn\": \"${INSTANCE_ROLE_ARN}\"}" \
    --health-check-configuration "{\"Protocol\":\"TCP\",\"Interval\":10,\"Timeout\":5,\"HealthyThreshold\":1,\"UnhealthyThreshold\":5}" \
    --output text >/dev/null
fi

echo "        Waiting for RUNNING (5–10 min)..."
for i in $(seq 1 90); do
  STATUS=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
    | python3 -c "import json,sys
for s in json.load(sys.stdin).get('ServiceSummaryList',[]):
    if s.get('ServiceName')=='${SERVICE_NAME}': print(s.get('Status','UNKNOWN')); break" 2>/dev/null || echo UNKNOWN)
  [[ "$STATUS" == "RUNNING" ]] && break
  if [[ "$STATUS" == *FAILED* ]]; then echo "        ERROR: status $STATUS" >&2; exit 1; fi
  printf "        [%02d] %s ...\r" "$i" "$STATUS"; sleep 10
done
echo ""

SERVICE_URL=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
  | python3 -c "import json,sys
for s in json.load(sys.stdin).get('ServiceSummaryList',[]):
    if s.get('ServiceName')=='${SERVICE_NAME}': print('https://'+s.get('ServiceUrl','')); break" 2>/dev/null || true)

echo "        Service URL: $SERVICE_URL"

# Persist DEPLOYMENT_URL so the MCP deep links + port handoff use the real origin.
if grep -q '^DEPLOYMENT_URL=' .env.local 2>/dev/null; then
  sed "s|^DEPLOYMENT_URL=.*|DEPLOYMENT_URL=\"${SERVICE_URL}\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
else
  echo "DEPLOYMENT_URL=\"${SERVICE_URL}\"" >> .env.local
fi
chmod 600 .env.local

echo "═══════════════════════════════════════════════════════════════"
echo "  Ember deployed → $SERVICE_URL"
echo "═══════════════════════════════════════════════════════════════"
