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
 *   kiro   → ONE ROW per session in a SQLite DB (NOT a file):
 *            <kiro-data>/data.sqlite3, table conversations_v2
 *            (key=cwd, conversation_id=uuid, value=conversation JSON).
 *            resume: `kiro-cli chat --resume-id <uuid>`
 *
 * claude/codex store one movable JSONL per session, so port/pull is a file copy +
 * a native resume-by-id. Kiro has no file — its "transcript" is a DB row's `value`
 * JSON. The four ops below stay the same shape; we just ship/install opaque bytes
 * (the row value) and rewrite the row's cwd `key` on install so resume scoped to
 * the active cwd finds it.
 */

import { readdir, readFile, stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";

export type Cli = "claude" | "codex" | "kiro";

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

// ── kiro SQLite store ─────────────────────────────────────────────────────────
// kiro-cli keeps sessions in a single SQLite DB, table conversations_v2
// (key=cwd, conversation_id=uuid, value=conversation JSON). KIRO_HOME relocates
// the data dir; otherwise it's the platform default.
function kiroDbPath(): string {
  if (process.env.KIRO_HOME) return path.join(process.env.KIRO_HOME, "data.sqlite3");
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(xdg, "kiro-cli", "data.sqlite3");
}

// kiro's own DDL, verbatim — used to create the table when we upsert into a DB
// that kiro hasn't initialized yet (e.g. a fresh per-session KIRO_HOME).
const KIRO_DDL = `CREATE TABLE IF NOT EXISTS conversations_v2 (
  key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_updated_at ON conversations_v2(updated_at DESC);`;

/** Newest conversation row for a cwd → {conversation_id, value} or null. */
function kiroNewestRow(cwd: string): { id: string; value: string } | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(kiroDbPath(), { readOnly: true });
  } catch {
    return null; // no DB yet
  }
  try {
    const row = db
      .prepare(
        "SELECT conversation_id AS id, value FROM conversations_v2 WHERE key = ? ORDER BY updated_at DESC LIMIT 1"
      )
      .get(cwd) as { id?: string; value?: string } | undefined;
    if (!row?.id || typeof row.value !== "string") return null;
    return { id: row.id, value: row.value };
  } finally {
    db.close();
  }
}

/** The conversation `value` JSON for a specific kiro session id (newest if the
 *  id somehow appears under multiple cwd keys). */
function kiroValueById(sessionId: string): string | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(kiroDbPath(), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        "SELECT value FROM conversations_v2 WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1"
      )
      .get(sessionId) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } finally {
    db.close();
  }
}

/** Upsert a pulled conversation row into the local kiro DB, rewriting `key` to
 *  the local cwd so `kiro-cli chat --resume-id` (scoped to cwd) finds it. */
function kiroUpsertRow(cwd: string, sessionId: string, value: string): { overwrote: boolean } {
  const dbPath = kiroDbPath();
  const db = new DatabaseSync(dbPath); // creates the file if absent
  try {
    db.exec(KIRO_DDL);
    const existing = db
      .prepare("SELECT 1 FROM conversations_v2 WHERE key = ? AND conversation_id = ?")
      .get(cwd, sessionId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key, conversation_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(cwd, sessionId, value, now, now);
    return { overwrote: Boolean(existing) };
  } finally {
    db.close();
  }
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
  if (cli === "kiro") {
    // No file: the row is keyed by the real cwd. `file` is a synthetic ref
    // (<db>#<id>) for display/logging; the bytes come from the DB, not a read.
    const row = kiroNewestRow(await resolveReal(cwd));
    if (!row) return null;
    return { file: `${kiroDbPath()}#${row.id}`, sessionId: row.id };
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

/** Raw transcript bytes for a located session (shipped verbatim → native resume).
 *  For kiro the "file" is the synthetic `<db>#<conversation_id>` ref produced by
 *  locateNewestSession; the bytes are the row's `value` JSON read from the DB. */
export async function readTranscriptBytes(file: string): Promise<Buffer> {
  const m = file.match(/data\.sqlite3#(.+)$/); // kiro synthetic ref
  if (m) {
    const value = kiroValueById(m[1]);
    if (value == null) throw new Error(`kiro conversation ${m[1]} not found in DB`);
    return Buffer.from(value, "utf8");
  }
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
  // kiro: no file — upsert the conversation row into the local SQLite DB, keyed
  // by the local (real) cwd so `kiro-cli chat --resume-id` finds it here.
  if (cli === "kiro") {
    const value = Buffer.from(data).toString("utf8");
    const { overwrote } = kiroUpsertRow(await resolveReal(cwd), sessionId, value);
    return { path: `${kiroDbPath()}#${sessionId}`, overwrote };
  }
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
  if (cli === "codex") return `codex resume ${sessionId}`;
  if (cli === "kiro") return `kiro-cli chat --resume-id ${sessionId}`;
  return `claude --resume ${sessionId}`;
}
