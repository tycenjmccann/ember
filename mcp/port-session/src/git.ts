/**
 * Git helpers for the port handoff.
 *
 * The cloud needs the repo state, but it can reach it three different ways
 * depending on what the laptop can do — so port is FLEXIBLE about git instead of
 * demanding a writable origin:
 *
 *   pushed  — origin is writable: commit + push a branch, cloud clones it.
 *   bundle  — repo exists but origin is read-only (e.g. an aws-samples clone you
 *             don't own): ship a `git bundle` of your in-flight commits + a diff
 *             of uncommitted work; the cloud clones the PUBLIC origin and applies
 *             the bundle on top. No push rights needed.
 *   none    — not a repo (or no origin): ship just the transcript; the cloud
 *             resumes the conversation in a bare workspace, no code.
 *
 * The transcript always ships regardless of git mode — it's just a file.
 * All commands run in the user's project cwd.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** git that returns {ok, stdout} instead of throwing — for probes. */
async function gitTry(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args) };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

export interface GitState {
  isRepo: boolean;
  branch: string;
  remoteRepo?: string; // owner/name parsed from origin
  originUrl?: string; // full origin URL (https/ssh) for the cloud to clone
  dirty: boolean;
}

/** Parse owner/name from a github remote URL (https or ssh). */
export function parseRepo(remoteUrl: string): string | undefined {
  const m = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : undefined;
}

/**
 * Produce a clone URL the CLOUD can use. The runtime only configures HTTPS PAT
 * rewriting, so an `git@host:org/repo.git` SSH origin would fail there — convert
 * it to `https://host/org/repo.git`. Also strip any embedded userinfo
 * (`https://user:token@host/...`) so we never persist/return a credential.
 * Returns undefined if there's nothing usable.
 */
export function normalizeCloneUrl(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined;
  const url = remoteUrl.trim();
  // scp-like SSH: git@host:org/repo(.git)
  const ssh = url.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
  // ssh:// or https:// — drop userinfo (anything before @ in the authority).
  const m = url.match(/^(https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) {
    // An ssh:// URL's port (e.g. :22) is the SSH port — meaningless over HTTPS,
    // so drop it. Keep an explicit port on an https:// origin.
    const host = m[1] === "ssh" ? m[2].replace(/:\d+$/, "") : m[2];
    return `https://${host}/${m[3]}.git`;
  }
  // Unknown shape (e.g. a local path) — return as-is, no credential to strip.
  return url;
}

export async function readState(cwd: string): Promise<GitState> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let remoteRepo: string | undefined;
  let originUrl: string | undefined;
  try {
    const raw = await git(cwd, ["remote", "get-url", "origin"]);
    remoteRepo = parseRepo(raw);
    // Normalize for the cloud: SSH→HTTPS, strip embedded credentials. Push still
    // uses the local `origin` remote (this URL is only what the cloud clones).
    originUrl = normalizeCloneUrl(raw);
  } catch {
    /* no origin */
  }
  const status = await git(cwd, ["status", "--porcelain"]);
  return { isRepo: true, branch, remoteRepo, originUrl, dirty: status.length > 0 };
}

/** Can we push to origin? Probe with a dry-run push (no refs written). */
export async function canPushToOrigin(cwd: string): Promise<boolean> {
  // `--dry-run` performs auth + ref negotiation but writes nothing. A read-only
  // remote (no write grant) fails here; a writable one succeeds.
  const r = await gitTry(cwd, ["push", "--dry-run", "origin", "HEAD"]);
  return r.ok;
}

export type GitHandoff =
  | { mode: "pushed"; branch: string; committed: boolean; cloneUrl?: string }
  | { mode: "bundle"; branch: string; committed: boolean; cloneUrl?: string; baseRef: string }
  | { mode: "none"; reason: string };

/**
 * Prepare the repo for handoff, choosing the best available mode.
 *
 * @param writeBundle  called with the bundle bytes when mode==="bundle" (the
 *                     caller uploads them); receives {bundle, patch} buffers.
 */
