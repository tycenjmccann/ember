#!/usr/bin/env node
/**
 * port-session-mcp — a local stdio MCP server that hands your in-flight laptop
 * coding session off to Ember, so you can close the laptop and pick the
 * exact same session back up from your phone on the train.
 *
 * One tool: `port_session_to_cloud`. When called it:
 *   1. reads git state in your project (cwd)
 *   2. commits + pushes the in-flight work to a branch (Ember can only see
 *      the remote)
 *   3. extracts a compact context from the local Claude Code transcript
 *   4. POSTs it to the Ember `/api/ember/sessions/port` endpoint
 *   5. returns a deep link — open it on any device and the cloud agent clones,
 *      checks out the branch, and resumes from your context.
 *
 * Config via env (set in the MCP server registration):
 *   EMBER_URL  — base URL of the deployed app (required)
 *   PROJECT_CWD     — project dir; defaults to process.cwd()
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readState, prepareGitHandoff, pullBranch } from "./git.js";
import {
  locateNewestSession,
  readTranscriptBytes,
  installLocalTranscript,
  resumeCommand,
  type Cli,
} from "./cli-adapter.js";
import { gatherBundle } from "./config.js";
import { gatherLoginBody } from "./login.js";
import { detectArtifacts, uploadArtifact, stageArtifactLocally, downloadArtifact, ensureEmberExcluded, fmtBytes } from "./artifacts.js";
import { emberFetch } from "./auth.js";
import { runCognitoLogin } from "./cognito-login.js";

const EMBER_URL = (process.env.EMBER_URL || "").replace(/\/$/, "");

/** Coerce an untrusted cli value to a supported Cli, defaulting to claude. */
function coerceCli(v: unknown): Cli {
  return v === "codex" || v === "kiro" ? v : "claude";
}

const InputSchema = z.object({
  title: z
    .string()
    .optional()
    .describe("Short name for the session — used as the sidebar title and as a one-line hint to the cloud agent about what you're working on."),
  branch: z
    .string()
    .optional()
    .describe("Branch to push the in-flight work to. Defaults to the current branch."),
  firstPrompt: z
    .string()
    .optional()
    .describe("Optional first instruction for the cloud agent on resume, e.g. 'focus on the scroll bug first'."),
  cli: z.enum(["claude", "codex", "kiro"]).optional().describe("Which cloud CLI to resume with. Default: claude."),
  view: z
    .enum(["chat", "terminal"])
    .optional()
    .describe("Which surface the deep link opens. Default chat (mobile-friendly). 'terminal' auto-runs the CLI's resume in a live shell (claude + kiro; codex always opens chat)."),
  commitMessage: z.string().optional().describe("Commit message for the in-flight snapshot."),
  cwd: z.string().optional().describe("Project directory. Defaults to the server's cwd."),
  repoDir: z
    .string()
    .optional()
    .describe("Git repo dir, if it differs from where the transcript lives (e.g. Claude Code launched from a parent dir, code is in a subdir). Git ops run here; the transcript is still read from cwd."),
  preferBundle: z
    .boolean()
    .optional()
    .describe("Force bundle mode (ship a git bundle for the cloud to apply onto a clone of origin) even when origin is writable. Useful when you don't want to push a wip branch to a shared/upstream repo."),
  artifacts: z
    .enum(["y", "n", "auto"])
    .optional()
    .describe("Touched-but-untracked files this session produced/used (generated images, exports, datasets, media). omitted/'auto'/'y' = detect + ship them to the cloud's .ember/artifacts/; 'n' = skip. The filter is precise (only files the conversation touched that aren't git-tracked), so 'auto' ships deliverables without shipping junk."),
});

const server = new Server(
  { name: "port-session-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

const TOOL = {
  name: "port_session_to_cloud",
  description:
    "Hand off the current in-flight coding session to Ember so it can be " +
    "resumed from any device. Commits and pushes your work to a branch, packages " +
    "this conversation's context, and starts a cloud session that picks up where " +
    "you left off. Returns a link to open on your phone. Use when you want to " +
    "stop working locally (e.g. 'port this to the cloud, I'm catching the train').",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short session name — sidebar title + one-line hint to the agent." },
      branch: { type: "string", description: "Branch to push to. Defaults to the current branch." },
      firstPrompt: { type: "string", description: "First instruction for the resumed cloud agent (optional)." },
      view: { type: "string", enum: ["chat", "terminal"], description: "Deep-link surface. Default chat; 'terminal' auto-runs claude --resume in a shell." },
      cli: { type: "string", enum: ["claude", "codex", "kiro"], description: "Cloud CLI to resume with. Default claude." },
      commitMessage: { type: "string", description: "Commit message for the in-flight snapshot." },
      cwd: { type: "string", description: "Project directory. Defaults to the server cwd." },
      artifacts: { type: "string", enum: ["y", "n", "auto"], description: "Ship session-touched untracked files (images/exports/data/media) to the cloud. auto/y=detect+ship, n=skip. Default auto." },
    },
  },
};

