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
import {
  getInstallation,
  verifyInstallState,
  verifyInstallationOwnership,
  githubAppHasOAuth,
} from "@/lib/ember/github-app";

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
    const code = request.nextUrl.searchParams.get("code") || "";

    // A "request"/cancel with no installation → nothing to store.
    if (!installationId) {
      return NextResponse.redirect(`${back}?github=cancelled`);
    }

    if (setupAction === "delete") {
      await deleteGithubConnection(userId);
      return NextResponse.redirect(`${back}?github=disconnected`);
    }

    // First gate: the signed state proves THIS user started an install flow (CSRF
    // + ties the flow to the session). Necessary but not sufficient.
    if (!(await verifyInstallState(state, userId))) {
      return NextResponse.redirect(`${back}?github=state_mismatch`);
    }

    // Second gate: prove this user actually CONTROLS installationId — not just
    // that they know it. `state` alone can't do this: during its lifetime a user
    // could start their own flow then swap in another org's installation id. With
    // OAuth-on-install, GitHub appends a `code`; we exchange it for a user token
    // and confirm the installation is in THAT user's /user/installations. Only an
    // App created before this change (no OAuth creds) falls back to state-only.
    let verifiedAccount: string | undefined;
    if (await githubAppHasOAuth()) {
      if (!code) {
        return NextResponse.redirect(`${back}?github=ownership_unverified`);
      }
      const owned = await verifyInstallationOwnership(code, installationId);
      if (!owned) {
        return NextResponse.redirect(`${back}?github=ownership_unverified`);
      }
      verifiedAccount = owned.login;
    }

    const meta = await getInstallation(installationId);
    await putGithubConnection(
      {
        installationId,
        account: verifiedAccount || meta?.account,
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
