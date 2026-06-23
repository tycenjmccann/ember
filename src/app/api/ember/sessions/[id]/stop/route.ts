/**
 * POST /api/ember/sessions/[id]/stop  → interrupt a running chat turn ("Ctrl-C")
 *
 * Chat turns run headless inside the session microVM (claude --print), so there
 * is no PTY signal to send. Instead we StopRuntimeSession, which tears down the
 * microVM and kills the in-flight CLI. The workspace (EFS) and transcript
 * persist, so the next turn resumes the conversation with any partial work
 * intact — exactly like interrupting a local session.
 *
 * To hide the cold-start that the next turn would otherwise pay, we kick off a
 * background re-warm (config-only prepare → fresh VM) right after the stop. It's
 * best-effort and intentionally NOT awaited: the response returns immediately so
 * the UI can prompt for the next instruction while the VM warms in parallel. The
 * next real turn re-warms anyway, so a failed/raced prepare is harmless.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, DEFAULT_USER_ID } from "@/lib/ember/sessions";
import { stopCodingSession, prepareCodingSession, codingRuntimeConfigured } from "@/lib/ember/runtime";
import { currentConfigVersion } from "@/lib/ember/config-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const region = request.nextUrl.searchParams.get("region") || undefined;

  try {
    await stopCodingSession({ sessionId: session.sessionId, region });
  } catch (err) {
    console.error("[ember] stop error:", err);
    return NextResponse.json({ stopped: false, error: (err as Error).message }, { status: 200 });
  }

  // Background re-warm — DON'T await. Give the teardown a beat so the new VM
  // doesn't race the stop, then materialize config on a fresh microVM so the
  // user's next message lands hot. Failure is non-fatal (the next turn warms).
  (async () => {
    try {
      const userId = session.userId || DEFAULT_USER_ID;
      const configVersion = await currentConfigVersion(userId);
      await new Promise((r) => setTimeout(r, 1500));
      await prepareCodingSession({
        sessionId: session.sessionId,
        cli: session.cli,
        userId,
        configVersion,
        region,
        authMode: session.authMode,
      });
    } catch {
      /* best-effort; the next turn re-warms */
    }
  })();

  return NextResponse.json({ stopped: true });
}
