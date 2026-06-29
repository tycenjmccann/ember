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
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readState, prepareGitHandoff, pullBranch } from "./git.js";
import { newestTranscript, sessionIdForTranscript, installLocalTranscript } from "./transcript.js";
import { gatherBundle, type Cli } from "./config.js";
import { gatherLoginBody } from "./login.js";
import { emberFetch } from "./auth.js";
import { runCognitoLogin } from "./cognito-login.js";

const EMBER_URL = (process.env.EMBER_URL || "").replace(/\/$/, "");

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
  cli: z.enum(["claude", "codex"]).optional().describe("Which cloud CLI to resume with. Default: claude."),
  view: z
    .enum(["chat", "terminal"])
    .optional()
    .describe("Which surface the deep link opens. Default chat (mobile-friendly). 'terminal' auto-runs `claude --resume` in a live shell."),
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
      cli: { type: "string", enum: ["claude", "codex"], description: "Cloud CLI to resume with. Default claude." },
      commitMessage: { type: "string", description: "Commit message for the in-flight snapshot." },
      cwd: { type: "string", description: "Project directory. Defaults to the server cwd." },
    },
  },
};

const PULL_TOOL = {
  name: "pull_session_from_cloud",
  description:
    "Bring a Ember session back to this laptop (the round trip). Asks the " +
    "cloud to checkpoint the session's transcript, pulls the cloud's branch + " +
    "the grown transcript down, and places it so `claude --resume <id>` continues " +
    "locally right where the cloud left off. Use when you're back at your desk " +
    "after working from your phone. Provide the session id (from the deep link) " +
    "or the Ember session URL.",
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
    "uploads your Claude Code config, `cli:\"codex\"` your Codex config; run twice " +
    "for both. Not part of porting — config is reused by every future session. " +
    "Local-only MCP servers (absolute-path commands) are dropped (they can't run " +
    "in the cloud) and secret env values are redacted before upload.",
  inputSchema: {
    type: "object",
    properties: {
      cli: { type: "string", enum: ["claude", "codex"], description: "Which CLI's config to sync. Required — one at a time." },
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
      cli: { type: "string", enum: ["claude", "codex"], description: "Which CLI's subscription to connect. Required." },
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

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "auth") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
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
              `Pull my Ember session "${v}" back to this laptop by calling the ` +
              `pull_session_from_cloud tool now. After it returns, show me the ` +
              `\`claude --resume\` command to continue locally.`,
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
    "Port my current coding session to Ember by calling the " +
    "port_session_to_cloud tool now. " +
    (extras.length ? extras.join(" ") + " " : "") +
    "After it returns, show me the deep link so I can open it on my phone.";
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
    signal: AbortSignal.timeout(110_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    transcriptUrl?: string;
    claudeSessionId?: string;
    branch?: string;
    repo?: string;
    bytes?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `checkpoint returned ${res.status}`);
  if (!data.transcriptUrl || !data.claudeSessionId) {
    throw new Error("checkpoint did not return a transcript URL / session id");
  }

  // 2. download the transcript bytes.
  const dl = await fetch(data.transcriptUrl, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) throw new Error(`transcript download failed: ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());

  // 3. write it where `claude --resume` will find it. The cloud copy is the
  //    canonical latest (same session, grown) so we overwrite; a differing local
  //    copy is backed up to .bak-<stamp> first.
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const placed = await installLocalTranscript(cwd, data.claudeSessionId, bytes, { stamp });

  // 4. pull the cloud's branch home so local code matches the transcript.
  let gitNote = "no branch reported";
  if (data.branch) {
    try {
      gitNote = await pullBranch(cwd, data.branch);
    } catch (e) {
      gitNote = `branch pull failed: ${(e as Error).message}`;
    }
  }

  const sizeMb = (bytes.length / 1_048_576).toFixed(1);
  const summary = [
    `✅ Pulled session home.`,
    ``,
    data.repo ? `Repo: ${data.repo}` : "",
    data.branch ? `Branch: ${gitNote}` : "",
    `Transcript: ${sizeMb} MB → ${placed.path}${placed.overwrote ? " (overwrote local)" : ""}`,
    placed.backup ? `Prior local copy backed up → ${placed.backup}` : "",
    ``,
    `Now exit this session and resume the pulled one:`,
    `  /exit`,
    `  claude --resume ${data.claudeSessionId}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { content: [{ type: "text", text: summary }] };
}

const SyncSchema = z.object({ cli: z.enum(["claude", "codex"]) });

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
    signal: AbortSignal.timeout(60_000),
  });
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

  if (g.skipped.length) lines.push(``, `Not present locally (skipped): ${g.skipped.join(", ")}`);
  lines.push(
    ``,
    cli === "codex"
      ? `Note: codex/config.toml shipped verbatim — check it for any inline secrets.`
      : `Run \`/mcp__port-session__sync-config codex\` too if you use Codex in the cloud.`
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const LoginSchema = z.object({ cli: z.enum(["claude", "codex"]), token: z.string().optional() });

async function runLogin(rawArgs: unknown) {
  if (!EMBER_URL) throw new Error("EMBER_URL is not set in the MCP server environment.");
  const { cli, token } = LoginSchema.parse(rawArgs ?? {});

  // Read the local subscription credential (or use an explicit setup-token).
  const body = await gatherLoginBody(cli, token);

  const res = await emberFetch(EMBER_URL, `/api/ember/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { meta?: { label?: string }; error?: string };
  if (!res.ok) throw new Error(data.error || `auth endpoint returned ${res.status}`);

  const label = (body.label as string) || cli;
  const lines = [
    `✅ Connected your ${cli === "claude" ? "Claude" : "Codex"} subscription to Ember.`,
    ``,
    `Plan: ${label}`,
    cli === "claude"
      ? `Cloud Claude turns can now run on your plan (CLAUDE_CODE_OAUTH_TOKEN) instead of Bedrock.`
      : `Emberx turns can now run on your ChatGPT plan (~/.codex/auth.json) instead of Bedrock Mantle.`,
    ``,
    `When you start a session, pick "My plan" (or set authMode:"subscription"). Bedrock stays the default.`,
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
    // Transcript is read from cwd (where Claude Code runs); git ops run in
    // repoDir if given (handles the launched-from-parent / code-in-subdir split).
    const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();
    const repoDir = args.repoDir || cwd;

    // 1. locate the live transcript FIRST — it's the only hard requirement.
    //    Its filename IS the Claude session id we resume natively in the cloud.
    const file = await newestTranscript(cwd);
    if (!file) {
      throw new Error(
        `No Claude Code transcript found for ${cwd}. Run this from inside a Claude Code session ` +
        `(or pass cwd=<the dir Claude Code was launched in>).`
      );
    }
    const claudeSessionId = sessionIdForTranscript(file);
    const transcript = await readFile(file); // raw .jsonl bytes (verbatim → native --resume)

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
        cli: args.cli || "claude",
        view: args.view || "chat",
        title: args.title,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      uploadUrl?: string;
      bundleUploadUrl?: string;
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
      body: transcript,
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

    // 6. pre-warm the microVM now (clone + checkout + install transcript) so the
    //    session is hot the instant the user opens the link. Best-effort: we wait
    //    briefly but don't fail the port if warming is slow or errors.
    const sid = data.session?.sessionId;
    let warmed = false;
    if (sid) {
      try {
        const w = await emberFetch(EMBER_URL, `/api/ember/sessions/${sid}/warm`, {
          method: "POST",
          signal: AbortSignal.timeout(60_000),
        });
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

    const summary = [
      `✅ Ported to Ember (native resume).`,
      ``,
      `Transcript: ${sizeMb} MB uploaded — the cloud agent resumes this exact session (claude --resume).`,
      ...codeLines,
      ``,
      `Open on any device:`,
      link,
      ``,
      `When you're back at this machine, pull the cloud's work home:`,
      `  /mcp__port-session__pull ${sid}`,
    ].join("\n");

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Port failed: ${(err as Error).message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("port-session-mcp ready (stdio)");
