# ECS Express Mode deploy

The recommended web-tier hosting path. **App Runner is closed to new AWS
customers** ([availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html),
end of support 2026-04-30); ECS Express Mode is AWS's named successor — one API
call provisions a Fargate service, an Application Load Balancer, auto scaling,
and a public `https://<service>.ecs.<region>.on.aws` URL.

The container is byte-identical to the App Runner path (same `Dockerfile`, same
`HOSTNAME=0.0.0.0` + `PORT=8080` binding); only the hosting control plane
differs. Existing App Runner deploys keep working — see Migration below.

## Run it

```bash
# prereqs: AWS CLI v2 >= 2.34, Docker running, default VPC, .env.local populated
AWS_PROFILE=<your-profile> ./deploy/ecs-express/deploy.sh
```

Idempotent — re-run any time; an existing `ember` service updates in place.

## What it creates

| Resource | Purpose |
|----------|---------|
| ECR repo `ember-web` | Web image (shared with the App Runner path) |
| `ecsTaskExecutionRole` | ECS pulls the image + writes logs (`AmazonECSTaskExecutionRolePolicy`) |
| `ecsInfrastructureRoleForExpressServices` | ECS provisions the ALB + scaling (`AmazonECSInfrastructureRoleforExpressGatewayServices`) |
| `ember-ecs-task` | The app's OWN runtime perms — AgentCore, DynamoDB, S3, Bedrock, Secrets Manager. Successor to `ember-apprunner-instance` (same policy, `ecs-tasks.amazonaws.com` trust) |
| ECS Express service `ember` | 1 vCPU / 2 GB Fargate, scale 1–4 tasks, TLS URL |

**Three distinct roles — do not merge them.** Execution role = ECS starts the
container; infrastructure role = ECS builds the ALB; task role = the running
app calls AWS.

## Tuning

| Env var | Default | Notes |
|---------|---------|-------|
| `EXPRESS_CPU` | `1024` | ECS CPU units, **not vCPU** (1024 = 1 vCPU). Must be a valid Fargate combo. |
| `EXPRESS_MEMORY` | `2048` | MiB, **not GB**. |
| `EXPRESS_CLUSTER` | `default` | Target cluster. |
| `EXPRESS_SUBNETS` / `EXPRESS_SECURITY_GROUPS` | (default VPC) | Comma-separated; only needed without a usable default VPC. |
| `EXPECTED_ACCOUNT_ID` | (unset) | Refuse to deploy unless creds resolve to this account. |

Runtime env is **additive**: a redeploy merges the live service's environment
with whatever this shell/.env.local provides, so re-running from a fresh shell
can't silently drop `CODING_AGENT_RUNTIME_ARN`. Both the runtime-ARN and
auth (`COGNITO_*` or `EMBER_AUTH_DISABLED=1`) guards fail closed.

## Health check

The ALB health check hits `/api/auth/health` — the only route that returns an
unauthenticated 200. `/` redirects to `/login` when Cognito is on, which the
target group counts as unhealthy.

## SSE (long coding turns)

Coding-turn streams ride SSE through the managed ALB. The ALB's default
`idle_timeout` is **60s** — raise it to `>= 3600` or long turns get cut
mid-stream:

```bash
# find the ALB the Express service created (tagged with the service), then:
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn <alb-arn> \
  --attributes Key=idle_timeout.timeout_seconds,Value=3600
```

## Gotchas (learned the hard way)

- `statusCode` is only `ACTIVE|DRAINING|INACTIVE` — a fresh service starts
  `INACTIVE` and flips to `ACTIVE` when ALB targets pass health checks. There
  is no `FAILED` state; a bad deploy just never goes ACTIVE (the script times
  out and prints `statusReason`).
- The public URL lives at `activeConfigurations[].ingressPaths[].endpoint`.
  There is no `service.url` field.
- `--cpu`/`--memory` are ECS units (1024 = 1 vCPU, 2048 = 2048 MiB).
- Next.js standalone binds to `HOSTNAME` — pin `0.0.0.0` or the `:8080` health
  check fails.
- New URL ⇒ update the Cognito app client's callback URLs
  (`<url>/api/auth/callback`) and re-run `deploy/register-mcp.sh` so the MCP's
  `EMBER_URL` points at the new origin.

## Migrating from App Runner

Nothing forces an immediate move — App Runner keeps serving existing customers
until 2026-04-30. When ready:

1. Run this deploy (creates the ECS service alongside App Runner; both serve
   the same image + stores).
2. Update Cognito callback URLs for the new origin; re-register the MCP.
3. Flip traffic — if you front with your own domain, shift DNS (Route 53
   weighted records give you blue/green); otherwise just start using the
   `.on.aws` URL.
4. Delete the App Runner service:
   `aws apprunner delete-service --service-arn <arn>`.

The legacy path stays at [`deploy/apprunner/deploy.sh`](../apprunner/deploy.sh),
unchanged.