const PULL_TOOL = {
  name: "pull_session_from_cloud",
  description:
    "Bring a Ember session back to this laptop (the round trip). Asks the " +
    "cloud to checkpoint the session's transcript, pulls the cloud's branch + " +
    "the grown transcript down, and places it so the CLI's native resume " +
    "(`claude --resume <id>`, `codex resume <id>`, or `kiro-cli chat --resume-id <id>`) " +
    "continues locally right where the cloud left off. Works for Claude Code, " +
    "Codex, and Kiro sessions. " +
    "Use when you're back at your desk after working from your phone. Provide " +
    "the session id (from the deep link) or the Ember session URL.",
  inputSchema: {
    type: "object",
    properties: {
      session: { type: "string", description: "Ember session id (cc-...) or the full session URL." },
      cwd: { type: "string", description: "Project directory to resume into. Defaults to the server cwd." },
    },
    required: ["session"],
  },
};

const SYNC_TOOL = {
  name: "sync_cli_config",
  description:
    "One-time setup: mirror this laptop's coding-CLI configuration to Ember " +
    "so cloud sessions are a clone of your local setup (CLAUDE.md / AGENTS.md, " +
    "skills, custom agents, MCP servers). Run once per CLI — `cli:\"claude\"` " +
    "uploads your Claude Code config, `cli:\"codex\"` your Codex config, " +
    "`cli:\"kiro\"` your Kiro config. Not part of porting — config is reused by every future session. " +
    "Local-only MCP servers (absolute-path commands) are dropped (they can't run " +
    "in the cloud) and secret env values are redacted before upload.",
  inputSchema: {
    type: "object",
    properties: {
      cli: { type: "string", enum: ["claude", "codex", "kiro"], description: "Which CLI's config to sync. Required — one at a time." },
    },
    required: ["cli"],
  },
};

const LOGIN_TOOL = {
  name: "login_cli",
  description:
    "Connect this laptop's coding-CLI SUBSCRIPTION to Ember so cloud " +
    "sessions can run on your OWN plan (Claude Pro/Max, or your ChatGPT plan for " +
    "Codex) instead of AWS Bedrock. Reads the local login credential and uploads " +
    "it: `cli:\"claude\"` grabs your Claude OAuth token (from the keychain / " +
    "credentials file, or pass `token` from `claude setup-token`); `cli:\"codex\"` " +
    "ships ~/.codex/auth.json (run `codex login` first). After connecting, pick " +
    "\"My plan\" when starting a session. Run once per CLI.",
  inputSchema: {
    type: "object",
    properties: {
      cli: { type: "string", enum: ["claude", "codex", "kiro"], description: "Which CLI's subscription to connect. Required." },
      token: { type: "string", description: "Claude only (optional): a token from `claude setup-token` to use instead of the local keychain login." },
    },
    required: ["cli"],
  },
};

const AUTH_TOOL = {
  name: "authenticate",
  description:
    "Sign in to Ember (Cognito) so this MCP can call an auth-enabled deployment. " +
    "Opens your browser to the Ember Hosted-UI login, captures the result on a " +
    "localhost loopback, and saves the tokens to ~/.ember/credentials.json. After " +
    "this, port/pull/sync/login all carry your identity automatically and the " +
    "token auto-refreshes — you sign in ONCE, not hourly. Run this if those tools " +
    "return 401, or once after the admin turns on auth. No-op note: a personal " +
    "deploy (EMBER_AUTH_DISABLED=1) needs no login.",
  inputSchema: { type: "object", properties: {} },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL, PULL_TOOL, SYNC_TOOL, LOGIN_TOOL, AUTH_TOOL] }));

