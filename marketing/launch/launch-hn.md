# Ember — Show HN

## Title

**Show HN: Ember – Claude Code and Codex on the web, running in your own AWS account**

(Backup titles, pick by character/clarity:)
- Show HN: Ember – self-hosted Claude Code/Codex that runs in your AWS, not a vendor's
- Show HN: Ember – open-source cloud coding agent that runs in your own AWS account

---

## First comment

Hi HN — I built Ember because I wanted Claude Code / Codex "on the web" (fire a task, close
the laptop, resume from my phone) without my code, credentials, and model choice living on
someone else's cloud.

What it is: you point `install.sh` at an AWS account and it stands up the whole thing — a
per-session coding micro-VM on Amazon Bedrock AgentCore Runtime with a persistent EFS
workspace, a DynamoDB session store, and a Next.js web UI on App Runner. You give it a repo
and a task; it clones, codes, builds, and opens a PR server-side. Each session maps to a
warm micro-VM, so you can close the laptop and resume the *same* session from any device via
a deep link. The sidebar shows warm/idle/cold state per session.

Why it exists, specifically now: the hosted offerings validated the category and then locked
it to their cloud and their model. Claude Code on the web runs on Anthropic-managed infra;
OpenAI bought Gitpod/Ona to run Codex on theirs. The thing my old platform/security team
actually wanted — "can the agent run in our VPC, on our bill, on the model our compliance
team approved, with logs in our CloudWatch?" — none of them answer. Ember is that: same
capability, but the code, the credentials, the audit logs, and the model choice stay in your
account.

How it differs from the hosted ones, concretely:
- **Runs in your AWS account.** Not a vendor cloud. Set `EXPECTED_ACCOUNT_ID` and the deploy
  refuses to run anywhere else.
- **Bring your own plan.** Connect the Claude Pro/Max or ChatGPT plan you already pay for and
  sessions run on it — $0 marginal LLM cost. Or use Bedrock pay-per-token, fully in-VPC, for
  compliance-restricted repos. Switchable per session.
- **Model-agnostic.** Claude *and* Codex, not one wrapped vendor.
- **Laptop ⇄ cloud handoff** via a small stdio MCP server: `port` a live local session up to
  the cloud (it commits/pushes in-flight work and ships the raw transcript so the cloud runs
  native `claude --resume <id>`), and `pull` the grown session back home. It's lossless
  because it moves the real `.jsonl` transcript, not a summary.
- **Live web terminal** — xterm.js over a presigned `wss://` straight to the micro-VM; the
  server only signs the URL, the browser talks to AgentCore directly.

Honesty about where it is: out of the box it's single-user (`userId: "default"`) with no auth
on the API — fine for a personal deploy behind a private URL, not for multi-tenant or public
exposure. The path to SSO, per-user IAM scoping, VPC/PrivateLink isolation, and audit export
is written up in `docs/ENTERPRISE.md`. It's open-core: the self-host build is MIT and free;
the enterprise hardening is the paid tier (GitLab/Supabase model).

Cost in practice: infra is a rounding error (App Runner + AgentCore idle CPU is free, DynamoDB/
S3 are cents); the LLM is ~95% of cost, and that's $0 marginal if you connect your own plan.
There's a `/cost` calculator in the app.

Stack: Next.js, AgentCore Runtime (ARM64 image → ECR), EFS, App Runner, DynamoDB, S3, OTel →
CloudWatch.

Repo: [link]. MIT.

I'd love feedback on two things specifically: (1) the port/pull transcript handoff — is
overwriting the local `.jsonl` on pull the right default (cloud-canonical, with a `.bak`), or
should it merge? (2) for those of you who've been through a security review for agentic
coding tools — what's the one thing that would actually unblock a pilot at your company? Happy
to answer anything.
