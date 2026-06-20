# Cloud Code for the enterprise

The wedge in one sentence: **Claude Code / Codex on the web, running inside your
own AWS account** — your code, your credentials, your audit logs, your model
choice. This doc is the gap list between the open single-user build and a
company-wide rollout, plus why that posture matters right now.

## Why now

| Offering | Where the agent runs | Model | Your code leaves your account? |
|---|---|---|---|
| Claude Code on the web | Anthropic-managed cloud | Claude only | Yes |
| OpenAI Codex + Ona/Gitpod (acq. Jun 2026) | OpenAI-managed cloud | OpenAI only | Yes |
| **Cloud Code (this)** | **Your AWS account** | **Claude *and* Codex *and* Bedrock** | **No** |

The incumbents validated the category and then locked it to their cloud + their
model. The unmet enterprise ask — *"can the agent run in our VPC, on our bill, on
the model our compliance team approved, with logs in our CloudWatch?"* — is exactly
what this answers. Post-Ona, every platform/security team is asking it.

## What ships today

- Per-session coding microVM (Amazon Bedrock AgentCore Runtime) with a persistent
  EFS workspace — clone, build, commit, PR, resume.
- Two cost models per session: Amazon Bedrock (pay-per-token, in-account) **or**
  bring-your-own Claude/ChatGPT plan ($0 marginal LLM).
- Live web terminal over a presigned `wss://` straight to the microVM.
- Laptop ⇄ cloud session handoff (the `port-session` MCP).
- One-command install into a fresh account (`install.sh`).

## The gap to enterprise-ready

Ordered by what unblocks a paid pilot fastest.

### 1. Authentication + multi-tenancy  *(blocker)*
Today every row is `userId: "default"` and the API has no auth — fine behind a
private URL for one person, unacceptable for a team.
- **AuthN:** Amazon Cognito user pool (hosted UI) or SAML/OIDC federation to the
  customer's IdP (Okta, Entra, Google). App Runner sits behind it.
- **AuthZ:** stamp the real `sub` on every session, config, and auth row; filter all
  list/get/delete by it. The data model already keys on `userId` — it's a
  find-and-replace of `DEFAULT_USER_ID`, not a migration.
- **API gate:** middleware that rejects unauthenticated requests to
  `/api/cloud-code/*`, including the port/checkpoint/presign endpoints.

### 2. Network isolation  *(the core enterprise selling point)*
- Put App Runner behind a **VPC connector**; reach DynamoDB/S3/Bedrock over **VPC
  endpoints (PrivateLink)** so nothing transits the public internet.
- The coding runtime already runs in-VPC (EFS). Add private-subnet + NAT (or a
  fully private egress allowlist) so the agent can reach only approved Git hosts /
  package registries.
- Optional: private App Runner ingress + WAF, or front with an internal ALB.

### 3. Per-user credential isolation  *(security)*
- Subscription tokens + ported transcripts live in S3 under `cloud-code/{userId}/…`.
  Move secrets to **AWS Secrets Manager** (or AgentCore Identity vault) with
  per-user KMS grants; scope the runtime role so a session can read only its own
  user's prefix (IAM session policy / ABAC on `userId` tag).
- Short-lived, scoped GitHub tokens (GitHub App installation tokens) instead of a
  single shared PAT.

### 4. Audit + observability  *(compliance)*
- OTel → CloudWatch tracing already exists. Add an **immutable audit log** (every
  turn, shell command, file write, model + token count) to a dedicated, write-once
  store the customer owns.
- CloudTrail data events on the artifact bucket; per-session cost attribution via
  AgentCore metrics tagged by `userId`/team.

### 5. Cost governance
- Per-user / per-team **budget caps** and quotas (sessions/day, tokens/month);
  pause or downgrade model when exceeded.
- Default to "bring your own plan" for ICs (eliminates LLM spend); reserve Bedrock
  for compliance-restricted repos.

### 6. Admin surface
- Org dashboard: users, active sessions, spend, audit search.
- Repo allowlist, model allowlist, SSO group → permission mapping.

## Suggested rollout

1. **Pilot (single team, private):** items 1–2. SSO + VPC isolation. This is the
   demo that closes a security review.
2. **Department:** items 3–4. Per-user secret isolation + audit export.
3. **Org-wide:** items 5–6. Budgets, admin console, AWS Marketplace listing for
   procurement-friendly purchasing and co-sell.

## Business model

Open-core. The self-host build stays MIT and free — it's the top-of-funnel and the
proof the thing runs in *your* account. The enterprise tier (SSO, VPC/PrivateLink,
per-user secret isolation, audit export, admin console, support SLA) is the paid
layer, sold per-seat or via AWS Marketplace. Same playbook as GitLab / Supabase.
