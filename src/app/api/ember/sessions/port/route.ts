/**
 * POST /api/ember/sessions/port  → "port my laptop session to the cloud"
 *
 * Called by the local `port-session` MCP server after it has committed+pushed
 * the user's in-flight work to a branch. We create a Ember session and hand
 * back a presigned S3 PUT URL; the MCP uploads the RAW Claude transcript (.jsonl)
 * straight to S3. On open, the runtime downloads that transcript, drops it into
 * the workspace's project slug, and runs `claude --resume <sessionId>` — a native,
 * lossless continuation of the exact laptop conversation (no summary, no re-read).
 *
 * We do NOT run a turn here. The session records the transcript's S3 key + the
 * Claude session id inside it; the first turn (auto-fired on open) carries those
 * so the runtime resumes. Instant + serverless-robust — the user can close the
 * laptop immediately.
 *
 * Git is FLEXIBLE (see the port-session MCP): gitMode is "pushed" (branch on
 * origin), "bundle" (origin read-only → a git bundle the runtime layers on top),
 * "selfContained" (NO usable remote → a `bundle --all` of the whole repo the
 * runtime rebuilds standalone, nothing leaves the account), or "none" (truly
 * empty — conversation resumes in a bare workspace). repo/cloneUrl is only
 * required for pushed/bundle; the transcript ships in every mode.
 *
 * Request:  { gitMode, repo?, cloneUrl?, branch?, baseRef?, wantBundleUpload?,
 *             claudeSessionId, cli?, title?, firstPrompt?, view? }
 * Response: { session, url, uploadUrl, transcriptKey, bundleUploadUrl?, bundleKey? }
 *   - url             = deep link to open on any device
 *   - uploadUrl       = presigned S3 PUT; MCP uploads the .jsonl here
 *   - transcriptKey   = S3 key the runtime will fetch
 *   - bundleUploadUrl = presigned S3 PUT for the git bundle (bundle + selfContained)
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { putSession } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import {
  transcriptKey as buildTranscriptKey,
  bundleKey as buildBundleKey,
  artifactKey as buildArtifactKey,
  artifactPrefix as buildArtifactPrefix,
  safeRelPath,
} from "@/lib/ember/s3keys";
import type { EmberSession, EmberCli, EmberAuthMode } from "@/lib/ember/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const UPLOAD_EXPIRES = 900; // 15 min to push the transcript
// Server-side guard on the artifact manifest: a sane ceiling on how many PUTs we
// presign per port (the MCP already applies its own count/size caps; this is the
// untrusted-input backstop). Over-cap entries are dropped, not errored.
const MAX_ARTIFACTS = 200;

// Best-effort owner/name from any clone URL (for the default session title).
function parseRepoFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : undefined;
}

// First-prompt hint the auto-fired seed turn sends to the resumed agent. Kept
// short — the real context lives in the resumed transcript, not in this prompt.
function buildResumePrompt(opts: { branch?: string; firstPrompt?: string }): string {
  const { branch, firstPrompt } = opts;
  if (firstPrompt) return firstPrompt;
  return (
    "You've been resumed in the cloud from the laptop session" +
    (branch ? ` (branch \`${branch}\`)` : "") +
    ". In one line, confirm where things stand, then continue where we left off."
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!ARTIFACT_BUCKET) {
      return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
    }
    const { userId, tenantId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));
    const gitMode: "pushed" | "bundle" | "selfContained" | "none" =
      body.gitMode === "bundle" ? "bundle"
      : body.gitMode === "selfContained" ? "selfContained"
      : body.gitMode === "none" ? "none"
      : "pushed";
    const repo: string = (body.repo || "").trim();
    const cloneUrl: string | undefined = body.cloneUrl?.trim() || undefined;
    // pushed/bundle need SOMETHING to clone — either owner/name (github) or an
    // explicit cloneUrl (non-github / self-hosted origins where remoteRepo is
    // undefined). selfContained ships a bundle --all instead (no origin); "none"
    // ships the transcript only.
    if ((gitMode === "pushed" || gitMode === "bundle") && !repo && !cloneUrl) {
      return NextResponse.json({ error: "repo or cloneUrl is required for gitMode pushed/bundle" }, { status: 400 });
    }
    const claudeSessionId: string = (body.claudeSessionId || "").trim();
    if (!claudeSessionId) {
      return NextResponse.json({ error: "claudeSessionId is required (the id of the transcript being ported)" }, { status: 400 });
    }

    const cli: EmberCli = body.cli === "codex" || body.cli === "kiro" ? body.cli : "claude";
    const authMode: EmberAuthMode = body.authMode === "subscription" ? "subscription" : "bedrock";
    // Both bundle (commits-on-top) and selfContained (whole-repo --all) upload a
    // bundle; the runtime tells them apart by gitMode.
    const wantBundleUpload: boolean =
      Boolean(body.wantBundleUpload) && (gitMode === "bundle" || gitMode === "selfContained");
    const branch: string | undefined = body.branch?.trim() || undefined;
    const firstPrompt: string | undefined = body.firstPrompt?.trim() || undefined;
    const titleBase = repo || parseRepoFromUrl(cloneUrl) || "session";
    const title: string = (body.title?.trim() || `Ported: ${titleBase}`).slice(0, 120);
    // Surface the session opens in (sidebar tap restores it). All three CLIs write
    // a PTY resume hint (claude --resume / codex resume / kiro-cli chat
    // --resume-id), so a terminal port auto-resumes the conversation for each.
    const defaultView: "chat" | "terminal" =
      body.view === "terminal" ? "terminal" : "chat";

    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Transcript lands in the shared artifact bucket, namespaced per tenant +
    // session (ember/t/<tenantId>/resume/<sessionId>/…).
    const transcriptKey = buildTranscriptKey(tenantId, sessionId, claudeSessionId);
    const bundleKey = wantBundleUpload ? buildBundleKey(tenantId, sessionId) : undefined;

    // Artifact manifest (touched-but-untracked deliverables the MCP detected).
    // Validate every rel path against traversal, dedupe, and cap the count —
    // this is untrusted input that becomes S3 keys. Each survivor gets a
    // presigned PUT the MCP streams the file to.
    const rawArtifacts: Array<{ rel?: unknown }> = Array.isArray(body.artifacts) ? body.artifacts : [];
    const artifactRels: string[] = [];
    const seenRel = new Set<string>();
    for (const a of rawArtifacts) {
      if (artifactRels.length >= MAX_ARTIFACTS) break;
      const safe = safeRelPath(typeof a?.rel === "string" ? a.rel : "");
      if (!safe || seenRel.has(safe)) continue;
      seenRel.add(safe);
      artifactRels.push(safe);
    }
    const hasArtifacts = artifactRels.length > 0;

    const session: EmberSession = {
      sessionId,
      userId,
      tenantId,
      title,
      cli,
      authMode,
      repo: repo || undefined,
      branch,
      gitMode,
      cloneUrl,
      resumeBundleKey: bundleKey,
      // Resume the laptop conversation natively from the uploaded transcript.
      claudeSessionId,
      resumeTranscriptKey: transcriptKey,
      artifactPrefix: hasArtifacts ? buildArtifactPrefix(tenantId, sessionId) : undefined,
      defaultView,
      pendingSeed: buildResumePrompt({ branch, firstPrompt }),
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    await putSession(session);

    const s3 = new S3Client({ region: REGION });
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: transcriptKey,
        ContentType: "application/x-ndjson",
      }),
      { expiresIn: UPLOAD_EXPIRES }
    );
    const bundleUploadUrl = bundleKey
      ? await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: bundleKey,
            ContentType: "application/octet-stream",
          }),
          { expiresIn: UPLOAD_EXPIRES }
        )
      : undefined;

    // A presigned PUT per validated artifact rel. The MCP streams each file here.
    const artifactUploads = await Promise.all(
      artifactRels.map(async (rel) => ({
        rel,
        url: await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: buildArtifactKey(tenantId, sessionId, rel),
            ContentType: "application/octet-stream",
          }),
          { expiresIn: UPLOAD_EXPIRES }
        ),
      }))
    );

    const base = process.env.DEPLOYMENT_URL || request.nextUrl.origin || "";
    const url = `${base.replace(/\/$/, "")}/ember?session=${sessionId}`;

    return NextResponse.json(
      { session, url, uploadUrl, transcriptKey, bundleUploadUrl, bundleKey, artifactUploads },
      { status: 201 }
    );
  } catch (err) {
    console.error("[ember] port error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
