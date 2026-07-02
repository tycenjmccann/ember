/**
 * GET /api/ember/github/callback  → GitHub App install redirect target.
 *
 * After a user clicks "Install" (or "Configure") on GitHub, GitHub bounces here
 * with ?installation_id=&setup_action=. We record the installation for the
 * signed-in user and send them back to /ember. Tokens are minted on demand later.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/ember/identity";
import { putGithubConnection, deleteGithubConnection } from "@/lib/ember/github-store";
import { getInstallation } from "@/lib/ember/github-app";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const back = `${appBase(request)}/ember`;
  try {
    const { userId } = getIdentity(request);
    const installationId = request.nextUrl.searchParams.get("installation_id") || "";
    const setupAction = request.nextUrl.searchParams.get("setup_action") || "";

    // A "request"/cancel with no installation → nothing to store.
    if (!installationId) {
      return NextResponse.redirect(`${back}?github=cancelled`);
    }

    if (setupAction === "delete") {
      await deleteGithubConnection(userId);
      return NextResponse.redirect(`${back}?github=disconnected`);
    }

    const meta = await getInstallation(installationId);
    await putGithubConnection(
      {
        installationId,
        account: meta?.account,
        repoSelection: meta?.repoSelection,
        connectedAt: new Date().toISOString(),
      },
      userId
    );
    return NextResponse.redirect(`${back}?github=connected`);
  } catch (err) {
    console.error("[ember] github callback error:", err);
    return NextResponse.redirect(`${back}?github=error`);
  }
}
