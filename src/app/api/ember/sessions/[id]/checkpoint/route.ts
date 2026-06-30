/**
 * POST /api/ember/sessions/[id]/checkpoint  → pull a cloud session home
 *
 * The round trip: after working in the cloud (phone/train), this asks the
 * runtime to upload the session's grown transcript back to S3, then returns a
 * presigned GET URL + the cloud branch + the resume id. The local `pull-session`
 * MCP fetches the transcript, drops it where the CLI expects it, pulls the
 * branch, and resumes locally (`claude --resume <id>` / `codex resume <id>` /
 * `kiro-cli chat --resume-id <id>`). Works for Claude Code, Codex, and Kiro
 * (claude/codex: one movable transcript; kiro: a SQLite conversation row).
 *
 * Same session id throughout (the cloud appended to the same file), so the
 * laptop just overwrites its stale copy — no merge, no new session.
 *
 * Response: { transcriptUrl, transcriptKey, cli, resumeId, branch, repo, bytes }
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getOwnedSession } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import { checkpointCodingSession, codingRuntimeConfigured } from "@/lib/ember/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const DOWNLOAD_EXPIRES = 900;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Claude + Codex store one movable transcript per session; Kiro stores a
  // SQLite row. All three resume by id, so pull works for all three (the runtime
  // + MCP adapter handle the per-CLI placement).
  if (session.cli !== "claude" && session.cli !== "codex" && session.cli !== "kiro") {
    return NextResponse.json(
      { error: `checkpoint/pull is not supported for cli '${session.cli}'` },
      { status: 400 }
    );
  }
  // The conversation's real id is the resume handle (claude transcript filename /
  // codex thread uuid), surfaced through claudeSessionId for both CLIs.
  const resumeSessionId = session.claudeSessionId;
  if (!resumeSessionId) {
    return NextResponse.json(
      { error: "session has no resume id yet (no turns run?) — nothing to pull" },
      { status: 400 }
    );
  }

  const region = request.nextUrl.searchParams.get("region") || undefined;
  try {
    const cp = await checkpointCodingSession({
      sessionId: session.sessionId,
      cli: session.cli,
      repo: session.repo,
      resumeSessionId,
      tenantId,
      region,
    });
    if (!cp.key) {
      return NextResponse.json({ error: "runtime did not return a transcript key" }, { status: 502 });
    }

    const s3 = new S3Client({ region: REGION });
    const transcriptUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: cp.key }),
      { expiresIn: DOWNLOAD_EXPIRES }
    );

    // Return leg of artifact shipping: the runtime uploaded the cloud session's
    // touched-untracked deliverables under cp.artifactPrefix. List them and hand
    // back a presigned GET + workspace-relative path per file so the MCP can drop
    // each into the laptop's .ember/artifacts/.
    let artifacts: { rel: string; url: string; bytes: number }[] | undefined;
    if (cp.artifactPrefix && (cp.artifactCount ?? 0) > 0) {
      // Page through the prefix — the runtime caps at 200 files, but a single
      // ListObjectsV2 returns max 1000, so loop on the continuation token rather
      // than silently truncating if that cap is ever raised.
      const objects: { Key?: string; Size?: number }[] = [];
      let token: string | undefined;
      do {
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: ARTIFACT_BUCKET,
            Prefix: cp.artifactPrefix,
            ContinuationToken: token,
          })
        );
        for (const o of listed.Contents || []) objects.push(o);
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      artifacts = await Promise.all(
        objects
          .filter((o) => o.Key && !o.Key.endsWith("/"))
          .map(async (o) => ({
            rel: o.Key!.slice(cp.artifactPrefix!.length),
            bytes: o.Size ?? 0,
            url: await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: o.Key! }),
              { expiresIn: DOWNLOAD_EXPIRES }
            ),
          }))
      );
    }

    return NextResponse.json({
      transcriptUrl,
      transcriptKey: cp.key,
      cli: session.cli,
      resumeId: resumeSessionId,
      claudeSessionId: resumeSessionId, // back-compat alias
      branch: cp.branch || session.branch,
      repo: session.repo,
      bytes: cp.bytes,
      artifacts,
    });
  } catch (err) {
    console.error("[ember] checkpoint error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