export async function prepareGitHandoff(
  cwd: string,
  state: GitState,
  opts: {
    branch?: string;
    message?: string;
    preferBundle?: boolean; // force bundle even if origin is writable
    writeArtifacts?: (a: { bundle: Buffer; patch: Buffer; baseRef: string }) => Promise<void>;
  }
): Promise<GitHandoff> {
  if (!state.isRepo) return { mode: "none", reason: "not a git repository" };

  const target = opts.branch || state.branch;
  let committed = false;

  // Snapshot in-flight work onto the target branch so HEAD captures everything.
  if (opts.branch && opts.branch !== state.branch) {
    await git(cwd, ["checkout", "-B", opts.branch]);
  }
  if (state.dirty) {
    await git(cwd, ["add", "-A"]);
    const msg = opts.message || `wip: port session to cloud (${new Date().toISOString()})`;
    await git(cwd, ["commit", "--no-verify", "-m", msg]);
    committed = true;
  }

  // Mode selection keys off originUrl (what the cloud actually clones), not the
  // parsed github owner/name — a non-github or SSH origin is still clonable.
  // pushed if we can push and aren't forced to bundle; else bundle if there's an
  // origin to clone; else none.
  const writable = !opts.preferBundle && state.originUrl
    ? await canPushToOrigin(cwd)
    : false;

  if (writable) {
    await git(cwd, ["push", "--no-verify", "-u", "origin", target]);
    return { mode: "pushed", branch: target, committed, cloneUrl: state.originUrl };
  }

  // Bundle mode needs an origin the cloud can clone (the public upstream) AND a
  // base commit present there, so the bundle only carries OUR commits on top.
  if (state.originUrl) {
    // base = the merge-base with the remote's default branch (or origin/HEAD).
    // Falls back to the upstream of the current branch, then to the first commit.
    let baseRef = "";
    for (const cand of [
      "origin/HEAD",
      `origin/${target}`,
      "@{upstream}",
    ]) {
      const r = await gitTry(cwd, ["merge-base", "HEAD", cand]);
      if (r.ok && r.out) { baseRef = r.out; break; }
    }
    if (!baseRef) {
      // No shared base with origin → bundle the whole branch history.
      const root = await gitTry(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
      baseRef = root.ok ? root.out.split("\n")[0] : "";
    }

    if (opts.writeArtifacts) {
      // git bundle of base..HEAD (our commits), plus a patch of anything still
      // uncommitted (should be empty after the commit above, but cheap insurance).
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const os = await import("node:os");
      const pathMod = await import("node:path");
      const tmp = await mkdtemp(pathMod.join(os.tmpdir(), "ember-bundle-"));
      const bundlePath = pathMod.join(tmp, "work.bundle");
      try {
        // Are there any commits in base..HEAD? An empty range means HEAD is
        // already on origin (nothing laptop-only to ship) — `git bundle` refuses
        // an empty bundle, so skip the artifact: the cloud's clean clone already
        // has this state. We still report bundle mode (origin is read-only) but
        // with no bundle to apply.
        const ahead = baseRef
          ? (await gitTry(cwd, ["rev-list", "--count", `${baseRef}..HEAD`])).out.trim()
          : "1";
        if (ahead && ahead !== "0") {
          const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
          await git(cwd, ["bundle", "create", bundlePath, range, "HEAD"]);
          const bundle = await readFile(bundlePath);
          const patch = Buffer.from(await git(cwd, ["diff", "HEAD"]), "utf8"); // usually empty
          await opts.writeArtifacts({ bundle, patch, baseRef });
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    return { mode: "bundle", branch: target, committed, cloneUrl: state.originUrl, baseRef };
  }

  return { mode: "none", reason: state.originUrl ? "origin not reachable" : "no origin remote" };
}

/**
 * Pull the cloud's work home: fetch + check out the branch, fast-forward to the
 * cloud's commits. Best-effort and non-destructive — if the local tree is dirty
 * or diverged we report it rather than clobber. Returns a status note.
 */
export async function pullBranch(cwd: string, branch: string): Promise<string> {
  const status = await git(cwd, ["status", "--porcelain"]);
  await git(cwd, ["fetch", "origin", branch]);
  if (status.length > 0) {
    return `local tree is dirty; fetched origin/${branch} but did NOT check out. Stash/commit, then \`git checkout ${branch} && git pull\`.`;
  }
  await git(cwd, ["checkout", branch]);
  try {
    await git(cwd, ["merge", "--ff-only", `origin/${branch}`]);
    return `pulled origin/${branch} (fast-forward).`;
  } catch {
    return `on ${branch}, but it diverged from origin/${branch}; resolve manually (\`git pull\`).`;
  }
}
