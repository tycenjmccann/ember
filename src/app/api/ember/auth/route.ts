/**
 * GET    /api/ember/auth          → which CLIs are connected to a plan
 * POST   /api/ember/auth          → store a subscription credential
 *          { cli, token }                       (claude — from `claude setup-token`)
 *          { cli, authJson, label? }             (codex  — the ~/.codex/auth.json)
 * DELETE /api/ember/auth?cli=claude|codex  → disconnect a CLI
 *
 * Subscription mode lets a session run on the user's OWN plan (Claude Pro/Max or
 * a ChatGPT plan) instead of AWS Bedrock. The credential bytes live in S3 and are
 * fetched by the runtime per session; this API only ever reports presence +
 * metadata, never the secret material. Single-user today (userId "default").
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthStatus, putCredential, deleteCredential, authConfigured } from "@/lib/ember/auth-store";
import { getIdentity } from "@/lib/ember/identity";
import type { EmberCli } from "@/lib/ember/types";

export const dynamic = "force-dynamic";

function parseCli(v: unknown): EmberCli | null {
  return v === "claude" || v === "codex" ? v : null;
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = getIdentity(request);
    const status = await getAuthStatus(userId);
    return NextResponse.json({ status, bedrockAlwaysAvailable: true });
  } catch (err) {
    console.error("[ember] auth status error:", err);
    return NextResponse.json({ status: {}, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  try {
    const { userId, tenantId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));
    const cli = parseCli(body.cli);
    if (!cli) return NextResponse.json({ error: "cli must be 'claude' or 'codex'" }, { status: 400 });

    let cred: Record<string, unknown>;
    let label: string | undefined = typeof body.label === "string" ? body.label : undefined;

    if (cli === "claude") {
      const token = (body.token || "").trim();
      if (!token) {
        return NextResponse.json(
          { error: "token is required (run `claude setup-token` on your laptop)" },
          { status: 400 }
        );
      }
      cred = { token };
      label = label || "Claude plan";
    } else {
      // codex: accept the auth.json as an object, or a JSON string to parse.
      let authJson = body.authJson ?? body.auth_json;
      if (typeof authJson === "string") {
        try {
          authJson = JSON.parse(authJson);
        } catch {
          return NextResponse.json({ error: "authJson is not valid JSON" }, { status: 400 });
        }
      }
      if (!authJson || typeof authJson !== "object") {
        return NextResponse.json(
          { error: "authJson is required (the contents of ~/.codex/auth.json after `codex login`)" },
          { status: 400 }
        );
      }
      cred = authJson as Record<string, unknown>;
      label = label || "ChatGPT plan";
    }

    const meta = await putCredential(cli, cred, { label, userId, tenantId });
    return NextResponse.json({ connected: true, cli, meta }, { status: 201 });
  } catch (err) {
    console.error("[ember] auth set error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId, tenantId } = getIdentity(request);
    const cli = parseCli(request.nextUrl.searchParams.get("cli"));
    if (!cli) return NextResponse.json({ error: "cli query param required" }, { status: 400 });
    await deleteCredential(cli, userId, tenantId);
    return NextResponse.json({ disconnected: true, cli });
  } catch (err) {
    console.error("[ember] auth delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
