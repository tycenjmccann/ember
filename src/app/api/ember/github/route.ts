/**
 * GET    /api/ember/github  → GitHub App connection status (no token material)
 * DELETE /api/ember/github  → disconnect (forget the installation)
 *
 * The connection is just an installation_id + display metadata; clone tokens are
 * minted on demand at turn time (see github-app.ts) and never stored or returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity, isAdmin } from "@/lib/ember/identity";
import { getGithubConnection, deleteGithubConnection } from "@/lib/ember/github-store";
import { githubAppConfigured } from "@/lib/ember/github-app";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { userId } = getIdentity(request);
    const [appConfigured, conn] = await Promise.all([
      githubAppConfigured(),
      getGithubConnection(userId),
    ]);
    return NextResponse.json({
      appConfigured,
      // Admins see a setup entry point even before the App exists (the install
      // route sends them into the manifest-creation flow); non-admins don't, so
      // they're not offered a path that just bounces to "ask your operator".
      isAdmin: isAdmin(request),
      connection: conn
        ? {
            account: conn.account,
            repoSelection: conn.repoSelection,
            repoCount: conn.repositories?.length,
            connectedAt: conn.connectedAt,
          }
        : null,
    });
  } catch (err) {
    console.error("[ember] github status error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = getIdentity(request);
    await deleteGithubConnection(userId);
    return NextResponse.json({ disconnected: true });
  } catch (err) {
    console.error("[ember] github disconnect error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
