/**
 * GET  /api/ember/sessions          → list sessions (sidebar)
 * POST /api/ember/sessions          → create a new session (no turn yet)
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listSessions, putSession } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import type { EmberSession, EmberCli, EmberAuthMode } from "@/lib/ember/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { tenantId } = getIdentity(request);
    const sessions = await listSessions(tenantId);
    return NextResponse.json({ sessions });
  } catch (err) {
    console.error("[ember] list error:", err);
    return NextResponse.json(
      { error: (err as Error).message, sessions: [] },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, tenantId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));
    const cli: EmberCli = body.cli === "codex" ? "codex" : "claude";
    const authMode: EmberAuthMode = body.authMode === "subscription" ? "subscription" : "bedrock";
    const repo: string | undefined = body.repo?.trim() || undefined;
    const title: string = (body.title?.trim() || "New session").slice(0, 120);

    // runtimeSessionId must be >= 33 chars for AgentCore; uuid (no dashes) = 32 + prefix.
    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    const session: EmberSession = {
      sessionId,
      userId,
      tenantId,
      title,
      cli,
      authMode,
      repo,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    await putSession(session);
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    console.error("[ember] create error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
