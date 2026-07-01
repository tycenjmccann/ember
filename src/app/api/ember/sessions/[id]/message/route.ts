/**
 * POST /api/ember/sessions/[id]/message  → run one coding turn
 *
 * Invokes the coding runtime with the same runtimeSessionId (warm microVM) and
 * the session's stored claudeSessionId (resumes the CLI conversation), persists
 * the user + agent turns, and returns the agent reply.
 *
 * Request/response today — the reply returns when the CLI finishes the turn.
 */

import { NextRequest, NextResponse } from "next/server";
import { getOwnedSession, putSession, DEFAULT_USER_ID } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import { invokeCodingTurn, invokeCodingTurnStream, codingRuntimeConfigured } from "@/lib/ember/runtime";
import { currentConfigVersion } from "@/lib/ember/config-store";
import { sseData } from "@/lib/sse";
import type { EmberTurn } from "@/lib/ember/types";

export const dynamic = "force-dynamic";
// A coding turn can be long; allow the route plenty of headroom.
export const maxDuration = 800;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json(
      { error: "Coding runtime not configured (CODING_AGENT_RUNTIME_ARN unset)" },
      { status: 503 }
    );
  }

  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  let prompt: string = (body.prompt || "").trim();
  // For the ported seed, the prompt is a huge transcript; displayPrompt is the
  // short label we persist/render in the chat instead of the raw seed.
  const displayPrompt: string = (body.displayPrompt || "").trim();
  // Chat attachments: artifact-prefix paths the user uploaded in the composer
  // (e.g. uploads/screenshot.png). Sanitized to safe relative paths; the runtime
  // downloads them into $EMBER_ARTIFACTS_DIR and appends their on-disk paths to
  // the prompt so the CLI reads them with its file tools.
  const attachments: string[] = Array.isArray(body.attachments)
    ? body.attachments
        .map((p: unknown) => String(p || "").replace(/^\/+/, ""))
        .filter((p: string) => p && !p.includes("..") && p.length < 1024)
        .slice(0, 20)
    : [];
  // Need either text or at least one attachment. An attachment-only turn gets a
  // default instruction so the CLI knows to look at the file(s).
  if (!prompt && attachments.length === 0) {
    return NextResponse.json({ error: "prompt or attachments required" }, { status: 400 });
  }
  if (!prompt) prompt = "Take a look at the attached file(s).";

  // Persist attachments structurally on the turn so the chat can render image
  // thumbnails (presigned at read time) instead of a plain text label.
  const ctFor = (p: string): string | undefined => {
    const ext = p.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    };
    return map[ext];
  };
  const userTurn: EmberTurn = {
    role: "user",
    text: displayPrompt || (attachments.length && !body.prompt?.trim() ? "" : prompt),
    at: new Date().toISOString(),
    ...(attachments.length
      ? { attachments: attachments.map((p) => ({ path: p, name: p.split("/").pop() || p, contentType: ctFor(p) })) }
      : {}),
  };
  const wantStream =
    request.nextUrl.searchParams.get("stream") === "1" && session.cli === "claude";
  const userId = session.userId || DEFAULT_USER_ID;
  const configVersion = await currentConfigVersion(userId);
  const region = request.nextUrl.searchParams.get("region") || undefined;

  // Ported session: re-send the resume fields on EVERY turn, not just the seed.
  // The runtime's transcript install is keyed to the cwd it lands in (Claude
  // scopes a conversation by its project-slug = realpath(workdir)). That cwd can
  // legitimately change between turns — e.g. the seed turn's clone failed and fell
  // back to the bare session dir, but a later turn's clone succeeds and lands in
  // the repo subdir. A different cwd → different slug → `claude --resume <id>`
  // can't find the transcript ("No conversation found"). Re-sending the resume
  // fields makes the runtime re-place the .jsonl at the current cwd before
  // resuming. Idempotent: the install dedupes when the transcript is already
  // there, and branch/clone/bundle each have their own on-disk markers.
  const resumeFields = session.resumeTranscriptKey
    ? {
        branch: session.branch,
        resumeTranscriptKey: session.resumeTranscriptKey,
        resumeSessionId: session.claudeSessionId,
        // Flexible git handoff: how the laptop shipped its code (pushed branch,
        // git bundle on a read-only origin, or none) + the explicit clone URL.
        gitMode: session.gitMode,
        cloneUrl: session.cloneUrl,
        resumeBundleKey: session.resumeBundleKey,
        artifactPrefix: session.artifactPrefix,
      }
    : {};

  // ── Streaming path (claude): relay SSE, persist on the terminal 'done' frame.
  if (wantStream) {
    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await invokeCodingTurnStream({
        sessionId: session.sessionId, prompt, cli: session.cli, repo: session.repo,
        claudeSessionId: session.claudeSessionId, userId, tenantId, configVersion, region,
        authMode: session.authMode, attachments, ...resumeFields,
      });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }

    const enc = new TextEncoder();
    let fullText = "";

    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Relaying to the browser is best-effort; draining `upstream` and
        // persisting the turn is not. A mobile client that backgrounds/locks
        // mid-turn kills its socket, but the runtime keeps working — so once the
        // browser is gone we stop enqueuing yet keep reading upstream to the end
        // and still persist the full reply (recovered on the next GET).
        let clientGone = false;
        const relay = (chunk: Uint8Array) => {
          if (clientGone) return;
          try { controller.enqueue(chunk); } catch { clientGone = true; }
        };
        try {
          // sseData parses the upstream frames; we tee text/done to persist and
          // relay each frame to the browser verbatim.
          for await (const json of sseData(upstream)) {
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(json); } catch { continue; }
            if (obj.type === "text") {
              fullText += String(obj.text || "");
            } else if (obj.type === "done") {
              if (obj.claude_session_id) session.claudeSessionId = String(obj.claude_session_id);
              fullText = String(obj.response || fullText);
            }
            relay(enc.encode(`data: ${json}\n\n`));
          }
          // Persist the completed turn — even if the browser disconnected
          // mid-stream (mobile background/lock).
          session.turns.push(userTurn, { role: "agent", text: fullText, at: new Date().toISOString() });
          if (session.title === "New session") session.title = prompt.slice(0, 80);
          session.pendingSeed = undefined; // ported seed has now run
          session.updatedAt = new Date().toISOString();
          await putSession(session).catch(() => {});
        } catch (err) {
          // Upstream itself failed. Keep any partial reply so it isn't lost.
          relay(enc.encode(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`));
          session.turns.push(userTurn);
          if (fullText) session.turns.push({ role: "agent", text: fullText, at: new Date().toISOString() });
          session.updatedAt = new Date().toISOString();
          await putSession(session).catch(() => {});
        } finally {
          if (!clientGone) { try { controller.close(); } catch { /* already closed */ } }
        }
      },
    });

    return new Response(out, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // ── Buffered path (codex, or stream not requested).
  try {
    const result = await invokeCodingTurn({
      sessionId: session.sessionId, prompt, cli: session.cli, repo: session.repo,
      claudeSessionId: session.claudeSessionId, userId, tenantId, configVersion, region,
      authMode: session.authMode, attachments, ...resumeFields,
    });

    const agentTurn: EmberTurn = { role: "agent", text: result.response, at: new Date().toISOString() };
    session.turns.push(userTurn, agentTurn);
    if (result.claudeSessionId) session.claudeSessionId = result.claudeSessionId;
    if (session.title === "New session") session.title = prompt.slice(0, 80);
    session.pendingSeed = undefined; // ported seed has now run
    session.updatedAt = new Date().toISOString();
    await putSession(session);

    return NextResponse.json({ reply: agentTurn, session });
  } catch (err) {
    session.turns.push(userTurn);
    session.updatedAt = new Date().toISOString();
    await putSession(session).catch(() => {});
    console.error("[ember] turn error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
