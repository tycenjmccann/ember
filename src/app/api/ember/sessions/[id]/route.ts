/**
 * GET    /api/ember/sessions/[id]   → full session (turns)
 * DELETE /api/ember/sessions/[id]   → soft-delete (tombstone + TTL)
 *
 * DELETE does NOT do backend cleanup inline. It soft-deletes (stamps deletedAt +
 * a short TTL) and returns at once: the row leaves the user's list immediately but
 * survives as a retry handle. DynamoDB's TTL later expires the row and the table
 * stream fires the reaper Lambda once — which stops the microVM and purges EFS/S3.
 * This keeps multi-step distributed cleanup OUT of the request path (no race to
 * lose: a failed reap just re-arms the TTL), and an S3 lifecycle rule backstops
 * any orphan regardless.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getOwnedSession, putSession, softDeleteSession } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import { artifactKey } from "@/lib/ember/s3keys";
import type { EmberSession } from "@/lib/ember/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

// Presign a short-lived GET for each chat attachment so a reloaded session can
// render image thumbnails. Adds a transient `url` per attachment (not
// persisted). Best-effort — a failure just leaves the chip without a preview.
async function withAttachmentUrls(session: EmberSession, tenantId: string): Promise<EmberSession> {
  if (!ARTIFACT_BUCKET) return session;
  const hasAny = session.turns?.some((t) => t.attachments?.length);
  if (!hasAny) return session;
  const s3 = new S3Client({ region: REGION });
  const turns = await Promise.all(
    session.turns.map(async (t) => {
      if (!t.attachments?.length) return t;
      const attachments = await Promise.all(
        t.attachments.map(async (a) => {
          try {
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: artifactKey(tenantId, session.sessionId, a.path) }),
              { expiresIn: 900 }
            );
            return { ...a, url };
          } catch {
            return a;
          }
        })
      );
      return { ...t, attachments };
    })
  );
  return { ...session, turns };
}

/**
 * PATCH /api/ember/sessions/[id]  → small session mutations.
 * Today: { clearPendingSeed: true } — the terminal calls this once it has typed
 * the resume seed, so reopening the terminal re-attaches via `claude --resume`
 * WITHOUT re-typing the seed (which otherwise stacks in the transcript).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { tenantId } = getIdentity(request);
    const session = await getOwnedSession(params.id, tenantId);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    if (body.clearPendingSeed) session.pendingSeed = undefined;
    session.updatedAt = new Date().toISOString();
    await putSession(session);
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[ember] patch error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { tenantId } = getIdentity(request);
    const session = await getOwnedSession(params.id, tenantId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session: await withAttachmentUrls(session, tenantId) });
  } catch (err) {
    console.error("[ember] get error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { tenantId } = getIdentity(request);
    // Soft-delete only: stamp the tombstone + TTL and return immediately. The row
    // disappears from the list now; the reaper Lambda (fired by the TTL-expiry
    // stream event) does the stop + EFS/S3 purge out of band. No distributed
    // cleanup in the request path = no race to lose. Tenant-scoped: a cross-tenant
    // id is a no-op that still reports 404 (can't distinguish from missing).
    const deleted = await softDeleteSession(params.id, tenantId);
    if (!deleted) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[ember] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
