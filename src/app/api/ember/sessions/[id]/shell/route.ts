/**
 * POST /api/ember/sessions/[id]/shell  → mint a presigned wss:// URL
 *
 * Returns a short-lived (max 300s) SigV4-presigned WebSocket URL that the
 * browser (xterm.js) connects to DIRECTLY — the live PTY into the session's
 * microVM. App Runner only signs the URL; it does not proxy the socket.
 *
 * Wire protocol on that socket: Kubernetes channel-prefix frames
 * ([1-byte channel][payload]) — see src/lib/ember/shell-protocol.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { getOwnedSession, DEFAULT_USER_ID } from "@/lib/ember/sessions";
import { getIdentity } from "@/lib/ember/identity";
import { currentConfigVersion } from "@/lib/ember/config-store";
import { prepareCodingSession, warmCodingSession } from "@/lib/ember/runtime";
import { resolveRuntimeArn } from "@/lib/ember/tenant-store";

export const dynamic = "force-dynamic";
// Bounded by the prepare/warm race below; the presign itself is instant. A
// ported session must finish its clone + transcript install before the PTY
// runs `claude --resume`, and a cold clone can take 10-30s — so allow longer.
export const maxDuration = 60;

const REGION = process.env.AWS_REGION || "us-east-1";
const RUNTIME_ARN = process.env.CODING_AGENT_RUNTIME_ARN || "";
const EXPIRES = 300; // AgentCore presigned-URL max

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!RUNTIME_ARN) {
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

  // The PTY must attach to the SAME runtime we warm/prepare below. For a siloed
  // tenant that's its dedicated runtime, not the shared default — sign the URL
  // against it or the browser crosses into the pool runtime (wrong VM, missing
  // resume/config, broken compute boundary). Falls back to the shared ARN.
  const runtimeArn = await resolveRuntimeArn(tenantId);

  // Ready the session's microVM BEFORE the browser opens the PTY — a terminal
  // session never runs a chat turn, which is otherwise the only thing that
  // materializes config AND (for a ported session) clones the repo + installs the
  // resume transcript. Two cases:
  //
  //   • Ported session (resumeTranscriptKey set): the PTY fires `claude --resume
  //     <id>` the instant it connects. That id only exists once the transcript is
  //     installed on disk — which warmCodingSession does (clone + checkout +
  //     install). If we don't AWAIT it here, the resume races the background warm
  //     and `claude` reports "conversation not found". So block on the full warm.
  //   • Non-ported terminal session: just materialize config (cheap prepare).
  let resumeReady = false;
  try {
    const userId = session.userId || DEFAULT_USER_ID;
    const configVersion = await currentConfigVersion(userId);
    if (session.resumeTranscriptKey) {
      // Full setup must COMPLETE before the resume runs. Bound it so a pathological
      // clone can't hang the request past maxDuration; if it times out the PTY's
      // resume retries are idempotent and the install marker dedupes. We capture
      // resumeReady from the warm so the response can tell the browser whether the
      // Terminal will auto-resume (gates the first-prompt seed). A timeout wins the
      // race → resumeReady stays false → the client holds the seed for a retry.
      const warmed = await Promise.race([
        warmCodingSession({
          sessionId: session.sessionId,
          cli: session.cli,
          repo: session.repo,
          branch: session.branch,
          resumeTranscriptKey: session.resumeTranscriptKey,
          resumeSessionId: session.claudeSessionId,
          gitMode: session.gitMode,
          cloneUrl: session.cloneUrl,
          resumeBundleKey: session.resumeBundleKey,
          userId,
          tenantId,
          configVersion,
          region: REGION,
          authMode: session.authMode,
        }).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 50_000)),
      ]);
      resumeReady = Boolean(warmed?.resumeReady);
    } else if (configVersion || session.authMode === "subscription" || session.claudeSessionId) {
      // No transcript to install — just materialize config / plan creds, AND let the
      // runtime restore a durable resume hint. A plain Bedrock session that already
      // has a claudeSessionId (a chat turn ran, no port) must hit prepare too: on a
      // recycled/cold VM only prepare's _restore_resume_launch_hint rebuilds
      // /tmp/.resume-launch.sh, so the PTY lands in the live TUI instead of a bare
      // shell. Bounded:
      // wait briefly so `claude` reads .mcp.json on first launch, but never block
      // the URL on a cold path (materialization continues server-side; marker dedupes).
      const prepared = await Promise.race([
        prepareCodingSession({
          sessionId: session.sessionId,
          cli: session.cli,
          userId,
          tenantId,
          configVersion,
          region: REGION,
          authMode: session.authMode,
        }).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      resumeReady = Boolean(prepared?.resumeReady);
    }
  } catch {
    /* best-effort; the PTY's resume retries + the install marker recover */
  }

  // A shell id is the reconnect handle for this PTY; one per attach is fine.
  const shellId = `sh-${params.id}`.slice(0, 60);
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const path = `/runtimes/${encodeURIComponent(runtimeArn)}/ws/shells`;

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
    // Default uriEscapePath:true — the canonical request double-encodes the
    // already-%-encoded ARN in the path (arn%253A…), matching the platform's
    // botocore presigner. Setting it false → 403.
  });

  try {
    const signed = await signer.presign(
      {
        method: "GET",
        protocol: "https:",
        hostname: host,
        path,
        headers: { host },
        query: {
          qualifier: "DEFAULT",
          shellId,
          // Routes to (and warms) the same microVM as this session's turns.
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session.sessionId,
        },
      },
      { expiresIn: EXPIRES }
    );

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(signed.query || {})) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v != null) qs.append(k, String(v));
    }
    const url = `wss://${host}${path}?${qs.toString()}`;

    return NextResponse.json({ url, shellId, expiresIn: EXPIRES, resumeReady });
  } catch (err) {
    console.error("[ember] shell presign error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
