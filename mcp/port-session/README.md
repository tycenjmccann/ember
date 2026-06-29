# port-session-mcp

Local **stdio MCP server** that moves a live coding session between your laptop
and **Ember** — both directions. Close the laptop mid-task, resume the exact
session on your phone; pick it back up at your desk later. Same session id, full
history, no context lost.

```
        ── port (laptop → cloud) ──▶
you (local Claude Code)                         Ember (cloud microVM)
        ◀── pull (cloud → laptop) ──
```

## The round trip

```
PORT  "port this to the cloud, I'm catching the train"
  1. commit + push in-flight work to a branch     (cloud only sees the remote)
  2. POST /sessions/port  → create session + presigned S3 PUT
  3. upload this session's raw transcript (.jsonl) to S3
  4. pre-warm the microVM (clone + checkout + install transcript) so open is instant
  5. return a deep link  (+ the /pull command for later)
        ▼  open on phone → claude --resume <id>, continue

PULL  "I'm back at my desk"  →  /mcp__port-session__pull cc-...
  1. POST /sessions/[id]/checkpoint → cloud uploads the GROWN transcript to S3
  2. download it → overwrite the local ~/.claude/projects/<slug>/<id>.jsonl
     (prior local copy backed up to .bak-<stamp>)
  3. git pull the cloud's branch (fast-forward; skipped if local tree is dirty)
  4. print:  /exit  then  claude --resume <id>   → continue locally
```

## Why it's lossless (native `--resume`)

- We ship the **raw transcript**, not a summary. Claude Code stores each session
  at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; the filename equals the
  `sessionId` inside, so the file *is* the resume handle.
- The cloud drops it under the workspace's project slug
  (`re.sub(r'[^a-zA-Z0-9]','-', realpath(cwd))` — the exact rule Claude uses) and
  runs `claude --resume <id>`. The conversation continues; it's the same session,
  grown — so pull just brings the bigger file home and overwrites the stale one.
- **Cloud is canonical on pull.** Overwrite is the point. A *differing* local copy
  is backed up to `<id>.jsonl.bak-<stamp>` first, so a divergent local branch is
  recoverable.

## Build

```bash
cd mcp/port-session
npm install
npm run build
```

## Register with your local Claude Code