// Slash-command surface: a `port` prompt shows up as
// /mcp__port-session__port. Selecting it tells Claude to call the tool now.
const PORT_PROMPT = {
  name: "port",
  description: "Port this coding session to Ember (commit + push, then resume in the cloud).",
  // One free-text arg so spaces don't split across placeholders. Comma-separated:
  //   view (chat|terminal), title, first prompt, new branch — all optional.
  arguments: [
    {
      name: "view, title, first prompt, new branch",
      description: "Comma-separated, all optional. view=chat|terminal (default chat). e.g. \"terminal, fix scroll, start on the terminal bug, wip/train\"",
      required: false,
    },
  ],
};

const PULL_PROMPT = {
  name: "pull",
  description: "Pull a Ember session back to this laptop (round trip) and resume locally.",
  arguments: [
    { name: "session id or URL", description: "The cc-... id or the Ember session link.", required: true },
  ],
};

const SYNC_PROMPT = {
  name: "sync-config",
  description: "Mirror this laptop's CLI config (skills, agents, MCP) to Ember. One CLI at a time.",
  arguments: [{ name: "cli", description: "claude or codex (required).", required: true }],
};

const LOGIN_PROMPT = {
  name: "login",
  description: "Connect your Claude/ChatGPT subscription to Ember so sessions run on your own plan.",
  arguments: [{ name: "cli", description: "claude or codex (required).", required: true }],
};

const AUTH_PROMPT = {
  name: "auth",
  description: "Sign in to Ember (Cognito Hosted UI) so this MCP can call an auth-enabled deployment.",
  arguments: [],
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [PORT_PROMPT, PULL_PROMPT, SYNC_PROMPT, LOGIN_PROMPT, AUTH_PROMPT] }));

// Slash-command prompt texts reach the agent wrapped in the harness's
// local-command-caveat ("DO NOT respond … unless explicitly asked"), which made
// the agent skip the tool call. Lead every prompt with an explicit-request
// override so the injected instruction is treated as a live command, not context.
const DIRECT =
  "This is an explicit, direct request from me, the user — act on it now, do not " +
  "treat it as background context or a message to ignore. ";

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "auth") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              DIRECT +
              "Sign me in to Ember by calling the authenticate tool now. A browser " +
              "window will open for the Cognito login; after it returns, confirm I'm " +
              "signed in and that port/pull/sync will now carry my identity.",
          },
        },
      ],
    };
  }
  if (req.params.name === "login") {
    const cli = (Object.values((req.params.arguments ?? {}) as Record<string, string>)[0] || "claude").trim();
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              DIRECT +
              `Connect my ${cli} subscription to Ember by calling the login_cli ` +
              `tool now with cli="${cli}". After it returns, confirm it's connected and ` +
              `remind me to pick "My plan" when starting a session.`,
          },
        },
      ],
    };
  }
  if (req.params.name === "sync-config") {
    const cli = (Object.values((req.params.arguments ?? {}) as Record<string, string>)[0] || "claude").trim();
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              DIRECT +
              `Sync my local ${cli} CLI configuration to Ember by calling the ` +
              `sync_cli_config tool now with cli="${cli}". After it returns, show me ` +
              `what was uploaded and anything that was dropped or redacted.`,
          },
        },
      ],
    };
  }
  if (req.params.name === "pull") {
    const v = Object.values((req.params.arguments ?? {}) as Record<string, string>)[0] || "";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              DIRECT +
              `Pull my Ember session "${v}" back to this laptop by calling the ` +
              `pull_session_from_cloud tool now. After it returns, show me the ` +
              `resume command (\`claude --resume\` / \`codex resume\`) to continue locally.`,
          },
        },
      ],
    };
  }
  const a = (req.params.arguments ?? {}) as Record<string, string>;
  // The single arg's name is a human label; read it positionally regardless.
  const raw = Object.values(a)[0] || "";
  const [view, title, firstPrompt, branch] = raw.split(",").map((s) => s.trim());
  const extras: string[] = [];
  if (view === "terminal" || view === "chat") extras.push(`Open in the ${view} view.`);
  if (title) extras.push(`Use session title: "${title}".`);
  if (firstPrompt) extras.push(`First instruction for the cloud agent on resume: "${firstPrompt}".`);
  if (branch) extras.push(`Push to branch: "${branch}".`);
  const text =
    DIRECT +
    "Port my current coding session to Ember by calling the " +
    "port_session_to_cloud tool now. " +
    (extras.length ? extras.join(" ") + " " : "") +
    "After it returns, display its entire text output to me verbatim — the resume " +
    "command, the open-on-any-device link, and the pull-home command — exactly as " +
    "returned, without summarizing, shortening, or omitting any line.";
  return {
    messages: [{ role: "user", content: { type: "text", text } }],
  };
});

