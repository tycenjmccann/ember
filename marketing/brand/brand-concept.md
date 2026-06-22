# Ember — Brand Concept

> **Keep your session warm.**

Ember is the open-source coding agent (Claude Code + Codex) that runs inside *your own*
AWS account. Hand it a repo and a task at your desk; close the laptop; the session keeps
running on a warm micro-VM in your cloud. Pick it back up from the web on the walk to a
meeting, course-correct from your phone over lunch, pull it back home at night. The work
never goes cold — and you get to be outside while the loop runs.

---

## The one-liner

**Ember runs your coding agent in your own cloud, so the build keeps going while you don't.**

## The story (why the name)

A campfire doesn't go out when you walk away from it. Bank it right and the embers stay
hot for hours — you come back, breathe on it, and it flares straight back to life.

That's the product. Your session is the ember. Close the lid (walk away from the fire);
the micro-VM stays *warm* in your AWS account (the embers hold their heat); reopen on any
device and it flares back instantly — same workspace, same context, still running. The
incumbents make you sit and tend a fire on *their* land. Ember keeps yours hot on *your*
ground, and frees you to go live your life while it burns down the work.

The product literally has **warm / idle / cold** session states. The name isn't a
metaphor we bolted on — it's the mechanic. That's why it's unkillable as a brand.

## The feeling we're selling

Not "grind harder at the terminal." The opposite: **work happens while you're at the
campfire.** Roasting s'mores at the beach. Dutch oven over coals in the woods. Whistling
while dinner cooks. Phone in pocket buzzes — a PR's ready — you glance, tap "ship it," and
go back to the fire. Agentic loops run; you're outside more. That's the life Ember sells.

The emotional pivot of every piece of marketing: **the relief of closing the laptop and
smiling** while your peers look stressed. You're on Ember. Your fire's still warm.

## What it actually is

- **Claude Code + Codex, on the web**, running on per-session micro-VMs (Amazon Bedrock
  AgentCore) inside the customer's own AWS account.
- **Bring your own plan** (Claude Pro/Max or ChatGPT) → $0 marginal LLM cost — or Bedrock
  pay-per-token, fully in-VPC for compliance.
- **Resumable everywhere** — persistent EFS workspace per session; close the lid, resume
  from any device via deep links. Warm/idle/cold warmth dots.
- **Laptop ⇄ cloud handoff** — `port` a live local session up to the cloud, `pull` the
  grown session back home (the `port-session` MCP).
- **Your code, your keys, your bill, your model — nothing leaves your account.**
- **Open-core**: MIT self-host (top of funnel) + paid enterprise tier (SSO, VPC/PrivateLink,
  per-user secret isolation, audit export, admin console).

## Who it's for

| Avatar | Who | The ache | The Ember promise |
|---|---|---|---|
| **Maya, the maker** | Indie dev / founder on a Claude Max plan | "I have to babysit the terminal. I can't step away." | Fire a task, close the lid, live your day. It's still building. |
| **Dev the staff eng** | Senior eng at a 50–500 person co | "Our security team won't let our code touch a vendor cloud." | It runs in *your* VPC, on *your* bill, with logs in *your* CloudWatch. |
| **Priya, the platform lead** | Eng platform / security owner | "Post-Ona, leadership wants agentic coding without the data-exfil risk." | Self-host the open core; buy the enterprise tier when you're ready. |

## Positioning

**For** developers and teams who want agentic coding **without** handing their code to a
vendor's cloud, **Ember is** a self-hosted coding agent that runs in your own AWS account
and keeps your session warm across every device — **unlike** Claude Code on the web or
OpenAI Codex/Ona, which lock the agent to *their* cloud and *their* model.

The wedge, in one breath: *same capability, but the code, the credentials, the audit logs,
and the model choice stay in your account.*

## Brand pillars

1. **Stays warm.** Close the lid; the work doesn't stop. (resumable, never-cold sessions)
2. **Your ground.** Your account, your keys, your bill, your model. (sovereignty)
3. **Go outside.** The agent runs so you don't have to sit there. (life, not grind)
4. **Open by the fire.** MIT core, no lock-in, community around the campfire. (open-core)

## Voice & tone

Warm, plainspoken, confident. Outdoorsy without being folksy-corny. We talk like a person
who's relaxed *because* the work is handled — never anxious, never hype-bro.

- **Do:** short, declarative, sensory. "Close the lid. It's still burning." / "Your fire,
  your land." / "Bank it and walk away."
- **Don't:** enterprise mush ("leverage synergies"), AI-hype ("revolutionary 10x"), or
  cutesy overload (no campfire pun in *every* sentence — let it breathe).
- **Campfire lexicon** (use sparingly, deliberately): warm, bank the fire, kindling, spark,
  flare up, coals, ember, glow, by the fire, go outside, the long burn.
- **Tagline:** *Keep your session warm.*
- **Alt lines:** "Close the lid. Stay warm." · "The build keeps burning while you don't." ·
  "Your fire. Your land." · "Go outside. It's handled."

## Visual world

- **Hero motion (signature):** macro shot of a *real* ember in a campfire — glowing,
  breathing, sparks lifting — that **morphs into the Ember logo mark** (the glowing ember
  tip). Real fire → brand. This transition is the single most important asset; it opens the
  launch video and the landing hero.
- **Imagery:** real campfire scenes, golden-hour and night. Beach bonfire + s'mores. Dutch
  oven over coals in the woods. Faces lit warm by firelight, relaxed, laptop *closed*. Sparks
  against a dark treeline. Never stocky/sterile — warm, grainy, alive.
- **The logo:** an **ember** — the glowing tip of a charred log / a single live coal — that
  reads instantly at favicon size as a hot dot with a soft bloom. Pairs with a clean wordmark
  "ember" (lowercase, warm geometric). The CLI is `ember`.
- **Mood:** night woods, warm black, one source of light (the ember glow) against the dark.
  The existing app is already a true-black dark UI — that *is* the night. We light it with
  ember-orange instead of iOS blue.

See `design.md` for exact tokens, the logo system, and the app-redesign palette.
