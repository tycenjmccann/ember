#!/usr/bin/env bash
#
# deploy/ecs-express/deploy.sh — Idempotent Amazon ECS Express Mode deploy for
# Ember. This is the recommended web-tier path: App Runner is closed to NEW
# customers (https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html),
# and ECS Express Mode is AWS's named successor — one API call provisions a
# Fargate service, an Application Load Balancer, auto scaling, and networking.
#
# Creates (if needed):
#   1. ECR repo: ember-web                       (shared with the App Runner path)
#   2. ecsTaskExecutionRole                      (ECS pulls the image + writes logs)
#   3. ecsInfrastructureRoleForExpressServices   (ECS provisions the ALB/scaling)
#   4. ember-ecs-task role                       (the app's OWN runtime perms:
#                                                 AgentCore, DynamoDB, S3, Bedrock,
#                                                 Secrets Manager — same policy as
#                                                 the App Runner instance role)
#   5. Docker build + push (linux/amd64)
#   6. ECS Express Mode service: ember
#
# Output: DEPLOYMENT_URL (public https://<service>.ecs.<region>.on.aws URL),
#         persisted to .env.local.
#
# Prereqs: AWS CLI v2 >= 2.34 (ships *-express-gateway-service), Docker running,
#          .env.local present, a default VPC with public subnets (or set
#          EXPRESS_SUBNETS / EXPRESS_SECURITY_GROUPS).
# Usage:   AWS_PROFILE=<your-profile> ./deploy/ecs-express/deploy.sh
#
# The container is identical to the App Runner path (same Dockerfile, same
# HOSTNAME=0.0.0.0 + PORT=8080 fix); only the hosting control plane differs.

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
CLUSTER="${EXPRESS_CLUSTER:-default}"   # Express Mode services land in the default cluster
EXEC_ROLE="ecsTaskExecutionRole"
INFRA_ROLE="ecsInfrastructureRoleForExpressServices"
TASK_ROLE="ember-ecs-task"              # the app's runtime permissions
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-ember-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
EMBER_TABLE="${EMBER_TABLE:-ember-sessions}"
# CPU units + MiB, exactly as the ECS API takes them (NOT vCPU/GB): 1024 = 1 vCPU,
# 2048 = 2048 MiB. Must be a valid Fargate combo or the create/update is rejected.
CPU="${EXPRESS_CPU:-1024}"
MEMORY="${EXPRESS_MEMORY:-2048}"

echo "═══════════════════════════════════════════════════════════════"
echo "  ECS Express Mode Deploy — Ember"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "═══════════════════════════════════════════════════════════════"

# ─── Pre-flight ───────────────────────────────────────────────────────────────
if ! aws ecs create-express-gateway-service help >/dev/null 2>&1; then
  echo "ERROR: your AWS CLI lacks the ECS Express Mode commands. Upgrade to" >&2
  echo "       AWS CLI v2 >= 2.34 (aws --version)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running." >&2; exit 1
fi

# ─── 1. ECR repo ──────────────────────────────────────────────────────────────
echo "  [1/6] ECR repo: $ECR_REPO"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true --output text >/dev/null

# ─── 2. Task execution role (ECS pulls image + writes logs) ───────────────────
echo "  [2/6] IAM role: $EXEC_ROLE"
EXEC_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$EXEC_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$EXEC_ROLE" --policy-document "$EXEC_TRUST" >/dev/null
else
  aws iam create-role --role-name "$EXEC_ROLE" --assume-role-policy-document "$EXEC_TRUST" \
    --description "ECS task execution role (image pull + logs)" --output text >/dev/null
fi
aws iam attach-role-policy --role-name "$EXEC_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" >/dev/null
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE}"

# ─── 3. Express infrastructure role (ECS provisions the ALB/scaling) ──────────
echo "  [3/6] IAM role: $INFRA_ROLE"
INFRA_TRUST='{"Version":"2012-10-17","Statement":[{"Sid":"AllowAccessInfrastructureForECSExpressServices","Effect":"Allow","Principal":{"Service":"ecs.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$INFRA_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$INFRA_ROLE" --policy-document "$INFRA_TRUST" >/dev/null
else
  aws iam create-role --role-name "$INFRA_ROLE" --assume-role-policy-document "$INFRA_TRUST" \
    --description "ECS Express Mode infrastructure provisioning role" --output text >/dev/null
