/**
 * GET    /api/ember/sessions/[id]   → full session (turns)
 * DELETE /api/ember/sessions/[id]   → forget the session row + reclaim its storage
 *
 * DELETE also reclaims the session's backend storage (best-effort): it stops the
 * live runtime session and purges its EFS dir + S3 artifacts, so deleting in the
 * UI matches the backend reality instead of leaking storage we keep paying for.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, putSession, deleteSession } from "@/lib/ember/sessions";
import { codingRuntimeConfigured, purgeCodingSession } from "@/lib/ember/runtime";

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
    // Reclaim backend storage BEFORE forgetting the row — we need the session's
    // cli + claudeSessionId to target the purge, and the row is the only record of
    // it. Best-effort: purgeCodingSession bounds each step (disk purge + stop)
    // internally, so it returns promptly even against a busy/cold session and a
    // failure can't block the user's delete. The row goes away regardless; a later
    // lifecycle sweep catches any orphan.
    if (codingRuntimeConfigured()) {
      const session = await getSession(params.id);
      if (session) {
        await purgeCodingSession({
          sessionId: session.sessionId,
          cli: session.cli,
          claudeSessionId: session.claudeSessionId,
        }).catch(() => {});
      }
    }
    await deleteSession(params.id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[ember] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
