/**
 * port-session-mcp — per-CLI session/transcript adapter.
 *
 * Each supported coding CLI persists a session differently on disk; port/pull
 * needs to (a) find the newest session for a cwd, (b) read its raw transcript
 * bytes, (c) place a pulled transcript where the CLI's resume will find it, and
 * (d) print the right resume command. This module isolates those four ops so the
 * port/pull tools stay CLI-agnostic.
 *
 *   claude → ONE jsonl per session at
 *            ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 *            resume: `claude --resume <id>`
 *   codex  → ONE jsonl per session at
 *            ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *            (the uuid in the filename IS the resume id; the first line is a
 *            `session_meta` record carrying it)
 *            resume: `codex exec resume <id>` (headless) / `codex resume <id>`
 *
 * Both store one movable JSONL per session, so port/pull is a file copy + a
 * native resume-by-id for both — only the path layout and the resume verb differ.
 * (Kiro stores sessions in a SQLite DB, not a file, so it needs a different
 * adapter — added separately.)
 */

import { readdir, readFile, stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Cli = "claude" | "codex";

export interface LocatedSession {
  /** Absolute path to the session's transcript file. */
  file: string;
  /** The CLI-native resume id (claude sessionId / codex thread uuid). */
  sessionId: string;
}

export interface InstalledTranscript {
  path: string;
  overwrote: boolean;
  backup?: string;
}

// ── path helpers ──────────────────────────────────────────────────────────────

/** cwd → the on-disk project dir name Claude Code uses. Claude slugifies the REAL
 *  (symlink-resolved) path replacing EVERY non-alphanumeric char with '-'. */
export function slugForPath(realCwd: string): string {
  return realCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function resolveReal(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd; // may not exist yet; caller falls back to the given cwd
  }
}

function claudeProjectsRoot(): string {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
    "projects"
  );
}

async function claudeProjectDir(cwd: string): Promise<string> {
  return path.join(claudeProjectsRoot(), slugForPath(await resolveReal(cwd)));
}

function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
}

/** Newest .jsonl under a dir tree (recursive for codex's YYYY/MM/DD nesting). */
async function newestJsonl(root: string, recursive: boolean): Promise<string | null> {
  const found: Array<{ file: string; m: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!e.name.endsWith(".jsonl")) continue;
      found.push({ file: full, m: (await stat(full)).mtimeMs });
    }
  };
  await walk(root);
  if (found.length === 0) return null;
  found.sort((a, b) => b.m - a.m);
  return found[0].file;
}

// ── codex session-id extraction ─────────────────────────────────────────────
// Filename: rollout-<YYYY-MM-DDThh-mm-ss>-<uuid>.jsonl. The uuid is the resume
// id; pull it from the name, but fall back to the session_meta record so a
// renamed file still resolves.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function codexIdFromFilename(file: string): string | null {
  const m = path.basename(file).match(UUID_RE);
  return m ? m[0] : null;
}

async function codexIdFromMeta(file: string): Promise<string | null> {
  try {
    const head = (await readFile(file, "utf8")).split("\n", 1)[0];
    const rec = JSON.parse(head);
    // session_meta shape: { type:"session_meta", payload:{ id|session_id } } or flat.
    const p = rec?.payload ?? rec;
    const id = p?.session_id || p?.id || rec?.session_id || rec?.id;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/** Find an existing codex rollout file for a specific thread uuid (newest if
 *  several), so a re-pull overwrites in place instead of duplicating the uuid. */
async function findCodexRolloutById(sessionId: string): Promise<string | null> {
  const matches: Array<{ file: string; m: number }> = [];
  const root = codexSessionsRoot();
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".jsonl") && e.name.includes(sessionId)) {
        matches.push({ file: full, m: (await stat(full)).mtimeMs });
      }
    }
  };
  await walk(root);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.m - a.m);
  return matches[0].file;
}

/** Find the newest session for this cwd + CLI. Returns null if none on disk. */
export async function locateNewestSession(cli: Cli, cwd: string): Promise<LocatedSession | null> {
  if (cli === "codex") {
    const file = await newestJsonl(codexSessionsRoot(), true);
    if (!file) return null;
    const sessionId = codexIdFromFilename(file) || (await codexIdFromMeta(file));
    if (!sessionId) return null;
    return { file, sessionId };
  }
  // claude
  const file = await newestJsonl(await claudeProjectDir(cwd), false);
  if (!file) return null;
  return { file, sessionId: sessionIdForClaudeTranscript(file) };
}

/** The claude session id for a transcript = its filename (verified: equals the
 *  `sessionId` field inside the records). */
export function sessionIdForClaudeTranscript(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, "");
}

/** Raw transcript bytes for a located session (shipped verbatim → native resume). */
export async function readTranscriptBytes(file: string): Promise<Buffer> {
  return readFile(file);
}

/** Local path where the CLI's resume expects this session's transcript. */
export async function localTranscriptPath(cli: Cli, cwd: string, sessionId: string): Promise<string> {
  if (cli === "codex") {
    // codex resume scans ~/.codex/sessions for a session by parsing BOTH a
    // timestamp and the uuid out of the filename (rollout-<ts>-<uuid>.jsonl), so
    // the placed file MUST match that shape or the scan skips it. Place it under
    // today's YYYY/MM/DD like codex itself does, with a synthetic timestamp.
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const y = now.getUTCFullYear();
    const mo = p2(now.getUTCMonth() + 1);
    const d = p2(now.getUTCDate());
    const ts = `${y}-${mo}-${d}T${p2(now.getUTCHours())}-${p2(now.getUTCMinutes())}-${p2(now.getUTCSeconds())}`;
    return path.join(codexSessionsRoot(), `${y}`, mo, d, `rollout-${ts}-${sessionId}.jsonl`);
  }
  return path.join(await claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Write a pulled cloud transcript to the local path so the CLI's resume picks it
 * up. The cloud copy IS the canonical latest after a round trip (same session,
 * grown), so overwrite — but back up a divergent local copy to `<path>.bak-<stamp>`
 * first so a locally-continued branch is recoverable.
 */
export async function installLocalTranscript(
  cli: Cli,
  cwd: string,
  sessionId: string,
  data: Buffer | Uint8Array,
  opts: { stamp?: string } = {}
): Promise<InstalledTranscript> {
  // codex: if a rollout for this uuid already exists locally, overwrite IT in
  // place (so repeated pulls don't litter the tree with duplicate uuids); else
  // create a fresh timestamped path. claude: the path is deterministic from the id.
  let dest: string;
  if (cli === "codex") {
    dest = (await findCodexRolloutById(sessionId)) || (await localTranscriptPath("codex", cwd, sessionId));
  } else {
    dest = await localTranscriptPath(cli, cwd, sessionId);
  }
  await mkdir(path.dirname(dest), { recursive: true });

  let overwrote = false;
  let backup: string | undefined;
  try {
    const existing = await readFile(dest);
    overwrote = true;
    if (!Buffer.from(existing).equals(Buffer.from(data))) {
      backup = `${dest}.bak-${opts.stamp || "prev"}`;
      await writeFile(backup, existing);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await writeFile(dest, data);
  return { path: dest, overwrote, backup };
}

/** The command the user runs locally to resume a pulled session. */
export function resumeCommand(cli: Cli, sessionId: string): string {
  return cli === "codex" ? `codex resume ${sessionId}` : `claude --resume ${sessionId}`;
}
