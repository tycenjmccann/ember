/**
 * Ember — types for the standalone resumable coding agent.
 *
 * A "session" is one conversation with a cloud-hosted coding CLI (Claude Code or
 * Codex) running on the AgentCore coding runtime. It maps 1:1 to a
 * runtimeSessionId (which selects the warm microVM + /mnt/workspace) and carries
 * the claude_session_id used to resume the CLI's own conversation.
 */

export type EmberCli = "claude" | "codex" | "kiro";

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
  userId: string; // Cognito `sub` (the employee). "default" in no-auth deploys.
  // Company boundary (Cognito `custom:tenantId`). "default" in no-auth deploys.
  // Present so the store can filter cross-tenant and Phase 2/3 can scope infra by
  // it without a data migration.
  tenantId?: string;
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
  // How the laptop handed off its code (port-session MCP):
  //   "pushed"        — branch pushed to origin; runtime clones + checks it out.
  //   "bundle"        — origin read-only; runtime clones origin and git-fetches a
  //                     bundle (resumeBundleKey) to layer the laptop's commits on top.
  //   "selfContained" — no usable remote; the laptop shipped a `bundle --all`
  //                     (resumeBundleKey) and the runtime rebuilds a standalone repo
  //                     from it — no clone, no origin, stays in your account.
  //   "none"          — no repo shipped; bare workspace, conversation resumes only.
  gitMode?: "pushed" | "bundle" | "selfContained" | "none";
  // Explicit clone URL (the laptop's origin) — lets the runtime clone an upstream
  // it has no push rights to. Falls back to `repo` (owner/name) when absent.
  cloneUrl?: string;
  // S3 key of a git bundle: the laptop's in-flight commits (gitMode="bundle") or
  // the whole repo as `bundle --all` (gitMode="selfContained").
  resumeBundleKey?: string;
  // Which surface this session opens in (sidebar tap restores it). Set at port
  // time; defaults to chat. A ported terminal session auto-runs the CLI's resume
  // (claude/codex/kiro) in the PTY instead of firing the chat seed.
  defaultView?: "chat" | "terminal";
  // Soft-delete tombstone (ISO timestamp). DELETE sets this and returns at once —
  // the row is hidden from the list immediately, but kept as the retry handle for
  // backend cleanup (stop VM + purge EFS/S3). The row is hard-deleted only once a
  // purge confirms; until then the sweep retries it. This is what makes delete
  // reliable WITHOUT racing multi-step cleanup in the request path.
  deletedAt?: string;
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
