# Ember — Product Hunt launch

## Tagline (<= 60 chars)

**Keep your coding agent warm in your own AWS account** *(50 chars)*

Alternates:
- `Claude Code + Codex, self-hosted in your AWS account` (52)
- `Close the laptop. Your coding agent keeps running.` (50)
- `The coding agent that runs in your cloud, not ours` (50)

---

## Name

Ember

---

## Description

Ember is the open-source coding agent — Claude Code + Codex — that runs inside your *own*
AWS account.

Hand it a repo and a task at your desk. Close the laptop. The session keeps running on a
warm micro-VM in your cloud. Reopen on the web on your walk to a meeting, fix it from your
phone over lunch, pull it home at night. Same session, full context, still building.

A campfire doesn't go out when you walk away — bank the coals and they hold heat for hours.
Your session is the ember. Close the lid, the micro-VM stays warm, reopen anywhere and it
flares right back to life.

The difference from the hosted tools: your code, your keys, your bill, your model. Nothing
leaves your account.

🔥 **Bring your own plan** — run on the Claude Pro/Max or ChatGPT plan you already pay for.
$0 marginal LLM cost. (Or Bedrock pay-per-token, fully in-VPC, for compliance.)
🔥 **Runs in your AWS** — one command stands up the whole thing; set an account guard so it
can't deploy anywhere else.
🔥 **Resumable everywhere** — warm/idle/cold sessions, persistent workspace, deep links to
any device.
🔥 **Model-agnostic** — Claude *and* Codex, switchable per session.
🔥 **Open-core** — MIT self-host, free forever. Paid enterprise tier (SSO, VPC/PrivateLink,
per-user secrets, audit export).

Close the lid. Stay warm.

---

## First comment (maker comment)

Hey Product Hunt 👋

I kept hitting the same wall: I loved the idea of a coding agent "on the web" — fire a task,
walk away, resume from my phone — but I didn't want my code and credentials living on a
vendor's cloud, and I didn't want a second LLM bill when I already pay for Claude Max.

So Ember runs the agent in *your* AWS account instead. One `install.sh` stands up a
per-session micro-VM (Amazon Bedrock AgentCore), a persistent workspace, and a web UI. You
connect the plan you already have and sessions run on it — $0 marginal LLM. Close the laptop;
the session stays warm; reopen on any device and it's exactly where you left it.

The name's not decoration — sessions literally have warm / idle / cold states. Bank the coals,
walk away, breathe it back to life.

It's MIT and self-hostable today. The enterprise tier (SSO, VPC isolation, audit) is the paid
layer — open-core, GitLab-style.

Would genuinely love to know: what's stopped *you* from stepping away from the terminal? AMA
below. 🔥

---

## Gallery image captions (5)

1. **Close the lid. It's still burning.** — A closed laptop by a beach bonfire at dusk; phone
   in pocket shows one warm "session warm" dot. The whole pitch in one frame.

2. **Warm. Idle. Cold.** — The session sidebar, true-black UI lit by ember-orange, three
   sessions with glowing warmth dots — one breathing live, one dimming, one gone out.

3. **Your account. Your keys. Your bill. Your model.** — The architecture in one line:
   `laptop → port → ember (AgentCore micro-VM, *your* AWS) → pull → laptop`. Nothing leaves
   your account.

4. **$0 marginal LLM.** — The cost calculator screen: connect the Claude/ChatGPT plan you
   already pay for, watch the LLM line drop to zero. Bedrock pay-per-token shown as the
   compliance option.

5. **One command. Your cloud. An afternoon.** — Terminal mid-`./install.sh`, the resource
   table filling in (DynamoDB, IAM role, EFS, AgentCore runtime, App Runner URL), ember-orange
   on warm black.
