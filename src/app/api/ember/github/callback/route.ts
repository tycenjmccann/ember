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
import { getInstallation, verifyInstallState } from "@/lib/ember/github-app";

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
    const state = request.nextUrl.searchParams.get("state") || "";

    // A "request"/cancel with no installation → nothing to store.
    if (!installationId) {
      return NextResponse.redirect(`${back}?github=cancelled`);
    }

    if (setupAction === "delete") {
      await deleteGithubConnection(userId);
      return NextResponse.redirect(`${back}?github=disconnected`);
    }

    // Bind the installation to the user who actually initiated the flow. Without
    // this, any signed-in user could replay a callback with another org's
    // installation id and mint tokens for repos they don't administer. The state
    // is the signed nonce our install route issued for THIS user.
    if (!(await verifyInstallState(state, userId))) {
      return NextResponse.redirect(`${back}?github=state_mismatch`);
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