const PullSchema = z.object({
  session: z.string(),
  cwd: z.string().optional(),
});

async function runPull(rawArgs: unknown) {
  if (!EMBER_URL) throw new Error("EMBER_URL is not set in the MCP server environment.");
  const args = PullSchema.parse(rawArgs ?? {});
  const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();
  // Accept a raw id or a full deep link.
  const m = args.session.match(/cc-[a-f0-9]+/i);
  const sid = m ? m[0] : args.session.trim();

  // 1. checkpoint: cloud uploads the grown transcript + returns a presigned GET.
  const res = await emberFetch(EMBER_URL, `/api/ember/sessions/${sid}/checkpoint`, {
    method: "POST",
  }, 110_000);
  const data = (await res.json().catch(() => ({}))) as {
    transcriptUrl?: string;
    // resumeId is the CLI-native id; claudeSessionId kept as a back-compat alias.
    resumeId?: string;
    claudeSessionId?: string;
    cli?: Cli;
    branch?: string;
    repo?: string;
    bytes?: number;
    artifacts?: { rel: string; url: string; bytes: number }[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `checkpoint returned ${res.status}`);
  const resumeId = data.resumeId || data.claudeSessionId;
  if (!data.transcriptUrl || !resumeId) {
    throw new Error("checkpoint did not return a transcript URL / session id");
  }
  const cli: Cli = coerceCli(data.cli);

  // 2. download the transcript bytes.
  const dl = await fetch(data.transcriptUrl, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) throw new Error(`transcript download failed: ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());

  // 3. write it where the CLI's resume will find it. The cloud copy is the
  //    canonical latest (same session, grown) so we overwrite; a differing local
  //    copy is backed up to .bak-<stamp> first.
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const placed = await installLocalTranscript(cli, cwd, resumeId, bytes, { stamp });

  // 4. pull the cloud's branch home so local code matches the transcript.
  //    Exclude .ember/ first: a prior port staged artifacts there, and pullBranch
  //    refuses a non-empty `git status --porcelain` — without this the staged
  //    copies would block the very checkout that brings the cloud code home.
  await ensureEmberExcluded(cwd);
  let gitNote = "no branch reported";
  if (data.branch) {
    try {
      gitNote = await pullBranch(cwd, data.branch);
    } catch (e) {
      gitNote = `branch pull failed: ${(e as Error).message}`;
    }
  }

  // 5. bring home the cloud session's artifacts (touched-untracked deliverables
  //    it produced — media, exports, data). Streamed into local .ember/artifacts/.
  //    Per-file failure is non-fatal + named; the pull already succeeded.
  const pulledArtifacts: string[] = [];
  const failedArtifacts: { rel: string; error: string }[] = [];
  let artifactBytes = 0;
  if (data.artifacts?.length) {
    await Promise.all(
      data.artifacts.map(async (a) => {
        try {
          await downloadArtifact(cwd, a.rel, a.url);
          pulledArtifacts.push(a.rel);
          artifactBytes += a.bytes || 0;
        } catch (e) {
          failedArtifacts.push({ rel: a.rel, error: (e as Error).message });
        }
      })
    );
  }

  const sizeMb = (bytes.length / 1_048_576).toFixed(1);
  const artifactLine =
    pulledArtifacts.length > 0
      ? `Artifacts: ${pulledArtifacts.length} file${pulledArtifacts.length === 1 ? "" : "s"} ` +
        `(${fmtBytes(artifactBytes)}) → .ember/artifacts/ — ${pulledArtifacts.slice(0, 8).join(", ")}`
      : "";
  const artifactFailLine =
    failedArtifacts.length > 0
      ? `⚠️ ${failedArtifacts.length} artifact(s) failed: ${failedArtifacts.map((f) => f.rel).join(", ")}`
      : "";
  const summary = [
    `✅ Pulled session home.`,
    ``,
    data.repo ? `Repo: ${data.repo}` : "",
    data.branch ? `Branch: ${gitNote}` : "",
    `Transcript: ${sizeMb} MB → ${placed.path}${placed.overwrote ? " (overwrote local)" : ""}`,
    placed.backup ? `Prior local copy backed up → ${placed.backup}` : "",
    artifactLine,
    artifactFailLine,
    ``,
    `Now exit this session and resume the pulled one:`,
    `  /exit`,
    `  ${resumeCommand(cli, resumeId)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { content: [{ type: "text", text: summary }] };
}

const SyncSchema = z.object({ cli: z.enum(["claude", "codex", "kiro"]) });

async function runSync(rawArgs: unknown) {
  if (!EMBER_URL) throw new Error("EMBER_URL is not set in the MCP server environment.");
  const { cli } = SyncSchema.parse(rawArgs ?? {});

  // 1. gather this CLI's local config into a bundle zip (claude/... or codex/...).
  const g = await gatherBundle(cli as Cli);
  if (g.files.length === 0) {
    throw new Error(`No local ${cli} config found to sync (looked under ~/.${cli}).`);
  }

  // 2. upload to /config with scope=<cli> so the server MERGES this CLI's subtree
  //    into the current bundle — syncing one CLI never wipes the other.
  const form = new FormData();
  form.set("bundle", new Blob([new Uint8Array(g.zip)], { type: "application/zip" }), `${cli}-config.zip`);
  form.set("label", `${cli} config sync`);
  form.set("scope", cli);
  const res = await emberFetch(EMBER_URL, `/api/ember/config`, {
    method: "POST",
    body: form,
  }, 60_000);
  const data = (await res.json().catch(() => ({}))) as {
    version?: { version?: string; fileCount?: number };
    currentVersion?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `config upload returned ${res.status}`);

  const sizeKb = (g.zip.length / 1024).toFixed(0);

  // MCP servers split into three buckets so the engineer knows exactly what will
  // and won't run in the cloud, and how to fix the ones that won't.
  const works = g.classified.filter((c) => c.category === "works");
  const needsSecret = g.classified.filter((c) => c.category === "needs-secret");
  const unsupported = g.classified.filter((c) => c.category === "unsupported");

  const lines: string[] = [
    `✅ Synced ${cli} config to Ember.`,
    ``,
    `Uploaded ${g.files.length} files (${sizeKb} KB) — now the active config bundle.`,
    `Included: ${g.files.map((f) => f.replace(`${cli}/`, "")).join(", ")}`,
  ];

  if (g.classified.length) {
    lines.push(``, `MCP servers:`);
    if (works.length)
      lines.push(`  ✅ Works (${works.length}): ${works.map((c) => `${c.name} [${c.transport}]`).join(", ")}`);
    if (needsSecret.length) {
      lines.push(`  🔑 Needs a secret (${needsSecret.length}) — ships but inactive until you set the token in Ember:`);
      for (const c of needsSecret) lines.push(`     • ${c.name}: ${(c.redactedEnv || []).join(", ")}`);
    }
    if (unsupported.length) {
      lines.push(`  🚫 Won't run in the cloud (${unsupported.length}) — dropped:`);
      for (const c of unsupported) lines.push(`     • ${c.name}: ${c.reason || c.transport}`);
    }
  }

  if (g.pruned.count) {
    const prunedMb = (g.pruned.bytes / 1024 / 1024).toFixed(0);
    lines.push(
      ``,
      `Pruned ${g.pruned.count} rebuildable files (${prunedMb} MB) — venvs, node_modules, ` +
        `build/render output. These are recreated cloud-side from declared deps; ` +
        `the skill itself (SKILL.md + scripts + referenced assets) ships.`
    );
  }
  if (g.skipped.length) lines.push(``, `Not present locally (skipped): ${g.skipped.join(", ")}`);
  lines.push(
    ``,
    cli === "codex"
      ? `Note: codex/config.toml shipped verbatim — check it for any inline secrets.`
      : cli === "kiro"
      ? `Note: kiro config (agents/prompts) shipped — check it for any inline secrets.`
      : `Run \`/mcp__ember__sync-config codex\` too if you use Codex in the cloud.`
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const LoginSchema = z.object({ cli: z.enum(["claude", "codex", "kiro"]), token: z.string().optional() });

async function runLogin(rawArgs: unknown) {
  if (!EMBER_URL) throw new Error("EMBER_URL is not set in the MCP server environment.");
  const { cli, token } = LoginSchema.parse(rawArgs ?? {});

  // Read the local subscription credential (or use an explicit setup-token).
  const body = await gatherLoginBody(cli, token);

  const res = await emberFetch(EMBER_URL, `/api/ember/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 30_000);
  const data = (await res.json().catch(() => ({}))) as { meta?: { label?: string }; error?: string };
  if (!res.ok) throw new Error(data.error || `auth endpoint returned ${res.status}`);

  const label = (body.label as string) || cli;
  const cliName = cli === "claude" ? "Claude" : cli === "kiro" ? "Kiro" : "Codex";
  const planNote =
    cli === "claude"
      ? `Cloud Claude turns can now run on your plan (CLAUDE_CODE_OAUTH_TOKEN) instead of Bedrock.`
      : cli === "kiro"
      ? `Cloud Kiro turns run on your access key (KIRO_API_KEY) — Kiro has no Bedrock fallback, so this is required.`
      : `Cloud Codex turns can now run on your ChatGPT plan (~/.codex/auth.json) instead of Bedrock Mantle.`;
  const lines = [
    `✅ Connected your ${cliName} ${cli === "kiro" ? "access key" : "subscription"} to Ember.`,
    ``,
    `Plan: ${label}`,
    planNote,
    ``,
    cli === "kiro"
      ? `Kiro sessions always run on your key (there's no shared-billing mode).`
      : `When you start a session, pick "My plan" (or set authMode:"subscription"). Bedrock stays the default.`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function runAuth() {
  if (!EMBER_URL) throw new Error("EMBER_URL is not set in the MCP server environment.");
  const { email } = await runCognitoLogin(EMBER_URL);
  const lines = [
    `✅ Signed in to Ember${email ? ` as ${email}` : ""}.`,
    ``,
    `Saved to ~/.ember/credentials.json (id-token + refresh token, 0600).`,
    `port / pull / sync / login now carry your identity automatically, and the`,
    `token auto-refreshes — you won't need to sign in again until the session`,
    `fully expires.`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === AUTH_TOOL.name) {
    try {
      return await runAuth();
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Sign-in failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name === LOGIN_TOOL.name) {
    try {
      return await runLogin(req.params.arguments);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Login failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name === SYNC_TOOL.name) {
    try {
      return await runSync(req.params.arguments);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Sync failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name === PULL_TOOL.name) {
    try {
      return await runPull(req.params.arguments);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Pull failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name !== TOOL.name) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    if (!EMBER_URL) {
      throw new Error("EMBER_URL is not set in the MCP server environment.");
    }
    const args = InputSchema.parse(req.params.arguments ?? {});
    const cli: Cli = coerceCli(args.cli);
    // Transcript is read from cwd (where the CLI runs); git ops run in repoDir if
    // given (handles the launched-from-parent / code-in-subdir split).
    const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();
    const repoDir = args.repoDir || cwd;

    // 1. locate the live session FIRST — it's the only hard requirement. Its
    //    native id (claude filename / codex thread uuid) is what we resume in
    //    the cloud; the raw transcript ships verbatim.
    const located = await locateNewestSession(cli, cwd);
    if (!located) {
      const where =
        cli === "codex"
          ? "Run this from a directory where you've used Codex (~/.codex/sessions has no rollout yet)."
          : cli === "kiro"
          ? "Run this from a directory where you've used kiro-cli (no conversation row for this cwd yet)."
          : `Run this from inside a Claude Code session (or pass cwd=<the dir it was launched in>).`;
      throw new Error(`No ${cli} session transcript found for ${cwd}. ${where}`);
    }
    const claudeSessionId = located.sessionId; // CLI-native resume id (field name kept for the API)
    const transcript = await readTranscriptBytes(located.file); // raw bytes → native resume

    // 1b. artifact detection. The files this session touched that exist locally
    //     and aren't git-tracked are exactly the deliverables the code bundle
    //     misses. 'n' skips; 'auto'/'y' detect and (below) ship them.
    const artifactMode = args.artifacts ?? "auto";
    const detected =
      artifactMode === "n"
        ? null
        : await detectArtifacts({ cwd, repoDir, transcript }).catch(() => null);

    // 2. git handoff — best-effort, flexible. The transcript ships regardless;
    //    git just determines whether (and how) the cloud also gets your code.
    const state = await readState(repoDir);
    let bundleBytes: Buffer | null = null;
    const handoff = await prepareGitHandoff(repoDir, state, {
      branch: args.branch,
      message: args.commitMessage,
      preferBundle: args.preferBundle,
      writeArtifacts: async ({ bundle }) => { bundleBytes = bundle; },
      writeSelfContained: async (bundle) => { bundleBytes = bundle; },
    });

    // 3. create the cloud session + presigned upload URLs (transcript always;
    //    bundle only when we produced one).
    const res = await emberFetch(EMBER_URL, `/api/ember/sessions/port`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: handoff.mode === "none" ? undefined : state.remoteRepo,
        cloneUrl: handoff.mode === "none" ? undefined : (handoff as any).cloneUrl,
        gitMode: handoff.mode, // pushed | bundle | selfContained | none
        branch: handoff.mode === "none" ? undefined : (handoff as any).branch,
        baseRef: handoff.mode === "bundle" ? (handoff as any).baseRef : undefined,
        wantBundleUpload: Boolean(bundleBytes),
        claudeSessionId,
        firstPrompt: args.firstPrompt,
        cli,
        view: args.view || "chat",
        title: args.title,
        // Artifact manifest → the route presigns a PUT per file. rel is the
        // on-the-wire identity (validated server-side against path traversal).
        artifacts: detected
          ? detected.candidates.map((c) => ({ rel: c.rel, bytes: c.bytes }))
          : undefined,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      uploadUrl?: string;
      bundleUploadUrl?: string;
      artifactUploads?: { rel: string; url: string }[];
      error?: string;
      session?: { sessionId?: string };
    };
    if (!res.ok) throw new Error(data.error || `port endpoint returned ${res.status}`);
    if (!data.uploadUrl) throw new Error("port endpoint did not return an upload URL");

    // 4. upload the raw transcript straight to S3 (presigned PUT — no big body
    //    through the app, no DynamoDB size cap).
    const up = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" },
      body: new Uint8Array(transcript),
    });
    if (!up.ok) throw new Error(`transcript upload failed: ${up.status} ${up.statusText}`);

    // 4b. upload the git bundle if we have one (bundle mode).
    if (bundleBytes && data.bundleUploadUrl) {
      const ub = await fetch(data.bundleUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bundleBytes,
      });
      if (!ub.ok) throw new Error(`bundle upload failed: ${ub.status} ${ub.statusText}`);
    }

    // 4c. stream each detected artifact to its presigned PUT. Per-file failure is
    //     NON-fatal — the port already succeeded (code + transcript shipped); we
    //     count + NAME failures so the summary never reads a silent "0/N". Files
    //     also copy into local .ember/artifacts so the pull round trip is symmetric.
    const uploadedArtifacts: string[] = [];
    const failedArtifacts: { rel: string; error: string }[] = [];
    if (detected && data.artifactUploads?.length) {
      // Exclude .ember/ locally BEFORE staging so the staged copies can't leave
      // the tree dirty (which would block pull's checkout of the cloud code).
      await ensureEmberExcluded(repoDir);
      const byRel = new Map(detected.candidates.map((c) => [c.rel, c]));
      await Promise.all(
        data.artifactUploads.map(async (u) => {
          const cand = byRel.get(u.rel);
          if (!cand) return;
          try {
            await uploadArtifact(u.url, cand.abs, cand.bytes);
            uploadedArtifacts.push(u.rel);
            await stageArtifactLocally(cwd, u.rel, cand.abs).catch(() => {});
          } catch (e) {
            failedArtifacts.push({ rel: u.rel, error: (e as Error).message });
          }
        })
      );
    }

    // 6. pre-warm the microVM now (clone + checkout + install transcript) so the
    //    session is hot the instant the user opens the link. Best-effort: we wait
    //    briefly but don't fail the port if warming is slow or errors.
    const sid = data.session?.sessionId;
    let warmed = false;
    if (sid) {
      try {
        const w = await emberFetch(EMBER_URL, `/api/ember/sessions/${sid}/warm`, {
          method: "POST",
        }, 60_000);
        warmed = w.ok && Boolean((await w.json().catch(() => ({}))).warmed);
      } catch {
        /* warming is an optimization; the first turn clones on demand */
      }
    }

    // Deep link — built from EMBER_URL (the server's DEPLOYMENT_URL may be unset).
    const viewQ = args.view === "terminal" ? "&view=terminal" : "";
    const link =
      sid ? `${EMBER_URL}/ember?session=${sid}${viewQ}` : data.url || "(no url returned)";

    const sizeMb = (transcript.length / 1_048_576).toFixed(1);

    // Mode-aware "what shipped / why / how" so a read-only or no-repo handoff is
    // never silently degraded — the user knows exactly what the cloud has.
    const codeLines: string[] = [];
    if (handoff.mode === "pushed") {
      codeLines.push(
        `Code: branch \`${(handoff as any).branch}\`${(handoff as any).committed ? " (in-flight work committed +" : " ("}pushed to origin).`,
        warmed
          ? `Workspace: pre-warmed (repo cloned + branch checked out) — open and it's instant.`
          : `Workspace: warms on first open (clone happens then).`
      );
    } else if (handoff.mode === "bundle") {
      codeLines.push(
        `Code: origin is read-only, so your commits shipped as a git BUNDLE.`,
        `      The cloud clones ${state.remoteRepo} and applies the bundle on top —`,
        `      your in-flight work is there without pushing to a repo you don't own.`
      );
    } else if (handoff.mode === "selfContained") {
      // The no-remote / not-a-repo path: whole repo shipped to Ember's own
      // workspace (S3 → EFS). No GitHub, nothing left your account.
      codeLines.push(
        (handoff as any).initialized
          ? `Code: no git repo here, so Ember initialized one and shipped the whole`
          : `Code: no remote set up, so your whole repo shipped to Ember's workspace`,
        (handoff as any).initialized
          ? `      workspace to its own cloud workspace (a self-contained git bundle).`
          : `      as a self-contained git bundle (history + all branches).`,
        `      It lives in your AWS account only — no GitHub, nothing pushed.`,
        warmed
          ? `Workspace: pre-warmed (repo rebuilt + ready) — open and it's instant.`
          : `Workspace: rebuilds on first open.`,
        ``,
        `      Want to push this somewhere later? From the cloud session (or back`,
        `      here) just \`git remote add origin <url> && git push -u origin ${(handoff as any).branch}\`.`
      );
    } else {
      // none
      codeLines.push(
        `Code: NOT shipped (${(handoff as any).reason}).`,
        `      The cloud agent resumes the conversation but starts from an empty`,
        `      workspace. To bring code too: run port from inside a folder with`,
        `      files, or pass repoDir=<path> if your code lives in a subdir of`,
        `      where Claude Code launched.`
      );
    }

    // Artifacts line — what shipped, what failed (named), what the caps skipped.
    // Never a silent "0/N": every excluded file is accounted for so the user
    // knows exactly which deliverables did and didn't make the trip.
    const artifactLines: string[] = [];
    if (detected && (detected.count > 0 || detected.overCap.length > 0 || detected.dropped.length > 0)) {
      if (detected.count > 0) {
        const okBytes = detected.candidates
          .filter((c) => uploadedArtifacts.includes(c.rel))
          .reduce((n, c) => n + c.bytes, 0);
        const names = uploadedArtifacts.slice(0, 8);
        const more = uploadedArtifacts.length - names.length;
        artifactLines.push(
          ``,
          `Artifacts: ${uploadedArtifacts.length}/${detected.count} shipped (${fmtBytes(okBytes)}) ` +
            `→ restored in the cloud's .ember/artifacts/.`
        );
        if (names.length) artifactLines.push(`  ${names.join(", ")}${more > 0 ? `, +${more} more` : ""}`);
      }
      if (failedArtifacts.length > 0) {
        artifactLines.push(
          `  ⚠️ ${failedArtifacts.length} failed: ` +
            failedArtifacts.map((f) => `${f.rel} (${f.error})`).join(", ")
        );
      }
      const fileCapMb = Math.round(detected.fileCapBytes / 1024 / 1024);
      if (detected.overCap.length > 0) {
        artifactLines.push(
          `  ${detected.overCap.length} over the ${fileCapMb} MB per-file cap (skipped): ` +
            detected.overCap.map((c) => `${c.rel} (${fmtBytes(c.bytes)})`).join(", ")
        );
      }
      if (detected.dropped.length > 0) {
        artifactLines.push(
          `  ${detected.dropped.length} skipped by the count/total cap: ` +
            detected.dropped.map((c) => c.rel).slice(0, 8).join(", ")
        );
      }
    }

    const summary = [
      `✅ Ported to Ember (native resume).`,
      ``,
      `Transcript: ${sizeMb} MB uploaded — the cloud agent resumes this exact session (${resumeCommand(cli, claudeSessionId)}).`,
      ...codeLines,
      ...artifactLines,
      ``,
      `Open on any device:`,
      link,
      ``,
      `When you're back at this machine, pull the cloud's work home:`,
      `  /mcp__ember__pull ${sid}`,
    ].join("\n");

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Port failed: ${(err as Error).message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("port-session-mcp ready (stdio)");