fi
aws iam attach-role-policy --role-name "$INFRA_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices" >/dev/null
INFRA_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INFRA_ROLE}"

# ─── 4. Task role (the app's OWN runtime permissions) ─────────────────────────
# Direct successor to the App Runner instance role (ember-apprunner-instance):
# same policy, different trust principal (ecs-tasks vs tasks.apprunner). Keep the
# two statements in sync if you change either.
echo "  [4/6] IAM role: $TASK_ROLE"
TASK_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$TASK_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$TASK_ROLE" --policy-document "$TASK_TRUST" >/dev/null
else
  aws iam create-role --role-name "$TASK_ROLE" --assume-role-policy-document "$TASK_TRUST" \
    --description "Runtime permissions for the Ember ECS task" --output text >/dev/null
fi
aws iam put-role-policy --role-name "$TASK_ROLE" --policy-name "EmberRuntimePerms" \
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
        \"Resource\": [
          \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${EMBER_TABLE}\",
          \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${EMBER_TABLE}/index/*\"
        ]
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
        \"Sid\": \"SecretsManagerUserCreds\",
        \"Effect\": \"Allow\",
        \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\", \"secretsmanager:DeleteSecret\", \"secretsmanager:DescribeSecret\", \"secretsmanager:TagResource\"],
        \"Resource\": \"arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:ember/t/*\"
      },
      {
        \"Sid\": \"SecretsManagerGithubApp\",
        \"Effect\": \"Allow\",
        \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\", \"secretsmanager:GetSecretValue\", \"secretsmanager:DeleteSecret\", \"secretsmanager:DescribeSecret\"],
        \"Resource\": \"arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:ember/github-app*\"
      },
      {
        \"Sid\": \"STS\",
        \"Effect\": \"Allow\",
        \"Action\": \"sts:GetCallerIdentity\",
        \"Resource\": \"*\"
      }
    ]
  }"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}"

# ─── 5. Build + push ──────────────────────────────────────────────────────────
echo "  [5/6] Docker build + ECR push (linux/amd64)"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "$(date +%Y%m%d%H%M%S)")"
FULL_TAG="${ECR_URI}:${GIT_SHA}"
LATEST_TAG="${ECR_URI}:latest"

docker buildx build --platform linux/amd64 \
  --tag "$FULL_TAG" --tag "$LATEST_TAG" --push --file Dockerfile .
echo "        Pushed $FULL_TAG"

# ─── 6. ECS Express Mode service ──────────────────────────────────────────────
echo "  [6/6] ECS Express Mode service: $SERVICE_NAME"

# Idempotency: find OUR service in the target cluster so a re-run updates in
# place. Match the service-name segment EXACTLY — a prefix match could hit a
# sibling service and, since serviceArns ordering isn't guaranteed, update the
# wrong one.
# NB: the SERVICE_NAME assignment must sit on the python3 side of the pipe — a
# prefix on `aws` doesn't reach the second command, and the 2>/dev/null||true
# would silently swallow the KeyError, making every re-run "create" a duplicate.
EXISTING_ARN=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" --output json 2>/dev/null \
  | SERVICE_NAME="$SERVICE_NAME" python3 -c "
import json, os, sys
want = os.environ['SERVICE_NAME']
for arn in json.load(sys.stdin).get('serviceArns', []):
    if arn.rsplit('/', 1)[-1] == want:
        print(arn); break
" 2>/dev/null || true)

# Runtime env. HOSTNAME=0.0.0.0 + PORT=8080 mirror the App Runner fix: Next.js
# standalone binds to whatever HOSTNAME resolves to, so pin it to all-interfaces
# or the ALB target health check on :8080 fails.
#
# Env is ADDITIVE, never subtractive: start from the LIVE service's existing
# environment (so a redeploy from a shell that didn't export every var can't
# silently drop CODING_AGENT_RUNTIME_ARN etc. and break the app), then overlay
# any values the current shell/.env.local provides.
source "$REPO_ROOT/deploy/config.sh" 2>/dev/null || true
EXISTING_ENV='[]'
if [[ -n "$EXISTING_ARN" ]]; then
  EXISTING_ENV=$(aws ecs describe-express-gateway-service --service-arn "$EXISTING_ARN" --region "$AWS_REGION" \
    --query 'service.activeConfigurations[0].primaryContainer.environment' \
    --output json 2>/dev/null || echo '[]')
  [[ "$EXISTING_ENV" == "null" ]] && EXISTING_ENV='[]'
fi
ENV_JSON=$(EXISTING_ENV="$EXISTING_ENV" python3 -c "
import json, os
env = {e['name']: e['value'] for e in json.loads(os.environ.get('EXISTING_ENV') or '[]') if e.get('name')}
env.update({'HOSTNAME': '0.0.0.0', 'PORT': '8080', 'NODE_ENV': 'production'})
# Overlay only vars actually present in this shell's environment.
for k in ['AWS_REGION','CODING_AGENT_RUNTIME_ARN','EMBER_TABLE','ARTIFACT_BUCKET','DEPLOYMENT_URL','NEXT_PUBLIC_BRAND_NAME',
          'COGNITO_USER_POOL_ID','COGNITO_CLIENT_ID','COGNITO_CLIENT_SECRET','COGNITO_DOMAIN','EMBER_AUTH_DISABLED',
          'COGNITO_CLI_CLIENT_ID','EMBER_SECRETS_BACKEND']:
    v = os.environ.get(k)
    if v: env[k] = v
print(json.dumps([{'name': k, 'value': v} for k, v in env.items()]))
")
# Hard guard: never deploy without the runtime ARN — the whole app is dead without it.
if ! ENV_JSON="$ENV_JSON" python3 -c "
import json, os, sys
env = {e['name']: e.get('value') for e in json.loads(os.environ['ENV_JSON'])}
sys.exit(0 if env.get('CODING_AGENT_RUNTIME_ARN') else 1)
"; then
  echo "ERROR: CODING_AGENT_RUNTIME_ARN missing from both the live service and this shell." >&2
  echo "       Export it (or set it in deploy/config.sh) before deploying." >&2
  exit 1
fi
# Auth guard: fail closed. Either a Cognito pool must be wired (multi-tenant) OR
# the deployer must explicitly opt into the no-auth personal mode. Shipping with
# neither would leave every session reachable by anyone.
if ! ENV_JSON="$ENV_JSON" python3 -c "
import json, os, sys
env = {e['name']: e.get('value') for e in json.loads(os.environ['ENV_JSON'])}
sys.exit(0 if env.get('COGNITO_USER_POOL_ID') or env.get('EMBER_AUTH_DISABLED') == '1' else 1)
"; then
  echo "ERROR: No auth configured. Set COGNITO_* (run deploy/cognito/setup-cognito.sh) for" >&2
  echo "       multi-tenant auth, or export EMBER_AUTH_DISABLED=1 for a personal no-auth deploy." >&2
  exit 1
fi

PRIMARY_CONTAINER="{\"image\":\"${FULL_TAG}\",\"containerPort\":8080,\"environment\":${ENV_JSON}}"

# Optional explicit networking (only when there's no usable default VPC).
NET_ARG=()
if [[ -n "${EXPRESS_SUBNETS:-}" ]]; then
  SUBNETS_JSON=$(printf '"%s",' ${EXPRESS_SUBNETS//,/ }); SUBNETS_JSON="[${SUBNETS_JSON%,}]"
  SG_JSON="[]"
  if [[ -n "${EXPRESS_SECURITY_GROUPS:-}" ]]; then
    SG_JSON=$(printf '"%s",' ${EXPRESS_SECURITY_GROUPS//,/ }); SG_JSON="[${SG_JSON%,}]"
  fi
  NET_ARG=(--network-configuration "{\"subnets\":${SUBNETS_JSON},\"securityGroups\":${SG_JSON}}")
fi

# Health check: /api/auth/health is the ONLY unauthenticated 200 — / redirects
# (307/302) to /login when Cognito is on, which the target group counts unhealthy.
HEALTH_PATH="/api/auth/health"

if [[ -n "$EXISTING_ARN" ]]; then
  echo "        Service exists — updating in place..."
  aws ecs update-express-gateway-service \
    --service-arn "$EXISTING_ARN" --region "$AWS_REGION" \
    --primary-container "$PRIMARY_CONTAINER" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --cpu "$CPU" --memory "$MEMORY" \
    --health-check-path "$HEALTH_PATH" \
    --monitor-resources \
    ${NET_ARG[@]+"${NET_ARG[@]}"} \
    --output text >/dev/null
  SERVICE_ARN="$EXISTING_ARN"
else
  echo "        Creating new service..."
  SERVICE_ARN=$(aws ecs create-express-gateway-service \
    --service-name "$SERVICE_NAME" --cluster "$CLUSTER" --region "$AWS_REGION" \
    --primary-container "$PRIMARY_CONTAINER" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --cpu "$CPU" --memory "$MEMORY" \
    --health-check-path "$HEALTH_PATH" \
    --scaling-target '{"minTaskCount":1,"maxTaskCount":4}' \
    --monitor-resources \
    ${NET_ARG[@]+"${NET_ARG[@]}"} \
    --query 'service.serviceArn' --output text)
fi

# ─── Wait for ACTIVE + resolve the URL ────────────────────────────────────────
# statusCode is only ACTIVE|DRAINING|INACTIVE — a fresh service starts INACTIVE
# and flips to ACTIVE once the ALB targets pass health checks (no FAILED state).
# The public endpoint lives at activeConfigurations[].ingressPaths[].endpoint
# (there is no service.url field).
echo "        Waiting for ACTIVE (5–10 min)..."
STATUS="UNKNOWN"; STATUS_REASON=""; SERVICE_URL=""
for i in $(seq 1 90); do
  DESC=$(aws ecs describe-express-gateway-service \
    --service-arn "$SERVICE_ARN" --region "$AWS_REGION" --output json 2>/dev/null || echo '{}')
  # \x1f field separator: a non-whitespace delimiter so `read` can't collapse an
  # empty middle field (URL is empty while INACTIVE) and shift the columns.
  IFS=$'\x1f' read -r STATUS SERVICE_URL STATUS_REASON <<<"$(echo "$DESC" | python3 -c "
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
s = d.get('service', {})
st = s.get('status') or {}
url = ''
for cfg in s.get('activeConfigurations', []) or []:
    for ing in cfg.get('ingressPaths', []) or []:
        if ing.get('endpoint'):
            url = ing['endpoint']; break
    if url: break
sys.stdout.write('\x1f'.join([st.get('statusCode', 'UNKNOWN'), url, st.get('statusReason', '')]))
" 2>/dev/null || printf 'UNKNOWN\x1f\x1f')"
  # ACTIVE can briefly precede the ingress endpoint being published — need both.
  if [[ "$STATUS" == "ACTIVE" && -n "$SERVICE_URL" ]]; then break; fi
  printf "        [%02d] %s ...\r" "$i" "$STATUS"
  sleep 10
done
echo ""

if [[ "$STATUS" != "ACTIVE" ]]; then
  echo "        ERROR: service did not reach ACTIVE (last status: ${STATUS})." >&2
  [[ -n "$STATUS_REASON" ]] && echo "        Reason: ${STATUS_REASON}" >&2
  echo "        Inspect: aws ecs describe-express-gateway-service --service-arn ${SERVICE_ARN} --region ${AWS_REGION}" >&2
  exit 1
fi

[[ "$SERVICE_URL" != http* && -n "$SERVICE_URL" ]] && SERVICE_URL="https://${SERVICE_URL}"
echo "        Service URL: ${SERVICE_URL:-<pending — re-run describe shortly>}"

# Persist DEPLOYMENT_URL (only when resolved, so a transient empty endpoint
# can't blank a previously-good value). Cognito callback URLs + the MCP deep
# links read this.
if [[ -n "$SERVICE_URL" ]]; then
  if grep -q '^DEPLOYMENT_URL=' .env.local 2>/dev/null; then
    sed "s|^DEPLOYMENT_URL=.*|DEPLOYMENT_URL=\"${SERVICE_URL}\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
  else
    echo "DEPLOYMENT_URL=\"${SERVICE_URL}\"" >> .env.local
  fi
  chmod 600 .env.local
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  Ember deployed → ${SERVICE_URL:-<pending>}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Post-deploy notes:"
echo "    • SSE: raise the service ALB's idle timeout to >= 3600s (default 60s)"
echo "      or long coding-turn streams get cut. See deploy/ecs-express/README.md."
echo "    • Cognito: add ${SERVICE_URL:-<url>}/api/auth/callback to the app"
echo "      client's callback URLs if this URL is new."