Add to your global MCP config (`~/.claude.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "port-session": {
      "command": "node",
      "args": ["/absolute/path/to/ember/mcp/port-session/dist/index.js"],
      "env": {
        "EMBER_URL": "https://<your-app-runner-url>",
        "EMBER_TOKEN": "<your-cognito-id-token>"
      }
    }
  }
}
```

`EMBER_URL` = the deployed app base URL. The tool reads git + the transcript
for whatever directory it's launched in (its `cwd`), so run Claude Code from
inside the repo you're porting. Reconnect (`/mcp`) after a rebuild to load changes.

### Auth (multi-tenant deploys)

If the deploy has Cognito auth on, every API call must carry your identity. The
MCP attaches a Cognito id-token as a **Bearer token** to its `EMBER_URL` calls.

**You don't have to do anything — login is automatic.** The first time you run
`port` / `pull` / `sync-config` / `login` against an auth-enabled deploy without
a valid token, the call gets a `401`, the MCP **opens the Cognito Hosted UI in
your browser**, captures the result on a localhost loopback (PKCE — no client
secret), saves the tokens to `~/.ember/credentials.json` (mode 0600), and retries
the call. After that the id-token **auto-refreshes** from the stored refresh
token — you sign in once, transparently, and not again until the session fully
expires.

Want to sign in ahead of time (or switch accounts)? Run it explicitly:

```
/mcp__port-session__auth
```

Token source order (first wins):
1. `EMBER_TOKEN` env — explicit override (e.g. CI with a pre-minted token).
2. `~/.ember/credentials.json` — from `authenticate`; auto-refreshed.
3. `~/.ember/token` — a plain id-token you dropped in (`EMBER_TOKEN_FILE` overrides the path).

The token is sent **only** to `EMBER_URL`, never to the presigned S3 URLs (those
carry their own signature). For a personal deploy (`EMBER_AUTH_DISABLED=1`) leave
all unset — calls go through unauthenticated, as before.

## Tools

### `port_session_to_cloud`  (slash: `/mcp__port-session__port`)

| Arg | Default | Notes |
|---|---|---|
| `title` | `Ported: <repo>` | Session name shown in the sidebar. |
| `branch` | current branch | Branch to push the in-flight work to (and check out in the cloud). |
| `firstPrompt` | a default nudge | First instruction to the resumed agent. |
| `view` | `chat` | Surface the session opens in. `terminal` auto-runs `claude --resume` in a live PTY; persisted to the session so a sidebar tap reopens it the same way. |
| `cli` | `claude` | Cloud CLI to resume with (`claude` or `codex`). |
| `commitMessage` | auto | Message for the in-flight snapshot commit. |
| `cwd` | server cwd | Where the transcript is read (the dir Claude Code launched in). |
| `repoDir` | = `cwd` | Git repo dir, when it differs from `cwd` (e.g. Claude Code launched from a parent, code is in a subdir). Git ops run here. |
| `preferBundle` | `false` | Force bundle mode even if origin is writable (don't push a wip branch to a shared/upstream repo). |

**Git is flexible** — the transcript always ships; how your *code* reaches the cloud adapts:

| Mode | When | What the cloud does |
|---|---|---|
| `pushed` | origin is writable | commits + pushes a branch; cloud clones it |
| `bundle` | origin is read-only (e.g. an aws-samples clone you don't own) or `preferBundle` | ships a git **bundle** of your in-flight commits; cloud clones the upstream and `git fetch`es the bundle on top — no push rights needed |
| `selfContained` | **no usable remote** — no origin, unreachable, or not even a git repo yet | `git init`s if needed, commits everything, ships a **`bundle --all`** of the whole repo (history + branches); the cloud rebuilds a standalone repo from it. **Nothing leaves your AWS account — no GitHub, no push.** This is the "I never set up a remote and I'm in a hurry" path: it just works. Wire a real remote later with `git remote add` + push. |
| `none` | truly empty workspace (no files) | ships only the transcript; the cloud resumes the conversation in a bare workspace |

You never have to set up a remote to port — if there isn't one, `selfContained`
captures the whole project automatically. The result message tells you which mode
ran and, for `selfContained`, how to push to a real remote later when you want to.

Slash command's one comma arg: `view, title, first prompt, new branch` (all optional).
Returns a deep link `<EMBER_URL>/ember?session=<id>` + the `/pull` command for the return leg.

### `pull_session_from_cloud`  (slash: `/mcp__port-session__pull`)

| Arg | Default | Notes |
|---|---|---|
| `session` | — (required) | The `cc-...` id or the full Ember session URL. |
| `cwd` | server cwd | Project dir to resume into (where the transcript + branch land). |

Brings the cloud's work home and prints `/exit` + `claude --resume <id>`.

### `sync_cli_config`  (slash: `/mcp__port-session__sync-config`)

**One-time setup** (re-run when your local config changes) — mirror this laptop's
coding-CLI configuration to Ember so every future cloud session is a clone of
your local setup. **Not** part of porting; it writes the per-user config bundle the
runtime materializes on each turn (the same `/config` bundle you'd otherwise upload
by hand).

| Arg | Default | Notes |
|---|---|---|
| `cli` | — (required) | `claude` or `codex`. One at a time — run twice for both. |

What it ships per CLI:

| `cli` | Source → bundle | |
|---|---|---|
| `claude` | `~/.claude/CLAUDE.md`, `agents/`, `skills/`, `commands/`, `output-styles/` → `claude/…`; `~/.claude.json` `mcpServers` → `claude/.mcp.json` | |
| `codex` | `~/.codex/config.toml`, `AGENTS.md`, `prompts/` → `codex/…` | |

**Scoped merge** — syncing one CLI folds its subtree into the current bundle and
leaves the other CLI's files intact (the `/config` route merges by top-level dir).

**Portability contract (what runs in the cloud).** The cloud microVM is Linux
ARM64 with `node`/`npx`, `uv`/`uvx`, `pip`, and headless `chromium` baked in — it
carries the *launchers*, not anyone's specific servers, so each server self-installs
on first launch. Sync classifies every MCP server into three buckets and **only
ships the runnable ones**:

| Verdict | What it is | Shipped? |
|---|---|---|
| ✅ **works** | remote (`http`/`sse`) or registry-launched (`npx`/`uvx`/`pipx`) | yes — self-installs |
| 🔑 **needs-secret** | runnable, but an `env` value looks secret (token/key/…) | yes, value blanked — set the token in the cloud later (vault TBD) |
| 🚫 **unsupported** | local-path command, interpreter+local-script, bare binary not in the image, or platform-locked (e.g. `xcodebuild` → needs macOS) | **dropped** — the report tells you to reconfigure as `uvx <pkg>` / `npx <pkg>` |

The sync output prints all three buckets so you know exactly what will and won't
work, and how to fix the rest. `port-session` itself is always excluded. Secret env
is never uploaded (Codex `config.toml` ships verbatim — check it for inline secrets).

### `authenticate`  (slash: `/mcp__port-session__auth`)

**Optional / manual** — sign-in is normally automatic (any tool that hits a
`401` triggers this same flow and retries). Run it explicitly only to sign in
ahead of time or switch accounts. Opens the Hosted UI in your browser, captures
the code on a localhost loopback (PKCE — no client secret), and writes
`~/.ember/credentials.json`. One-time; the id-token then auto-refreshes. No args.
A personal deploy (`EMBER_AUTH_DISABLED=1`) needs no login. Requires the public
CLI client — the admin gets it from `deploy/cognito/setup-cognito.sh`
(`COGNITO_CLI_CLIENT_ID`).

## Limits / future

- **Claude only.** `--resume` is a Claude Code mechanism. Codex resume uses a
  different `thread_id`, not wired through the transcript path yet.
- **Multi-tenant aware.** Sends a Cognito Bearer token (`EMBER_TOKEN` /
  `~/.ember/token`) so ported sessions land in your tenant. Unset = personal
  no-auth deploy. The identity rides the API calls; the per-user config/auth
  bundle the cloud materializes is keyed off it.
- **Pull skips a dirty local tree** (won't clobber uncommitted work) — it fetches
  the branch and tells you to stash/checkout manually.
