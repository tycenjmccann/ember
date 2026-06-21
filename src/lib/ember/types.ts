/**
 * Ember — types for the standalone resumable coding agent.
 *
 * A "session" is one conversation with a cloud-hosted coding CLI (Claude Code or
 * Codex) running on the AgentCore coding runtime. It maps 1:1 to a
 * runtimeSessionId (which selects the warm microVM + /mnt/workspace) and carries
 * the claude_session_id used to resume the CLI's own conversation.
 */

export type EmberCli = "claude" | "codex";

/**
 * Where the model inference is billed/authenticated:
 *   bedrock      — AWS Bedrock / Mantle (the default; no user login)
 *   subscription — the user's OWN plan (Claude Pro/Max, or ChatGPT for Codex),
 *                  via a credential they uploaded with the login MCP / Account UI
 */
export type EmberAuthMode = "bedrock" | "subscription";

/** Liveness of the underlying microVM, derived from last activity. */
export type SessionWarmth = "warm" | "idle" | "cold";

export interface EmberTurn {
  role: "user" | "agent";
  text: string;
  at: string; // ISO timestamp
}

export interface EmberSession {
  sessionId: string; // runtimeSessionId — the resume handle
  userId: string; // "default" until app-wide SSO lands
  title: string;
  cli: EmberCli;
  // How this session authenticates to the model. Defaults to "bedrock" when
  // absent (every pre-existing row). "subscription" uses the user's own plan.
  authMode?: EmberAuthMode;
  repo?: string; // owner/name or clone URL
  claudeSessionId?: string; // CLI conversation id, for --resume
  createdAt: string;
  updatedAt: string;
  turns: EmberTurn[];
  // Set when a session is created by "port to cloud" (the MCP handoff): the
  // first prompt to auto-run on open. The real context comes from natively
  // resuming the ported transcript (resumeTranscriptKey + claudeSessionId), not
  // from this prompt. Cleared once it has been fired.
  pendingSeed?: string;
  branch?: string; // branch the local session pushed, for display + checkout
  // S3 key of the raw laptop transcript (.jsonl). The runtime downloads it and
  // runs `claude --resume claudeSessionId` for a lossless continuation.
  resumeTranscriptKey?: string;
  // Which surface this session opens in (sidebar tap restores it). Set at port
  // time; defaults to chat. A ported terminal session auto-runs `claude --resume`
  // in the PTY instead of firing the chat seed.
  defaultView?: "chat" | "terminal";
}

/** Trimmed shape for the sidebar list (no full turn history). */
export interface EmberSessionSummary {
  sessionId: string;
  title: string;
  cli: EmberCli;
  authMode?: EmberAuthMode;
  repo?: string;
  defaultView?: "chat" | "terminal";
  createdAt: string;
  updatedAt: string;
  warmth: SessionWarmth;
}
