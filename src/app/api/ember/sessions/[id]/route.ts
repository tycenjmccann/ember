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
import { getSession, putSession, softDeleteSession } from "@/lib/ember/sessions";

export const dynamic = "force-dynamic";

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
    const session = await getSession(params.id);
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
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession(params.id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[ember] get error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Soft-delete only: stamp the tombstone + TTL and return immediately. The row
    // disappears from the list now; the reaper Lambda (fired by the TTL-expiry
    // stream event) does the stop + EFS/S3 purge out of band. No distributed
    // cleanup in the request path = no race to lose.
    await softDeleteSession(params.id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[ember] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
