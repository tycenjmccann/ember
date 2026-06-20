<div align="center">

<img src="marketing/brand/logo/ember-lockup-dark.svg" alt="Ember" width="280" />

### Keep your session warm.

**The open-source coding agent — Claude Code + Codex — that runs inside _your own_ AWS account.**

[![License: MIT](https://img.shields.io/badge/License-MIT-ff6a00.svg)](LICENSE)
[![Runs in your AWS](https://img.shields.io/badge/runs%20in-your%20AWS-ff6a00.svg)](#the-wedge)
[![BYO plan = $0 marginal LLM](https://img.shields.io/badge/BYO%20plan-%240%20marginal%20LLM-ff6a00.svg)](#the-wedge)
[![Self-host](https://img.shields.io/badge/self--host-one%20command-ff6a00.svg)](#stand-it-up-one-command)
[![Open-core](https://img.shields.io/badge/open--core-MIT%20%2B%20enterprise-3a3531.svg)](#open-core)

</div>

<!--
  This is the Ember-branded repository root README. To ship it, copy this file to
  the repo root as README.md (replacing the current "Cloud Code" README). All links
  and the logo <img> are root-relative and resolve from the repo root.
-->

---

Hand Ember a repo and a task at your desk. Close the laptop. The session keeps running
on a **warm micro-VM in your cloud** — not ours. Reopen on the web on your walk to a
meeting, course-correct from your phone over lunch, pull it back home at night. The work
never goes cold, and you get to be outside while the loop runs.

A campfire doesn't go out when you walk away. Bank it right and the embers hold their heat
for hours. **Your session is the ember** — and the product actually tracks it: every session
carries a **warm / idle / cold** state, on a persistent EFS workspace that's still there when
you come back. The name isn't a metaphor bolted on; it's the mechanic.

## The wedge

The incumbents host this on *their* clouds (OpenAI bought Gitpod/Ona for exactly this;
Claude Code on the web runs on Anthropic-managed infrastructure). Ember is the open,
self-hosted alternative: **same capability — your code, your keys, your bill, your model.
Nothing leaves your account.**

- **Bring your own plan** — run on the Claude Pro/Max or ChatGPT plan you *already pay for*.
  **$0 marginal LLM cost.**
- **Or Amazon Bedrock** — pay-per-token, fully in-VPC, nothing leaves your account. Built
  for compliance.
- **Model-agnostic** — Claude *and* Codex, switchable per session.
- **Resumable everywhere** — persistent EFS workspace per session; warm / idle / cold
  warmth dots; deep links to any device.

```
laptop (Claude Code / Codex)  ──port──▶  ember  ──pull──▶  laptop
                                         (AgentCore micro-VM, your account)
```

## Stand it up (one command)

```bash
export AWS_PROFILE=<your-profile>      # creds for the target account
git clone <this-repo> ember && cd ember
npm install
./install.sh
```

`install.sh` is idempotent and stands up everything end to end — DynamoDB + S3, the IAM
execution role, an EFS workspace on your VPC, the AgentCore coding runtime (Claude Code +
Codex), and a public App Runner URL. It prints the live URL at the end.

> **Account guard.** Set `EXPECTED_ACCOUNT_ID` in `.env.local` and the deploy refuses to
> run against any other account — protection against a wrong profile.

## Open-core

MIT self-host, free, forever — the proof it runs in *your* account. The enterprise tier
(SSO, VPC/PrivateLink, per-user secret isolation, audit export, admin console) is the paid
layer. Same playbook as GitLab and Supabase. See [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md).

---

<div align="center">

**Close the lid. It's still burning.**

</div>
