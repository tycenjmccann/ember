/**
 * GET /api/ember/github/install  → redirect the user to GitHub to install the
 * (already-created) Ember App on their account/repos. GitHub bounces back to the
 * connect callback with the installation_id.
 *
 * If no App exists yet, an admin is sent to the manifest creation flow; a
 * non-admin gets a clear "ask your operator" bounce.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGithubAppConfig } from "@/lib/ember/secrets";
import { isAdmin } from "@/lib/ember/identity";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const base = appBase(request);
  const cfg = await getGithubAppConfig();

  if (!cfg) {
    // No App yet: admins create one, everyone else waits for the operator.
    if (isAdmin(request)) {
      return NextResponse.redirect(`${base}/api/ember/github/manifest`);
    }
    return NextResponse.redirect(`${base}/ember?github=not_configured`);
  }

  if (!cfg.slug) {
    return NextResponse.redirect(`${base}/ember?github=app_error`);
  }
  return NextResponse.redirect(`https://github.com/apps/${cfg.slug}/installations/new`);
}
